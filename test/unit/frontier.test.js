import assert from 'node:assert/strict';
import test from 'node:test';

import { addNode, createGraphState, linkNodes } from '../../src/core/graph.js';
import { computeFrontier } from '../../src/core/frontier.js';
import { nodeLine, renderFrontier, renderOverview, renderTree } from '../../src/core/compact.js';

const NOW = '2026-01-01T00:00:00.000Z';

function state() {
    return createGraphState({ workspaceRoot: 'C:/ws', now: NOW });
}

test('空图给出 seed 建议', () => {
    const result = computeFrontier(state(), {});
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].type, 'seed');
});

test('研究图同时给出验证类与换路径/收敛类建议', () => {
    const graph = state();
    const goal = addNode(graph, { kind: 'goal', title: '目标', status: 'active' }, { now: NOW });
    const h1 = addNode(graph, { parentId: goal.id, kind: 'hypothesis', title: '假设一', confidence: 0.9 }, { now: NOW });
    const h2 = addNode(graph, { parentId: goal.id, kind: 'hypothesis', title: '假设二' }, { now: NOW });
    addNode(graph, { parentId: h1.id, kind: 'step', title: '步骤' }, { now: NOW });
    addNode(graph, { parentId: h1.id, kind: 'dead_end', title: '失败尝试', summary: '接口不通' }, { now: NOW });
    addNode(graph, { parentId: goal.id, kind: 'question', title: '开放问题', status: 'open' }, { now: NOW });
    const result = computeFrontier(graph, { sessionId: null, focusId: h1.id, limit: 5 });
    const types = result.suggestions.map((item) => item.type);
    assert.ok(types.includes('verify'), `应包含 verify：${types.join(',')}`);
    assert.ok(types.some((type) => type === 'branch' || type === 'consolidate' || type === 'resolve'), `应包含收敛/换路：${types.join(',')}`);
    assert.ok(result.avoid.some((item) => item.nodeId === 'n5'));
    const text = renderFrontier(result);
    assert.match(text, /建议（/);
});

test('全部 done 且有结论时给出 stop', () => {
    const graph = state();
    const goal = addNode(graph, { kind: 'goal', title: '目标', status: 'done' }, { now: NOW });
    addNode(graph, { kind: 'conclusion', title: '结论', status: 'done' }, { now: NOW });
    addNode(graph, { parentId: goal.id, kind: 'step', title: '步骤', status: 'done' }, { now: NOW });
    const result = computeFrontier(graph, {});
    assert.equal(result.suggestions[0].type, 'stop');
});

test('重复指纹给出 consolidate 建议且不抛错', () => {
    const graph = state();
    const first = addNode(graph, { kind: 'note', title: '重复想法 A', fingerprint: 'auto:note:dup' }, { now: NOW });
    addNode(graph, { kind: 'note', title: '重复想法 B', fingerprint: 'auto:note:dup' }, { now: NOW });
    const result = computeFrontier(graph, { sessionId: null });
    const consolidate = result.suggestions.find((item) => item.title === '合并重复节点');
    assert.ok(consolidate, '重复指纹应产生合并建议');
    assert.equal(consolidate.nodeId, first.id);
    assert.deepEqual(consolidate.basis, ['n1', 'n2']);
});

test('compact 渲染包含节点 id 与树结构', () => {
    const graph = state();
    const goal = addNode(graph, { kind: 'goal', title: '目标', status: 'active' }, { now: NOW });
    const step = addNode(graph, { parentId: goal.id, kind: 'step', title: '步骤' }, { now: NOW });
    linkNodes(graph, goal.id, step.id, 'supports');
    assert.match(nodeLine(goal), /^n1 ◐ goal 目标$/);
    const overview = renderOverview(graph, { sessionId: null });
    assert.match(overview, /n1/);
    assert.match(overview, /最近更新/);
    const tree = renderTree(graph, { maxDepth: 3 });
    assert.match(tree, /n2/);
    assert.match(tree, /步骤/);
});

test('overview：待办列表折叠推理旁白与已关闭主题的陈旧项', () => {
    const graph = state();
    const goal = addNode(graph, { kind: 'goal', title: '目标', status: 'active' }, { now: NOW });
    const topic = addNode(graph, { kind: 'topic', parentId: goal.id, title: '活跃主题', status: 'active' }, { now: NOW });
    addNode(graph, { kind: 'question', parentId: topic.id, title: '是否应该保留未决列表？', origin: 'auto' }, { now: NOW });
    addNode(graph, { kind: 'question', parentId: topic.id, title: 'Let me read the README first.', origin: 'auto' }, { now: NOW });
    const closed = addNode(graph, { kind: 'topic', parentId: goal.id, title: '旧主题', status: 'done' }, { now: NOW });
    addNode(graph, { kind: 'hypothesis', parentId: closed.id, title: 'Read the docs before deciding.', origin: 'auto' }, { now: NOW });

    const overview = renderOverview(graph, { sessionId: null });
    assert.match(overview, /待办（1 · 全图/);
    assert.match(overview, /已折叠 2/);
    const openSection = overview.slice(overview.indexOf('待办（1'), overview.indexOf('可用动作'));
    assert.doesNotMatch(openSection, /Let me read the README/);
    assert.doesNotMatch(openSection, /Read the docs before deciding/);
    assert.match(openSection, /是否应该保留未决列表/);
});

test('overview：没有 topic 的旧图里 step 下的未决不被折叠为零（B1 回归）', () => {
    const graph = state();
    const goal = addNode(graph, { kind: 'goal', title: '旧图', status: 'active' }, { now: NOW });
    const step = addNode(graph, { parentId: goal.id, kind: 'step', title: '第 1 轮' }, { now: NOW });
    addNode(graph, {
        parentId: step.id,
        kind: 'question',
        title: '没有 topic 时这个问题还要不要做？',
        origin: 'auto',
    }, { now: NOW });
    const overview = renderOverview(graph, { sessionId: null });
    assert.match(overview, /待办（1 · 全图/);
    assert.match(overview, /没有 topic 时这个问题还要不要做/);
    assert.doesNotMatch(overview, /待办（0/);
});

test('auto-curated 的自动收敛项不再被当成死路参与 frontier/overview', () => {
    const graph = state();
    const goal = addNode(graph, { kind: 'goal', title: '目标', status: 'active' }, { now: NOW });
    const curated = addNode(graph, {
        parentId: goal.id,
        kind: 'question',
        title: '自动收敛的旁白',
        status: 'abandoned',
        tags: ['auto-curated', 'reasoning-noise', 'archived'],
        summary: '自动收敛：推理旁白',
    }, { now: NOW });
    const real = addNode(graph, {
        parentId: goal.id,
        kind: 'dead_end',
        title: '真正的死路',
        summary: '接口不通',
    }, { now: NOW });
    const result = computeFrontier(graph, { sessionId: null, focusId: real.id, limit: 6 });
    assert.ok(!result.avoid.some((item) => item.nodeId === curated.id), '自动收敛项不应进入 avoid');
    assert.ok(result.avoid.some((item) => item.nodeId === real.id), '真正的死路仍应进入 avoid');
});

test('P2：supports 边上的证据让假设不再进入 verify，contradicts 边进入提示', () => {
    const graph = state();
    const goal = addNode(graph, { kind: 'goal', title: '目标', status: 'active' }, { now: NOW });
    const h1 = addNode(graph, { parentId: goal.id, kind: 'hypothesis', title: '缓存键格式变化是主因' }, { now: NOW });
    const h2 = addNode(graph, { parentId: goal.id, kind: 'hypothesis', title: '工具顺序变化是主因' }, { now: NOW });
    const evidence = addNode(graph, { kind: 'evidence', title: '回放显示键格式改变后命中率下降' }, { now: NOW });
    linkNodes(graph, evidence.id, h1.id, 'supports');
    const dead = addNode(graph, { kind: 'dead_end', title: '回滚键格式无效', summary: '回滚后命中率未恢复' }, { now: NOW });
    linkNodes(graph, dead.id, h2.id, 'contradicts');

    const result = computeFrontier(graph, { sessionId: null, focusId: h1.id, limit: 8 });
    assert.ok(!result.suggestions.some((item) => item.type === 'verify' && item.nodeId === h1.id),
        '有 supports 边的假设不应再提示验证');
    assert.ok(result.notes.some((note) => /supports 边/.test(note)), 'notes 应说明边上的证据');
    assert.ok(result.notes.some((note) => /contradicts/.test(note)), 'notes 应提示冲突证据');
    const revive = result.suggestions.find((item) => item.type === 'revive');
    assert.ok(revive, '死路仍有 revive 建议');
    assert.match(revive.reason, /否定了假设/);
});
