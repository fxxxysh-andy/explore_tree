/**
 * P2：把旧图的结束原因回填为 closeReason / resolutionBy。
 *
 * 迁移只加字段、不改 status：
 *  - 已有 closeReason 的节点跳过（可重跑）；
 *  - open/active 保持为空；
 *  - 其余按标签/标题/kind/status 推断：自动收敛/合并/工具失败/中断本身是系统产生，标 auto；
 *    研究结论与人工关闭标 migrated。
 *
 * 这里不读写文件；scripts/migrate-close-reason.mjs 负责 dry-run、备份、原子写与回滚。
 *
 * @module core/migrate-close-reason
 */
import { CLOSE_REASONS, RESOLUTION_BY } from './model.js';
import { isToolNoise } from './status.js';

export const CLOSE_REASON_SCHEMA_VERSION = 2;

const RECORD_KINDS = new Set(['evidence', 'note', 'conclusion', 'artifact']);
const CLOSED_STATUSES = new Set(['done', 'abandoned']);

function tagsOf(node) {
    return Array.isArray(node.tags) ? node.tags : [];
}

/**
 * 按 P2 规则推断一个节点的结束原因。
 * @param {object} node 原始 graph.json 节点
 * @returns {{closeReason: string, resolutionBy: string, rule: string}|null}
 */
export function inferMigrationFields(node) {
    if (node === null || typeof node !== 'object') return null;
    const status = node.status;
    if (status === 'open' || status === 'active') return null;
    if (!CLOSED_STATUSES.has(status)) return null;
    const tags = tagsOf(node);

    // 顺序与 status-findings 7.9 对齐：记录类先于 auto-curated，否则 done decision
    // 会被写成 curated（phaseOf 仍按 recorded 派生，但回填计数与报告对不上）。
    if (status === 'done' && (RECORD_KINDS.has(node.kind) || node.kind === 'decision')) {
        return { closeReason: 'recorded', resolutionBy: 'migrated', rule: 'recorded' };
    }
    if (tags.includes('auto-curated')) return { closeReason: 'curated', resolutionBy: 'auto', rule: 'auto-curated' };
    if (tags.includes('merged-into')) return { closeReason: 'duplicate', resolutionBy: 'auto', rule: 'merged-into' };
    if (isToolNoise(node)) return { closeReason: 'aborted', resolutionBy: 'auto', rule: 'tool-noise' };
    if (node.kind === 'dead_end') return { closeReason: 'dead_end', resolutionBy: 'migrated', rule: 'dead-end' };
    if (status === 'done') {
        if (node.kind === 'goal' || node.kind === 'topic') {
            return { closeReason: 'solved', resolutionBy: 'migrated', rule: 'closed' };
        }
        if (node.kind === 'step' || node.kind === 'action') {
            return { closeReason: 'completed', resolutionBy: 'migrated', rule: 'completed' };
        }
        return { closeReason: 'recorded', resolutionBy: 'migrated', rule: 'done-other' };
    }
    // 中断轮次：step/action 直接 abandoned，属于系统中断而非研究死路。
    if (node.kind === 'step' || node.kind === 'action') {
        return { closeReason: 'aborted', resolutionBy: 'auto', rule: 'interrupted' };
    }
    // 其余未知 abandoned：保守标成中断，交给人工复核。
    return { closeReason: 'aborted', resolutionBy: 'migrated', rule: 'abandoned-other' };
}

/** 统计 status，用于迁移前后对账。 */
export function countStatuses(snapshot) {
    const counts = {};
    for (const node of Object.values(snapshot?.nodes ?? {})) {
        if (node === null || typeof node !== 'object') continue;
        counts[node.status] = (counts[node.status] ?? 0) + 1;
    }
    return counts;
}

/**
 * 生成迁移计划，不修改入参。
 * @param {object} snapshot 原始 graph.json
 * @param {{sample?: number}} options
 */
export function planCloseReasonMigration(snapshot, options = {}) {
    if (snapshot === null || typeof snapshot !== 'object') throw new Error('graph snapshot is not an object');
    if (snapshot.nodes === null || typeof snapshot.nodes !== 'object') throw new Error('graph snapshot has no nodes');
    const sampleSize = Number.isInteger(options.sample) && options.sample >= 0 ? options.sample : 8;
    const changes = [];
    const skipped = [];
    const counts = {};
    const rules = {};
    let total = 0;

    for (const [id, node] of Object.entries(snapshot.nodes)) {
        if (node === null || typeof node !== 'object') continue;
        total += 1;
        if (typeof node.closeReason === 'string' && node.closeReason !== '') {
            skipped.push({ id, reason: 'already-has-closeReason' });
            continue;
        }
        const inferred = inferMigrationFields(node);
        if (inferred === null) {
            if (typeof node.resolutionBy === 'string' && node.resolutionBy !== '') {
                skipped.push({ id, reason: 'open-with-resolutionBy' });
            }
            continue;
        }
        const change = {
            id,
            kind: node.kind,
            status: node.status,
            title: typeof node.title === 'string' ? node.title : '',
            ...inferred,
        };
        changes.push(change);
        const key = `${inferred.closeReason}/${inferred.resolutionBy}`;
        counts[key] = (counts[key] ?? 0) + 1;
        rules[inferred.rule] = (rules[inferred.rule] ?? 0) + 1;
    }

    return {
        fromVersion: snapshot.version ?? null,
        toVersion: CLOSE_REASON_SCHEMA_VERSION,
        total,
        changed: changes.length,
        skipped: skipped.length,
        skippedDetails: skipped,
        counts,
        rules,
        sample: changes.slice(0, sampleSize),
        changes,
        statusCounts: countStatuses(snapshot),
    };
}

/**
 * 应用迁移计划（就地修改 snapshot），返回写入统计。
 * 只补缺失字段，不覆盖已有 closeReason。
 */
export function applyCloseReasonMigration(snapshot, plan) {
    if (snapshot === null || typeof snapshot !== 'object' || snapshot.nodes === null || typeof snapshot.nodes !== 'object') {
        throw new Error('graph snapshot has no nodes');
    }
    let applied = 0;
    for (const change of plan?.changes ?? []) {
        const node = snapshot.nodes[change.id];
        if (node === null || typeof node !== 'object') continue;
        if (typeof node.closeReason === 'string' && node.closeReason !== '') continue;
        node.closeReason = change.closeReason;
        node.resolutionBy = change.resolutionBy;
        applied += 1;
    }
    snapshot.version = CLOSE_REASON_SCHEMA_VERSION;
    return { applied, version: snapshot.version };
}

/**
 * 迁移后校验：版本、status 计数不变、关闭节点有合法原因、开放节点没有原因。
 * @param {object} snapshot
 * @param {object} beforeStatusCounts
 */
export function validateCloseReasonMigration(snapshot, beforeStatusCounts) {
    const missing = [];
    const badOpen = [];
    const invalid = [];
    for (const [id, node] of Object.entries(snapshot?.nodes ?? {})) {
        if (node === null || typeof node !== 'object') continue;
        const status = node.status;
        const hasReason = typeof node.closeReason === 'string' && node.closeReason !== '';
        const hasBy = typeof node.resolutionBy === 'string' && node.resolutionBy !== '';
        if (status === 'open' || status === 'active') {
            if (hasReason || hasBy) badOpen.push(id);
            continue;
        }
        if (status === 'done' || status === 'abandoned') {
            if (!hasReason || !hasBy) missing.push(id);
            if (hasReason && !CLOSE_REASONS.includes(node.closeReason)) invalid.push(`${id}:closeReason=${node.closeReason}`);
            if (hasBy && !RESOLUTION_BY.includes(node.resolutionBy)) invalid.push(`${id}:resolutionBy=${node.resolutionBy}`);
        }
    }
    const statusCounts = countStatuses(snapshot);
    const statusUnchanged = JSON.stringify(statusCounts) === JSON.stringify(beforeStatusCounts);
    return {
        ok: snapshot?.version === CLOSE_REASON_SCHEMA_VERSION
            && statusUnchanged
            && missing.length === 0
            && badOpen.length === 0
            && invalid.length === 0,
        version: snapshot?.version ?? null,
        statusUnchanged,
        missing: missing.length,
        badOpen: badOpen.length,
        invalid: invalid.length,
        missingIds: missing.slice(0, 12),
        badOpenIds: badOpen.slice(0, 12),
        invalidDetails: invalid.slice(0, 12),
        statusCounts,
    };
}

/** 按 resolutionBy=migrated 清空迁移字段；人工/自动写入保留。 */
export function revertCloseReasonMigration(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object' || snapshot.nodes === null || typeof snapshot.nodes !== 'object') {
        throw new Error('graph snapshot has no nodes');
    }
    let reverted = 0;
    for (const node of Object.values(snapshot.nodes)) {
        if (node === null || typeof node !== 'object') continue;
        if (node.resolutionBy !== 'migrated') continue;
        delete node.closeReason;
        delete node.resolutionBy;
        reverted += 1;
    }
    const remains = Object.values(snapshot.nodes).some((node) => node !== null && typeof node === 'object'
        && ((typeof node.closeReason === 'string' && node.closeReason !== '')
            || (typeof node.resolutionBy === 'string' && node.resolutionBy !== '')));
    snapshot.version = remains ? CLOSE_REASON_SCHEMA_VERSION : 1;
    return { reverted, version: snapshot.version, remains };
}
