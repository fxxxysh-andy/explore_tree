import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addNode,
    GRAPH_VERSION,
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

test('P1：closeReason/resolutionBy 写入、重开清空、合并留因并持久化', () => {
    const state = freshState();
    const question = addNode(state, { kind: 'question', title: '是否保留缓存？' }, { now: NOW });
    updateNode(state, question.id, { status: 'done', closeReason: 'solved', resolutionBy: 'human' }, { now: NOW });
    assert.equal(question.closeReason, 'solved');
    assert.equal(question.resolutionBy, 'human');
    updateNode(state, question.id, { status: 'active' }, { now: NOW });
    assert.equal(question.closeReason, null, '重开必须清掉旧结束原因');
    assert.equal(question.resolutionBy, null);

    const drop = addNode(state, { kind: 'question', title: '重复问题' }, { now: NOW });
    mergeNodes(state, question.id, drop.id, { now: NOW });
    assert.equal(drop.closeReason, 'duplicate');
    assert.equal(drop.resolutionBy, 'auto');
    const superseded = addNode(state, { kind: 'question', title: '被替代问题' }, { now: NOW });
    mergeNodes(state, question.id, superseded.id, { closeReason: 'superseded', now: NOW });
    assert.equal(superseded.closeReason, 'superseded');

    const stats = graphStats(state);
    assert.equal(stats.byCloseReason.duplicate, 1);
    assert.equal(stats.byCloseReason.superseded, 1);
    assert.equal(stats.byResolution.auto, 2);

    const raw = JSON.parse(JSON.stringify(toJSON(state)));
    const restored = fromJSON(raw);
    assert.equal(restored.nodes.get(drop.id).closeReason, 'duplicate');
    assert.equal(restored.nodes.get(drop.id).resolutionBy, 'auto');
    // 旧图没有字段时不能因加载而凭空写入。
    for (const node of Object.values(raw.nodes)) {
        delete node.closeReason;
        delete node.resolutionBy;
    }
    const old = fromJSON(raw);
    assert.equal('closeReason' in old.nodes.get(drop.id), false);
    assert.equal('resolutionBy' in old.nodes.get(drop.id), false);
});

test('P1：done step 默认 completed，旧图未知原因不误判', () => {
    const state = freshState();
    const step = addNode(state, { kind: 'step', title: '已完成轮次', status: 'done' }, { now: NOW });
    assert.equal(step.closeReason, 'completed');
    assert.equal(step.resolutionBy, 'auto');
    const open = addNode(state, { kind: 'question', title: '仍开放', status: 'open', closeReason: 'solved' }, { now: NOW });
    assert.equal(open.closeReason, null, 'open 节点不能带关闭原因');
    assert.equal(open.resolutionBy, null);
    assert.equal(graphStats(state).byCloseReason.completed, 1);
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

test('v2：读取 v1 保持 v1，未知版本拒绝', () => {
    const state = freshState();
    addNode(state, { kind: 'goal', title: 'G' }, { now: NOW });
    const raw = JSON.parse(JSON.stringify(toJSON(state)));
    raw.version = 1;
    for (const node of Object.values(raw.nodes)) {
        delete node.closeReason;
        delete node.resolutionBy;
    }
    const restored = fromJSON(raw);
    assert.equal(restored.version, 1, '旧图保持 v1，等待显式迁移');
    updateNode(restored, 'n1', { title: 'G2' }, { now: NOW });
    assert.equal(toJSON(restored).version, 1, '普通写入不能把缺字段的图升成 v2');
    assert.equal(GRAPH_VERSION, 2, '新建图直接写 v2');
    raw.version = 3;
    assert.throws(() => fromJSON(raw), /unsupported graph version: 3/);
});
