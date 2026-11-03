import assert from 'node:assert/strict';
import test from 'node:test';

import { addNode, createGraphState, linkNodes } from '../../src/core/graph.js';
import {
    computeTeamBoard,
    computeWalk,
    renderTeamBoard,
    renderWalk,
    resolveWalkFocus,
} from '../../src/core/navigate.js';

const NOW = '2026-01-01T00:00:00.000Z';

function state() {
    return createGraphState({ workspaceRoot: 'C:/ws', now: NOW });
}

function buildTopicTree() {
    const graph = state();
    const goal = addNode(graph, { kind: 'goal', title: '缓存性能排查', status: 'active' }, { now: NOW });
    const topic = addNode(graph, {
        parentId: goal.id,
        kind: 'topic',
        title: '缓存命中率',
        status: 'active',
        owner: 'agent-a',
        leaseUntil: '2026-01-01T01:00:00.000Z',
    }, { now: NOW });
    const question = addNode(graph, {
        parentId: topic.id,
        kind: 'question',
        title: '缓存键格式变化是否导致命中率下降？',
        status: 'open',
    }, { now: NOW });
    const hypothesis = addNode(graph, {
        parentId: question.id,
        kind: 'hypothesis',
        title: '键格式变化导致命中率下降',
        status: 'open',
    }, { now: NOW });
    addNode(graph, {
        parentId: hypothesis.id,
        kind: 'evidence',
        title: '命中率从 95% 降到 71%',
        status: 'done',
    }, { now: NOW });
    const other = addNode(graph, {
        parentId: topic.id,
        kind: 'question',
        title: '是否还有其他瓶颈？',
        status: 'open',
    }, { now: NOW });
    return { graph, goal, topic, question, hypothesis, other };
}

test('resolveWalkFocus 优先显式 id，其次会话游标与目标', () => {
    const { graph, goal, topic } = buildTopicTree();
    graph.sessions.set('s1', { goalId: goal.id, activeNodeId: topic.id });
    assert.equal(resolveWalkFocus(graph, { focusId: goal.id, sessionId: 's1' }).id, goal.id);
    assert.equal(resolveWalkFocus(graph, { sessionId: 's1' }).id, topic.id);
    graph.sessions.set('s2', { goalId: goal.id, activeNodeId: null });
    assert.equal(resolveWalkFocus(graph, { sessionId: 's2' }).id, goal.id);
    assert.equal(resolveWalkFocus(graph, {}).id, goal.id);
});

test('computeWalk：路径、子节点、未决叶与下一步都围绕焦点分支', () => {
    const { graph, goal, topic, question, hypothesis, other } = buildTopicTree();
    graph.sessions.set('s1', { goalId: goal.id, activeNodeId: topic.id });
    const result = computeWalk(graph, { sessionId: 's1', limit: 5 });

    assert.equal(result.focus.id, topic.id);
    assert.equal(result.path[0].id, goal.id);
    assert.equal(result.path.at(-1).id, topic.id);
    assert.equal(result.parent.id, goal.id);
    assert.ok(result.children.some((child) => child.id === question.id));
    assert.ok(result.children.some((child) => child.id === other.id));
    assert.ok(result.openLeaves.some((leaf) => leaf.id === hypothesis.id));
    assert.ok(result.openLeaves.some((leaf) => leaf.id === other.id));
    assert.equal(result.next.type, 'descend');
    assert.equal(result.next.targetId, question.id);
    assert.match(result.next.command, /explore_tree action=walk id=n\d+/);
    assert.equal(result.stats.subtreeNodes, 5);
    assert.equal(result.stats.openNodes, 4);

    const text = renderWalk(result);
    assert.match(text, /沿树展开/);
    assert.match(text, /路径：/);
    assert.match(text, /子节点（2）/);
    assert.match(text, /未决叶/);
    assert.match(text, /下一步：descend/);
});

test('computeWalk：开放叶子给出 expand 与按 kind 的 add 模板', () => {
    const { graph, topic } = buildTopicTree();
    const unverified = addNode(graph, {
        parentId: topic.id,
        kind: 'hypothesis',
        title: '未验证的候选解释',
        status: 'open',
    }, { now: NOW });
    const result = computeWalk(graph, { focusId: unverified.id, limit: 5 });

    assert.equal(result.focus.id, unverified.id);
    assert.equal(result.next.type, 'expand');
    assert.equal(result.next.targetId, unverified.id);
    assert.ok(result.next.expansions.some((item) => item.kind === 'evidence'));
    assert.ok(result.next.expansions.some((item) => item.kind === 'dead_end'));
    assert.ok(result.gaps.some((gap) => gap.code === 'HYPOTHESIS_NO_EVIDENCE'));
    assert.match(renderWalk(result), /可添加：/);
});

test('computeWalk：关闭焦点不强行展开，转向最近的开放兄弟', () => {
    const { graph, topic } = buildTopicTree();
    const closed = addNode(graph, {
        parentId: topic.id,
        kind: 'question',
        title: '已经回答的问题',
        status: 'done',
    }, { now: NOW });
    const open = addNode(graph, {
        parentId: topic.id,
        kind: 'question',
        title: '仍需回答的问题',
        status: 'open',
    }, { now: NOW });
    const result = computeWalk(graph, { focusId: closed.id, limit: 5 });

    assert.equal(result.focus.status, 'done');
    assert.equal(result.next.type, 'branch');
    assert.equal(graph.nodes.get(result.next.targetId).status, 'open');
    assert.match(result.next.reason, /未决兄弟/);
});

test('computeWalk：主题超宽给出 TOPIC_WIDE 与 split 建议（焦点在子树内也算主题宽度）', () => {
    const { graph, topic, hypothesis } = buildTopicTree();
    const result = computeWalk(graph, { focusId: hypothesis.id, limit: 5, maxWidth: 2 });

    assert.ok(result.gaps.some((gap) => gap.code === 'TOPIC_WIDE'));
    const split = result.suggestions.find((item) => item.type === 'split');
    assert.ok(split, '应建议拆分过宽主题');
    assert.match(split.reason, /直接子节点 \d+/);
});

test('computeWalk：空图给出 seed，且不抛错', () => {
    const result = computeWalk(state(), {});
    assert.equal(result.focus, null);
    assert.equal(result.next.type, 'seed');
    assert.equal(result.path.length, 0);
    assert.match(renderWalk(result), /研究图为空/);
});

test('computeTeamBoard：树侧租约与真实 Agent Teams 任务合并，且不复制任务板', () => {
    const graph = state();
    const goal = addNode(graph, { kind: 'goal', title: '多 agent 协作', status: 'active' }, { now: NOW });
    const mine = addNode(graph, {
        parentId: goal.id,
        kind: 'topic',
        title: '缓存命中率',
        status: 'active',
        owner: 'agent-a',
        leaseUntil: '2026-01-01T01:00:00.000Z',
        priority: 'P1',
    }, { now: NOW });
    addNode(graph, { parentId: mine.id, kind: 'question', title: '键格式是否影响命中率？', status: 'open' }, { now: NOW });
    addNode(graph, { parentId: mine.id, kind: 'hypothesis', title: '键格式变化导致命中率下降', status: 'open' }, { now: NOW });
    const unowned = addNode(graph, {
        parentId: goal.id,
        kind: 'topic',
        title: '未认领主题',
        status: 'active',
    }, { now: NOW });
    addNode(graph, { parentId: unowned.id, kind: 'question', title: '谁来做这个主题？', status: 'open' }, { now: NOW });
    const expired = addNode(graph, {
        parentId: goal.id,
        kind: 'topic',
        title: '过期租约主题',
        status: 'active',
        owner: 'agent-b',
        leaseUntil: '2025-12-31T23:00:00.000Z',
    }, { now: NOW });
    addNode(graph, { parentId: expired.id, kind: 'question', title: '过期主题还能继续吗？', status: 'open' }, { now: NOW });
    const other = addNode(graph, {
        parentId: goal.id,
        kind: 'topic',
        title: '他人的活跃主题',
        status: 'active',
        owner: 'agent-b',
        leaseUntil: '2026-01-01T02:00:00.000Z',
    }, { now: NOW });
    addNode(graph, { parentId: other.id, kind: 'question', title: '他人主题的未决问题？', status: 'open' }, { now: NOW });
    addNode(graph, {
        parentId: goal.id,
        kind: 'topic',
        title: '已完成主题',
        status: 'done',
    }, { now: NOW });

    const linkedTask = {
        id: 'task-1',
        revision: 2,
        subject: '认领未认领主题',
        description: '[explore-tree:' + unowned.id + ']\n先补齐证据',
        status: 'in_progress',
        ownerName: 'agent-b',
        blockedBy: [],
        writeScopes: [],
        ready: true,
        writeScopeWarnings: [],
    };
    const unlinkedTask = {
        id: 'task-2',
        revision: 1,
        subject: '与树无关的 Team 任务',
        description: '独立任务',
        status: 'pending',
        blockedBy: [],
        writeScopes: [],
        ready: true,
        writeScopeWarnings: [],
    };
    const board = computeTeamBoard(graph, {
        actor: 'agent-a',
        now: Date.parse(NOW),
        maxWidth: 2,
        team: {
            available: true,
            members: [{ name: 'lead', role: 'lead', status: 'running' }, { name: 'agent-b', role: 'teammate', status: 'inactive' }],
            tasks: [linkedTask, unlinkedTask, { ...unlinkedTask, id: 'task-3', status: 'deleted' }],
        },
    });
    assert.equal(board.actor, 'agent-a');
    assert.deepEqual(board.mine.map((item) => item.id), [mine.id]);
    assert.deepEqual(board.unowned.map((item) => item.id), [unowned.id]);
    assert.deepEqual(board.expired.map((item) => item.id), [expired.id]);
    assert.deepEqual(board.others.map((item) => item.id), [other.id]);
    assert.ok(board.claimable.some((item) => item.id === unowned.id));
    assert.ok(board.claimable.some((item) => item.id === expired.id));
    assert.equal(board.stats.topics, 4);
    assert.ok(board.suggestions.some((item) => item.type === 'claim'));
    assert.ok(board.suggestions.some((item) => item.type === 'split' && item.targetId === mine.id));

    assert.equal(board.team.available, true);
    assert.equal(board.team.tasks.length, 2, 'deleted 任务不进入视图');
    assert.equal(board.team.linked.length, 1);
    assert.equal(board.team.linked[0].nodeId, unowned.id);
    assert.equal(board.team.linked[0].node.title, '未认领主题');
    assert.equal(board.team.linked[0].ownerName, 'agent-b');
    assert.equal(board.team.unlinked.length, 1);
    assert.equal(board.stats.teamTasks, 2);
    assert.equal(board.stats.teamActive, 2);
    assert.ok(board.taskSuggestions.some((entry) => entry.targetId === expired.id), '未关联主题应给出可发布任务');
    assert.ok(!board.taskSuggestions.some((entry) => entry.targetId === unowned.id), '已有 Team 任务的主题不重复建议');
    assert.match(board.taskSuggestions.find((entry) => entry.targetId === expired.id).command, /team_task_create/);

    const text = renderTeamBoard(board);
    assert.match(text, /研究轨迹 × Agent Teams/);
    assert.match(text, /成员 2/);
    assert.match(text, /已关联任务（1）/);
    assert.match(text, /未关联任务（1）/);
    assert.match(text, /可发布为 Team 任务/);
    assert.match(text, /my-agent|team_task_create/);
    assert.ok(!text.includes('任务草案'), '不应再生成第二套任务草案');
});

test('computeTeamBoard：没有 Agent Teams 时降级为树侧租约，不伪造任务', () => {
    const graph = state();
    const goal = addNode(graph, { kind: 'goal', title: '目标', status: 'active' }, { now: NOW });
    const topic = addNode(graph, { parentId: goal.id, kind: 'topic', title: '待认领主题', status: 'active' }, { now: NOW });
    const board = computeTeamBoard(graph, { now: Date.parse(NOW) });
    assert.equal(board.actor, null);
    assert.equal(board.mine.length, 0);
    assert.equal(board.team.available, false);
    assert.equal(board.team.tasks.length, 0);
    assert.equal(board.taskSuggestions.length, 0);
    assert.ok(board.unowned.some((item) => item.id === topic.id));
    const text = renderTeamBoard(board);
    assert.match(text, /Agent Teams：未接入/);
    assert.match(text, /待认领/);
    assert.ok(!text.includes('可发布为 Team 任务'));
});

test('computeTeamBoard：空图提示先建 topic', () => {
    const board = computeTeamBoard(state(), { actor: 'agent-a' });
    assert.equal(board.stats.topics, 0);
    assert.match(renderTeamBoard(board), /还没有 topic/);
});
