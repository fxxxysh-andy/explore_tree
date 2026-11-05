import test from 'node:test';
import assert from 'node:assert/strict';

import { addNode, createGraphState } from '../../src/core/graph.js';
import {
    formatDigest,
    inferCloseReason,
    isStrongOpenNode,
    isToolNoise,
    isTrueDeadEnd,
    phaseOf,
    statusDigest,
} from '../../src/core/status.js';

const NOW = '2026-11-03T00:00:00.000Z';

test('phaseOf：每个节点只落一个展示阶段', () => {
    const cases = [
        [{ kind: 'question', status: 'open' }, 'todo'],
        [{ kind: 'hypothesis', status: 'active' }, 'todo'],
        [{ kind: 'decision', status: 'open' }, 'todo'],
        [{ kind: 'decision', status: 'done' }, 'recorded'],
        [{ kind: 'goal', status: 'active' }, 'doing'],
        [{ kind: 'topic', status: 'active' }, 'doing'],
        [{ kind: 'step', status: 'active' }, 'doing'],
        [{ kind: 'evidence', status: 'open' }, 'recorded'],
        [{ kind: 'note', status: 'done' }, 'recorded'],
        [{ kind: 'step', status: 'done' }, 'completed'],
        [{ kind: 'action', status: 'abandoned' }, 'aborted'],
        [{ kind: 'goal', status: 'done' }, 'closed'],
        [{ kind: 'topic', status: 'done' }, 'closed'],
        [{ kind: 'dead_end', status: 'abandoned' }, 'dead_end'],
        [{ kind: 'dead_end', status: 'done' }, 'dead_end'],
        [{ kind: 'dead_end', status: 'abandoned', title: '失败：run_code' }, 'tool_noise'],
        [{ kind: 'dead_end', status: 'abandoned', title: '轮次中断：旧图' }, 'tool_noise'],
        [{ kind: 'question', status: 'abandoned', tags: ['auto-curated'] }, 'curated'],
        [{ kind: 'question', status: 'abandoned', tags: ['merged-into'] }, 'merged'],
        [{ kind: 'decision', status: 'done', tags: ['auto-curated'] }, 'recorded'],
    ];
    for (const [node, expected] of cases) {
        assert.equal(phaseOf(node), expected, JSON.stringify(node));
    }
    assert.equal(phaseOf(null), 'aborted');
});

test('isTrueDeadEnd：排除工具失败、合并与自动收敛', () => {
    assert.equal(isTrueDeadEnd({ kind: 'dead_end', status: 'abandoned', title: '接口不通' }), true);
    assert.equal(isTrueDeadEnd({ kind: 'dead_end', status: 'open', title: '尚未标记的坑' }), true);
    assert.equal(isTrueDeadEnd({ kind: 'dead_end', status: 'abandoned', title: '失败：run_code' }), false);
    assert.equal(isTrueDeadEnd({ kind: 'dead_end', status: 'abandoned', title: '历史工具失败（已合并 6 条）' }), false);
    assert.equal(isTrueDeadEnd({ kind: 'dead_end', status: 'abandoned', tags: ['merged-into'] }), false);
    assert.equal(isTrueDeadEnd({ kind: 'dead_end', status: 'abandoned', tags: ['auto-curated'] }), false);
    assert.equal(isTrueDeadEnd({ kind: 'question', status: 'abandoned' }), false);
    assert.equal(isToolNoise({ title: '失败：edit' }), true);
    assert.equal(inferCloseReason({ kind: 'dead_end', status: 'abandoned', title: '接口不通' }), 'dead_end');
});

test('statusDigest：六主桶 + 尾桶对账，强/弱与折叠一致', () => {
    const state = createGraphState({ workspaceRoot: '/tmp/status-test', now: NOW });
    const goal = addNode(state, { kind: 'goal', title: '目标', status: 'active' }, { now: NOW });
    const topic = addNode(state, { kind: 'topic', parentId: goal.id, title: '主题', status: 'active' }, { now: NOW });
    const modelQ = addNode(state, { kind: 'question', parentId: topic.id, title: '是否保留待办列表？', origin: 'model' }, { now: NOW });
    const autoQ = addNode(state, { kind: 'question', parentId: topic.id, title: '是否应该增加缓存层？', origin: 'auto' }, { now: NOW });
    addNode(state, { kind: 'evidence', parentId: autoQ.id, title: '压测结果', status: 'done' }, { now: NOW });
    addNode(state, { kind: 'question', parentId: topic.id, title: 'Let me read the README first.', origin: 'auto' }, { now: NOW });
    const closedTopic = addNode(state, { kind: 'topic', parentId: goal.id, title: '旧主题', status: 'done' }, { now: NOW });
    addNode(state, { kind: 'hypothesis', parentId: closedTopic.id, title: 'Read the docs before deciding.', origin: 'auto' }, { now: NOW });
    addNode(state, { kind: 'dead_end', parentId: topic.id, title: '接口不通', status: 'abandoned' }, { now: NOW });
    addNode(state, { kind: 'dead_end', parentId: topic.id, title: '失败：run_code', status: 'abandoned' }, { now: NOW });
    addNode(state, { kind: 'evidence', parentId: topic.id, title: '已记录证据', status: 'done' }, { now: NOW });
    addNode(state, { kind: 'step', parentId: goal.id, title: '已走步骤', status: 'done' }, { now: NOW });
    addNode(state, { kind: 'step', parentId: goal.id, title: '中断步骤', status: 'abandoned' }, { now: NOW });
    addNode(state, { kind: 'question', parentId: topic.id, title: '自动收敛旁白', status: 'abandoned', tags: ['auto-curated'] }, { now: NOW });
    addNode(state, { kind: 'question', parentId: topic.id, title: '已合并问题', status: 'abandoned', tags: ['merged-into'] }, { now: NOW });
    addNode(state, { kind: 'goal', title: '已关闭目标', status: 'done' }, { now: NOW });

    const digest = statusDigest(state);
    assert.equal(digest.reconciled, true, JSON.stringify(digest.buckets));
    assert.equal(digest.total, state.nodes.size);
    assert.equal(digest.todo.total, 4);
    assert.equal(digest.todo.visible, 2);
    assert.equal(digest.todo.hidden, 2);
    assert.equal(digest.todo.strong, 2);
    assert.equal(digest.todo.weak, 0);
    assert.equal(digest.doing, 2);
    assert.equal(digest.recorded, 2);
    assert.equal(digest.completed, 1);
    assert.equal(digest.closed, 2);
    assert.equal(digest.deadEnd, 1);
    assert.equal(digest.settled.toolNoise, 1);
    assert.equal(digest.settled.curated, 1);
    assert.equal(digest.settled.merged, 1);
    assert.equal(digest.settled.aborted, 1);
    assert.equal(digest.main, digest.todo.visible);
    assert.equal(isStrongOpenNode(state, modelQ), true);
    assert.equal(isStrongOpenNode(state, autoQ), true);
    assert.match(formatDigest(digest), /待办 2 · 全图（共 4；强 2 \/ 自动 0；折叠 2）/);
});

test('P1：显式 closeReason 优先，solved 问题进入已关闭、dead_end 进入真死路', () => {
    assert.equal(inferCloseReason({ kind: 'question', status: 'done', closeReason: 'solved' }), 'solved');
    assert.equal(phaseOf({ kind: 'question', status: 'done', closeReason: 'solved' }), 'closed');
    assert.equal(phaseOf({ kind: 'hypothesis', status: 'done', closeReason: 'solved' }), 'closed');
    assert.equal(isTrueDeadEnd({ kind: 'question', status: 'done', closeReason: 'dead_end' }), true);
    assert.equal(phaseOf({ kind: 'hypothesis', status: 'done', closeReason: 'dead_end' }), 'dead_end');
    assert.equal(phaseOf({ kind: 'question', status: 'abandoned', closeReason: 'curated' }), 'curated');
    // 记录类即使被标成 aborted 也先落「已记录」，避免记录被当成中断噪音。
    assert.equal(phaseOf({ kind: 'evidence', status: 'done', closeReason: 'aborted' }), 'recorded');
    // 合并是结构事实，优先于显式 closeReason。
    assert.equal(phaseOf({ kind: 'question', status: 'abandoned', closeReason: 'dead_end', tags: ['merged-into'] }), 'merged');
    assert.equal(isTrueDeadEnd({ kind: 'dead_end', status: 'done', closeReason: 'recorded' }), false);
});

test('statusDigest：sessionId 过滤与 scope 文案', () => {
    const state = createGraphState({ workspaceRoot: '/tmp/status-scope', now: NOW });
    addNode(state, { kind: 'question', title: '本会话问题', sessionId: 's1' }, { now: NOW });
    addNode(state, { kind: 'question', title: '别的会话问题', sessionId: 's2' }, { now: NOW });

    const scoped = statusDigest(state, { sessionId: 's1' });
    assert.equal(scoped.scope, 'session');
    assert.equal(scoped.total, 1);
    assert.equal(scoped.todo.total, 1);
    assert.match(formatDigest(scoped), /本会话/);
    assert.doesNotMatch(formatDigest(scoped), /别的会话问题/);

    const workspace = statusDigest(state);
    assert.equal(workspace.scope, 'workspace');
    assert.equal(workspace.total, 2);
    assert.match(formatDigest(workspace), /全图/);
    assert.equal(statusDigest(state, { sessionId: 'missing' }).total, 0);
});
