import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addNode,
    assignLease,
    childrenOf,
    createGraphState,
    ensureRevision,
    LeaseError,
    StaleRevisionError,
    findByFingerprint,
    fromJSON,
    graphStats,
    linkNodes,
    mergeNodes,
    moveNode,
    nextNodeId,
    pathToRoot,
    relatedNodes,
    removeNode,
    rootNodes,
    sessionOf,
    setActiveNode,
    subtreeIds,
    toJSON,
    updateNode,
    validateGraph,
} from '../../src/core/graph.js';

const NOW = '2026-01-01T00:00:00.000Z';

function freshState() {
    return createGraphState({ workspaceRoot: 'C:/ws', now: NOW });
}

test('addNode 生成单调 id、根索引与父索引', () => {
    const state = freshState();
    const goal = addNode(state, { kind: 'goal', title: '目标' }, { now: NOW });
    const step = addNode(state, { parentId: goal.id, kind: 'step', title: '步骤' }, { now: NOW });
    assert.equal(goal.id, 'n1');
    assert.equal(step.id, 'n2');
    assert.deepEqual(rootNodes(state).map((node) => node.id), ['n1']);
    assert.deepEqual(childrenOf(state, 'n1').map((node) => node.id), ['n2']);
    assert.deepEqual(pathToRoot(state, 'n2').map((node) => node.id), ['n1', 'n2']);
    assert.equal(validateGraph(state).ok, true);
});

test('nodeVersion 单调递增，CAS 不匹配抛 StaleRevisionError', () => {
    const state = freshState();
    const node = addNode(state, { kind: 'hypothesis', title: 'H' }, { now: NOW });
    assert.equal(node.nodeVersion, 1);
    assert.equal(node.leaseEpoch, 0);
    updateNode(state, node.id, { title: 'H2' }, { now: NOW });
    assert.equal(node.nodeVersion, 2, '任何字段更新都要推进版本');
    updateNode(state, node.id, { summary: 's' }, { now: NOW, expectedRevision: 2 });
    assert.equal(node.nodeVersion, 3);
    assert.throws(
        () => updateNode(state, node.id, { title: 'H3' }, { now: NOW, expectedRevision: 2 }),
        (error) => error instanceof StaleRevisionError && error.currentVersion === 3 && error.expectedVersion === 2,
    );
    ensureRevision(state, node.id, 3);
    assert.throws(() => ensureRevision(state, node.id, 1), StaleRevisionError);
});

test('assignLease：认领/续租/抢占/释放都推进 leaseEpoch', () => {
    const state = freshState();
    const goal = addNode(state, { kind: 'goal', title: 'G' }, { now: NOW });
    const topic = addNode(state, { parentId: goal.id, kind: 'topic', title: 'T' }, { now: NOW });
    assignLease(state, topic.id, { owner: 'a', leaseUntil: '2026-01-01T01:00:00.000Z', actor: 'a', now: NOW });
    assert.equal(topic.owner, 'a');
    assert.equal(topic.leaseEpoch, 1);
    assert.equal(topic.nodeVersion, 2);
    assert.throws(
        () => assignLease(state, topic.id, { owner: 'b', leaseUntil: '2026-01-01T01:00:00.000Z', actor: 'b', now: NOW }),
        (error) => error instanceof LeaseError && error.code === 'LEASE_HELD',
    );
    assignLease(state, topic.id, { owner: 'b', leaseUntil: '2026-01-01T01:00:00.000Z', actor: 'lead', steal: true, now: NOW });
    assert.equal(topic.owner, 'b');
    assert.equal(topic.leaseEpoch, 2);
    assignLease(state, topic.id, { owner: 'b', leaseUntil: '2026-01-01T02:00:00.000Z', actor: 'b', renew: true, now: NOW });
    assert.equal(topic.leaseEpoch, 3);
    assignLease(state, topic.id, { owner: null, actor: 'b', now: NOW });
    assert.equal(topic.owner, null);
    assert.equal(topic.leaseEpoch, 4, '释放也要推进 epoch，避免旧租约写回');
    assert.throws(
        () => assignLease(state, goal.id, { owner: 'a', now: NOW }),
        (error) => error instanceof LeaseError && error.code === 'NOT_TOPIC',
    );
});

test('updateNode 白名单 + 指纹索引', () => {
    const state = freshState();
    const node = addNode(state, { kind: 'hypothesis', title: 'H', fingerprint: 'fp1' }, { now: NOW });
    updateNode(state, node.id, { title: 'H2', summary: 's', confidence: 0.5, fingerprint: 'fp2' }, { now: NOW });
    assert.equal(node.title, 'H2');
    assert.deepEqual(findByFingerprint(state, 'fp1'), []);
    assert.deepEqual(findByFingerprint(state, 'fp2').map((item) => item.id), [node.id]);
});

test('moveNode 阻止环，合法移动更新根与子索引', () => {
    const state = freshState();
    const a = addNode(state, { kind: 'goal', title: 'A' }, { now: NOW });
    const b = addNode(state, { parentId: a.id, kind: 'step', title: 'B' }, { now: NOW });
    const c = addNode(state, { parentId: b.id, kind: 'note', title: 'C' }, { now: NOW });
    assert.throws(() => moveNode(state, a.id, c.id), /descendant/);
    moveNode(state, c.id, a.id, { now: NOW });
    assert.deepEqual(childrenOf(state, a.id).map((node) => node.id), ['n2', 'n3']);
    assert.deepEqual(subtreeIds(state, a.id).sort(), ['n1', 'n2', 'n3']);
});

test('linkNodes 去重，mergeNodes 迁移子节点/关系并留占位', () => {
    const state = freshState();
    const keep = addNode(state, { kind: 'hypothesis', title: '保留', fingerprint: 'same' }, { now: NOW });
    const drop = addNode(state, { kind: 'hypothesis', title: '丢弃', fingerprint: 'same' }, { now: NOW });
    const child = addNode(state, { parentId: drop.id, kind: 'evidence', title: '证据' }, { now: NOW });
    const other = addNode(state, { kind: 'conclusion', title: '结论' }, { now: NOW });
    const edge1 = linkNodes(state, drop.id, other.id, 'supports', 'n', { now: NOW });
    const edge2 = linkNodes(state, drop.id, other.id, 'supports', '', { now: NOW });
    assert.equal(edge1.id, edge2.id);
    mergeNodes(state, keep.id, drop.id, { now: NOW });
    assert.equal(drop.status, 'abandoned');
    assert.equal(child.parentId, keep.id);
    assert.ok(keep.mergedFrom.includes(drop.id));
    assert.deepEqual(relatedNodes(state, other.id).map((item) => item.node.id), [keep.id]);
    assert.equal(validateGraph(state).ok, true);
});

test('removeNode 子节点上移、边删除', () => {
    const state = freshState();
    const a = addNode(state, { kind: 'goal', title: 'A' }, { now: NOW });
    const b = addNode(state, { parentId: a.id, kind: 'step', title: 'B' }, { now: NOW });
    const c = addNode(state, { parentId: b.id, kind: 'note', title: 'C' }, { now: NOW });
    linkNodes(state, b.id, a.id, 'refines', '', { now: NOW });
    removeNode(state, b.id, { now: NOW });
    assert.equal(c.parentId, a.id);
    assert.equal(state.edges.length, 0);
    assert.equal(validateGraph(state).ok, true);
});

test('会话游标', () => {
    const state = freshState();
    const goal = addNode(state, { kind: 'goal', title: 'G' }, { now: NOW });
    const session = sessionOf(state, 's1', NOW);
    setActiveNode(state, 's1', goal.id, NOW);
    assert.equal(session.activeNodeId, goal.id);
    assert.throws(() => setActiveNode(state, 's1', 'n99', NOW), /unknown node/);
    assert.equal(validateGraph(state).ok, true);
});

test('toJSON/fromJSON 往返保持结构，seq 不复用', () => {
    const state = freshState();
    const a = addNode(state, { kind: 'goal', title: 'A', createdBy: 'agent-a' }, { now: NOW });
    updateNode(state, a.id, { title: 'A2' }, { now: NOW, actor: 'agent-b' });
    addNode(state, { parentId: a.id, kind: 'step', title: 'B' }, { now: NOW });
    nextNodeId(state);
    const raw = JSON.parse(JSON.stringify(toJSON(state)));
    const restored = fromJSON(raw);
    assert.deepEqual([...restored.nodes.keys()], [...state.nodes.keys()]);
    assert.equal(restored.seq, 3);
    assert.equal(validateGraph(restored).ok, true);
    assert.equal(childrenOf(restored, 'n1').length, 1);
    assert.equal(restored.nodes.get('n1').nodeVersion, 2);
    assert.equal(restored.nodes.get('n1').createdBy, 'agent-a');
    assert.equal(restored.nodes.get('n1').updatedBy, 'agent-b');
});

test('graphStats 统计未验证假设与重复', () => {
    const state = freshState();
    const h = addNode(state, { kind: 'hypothesis', title: 'H', fingerprint: 'fp' }, { now: NOW });
    addNode(state, { kind: 'hypothesis', title: 'H2', fingerprint: 'fp', hits: 2 }, { now: NOW });
    const stats = graphStats(state);
    assert.equal(stats.nodes, 2);
    assert.equal(stats.repeated, 1);
    assert.equal(stats.hypotheses, 2);
    assert.equal(stats.unverifiedHypotheses, 2);
    assert.equal(stats.byCreator.unknown, 2, '无 actor 的旧节点归到 unknown');
    assert.equal(h.status, 'open');
});

test('graphStats 按 createdBy/updatedBy 给 per-actor 统计', () => {
    const state = freshState();
    addNode(state, { kind: 'note', title: 'A', createdBy: 'agent-a', updatedBy: 'agent-a' }, { now: NOW });
    addNode(state, { kind: 'note', title: 'B', createdBy: 'agent-b', updatedBy: 'extractor' }, { now: NOW });
    addNode(state, { kind: 'note', title: 'C', createdBy: 'agent-a', updatedBy: 'agent-a' }, { now: NOW });
    const stats = graphStats(state);
    assert.deepEqual(stats.byCreator, { 'agent-a': 2, 'agent-b': 1 });
    assert.deepEqual(stats.byUpdater, { 'agent-a': 2, extractor: 1 });
});
