import test from 'node:test';
import assert from 'node:assert/strict';

import { addNode, createGraphState, moveNode, updateNode } from '../../src/core/graph.js';
import { applyTrunkMigration, planTrunkMigration, topicsUnder } from '../../src/core/migrate.js';
import { refreshTopicDigest, trunkStats } from '../../src/core/trunk.js';

const NOW = '2026-11-01T00:00:00.000Z';

function setup() {
    const state = createGraphState({ workspaceRoot: '/tmp/migrate-test', now: NOW });
    const goal = addNode(state, { kind: 'goal', title: '研究轨迹插件', now: NOW });
    const topic = addNode(state, { kind: 'topic', parentId: goal.id, title: '建树算法', summary: '分层配额、MMR 与 note 折叠，解决过程旁白占满槽位', now: NOW });
    const step = addNode(state, { kind: 'step', parentId: goal.id, title: '第 1 轮：优化建树', now: NOW });
    const hypothesis = addNode(state, {
        kind: 'hypothesis',
        parentId: step.id,
        title: '配额先到先得导致过程旁白占满槽位',
        now: NOW,
    });
    const evidence = addNode(state, {
        kind: 'evidence',
        parentId: step.id,
        title: '回放 97.8% 通过但 top24 交集为 0',
        now: NOW,
    });
    const note = addNode(state, { kind: 'note', parentId: step.id, title: '让我先看看代码', now: NOW });
    const weather = addNode(state, {
        kind: 'hypothesis',
        parentId: step.id,
        title: '明天可能会下雨，适合带伞',
        now: NOW,
    });
    refreshTopicDigest(state, topic.id, { now: NOW });
    return { state, goal, topic, step, hypothesis, evidence, note, weather };
}

test('planTrunkMigration：approach 挂 topic、dependent 挂叶根、note 不迁移', () => {
    const { state, topic, hypothesis, evidence, note, weather } = setup();
    const plan = planTrunkMigration(state, { threshold: 0.05 });
    const byId = new Map(plan.changes.map((change) => [change.id, change]));
    assert.ok(byId.has(hypothesis.id), '相关假设应可迁移');
    assert.equal(byId.get(hypothesis.id).targetParentId, topic.id);
    assert.equal(byId.get(hypothesis.id).reason, 'topic');
    assert.ok(byId.has(evidence.id), '证据应在迁移计划里');
    assert.ok([topic.id, hypothesis.id].includes(byId.get(evidence.id).targetParentId), '证据应挂 topic 或叶根');
    assert.ok(!byId.has(note.id), 'note 不迁移（时间性旁白）');
    assert.ok(!byId.has(weather.id), '不相关假设应低于阈值被跳过');
    assert.ok(plan.skipped.some((item) => item.id === weather.id && item.reason === 'below-threshold'));
});

test('applyTrunkMigration：移动父节点、补 stepId、刷新摘要，dry-run 不改图', () => {
    const { state, topic, step, hypothesis, evidence } = setup();
    const plan = planTrunkMigration(state, { threshold: 0.05 });
    assert.equal(state.nodes.get(hypothesis.id).parentId, step.id, 'plan 不应改动图');
    const applied = applyTrunkMigration(state, plan, { now: NOW });
    assert.ok(applied.moved >= 2);
    const movedHypothesis = state.nodes.get(hypothesis.id);
    assert.equal(movedHypothesis.parentId, topic.id);
    assert.equal(movedHypothesis.stepId, step.id);
    assert.ok(movedHypothesis.tags.includes('trunk-migrated'));
    assert.notEqual(state.nodes.get(evidence.id).parentId, step.id, '证据不应再挂 step');
    const topicNode = state.nodes.get(topic.id);
    assert.equal(typeof topicNode.digest, 'string');
    assert.ok(topicNode.digest.includes('配额先到先得') || topicNode.digest.includes('回放 97.8%'));
    assert.equal(trunkStats(state).semanticUnderStep, 1, '只剩不相关/note 类留在 step 下（weather）');
});

test('无 topic 时 plan 全部跳过，提示先建主干', () => {
    const state = createGraphState({ workspaceRoot: '/tmp/migrate-empty', now: NOW });
    const goal = addNode(state, { kind: 'goal', title: '只有目标', now: NOW });
    const step = addNode(state, { kind: 'step', parentId: goal.id, title: '第 1 轮', now: NOW });
    const hypothesis = addNode(state, { kind: 'hypothesis', parentId: step.id, title: '一个想法', now: NOW });
    const plan = planTrunkMigration(state, {});
    assert.equal(plan.changes.length, 0);
    assert.deepEqual(plan.skipped.find((item) => item.id === hypothesis.id).reason, 'no-topic');
    assert.deepEqual(topicsUnder(state, goal.id), []);
});

test('带 stepId 的叶根在迁移时优先作为 dependent 的父节点', () => {
    const { state, topic, step, hypothesis, evidence } = setup();
    // 把证据换成与假设高度相似的文本，确保能挂到叶根
    updateNode(state, evidence.id, { title: '配额先到先得导致旁白占满槽位：回放 97.8% 通过' }, { now: NOW });
    moveNode(state, hypothesis.id, topic.id, { now: NOW });
    updateNode(state, hypothesis.id, { stepId: step.id, tags: ['leaf-root'] }, { now: NOW });
    const plan = planTrunkMigration(state, { threshold: 0.05 });
    const evidenceChange = plan.changes.find((change) => change.id === evidence.id);
    assert.ok(evidenceChange, '证据应可迁移');
    assert.equal(evidenceChange.targetParentId, hypothesis.id, '应挂到同 stepId 的叶根');
    assert.equal(evidenceChange.reason, 'step-group');
});
