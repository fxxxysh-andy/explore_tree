import test from 'node:test';
import assert from 'node:assert/strict';

import { addNode, createGraphState, linkNodes, updateNode } from '../../src/core/graph.js';
import {
    claimableTopics,
    parseTeamTaskMarker,
    renderHandoff,
    topicConflicts,
    digestBasisOf,
    leafRootImportance,
    leaseStatus,
    renderBrief,
    renderBriefDelta,
    snapshotBriefState,
    trunkFrontier,
    isDigestStale,
    refreshAncestorTopics,
    refreshTopicDigest,
    renderTrunk,
    topicDigest,
    topicTaskPayload,
    trunkOf,
    trunkStats,
    validateTrunk,
} from '../../src/core/trunk.js';

const NOW = '2026-11-01T00:00:00.000Z';

function setup() {
    const state = createGraphState({ workspaceRoot: '/tmp/trunk-test', now: NOW });
    const goal = addNode(state, { kind: 'goal', title: '研究轨迹插件', now: NOW });
    const topic = addNode(state, { kind: 'topic', parentId: goal.id, title: '建树算法', now: NOW });
    const leaf = addNode(state, { kind: 'question', parentId: topic.id, title: '配额为何先到先得？', now: NOW });
    addNode(state, { kind: 'evidence', parentId: leaf.id, title: '回放 97.8% 通过', now: NOW });
    const leaf2 = addNode(state, { kind: 'hypothesis', parentId: topic.id, title: '同分靠时间序会挤掉结论', now: NOW });
    addNode(state, { kind: 'decision', parentId: leaf2.id, title: '改为分层配额 + MMR', now: NOW });
    return { state, goal, topic, leaf, leaf2 };
}

test('模板 digest 只读子节点标题/状态，可重算且 basis 一致', () => {
    const { state, topic, leaf, leaf2 } = setup();
    const digest = topicDigest(state, state.nodes.get(topic.id));
    assert.match(digest, /配额为何先到先得/);
    assert.match(digest, /同分靠时间序/);
    assert.match(digest, /完成 0\/2/);

    const refreshed = refreshTopicDigest(state, topic.id);
    assert.equal(refreshed.digest, digest);
    assert.equal(refreshed.digestSource, 'template');
    assert.deepEqual(refreshed.digestBasis.children, [leaf.id, leaf2.id].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
    assert.equal(refreshed.digestBasis.hash, digestBasisOf(state, refreshed, digest).hash);
    assert.equal(isDigestStale(state, refreshed), false);
});

test('子节点完成后 digest 更新进度；人工摘要不被模板覆盖', () => {
    const { state, topic, leaf } = setup();
    refreshTopicDigest(state, topic.id);
    updateNode(state, leaf.id, { status: 'done' }, { now: NOW });
    refreshTopicDigest(state, topic.id);
    assert.match(state.nodes.get(topic.id).digest, /完成 1\/2/);

    updateNode(state, topic.id, { digest: '人工写的摘要', digestSource: 'human' }, { now: NOW });
    refreshTopicDigest(state, topic.id);
    assert.equal(state.nodes.get(topic.id).digest, '人工写的摘要');
});

test('topic 级冲突：contradicts 边在 trunk/brief/frontier/handoff 可见', () => {
    const { state, topic, leaf, leaf2 } = setup();
    refreshTopicDigest(state, topic.id);
    linkNodes(state, leaf.id, leaf2.id, 'contradicts', '两个结论互斥', { now: NOW });
    assert.equal(topicConflicts(state, topic.id).length, 1);
    assert.equal(trunkOf(state)[0].topics[0].conflicts, 1);
    assert.equal(trunkStats(state).conflictedTopics, 1);
    assert.match(renderTrunk(state), /⚠冲突/);
    assert.match(renderBrief(state), /⚠冲突/);
    assert.match(renderBrief(state), /冲突：/);
    const handoff = renderHandoff(state, topic.id, { from: 'agent-a', to: 'agent-b' });
    assert.match(handoff, /冲突：/);
    assert.ok(trunkFrontier(state, { limit: 10 }).some((item) => item.type === 'resolve' && item.targetId === topic.id));
});

test('trunkOf/trunkStats/renderTrunk 给出去掉时间桶的主干视图', () => {
    const { state, goal, topic } = setup();
    refreshTopicDigest(state, topic.id);
    const trunk = trunkOf(state);
    assert.equal(trunk.length, 1);
    assert.equal(trunk[0].id, goal.id);
    assert.equal(trunk[0].topics.length, 1);
    assert.equal(trunk[0].topics[0].id, topic.id);
    assert.equal(trunk[0].topics[0].leaves.length, 2);
    assert.equal(trunk[0].topics[0].progress.total, 2);
    assert.equal(trunk[0].topics[0].progress.done, 0);

    const stats = trunkStats(state);
    assert.equal(stats.topics, 1);
    assert.equal(stats.leafRoots, 2);
    assert.equal(stats.semanticUnderStep, 0);

    const text = renderTrunk(state);
    assert.match(text, /研究主干：1 个主题 \/ 2 个叶根/);
    assert.match(text, /建树算法/);
    assert.match(text, /配额为何先到先得/);
});

test('validateTrunk：topic 结构错误报 ERROR，旧图 step 父节点报 WARN', () => {
    const { state, goal, topic } = setup();
    refreshTopicDigest(state, topic.id);
    assert.equal(validateTrunk(state).ok, true);

    const step = addNode(state, { kind: 'step', parentId: goal.id, title: '第 1 轮研究', now: NOW });
    const badTopic = addNode(state, { kind: 'topic', parentId: step.id, title: '错位主干', now: NOW });
    const orphan = addNode(state, { kind: 'question', parentId: step.id, title: '直接挂 step 的问题', now: NOW });
    addNode(state, { kind: 'evidence', parentId: orphan.id, title: '证据', now: NOW });
    const result = validateTrunk(state);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((line) => line.includes(badTopic.id) && line.includes('父节点')));
    assert.ok(result.warnings.some((line) => line.includes('挂在 step 下')));
    assert.ok(validateTrunk(state).warnings.some((line) => line.includes('旧图')));
});

test('refreshAncestorTopics 会向上刷新父 topic', () => {
    const { state, goal, topic } = setup();
    const child = addNode(state, { kind: 'topic', parentId: topic.id, title: '子主题', now: NOW });
    const leaf = addNode(state, { kind: 'decision', parentId: child.id, title: '选择方案 A', now: NOW });
    const touched = refreshAncestorTopics(state, leaf.id);
    assert.ok(touched.some((node) => node.id === child.id));
    assert.ok(touched.some((node) => node.id === topic.id));
    assert.match(state.nodes.get(child.id).digest, /选择方案 A/);
    assert.match(state.nodes.get(topic.id).digest, /子主题/);
    assert.ok(trunkOf(state)[0].topics[0].children.length === 1);
    // goal 不参与 digest
    assert.equal(state.nodes.get(goal.id).digest, null);
});

test('trunkFrontier/renderBrief：给出主干建议与 ≤400 字简报', () => {
    const { state, topic, leaf } = setup();
    refreshTopicDigest(state, topic.id);
    const items = trunkFrontier(state, { limit: 5 });
    assert.ok(items.some((item) => item.type === 'advance' && item.targetId === topic.id), '有未决叶根时应建议推进该主题');
    assert.ok(items.some((item) => item.type === 'claim' && item.targetId === topic.id), '未认领时应建议认领');

    const brief = renderBrief(state, { sessionId: null, limit: 2 });
    assert.match(brief, /研究轨迹简报/);
    assert.match(brief, /主干/);
    assert.match(brief, /建树算法/);
    assert.ok(brief.length <= 400, `brief 应 ≤400 字，实际 ${brief.length}`);
    assert.equal(leaf.status, 'open');
});

test('renderBriefDelta：只报关键节点变化，忽略 step/action 与无变化', () => {
    const { state, topic, leaf } = setup();
    const before = snapshotBriefState(state);
    assert.equal(renderBriefDelta(state, before), '', '没有变化时返回空串');

    const step = addNode(state, { kind: 'step', parentId: topic.id, title: '第 2 轮', now: NOW });
    updateNode(state, step.id, { status: 'done' }, { now: NOW });
    addNode(state, { kind: 'conclusion', parentId: leaf.id, title: '缓存键随版本变化', status: 'done', now: NOW });
    updateNode(state, leaf.id, { status: 'done' }, { now: NOW });

    const delta = renderBriefDelta(state, before);
    assert.match(delta, /研究轨迹增量/);
    assert.match(delta, /缓存键随版本变化/);
    assert.match(delta, /完成：/);
    assert.doesNotMatch(delta, /第 2 轮/, 'step 完成不算研究增量');
    assert.doesNotMatch(delta, /【研究轨迹简报】/);
    assert.ok(delta.length <= 400, '增量应 ≤400 字');
});

test('renderBriefDelta：首次没有快照时退回完整简报', () => {
    const { state } = setup();
    const full = renderBriefDelta(state, new Map());
    assert.match(full, /【研究轨迹简报】/);
    assert.match(full, /建树算法/);
});

test('叶根重要性：显式未决优先于自动提取的旧疑问', () => {
    const { state, topic } = setup();
    const autoLeaf = addNode(state, { kind: 'question', parentId: topic.id, title: '旧噪音', origin: 'auto', now: NOW });
    const explicitLeaf = addNode(state, { kind: 'question', parentId: topic.id, title: '显式未决', origin: 'model', now: NOW });
    assert.ok(leafRootImportance(explicitLeaf) > leafRootImportance(autoLeaf));
});

test('trunkFrontier：细节多且跨轮次的叶根建议 promote', () => {
    const { state, topic, leaf } = setup();
    refreshTopicDigest(state, topic.id);
    for (let index = 0; index < 6; index += 1) {
        addNode(state, {
            kind: 'evidence',
            parentId: leaf.id,
            title: '细节 ' + index,
            turn: index < 3 ? 1 : 2,
        });
    }
    const items = trunkFrontier(state, { limit: 10 });
    assert.ok(items.some((item) => item.type === 'promote' && item.targetId === leaf.id), '应建议把叶根提升为子主题');
});

test('租约与 Team 映射：未认领/过期可认领，payload 可直接建任务', () => {
    const { state, topic } = setup();
    assert.equal(leaseStatus(state.nodes.get(topic.id), Date.parse(NOW)), 'unowned');
    const owned = updateNode(state, topic.id, {
        owner: 'agent-a',
        leaseUntil: '2026-11-01T01:00:00.000Z',
    });
    assert.equal(leaseStatus(owned, Date.parse('2026-11-01T00:30:00.000Z')), 'leased');
    assert.equal(leaseStatus(owned, Date.parse('2026-11-01T02:00:00.000Z')), 'expired');
    assert.equal(claimableTopics(state, Date.parse('2026-11-01T00:30:00.000Z')).length, 0);
    assert.equal(claimableTopics(state, Date.parse('2026-11-01T02:00:00.000Z')).length, 1);
    const payload = topicTaskPayload(state.nodes.get(topic.id));
    assert.equal(payload.subject, '建树算法');
    assert.ok(payload.tags.includes('explore-tree'));
    assert.equal(payload.marker, '[explore-tree:' + topic.id + ']');
    assert.ok(payload.description.startsWith(payload.marker + '\n'), 'description 首行必须是节点标记');
    assert.equal(parseTeamTaskMarker(payload.description), topic.id, 'Team 任务描述能反查回主题节点');
});

test('人工摘要没有 basis 时不算过期（无法判断而不是 false positive）', () => {
    const { state, topic } = setup();
    const node = state.nodes.get(topic.id);
    node.digest = '人工写的摘要';
    node.digestSource = 'human';
    node.digestBasis = null;
    assert.equal(isDigestStale(state, node), false);
    node.digestSource = 'template';
    assert.equal(isDigestStale(state, node), true);
});

test('renderBrief：workspace 范围显示其他 goal 的主干，goal 范围不显示', () => {
    const { state, goal, topic } = setup();
    const otherGoal = addNode(state, { kind: 'goal', title: '多 agent 实验', now: NOW });
    const otherTopic = addNode(state, { kind: 'topic', parentId: otherGoal.id, title: '共享黑板', now: NOW });
    updateNode(state, otherTopic.id, { digest: '认领 + handoff' }, { now: NOW });
    state.sessions.set('s1', { goalId: goal.id, activeNodeId: topic.id });

    const goalBrief = renderBrief(state, { sessionId: 's1', limit: 2, scope: 'goal' });
    assert.doesNotMatch(goalBrief, /其他主干/);

    const workspaceBrief = renderBrief(state, { sessionId: 's1', limit: 2, scope: 'workspace' });
    assert.match(workspaceBrief, /其他主干：/);
    assert.match(workspaceBrief, /共享黑板/);
    assert.match(workspaceBrief, /认领 \+ handoff/);
    assert.ok(workspaceBrief.length <= 400, `brief 应 ≤400 字，实际 ${workspaceBrief.length}`);
});
