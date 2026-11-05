/**
 * 展示语义（P0）：把存储的 4 个 status 派生为「研究状态」，不改变图 schema。
 *
 * 背景：open/active/done/abandoned 同时承担进度、记录、结果、清理四种语义。
 * 这里只读节点现有字段（kind/status/tags/title），生成一个唯一口径：
 *  - phaseOf(node) 每个节点恰好落在一个展示 phase；
 *  - statusDigest(state,{sessionId}) 汇总为 6 个主桶 + 可折叠尾桶；
 *  - overview / 面板 / brief / trunk / frontier 共用同一口径，不再各自 filter。
 *
 * P0 只读派生；P1 起节点可携带 closeReason / resolutionBy（旧图缺失时仍按规则推断）。
 *
 * @module core/status
 */
import { childrenOf } from './graph.js';
import { collectOpenItems, hasBlockerTag } from './hygiene.js';

/** 研究结论类节点：需要人做决定。 */
export const RESEARCH_KINDS = Object.freeze(['question', 'hypothesis', 'decision']);
/** 结构/流程类节点：表达树的结构，不代表研究结论。 */
export const STRUCTURE_KINDS = Object.freeze(['goal', 'topic', 'step', 'action']);
/** 记录类节点：记录证据/结论/笔记/产物，不代表任务完成。 */
export const RECORD_KINDS = Object.freeze(['evidence', 'note', 'conclusion', 'artifact']);

/** 细粒度展示阶段。 */
export const PHASES = Object.freeze([
    'todo',
    'doing',
    'recorded',
    'completed',
    'closed',
    'dead_end',
    'curated',
    'merged',
    'tool_noise',
    'aborted',
]);

const PHASE_LABEL = Object.freeze({
    todo: '待办',
    doing: '进行中',
    recorded: '已记录',
    completed: '流程完成',
    closed: '已关闭',
    dead_end: '真死路',
    curated: '自动收敛',
    merged: '已合并',
    tool_noise: '工具失败',
    aborted: '中断',
});

const TRUE_VALUES = new Set(['open', 'active']);

/** 展示阶段的中文名。 */
export function phaseLabel(phase) {
    return PHASE_LABEL[phase] ?? phase;
}

/**
 * 推断「为什么结束」。P0 是只读推断；P1 若节点带 closeReason，优先使用写入值。
 * @param {object|null|undefined} node
 * @returns {string|null}
 */
export function inferCloseReason(node) {
    if (node === null || node === undefined || typeof node !== 'object') return null;
    if (typeof node.closeReason === 'string' && node.closeReason !== '') return node.closeReason;
    const tags = Array.isArray(node.tags) ? node.tags : [];
    if (tags.includes('merged-into')) return 'duplicate';
    if (isToolNoise(node)) return 'aborted';
    if (node.kind === 'dead_end' && (node.status === 'done' || node.status === 'abandoned')) return 'dead_end';
    if (node.status === 'done') {
        if (RECORD_KINDS.includes(node.kind) || node.kind === 'decision') return 'recorded';
        if (node.kind === 'goal' || node.kind === 'topic') return 'solved';
        if (node.kind === 'step' || node.kind === 'action') return 'completed';
    }
    if (tags.includes('auto-curated')) return 'curated';
    return null;
}

/**
 * 工具失败/轮次中断留下的死路：不是「研究方向走不通」。
 * 标题规则覆盖旧图，closeReason 规则供 P1 使用。
 * @param {object|null|undefined} node
 */
export function isToolNoise(node) {
    if (node === null || node === undefined) return false;
    if (node.closeReason === 'aborted') return true;
    const title = String(node.title ?? '').trim();
    // 「历史工具失败（已合并 N 条）」是批量清理时合并出来的聚合死路，同样不是研究结论。
    return title.startsWith('失败：') || title.includes('轮次中断') || title.includes('历史工具失败');
}

/**
 * 真研究死路：dead_end、未被合并、不是工具失败。
 * @param {object|null|undefined} node
 */
export function isTrueDeadEnd(node) {
    if (node === null || node === undefined) return false;
    const tags = Array.isArray(node.tags) ? node.tags : [];
    if (tags.includes('auto-curated') || tags.includes('merged-into')) return false;
    if (isToolNoise(node)) return false;
    // kind=dead_end 本身就是「此路不通」，不要求先被人工标成 abandoned；
    // 真实图里 106 条 dead_end 都是 done/abandoned，测试/旧图里可能是 open。
    if (node.kind === 'dead_end') {
        const reason = inferCloseReason(node);
        return reason === null || reason === 'dead_end';
    }
    // P1：question/hypothesis 也可以被显式关闭为 dead_end（不必再额外建 dead_end 节点）。
    return RESEARCH_KINDS.includes(node.kind) && inferCloseReason(node) === 'dead_end';
}

/**
 * 单个节点的展示阶段。每个节点必须落在且只落在一个阶段。
 * @param {object|null|undefined} node
 * @returns {string}
 */
export function phaseOf(node) {
    if (node === null || node === undefined || typeof node !== 'object') return 'aborted';
    const tags = Array.isArray(node.tags) ? node.tags : [];
    const reason = inferCloseReason(node);
    if (tags.includes('merged-into')) return 'merged';
    // 记录类与已决策的 decision 先归入「已记录」：即使它们带着 auto-curated 标签，
    // 也不该被当成「自动收敛的旁白」（报告口径 498 = 396 记录 + 102 决策）。
    if (RECORD_KINDS.includes(node.kind)) return 'recorded';
    if (node.kind === 'decision') {
        if (reason === 'dead_end') return 'dead_end';
        if (node.status === 'done' || reason === 'recorded') return 'recorded';
        if (TRUE_VALUES.has(node.status)) return 'todo';
        return 'aborted';
    }
    if (node.kind === 'dead_end') return isToolNoise(node) ? 'tool_noise' : 'dead_end';
    if (reason === 'dead_end') return 'dead_end';
    if (reason === 'curated' || tags.includes('auto-curated')) return 'curated';
    if (node.kind === 'step' || node.kind === 'action') {
        if (node.status === 'done') return 'completed';
        if (node.status === 'abandoned' || reason === 'aborted') return 'aborted';
    }
    if (node.status === 'done') {
        if (node.kind === 'goal' || node.kind === 'topic') return 'closed';
        // P1：已解决的问题/假设是「已关闭」，不是异常中断。
        if (node.kind === 'question' || node.kind === 'hypothesis') return 'closed';
    }
    if (TRUE_VALUES.has(node.status)) {
        if (node.kind === 'goal' || node.kind === 'topic' || node.kind === 'step' || node.kind === 'action') return 'doing';
        if (node.kind === 'question' || node.kind === 'hypothesis') return 'todo';
    }
    return 'aborted';
}

/**
 * 「强待办」：人工写入、blocker、有细节子节点、重复命中。
 * 用于把自动提取的一句话旁白折到弱信号里，而不是直接丢掉。
 * @param {object} state
 * @param {object} node
 */
export function isStrongOpenNode(state, node) {
    if (node === null || node === undefined) return false;
    if (hasBlockerTag(node)) return true;
    if (node.origin !== 'auto') return true;
    if ((node.hits ?? 1) > 1) return true;
    return childrenOf(state, node.id).length > 0;
}

/**
 * 全图（或单会话）的状态摘要。
 *
 * 主桶（UI 首屏）：
 *  待办 184 = 164 可见 + 20 折叠；进行中 75；已记录 498；
 *  流程完成 128；已关闭 14；真死路 44。
 * 尾桶（可折叠）：自动收敛 146、已合并 30、工具失败 44、中断 4。
 *
 * @param {object} state
 * @param {{sessionId?: string|null}} [options]
 */
export function statusDigest(state, options = {}) {
    const sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : null;
    const phaseCounts = Object.fromEntries(PHASES.map((phase) => [phase, 0]));
    let total = 0;
    for (const node of state.nodes.values()) {
        if (sessionId !== null && node.sessionId !== sessionId) continue;
        total += 1;
        const phase = phaseOf(node);
        phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
    }

    // collectOpenItems 仍负责「噪音/旧主题/推理细节」的折叠判定；这里只补强/弱分层。
    const open = collectOpenItems(state, { sessionId, limit: 1_000_000_000 });
    let strong = 0;
    for (const item of open.visible) {
        if (isStrongOpenNode(state, item.node)) strong += 1;
    }
    const visible = open.visibleCount;
    const todo = {
        total: phaseCounts.todo,
        visible,
        hidden: open.hiddenCount,
        strong,
        weak: Math.max(0, visible - strong),
        noise: open.noiseCount,
        stale: open.staleCount,
        detail: open.detailCount,
    };
    const settled = {
        curated: phaseCounts.curated,
        merged: phaseCounts.merged,
        toolNoise: phaseCounts.tool_noise,
        aborted: phaseCounts.aborted,
        total: phaseCounts.curated + phaseCounts.merged + phaseCounts.tool_noise + phaseCounts.aborted,
    };
    const digest = {
        scope: sessionId !== null ? 'session' : 'workspace',
        sessionId,
        total,
        phaseCounts,
        todo,
        doing: phaseCounts.doing,
        recorded: phaseCounts.recorded,
        completed: phaseCounts.completed,
        closed: phaseCounts.closed,
        deadEnd: phaseCounts.dead_end,
        settled,
        main: visible,
    };
    // 6 个主桶（UI 首屏）；尾桶不计入「主数字」。
    digest.buckets = [
        { key: 'todo', label: '待办', count: todo.total, visible },
        { key: 'doing', label: '进行中', count: digest.doing },
        { key: 'recorded', label: '已记录', count: digest.recorded },
        { key: 'completed', label: '流程完成', count: digest.completed },
        { key: 'closed', label: '已关闭', count: digest.closed },
        { key: 'deadEnd', label: '真死路', count: digest.deadEnd },
    ];
    digest.reconciled = total === todo.total + digest.doing + digest.recorded
        + digest.completed + digest.closed + digest.deadEnd + settled.total;
    return digest;
}

/**
 * 一行式口径文案。scope 会写进字符串，避免「同一个数字不同范围」。
 * @param {ReturnType<typeof statusDigest>} digest
 * @param {{compact?: boolean}} [options]
 */
export function formatDigest(digest, options = {}) {
    if (digest === null || digest === undefined) return '';
    const scope = digest.scope === 'session' ? ' · 本会话' : ' · 全图';
    const todo = digest.todo ?? {};
    const settled = digest.settled ?? {};
    const closed = (digest.completed ?? 0) + (digest.closed ?? 0);
    if (options.compact === true) {
        return `待办 ${todo.visible ?? 0}${scope}（强 ${todo.strong ?? 0}；折叠 ${todo.hidden ?? 0}）`
            + ` · 进行中 ${digest.doing ?? 0} · 已记录 ${digest.recorded ?? 0}`
            + ` · 已收束 ${closed} · 死路 ${digest.deadEnd ?? 0}`;
    }
    return `待办 ${todo.visible ?? 0}${scope}（共 ${todo.total ?? 0}；强 ${todo.strong ?? 0} / 自动 ${todo.weak ?? 0}；折叠 ${todo.hidden ?? 0}）`
        + ` · 进行中 ${digest.doing ?? 0} · 已记录 ${digest.recorded ?? 0} · 已收束 ${closed}`
        + ` · 死路 ${digest.deadEnd ?? 0}（工具 ${settled.toolNoise ?? 0}）`
        + ` · 已收敛 ${(settled.curated ?? 0) + (settled.merged ?? 0)} · 中断 ${settled.aborted ?? 0}`;
}
