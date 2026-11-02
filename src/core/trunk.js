/**
 * 摘要主干（v0.13 P0）：topic 的判定、模板摘要、主干视图与不变量校验。
 *
 * 设计（见 docs/tree-structure-research.md）：
 *  - 父子关系只表达问题分解：goal → topic* → 叶根 → 叶；
 *  - topic 的 digest 只由子节点的标题/摘要/状态合成，不读原文；
 *  - 时间轴（step/turn/sessionId）退为元数据，主干视图不显示 step。
 *
 * 纯函数 + 少量就地更新（refreshTopicDigest 通过 graph.updateNode 写回）。
 *
 * @module core/trunk
 */
import { fingerprint } from './fingerprint.js';
import { computeFrontier } from './frontier.js';
import { childrenOf, isDescendant, updateNode } from './graph.js';
import { isAutoCuratedNode } from './hygiene.js';
import {
    clampText,
    isLeafRootKind,
    MAX_DIGEST,
    TRUNK_KIND,
} from './model.js';

/** 展示建议长度（硬上限仍是 MAX_DIGEST）。 */
export const DIGEST_DISPLAY_MAX = 120;
/** 主干宽度/深度建议上限。 */
export const TRUNK_MAX_WIDTH = 9;
export const TRUNK_MAX_DEPTH = 4;

/** @param {unknown} node */
export function isTopic(node) {
    return node !== null && typeof node === 'object' && node.kind === TRUNK_KIND;
}

/**
 * 叶根：可作为「研究叶」锚点的想法节点。
 * 结构上要求直接挂在 topic 下（或显式 tags:['leaf-root']）；
 * 叶根下面的 question/evidence/decision 是叶内细节，不再算叶根。
 */
export function isArchived(node) {
    return Array.isArray(node?.tags) && node.tags.includes('archived');
}

/** 叶根：直接挂 topic 的想法节点，或显式打 leaf-root 标签的节点。 */
export function isLeafRoot(state, node) {
    if (node === null || node === undefined) return false;
    if (!isLeafRootKind(node.kind)) return false;
    // 交接记录是审计节点，不是研究叶根，避免污染 topic 进度与摘要。
    if (Array.isArray(node.tags) && node.tags.includes('handoff')) return false;
    if (Array.isArray(node.tags) && node.tags.includes('leaf-root')) return true;
    const parent = state.nodes.get(node.parentId ?? '');
    return isTopic(parent);
}

/** 语义节点（应当挂在 topic/叶根下，而不是时间桶下）。 */
export function isSemanticKind(kind) {
    return kind !== 'goal' && kind !== TRUNK_KIND && kind !== 'step'
        && kind !== 'action' && kind !== 'artifact' && kind !== 'note';
}

/** topic 直接子节点中的叶根。 */
export function leafRootsOf(state, topicId) {
    return childrenOf(state, topicId).filter((node) => isLeafRoot(state, node));
}

/** 子 topic。 */
export function childTopicsOf(state, topicId) {
    return childrenOf(state, topicId).filter((node) => isTopic(node));
}

/** 节点最近的 topic 祖先（含自身）；用于判断 contradicts 边属于哪个主题。 */
function nearestTopicOf(state, nodeId) {
    let cursor = state.nodes.get(nodeId);
    const seen = new Set();
    while (cursor !== undefined && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        if (isTopic(cursor)) return cursor.id;
        cursor = cursor.parentId === null || cursor.parentId === undefined ? undefined : state.nodes.get(cursor.parentId);
    }
    return null;
}

/**
 * topic 级冲突：两端最近 topic 都指向同一个 topic 的 contradicts 边。
 * 冲突不改变节点状态；只作为 trunk/brief/frontier 的可见标记，避免把「讨论过冲突」误当成「已解决」。
 */
export function topicConflicts(state, topicId) {
    if (!Array.isArray(state.edges)) return [];
    return state.edges.filter((edge) => edge.kind === 'contradicts'
        && nearestTopicOf(state, edge.from) === topicId
        && nearestTopicOf(state, edge.to) === topicId);
}

/** 主题进度：直接叶根的完成数与总数。 */
export function topicProgress(state, topicId) {
    const roots = leafRootsOf(state, topicId);
    return {
        total: roots.length,
        done: roots.filter((node) => node.status === 'done').length,
        open: roots.filter((node) => node.status !== 'done' && node.status !== 'abandoned').length,
    };
}

/**
 * 模板摘要：只读子 topic 的标题/摘要与叶根标题/状态。
 *
 * @param {object} state
 * @param {object} topic
 * @returns {string}
 */
export function topicDigest(state, topic) {
    const children = childrenOf(state, topic.id);
    const topics = children.filter((node) => isTopic(node));
    const leaves = children.filter((node) => isLeafRoot(state, node));
    const parts = [];
    for (const child of topics.slice(0, 3)) {
        parts.push(`${child.title}${child.status === 'done' ? '✓' : ''}`);
    }
    for (const leaf of leaves.slice(0, 3)) {
        parts.push(`${leaf.title}${leaf.status === 'done' ? '✓' : ''}`);
    }
    if (leaves.length > 3) parts.push(`…等 ${leaves.length} 个叶根`);
    if (parts.length === 0) {
        const summary = typeof topic.summary === 'string' ? topic.summary : '';
        return clampText(summary, DIGEST_DISPLAY_MAX) || '尚未展开';
    }
    const progress = topicProgress(state, topic.id);
    const suffix = progress.total > 0 ? `（完成 ${progress.done}/${progress.total}）` : '';
    return clampText(`${parts.join('；')}${suffix}`, DIGEST_DISPLAY_MAX);
}

/**
 * 摘要依据：子节点 id + 摘要内容哈希。用于判断 digest 是否过期。
 *
 * @param {object} state
 * @param {object} topic
 * @param {string} digest
 */
export function digestBasisOf(state, topic, digest) {
    const children = childrenOf(state, topic.id);
    const ids = children.map((node) => node.id);
    const hash = fingerprint('digest', `${digest}\u0000${ids.join(',')}`);
    return { children: ids, hash };
}

/** digest 是否与当前子节点一致（basis.hash 比对）。 */
export function isDigestStale(state, topic) {
    if (!isTopic(topic) || typeof topic.digest !== 'string' || topic.digest === '') return true;
    const basis = topic.digestBasis;
    if (basis === null || typeof basis !== 'object') return topic.digestSource !== 'human';
    const digest = topicDigest(state, topic);
    return basis.hash !== digestBasisOf(state, topic, digest).hash;
}

/**
 * 重算一个 topic 的模板摘要并写回；人工摘要（human）默认保留。
 *
 * @param {object} state
 * @param {string} topicId
 * @param {{force?: boolean, now?: string}} [opts]
 * @returns {object|null}
 */
export function refreshTopicDigest(state, topicId, opts = {}) {
    const topic = state.nodes.get(topicId);
    if (!isTopic(topic)) return null;
    if (topic.digestSource === 'human' && opts.force !== true) return topic;
    const digest = topicDigest(state, topic);
    const basis = digestBasisOf(state, topic, digest);
    const same = topic.digest === digest
        && topic.digestBasis !== null
        && typeof topic.digestBasis === 'object'
        && topic.digestBasis.hash === basis.hash;
    if (same) return topic;
    return updateNode(state, topicId, {
        digest,
        digestSource: 'template',
        digestBasis: basis,
    }, opts.now !== undefined ? { now: opts.now } : {});
}

/**
 * 从某个节点向上刷新所有祖先 topic（含自身是 topic 的情况）。
 *
 * @param {object} state
 * @param {string} nodeId
 * @param {{force?: boolean, now?: string}} [opts]
 * @returns {object[]} 被更新的 topic
 */
export function refreshAncestorTopics(state, nodeId, opts = {}) {
    const touched = [];
    let current = state.nodes.get(nodeId);
    const seen = new Set();
    if (isTopic(current)) {
        const next = refreshTopicDigest(state, current.id, opts);
        if (next !== null) touched.push(next);
    }
    let guard = 0;
    while (current !== undefined && current.parentId !== null && current.parentId !== undefined && guard < 200) {
        if (seen.has(current.parentId)) break;
        seen.add(current.parentId);
        current = state.nodes.get(current.parentId);
        if (isTopic(current)) {
            const next = refreshTopicDigest(state, current.id, opts);
            if (next !== null) touched.push(next);
        }
        guard += 1;
    }
    return touched;
}

/** 某个 topic 的子树（topic + 叶根 + 叶），供研究视图与测试使用。 */
export function topicSubtree(state, topicId) {
    const root = state.nodes.get(topicId);
    if (!isTopic(root)) return null;
    const build = (node) => ({
        id: node.id,
        kind: node.kind,
        title: node.title,
        status: node.status,
        digest: node.digest ?? null,
        children: childrenOf(state, node.id).map(build),
    });
    return build(root);
}

/**
 * 主干树：goal → topic 递归；叶根只给摘要信息（不展开叶子细节）。
 *
 * @param {object} state
 * @param {{goalId?: string|null}} [opts]
 */
export function trunkOf(state, opts = {}) {
    const goalId = typeof opts.goalId === 'string' ? opts.goalId : null;
    const goals = [...state.nodes.values()]
        .filter((node) => node.kind === 'goal' && (goalId === null || node.id === goalId))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return goals.map((goal) => ({
        id: goal.id,
        title: goal.title,
        status: goal.status,
        topics: childrenOf(state, goal.id).filter((node) => isTopic(node)).map((topic) => trunkNode(state, topic)),
    }));
}

function trunkNode(state, topic) {
    const children = childrenOf(state, topic.id);
    const progress = topicProgress(state, topic.id);
    return {
        id: topic.id,
        title: topic.title,
        status: topic.status,
        digest: topic.digest ?? topicDigest(state, topic),
        owner: topic.owner ?? null,
        leaseUntil: topic.leaseUntil ?? null,
        priority: topic.priority ?? null,
        revision: topic.revision ?? 1,
        stale: isDigestStale(state, topic),
        conflicts: topicConflicts(state, topic.id).length,
        progress,
        children: children.filter((node) => isTopic(node)).map((node) => trunkNode(state, node)),
        leaves: children.filter((node) => isLeafRoot(state, node)).map((node) => ({
            id: node.id,
            kind: node.kind,
            title: node.title,
            status: node.status,
            children: childrenOf(state, node.id).length,
            owner: node.owner ?? null,
            archived: isArchived(node),
        })),
    };
}

/** 主干统计（brief/audit/UI 共用）。 */
export function trunkStats(state) {
    const nodes = [...state.nodes.values()];
    const topics = nodes.filter((node) => isTopic(node));
    const leafRoots = nodes.filter((node) => isLeafRoot(state, node) && isTopic(state.nodes.get(node.parentId ?? '')));
    const semanticUnderStep = nodes.filter((node) => isSemanticKind(node.kind)
        && state.nodes.get(node.parentId ?? '')?.kind === 'step');
    return {
        goals: nodes.filter((node) => node.kind === 'goal').length,
        topics: topics.length,
        leafRoots: leafRoots.length,
        doneLeafRoots: leafRoots.filter((node) => node.status === 'done').length,
        openLeafRoots: leafRoots.filter((node) => node.status !== 'done' && node.status !== 'abandoned').length,
        ownedTopics: topics.filter((node) => typeof node.owner === 'string' && node.owner !== '').length,
        semanticUnderStep: semanticUnderStep.length,
        staleDigests: topics.filter((node) => isDigestStale(state, node)).length,
        conflictedTopics: topics.filter((node) => topicConflicts(state, node.id).length > 0).length,
        archivedLeaves: leafRoots.filter((node) => isArchived(node)).length,
        archivedTopics: topics.filter((node) => isArchived(node)).length,
    };
}

/** 深度（根=0）。 */
export function depthOf(state, nodeId) {
    let depth = 0;
    let current = state.nodes.get(nodeId);
    const seen = new Set();
    while (current !== undefined && current.parentId !== null && current.parentId !== undefined) {
        if (seen.has(current.parentId)) break;
        seen.add(current.parentId);
        current = state.nodes.get(current.parentId);
        depth += 1;
        if (depth > 500) break;
    }
    return depth;
}

/**
 * 主干不变量校验（P0）：
 *  - ERROR：topic 父节点不是 goal/topic；topic 子节点不是 topic/叶根；topic 缺 digest。
 *  - WARN：叶根父节点不是 topic；语义节点仍挂在 step；宽度/深度/摘要长度超限；摘要过期。
 *
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateTrunk(state) {
    const errors = [];
    const warnings = [];
    const nodes = [...state.nodes.values()];
    for (const node of nodes) {
        if (!isTopic(node)) continue;
        const parent = state.nodes.get(node.parentId ?? '');
        if (parent !== undefined && parent.kind !== 'goal' && !isTopic(parent)) {
            errors.push(`${node.id}: topic 的父节点必须是 goal 或 topic（当前 ${parent.id}/${parent.kind}）`);
        }
        for (const child of childrenOf(state, node.id)) {
            if (isTopic(child)) continue;
            if (isLeafRoot(state, child)) continue;
            errors.push(`${node.id}: topic 子节点 ${child.id}（${child.kind}）必须是 topic 或叶根`);
        }
        if (typeof node.digest !== 'string' || node.digest.trim() === '') {
            errors.push(`${node.id}: topic 缺少 digest（运行 refreshTopicDigest 或人工填写）`);
        } else if (node.digest.length > DIGEST_DISPLAY_MAX) {
            warnings.push(`${node.id}: digest ${node.digest.length} 字，超过建议 ${DIGEST_DISPLAY_MAX}`);
        }
        const width = childrenOf(state, node.id).length;
        if (width > TRUNK_MAX_WIDTH) warnings.push(`${node.id}: 主干宽度 ${width}，建议拆分（上限 ${TRUNK_MAX_WIDTH}）`);
        const depth = depthOf(state, node.id);
        if (depth > TRUNK_MAX_DEPTH) warnings.push(`${node.id}: 主干深度 ${depth}，超过 ${TRUNK_MAX_DEPTH}`);
        if (isDigestStale(state, node)) warnings.push(`${node.id}: digest 已过期（子节点变化后未重算）`);
    }
    for (const node of nodes) {
        if (!isLeafRootKind(node.kind)) continue;
        if (isLeafRoot(state, node)) continue;
        const parent = state.nodes.get(node.parentId ?? '');
        const where = parent !== undefined ? `${parent.id}/${parent.kind}` : '根';
        warnings.push(`${node.id}: 叶根 ${node.kind} 挂在 ${where} 下，应挂到 topic`);
    }
    const underStep = nodes.filter((node) => isSemanticKind(node.kind) && state.nodes.get(node.parentId ?? '')?.kind === 'step');
    if (underStep.length > 0) {
        warnings.push(`${underStep.length} 个语义节点仍挂在 step 下（旧图迁移未完成）`);
    }
    return { ok: errors.length === 0, errors, warnings };
}

/** 主干视图的纯文本渲染（工具输出用）。 */
export function renderTrunk(state, opts = {}) {
    const goalId = typeof opts.goalId === 'string' ? opts.goalId : null;
    const includeArchived = opts.includeArchived === true;
    let hiddenArchived = 0;
    const stats = trunkStats(state);
    const lines = [];
    lines.push(`研究主干：${stats.topics} 个主题 / ${stats.leafRoots} 个叶根（完成 ${stats.doneLeafRoots}）`);
    const goals = trunkOf(state, { goalId });
    if (goals.length === 0) {
        lines.push('（还没有 goal：先用 record add 建一个目标）');
        return lines.join('\n');
    }
    for (const goal of goals) {
        lines.push(`目标 ${goal.id} ${goal.title}`);
        if (goal.topics.length === 0) {
            lines.push('  （尚未建立主干：record add kind=topic，或把已有 leaf root move 到 topic 下）');
            continue;
        }
        for (const topic of goal.topics) hiddenArchived += renderTopicLines(topic, 1, lines, includeArchived);
    }
    if (hiddenArchived > 0) lines.push(`\n已归档 ${hiddenArchived} 个叶根（trunk 传 archived:true 查看）。`);
    if (stats.semanticUnderStep > 0) {
        lines.push(`\n旧图提示：${stats.semanticUnderStep} 个语义节点仍挂在 step 下；audit-graph 会给出 WARN，可用 move 迁到叶根下。`);
    }
    return lines.join('\n');
}

function renderTopicLines(topic, level, lines, includeArchived = false) {
    const indent = '  '.repeat(level);
    const progress = topic.progress.total > 0 ? ` [${topic.progress.done}/${topic.progress.total}]` : '';
    const owner = topic.owner !== null ? ` @${topic.owner}` : '';
    const flag = topic.status === 'done' ? '✓' : (topic.status === 'abandoned' ? '×' : '');
    const conflict = topic.conflicts > 0 ? ' ⚠冲突' : '';
    lines.push(`${indent}- ${topic.id} ${topic.title}${flag}${progress}${owner}${conflict}`);
    lines.push(`${indent}  ${topic.digest}${topic.stale ? '（摘要过期）' : ''}`);
    let hidden = 0;
    for (const child of topic.children) hidden += renderTopicLines(child, level + 1, lines, includeArchived);
    for (const leaf of topic.leaves) {
        if (leaf.archived === true && !includeArchived) {
            hidden += 1;
            continue;
        }
        const mark = leaf.status === 'done' ? '✓' : (leaf.status === 'abandoned' ? '×' : '');
        const size = leaf.children > 0 ? `（${leaf.children} 个细节）` : '';
        lines.push(`${indent}  · ${leaf.id} ${leaf.title}${mark}${size}${leaf.archived === true ? '（已归档）' : ''}`);
    }
    return hidden;
}

/** 认领状态：unowned / leased（租约有效）/ expired（租约过期）/ owned（无到期时间）。 */
export function leaseStatus(node, now = Date.now()) {
    if (node === null || node === undefined) return 'unowned';
    if (typeof node.owner !== 'string' || node.owner === '') return 'unowned';
    if (typeof node.leaseUntil !== 'string' || node.leaseUntil === '') return 'owned';
    const at = Date.parse(node.leaseUntil);
    if (!Number.isFinite(at)) return 'owned';
    return at > now ? 'leased' : 'expired';
}

/** 可被认领/接手的 topic：未认领或租约已过期。 */
export function claimableTopics(state, now = Date.now()) {
    return [...state.nodes.values()]
        .filter((node) => isTopic(node) && node.status !== 'done' && node.status !== 'abandoned' && !isArchived(node))
        .filter((node) => {
            const status = leaseStatus(node, now);
            return status === 'unowned' || status === 'expired';
        });
}

/** topic ↔ Team task 的映射负载（subject/description/标签；writeScopes 由调用方补文件范围）。 */
export function topicTaskPayload(topic) {
    if (!isTopic(topic)) return null;
    const description = typeof topic.digest === 'string' && topic.digest !== ''
        ? topic.digest
        : (typeof topic.summary === 'string' ? topic.summary : '');
    return {
        subject: topic.title,
        description: description === '' ? topic.title : description,
        tags: ['explore-tree', 'topic', ...(topic.priority ? [topic.priority] : [])],
    };
}

/** 是否过期叶子节点（供 brief 排序）。 */
export function leafRootImportance(node) {
    let score = 0;
    if (node.status === 'open' || node.status === 'active') score += 6;
    if (node.kind === 'question' || node.kind === 'hypothesis') score += 3;
    if (node.kind === 'decision') score += 2;
    // 显式写入的未决比自动提取的旧疑问更值得进简报；auto 仍保留为兜底。
    if (node.origin !== 'auto') score += 4;
    return score + (node.hits ?? 1);
}

/**
 * 主干级 frontier：该推进/认领/刷新哪个 topic。叶子级建议仍由 core/frontier 给出。
 *
 * @param {object} state
 * @param {{limit?: number}} [opts]
 */
export function trunkFrontier(state, opts = {}) {
    const limit = Number.isInteger(opts.limit) ? Math.max(1, Math.min(10, opts.limit)) : 3;
    const items = [];
    const topics = [...state.nodes.values()].filter((node) => isTopic(node));
    for (const topic of topics) {
        if (topic.status === 'done' || topic.status === 'abandoned' || isArchived(topic)) continue;
        const leaves = leafRootsOf(state, topic.id);
        const open = leaves.filter((node) => node.status !== 'done' && node.status !== 'abandoned');
        if (open.length > 0) {
            items.push({
                type: 'advance',
                targetId: topic.id,
                priority: topic.priority ?? null,
                reason: `${open.length} 个未决叶根：${open.slice(0, 2).map((node) => node.title).join('；')}`,
            });
        }
        const lease = leaseStatus(topic);
        if (lease === 'unowned') {
            items.push({ type: 'claim', targetId: topic.id, priority: topic.priority ?? null, reason: '未认领（assign 后可交接给 agent）' });
        } else if (lease === 'expired') {
            items.push({ type: 'claim', targetId: topic.id, priority: topic.priority ?? null, reason: '租约已过期，可重新认领' });
        }
        for (const leaf of leaves) {
            if (isArchived(leaf)) continue;
            const details = childrenOf(state, leaf.id);
            const turns = new Set(details.map((node) => node.turn).filter((turn) => Number.isInteger(turn)));
            if (details.length >= 6 && turns.size >= 2) {
                items.push({ type: 'promote', targetId: leaf.id, priority: topic.priority ?? null,
                    reason: `${details.length} 个细节、跨 ${turns.size} 轮，可提升为子主题` });
            }
        }
        if (isDigestStale(state, topic)) {
            items.push({ type: 'refresh', targetId: topic.id, priority: topic.priority ?? null, reason: 'digest 已过期（子节点变化后未重算）' });
        }
        const conflicts = topicConflicts(state, topic.id);
        if (conflicts.length > 0) {
            items.push({
                type: 'resolve',
                targetId: topic.id,
                priority: topic.priority ?? null,
                reason: `${conflicts.length} 条 contradicts 边未收敛：${conflicts.slice(0, 2).map((edge) => `${edge.from}↔${edge.to}`).join('；')}`,
            });
        }
    }
    const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
    items.sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9));
    return items.slice(0, limit);
}

/**
 * 当前会话对应的 goal：优先 session.goalId，其次最近创建的 goal。
 * 简报和增量都只围绕一个 goal，避免把其他工作区的目标混进来。
 */
function briefGoalOf(state, sessionId) {
    if (sessionId !== null) {
        const session = state.sessions.get(sessionId);
        if (session?.goalId) {
            const goal = state.nodes.get(session.goalId);
            if (goal !== undefined && goal.kind === 'goal') return goal;
        }
    }
    const goals = [...state.nodes.values()]
        .filter((node) => node.kind === 'goal')
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return goals[goals.length - 1] ?? null;
}

/**
 * ≤400 字研究简报：目标 / 主干 digest / 未决叶根 / 主干 + 叶子建议。
 * 轮首或 compaction 后注入时使用（source.kind = explore-tree-context）。
 *
 * @param {object} state
 * @param {{sessionId?: string|null, focusId?: string|null, limit?: number, scope?: 'workspace'|'goal'}} [options]
 *   scope='workspace'（默认）时额外列「其他主干」，让同工作区的其他 goal 可见；
 *   scope='goal' 保留旧的单 goal 视图。
 */
export function renderBrief(state, options = {}) {
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    const focusId = options.focusId ?? null;
    const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(5, options.limit)) : 3;
    const scope = options.scope === 'goal' ? 'goal' : 'workspace';
    const goal = briefGoalOf(state, sessionId);
    const topics = goal !== null ? childrenOf(state, goal.id).filter((node) => isTopic(node)) : [];
    const ownTopicIds = new Set(topics.map((topic) => topic.id));
    const otherTopics = scope === 'workspace' && goal !== null
        ? [...state.nodes.values()]
            .filter((node) => isTopic(node) && !ownTopicIds.has(node.id) && !isArchived(node))
            .filter((node) => !isDescendant(state, goal.id, node.id))
            .sort((a, b) => {
                const done = (node) => (node.status === 'done' ? 1 : 0);
                const priority = { P0: 0, P1: 1, P2: 2, P3: 3 };
                return done(a) - done(b)
                    || (priority[a.priority] ?? 9) - (priority[b.priority] ?? 9)
                    || (a.order ?? 0) - (b.order ?? 0);
            })
        : [];
    const lines = [`【研究轨迹简报】目标：${goal !== null ? goal.title : '（未建目标）'}`];
    if (topics.length === 0) {
        lines.push('主干：尚未建立（record add kind=topic 建主题，再把叶根挂上去）');
    } else {
        const summary = topics.slice(0, 4).map((topic) => {
            const label = typeof topic.digest === 'string' && topic.digest !== '' ? topic.digest : (topic.summary ?? '');
            const conflict = topicConflicts(state, topic.id).length > 0 ? '⚠冲突' : '';
            return `${topic.title}${label !== '' ? `（${label}）` : ''}${conflict}`;
        });
        lines.push(`主干：${summary.join('；')}`);
        const conflicted = topics.filter((topic) => topicConflicts(state, topic.id).length > 0);
        if (conflicted.length > 0) {
            lines.push(`冲突：${conflicted.slice(0, 3).map((topic) => topic.title).join('；')}（用 contradicts 边标记，需裁决）`);
        }
    }
    if (otherTopics.length > 0) {
        const shown = otherTopics.slice(0, 2).map((topic) => {
            const label = typeof topic.digest === 'string' && topic.digest !== '' ? topic.digest : (topic.summary ?? '');
            const owner = typeof topic.owner === 'string' && topic.owner !== '' ? ` @${topic.owner}` : '';
            return `${topic.title}${owner}${label !== '' ? `（${label}）` : ''}`;
        });
        lines.push(`其他主干：${shown.join('；')}`);
    }
    const openLeaves = [];
    for (const topic of topics) {
        for (const leaf of leafRootsOf(state, topic.id)) {
            if (leaf.status === 'done' || leaf.status === 'abandoned') continue;
            openLeaves.push({ leaf, topic });
        }
    }
    openLeaves.sort((a, b) => leafRootImportance(b.leaf) - leafRootImportance(a.leaf));
    if (openLeaves.length > 0) {
        lines.push(`未决：${openLeaves.slice(0, 3).map(({ leaf, topic }) => `${leaf.title}（${topic.title}）`).join('；')}`);
    }
    const claimable = claimableTopics(state);
    if (claimable.length > 0) {
        lines.push(`可认领：${claimable.slice(0, 3).map((topic) => topic.title).join('；')}`);
    }
    const trunk = trunkFrontier(state, { limit: 2 });
    if (trunk.length > 0) {
        lines.push(`主干建议：${trunk.map((item) => `[${item.type}] ${item.targetId} ${item.reason}`).join('；')}`);
    }
    const frontier = computeFrontier(state, { sessionId, focusId, limit: 2 });
    const leaf = (frontier.suggestions ?? []).slice(0, 2).map((item) => {
        const target = item.targetId !== null && item.targetId !== undefined ? ` ${item.targetId}` : '';
        return `[${item.type}]${target} ${item.reason}`;
    });
    if (leaf.length > 0) lines.push(`叶子建议：${leaf.join('；')}`);
    const text = lines.join('\n');
    return text.length <= 400 ? text : `${text.slice(0, 399)}…`;
}

/**
 * 记录「上次注入时」的节点签名，供下一次只推增量。
 * 只保留比较需要的字段，避免把整个 state 挂在 service 上。
 *
 * @param {object} state
 * @returns {Map<string, {id: string, kind: string, title: string, status: string, parentId: string|null, updatedAt: string}>}
 */
export function snapshotBriefState(state) {
    const snapshot = new Map();
    for (const node of state.nodes.values()) {
        if (node === null || typeof node !== 'object' || typeof node.id !== 'string') continue;
        snapshot.set(node.id, {
            id: node.id,
            kind: typeof node.kind === 'string' ? node.kind : '',
            title: String(node.title ?? ''),
            status: typeof node.status === 'string' ? node.status : 'open',
            parentId: node.parentId ?? null,
            updatedAt: String(node.updatedAt ?? ''),
        });
    }
    return snapshot;
}

const BRIEF_DELTA_KINDS = new Set([
    'topic', 'conclusion', 'decision', 'dead_end', 'artifact',
    'question', 'hypothesis', 'evidence',
]);
const BRIEF_DELTA_LABELS = Object.freeze({
    topic: '主题', conclusion: '结论', decision: '决策', dead_end: '死路', artifact: '产物',
    question: '问题', hypothesis: '假设', evidence: '证据',
});
const BRIEF_DELTA_PRIORITY = Object.freeze({
    conclusion: 5, decision: 5, dead_end: 4, topic: 3, artifact: 3,
    hypothesis: 2, question: 2, evidence: 1,
});

function briefDeltaChangedTitles(nodes, max = 3) {
    const shown = nodes.slice(0, max)
        .map((node) => clampText(String(node.title ?? ''), 50))
        .filter((title) => title !== '');
    if (shown.length === 0) return '';
    return nodes.length > max ? `${shown.join('；')} 等 ${nodes.length} 项` : shown.join('；');
}

/**
 * 与上次简报相比的增量：新增关键节点 / 完成 / 放弃 / 标题或父节点变化 / 合并移除。
 * 没有值得说的变化时返回空串，调用方跳过注入，避免每轮重复同一份简报。
 *
 * @param {object} state
 * @param {Map<string, object>} previous snapshotBriefState 的返回值
 * @param {{sessionId?: string|null}} [options]
 * @returns {string}
 */
export function renderBriefDelta(state, previous, options = {}) {
    if (!(previous instanceof Map) || previous.size === 0) return renderBrief(state, options);
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    const goal = briefGoalOf(state, sessionId);
    const current = snapshotBriefState(state);
    const added = [];
    const completed = [];
    const abandoned = [];
    const updated = [];
    const removed = [];

    for (const node of current.values()) {
        const before = previous.get(node.id);
        if (before === undefined) {
            if (BRIEF_DELTA_KINDS.has(node.kind)) added.push(node);
            continue;
        }
        if (node.status !== before.status) {
            if (!BRIEF_DELTA_KINDS.has(node.kind)) continue;
            if (node.status === 'done') completed.push(node);
            else if (node.status === 'abandoned' && !isAutoCuratedNode(node)) abandoned.push(node);
        } else if (BRIEF_DELTA_KINDS.has(node.kind)
            && (node.title !== before.title || node.parentId !== before.parentId)) {
            updated.push(node);
        }
    }
    for (const [id, before] of previous) {
        if (!current.has(id) && BRIEF_DELTA_KINDS.has(before.kind)) removed.push(before);
    }

    added.sort((a, b) => (BRIEF_DELTA_PRIORITY[b.kind] ?? 0) - (BRIEF_DELTA_PRIORITY[a.kind] ?? 0)
        || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    completed.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    abandoned.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    updated.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    const lines = [goal !== null
        ? `【研究轨迹增量】目标：${goal.title}`
        : '【研究轨迹增量】'];
    if (added.length > 0) {
        const text = added.slice(0, 3)
            .map((node) => `${BRIEF_DELTA_LABELS[node.kind] ?? node.kind}「${clampText(node.title, 40)}」`)
            .join('；');
        lines.push(`新增：${text}${added.length > 3 ? ` 等 ${added.length} 项` : ''}`);
    }
    if (completed.length > 0) lines.push(`完成：${briefDeltaChangedTitles(completed)}`);
    if (abandoned.length > 0) lines.push(`放弃：${briefDeltaChangedTitles(abandoned)}`);
    if (updated.length > 0) lines.push(`更新：${briefDeltaChangedTitles(updated)}`);
    if (removed.length > 0) lines.push(`合并/移除：${briefDeltaChangedTitles(removed)}`);
    if (lines.length === 1) return '';
    const text = lines.join('\n');
    return text.length <= 400 ? text : `${text.slice(0, 399)}…`;
}

/**
 * P5.4 交接包：topic 当前摘要 + 未决叶根 + 最近关键节点。
 * 与 renderBrief 不同，它面向「接手者」而不是轮首注入，可以稍长（≤1000 字）。
 *
 * @param {object} state
 * @param {string} topicId
 * @param {{from?: string|null, to?: string|null}} [options]
 */
export function renderHandoff(state, topicId, options = {}) {
    const topic = state.nodes.get(topicId);
    if (topic === undefined || !isTopic(topic)) return '';
    const leaves = leafRootsOf(state, topicId);
    const open = leaves.filter((node) => node.status !== 'done' && node.status !== 'abandoned');
    const recent = childrenOf(state, topicId)
        .filter((node) => (node.kind === 'decision' || node.kind === 'conclusion' || node.kind === 'dead_end')
            && !(Array.isArray(node.tags) && node.tags.includes('handoff')))
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
        .slice(0, 3);
    const digest = typeof topic.digest === 'string' && topic.digest !== '' ? topic.digest : topicDigest(state, topic);
    const lines = [
        `交接：${topic.title}（${topic.id}）`,
        `摘要：${digest}`,
        `叶根：${leaves.length} 个（未决 ${open.length}，完成 ${leaves.length - open.length}）`,
    ];
    if (open.length > 0) {
        lines.push(`未决：${open.slice(0, 5).map((node) => `${node.id} ${node.title}`).join('；')}`);
    }
    if (topicConflicts(state, topicId).length > 0) {
        lines.push(`冲突：${topicConflicts(state, topicId).map((edge) => `${edge.from}↔${edge.to}`).join('；')}`);
    }
    if (recent.length > 0) {
        lines.push(`关键节点：${recent.map((node) => `${node.id} ${node.title}`).join('；')}`);
    }
    const from = typeof options.from === 'string' && options.from !== '' ? options.from : null;
    const to = typeof options.to === 'string' && options.to !== '' ? options.to : null;
    if (from !== null || to !== null) lines.push(`交接：${from ?? '?'} → ${to ?? '?'}`);
    return clampText(lines.join('\n'), 1000);
}
