/**
 * navigate：面向「沿树展开」与多 agent 任务协调的只读导航。
 *
 * walk 把当前焦点放回它的根路径、兄弟分支与未决叶子中，给出下一步应该沿哪个
 * 子节点继续、当前缺口是什么，以及可以直接执行的 add 模板；team 把 topic 的
 * owner/租约、未决叶根、冲突，与宿主 Agent Teams 的真实成员/任务合并成协作视图。
 *
 * 纯函数：输入 graph state，输出结构化视图；不读文件、不调 LLM、不写图。
 *
 * @module core/navigate
 */
import { childrenOf, isDescendant, pathToRoot, rootNodes, subtreeIds } from './graph.js';
import { hasContradiction, hasEvidence } from './frontier.js';
import { isLeafRootKind } from './model.js';
import {
    claimableTopics,
    isArchived,
    isDigestStale,
    isTopic,
    leaseStatus,
    leafRootsOf,
    parseTeamTaskMarker,
    topicConflicts,
    topicTaskPayload,
    TRUNK_MAX_WIDTH,
} from './trunk.js';

const OPEN_STATUSES = new Set(['open', 'active']);
const STATUS_MARK = Object.freeze({ open: '○', active: '◐', done: '●', abandoned: '✗' });
const KIND_LABEL = Object.freeze({
    goal: '目标', topic: '主题', question: '问题', hypothesis: '假设', step: '步骤',
    action: '动作', evidence: '证据', decision: '决策', dead_end: '死路',
    conclusion: '结论', artifact: '产物', note: '笔记',
});
const KIND_ORDER = Object.freeze({
    goal: 0, topic: 1, question: 2, hypothesis: 2, decision: 3, evidence: 4,
    conclusion: 5, dead_end: 5, step: 6, action: 7, artifact: 8, note: 9,
});
const PRIORITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });
const SEMANTIC_KINDS = new Set(['question', 'hypothesis', 'evidence', 'decision', 'conclusion', 'dead_end']);

/** walk/team 的默认条数。 */
export const DEFAULT_WALK_LIMIT = 6;
export const DEFAULT_TEAM_LIMIT = 8;

function isOpen(node) {
    return node !== undefined && node !== null && OPEN_STATUSES.has(node.status);
}

function truncate(value, max) {
    const text = value === null || value === undefined ? '' : String(value);
    if (max <= 0 || text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function firstLine(text, max) {
    const line = String(text ?? '').split('\n')[0] ?? '';
    return truncate(line, max);
}

function label(node) {
    return `${node.id} [${node.kind}/${node.status}] ${truncate(node.title, 90)}`;
}

function nearestTopicOf(state, nodeId) {
    let cursor = state.nodes.get(nodeId);
    const seen = new Set();
    while (cursor !== undefined && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        if (isTopic(cursor)) return cursor;
        cursor = cursor.parentId === null || cursor.parentId === undefined
            ? undefined
            : state.nodes.get(cursor.parentId);
    }
    return null;
}

function rootOf(state, nodeId) {
    const path = pathToRoot(state, nodeId);
    return path.length > 0 ? path[0] : null;
}

function summaryOf(state, node) {
    if (node === null || node === undefined) return null;
    return {
        id: node.id,
        kind: node.kind,
        status: node.status,
        title: node.title,
        parentId: node.parentId ?? null,
        summaryHint: firstLine(node.summary, 160),
        tags: Array.isArray(node.tags) ? node.tags.slice(0, 8) : [],
        owner: typeof node.owner === 'string' && node.owner !== '' ? node.owner : null,
        leaseStatus: isTopic(node) ? leaseStatus(node) : null,
        priority: node.priority ?? null,
        digest: node.digest ?? null,
        nodeVersion: node.nodeVersion ?? 1,
        updatedAt: node.updatedAt ?? null,
    };
}

/**
 * 当前应该从哪里开始走：显式 id > 会话游标 > 会话目标 > 最新目标 > 根。
 * 与 overview 的「最新节点」不同，这里优先语义根，避免落到一条 action 上。
 */
export function resolveWalkFocus(state, options = {}) {
    const focusId = typeof options.focusId === 'string' ? options.focusId : null;
    if (focusId !== null && state.nodes.has(focusId)) return state.nodes.get(focusId);
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    const session = sessionId !== null ? state.sessions.get(sessionId) : undefined;
    if (session?.activeNodeId !== null && session?.activeNodeId !== undefined && state.nodes.has(session.activeNodeId)) {
        return state.nodes.get(session.activeNodeId);
    }
    if (session?.goalId !== null && session?.goalId !== undefined && state.nodes.has(session.goalId)) {
        const goal = state.nodes.get(session.goalId);
        if (goal?.kind === 'goal') return goal;
    }
    const goals = [...state.nodes.values()]
        .filter((node) => node.kind === 'goal')
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
    if (goals.length > 0) return goals[goals.length - 1];
    const roots = rootNodes(state);
    return roots.length > 0 ? roots[0] : null;
}

function subtreeCounts(state, nodeId) {
    const ids = subtreeIds(state, nodeId);
    let open = 0;
    let openLeaves = 0;
    const byKind = {};
    for (const id of ids) {
        const node = state.nodes.get(id);
        if (node === undefined) continue;
        byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
        if (!isOpen(node)) continue;
        open += 1;
        const hasOpenChild = childrenOf(state, id).some((child) => isOpen(child));
        if (!hasOpenChild) openLeaves += 1;
    }
    return { total: ids.length, open, openLeaves, byKind };
}

function childSummary(state, child) {
    const counts = subtreeCounts(state, child.id);
    return {
        id: child.id,
        kind: child.kind,
        status: child.status,
        title: child.title,
        parentId: child.parentId ?? null,
        subtreeSize: counts.total,
        openDescendants: counts.open,
        openLeaves: counts.openLeaves,
        hasChildren: childrenOf(state, child.id).length > 0,
        lastUpdated: child.updatedAt ?? null,
    };
}

function compareChild(left, right) {
    const openDelta = Number(!isOpen(left)) - Number(!isOpen(right));
    if (openDelta !== 0) return openDelta;
    const kindDelta = (KIND_ORDER[left.kind] ?? 99) - (KIND_ORDER[right.kind] ?? 99);
    if (kindDelta !== 0) return kindDelta;
    return (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id);
}

function collectOpenLeaves(state, focusId, limit) {
    const out = [];
    const seen = new Set();
    const walk = (nodeId, depth) => {
        if (out.length >= limit || seen.has(nodeId)) return;
        seen.add(nodeId);
        const node = state.nodes.get(nodeId);
        if (node === undefined) return;
        const openChildren = childrenOf(state, nodeId).filter((child) => isOpen(child));
        if (isOpen(node) && openChildren.length === 0) {
            out.push({
                id: node.id,
                kind: node.kind,
                status: node.status,
                title: node.title,
                depth,
                isFocus: node.id === focusId,
            });
            return;
        }
        for (const child of childrenOf(state, nodeId)) {
            if (out.length >= limit) break;
            walk(child.id, depth + 1);
        }
    };
    walk(focusId, 0);
    return out;
}

/** 可直接复制的写入模板；尖括号是占位符，不是真实 id。 */
function addCommand(parentId, kind, titleHint, summaryHint) {
    return `explore_tree_record add parentId=${parentId} kind=${kind} title="<${titleHint}>" summary="<${summaryHint}>"`;
}

function expansionPlan(state, node) {
    if (node === null || node === undefined) return [];
    const plan = [];
    const push = (kind, titleHint, summaryHint, reason) => plan.push({ kind, titleHint, summaryHint, reason, command: addCommand(node.id, kind, titleHint, summaryHint) });
    switch (node.kind) {
        case 'goal':
            push('topic', '主题', '范围与完成标准', '目标还没有主题：先拆出 1-2 个可独立推进的主题。');
            break;
        case 'topic':
            push('question', '可验证问题', '问题、约束与判定标准', '主题需要可验证的叶根，而不是继续堆旁白。');
            push('hypothesis', '候选解释', '机制、可证伪点', '为一个问题写下至少一条可证伪的候选解释。');
            break;
        case 'question':
            push('hypothesis', '候选答案', '机制与可证伪点', '问题需要一个候选答案，后续证据才有挂载点。');
            push('evidence', '已有观察', '来源、数字、复现步骤', '把已经看到的观察写成证据，并 link 到候选假设。');
            break;
        case 'hypothesis':
            push('evidence', '支持或反驳证据', '来源、数字、反例', '假设需要证据；先写能证伪它的最小实验或观察。');
            push('dead_end', '证伪记录', '失败条件与原因', '如果实验失败，记录 dead_end，避免下次重复走同一条路。');
            push('hypothesis', '竞争解释', '与当前假设互斥的机制', '写下互斥假设，并用 contradicts 边表达冲突。');
            break;
        case 'decision':
            push('evidence', '决策依据', '数据、约束、tradeoff', '决策需要依据；把支撑它的观察或约束挂到下面。');
            push('conclusion', '结论', '选择与影响', '把决定沉淀成 conclusion，供后续复用。');
            break;
        case 'step':
            push('question', '待解问题', '问题与判定标准', 'step 是时间桶，不应承载语义；先写语义节点，再 move 到 topic/叶根。');
            break;
        case 'action':
            push('evidence', '动作结果', '输出、错误、数字', '把动作结果写成 evidence，而不是只留在对话里。');
            push('dead_end', '失败记录', '失败原因', '动作失败时记录 dead_end，避免重复尝试。');
            break;
        case 'evidence':
            push('conclusion', '提炼结论', '这条证据支持/反驳了什么', '证据需要挂到假设或决策上；必要时 link，避免孤立。');
            break;
        case 'artifact':
            push('conclusion', '产物判断', '产物证明了什么、边界', '产物本身不是结论：把它隐含的判断提炼成 conclusion。');
            break;
        case 'note':
            push('question', '待验证问题', '问题与判定标准', '笔记还不是研究节点：把其中的疑问提炼成 question。');
            break;
        default:
            break;
    }
    return plan.slice(0, 3);
}

function collectGaps(state, node, options = {}) {
    const maxWidth = Number.isInteger(options.maxWidth) && options.maxWidth > 0 ? options.maxWidth : TRUNK_MAX_WIDTH;
    const gaps = [];
    const add = (code, message) => gaps.push({ code, message, nodeId: node.id });
    const children = childrenOf(state, node.id);
    const topic = isTopic(node) ? node : nearestTopicOf(state, node.id);

    if (node.kind === 'goal' && !children.some((child) => isTopic(child))) {
        add('GOAL_NO_TOPIC', '目标还没有主题：先 record add kind=topic，再往下挂叶根。');
    }
    if (node.kind === 'topic') {
        const leaves = leafRootsOf(state, node.id);
        if (leaves.length === 0) add('TOPIC_NO_LEAF', '主题还没有叶根：先写一个可验证问题或假设。');
        if (children.length >= maxWidth) add('TOPIC_WIDE', `主题宽度 ${children.length}，达到/超过建议上限 ${maxWidth}；考虑拆子主题。`);
        if (topic !== null && topicConflicts(state, topic.id).length > 0) {
            add('TOPIC_CONFLICT', `主题有 ${topicConflicts(state, topic.id).length} 条 contradicts 边未裁决。`);
        }
        if (isDigestStale(state, node)) add('DIGEST_STALE', '主题摘要已过期：子节点变化后没有重算 digest。');
        if (typeof node.owner !== 'string' || node.owner === '') add('TOPIC_UNOWNED', '主题未认领：多 agent 场景先用 assign 划写域。');
    }
    if (node.kind === 'question' && !children.some((child) => child.kind === 'hypothesis')) {
        add('QUESTION_NO_HYPOTHESIS', '问题还没有候选假设：先写至少一条可证伪的解释。');
    }
    if (node.kind === 'hypothesis' && !hasEvidence(state, node.id)) {
        add('HYPOTHESIS_NO_EVIDENCE', '假设还没有证据：先设计能证伪它的最小实验/检索。');
    }
    if (node.kind === 'hypothesis' && hasContradiction(state, node.id)) {
        add('HYPOTHESIS_CONTRADICTED', '假设已有反驳证据：先解释冲突，再决定加码还是换路径。');
    }
    if (node.kind === 'decision' && !children.some((child) => child.kind === 'evidence' || child.kind === 'conclusion')) {
        add('DECISION_NO_BASIS', '决策还没有依据或结论：补证据，或把决定写成 conclusion。');
    }
    if (node.kind === 'step') {
        add('STEP_TIME_BUCKET', 'step 是时间桶，不是语义父节点：语义节点应挂到 topic/叶根。');
    }
    if (isOpen(node) && children.length === 0 && node.kind !== 'goal' && node.kind !== 'topic') {
        add('LEAF_UNEXPANDED', '当前是开放叶子：还没有子节点，先按下一步模板展开。');
    }
    if (topic !== null && !isTopic(node) && topicConflicts(state, topic.id).length > 0) {
        add('TOPIC_CONFLICT', `所在主题 ${topic.id} 有 ${topicConflicts(state, topic.id).length} 条 contradicts 边未裁决。`);
    }
    if (topic !== null && node.kind !== 'topic' && childrenOf(state, topic.id).length >= maxWidth) {
        add('TOPIC_WIDE', `所在主题 ${topic.id} 的直接子节点 ${childrenOf(state, topic.id).length} 个，达到/超过建议上限 ${maxWidth}；考虑拆子主题。`);
    }
    return gaps.slice(0, 6);
}

function findOpenSibling(state, focus) {
    let cursor = focus;
    const seen = new Set();
    while (cursor !== undefined && cursor.parentId !== null && cursor.parentId !== undefined && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        const parent = state.nodes.get(cursor.parentId);
        if (parent === undefined) break;
        const siblings = childrenOf(state, parent.id)
            .filter((node) => node.id !== cursor.id && isOpen(node))
            .sort(compareChild);
        if (siblings.length > 0) return { node: siblings[0], via: parent };
        cursor = parent;
    }
    return null;
}

function findResumeInTopic(state, focusId) {
    const topic = nearestTopicOf(state, focusId);
    if (topic === null) return null;
    const open = leafRootsOf(state, topic.id)
        .filter((node) => node.id !== focusId && isOpen(node) && !isDescendant(state, focusId, node.id))
        .sort(compareChild);
    return open.length > 0 ? { node: open[0], via: topic } : null;
}

function nextOf(state, focus, children) {
    if (focus === null) {
        return {
            type: 'seed',
            targetId: null,
            targetKind: null,
            title: '建立第一个目标',
            reason: '研究图为空：先 add kind=goal。',
            command: 'explore_tree_record add kind=goal title="<目标>" summary="<完成标准>"',
            expansions: [],
        };
    }
    const openChildren = children.filter((child) => isOpen(child));
    if (openChildren.length > 0) {
        const target = openChildren[0];
        const targetNode = state.nodes.get(target.id);
        const targetOpenChildren = childrenOf(state, target.id).filter((child) => isOpen(child));
        return {
            type: 'descend',
            targetId: target.id,
            targetKind: target.kind,
            title: target.title,
            reason: `沿子节点 ${target.id}（${KIND_LABEL[target.kind] ?? target.kind}）继续向下展开；它还有 ${targetOpenChildren.length} 个开放子节点。`,
            command: `explore_tree action=walk id=${target.id}`,
            expansions: isOpen(targetNode) && targetOpenChildren.length === 0 ? expansionPlan(state, targetNode) : [],
        };
    }
    if (isOpen(focus)) {
        return {
            type: 'expand',
            targetId: focus.id,
            targetKind: focus.kind,
            title: focus.title,
            reason: `当前 ${focus.id}（${KIND_LABEL[focus.kind] ?? focus.kind}）是开放叶子，没有开放子节点；先按模板展开一层。`,
            command: `explore_tree action=walk id=${focus.id}`,
            expansions: expansionPlan(state, focus),
        };
    }
    const sibling = findOpenSibling(state, focus);
    if (sibling !== null) {
        const targetNode = state.nodes.get(sibling.node.id);
        return {
            type: 'branch',
            targetId: sibling.node.id,
            targetKind: sibling.node.kind,
            title: sibling.node.title,
            reason: `当前分支已收敛；最近的未决兄弟 ${sibling.node.id}（在 ${sibling.via.id} 下）还没展开。`,
            command: `explore_tree action=walk id=${sibling.node.id}`,
            expansions: childrenOf(state, sibling.node.id).filter((child) => isOpen(child)).length === 0
                ? expansionPlan(state, targetNode)
                : [],
        };
    }
    const resume = findResumeInTopic(state, focus.id);
    if (resume !== null) {
        return {
            type: 'resume',
            targetId: resume.node.id,
            targetKind: resume.node.kind,
            title: resume.node.title,
            reason: `当前分支已收敛；同一主题还有未决叶 ${resume.node.id}。`,
            command: `explore_tree action=walk id=${resume.node.id}`,
            expansions: expansionPlan(state, resume.node),
        };
    }
    return {
        type: 'stopped',
        targetId: null,
        targetKind: null,
        title: '当前分支已收敛',
        reason: '当前分支没有开放子节点，也没有可接续的兄弟/同主题未决叶；用 overview/trunk 选择新目标。',
        command: 'explore_tree action=overview',
        expansions: [],
    };
}

function localSuggestions(state, focus, children, options = {}) {
    const suggestions = [];
    const maxWidth = Number.isInteger(options.maxWidth) && options.maxWidth > 0 ? options.maxWidth : TRUNK_MAX_WIDTH;
    const topic = nearestTopicOf(state, focus.id);
    const topicChildren = topic === null ? children : childrenOf(state, topic.id);
    if (focus.kind === 'hypothesis' && !hasEvidence(state, focus.id)) {
        suggestions.push({
            type: 'verify',
            targetId: focus.id,
            reason: `假设 ${focus.id} 尚无证据：先做能证伪它的最小实验。`,
            command: `explore_tree_record add parentId=${focus.id} kind=evidence title="<证据>" summary="<来源与数字>"`,
        });
    }
    if ((focus.kind === 'question' || focus.kind === 'decision') && isOpen(focus)) {
        suggestions.push({
            type: 'resolve',
            targetId: focus.id,
            reason: `${KIND_LABEL[focus.kind]} ${focus.id} 仍 ${focus.status}：给出明确答案/决定，并记录 conclusion。`,
            command: `explore_tree_record add parentId=${focus.id} kind=conclusion title="<结论>" summary="<依据>"`,
        });
    }
    if (topic !== null) {
        const lease = leaseStatus(topic);
        if (lease === 'unowned' || lease === 'expired') {
            suggestions.push({
                type: 'claim',
                targetId: topic.id,
                reason: `主题 ${topic.id} ${lease === 'unowned' ? '未认领' : '租约已过期'}：多 agent 场景先认领写域。`,
                command: `explore_tree_record assign id=${topic.id} owner=<agent>`,
            });
        }
        if (topicConflicts(state, topic.id).length > 0) {
            suggestions.push({
                type: 'resolve',
                targetId: topic.id,
                reason: `主题 ${topic.id} 有 ${topicConflicts(state, topic.id).length} 条 contradicts 边未裁决。`,
                command: `explore_tree_record add parentId=${topic.id} kind=decision title="裁决：<冲突>" summary="<依据>"`,
            });
        }
        if (topicChildren.length >= maxWidth) {
            const leaf = topicChildren.find((child) => isLeafRootKind(child.kind) && isOpen(child));
            suggestions.push({
                type: 'split',
                targetId: leaf?.id ?? topic.id,
                reason: `主题 ${topic.id} 的直接子节点 ${topicChildren.length} 个，达到/超过 ${maxWidth}；把过宽的叶根提升为子主题。`,
                command: leaf !== undefined
                    ? `explore_tree_record promote id=${leaf.id}`
                    : `explore_tree_record add parentId=${topic.id} kind=topic title="<子主题>" summary="<范围>"`,
            });
        }
    }
    if (focus.kind === 'step') {
        const semantic = children.find((child) => SEMANTIC_KINDS.has(child.kind));
        if (semantic !== undefined && topic !== null) {
            suggestions.push({
                type: 'migrate',
                targetId: semantic.id,
                reason: `${semantic.id} 是语义节点，仍挂在 step ${focus.id} 下；迁到主题/叶根。`,
                command: `explore_tree_record move id=${semantic.id} parentId=${topic.id}`,
            });
        }
    }
    if (focus.kind === 'dead_end') {
        suggestions.push({
            type: 'reopen',
            targetId: focus.id,
            reason: '只有出现新证据/新工具时才 reopen；否则保持关闭，避免重复走同一条死路。',
            command: `explore_tree_record reopen id=${focus.id} reason="<新证据>"`,
        });
    }
    return suggestions.slice(0, 6);
}

/**
 * 沿当前分支展开。
 *
 * @param {object} state
 * @param {{sessionId?: string|null, focusId?: string|null, limit?: number, maxWidth?: number}} [options]
 */
export function computeWalk(state, options = {}) {
    const focus = resolveWalkFocus(state, options);
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(12, options.limit) : DEFAULT_WALK_LIMIT;
    if (focus === null) {
        const next = nextOf(state, null, []);
        return {
            focus: null,
            path: [],
            parent: null,
            siblings: [],
            children: [],
            openLeaves: [],
            gaps: [],
            next,
            suggestions: [next],
            topic: null,
            stats: { subtreeNodes: 0, openNodes: 0, openLeaves: 0, byKind: {}, maxDepth: 0, evidence: 0, conclusions: 0, decisions: 0, children: 0, width: 0 },
            generatedAt: new Date().toISOString(),
        };
    }
    const path = pathToRoot(state, focus.id).map((node) => ({ id: node.id, kind: node.kind, status: node.status, title: node.title }));
    const parent = focus.parentId === null || focus.parentId === undefined ? null : state.nodes.get(focus.parentId) ?? null;
    const siblings = parent === null
        ? []
        : childrenOf(state, parent.id)
            .filter((node) => node.id !== focus.id)
            .map((node) => ({ ...childSummary(state, node), isCurrent: false }))
            .sort((left, right) => {
                const openDelta = Number(!isOpen(left)) - Number(!isOpen(right));
                if (openDelta !== 0) return openDelta;
                const kindDelta = (KIND_ORDER[left.kind] ?? 99) - (KIND_ORDER[right.kind] ?? 99);
                return kindDelta !== 0 ? kindDelta : left.id.localeCompare(right.id);
            })
            .slice(0, 8);
    const children = childrenOf(state, focus.id).map((child) => childSummary(state, child)).sort((left, right) => {
        const openDelta = Number(!isOpen(left)) - Number(!isOpen(right));
        if (openDelta !== 0) return openDelta;
        const kindDelta = (KIND_ORDER[left.kind] ?? 99) - (KIND_ORDER[right.kind] ?? 99);
        return kindDelta !== 0 ? kindDelta : (left.lastUpdated ?? '').localeCompare(right.lastUpdated ?? '') || left.id.localeCompare(right.id);
    });
    const counts = subtreeCounts(state, focus.id);
    const openLeaves = collectOpenLeaves(state, focus.id, limit);
    const topic = nearestTopicOf(state, focus.id);
    const gaps = collectGaps(state, focus, options);
    const next = nextOf(state, focus, children);
    const suggestions = localSuggestions(state, focus, children, options);
    const maxDepth = Math.max(0, ...subtreeIds(state, focus.id).map((id) => pathToRoot(state, id).length - path.length));
    return {
        focus: summaryOf(state, focus),
        path,
        parent: summaryOf(state, parent),
        siblings,
        children,
        openLeaves,
        gaps,
        next,
        suggestions,
        topic: summaryOf(state, topic),
        stats: {
            subtreeNodes: counts.total,
            openNodes: counts.open,
            openLeaves: counts.openLeaves,
            byKind: counts.byKind,
            maxDepth,
            evidence: counts.byKind.evidence ?? 0,
            conclusions: counts.byKind.conclusion ?? 0,
            decisions: counts.byKind.decision ?? 0,
            children: children.length,
            width: children.length,
        },
        generatedAt: new Date().toISOString(),
    };
}

/** walk 的紧凑文本渲染。 */
export function renderWalk(result) {
    if (result === null || result.focus === null) {
        return '研究图为空：先用 explore_tree_record add kind=goal 建目标，再用 add kind=topic 拆主题。';
    }
    const focus = result.focus;
    const lines = [];
    lines.push(`沿树展开：${label(focus)}（子树 ${result.stats.subtreeNodes} 节点 / 未决 ${result.stats.openNodes}）`);
    lines.push(`路径：${result.path.map((node) => `${node.id}:${node.kind}`).join(' > ')}`);
    if (focus.summaryHint !== '') lines.push(`摘要：${focus.summaryHint}`);
    if (result.parent !== null) lines.push(`父级：${label(result.parent)}`);
    if (result.siblings.length > 0) {
        lines.push(`兄弟（${result.siblings.length}）：`);
        for (const sibling of result.siblings) {
            lines.push(`  ${sibling.id} ${STATUS_MARK[sibling.status] ?? '?'} ${sibling.kind} ${truncate(sibling.title, 70)}${sibling.subtreeSize > 1 ? `（子树 ${sibling.subtreeSize}${sibling.openDescendants > 0 ? `，未决 ${sibling.openDescendants}` : ''}）` : ''}`);
        }
    }
    if (result.children.length > 0) {
        lines.push(`子节点（${result.children.length}）：`);
        for (const child of result.children) {
            const mark = child.id === result.next?.targetId ? ' ▸' : '';
            lines.push(`  ${child.id} ${STATUS_MARK[child.status] ?? '?'} ${child.kind} ${truncate(child.title, 70)}（子树 ${child.subtreeSize}${child.openDescendants > 0 ? `，未决 ${child.openDescendants}` : ''}）${mark}`);
        }
    } else {
        lines.push('子节点（0）：当前是叶子。');
    }
    if (result.openLeaves.length > 0) {
        const leafTotal = Math.max(result.stats.openLeaves, result.openLeaves.length);
        const leafLabel = leafTotal > result.openLeaves.length
            ? `显示 ${result.openLeaves.length}/${leafTotal}`
            : String(leafTotal);
        lines.push(`未决叶（${leafLabel}）：`);
        for (const leaf of result.openLeaves) {
            lines.push(`  ${'  '.repeat(Math.min(3, leaf.depth))}${leaf.id} ${STATUS_MARK[leaf.status] ?? '?'} ${leaf.kind} ${truncate(leaf.title, 70)}${leaf.isFocus ? '（当前）' : ''}`);
        }
    }
    if (result.gaps.length > 0) {
        lines.push('缺口：');
        for (const gap of result.gaps) lines.push(`  - ${gap.message}`);
    }
    if (result.next !== null) {
        lines.push(`下一步：${result.next.type} ${result.next.targetId ?? ''} ${truncate(result.next.reason, 220)}`);
        if (result.next.command) lines.push(`  命令：${result.next.command}`);
        if (result.next.expansions.length > 0) {
            lines.push('  可添加：');
            for (const item of result.next.expansions) {
                lines.push(`    - ${item.kind}：${item.reason}`);
                lines.push(`      ${item.command}`);
            }
        }
    }
    if (result.suggestions.length > 0) {
        lines.push(`建议（${result.suggestions.length}）：`);
        for (const item of result.suggestions) {
            const target = item.targetId === null || item.targetId === undefined ? '' : ` → ${item.targetId}`;
            lines.push(`  [${item.type}]${target} ${truncate(item.reason, 200)}`);
            if (item.command) lines.push(`    ${item.command}`);
        }
    }
    lines.push(`统计：节点 ${result.stats.subtreeNodes} / 未决 ${result.stats.openNodes} / 未决叶 ${result.stats.openLeaves} / 证据 ${result.stats.evidence} / 结论 ${result.stats.conclusions} / 决策 ${result.stats.decisions} / 最大深度 ${result.stats.maxDepth}`);
    const text = lines.join('\n');
    return text.length <= 6000 ? text : `${text.slice(0, 5999)}…`;
}

function topicSummary(state, topic, now) {
    const leaves = leafRootsOf(state, topic.id);
    const openLeaves = leaves.filter((node) => isOpen(node));
    const conflicts = topicConflicts(state, topic.id);
    const lease = leaseStatus(topic, now);
    return {
        id: topic.id,
        title: topic.title,
        status: topic.status,
        priority: topic.priority ?? null,
        owner: typeof topic.owner === 'string' && topic.owner !== '' ? topic.owner : null,
        leaseStatus: lease,
        leaseUntil: topic.leaseUntil ?? null,
        leaseEpoch: topic.leaseEpoch ?? 0,
        nodeVersion: topic.nodeVersion ?? 1,
        digest: topic.digest ?? '',
        width: childrenOf(state, topic.id).length,
        leafRoots: leaves.length,
        openLeaves: openLeaves.length,
        doneLeaves: leaves.filter((node) => node.status === 'done').length,
        conflicts: conflicts.length,
        conflictEdges: conflicts.slice(0, 4).map((edge) => `${edge.from}↔${edge.to}`),
        digestStale: isDigestStale(state, topic),
        updatedAt: topic.updatedAt ?? null,
        task: topicTaskPayload(topic),
        openLeafItems: openLeaves.slice(0, 5).map((leaf) => ({
            id: leaf.id,
            kind: leaf.kind,
            title: leaf.title,
            status: leaf.status,
        })),
    };
}

function compareTopic(left, right) {
    const priorityDelta = (PRIORITY_RANK[left.priority] ?? 9) - (PRIORITY_RANK[right.priority] ?? 9);
    if (priorityDelta !== 0) return priorityDelta;
    if (left.openLeaves !== right.openLeaves) return right.openLeaves - left.openLeaves;
    return String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')) || left.id.localeCompare(right.id);
}

/**
 * 归一化宿主注入的真实 Agent Teams 视图。Team 插件缺失时 available=false，
 * 树上的租约/可认领主题仍然可用，不伪造任务草案。
 */
function normalizeTeam(team, state) {
    if (team === null || typeof team !== 'object' || team.available !== true) {
        return {
            available: false,
            error: typeof team?.error === 'string' ? team.error : '',
            members: [],
            tasks: [],
            linked: [],
            unlinked: [],
            active: [],
        };
    }
    const members = (Array.isArray(team.members) ? team.members : []).map((member) => ({
        name: typeof member?.name === 'string' ? member.name : '?',
        role: member?.role === 'lead' ? 'lead' : 'teammate',
        status: typeof member?.status === 'string' ? member.status : 'unknown',
        description: typeof member?.description === 'string' ? truncate(member.description, 100) : '',
    }));
    const tasks = (Array.isArray(team.tasks) ? team.tasks : [])
        .filter((task) => task !== null && typeof task === 'object' && task.status !== 'deleted')
        .map((task) => {
            const nodeId = parseTeamTaskMarker(task.description);
            const node = nodeId !== null && state.nodes.has(nodeId) ? state.nodes.get(nodeId) : null;
            return {
                id: typeof task.id === 'string' ? task.id : '?',
                revision: Number.isInteger(task.revision) ? task.revision : 0,
                subject: typeof task.subject === 'string' ? task.subject : '(无标题)',
                status: typeof task.status === 'string' ? task.status : 'pending',
                ownerName: typeof task.ownerName === 'string' && task.ownerName !== '' ? task.ownerName : null,
                ready: task.ready === true,
                blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.slice(0, 8) : [],
                writeScopes: Array.isArray(task.writeScopes) ? task.writeScopes.slice(0, 8) : [],
                nodeId,
                node: node === null ? null : { id: node.id, kind: node.kind, title: node.title, status: node.status },
            };
        });
    const rank = { in_progress: 0, pending: 1, completed: 2 };
    tasks.sort((left, right) => (rank[left.status] ?? 9) - (rank[right.status] ?? 9) || left.id.localeCompare(right.id));
    return {
        available: true,
        error: '',
        members,
        tasks,
        linked: tasks.filter((task) => task.node !== null),
        unlinked: tasks.filter((task) => task.node === null),
        active: tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress'),
    };
}

/**
 * 多 agent 协作：树上的 topic 租约/可认领状态 + 真实 Agent Teams 成员与任务。
 * Team 任务通过 description 里的 [explore-tree:n12] 标记挂回树节点；不复制一份任务板。
 *
 * @param {object} state
 * @param {{actor?: string|null, now?: number, limit?: number, maxWidth?: number,
 *          team?: {available?: boolean, members?: object[], tasks?: object[], error?: string}}} [options]
 */
export function computeTeamBoard(state, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(20, options.limit) : DEFAULT_TEAM_LIMIT;
    const actor = typeof options.actor === 'string' && options.actor.trim() !== '' ? options.actor.trim() : null;
    const maxWidth = Number.isInteger(options.maxWidth) && options.maxWidth > 0 ? options.maxWidth : TRUNK_MAX_WIDTH;
    const topics = [...state.nodes.values()].filter((node) => isTopic(node));
    const active = topics.filter((topic) => topic.status !== 'done' && topic.status !== 'abandoned' && !isArchived(topic));
    const summaries = active.map((topic) => topicSummary(state, topic, now));
    const mine = summaries.filter((item) => actor !== null && item.owner === actor).sort(compareTopic);
    const others = summaries.filter((item) => item.owner !== null && item.owner !== actor && item.leaseStatus !== 'expired').sort(compareTopic);
    const unowned = summaries.filter((item) => item.owner === null).sort(compareTopic);
    const expired = summaries.filter((item) => item.leaseStatus === 'expired').sort(compareTopic);
    const claimable = claimableTopics(state, now)
        .map((topic) => summaries.find((item) => item.id === topic.id))
        .filter((item) => item !== undefined)
        .sort(compareTopic);
    const conflicts = summaries.filter((item) => item.conflicts > 0).sort(compareTopic);
    const staleDigests = summaries.filter((item) => item.digestStale).sort(compareTopic);
    const team = normalizeTeam(options.team, state);
    const actors = new Map();
    for (const item of summaries) {
        const key = item.owner ?? '(unowned)';
        const entry = actors.get(key) ?? {
            actor: item.owner,
            topics: [],
            openTopics: 0,
            openLeaves: 0,
            expired: 0,
            lastActive: null,
        };
        entry.topics.push(item.id);
        if (item.openLeaves > 0) entry.openTopics += 1;
        entry.openLeaves += item.openLeaves;
        if (item.leaseStatus === 'expired') entry.expired += 1;
        if (entry.lastActive === null || String(item.updatedAt ?? '') > String(entry.lastActive)) entry.lastActive = item.updatedAt ?? null;
        actors.set(key, entry);
    }
    const suggestions = [];
    const seen = new Set();
    const push = (type, targetId, reason, command) => {
        const key = type + ':' + targetId;
        if (seen.has(key)) return;
        seen.add(key);
        suggestions.push({ type, targetId, reason, command });
    };
    for (const item of mine.filter((entry) => entry.leaseStatus === 'expired')) {
        push('renew', item.id, item.id + ' 的租约已过期，续租后再写。', 'explore_tree_record assign id=' + item.id + ' renew=true');
    }
    for (const item of unowned.slice(0, 3)) {
        push('claim', item.id, item.id + ' 未认领（' + item.openLeaves + ' 个未决叶根），可直接认领。', 'explore_tree_record assign id=' + item.id + ' owner=' + (actor ?? '<agent>'));
    }
    for (const item of expired.filter((entry) => entry.owner !== actor).slice(0, 3)) {
        push('claim', item.id, item.id + ' 当前由 ' + (item.owner ?? '?') + ' 持有但租约已过期，可重新认领。', 'explore_tree_record assign id=' + item.id + ' owner=' + (actor ?? '<agent>'));
    }
    for (const item of conflicts.slice(0, 2)) {
        push('resolve', item.id, item.id + ' 有 ' + item.conflicts + ' 条 contradicts 边未裁决。', 'explore_tree_record add parentId=' + item.id + ' kind=decision title="裁决：<冲突>" summary="<依据>"');
    }
    for (const item of staleDigests.slice(0, 2)) {
        push('digest', item.id, item.id + ' 的摘要已过期。', 'explore_tree_record digest id=' + item.id + ' digest="<重写摘要>"');
    }
    for (const item of summaries.filter((entry) => entry.width >= maxWidth).slice(0, 2)) {
        push('split', item.id, item.id + ' 直接子节点 ' + item.width + ' 个，超过建议宽度 ' + maxWidth + '；未决叶根 ' + item.openLeaves + ' 个。', 'explore_tree_record add parentId=' + item.id + ' kind=topic title="<子主题>" summary="<范围>"');
    }
    const taskSuggestions = team.available
        ? claimable
            .filter((item) => !team.tasks.some((task) => task.nodeId === item.id))
            .slice(0, limit)
            .map((item) => ({
                targetId: item.id,
                subject: item.task.subject,
                description: item.task.description,
                marker: item.task.marker,
                command: 'team_task_create({ subject: ' + JSON.stringify(item.task.subject) + ', description: ' + JSON.stringify(item.task.description) + ' })',
            }))
        : [];
    return {
        actor,
        now: new Date(now).toISOString(),
        mine: mine.slice(0, limit),
        others: others.slice(0, limit),
        unowned: unowned.slice(0, limit),
        expired: expired.slice(0, limit),
        claimable: claimable.slice(0, limit),
        conflicts: conflicts.slice(0, limit),
        staleDigests: staleDigests.slice(0, limit),
        actors: [...actors.values()].sort((left, right) => (left.actor ?? '').localeCompare(right.actor ?? '')),
        team,
        taskSuggestions,
        suggestions: suggestions.slice(0, 8),
        stats: {
            topics: active.length,
            mine: mine.length,
            others: others.length,
            unowned: unowned.length,
            expired: expired.length,
            claimable: claimable.length,
            conflicts: conflicts.length,
            staleDigests: staleDigests.length,
            teamTasks: team.tasks.length,
            teamActive: team.active.length,
            openLeaves: summaries.reduce((sum, item) => sum + item.openLeaves, 0),
        },
        generatedAt: new Date(now).toISOString(),
    };
}

function renderTopicLine(item) {
    const priority = item.priority ? ` ${item.priority}` : '';
    const owner = item.owner !== null ? ` @${item.owner}` : '';
    const lease = item.leaseStatus === 'leased'
        ? ` 租约至 ${item.leaseUntil}`
        : (item.leaseStatus === 'expired' ? ` 租约已过期（${item.leaseUntil ?? '?'}）` : '');
    const conflict = item.conflicts > 0 ? ` ⚠冲突${item.conflicts}` : '';
    return `  ${item.id}${priority} ${truncate(item.title, 70)}${owner}${lease} · 未决叶 ${item.openLeaves}/${item.leafRoots}${conflict}`;
}

/** team 的紧凑文本渲染：树侧租约 + 真实 Agent Teams 任务，不生成第二套任务板。 */
export function renderTeamBoard(board) {
    const shownLabel = (total, shown) => (total > shown ? '显示 ' + shown + '/' + total : String(total));
    const lines = [];
    const stats = board.stats;
    const team = board.team ?? { available: false, error: '', members: [], tasks: [], linked: [], unlinked: [], active: [] };
    lines.push('研究轨迹 × Agent Teams：actor ' + (board.actor ?? '(未指定)') + ' · 主题 ' + stats.topics + ' · 未决叶 ' + stats.openLeaves + ' · 可认领 ' + stats.claimable);
    if (!team.available) {
        lines.push('Agent Teams：未接入' + (team.error !== '' ? '（' + truncate(team.error, 120) + '）' : '') + '；只显示树上的租约与可认领主题。');
    } else {
        lines.push('Agent Teams：成员 ' + team.members.length + ' · 任务 ' + team.tasks.length + '（进行中 ' + team.active.length + '）');
        if (team.members.length > 0) {
            lines.push('  成员：' + team.members.slice(0, 6).map((member) => member.name + '@' + member.status).join('、'));
        }
        if (team.linked.length > 0) {
            lines.push('已关联任务（' + team.linked.length + '）：');
            for (const task of team.linked.slice(0, 6)) {
                const target = task.nodeId + ' ' + truncate(task.node.title, 50);
                lines.push('  ' + task.id + ' [' + task.status + '] @' + (task.ownerName ?? 'unowned') + ' ' + truncate(task.subject, 60) + ' → ' + target);
            }
        }
        if (team.unlinked.length > 0) {
            lines.push('未关联任务（' + team.unlinked.length + '）：');
            for (const task of team.unlinked.slice(0, 4)) {
                lines.push('  ' + task.id + ' [' + task.status + '] @' + (task.ownerName ?? 'unowned') + ' ' + truncate(task.subject, 70));
            }
        }
    }
    if (stats.topics === 0) {
        lines.push('还没有 topic：先用 explore_tree_record add kind=topic 建主题，再 assign 认领。');
        return lines.join('\n');
    }
    lines.push('我的主题（' + shownLabel(stats.mine, board.mine.length) + '）：');
    if (board.mine.length === 0) lines.push('  （无；从下面的待认领里选一个）');
    for (const item of board.mine) lines.push(renderTopicLine(item));
    lines.push('待认领（' + shownLabel(stats.unowned, board.unowned.length) + '）：');
    if (board.unowned.length === 0) lines.push('  （无）');
    for (const item of board.unowned.slice(0, 5)) lines.push(renderTopicLine(item));
    if (board.expired.length > 0) {
        lines.push('租约过期（' + shownLabel(stats.expired, board.expired.length) + '）：');
        for (const item of board.expired.slice(0, 5)) {
            lines.push(renderTopicLine(item));
            if (item.owner !== null) lines.push('    建议：' + item.id + ' 可重新认领或由 ' + item.owner + ' 续租');
        }
    }
    if (board.others.length > 0) {
        lines.push('他人主题（' + shownLabel(stats.others, board.others.length) + '，避免重复写）：');
        for (const item of board.others.slice(0, 5)) lines.push(renderTopicLine(item));
    }
    if (board.conflicts.length > 0) {
        lines.push('冲突（' + shownLabel(stats.conflicts, board.conflicts.length) + '）：');
        for (const item of board.conflicts.slice(0, 3)) {
            lines.push('  ' + item.id + ' ' + truncate(item.title, 60) + '：' + item.conflictEdges.join('；'));
        }
    }
    if (board.taskSuggestions.length > 0) {
        lines.push('可发布为 Team 任务（' + board.taskSuggestions.length + '，用 Team 插件自己的 team_task_create；description 保留标记）：');
        for (const entry of board.taskSuggestions.slice(0, 3)) {
            lines.push('  ' + entry.targetId + '｜' + entry.subject);
            lines.push('    ' + entry.command);
        }
    }
    if (board.suggestions.length > 0) {
        lines.push('建议（' + board.suggestions.length + '）：');
        for (const item of board.suggestions) {
            lines.push('  [' + item.type + '] → ' + item.targetId + ' ' + truncate(item.reason, 180));
            lines.push('    ' + item.command);
        }
    }
    const text = lines.join('\n');
    return text.length <= 6000 ? text : text.slice(0, 5999) + '…';
}
