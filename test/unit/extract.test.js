import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ResearchExtractor, classifySectionKind, classifyThought, conclusionTitle, looksLikeConclusion, scoreThought, splitAnswerSections, splitThoughts, summarizeArgs, thoughtSource, thoughtTitle, titleFromText } from '../../src/core/extract.js';
import { WorkspaceGraphStore } from '../../src/core/store.js';

function setup(t) {
    return setupWithConfig(t);
}

function setupWithConfig(t, config, logger) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-extract-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    const extractor = new ResearchExtractor({
        store,
        ...(config === undefined ? {} : { config }),
        logger: logger ?? { warn: () => {}, error: () => {} },
    });
    return { root, store, extractor };
}

const SESSION = 's1';

test('titleFromText/looksLikeConclusion 规则', () => {
    assert.equal(titleFromText('## 分析缓存命中问题\n\n后续细节'), '分析缓存命中问题');
    assert.equal(looksLikeConclusion('太短'), false);
    assert.equal(looksLikeConclusion('分析了一圈没有结论'), false);
    assert.equal(looksLikeConclusion('\n结论：前缀必须保持稳定，所以动态状态不能写入系统提示。'), true);
    assert.equal(conclusionTitle('\n结论：前缀必须保持稳定。后续细节'), '前缀必须保持稳定');
    assert.ok(summarizeArgs({ query: 'abc', timeoutMs: 5000 }).includes('abc'));
    assert.ok(!summarizeArgs({ query: 'abc', timeoutMs: 5000 }).includes('timeoutMs'));
});

test('splitThoughts：按段落/列表切分，剔除代码块，长度上限生效', () => {
    const text = [
        '先看文档，确认插件入口。',
        '',
        '- 假设：前缀稳定取决于工具面',
        '1. 观察：缓存命中率在 90% 以上',
        '',
        '```js',
        'const hidden = 1;',
        '```',
        '最后检查 webServer 路由。',
    ].join('\n');
    const units = splitThoughts(text, { minChars: 6, maxChars: 40, maxUnits: 4 });
    assert.equal(units.length, 4);
    assert.ok(!units.some((unit) => unit.includes('hidden')), '代码块不应变成想法');
    assert.ok(units.some((unit) => unit.includes('假设')));
    assert.ok(units.every((unit) => unit.length <= 40));
});

test('classifyThought/thoughtTitle：只按句式线索分类，不判对错', () => {
    assert.equal(classifyThought('是否应该把推理也写进树？'), 'question');
    assert.equal(classifyThought('假设缓存失配是因为工具顺序变化'), 'hypothesis');
    assert.equal(classifyThought('这个方案行不通，必须换一条路'), 'dead_end');
    assert.equal(classifyThought('因为快照里没有该节点，所以前端拿不到图'), 'evidence');
    assert.equal(classifyThought('决定先修渲染再补数据'), 'decision');
    assert.equal(classifyThought('结论：推理才是主要信号'), 'conclusion');
    assert.equal(classifyThought('树有一百多个节点'), 'note');
    assert.equal(thoughtTitle('## 先确认工具面'), '先确认工具面');
});

test('scoreThought：过程旁白扣分，决定/证据/失败加分', () => {
    assert.ok(scoreThought('Let me run npm test and check the output') < 2);
    assert.ok(scoreThought('Remaining tasks: fix the client bundle') < 2);
    assert.ok(scoreThought('决定改用卡片树布局，因为层级更深时列表不可读') >= 2);
    assert.ok(scoreThought('失败：conversation.view 在无会话时不会渲染，所以需要全局入口') >= 2);
    assert.ok(scoreThought('结论：推理链才是主要信号', 'conclusion') >= 2);
    assert.ok(scoreThought('短句') < 2);
});

test('scoreThought：英文/数学推理按信息量给分，不按语言扣分', () => {
    assert.ok(scoreThought('The matrix can be written as A = D + 11^T.') >= 2, '结构观察应保留');
    assert.ok(scoreThought('This is a classic problem. Let me solve it.') < 1, '过程旁白应过滤');
    assert.ok(scoreThought('Case 2: at least two a_i are zero, so D is singular.') >= 2, '分支展开应保留');
    assert.ok(scoreThought('A^{-1} = D^{-1} - D^{-1}11^TD^{-1}/(1+1^TD^{-1}1).') >= 1, '公式推导应保留');
});

test('splitThoughts：公式续行并回上一段，不产生孤立碎片', () => {
    const text = [
        '$$A = D + \\mathbf{1}\\mathbf{1}^T$$',
        '',
        'is invertible, and find its inverse when invertible.',
        '',
        'Case 1: All $a_i \\neq 0$.',
        '',
        'Then $D$ is invertible.',
    ].join('\n');
    const units = splitThoughts(text, { minChars: 8, maxChars: 400, maxUnits: 12, minScore: -10 });
    assert.ok(units.length >= 1);
    assert.ok(!units.some((unit) => /^is invertible/i.test(unit.trim())), '续行不应单独成节点');
    assert.ok(units.some((unit) => unit.includes('$$A = D') && unit.includes('is invertible')), '公式与续行应合并');
});

test('splitThoughts：低分旁白被过滤，有内容的句子保留', () => {
    const text = [
        'Let me run npm test to verify the build.',
        '',
        'The matrix can be written as A = D + 11^T, where D = diag(a_i).',
    ].join('\n');
    const units = splitThoughts(text, { minChars: 8, maxChars: 400, maxUnits: 8, minScore: 1 });
    assert.ok(units.length >= 1);
    assert.ok(units.some((unit) => unit.includes('diag')), '有信息量的推导应保留');
    assert.ok(!units.some((unit) => /^Let me/.test(unit)), '过程旁白应被过滤');
});

test('thoughtSource：超长推理取头尾，中间注明省略', () => {
    const text = `HEAD-${'x'.repeat(500)}-MIDDLE-${'y'.repeat(500)}-TAIL`;
    const source = thoughtSource(text, 120);
    assert.ok(source.startsWith('HEAD-'));
    assert.ok(source.endsWith('TAIL'));
    assert.ok(source.includes('中间推理省略'));
    assert.ok(source.length <= 160);
});

test('自动提取写入带 actor，journal 可审计', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '审计自动提取归属' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    const goal = [...store.state.nodes.values()].find((node) => node.kind === 'goal');
    const step = [...store.state.nodes.values()].find((node) => node.kind === 'step');
    assert.equal(goal.createdBy, 'extractor');
    assert.equal(goal.updatedBy, 'extractor');
    assert.equal(step.createdBy, 'extractor');
    await extractor.handle({
        type: 'assistant.reasoning',
        sessionId: SESSION,
        turn: 1,
        text: '决定：自动提取节点必须带 actor，否则写域审计无法区分系统与 agent。',
    });
    assert.ok([...store.state.nodes.values()].every((node) => node.createdBy === 'extractor'));
});

test('turn/start 重复投递时只建一个 step', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '重复轮次开始' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    const steps = [...store.state.nodes.values()].filter((node) => node.kind === 'step');
    assert.equal(steps.length, 1);
});

test('推理里的关键想法有层级：假设下的证据挂到假设节点', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '研究图要取关键节点' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({
        type: 'assistant.reasoning',
        sessionId: SESSION,
        turn: 1,
        text: '假设：工具调用聚合后仍会丢信息，因为失败路径需要单独保留。\n\n证据：live 图里 note 有 53 个，说明旁白没有被过滤。',
    });
    const nodes = [...store.state.nodes.values()];
    const hypothesis = nodes.find((node) => node.kind === 'hypothesis');
    const evidence = nodes.find((node) => node.kind === 'evidence');
    assert.ok(hypothesis, '关键假设要成为节点');
    assert.ok(evidence, '证据句要成为节点');
    assert.equal(evidence.parentId, hypothesis.id, '证据应挂在假设下，形成多层树');
});

test('低于 minThoughtScore 的推理片段不建节点', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '只保留有信息量的想法' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({
        type: 'assistant.reasoning',
        sessionId: SESSION,
        turn: 1,
        text: 'Let me run npm test to verify the build. I need to check package.json.',
    });
    const nodes = [...store.state.nodes.values()];
    const step = nodes.find((node) => node.kind === 'step');
    assert.ok(step, '轮次步骤仍应创建');
    assert.equal(nodes.filter((node) => node.parentId === step.id).length, 0, '过程旁白不应变成想法节点');
});
test('推理链切出的想法成为 step 下的节点，重复只加 hits', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '研究图应该以推理为主' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    const reasoning = '假设：工具调用只是旁证，真正的研究轨迹在推理里，因为用户明确说重要信息优先。\n\n决定：先验证想法节点会不会重复，再写测试。';
    await extractor.handle({ type: 'assistant.reasoning', sessionId: SESSION, turn: 1, text: reasoning });

    let state = store.state;
    const step = [...state.nodes.values()].find((node) => node.kind === 'step');
    const thoughts = [...state.nodes.values()].filter((node) => node.parentId === step.id);
    assert.equal(thoughts.length, 2);
    assert.ok(thoughts.some((node) => node.kind === 'hypothesis'));
    assert.ok(thoughts.some((node) => node.kind === 'decision'));

    // 同样的推理再来一次：不重复造节点，只累计 hits。
    await extractor.handle({ type: 'assistant.reasoning', sessionId: SESSION, turn: 1, text: reasoning });
    state = store.state;
    const after = [...state.nodes.values()].filter((node) => node.parentId === step.id);
    assert.equal(after.length, 2);
    assert.ok(after.every((node) => node.hits >= 2));
});

test('单轮想法节点数受 maxThoughtNodesPerTurn 约束', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-extract-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    const extractor = new ResearchExtractor({
        store,
        config: { maxThoughtNodesPerTurn: 2, maxThoughtUnitsPerBlock: 5, minThoughtChars: 4 },
        logger: { warn: () => {}, error: () => {} },
    });
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '一次很长的思考' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({
        type: 'assistant.reasoning',
        sessionId: SESSION,
        turn: 1,
        text: '决定先观察目录结构，因为入口在 src/index.js。\n\n决定再检查 src/host/service.js 的路由注册。\n\n决定最后确认工具注册在 src/host/tools.js。\n\n决定验证面板槽位在 lib/client.js。',
    });
    const step = [...store.state.nodes.values()].find((node) => node.kind === 'step');
    const thoughts = [...store.state.nodes.values()].filter((node) => node.parentId === step.id);
    assert.equal(thoughts.length, 2);
});

test('一轮会话自动生成 goal → step → action → conclusion', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'session.start', sessionId: SESSION });
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '研究 DSH 插件如何保持前缀缓存命中', messageId: 'm1' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1, text: '研究 DSH 插件如何保持前缀缓存命中' });
    await extractor.handle({ type: 'assistant.reasoning', sessionId: SESSION, turn: 1, text: '关键问题：工具面是否固定？因为前缀缓存依赖系统提示保持不变。' });
    await extractor.handle({ type: 'tool.start', sessionId: SESSION, turn: 1, callId: 'c1', toolName: 'read', args: { path: 'docs/design.md' } });
    await extractor.handle({ type: 'tool.end', sessionId: SESSION, turn: 1, callId: 'c1', toolName: 'read', ok: true, result: '设计文档内容', artifacts: [{ kind: 'file', value: 'out/report.md' }] });
    await extractor.handle({ type: 'assistant.message', sessionId: SESSION, turn: 1, text: '\n结论：工具面固定且系统提示纯静态，前缀就可以稳定命中缓存。' });
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1, text: '\n结论：工具面固定且系统提示纯静态，前缀就可以稳定命中缓存。' });

    const state = store.state;
    const nodes = [...state.nodes.values()];
    const kinds = nodes.map((node) => node.kind).sort();
    // 句级切分后「关键问题…？因为…」拆成 question + evidence（evidence 挂在 question 下）
    assert.deepEqual(kinds, ['action', 'artifact', 'conclusion', 'evidence', 'goal', 'question', 'step']);
    const goal = nodes.find((node) => node.kind === 'goal');
    const step = nodes.find((node) => node.kind === 'step');
    const action = nodes.find((node) => node.kind === 'action');
    const conclusion = nodes.find((node) => node.kind === 'conclusion');
    const thought = nodes.find((node) => node.kind === 'question');
    const evidenceNode = nodes.find((node) => node.kind === 'evidence');
    assert.equal(goal.parentId, null);
    assert.equal(step.parentId, goal.id);
    assert.equal(action.parentId, step.id);
    assert.equal(thought.parentId, step.id);
    assert.equal(evidenceNode.parentId, thought.id, '证据挂在它支撑的假设/问题下');
    assert.match(thought.summary, /工具面是否固定/);
    assert.equal(conclusion.parentId, step.id);
    assert.equal(action.status, 'done');
    assert.match(action.title, /^工具调用 ×1/);
    assert.match(action.summary, /read ×1/);
    const artifact = nodes.find((node) => node.kind === 'artifact');
    assert.equal(artifact.parentId, step.id, '产物直接挂在 step 下，不挂在动作节点下');
    const session = state.sessions.get(SESSION);
    assert.equal(session.goalId, goal.id);
    assert.equal(session.turn, 1);
    assert.equal(session.activeNodeId, step.id);
});

test('默认聚合模式：一轮多个工具调用只留一个汇总节点', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '查同一个问题' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    for (const callId of ['c1', 'c2']) {
        await extractor.handle({ type: 'tool.start', sessionId: SESSION, turn: 1, callId, toolName: 'web_search', args: { queries: ['cache prefix'] } });
        await extractor.handle({ type: 'tool.end', sessionId: SESSION, turn: 1, callId, toolName: 'web_search', ok: true, result: '结果' });
    }
    await extractor.handle({ type: 'tool.start', sessionId: SESSION, turn: 1, callId: 'c3', toolName: 'read', args: { path: 'a.md' } });
    let actions = [...store.state.nodes.values()].filter((node) => node.kind === 'action');
    assert.equal(actions.length, 1, '默认不再为每次调用建节点');
    assert.equal(actions[0].title, '工具调用（本轮）', '轮内标题保持稳定，不随调用次数重写');
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1 });
    actions = [...store.state.nodes.values()].filter((node) => node.kind === 'action');
    assert.match(actions[0].title, /工具调用 ×3/);
    assert.match(actions[0].summary, /web_search ×2/);
    assert.match(actions[0].summary, /read ×1/);
    assert.equal(actions[0].parentId, [...store.state.nodes.values()].find((node) => node.kind === 'step').id);
});

test('聚合动作节点一轮只写一次：轮内不更新，轮末定稿标题/摘要', async (t) => {
    const { store, extractor } = setup(t);
    let actionId = null;
    let actionUpdates = 0;
    const originalApply = store.apply.bind(store);
    store.apply = async (op) => {
        const result = await originalApply(op);
        if (op?.t === 'addNode' && op.node?.kind === 'action' && actionId === null) actionId = result.node.id;
        if (op?.t === 'updateNode' && actionId !== null && op.id === actionId) actionUpdates += 1;
        return result;
    };
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '减少聚合节点 churn' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    for (let index = 0; index < 10; index += 1) {
        const callId = `c${index}`;
        await extractor.handle({ type: 'tool.start', sessionId: SESSION, turn: 1, callId, toolName: 'read', args: { path: `${index}.md` } });
        await extractor.handle({ type: 'tool.end', sessionId: SESSION, turn: 1, callId, toolName: 'read', ok: true, result: 'x' });
    }
    assert.equal(actionId === null, false, '已创建聚合节点');
    assert.equal(actionUpdates, 0, '轮内不重写聚合节点');
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1 });
    assert.equal(actionUpdates, 1, '轮末只写一次');
    const action = store.state.nodes.get(actionId);
    assert.match(action.title, /工具调用 ×10/);
    assert.match(action.summary, /read ×10/);
});

test('toolCallMode=nodes 时保留逐调用节点（旧行为可切回）', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-extract-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    const extractor = new ResearchExtractor({ store, config: { toolCallMode: 'nodes' }, logger: { warn: () => {}, error: () => {} } });
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '逐调用记录' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    for (const callId of ['c1', 'c2']) {
        await extractor.handle({ type: 'tool.start', sessionId: SESSION, turn: 1, callId, toolName: 'read', args: { path: 'a.md' } });
        await extractor.handle({ type: 'tool.end', sessionId: SESSION, turn: 1, callId, toolName: 'read', ok: true, result: 'x' });
    }
    const actions = [...store.state.nodes.values()].filter((node) => node.kind === 'action');
    assert.equal(actions.length, 1, '同参数调用在 nodes 模式下仍按指纹合并');
    assert.equal(actions[0].hits, 2);
});

test('工具失败记录 abandoned 动作与 dead_end', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '尝试一个会失败的命令' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({ type: 'tool.start', sessionId: SESSION, turn: 1, callId: 'c1', toolName: 'bash', args: { command: 'bad' } });
    await extractor.handle({ type: 'tool.end', sessionId: SESSION, turn: 1, callId: 'c1', toolName: 'bash', ok: false, error: 'command not found' });
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1, aborted: true, error: 'command not found' });
    const state = store.state;
    const action = [...state.nodes.values()].find((node) => node.kind === 'action');
    const deadEnd = [...state.nodes.values()].find((node) => node.kind === 'dead_end');
    const step = [...state.nodes.values()].find((node) => node.kind === 'step');
    assert.equal(action.status, 'abandoned');
    assert.equal(deadEnd.parentId, step.id, '失败直接挂在 step 下，避免动作节点套娃');
    assert.match(deadEnd.summary, /command not found/);
});

test('插件自身工具不记录；轮次中断标 abandoned', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '忽略插件自身调用' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({ type: 'tool.start', sessionId: SESSION, turn: 1, callId: 'c1', toolName: 'explore_tree', args: { action: 'overview' } });
    await extractor.handle({ type: 'tool.end', sessionId: SESSION, turn: 1, callId: 'c1', toolName: 'explore_tree', ok: true, result: '图' });
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1, aborted: true, error: '用户取消' });
    const nodes = [...store.state.nodes.values()];
    assert.equal(nodes.filter((node) => node.kind === 'action').length, 0);
    assert.equal(nodes.find((node) => node.kind === 'step').status, 'abandoned');
});

test('轮次中途接入（无 goal/step）时动作挂到补建的容器 step 下', async (t) => {
    const { store, extractor } = setup(t);
    // 插件安装晚于本轮的 user.message/turn.start，只会先收到 tool.start。
    await extractor.handle({ type: 'tool.start', sessionId: SESSION, turn: 1, callId: 'c1', toolName: 'read', args: { path: 'a.md' } });
    await extractor.handle({ type: 'tool.end', sessionId: SESSION, turn: 1, callId: 'c1', toolName: 'read', ok: true, result: '内容' });
    await extractor.handle({ type: 'tool.start', sessionId: SESSION, turn: 1, callId: 'c2', toolName: 'grep', args: { pattern: 'x' } });

    let nodes = [...store.state.nodes.values()];
    let steps = nodes.filter((node) => node.kind === 'step');
    let actions = nodes.filter((node) => node.kind === 'action');
    assert.equal(steps.length, 1, '只补建一个容器 step');
    assert.equal(actions.length, 1, '聚合模式：只留一个汇总动作节点');
    assert.equal(actions[0].parentId, steps[0].id);
    assert.equal(actions[0].title, '工具调用（本轮）');
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1 });
    nodes = [...store.state.nodes.values()];
    steps = nodes.filter((node) => node.kind === 'step');
    actions = nodes.filter((node) => node.kind === 'action');
    assert.match(actions[0].title, /工具调用 ×2/);
    assert.equal(steps[0].parentId, null);
    assert.match(steps[0].title, /缺少开始事件|接入前/);
    // 后续真正收到 user.message/turn.start 时，新 goal/step 正常建立，旧容器不受影响。
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '下一轮的问题' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 2 });
    await extractor.handle({ type: 'tool.start', sessionId: SESSION, turn: 2, callId: 'c3', toolName: 'read', args: { path: 'b.md' } });
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 2 });
    const after = [...store.state.nodes.values()];
    const goals = after.filter((node) => node.kind === 'goal');
    assert.equal(goals.length, 1);
    const turn2Step = after.find((node) => node.kind === 'step' && node.parentId === goals[0].id && node.turn === 2);
    assert.ok(turn2Step);
    const turn2Action = after.find((node) => node.kind === 'action' && node.parentId === turn2Step.id);
    assert.ok(turn2Action, '第 2 轮工具调用挂到新 step 下');
    assert.match(turn2Action.title, /工具调用 ×1/);
});
test('有 goal 但缺少 turn.start 时，容器 step 挂在 goal 下', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '目标已记录，但轮次开始事件缺失' });
    await extractor.handle({ type: 'tool.start', sessionId: SESSION, turn: 1, callId: 'c1', toolName: 'read', args: { path: 'x.md' } });

    const nodes = [...store.state.nodes.values()];
    const goal = nodes.find((node) => node.kind === 'goal');
    const step = nodes.find((node) => node.kind === 'step');
    const action = nodes.find((node) => node.kind === 'action');
    assert.ok(goal && step && action, 'goal/step/action 都应存在');
    assert.equal(step.parentId, goal.id);
    assert.equal(action.parentId, step.id);
});


test('splitAnswerSections：按 Markdown 标题/独立加粗小标题切段', () => {
    const text = [
        '# 解答',
        '这是一段开场说明，解释问题背景与符号约定。',
        '**记号.**',
        '设 A 为矩阵，所有 a_i 非零，记 D 为对角阵。',
        '**情形一：所有 a_i 非零**',
        '此时可用 Sherman–Morrison 公式求出逆矩阵。',
        '## 结论',
        '因此可逆当且仅当求和不为 -1。',
    ].join('\n');
    const sections = splitAnswerSections(text, { minSectionChars: 8, maxSections: 10 });
    assert.ok(sections.length >= 4);
    assert.equal(sections[0].title, '解答');
    assert.ok(sections.some((section) => section.title === '记号'));
    assert.ok(sections.some((section) => section.title.includes('情形一')));
    const last = sections[sections.length - 1];
    assert.equal(last.title, '结论');
    assert.equal(last.conclusion, true);
    assert.equal(classifySectionKind('结论'), 'conclusion');
    assert.equal(classifySectionKind('情形一', '此时验证通过'), 'evidence');
    assert.equal(classifySectionKind('假设', '可能因为缓存'), 'hypothesis');
});

test('没有推理链时，长回答按小标题拆成 step 下的推导链', async (t) => {
    const { store, extractor } = setup(t);
    const answer = [
        '# 解答',
        '这是一段足够长的开场说明，用来占位并解释题目的背景与符号约定，保证总字数超过阈值。',
        '',
        '**记号.**',
        '设 A 为 n 阶矩阵，D 为对角阵，所有 a_i 非零。',
        '',
        '**情形一：所有 a_i 非零**',
        '此时可用 Sherman–Morrison 公式求出逆矩阵，并给出逐元素表达式。',
        '',
        '## 结论',
        '因此矩阵可逆当且仅当求和不为 -1。',
    ].join('\n').repeat(3);
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '解决这个问题' });
    await extractor.handle({ type: 'assistant.message', sessionId: SESSION, turn: 1, text: answer, final: true });

    const state = store.state;
    const nodes = [...state.nodes.values()];
    const goal = nodes.find((node) => node.kind === 'goal');
    const step = nodes.find((node) => node.kind === 'step');
    assert.ok(goal && step, 'goal 与 step 都应存在');
    assert.equal(step.parentId, goal.id, 'turn/start 早于 user/message 时 step 要归到 goal 下');
    const isSection = (node) => Array.isArray(node.tags) && (node.tags.includes('section') || node.tags.includes('key'));
    const sections = nodes.filter(isSection);
    assert.ok(sections.length >= 3, '长回答应拆出多个推导节点');
    const conclusion = nodes.find((node) => node.kind === 'conclusion');
    assert.ok(conclusion, '结论段应是 conclusion 节点');
    assert.ok(nodes.filter((node) => node.kind === 'conclusion').length === 1, '有分段时不再额外添加整篇结论');
    const chained = nodes.filter(isSection);
    assert.ok(chained.length >= 3);
    assert.equal(chained[0].parentId, step.id, '第一个推导节点挂 step');
    assert.equal(chained[1].parentId, chained[0].id, '后续推导节点依次成链，形成多层树');
});

test('已经有推理节点时，不再把最终回答拆成推导节点', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '带推理的一轮' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({ type: 'assistant.reasoning', sessionId: SESSION, turn: 1, text: '决定先验证推理节点，因为推理才是主要信号。' });
    await extractor.handle({ type: 'assistant.message', sessionId: SESSION, turn: 1, text: ['# 解答', '这是一段足够长的最终回答，用来测试不会重复拆段。'.repeat(20)].join('\n'), final: true });
    const nodes = [...store.state.nodes.values()];
    assert.equal(nodes.filter((node) => Array.isArray(node.tags) && node.tags.includes('section')).length, 0);
});

test('turn/start 先于 user/message：step 在目标落库后归位', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    let step = [...store.state.nodes.values()].find((node) => node.kind === 'step');
    assert.equal(step.parentId, null, 'user/message 还没到，step 暂时是根');
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '解决这个问题' });
    const state = store.state;
    const goal = [...state.nodes.values()].find((node) => node.kind === 'goal');
    step = state.nodes.get(step.id);
    assert.equal(step.parentId, goal.id, 'goal 落库后把同会话的孤立 root step 挂到目标下');
    assert.equal([...state.nodes.values()].filter((node) => node.parentId === null && node.kind === 'step').length, 0);
});

test('P0：注入消息不建 goal，也不污染轮次标题', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({ type: 'user.message', sessionId: SESSION, sourceKind: 'user-approval', text: 'The approval policy changed from "ask" to "never".' });
    await extractor.handle({ type: 'user.message', sessionId: SESSION, sourceKind: 'time-context', text: 'Time sampled while preparing turn 1.' });
    let nodes = [...store.state.nodes.values()];
    assert.equal(nodes.filter((node) => node.kind === 'goal').length, 0, '注入消息不应建 goal');
    const step = nodes.find((node) => node.kind === 'step');
    assert.equal(step.title, '第 1 轮研究');
    assert.ok(!/Time sampled|approval policy/i.test(step.title));

    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '检索项目进度，优化建树算法' });
    nodes = [...store.state.nodes.values()];
    const goals = nodes.filter((node) => node.kind === 'goal');
    assert.equal(goals.length, 1, '真实消息才建 goal');
    assert.equal(goals[0].title, '检索项目进度，优化建树算法');
    assert.equal(nodes.find((node) => node.id === step.id).title, '第 1 轮：检索项目进度，优化建树算法');
});

test('P0：turn/start 的文本不再进入 step 标题', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 2, text: 'Time sampled while preparing turn 2' });
    const step = [...store.state.nodes.values()].find((node) => node.kind === 'step');
    assert.equal(step.title, '第 2 轮研究');
});

test('P0：重复 turn/start 不覆盖已回填的轮次标题', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '先读文档再分析' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    const steps = [...store.state.nodes.values()].filter((node) => node.kind === 'step');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].title, '第 1 轮：先读文档再分析');
});

test('P0：deliverable.presented 落 artifact 并按路径去重', async (t) => {
    const { store, extractor } = setup(t);
    const file = path.join('x', '报告.md');
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({ type: 'deliverable.presented', sessionId: SESSION, turn: 1, files: [{ kind: 'file', value: file, label: '报告' }] });
    await extractor.handle({ type: 'deliverable.presented', sessionId: SESSION, turn: 1, files: [{ kind: 'file', value: file, label: '报告' }] });
    const artifacts = [...store.state.nodes.values()].filter((node) => node.kind === 'artifact');
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].title, '报告.md');
    assert.equal(artifacts[0].summary, '报告');
    assert.ok(artifacts[0].tags.includes('deliverable'));
});

test('ranked：一轮多段推理只留关键节点，分层配额与总上限同时生效', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '设计建树算法的取舍策略' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({
        type: 'assistant.reasoning', sessionId: SESSION, turn: 1,
        text: [
            '假设：配额应该按层分配，因为结论常出现在轮次末尾。',
            '假设：note 应该折叠进轮次摘要，而不是单独占节点。',
            '假设：MMR 能压掉高度相似的候选。',
            '假设：分类应该按整句语义，而不是关键词。',
            '决定：采用 ranked 策略，chronological 只留作回退。',
            '决定：给结论预留一个槽位。',
            '数据表明回放里 24 个槽位在 51 秒内用尽。',
            '因为 31 个 artifact 全是读文件回显的路径，产物判定要改用展示事件。',
        ].join('\n\n'),
    });
    await extractor.handle({
        type: 'assistant.reasoning', sessionId: SESSION, turn: 1,
        text: [
            '假设：跨轮边应该单独补，不能靠时间桶。',
            '假设：frontier 应该看边，而不是只看子树里有没有证据。',
            '假设：step 摘要应该收拢过程旁白。',
            '假设：重复轮次要按会话与轮次合并。',
            '是否应该把 note 也落成节点？',
            '是否应该保留 24 条的旧默认值？',
            '数据表明 9 轮里有 8 轮的 turn 宽度超过 20。',
            '因为图里 edges 恒为 0，frontier 的 verify 建议被带偏。',
        ].join('\n\n'),
    });
    // 纯过程旁白：只计入「过程观察 ×N」，不建节点。
    await extractor.handle({
        type: 'assistant.reasoning', sessionId: SESSION, turn: 1,
        text: 'Let me read the README first.\n\n我先看一下测试结构。\n\nNext I will run the unit tests.',
    });

    const nodes = [...store.state.nodes.values()];
    const step = nodes.find((node) => node.kind === 'step');
    const thoughts = nodes.filter((node) => ['question', 'hypothesis', 'evidence', 'decision', 'conclusion', 'dead_end'].includes(node.kind));
    assert.ok(thoughts.length <= 10, `总上限 10，实际 ${thoughts.length}`);
    assert.equal(nodes.filter((node) => node.kind === 'note').length, 0, 'note 默认折叠，不建节点');
    const byKind = {};
    for (const node of thoughts) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    assert.ok((byKind.hypothesis ?? 0) <= 3, 'hypothesis 配额 3');
    assert.ok((byKind.decision ?? 0) <= 3, 'decision 配额 3');
    assert.ok((byKind.question ?? 0) <= 2, 'question 配额 2');
    assert.ok((byKind.evidence ?? 0) <= 3, 'evidence 配额 3');

    // 逻辑嵌套：父节点只能是 step 或同轮另一条想法（形成链/子树，而不是全部平铺）。
    const thoughtIds = new Set(thoughts.map((node) => node.id));
    for (const node of thoughts) {
        assert.notEqual(node.parentId, null);
        assert.ok(node.parentId === step.id || thoughtIds.has(node.parentId), '父节点应是 step 或另一条想法');
    }
    assert.ok(thoughts.some((node) => node.parentId !== step.id), '至少有一条想法挂在另一条想法下（逻辑深度）');

    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1, text: '' });
    const after = store.state.nodes.get(step.id);
    assert.match(after.summary, /过程观察 ×3/u, '过程旁白折叠进轮次摘要');
});

test('ranked：重复片段不耗尽候选预算，晚到结论仍能入选', async (t) => {
    const { store, extractor } = setup(t);
    const emit = (text) => extractor.handle({ type: 'assistant.reasoning', sessionId: SESSION, turn: 1, text });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    const hypothesis = '假设：缓存键格式变化导致命中率下降。';
    for (let i = 0; i < 65; i += 1) await emit(hypothesis);
    await emit('结论：统一缓存键编码后命中率恢复到 98%。');
    const nodes = [...store.state.nodes.values()];
    assert.ok(nodes.some((node) => node.kind === 'conclusion'), '第 60 次之后的结论不能被截断');
    assert.equal(nodes.find((node) => node.kind === 'hypothesis').hits, 65, '重复命中仍应计数');
    const runtime = extractor.runtime.get(SESSION);
    assert.equal(runtime.claims.size, 2, '重复片段只占一个候选');
    assert.equal(runtime.claimSeq, 2, '顺序编号只随新候选推进');
});

test('ranked：候选池满后持续接纳新方向与结论，内存保持有界', async (t) => {
    const { store, extractor } = setup(t);
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    const emit = (text) => extractor.handle({ type: 'assistant.reasoning', sessionId: SESSION, turn: 1, text });
    await emit('假设：旧版本的任务队列存在饥饿问题。');
    const early = [...store.state.nodes.values()].find((node) => node.kind === 'hypothesis');
    // 低置信普通观察不会成为关键节点，但仍会填充候选池。
    for (let i = 0; i < 75; i += 1) {
        await emit(`普通片段编号 ${i} 的内容描述记录在这里。`);
        assert.ok(extractor.runtime.get(SESSION).claims.size <= 60, '默认候选池最多 60 条');
    }
    await emit('假设：缓存键缺少用户命名空间导致数据串用。');
    await emit('结论：隔离用户命名空间后冲突率降至 0%。');
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1 });
    const nodes = [...store.state.nodes.values()];
    assert.ok(nodes.some((node) => node.kind === 'hypothesis' && node.summary.includes('缓存键缺少用户命名空间')), '满池后仍能探索新方向');
    assert.ok(nodes.some((node) => node.kind === 'conclusion'), '满池后仍能保留最终结论');
    assert.ok(extractor.runtime.get(SESSION).claims.size <= 60);
    assert.ok(store.state.nodes.has(early.id), '池淘汰不能删除仍入选的早期节点');
    const step = nodes.find((node) => node.kind === 'step');
    assert.match(step.summary, /过程观察 ×75（已折叠/u, '被逐出候选池的 note 仍计入摘要');
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 2 });
    assert.equal(extractor.runtime.get(SESSION).prunedNoteCount, 0, '折叠计数按轮重置');
});

test('ranked：大配额保留额外探索槽，同分未发布候选按最早淘汰', async (t) => {
    const { extractor } = setup(t);
    extractor.config.maxThoughtNodesPerTurn = 60;
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    for (let i = 0; i < 63; i += 1) {
        await extractor.handle({
            type: 'assistant.reasoning', sessionId: SESSION, turn: 1,
            text: `普通片段编号 ${i} 的内容描述记录在这里。`,
        });
        assert.ok(extractor.runtime.get(SESSION).claims.size <= 61);
    }
    const runtime = extractor.runtime.get(SESSION);
    const orders = [...runtime.claims.values()].map((claim) => claim.order);
    assert.equal(runtime.claims.size, 61);
    assert.equal(Math.min(...orders), 3, '同分淘汰最早的两个未发布候选');
    assert.equal(Math.max(...orders), 63, '满池后仍接纳最新候选');
});

test('ranked：chronological 回退仍按事件顺序保留节点', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-extract-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    const extractor = new ResearchExtractor({
        store,
        config: { selectionStrategy: 'chronological', maxThoughtUnitsPerBlock: 12, minThoughtChars: 4 },
        logger: { warn: () => {}, error: () => {} },
    });
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '对比旧策略' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({
        type: 'assistant.reasoning', sessionId: SESSION, turn: 1,
        text: Array.from({ length: 6 }, (_, i) => `决定：按顺序保留第 ${i + 1} 条，因为要做对照。`).join('\n\n'),
    });
    const nodes = [...store.state.nodes.values()];
    const thoughts = nodes.filter((node) => ['question', 'hypothesis', 'evidence', 'decision', 'conclusion', 'dead_end'].includes(node.kind));
    assert.equal(thoughts.length, 6, 'chronological 不看分层配额');
});

test('P2：跨轮建 continues 边，跨轮证据建 supports 边，轮末摘要带关键/结果', async (t) => {
    const { store, extractor } = setup(t);
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    await emit({ type: 'turn.start', turn: 1 });
    await emit({ type: 'user.message', turn: 1, sourceKind: 'user', text: '排查缓存命中率下降' });
    await emit({ type: 'assistant.reasoning', turn: 1, step: 1, text: '假设：缓存键格式变化导致命中率下降。' });
    await emit({ type: 'turn.end', turn: 1 });
    await emit({ type: 'turn.start', turn: 2 });
    await emit({ type: 'user.message', turn: 2, sourceKind: 'user', text: '继续验证这个假设' });
    await emit({ type: 'assistant.reasoning', turn: 2, step: 1, text: '证据：缓存键格式变化确实导致命中率下降。' });
    await emit({ type: 'turn.end', turn: 2 });

    const nodes = [...store.state.nodes.values()];
    const steps = nodes.filter((node) => node.kind === 'step').sort((a, b) => a.turn - b.turn);
    const hypothesis = nodes.find((node) => node.kind === 'hypothesis');
    const evidence = nodes.find((node) => node.kind === 'evidence');
    assert.equal(steps.length, 2);
    assert.ok(hypothesis, '第一轮应产出假设');
    assert.ok(evidence, '第二轮应产出证据');

    const continues = store.state.edges.find((edge) => edge.kind === 'continues');
    assert.ok(continues, `应有 continues 边：${store.state.edges.map((edge) => `${edge.kind} ${edge.from}->${edge.to}`).join(', ')}`);
    assert.equal(continues.from, steps[0].id);
    assert.equal(continues.to, steps[1].id);

    const supports = store.state.edges.find((edge) => edge.kind === 'supports');
    assert.ok(supports, `跨轮证据应接到假设：${store.state.edges.map((edge) => `${edge.kind} ${edge.from}->${edge.to}`).join(', ')}`);
    assert.equal(supports.from, evidence.id);
    assert.equal(supports.to, hypothesis.id);
    assert.match(steps[0].summary, /关键：/);
    assert.match(steps[1].summary, /结果：/);
});

test('ranked：同轮相关 claim 形成子假设/证据链（逻辑深度 ≥4）', async (t) => {
    const { store, extractor } = setup(t);
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    await emit({ type: 'turn.start', turn: 1 });
    await emit({ type: 'user.message', turn: 1, sourceKind: 'user', text: '调查配额策略' });
    await emit({
        type: 'assistant.reasoning',
        turn: 1,
        step: 1,
        text: [
            '假设：配额按先到先得分配，导致过程旁白占满槽位。',
            '假设：配额改为分层分配并替换同层最低分。',
            '证据：旧实现每轮保留 24 条想法，分层后每轮预计保留 10 条。',
            '结论：问题在取舍策略而不是切分粒度。',
        ].join('\n'),
    });
    await emit({ type: 'turn.end', turn: 1 });

    const nodes = [...store.state.nodes.values()];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const depthOf = (node) => {
        let depth = 0;
        let current = node;
        while (current?.parentId) {
            current = byId.get(current.parentId);
            depth += 1;
        }
        return depth;
    };
    const maxDepth = Math.max(...nodes.map(depthOf));
    assert.ok(maxDepth >= 4, `逻辑深度应 ≥4（goal→step→假设→子假设→证据），实际 ${maxDepth}`);
    const hypotheses = nodes.filter((node) => node.kind === 'hypothesis');
    assert.ok(hypotheses.length >= 2, '应保留两条假设');
    assert.ok(
        hypotheses.some((node) => hypotheses.some((other) => other.id === node.parentId)),
        '子假设应挂在另一条假设下（同轮嵌套）',
    );
    const evidence = nodes.find((node) => node.kind === 'evidence');
    assert.ok(evidence, '应产出证据');
    const stepId = nodes.find((node) => node.kind === 'step').id;
    assert.notEqual(evidence.parentId, stepId, '证据应挂在想法下面，而不是平铺在 step 下');
});

test('ranked：有 topic 时想法自动挂到主干叶根，step 只作时间元数据', async (t) => {
    const { store, extractor } = setup(t);
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    await emit({ type: 'turn.start', turn: 1 });
    await emit({ type: 'user.message', turn: 1, sourceKind: 'user', text: '把想法挂到主干' });
    const session = store.state.sessions.get(SESSION);
    const topicOp = await store.apply({
        t: 'addNode',
        node: { kind: 'topic', parentId: session.goalId, title: '自动挂载', digest: '本轮探索' },
    });
    const topicId = topicOp.node.id;
    await emit({
        type: 'assistant.reasoning',
        turn: 1,
        step: 1,
        text: '假设：主干应该承接本轮的探索方向\n\n证据：把证据挂到假设下面而不是 step 下',
    });
    await emit({ type: 'turn.end', turn: 1 });

    const nodes = [...store.state.nodes.values()];
    const step = nodes.find((node) => node.kind === 'step');
    const thoughts = nodes.filter((node) => !['goal', 'step', 'topic'].includes(node.kind));
    assert.ok(thoughts.length > 0, '应产出想法节点');
    assert.ok(
        thoughts.some((node) => node.parentId === topicId && ['question', 'hypothesis', 'decision'].includes(node.kind)),
        '至少一个叶根直接挂在 topic 下',
    );
    assert.ok(thoughts.every((node) => node.stepId === step.id), '自动想法应带 stepId');
    assert.ok(!thoughts.some((node) => node.parentId === step.id), '有 topic 时不应再把想法直接挂 step');
});

test('autoSeedTopic：无 topic 时单轮想法达到阈值后自动建候选主题并挂载', async (t) => {
    const { store, extractor } = setup(t);
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    await emit({ type: 'turn.start', turn: 1 });
    await emit({ type: 'user.message', turn: 1, sourceKind: 'user', text: '优化建树算法' });
    await emit({
        type: 'assistant.reasoning',
        turn: 1,
        step: 1,
        text: [
            '假设：配额按先到先得分配，导致过程旁白占满槽位。',
            '',
            '假设：配额改为分层分配并替换同层最低分。',
            '',
            '问题：note 是否应该默认折叠？',
            '',
            '证据：旧实现每轮保留 24 条想法。',
            '',
            '证据：分层后每轮预计保留 10 条。',
            '',
            '决策：改为分层配额 + MMR。',
        ].join('\n'),
    });
    await emit({ type: 'turn.end', turn: 1 });

    const nodes = [...store.state.nodes.values()];
    const topic = nodes.find((node) => node.kind === 'topic');
    assert.ok(topic, '应自动建一个候选主题');
    assert.match(topic.title, /优化建树算法/);
    assert.ok(topic.tags.includes('candidate'));
    assert.equal(typeof topic.digest, 'string');
    const step = nodes.find((node) => node.kind === 'step');
    const direct = nodes.filter((node) => node.parentId === step.id && !['action', 'artifact', 'step'].includes(node.kind));
    assert.equal(direct.length, 0, '本轮想法应迁到 topic/叶根，而不是留在 step 下');
    assert.ok(nodes.some((node) => node.parentId === topic.id), '至少一个叶根挂在 topic 下');
});

test('ranked：跨轮 adopted 的历史节点落选后只解除映射，绝不删除（回归）', async (t) => {
    const { store, extractor } = setup(t);
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    await emit({ type: 'turn.start', turn: 1 });
    await emit({ type: 'user.message', turn: 1, sourceKind: 'user', text: '排查任务队列饥饿问题' });
    await emit({ type: 'assistant.reasoning', turn: 1, text: '假设：旧版本的任务队列在高峰期存在饥饿问题。' });
    await emit({ type: 'turn.end', turn: 1 });

    const first = [...store.state.nodes.values()].find((node) => node.kind === 'hypothesis');
    assert.ok(first, '第一轮应产出假设节点');
    assert.equal(first.turn, 1);

    await emit({ type: 'turn.start', turn: 2 });
    await emit({ type: 'assistant.reasoning', turn: 2, text: '假设：旧版本的任务队列在高峰期存在饥饿问题。' });
    const runtime = extractor.runtime.get(SESSION);
    assert.ok([...runtime.claimNodes.values()].includes(first.id), '重复片段应 adopted 到第一轮的节点');

    for (const text of [
        '假设：v0.21 的缓存键编码导致 12% 命中率下降。',
        '假设：磁盘写入抖动来自 fsync 策略，实测延迟超过 340 ms。',
        '假设：并发读放大导致快照加载变慢，40 次读里 7 次超时。',
    ]) {
        await emit({ type: 'assistant.reasoning', turn: 2, text });
        assert.ok(store.state.nodes.has(first.id), `写入「${text.slice(0, 12)}…」后第一轮节点不应被删除`);
    }

    assert.ok(![...runtime.claimNodes.values()].includes(first.id), '落选后应解除 claim→node 映射');
    assert.equal(store.state.nodes.get(first.id).turn, 1, '被 adopted 的历史节点保持原轮次');
    assert.equal(runtime.autoCount, 3, 'adopted 不占预算；误删历史节点时也不应回退本轮预算');
    assert.equal([...store.state.nodes.values()].filter((node) => node.kind === 'hypothesis').length, 4, '历史假设 + 本轮 3 条新假设');
});

test('ranked：本轮新建节点落选时仍删除并回退预算（保留增量替换）', async (t) => {
    const { store, extractor } = setupWithConfig(t, { maxThoughtNodesPerTurn: 1 });
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    await emit({ type: 'user.message', text: '单轮增量替换' });
    await emit({ type: 'turn.start', turn: 1 });
    await emit({ type: 'assistant.reasoning', turn: 1, text: '假设：旧版本的任务队列在高峰期存在饥饿问题。' });
    const first = [...store.state.nodes.values()].find((node) => node.kind === 'hypothesis');
    assert.ok(first, '第一条假设应落节点');
    const runtime = extractor.runtime.get(SESSION);
    assert.equal(runtime.autoCount, 1);

    await emit({ type: 'assistant.reasoning', turn: 1, text: '假设：v0.21 的缓存键编码导致 12% 命中率下降。' });
    assert.equal(store.state.nodes.has(first.id), false, '本轮新建、落选的低分节点仍应删除');
    assert.equal(runtime.autoCount, 1, '删除本轮新建节点后预算回退到 1');
    assert.equal([...store.state.nodes.values()].filter((node) => node.kind === 'hypothesis').length, 1);
});

test('工具聚合路径共享 maxAutoNodesPerTurn：聚合动作、失败 dead_end、轮末中断都占预算（回归）', async (t) => {
    const warnings = [];
    const { store, extractor } = setupWithConfig(t, { maxAutoNodesPerTurn: 2 }, {
        warn: (message) => warnings.push(String(message)),
        error: () => {},
    });
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    await emit({ type: 'user.message', text: '测试工具预算' });
    await emit({ type: 'turn.start', turn: 1 });
    for (let index = 0; index < 6; index += 1) {
        const callId = `c${index}`;
        await emit({ type: 'tool.start', turn: 1, callId, toolName: 'bash', args: { command: `bad ${index}` } });
        await emit({ type: 'tool.end', turn: 1, callId, toolName: 'bash', ok: false, error: `不同的错误 ${index}` });
    }
    await emit({ type: 'turn.end', turn: 1, aborted: true, error: '用户取消' });

    const nodes = [...store.state.nodes.values()];
    const actions = nodes.filter((node) => node.kind === 'action');
    const deadEnds = nodes.filter((node) => node.kind === 'dead_end');
    const runtime = extractor.runtime.get(SESSION);
    assert.equal(actions.length, 1, '聚合动作节点只建一个');
    assert.equal(deadEnds.length, 1, '预算用尽后失败 dead_end 与轮末中断 dead_end 都应跳过');
    assert.equal(runtime.autoCount, 2, 'autoCount 只记两个占预算的新节点（goal/step 不占）');
    assert.equal(nodes.filter((node) => node.kind === 'goal').length, 1);
    assert.equal(nodes.filter((node) => node.kind === 'step').length, 1);
    assert.match(actions[0].title, /工具调用 ×6/, '聚合计数轮末仍定稿');
    assert.equal(warnings.filter((message) => message.includes('上限 2')).length, 1, '预算耗尽只记一次日志');

    // 下一轮：预算与告警都应重置，每轮最多再记一条超限日志。
    await emit({ type: 'turn.start', turn: 2 });
    for (let index = 0; index < 3; index += 1) {
        const callId = `t2-${index}`;
        await emit({ type: 'tool.start', turn: 2, callId, toolName: 'bash', args: { command: `again ${index}` } });
        await emit({ type: 'tool.end', turn: 2, callId, toolName: 'bash', ok: false, error: `第二轮错误 ${index}` });
    }
    assert.equal(warnings.filter((message) => message.includes('第 2 轮')).length, 1, '新的一轮应重新允许一条超限日志');
    assert.equal(warnings.filter((message) => message.includes('上限 2')).length, 2, '两轮各记一条，不会跨轮吞掉');
});

test('重复 turn.start 不重置轮级预算；user.message 先到的新轮 turn.start 仍会重置（回归）', async (t) => {
    const warnings = [];
    const { store, extractor } = setupWithConfig(t, { maxAutoNodesPerTurn: 1 }, {
        warn: (message) => warnings.push(String(message)),
        error: () => {},
    });
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    const failTool = async (turn, callId, message) => {
        await emit({ type: 'tool.start', turn, callId, toolName: 'bash', args: { command: `bad ${callId}` } });
        await emit({ type: 'tool.end', turn, callId, toolName: 'bash', ok: false, error: message });
    };

    await emit({ type: 'turn.start', turn: 1 });
    await failTool(1, 'c1', '第一轮错误');
    const runtime = extractor.runtime.get(SESSION);
    assert.equal(runtime.autoCount, 1, '聚合 action 应刚好用满预算 1');

    // 重复投递同一轮的 turn.start：不得清空预算/告警/claim 状态。
    await emit({ type: 'turn.start', turn: 1 });
    assert.equal(runtime.autoCount, 1, '重复 turn.start 不应重置预算');
    await failTool(1, 'c2', '第一轮第二个错误');
    assert.equal(runtime.autoCount, 1, '同一轮预算仍应保持满额');
    assert.equal([...store.state.nodes.values()].filter((node) => node.kind === 'action').length, 1, '重复轮内不再新建 action');
    assert.equal(warnings.filter((message) => message.includes('上限 1')).length, 1, '同一轮超限仍只记一次');

    // 宿主顺序：user.message 先把 runtime.turn 抬到 2，随后才到 turn.start 2。
    // 不能因为 runtime.turn 已经等于 2 就跳过轮级重置。
    await emit({ type: 'user.message', turn: 2, sourceKind: 'user', text: '开始第二轮' });
    assert.equal(runtime.turn, 2, 'user.message 会先把 runtime.turn 抬到新轮');
    await emit({ type: 'turn.start', turn: 2 });
    assert.equal(runtime.autoCount, 0, '新轮 turn.start 必须重置预算（即使 user.message 先到）');
    await failTool(2, 'c3', '第二轮错误');
    assert.equal(runtime.autoCount, 1, '第二轮可再次用满预算 1');
    assert.equal(runtime.turn, 2);

    // 迟到的旧轮 turn.start：只复用旧 step，不回退当前轮。
    await emit({ type: 'turn.start', turn: 1 });
    assert.equal(runtime.turn, 2, '迟到旧轮 turn.start 不应回退 runtime.turn');
    assert.equal(runtime.startedTurn, 2);
    assert.equal(runtime.autoCount, 1, '迟到旧轮 turn.start 不应重置当前轮预算');

    const nodes = [...store.state.nodes.values()];
    assert.equal(nodes.filter((node) => node.kind === 'step').length, 2, '每轮一个 step');
    assert.equal(nodes.filter((node) => node.kind === 'action').length, 2, '两轮各一个聚合 action');
    assert.equal(nodes.filter((node) => node.kind === 'dead_end').length, 0, '预算 1 时失败 dead_end 均跳过');
    assert.equal(warnings.filter((message) => message.includes('上限 1')).length, 2, '两轮各记一条超限日志');
});

test('artifact/deliverable 也占自动节点预算：重复指纹只加 hits（回归）', async (t) => {
    const warnings = [];
    const { store, extractor } = setupWithConfig(t, { maxAutoNodesPerTurn: 3 }, {
        warn: (message) => warnings.push(String(message)),
        error: () => {},
    });
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    await emit({ type: 'turn.start', turn: 1 });
    await emit({ type: 'tool.start', turn: 1, callId: 'c1', toolName: 'write', args: { path: 'out/a.md' } });
    await emit({ type: 'tool.end', turn: 1, callId: 'c1', toolName: 'write', ok: true, result: 'ok', artifacts: [{ kind: 'file', value: 'out/a.md' }, { kind: 'file', value: 'out/b.md' }] });
    // 同参数第二次调用：聚合动作已存在，重复 artifact 只加 hits，不重复占预算。
    await emit({ type: 'tool.start', turn: 1, callId: 'c2', toolName: 'write', args: { path: 'out/a.md' } });
    await emit({ type: 'tool.end', turn: 1, callId: 'c2', toolName: 'write', ok: true, result: 'ok', artifacts: [{ kind: 'file', value: 'out/a.md' }] });
    // 交付物：a.md 命中已有 artifact；d.md 因预算耗尽被跳过（也不再把 autoCount 加一）。
    await emit({ type: 'deliverable.presented', turn: 1, files: [{ kind: 'file', value: 'out/a.md', label: '报告' }, { kind: 'file', value: 'out/d.md' }] });
    // 预算已耗尽：新的成功产物与新失败 dead_end 都不再建节点。
    await emit({ type: 'tool.start', turn: 1, callId: 'c3', toolName: 'read', args: { path: 'x.md' } });
    await emit({ type: 'tool.end', turn: 1, callId: 'c3', toolName: 'read', ok: true, result: 'x', artifacts: [{ kind: 'file', value: 'out/e.md' }] });
    await emit({ type: 'tool.end', turn: 1, callId: 'c4', toolName: 'bash', ok: false, error: '新错误' });

    const nodes = [...store.state.nodes.values()];
    const artifacts = nodes.filter((node) => node.kind === 'artifact');
    const runtime = extractor.runtime.get(SESSION);
    assert.equal(artifacts.length, 2, '只保留预算内的两个产物');
    assert.equal(artifacts.find((node) => node.title === 'a.md')?.hits, 3, '重复指纹只累加 hits');
    assert.equal(artifacts.find((node) => node.title === 'b.md')?.hits, 1);
    assert.equal(nodes.filter((node) => node.kind === 'dead_end').length, 0);
    assert.equal(runtime.autoCount, 3, '聚合动作 + 两个 artifact 刚好用满预算');
    assert.equal(warnings.length, 1, '预算耗尽只记一次日志');
});

test('ranked：计划句不再落成永久 open 的问题/假设节点', async (t) => {
    const { store, extractor } = setup(t);
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    await emit({ type: 'turn.start', turn: 1 });
    await emit({ type: 'user.message', turn: 1, sourceKind: 'user', text: '清理未决节点' });
    await emit({
        type: 'assistant.reasoning',
        turn: 1,
        step: 1,
        text: [
            'Could use a Map for the cache.',
            '',
            'Need decide experiment design and delegate agents.',
            '',
            'Add hypothesis 1, hypothesis 2, and evidence under them.',
            '',
            'Read the README and run npm test.',
            '',
            'Do sequential in one bash to avoid output mess.',
        ].join('\n'),
    });
    await emit({ type: 'turn.end', turn: 1 });

    const thoughts = [...store.state.nodes.values()]
        .filter((node) => node.kind === 'question' || node.kind === 'hypothesis');
    assert.equal(thoughts.length, 0, '计划句不应变成问题/假设，实际：' + thoughts.map((node) => node.title).join(' | '));
    const open = [...store.state.nodes.values()].filter((node) => node.status === 'open');
    assert.equal(open.length, 0, '轮末不应留下 open 节点');
});

test('topic 平衡：已完成/满仓主题不再接收新想法，轮末自动建新主题', async (t) => {
    const { store, extractor } = setupWithConfig(t, { maxOpenLeavesPerTopic: 1 });
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    await emit({ type: 'turn.start', turn: 1 });
    await emit({ type: 'user.message', turn: 1, sourceKind: 'user', text: '继续研究未决问题' });
    const session = store.state.sessions.get(SESSION);
    const oldTopic = await store.apply({
        t: 'addNode',
        node: { kind: 'topic', parentId: session.goalId, title: '已完成主题', status: 'done', digest: '历史' },
    });
    await store.apply({
        t: 'addNode',
        node: { kind: 'question', parentId: oldTopic.node.id, title: '主题关闭时遗留的问题', status: 'open', origin: 'auto' },
    });
    const oldChildren = [...store.state.nodes.values()].filter((node) => node.parentId === oldTopic.node.id).length;

    await emit({
        type: 'assistant.reasoning',
        turn: 1,
        step: 1,
        text: [
            '假设：新建主题应承接本轮的五条想法。',
            '',
            '假设：旧主题关闭后不应继续追加叶根。',
            '',
            '问题：新主题的标题是否应来自轮次标题？',
            '',
            '证据：旧实现会继续挂到最近更新的主题。',
            '',
            '决策：主题没有容量时新建候选主题。',
            '',
            '假设：新主题应记录本轮的 stepId 以保留时间线。',
            '',
            '假设：旧主题完成后不应继续增长。',
        ].join('\n'),
    });
    await emit({ type: 'turn.end', turn: 1 });

    const nodes = [...store.state.nodes.values()];
    const topics = nodes.filter((node) => node.kind === 'topic');
    assert.equal(topics.length, 2, '应新建一个主题');
    assert.equal(nodes.filter((node) => node.parentId === oldTopic.node.id).length, oldChildren,
        '已完成主题不应再接收新想法');
    const fresh = topics.find((node) => node.id !== oldTopic.node.id);
    assert.notEqual(fresh.status, 'done');
    assert.ok(nodes.some((node) => node.parentId === fresh.id), '新想法应挂到新主题');
    const step = nodes.find((node) => node.kind === 'step');
    const direct = nodes.filter((node) => node.parentId === step.id
        && ['question', 'hypothesis', 'decision', 'evidence'].includes(node.kind));
    assert.equal(direct.length, 0, '轮末想法应迁到新主题/叶根，不留在 step 下');
});

test('topic 平衡：已有主题全部满仓时，单条想法也会另起候选主题（回归）', async (t) => {
    const { store, extractor } = setupWithConfig(t, { maxOpenLeavesPerTopic: 1 });
    const emit = (event) => extractor.handle({ sessionId: SESSION, ...event });
    await emit({ type: 'turn.start', turn: 1 });
    await emit({ type: 'user.message', turn: 1, sourceKind: 'user', text: '满仓后的新问题' });
    const session = store.state.sessions.get(SESSION);
    const fullTopic = await store.apply({
        t: 'addNode',
        node: { kind: 'topic', parentId: session.goalId, title: '满仓主题', status: 'active', digest: '已有一条叶根' },
    });
    await store.apply({
        t: 'addNode',
        node: { kind: 'question', parentId: fullTopic.node.id, title: '已占满的叶根', status: 'open', origin: 'auto' },
    });

    await emit({
        type: 'assistant.reasoning',
        turn: 1,
        step: 1,
        text: '问题：满仓后新问题是否应另起主题？',
    });
    await emit({ type: 'turn.end', turn: 1 });

    const nodes = [...store.state.nodes.values()];
    const topics = nodes.filter((node) => node.kind === 'topic');
    assert.equal(topics.length, 2, '满仓时单条想法也应另起候选主题');
    const fresh = topics.find((node) => node.id !== fullTopic.node.id);
    assert.ok(fresh, '应新建主题');
    assert.ok(nodes.some((node) => node.parentId === fresh.id && node.kind === 'question'),
        '新问题应迁到新主题，而不是留在 step 下');
    const step = nodes.find((node) => node.kind === 'step');
    assert.equal(nodes.filter((node) => node.parentId === step.id
        && ['question', 'hypothesis', 'decision', 'evidence'].includes(node.kind)).length, 0);
});
