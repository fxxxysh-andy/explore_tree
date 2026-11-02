import test from 'node:test';
import assert from 'node:assert/strict';

import { addNode, createGraphState } from '../../src/core/graph.js';
import {
    AUTO_CURATED_TAG,
    NOISE_TAG,
    STALE_TOPIC_TAG,
    classifyOpenNode,
    collectOpenItems,
    isActionableOpenNode,
    isReasoningNoiseText,
    isSubstantiveHypothesisText,
    planOpenCleanup,
} from '../../src/core/hygiene.js';

const NOW = '2026-11-02T00:00:00.000Z';

function setup() {
    const state = createGraphState({ workspaceRoot: '/tmp/hygiene-test', now: NOW });
    const goal = addNode(state, { kind: 'goal', title: '未决收敛', now: NOW });
    const topic = addNode(state, { kind: 'topic', parentId: goal.id, title: '活跃主题', status: 'active', now: NOW });
    const noise = addNode(state, {
        kind: 'question', parentId: topic.id, title: 'Let me read the README first.', origin: 'auto', now: NOW,
    });
    const real = addNode(state, {
        kind: 'question', parentId: topic.id, title: '是否应该把 note 折叠进轮次摘要？', origin: 'auto', now: NOW,
    });
    const explicit = addNode(state, {
        kind: 'hypothesis', parentId: topic.id, title: 'I should test this later', origin: 'model', now: NOW,
    });
    const closed = addNode(state, { kind: 'topic', parentId: goal.id, title: '已完成主题', status: 'done', now: NOW });
    const stale = addNode(state, {
        kind: 'question', parentId: closed.id, title: 'Read the docs before deciding.', origin: 'auto', now: NOW,
    });
    const stays = addNode(state, {
        kind: 'question', parentId: closed.id, title: '如何设计跨进程写协议？', origin: 'auto', now: NOW,
    });
    return { state, goal, topic, closed, noise, real, explicit, stale, stays };
}

test('isReasoningNoiseText：过程旁白/计划句判噪音，真正的疑问句保留', () => {
    for (const text of [
        'Let me read the README first.',
        'Also update docs/extractor-optimization.md: P1 status.',
        'Now I will run the unit tests.',
        'Could use create goal',
        'Need decide experiment design, topic, delegate agents.',
        'Add hypothesis 1, hypothesis 2, and evidence under them',
        'The user asks how to optimize the tree.',
        'Keys: version, workspaceRoot, createdAt',
    ]) {
        assert.equal(isReasoningNoiseText(text), true, text);
    }
    for (const text of [
        '是否应该把 note 折叠进轮次摘要？',
        'Which is more valuable',
        'What should happen to aggregate node when budget is 0/1',
        '如何为 explore-tree 设计可证明安全的跨进程写协议',
        'Did npm test modify package.json',
        'But does WorkspaceGraphStore have an init method',
        'Interesting: ... is there an actual lock implementation',
        'Is there an actual lock implementation',
        'Should version bump to 0.5.0',
        '缓存为什么会失效',
        'note 折叠策略是什么',
        '在 2023–2025 年的研究中，LLM 多智能体系统（MAS）的失败模式主要有哪些',
    ]) {
        assert.equal(isReasoningNoiseText(text), false, text);
    }
    assert.equal(isReasoningNoiseText(''), true);
});

test('isReasoningNoiseText：命令式/片段也算过程，when 从句不再自动当问题', () => {
    for (const text of [
        'UpdateNode patch can contain rich fields',
        'Test 822 pre-fix: adopted node dropped from wanted',
        ') The bash tool likely uses bash',
        'This is concrete and likely useful',
        'Add v0.20.5 note maybe in design history',
    ]) {
        assert.equal(isReasoningNoiseText(text), true, text);
    }
    for (const text of [
        'When a later conclusion exists, older Q/H can be marked done',
        'Where does turn-scoped state reset',
        '如何为 explore-tree 设计可证明安全的跨进程写协议',
    ]) {
        assert.equal(isReasoningNoiseText(text), false, text);
    }
});

test('isSubstantiveHypothesisText：推测/条件/因果句保留，纯观察与计算式收敛', () => {
    for (const text of [
        'Maybe the cache key is the bottleneck',
        'If the queue is full, late conclusions are dropped',
        '并发读放大导致快照超时',
        'LWW 在 W3b 很可能不收敛',
    ]) assert.equal(isSubstantiveHypothesisText(text), true, text);
    for (const text of [
        'LWW 恒 1.0 在 W2/W3a/W4 为真',
        '2.2(hypothesis)+0.5(proposition) = 4.55',
        'Cross-turn: n2 survives',
        'Test 822 pre-fix: hypothesis count 3 instead of 4',
    ]) assert.equal(isSubstantiveHypothesisText(text), false, text);
});

test('classifyOpenNode：无假设信号的 observation hypothesis 归为噪音，人工假设仍保留', () => {
    const state = createGraphState({ workspaceRoot: '/tmp/hygiene-hypothesis', now: NOW });
    const goal = addNode(state, { kind: 'goal', title: '假设卫生', now: NOW });
    const topic = addNode(state, { kind: 'topic', parentId: goal.id, title: '活跃主题', status: 'active', now: NOW });
    const observation = addNode(state, {
        kind: 'hypothesis', parentId: topic.id, title: 'LWW 恒 1.0 在 W2/W3a/W4 为真', origin: 'auto', now: NOW,
    });
    addNode(state, { kind: 'evidence', parentId: observation.id, title: '120/120 seeds', origin: 'auto', now: NOW });
    const real = addNode(state, {
        kind: 'hypothesis', parentId: topic.id, title: 'Maybe the cache key is the bottleneck', origin: 'auto', now: NOW,
    });
    const explicit = addNode(state, {
        kind: 'hypothesis', parentId: topic.id, title: '缓存键格式变化是主因', origin: 'model', now: NOW,
    });
    assert.equal(classifyOpenNode(state, state.nodes.get(observation.id)).state, 'noise');
    assert.equal(classifyOpenNode(state, state.nodes.get(real.id)).state, 'current');
    assert.equal(classifyOpenNode(state, state.nodes.get(explicit.id)).state, 'current');
});

test('classifyOpenNode：噪音、已关闭主题陈旧项、真正未决三分类', () => {
    const { state, closed, noise, real, explicit, stale, stays } = setup();
    assert.equal(classifyOpenNode(state, state.nodes.get(noise.id)).state, 'noise');
    assert.equal(classifyOpenNode(state, state.nodes.get(real.id)).state, 'current');
    // 人工写入的未决即使像计划句也保留。
    assert.equal(classifyOpenNode(state, state.nodes.get(explicit.id)).state, 'current');
    assert.equal(classifyOpenNode(state, state.nodes.get(stale.id)).state, 'stale-topic');
    // 明确疑问句即使落在已关闭主题下也保留。
    assert.equal(classifyOpenNode(state, state.nodes.get(stays.id)).state, 'current');
    // 英文问句可能已被 cleanTitle 去掉问号：只要 isQuestionText 命中就应按实质未决保留。
    const english = addNode(state, {
        kind: 'question',
        parentId: closed.id,
        title: 'What should happen to aggregate node when budget is 0/1',
        origin: 'auto',
        now: NOW,
    });
    assert.equal(classifyOpenNode(state, state.nodes.get(english.id)).state, 'current');
});

test('collectOpenItems：没有 topic 时 step 下的未决仍进首屏（B1 回归）', () => {
    const state = createGraphState({ workspaceRoot: '/tmp/hygiene-no-topic', now: NOW });
    const goal = addNode(state, { kind: 'goal', title: '旧图', now: NOW });
    const step = addNode(state, { kind: 'step', parentId: goal.id, title: '第 1 轮', now: NOW });
    const question = addNode(state, {
        kind: 'question', parentId: step.id, title: '没有 topic 时这个问题还要不要做？', origin: 'auto', now: NOW,
    });
    const result = collectOpenItems(state, { limit: 8 });
    assert.equal(result.total, 1);
    assert.equal(result.visibleCount, 1);
    assert.equal(result.detailCount, 0);
    assert.equal(isActionableOpenNode(state, state.nodes.get(question.id)), true);
});

test('blocker 标签豁免自动收敛：分类为 current，cleanup 不动它', () => {
    const state = createGraphState({ workspaceRoot: '/tmp/hygiene-blocker', now: NOW });
    const goal = addNode(state, { kind: 'goal', title: '阻塞项', now: NOW });
    const topic = addNode(state, { kind: 'topic', parentId: goal.id, title: '部署', status: 'active', now: NOW });
    const blocker = addNode(state, {
        kind: 'question',
        parentId: topic.id,
        title: 'Server port is taken',
        origin: 'auto',
        tags: ['blocker'],
        now: NOW,
    });
    assert.equal(classifyOpenNode(state, state.nodes.get(blocker.id)).state, 'current');
    const result = collectOpenItems(state, { limit: 8 });
    assert.equal(result.visibleCount, 1);
    const plan = planOpenCleanup(state);
    assert.ok(!plan.changes.some((change) => change.id === blocker.id));
});

test('collectOpenItems：折叠噪音与陈旧项，保留人工/实质未决并计数', () => {
    const { state } = setup();
    const result = collectOpenItems(state, { limit: 8 });
    assert.equal(result.total, 5);
    assert.equal(result.visibleCount, 3);
    assert.equal(result.noiseCount, 1);
    assert.equal(result.staleCount, 1);
    assert.equal(result.hiddenCount, 2);
    assert.deepEqual(result.visible.map((item) => item.node.id).sort(), ['n4', 'n5', 'n8'].sort());
});

test('planOpenCleanup：只收敛噪音/陈旧项，保留节点并写清理由', () => {
    const { state, noise, stale, real, explicit, stays } = setup();
    const plan = planOpenCleanup(state, { maxWidth: 9 });
    assert.equal(plan.stats.openBefore, 5);
    assert.equal(plan.stats.noise, 1);
    assert.equal(plan.stats.staleTopic, 1);
    assert.equal(plan.stats.openAfter, 3);

    const byId = new Map(plan.changes.map((change) => [change.id, change]));
    assert.equal(byId.size, 2);
    for (const id of [noise.id, stale.id]) {
        const change = byId.get(id);
        assert.equal(change.action, 'abandon');
        assert.equal(change.status, 'abandoned');
        assert.ok(change.tags.includes(AUTO_CURATED_TAG));
        assert.ok(change.tags.includes('archived'));
        assert.match(change.summary, /自动收敛/);
        assert.ok(change.reason.length > 0);
    }
    assert.ok(byId.get(noise.id).tags.includes(NOISE_TAG));
    assert.ok(byId.get(stale.id).tags.includes(STALE_TOPIC_TAG));
    for (const id of [real.id, explicit.id, stays.id]) assert.ok(!byId.has(id), id);
});

test('question 节点标题不是疑问句时按噪音收敛，即使已有子节点/重复命中', () => {
    const state = createGraphState({ workspaceRoot: '/tmp/hygiene-question', now: NOW });
    const goal = addNode(state, { kind: 'goal', title: '问题卫生', now: NOW });
    const topic = addNode(state, { kind: 'topic', parentId: goal.id, title: '活跃主题', status: 'active', now: NOW });
    const misclassified = addNode(state, {
        kind: 'question', parentId: topic.id, title: 'UpdateNode patch can contain rich fields', origin: 'auto', now: NOW,
    });
    addNode(state, { kind: 'evidence', parentId: misclassified.id, title: 'patch 示例', origin: 'auto', now: NOW });
    misclassified.hits = 2;
    assert.equal(classifyOpenNode(state, state.nodes.get(misclassified.id)).state, 'noise');
    const plan = planOpenCleanup(state);
    assert.ok(plan.changes.some((change) => change.id === misclassified.id && change.action === 'abandon'));
    // 真正的疑问句即使有子节点也不会被误判。
    const real = addNode(state, { kind: 'question', parentId: topic.id, title: 'Should we keep nested details?', origin: 'auto', now: NOW });
    addNode(state, { kind: 'evidence', parentId: real.id, title: '证据', origin: 'auto', now: NOW });
    assert.equal(classifyOpenNode(state, state.nodes.get(real.id)).state, 'current');
});

test('collectOpenItems：非叶根/非人工的嵌套未决折叠为推理细节', () => {
    const { state, real } = setup();
    const nested = addNode(state, {
        kind: 'question', parentId: real.id, title: 'How deep should the detail go?', origin: 'auto', now: NOW,
    });
    const result = collectOpenItems(state, { limit: 8 });
    assert.equal(result.total, 6);
    assert.equal(result.visibleCount, 3);
    assert.equal(result.detailCount, 1);
    assert.equal(result.hiddenCount, 3);
    assert.ok(result.details.some((item) => item.node.id === nested.id));
    assert.ok(!result.visible.some((item) => item.node.id === nested.id));
    assert.equal(isActionableOpenNode(state, state.nodes.get(nested.id)), false);
    assert.equal(isActionableOpenNode(state, state.nodes.get(real.id)), true);
});

test('planOpenCleanup：主题叶根超宽时只隐藏已完成/已放弃叶根，不动 open', () => {
    const { state, goal } = setup();
    const topic = addNode(state, { kind: 'topic', parentId: goal.id, title: '宽主题', status: 'active', now: NOW });
    const openLeaf = addNode(state, { kind: 'question', parentId: topic.id, title: '真正未决：如何拆分主题？', origin: 'auto', now: NOW });
    const doneLeaf = addNode(state, {
        kind: 'conclusion', parentId: topic.id, title: '已完成的结论', status: 'done', origin: 'auto', now: NOW,
    });
    const abandonedLeaf = addNode(state, {
        kind: 'hypothesis', parentId: topic.id, title: '已放弃的假设', status: 'abandoned', origin: 'auto', now: NOW,
    });
    const humanLeaf = addNode(state, {
        kind: 'conclusion', parentId: topic.id, title: '人工完成的结论', status: 'done', origin: 'model', now: NOW,
    });
    const plan = planOpenCleanup(state, { maxWidth: 2 });
    assert.ok(plan.stats.hiddenLeaves >= 1);
    const hidden = plan.changes.filter((change) => change.action === 'hide');
    assert.ok(hidden.some((change) => change.id === doneLeaf.id || change.id === abandonedLeaf.id));
    assert.ok(!hidden.some((change) => change.id === openLeaf.id), 'open 叶根不应被隐藏');
    assert.ok(!hidden.some((change) => change.id === humanLeaf.id), '人工完成项不应因宽度被隐藏');
    for (const change of hidden) assert.ok(change.tags.includes('archived'));
});
