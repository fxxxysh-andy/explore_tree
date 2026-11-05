/**
 * 工具输出的紧凑渲染（面向大模型，token 友好）。
 *
 * 渲染器只读的内存结构（graph state / frontier 结果），不依赖宿主；
 * UI 面板走自己的快照渲染，不复用这里的文本格式。
 *
 * @module core/compact
 */
import {
    childrenOf,
    edgesOf,
    graphStats,
    pathToRoot,
    relatedNodes,
    rootNodes,
} from './graph.js';
import { collectOpenItems } from './hygiene.js';
import { formatDigest, isTrueDeadEnd, statusDigest } from './status.js';

const STATUS_MARK = Object.freeze({
    open: '○',
    active: '◐',
    done: '●',
    abandoned: '✗',
});

const KIND_LABEL = Object.freeze({
    goal: '目标',
    question: '问题',
    hypothesis: '假设',
    step: '步骤',
    action: '动作',
    evidence: '证据',
    decision: '决策',
    dead_end: '死路',
    conclusion: '结论',
    artifact: '产物',
    note: '笔记',
});

const EDGE_LABEL = Object.freeze({
    supports: '支持',
    contradicts: '反驳',
    refines: '细化',
    depends: '依赖',
    replaces: '替代',
    duplicates: '重复',
    continues: '延续',
    related: '相关',
});

/** 截断到 max 字符，超出加省略号。 */
export function truncate(value, max) {
    const text = value === null || value === undefined ? '' : String(value);
    if (max <= 0 || text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** 单行节点：`n12 ◐ hypothesis 标题 ~0.6 ×3`。 */
export function nodeLine(node, { maxTitle = 90 } = {}) {
    if (node === null || node === undefined) return '(missing node)';
    const mark = STATUS_MARK[node.status] ?? '?';
    const hits = node.hits > 1 ? ` ×${node.hits}` : '';
    const confidence = typeof node.confidence === 'number' ? ` ~${node.confidence}` : '';
    return `${node.id} ${mark} ${node.kind} ${truncate(node.title, maxTitle)}${confidence}${hits}`;
}

/** 节点详情：标题行 + 路径 + 摘要 + 子节点 + 关系 + 引用。 */
export function nodeDetail(state, node, { maxSummary = 1200, maxChildren = 20, maxEdges = 12 } = {}) {
    const lines = [];
    lines.push(`${node.id} [${node.kind}/${node.status}] ${node.title}`);
    const path = pathToRoot(state, node.id);
    lines.push(`路径：${path.map((item) => item.id).join(' > ')}`);
    if (node.summary !== '') lines.push(`摘要：${truncate(node.summary, maxSummary)}`);
    if (typeof node.confidence === 'number') lines.push(`置信度：${node.confidence}`);
    const lease = node.kind === 'topic'
        ? `租约：${node.owner ?? '未认领'}${node.leaseUntil !== null && node.leaseUntil !== undefined ? `（至 ${node.leaseUntil}）` : ''}，leaseEpoch ${node.leaseEpoch ?? 0}`
        : null;
    if (lease !== null) lines.push(lease);
    lines.push(`版本：nodeVersion ${node.nodeVersion ?? 1}${node.updatedBy !== null && node.updatedBy !== undefined ? `；最后写者 ${node.updatedBy}` : ''}${node.revision > 1 ? `；摘要 revision ${node.revision}` : ''}`);
    if (node.tags.length > 0) lines.push(`标签：${node.tags.join(', ')}`);
    if (node.refs.length > 0) {
        lines.push('引用：');
        for (const ref of node.refs.slice(0, 12)) {
            lines.push(`  - ${ref.kind}: ${truncate(ref.value, 160)}${ref.label !== undefined ? `（${ref.label}）` : ''}`);
        }
    }
    const children = childrenOf(state, node.id);
    if (children.length > 0) {
        lines.push(`子节点（${children.length}）：`);
        for (const child of children.slice(0, maxChildren)) lines.push(`  ${nodeLine(child, { maxTitle: 80 })}`);
        if (children.length > maxChildren) lines.push(`  …还有 ${children.length - maxChildren} 个`);
    } else {
        lines.push('子节点：无');
    }
    const edges = edgesOf(state, node.id).slice(0, maxEdges);
    if (edges.length > 0) {
        lines.push('跨分支关系：');
        for (const edge of edges) {
            const other = edge.from === node.id ? edge.to : edge.from;
            const direction = edge.from === node.id ? '→' : '←';
            lines.push(`  ${direction} ${EDGE_LABEL[edge.kind] ?? edge.kind} ${other}${edge.note !== '' ? `（${truncate(edge.note, 80)}）` : ''}`);
        }
    }
    return lines.join('\n');
}

/**
 * ASCII 树。从根或指定节点展开，默认焦点路径加深，其余折叠。
 */
export function renderTree(state, { rootId = null, focusId = null, maxDepth = 5, maxNodes = 48 } = {}) {
    const focusPath = new Set(focusId !== null ? pathToRoot(state, focusId).map((node) => node.id) : []);
    const roots = rootId !== null ? [state.nodes.get(rootId)].filter(Boolean) : rootNodes(state);
    const lines = [];
    let emitted = 0;
    let truncated = false;

    const walk = (node, depth, prefix, isLast) => {
        if (emitted >= maxNodes) {
            truncated = true;
            return;
        }
        const focus = node.id === focusId ? '▸' : '';
        const connector = depth === 0 ? '' : `${isLast ? '└─' : '├─'} `;
        lines.push(`${prefix}${connector}${focus}${nodeLine(node, { maxTitle: 70 })}`);
        emitted += 1;
        const children = childrenOf(state, node.id);
        if (children.length === 0 || depth + 1 > maxDepth) return;
        const childPrefix = depth === 0 ? '' : `${prefix}${isLast ? '   ' : '│  '}`;
        for (let index = 0; index < children.length; index += 1) {
            const child = children[index];
            const childOnFocusPath = focusPath.has(child.id);
            if (depth + 1 === maxDepth && !childOnFocusPath && index > 4) {
                lines.push(`${childPrefix}└─ …还有 ${children.length - index} 个`);
                break;
            }
            walk(child, depth + 1, childPrefix, index === children.length - 1);
        }
    };

    for (let index = 0; index < roots.length; index += 1) walk(roots[index], 0, '', index === roots.length - 1);
    if (truncated || emitted >= maxNodes) lines.push(`…树已截断（显示 ${emitted} 个节点）`);
    return lines.join('\n');
}

/**
 * 总览：目标、焦点路径、最近节点、未决项、死路、产物。
 */
export function renderOverview(state, { sessionId = null, focusId = null, limit = 12 } = {}) {
    const stats = graphStats(state);
    const session = sessionId !== null ? state.sessions.get(sessionId) : undefined;
    // 指定会话时只汇总本会话的节点：树跨会话共享，overview 不该把别的会话的历史重新贴一遍。
    const inSession = (node) => sessionId === null || node.sessionId === sessionId;
    const digest = statusDigest(state, { sessionId });
    const focus = focusId ?? session?.activeNodeId ?? null;
    const lines = [];
    lines.push(`研究图：${state.workspaceRoot}`);
    lines.push(`规模：${stats.nodes} 节点 / ${stats.edges} 关系 / ${stats.sessions} 会话`);
    lines.push(`状态：${formatDigest(digest)}`);
    if (digest.scope === 'session') lines.push(`全图：${formatDigest(statusDigest(state), { compact: true })}`);
    if (state.meta?.lastSessionId !== undefined && sessionId === null) {
        lines.push(`最近会话：${state.meta.lastSessionId}`);
    }

    const goals = rootNodes(state).filter((node) => node.kind === 'goal' && inSession(node));
    if (goals.length > 0) {
        lines.push('目标：');
        for (const goal of goals.slice(0, 6)) lines.push(`  ${nodeLine(goal, { maxTitle: 60 })}`);
    }
    if (focus !== null) {
        const node = state.nodes.get(focus);
        if (node !== undefined) {
            lines.push(`焦点：${nodeLine(node, { maxTitle: 80 })}`);
            lines.push(`路径：${pathToRoot(state, focus).map((item) => `${item.id}:${item.kind}`).join(' > ')}`);
        }
    }

    const recent = [...state.nodes.values()]
        .filter(inSession)
        .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, limit);
    if (recent.length > 0) {
        lines.push(`最近更新（${recent.length}）：`);
        for (const node of recent) lines.push(`  ${nodeLine(node, { maxTitle: 70 })}`);
    }

    const open = collectOpenItems(state, { sessionId, limit: 8 });
    const scope = digest.scope === 'session' ? ' · 本会话' : ' · 全图';
    if (open.visibleCount > 0) {
        const folded = open.hiddenCount > 0
            ? `（已折叠 ${open.hiddenCount}：旁白 ${open.noiseCount} / 旧主题 ${open.staleCount} / 推理细节 ${open.detailCount}）`
            : '';
        lines.push(`待办（${open.visibleCount}${scope}；强 ${digest.todo.strong} / 自动 ${digest.todo.weak}）${folded}：`);
        for (const item of open.visible) lines.push(`  ${nodeLine(item.node, { maxTitle: 80 })}`);
    } else if (open.total > 0) {
        // 全部被折叠时不要把「0」当成没有待办：明确写出可展示 0 与折叠明细。
        lines.push(`待办（0 可展示${scope}；已折叠 ${open.hiddenCount}：旁白 ${open.noiseCount} / 旧主题 ${open.staleCount} / 推理细节 ${open.detailCount}）：`);
    }

    const deadCandidates = [...state.nodes.values()]
        .filter((node) => (node.kind === 'dead_end' || node.status === 'abandoned') && inSession(node));
    const deadEnds = deadCandidates.filter((node) => isTrueDeadEnd(node));
    if (deadEnds.length > 0) {
        const folded = deadCandidates.length - deadEnds.length;
        const suffix = folded > 0 ? `；已折叠 ${folded} 条工具失败/已合并/自动收敛` : '';
        lines.push(`研究死路（${deadEnds.length}${scope}，避免重复${suffix}）：`);
        for (const node of deadEnds.slice(0, 6)) {
            lines.push(`  ${node.id} ${truncate(node.title, 70)}${node.summary !== '' ? ` — ${truncate(node.summary.split('\n')[0], 100)}` : ''}`);
        }
    }

    const artifacts = [...state.nodes.values()].filter((node) => node.kind === 'artifact' && inSession(node));
    if (artifacts.length > 0) {
        lines.push(`产物（${artifacts.length}）：`);
        for (const node of artifacts.slice(0, 6)) {
            const ref = node.refs.find((item) => item.kind === 'file' || item.kind === 'artifact' || item.kind === 'url');
            lines.push(`  ${node.id} ${truncate(node.title, 70)}${ref !== undefined ? ` → ${truncate(ref.value, 120)}` : ''}`);
        }
    }

    const conclusions = [...state.nodes.values()].filter((node) => node.kind === 'conclusion' && inSession(node));
    if (conclusions.length > 0) {
        lines.push(`结论（${conclusions.length}）：`);
        for (const node of conclusions.slice(-5)) lines.push(`  ${nodeLine(node, { maxTitle: 80 })}`);
    }

    lines.push('可用动作：overview / stats / find / node / path / frontier（frontier 给出下一步建议，含验证与收敛）');
    return lines.join('\n');
}

function formatCounts(counts) {
    return Object.entries(counts)
        .map(([key, value]) => `${key}:${value}`)
        .join(' ');
}

function formatTopActors(counts, limit = 5) {
    return Object.entries(counts)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, limit)
        .map(([key, value]) => `${key}:${value}`)
        .join(' ');
}

/** 统计详情。 */
export function renderStats(state) {
    const stats = graphStats(state);
    const lines = [
        `节点 ${stats.nodes} · 关系 ${stats.edges} · 根 ${stats.roots} · 会话 ${stats.sessions}`,
        `类型：${formatCounts(stats.byKind)}`,
        `原始状态（兼容/调试）：${formatCounts(stats.byStatus)}`,
        `语义状态：${formatDigest(statusDigest(state))}`,
        `创建者：${formatTopActors(stats.byCreator)}`,
        `最近更新：${formatTopActors(stats.byUpdater)}`,
        `重复命中：${stats.repeated} · 假设：${stats.hypotheses}（未验证 ${stats.unverifiedHypotheses}）· 死路：${stats.deadEnds} · 结论：${stats.conclusions} · 产物：${stats.artifacts}`,
    ];
    return lines.join('\n');
}

/** 从根到节点的路径。 */
export function renderPath(state, id) {
    const node = state.nodes.get(id);
    if (node === undefined) return `节点 ${id} 不存在`;
    const path = pathToRoot(state, id);
    const lines = [`到 ${id} 的路径（${path.length} 层）：`];
    for (let index = 0; index < path.length; index += 1) {
        const item = path[index];
        lines.push(`${'  '.repeat(index)}${index === path.length - 1 ? '▸ ' : ''}${nodeLine(item, { maxTitle: 80 })}`);
    }
    return lines.join('\n');
}

/** 搜索结果。 */
export function renderSearch(state, nodes, query) {
    if (nodes.length === 0) return `没有匹配「${truncate(query, 80)}」的节点。`;
    const lines = [`匹配「${truncate(query, 80)}」的节点（${nodes.length}）：`];
    for (const node of nodes.slice(0, 20)) {
        const firstSummary = node.summary.split('\n')[0];
        const hint = firstSummary !== '' && !node.title.toLowerCase().includes(query.toLowerCase())
            ? ` — ${truncate(firstSummary, 80)}`
            : '';
        lines.push(`  ${nodeLine(node, { maxTitle: 90 })}${hint}`);
    }
    return lines.join('\n');
}

/** frontier 建议渲染。 */
export function renderFrontier(result) {
    const lines = [];
    if (result.focus !== null && result.focus !== undefined) {
        lines.push(`焦点：${result.focus.id} ${result.focus.kind}/${result.focus.status} ${truncate(result.focus.title, 80)}`);
    }
    lines.push(`建议（${result.suggestions.length}）：`);
    for (const item of result.suggestions) {
        const target = item.targetId !== null && item.targetId !== undefined ? ` → ${item.targetId}` : '';
        lines.push(`  [${item.type}]${target} ${truncate(item.reason, 220)}`);
    }
    if (result.avoid.length > 0) {
        lines.push(`避免：`);
        for (const item of result.avoid) lines.push(`  ${item.nodeId} ${truncate(item.reason, 160)}`);
    }
    if (result.notes.length > 0) {
        lines.push('备注：');
        for (const note of result.notes) lines.push(`  - ${note}`);
    }
    return lines.join('\n');
}

/** 图摘要（供 LLM prompt 模板使用，不含动态状态时才是静态前缀）。 */
export function summarizeForPrompt(state, { maxItems = 10 } = {}) {
    const stats = graphStats(state);
    const open = collectOpenItems(state, { limit: maxItems }).visible
        .map((item) => nodeLine(item.node, { maxTitle: 60 }));
    return {
        stats,
        open,
        recent: [...state.nodes.values()].slice(-maxItems).map((node) => nodeLine(node, { maxTitle: 60 })),
    };
}

export { KIND_LABEL, EDGE_LABEL, STATUS_MARK, relatedNodes };
