#!/usr/bin/env node
/**
 * 旧图迁移到摘要主干（P2）。
 *
 *   node scripts/migrate-trunk.mjs --workspace <dir> [--threshold 0.05] [--apply] [--force] [--json]
 *
 * 做什么：
 *   - 找出仍直接挂在 step 下的语义节点（question/hypothesis/evidence/decision/dead_end/conclusion）；
 *   - 按「节点文本 ↔ topic 标题+摘要」相似度选主题（默认阈值 0.2）；
 *   - approach 直接成为 topic 的叶根；dependent 挂到该 topic 下最相近的 approach；
 *   - 补 stepId（时间线保留）、打 trunk-migrated 标签、重算 topic 摘要。
 *
 * 默认 dry-run；`--apply` 会先备份 graph.json 再写回。
 * 宿主会用自己的内存覆盖 graph.json，apply 前需停掉 dsh web；脚本探测 3080，除非 `--force`。
 */
import fs from 'node:fs';
import path from 'node:path';

import { fromJSON, toJSON } from '../src/core/graph.js';
import { applyTrunkMigration, planTrunkMigration } from '../src/core/migrate.js';

function parseArgs(argv) {
    const options = { workspace: process.cwd(), apply: false, force: false, json: false, threshold: 0.05 };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--workspace' && argv[i + 1] !== undefined) {
            options.workspace = path.resolve(argv[i + 1]);
            i += 1;
        } else if (arg === '--threshold' && argv[i + 1] !== undefined) {
            const value = Number.parseFloat(argv[i + 1]);
            if (Number.isFinite(value)) options.threshold = value;
            i += 1;
        } else if (arg === '--apply') {
            options.apply = true;
        } else if (arg === '--force') {
            options.force = true;
        } else if (arg === '--json') {
            options.json = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log('用法: node scripts/migrate-trunk.mjs --workspace <dir> [--threshold 0.2] [--apply] [--force] [--json]');
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

const options = parseArgs(process.argv.slice(2));
const file = path.join(options.workspace, '.explore-tree', 'graph.json');
if (!fs.existsSync(file)) {
    console.error(`没有找到研究图：${file}`);
    process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const state = fromJSON(raw);
const plan = planTrunkMigration(state, { threshold: options.threshold });
const summary = {
    workspace: options.workspace,
    file,
    mode: options.apply ? 'apply' : 'dry-run',
    threshold: options.threshold,
    changes: plan.changes,
    skipped: plan.skipped,
};

if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
} else {
    console.log(`工作区 ${options.workspace}`);
    console.log(`模式   ${options.apply ? 'APPLY（写回并备份）' : 'dry-run（只打印）'} · 阈值 ${options.threshold}`);
    if (plan.changes.length === 0) {
        console.log('没有可迁移的节点（需要先给 goal 建 topic，且语义节点仍挂在 step 下）。');
    } else {
        for (const change of plan.changes) {
            console.log(`move  ${change.id.padEnd(5)} ${change.kind.padEnd(10)} ${String(change.title).slice(0, 38)} → ${change.targetParentId}（score ${change.score}）`);
        }
        console.log(`共 ${plan.changes.length} 个节点可迁移。`);
    }
    const reasons = {};
    for (const item of plan.skipped) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
    if (Object.keys(reasons).length > 0) {
        console.log(`跳过：${Object.entries(reasons).map(([reason, count]) => `${reason}:${count}`).join(' ')}`);
    }
}

if (!options.apply) {
    console.log('未写回；确认无误后加 --apply。');
    process.exit(0);
}
if (!options.force && await liveHostRunning()) {
    console.error('检测到 dsh web 正在运行：宿主会用自己的内存状态覆盖 graph.json。请先停止宿主，或加 --force 明确风险。');
    process.exit(2);
}
if (plan.changes.length === 0) {
    console.log('没有改动，未写回。');
    process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14);
const backup = path.join(options.workspace, '.explore-tree', `graph.trunk-backup-${stamp}.json`);
fs.copyFileSync(file, backup);

const fresh = fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
const applied = applyTrunkMigration(fresh, plan);
fresh.meta = {
    ...(fresh.meta ?? {}),
    lastTrunkMigration: {
        at: new Date().toISOString(),
        moved: applied.moved,
        threshold: options.threshold,
        backup: path.basename(backup),
    },
};
fs.writeFileSync(file, `${JSON.stringify(toJSON(fresh), null, 2)}\n`);
console.log(`已迁移 ${applied.moved} 个节点到 ${applied.topics.length} 个 topic；写回 ${file}（备份 ${backup}）。`);
