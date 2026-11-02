/**
 * P2：旧图迁移到摘要主干。
 *
 * 目标：把仍然直接挂在 `step` 下的语义节点迁到 topic（叶根/叶内），
 * 让主干视图与 frontier 不再被时间桶干扰；时间线通过 `stepId` 保留。
 *
 * 只在显式 `--apply` 时改动；纯函数便于 dry-run 与测试。
 *
 * @module core/migrate
 */
import { childrenOf, moveNode, updateNode } from './graph.js';
import { similarity } from './select.js';
import { digestBasisOf, isTopic, refreshAncestorTopics, topicDigest } from './trunk.js';

const LEAF_ROOT_KINDS = ['question', 'hypothesis', 'decision', 'conclusion', 'dead_end'];
const APPROACH_KINDS = ['question', 'hypothesis', 'decision'];
const DEPENDENT_KINDS = ['evidence'];

/** 节点文本（标题 + 摘要前 2000 字）。 */
function textOf(node) {
    return `${node.title ?? ''}\n${typeof node.summary === 'string' ? node.summary.slice(0, 2000) : ''}`;
}

/** 从节点向上找 goal。 */
export function goalAncestor(state, node) {
    let current = node;
    const seen = new Set();
    while (current !== undefined && current.parentId !== null && current.parentId !== undefined && !seen.has(current.id)) {
        seen.add(current.id);
        current = state.nodes.get(current.parentId);
        if (current?.kind === 'goal') return current;
    }
    return null;
}

/** goal 下的所有 topic（含嵌套）。 */
export function topicsUnder(state, goalId) {
    const out = [];
    const walk = (parentId) => {
        for (const child of childrenOf(state, parentId)) {
            if (!isTopic(child)) continue;
            out.push(child);
            walk(child.id);
        }
    };
    walk(goalId);
    return out;
}

/** topic 子树里所有 approach 节点（叶根候选）。 */
function approachesUnder(state, topicId) {
    const out = [];
    const walk = (parentId) => {
        for (const child of childrenOf(state, parentId)) {
            if (APPROACH_KINDS.includes(child.kind)) out.push(child);
            walk(child.id);
        }
    };
    walk(topicId);
    return out;
}

/**
 * 生成迁移计划（不改图）。
 *
 * @param {object} state
 * @param {{threshold?: number, limit?: number}} [options]
 * @returns {{changes: object[], skipped: object[]}}
 */
export function planTrunkMigration(state, options = {}) {
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.05;
    const limit = Number.isInteger(options.limit) ? options.limit : 200;
    const changes = [];
    const skipped = [];
    const nodes = [...state.nodes.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const stepTopic = new Map();
    // 已经迁过的节点（带 stepId 且在 topic 子树里）反向建立 step → topic 映射。
    for (const node of nodes) {
        if (node.stepId === null || node.stepId === undefined) continue;
        if (!LEAF_ROOT_KINDS.includes(node.kind)) continue;
        let current = node;
        let guard = 0;
        while (current !== undefined && current.parentId !== null && current.parentId !== undefined && guard < 100) {
            current = state.nodes.get(current.parentId);
            guard += 1;
            if (current !== undefined && current.kind === 'topic') {
                if (!stepTopic.has(node.stepId)) stepTopic.set(node.stepId, current.id);
                break;
            }
        }
    }

    // 第一遍：叶根候选（question/hypothesis/decision/conclusion/dead_end）按主题文本匹配。
    for (const node of nodes) {
        if (!LEAF_ROOT_KINDS.includes(node.kind)) continue;
        const step = state.nodes.get(node.parentId ?? '');
        if (step === undefined || step.kind !== 'step') continue;
        const goal = goalAncestor(state, step);
        if (goal === null) {
            skipped.push({ id: node.id, reason: 'no-goal' });
            continue;
        }
        const topics = topicsUnder(state, goal.id);
        if (topics.length === 0) {
            skipped.push({ id: node.id, reason: 'no-topic' });
            continue;
        }
        const nodeText = textOf(node);
        let bestTopic = null;
        let bestScore = 0;
        for (const topic of topics) {
            const score = similarity(nodeText, textOf(topic));
            if (score > bestScore) {
                bestScore = score;
                bestTopic = topic;
            }
        }
        if (bestTopic === null || bestScore < threshold) {
            skipped.push({ id: node.id, reason: 'below-threshold', score: Math.round(bestScore * 100) / 100 });
            continue;
        }
        changes.push({
            id: node.id,
            kind: node.kind,
            title: node.title,
            from: step.id,
            targetParentId: bestTopic.id,
            topicId: bestTopic.id,
            stepId: step.id,
            score: Math.round(bestScore * 100) / 100,
            reason: 'topic',
        });
        stepTopic.set(step.id, bestTopic.id);
    }

    const changedIds = new Set(changes.map((change) => change.id));

    // 第二遍：同一 step 里没匹配上主题的 dependent（证据等）跟随该 step 已迁移的叶根。
    for (const node of nodes) {
        if (changedIds.has(node.id)) continue;
        if (!DEPENDENT_KINDS.includes(node.kind)) continue;
        const step = state.nodes.get(node.parentId ?? '');
        if (step === undefined || step.kind !== 'step') continue;
        const topicId = stepTopic.get(step.id);
        if (topicId === undefined) {
            if (!skipped.some((item) => item.id === node.id)) skipped.push({ id: node.id, reason: 'no-topic-match' });
            continue;
        }
        const approaches = approachesUnder(state, topicId);
        for (const change of changes) {
            if (change.stepId !== step.id) continue;
            if (!LEAF_ROOT_KINDS.includes(change.kind)) continue;
            const moved = state.nodes.get(change.id);
            if (moved !== undefined) approaches.push(moved);
        }
        let target = null;
        let best = 0;
        for (const approach of approaches) {
            let score = similarity(textOf(node), textOf(approach));
            if (approach.stepId !== null && approach.stepId !== undefined && approach.stepId === step.id) score += 0.2;
            if (score > best) {
                best = score;
                target = approach;
            }
        }
        if (target === null) target = approaches.find((approach) => approach.stepId === step.id) ?? approaches[0] ?? null;
        if (target === null) {
            skipped.push({ id: node.id, reason: 'no-leaf' });
            continue;
        }
        changes.push({
            id: node.id,
            kind: node.kind,
            title: node.title,
            from: step.id,
            targetParentId: target.id,
            topicId,
            stepId: step.id,
            score: Math.round(Math.min(1, best) * 100) / 100,
            reason: 'step-group',
        });
        if (changes.length >= limit) break;
    }
    return { changes: changes.slice(0, limit), skipped };
}

/**
 * 应用迁移计划：移动父节点、补 stepId、打 trunk-migrated 标签、重算 topic 摘要。
 *
 * @param {object} state
 * @param {{changes: object[]}} plan
 * @param {{now?: string}} [options]
 */
export function applyTrunkMigration(state, plan, options = {}) {
    const now = options.now;
    const touchedTopics = new Set();
    let moved = 0;
    for (const change of plan.changes) {
        if (!state.nodes.has(change.id)) continue;
        if (!state.nodes.has(change.targetParentId)) continue;
        moveNode(state, change.id, change.targetParentId, now !== undefined ? { now } : {});
        const node = state.nodes.get(change.id);
        const tags = Array.isArray(node.tags) ? [...node.tags] : [];
        if (!tags.includes('trunk-migrated')) tags.push('trunk-migrated');
        updateNode(state, change.id, {
            stepId: change.stepId,
            tags,
        }, now !== undefined ? { now } : {});
        touchedTopics.add(change.topicId);
        moved += 1;
    }
    for (const topicId of touchedTopics) {
        const topic = state.nodes.get(topicId);
        if (topic === undefined || !isTopic(topic)) continue;
        refreshAncestorTopics(state, topicId, { force: false });
        // refreshAncestorTopics 走 updateNode（就地改状态）；调用方负责持久化。
    }
    return { moved, topics: [...touchedTopics] };
}

/** 迁移后 topic 的模板摘要（供脚本/测试断言与持久化）。 */
export function topicDigestPatch(state, topicId) {
    const topic = state.nodes.get(topicId);
    if (topic === undefined || !isTopic(topic)) return null;
    const digest = topicDigest(state, topic);
    return { digest, digestSource: 'template', digestBasis: digestBasisOf(state, topic, digest) };
}
