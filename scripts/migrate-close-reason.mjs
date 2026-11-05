#!/usr/bin/env node
/**
 * P2：把旧图的 closeReason / resolutionBy 回填到 graph.json。
 *
 *   node scripts/migrate-close-reason.mjs --workspace <dir> [--apply] [--json] [--sample 8]
 *   node scripts/migrate-close-reason.mjs --workspace <dir> --revert --apply
 *
 * 默认 dry-run；--apply 先备份再原子写。只加字段、不改 status。
 * 迁移逻辑见 src/core/migrate-close-reason.js。检测到 dsh web 正在运行时拒绝写回，
 * 除非加 --force（宿主可能用内存状态覆盖文件）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from '../src/core/store.js';
import {
    applyCloseReasonMigration,
    countStatuses,
    planCloseReasonMigration,
    revertCloseReasonMigration,
    validateCloseReasonMigration,
} from '../src/core/migrate-close-reason.js';

function parseArgs(argv) {
    const options = { workspace: process.cwd(), apply: false, revert: false, force: false, json: false, sample: 8 };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--workspace' && argv[i + 1] !== undefined) {
            options.workspace = path.resolve(argv[i + 1]);
            i += 1;
        } else if (arg === '--apply') {
            options.apply = true;
        } else if (arg === '--revert') {
            options.revert = true;
        } else if (arg === '--force') {
            options.force = true;
        } else if (arg === '--json') {
            options.json = true;
        } else if (arg === '--sample' && argv[i + 1] !== undefined) {
            const value = Number.parseInt(argv[i + 1], 10);
            if (Number.isInteger(value) && value >= 0) options.sample = value;
            i += 1;
        } else if (arg === '--help' || arg === '-h') {
            console.log('用法: node scripts/migrate-close-reason.mjs --workspace <dir> [--apply] [--revert] [--json] [--sample N] [--force]');
            process.exit(0);
        }
    }
    return options;
}

async function liveHostRunning() {
    try {
        const response = await fetch('http://127.0.0.1:3080/explore-tree/health', { signal: AbortSignal.timeout(1500) });
        return response.ok;
    } catch {
        return false;
    }
}

function stamp() {
    return new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 17);
}

function printPlan(summary) {
    console.log(`工作区 ${summary.workspace}`);
    console.log(`文件   ${summary.file}`);
    console.log(`模式   ${summary.mode} · graph v${summary.fromVersion ?? '?'} → v${summary.toVersion}`);
    console.log(`节点   ${summary.total} · 待迁移 ${summary.changed} · 跳过 ${summary.skipped}`);
    if (Object.keys(summary.counts).length > 0) {
        console.log(`原因   ${Object.entries(summary.counts).map(([key, count]) => `${key}:${count}`).join(' ')}`);
        console.log(`规则   ${Object.entries(summary.rules).map(([key, count]) => `${key}:${count}`).join(' ')}`);
    }
    for (const item of summary.sample) {
        console.log(`  ${item.id.padEnd(6)} ${String(item.kind).padEnd(11)} ${String(item.status).padEnd(9)} → ${item.closeReason}/${item.resolutionBy}  ${String(item.title).slice(0, 40)}`);
    }
    if (summary.validation !== undefined && summary.validation !== null) {
        const v = summary.validation;
        console.log(`校验   version=${v.version} status不变=${v.statusUnchanged} 缺失=${v.missing} 开放节点带原因=${v.badOpen} 非法=${v.invalid}`);
    }
    if (summary.backup !== undefined) console.log(`备份   ${summary.backup}`);
    if (summary.applied !== undefined) console.log(`写回   ${summary.applied} 个节点 → ${summary.file}`);
}

const options = parseArgs(process.argv.slice(2));
const file = path.join(options.workspace, '.explore-tree', 'graph.json');
if (!fs.existsSync(file)) {
    console.error(`没有找到研究图：${file}`);
    process.exit(1);
}

let raw;
try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
    console.error(`graph.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

const beforeStatusCounts = countStatuses(raw);
const summary = {
    workspace: options.workspace,
    file,
    mode: options.revert ? 'revert' : 'migrate',
    apply: options.apply,
    fromVersion: raw.version ?? null,
    toVersion: 2,
    total: Object.keys(raw.nodes ?? {}).length,
    changed: 0,
    skipped: 0,
    counts: {},
    rules: {},
    sample: [],
    validation: null,
};

let plan = null;
if (options.revert) {
    const result = revertCloseReasonMigration(raw);
    summary.reverted = result.reverted;
    summary.toVersion = result.version;
    summary.validation = {
        version: result.version,
        statusUnchanged: JSON.stringify(countStatuses(raw)) === JSON.stringify(beforeStatusCounts),
        missing: 0,
        badOpen: 0,
        invalid: 0,
    };
    summary.changed = result.reverted;
} else {
    plan = planCloseReasonMigration(raw, { sample: options.sample });
    summary.changed = plan.changed;
    summary.skipped = plan.skipped;
    summary.counts = plan.counts;
    summary.rules = plan.rules;
    summary.sample = plan.sample;
}

if (options.json && !options.apply) {
    console.log(JSON.stringify({ ...summary, plan: plan === null ? null : { ...plan, changes: undefined } }, null, 2));
    process.exit(0);
}
if (!options.json) printPlan(summary);

if (!options.apply) {
    if (!options.json) console.log('未写回；确认无误后加 --apply。');
    process.exit(0);
}
if (!options.force && await liveHostRunning()) {
    console.error('检测到 dsh web 正在运行：宿主会用自己的内存状态覆盖 graph.json。请先停止宿主，或加 --force 明确风险。');
    process.exit(2);
}

if (!options.revert) {
    const applied = applyCloseReasonMigration(raw, plan);
    const validation = validateCloseReasonMigration(raw, beforeStatusCounts);
    summary.applied = applied.applied;
    summary.validation = validation;
    if (!validation.ok) {
        if (!options.json) printPlan(summary);
        console.error('迁移校验未通过，未写回 graph.json。');
        process.exit(1);
    }
}

const backup = path.join(options.workspace, '.explore-tree', `graph.${options.revert ? 'before-close-reason-revert' : 'before-close-reason'}-${stamp()}.json`);
fs.copyFileSync(file, backup);
summary.backup = backup;
await atomicWriteFile(file, JSON.stringify(raw));

if (options.json) {
    console.log(JSON.stringify({ ...summary, plan: plan === null ? null : { ...plan, changes: undefined } }, null, 2));
} else {
    console.log(`已写回 ${file}（graph v${raw.version}）。`);
    if (summary.validation !== null) printPlan(summary);
}
