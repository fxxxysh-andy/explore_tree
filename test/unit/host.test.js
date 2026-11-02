/**
 * 宿主适配层测试：事件翻译、服务摄取、HTTP 快照、工具读写、插件装配。
 *
 * 这些用例就是「需求 1/2/5/6/8」的回归网：
 *  - 1/5：会话事件能完整落成图，且不改对话；
 *  - 2：工具能读能写；
 *  - 6：提示段/工具面是静态的，插件装配后不随图变化；
 *  - 8：同一工作区共享一个 store。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { apply } from '../../src/index.js';
import { extractConfigOf, normalizeConfig } from '../../src/host/config.js';
import { ResearchTraceService } from '../../src/host/service.js';
import { buildToolDefinitions } from '../../src/host/tools.js';
import { detectArtifacts, translateSessionEvent } from '../../src/host/translate.js';
import { PROMPT_TEXT } from '../../src/host/prompt.js';
import { fingerprint } from '../../src/core/fingerprint.js';
import { canonicalWorkspaceRoot } from '../../src/core/paths.js';

const tempRoots = [];
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-tree-dsh-home-'));
function makeWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-tree-host-'));
    tempRoots.push(root);
    // Windows runner 的 TEMP 常是 8.3 短路径；用例统一用 realpath，避免拿别名去比 canonical root。
    return canonicalWorkspaceRoot(root) ?? root;
}

after(() => {
    for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
});

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function mockContext(root, overrides = {}) {
    const listeners = new Map();
    const routes = [];
    const tools = [];
    const sections = [];
    const effects = [];
    const ctx = {
        logger: silentLogger,
        tools: { register: (definition) => { tools.push(definition); return () => {}; } },
        systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
        workingDirectory: { get: () => root, defaultDirectory: root },
        workspaceRegistry: { list: () => [{ id: 'w1', path: root, title: 'test-workspace' }] },
        on: (event, listener) => { listeners.set(event, listener); return () => {}; },
        effect: (execute) => { effects.push(execute()); return () => {}; },
        inject: (_deps, callback) => callback({
            effect: (execute) => { effects.push(execute()); return () => {}; },
            webServer: {
                register: (route) => { routes.push(route); return () => {}; },
            },
        }),
        ...overrides,
    };
    return { ctx, listeners, routes, tools, sections, effects };
}

function makeSession(id = 'session-1', cwd) {
    return { id, header: { cwd } };
}

describe('normalizeConfig', () => {
    it('maxOpenLeavesPerTopic 归一化并透传到提取器配置', () => {
        const config = normalizeConfig({ extract: { maxOpenLeavesPerTopic: 4 } });
        assert.equal(config.maxOpenLeavesPerTopic, 4);
        assert.equal(extractConfigOf(config).maxOpenLeavesPerTopic, 4);
        assert.equal(normalizeConfig({ extract: { maxOpenLeavesPerTopic: 999 } }).maxOpenLeavesPerTopic, 100);
    });
});

describe('translateSessionEvent', () => {
    it('把一轮会话翻译成 goal→step→action→artifact→conclusion 所需事件', () => {
        const runtime = { turn: 0, lastUserText: '' };
        const session = { id: 's1' };
        const out = [];

        out.push(...translateSessionEvent(session, { type: 'user/message', data: { id: 'm1', content: [{ type: 'text', text: '调查缓存命中率下降的原因' }], source: { kind: 'user' } } }, runtime));
        out.push(...translateSessionEvent(session, { type: 'turn/start', data: { turn: 1 } }, runtime));
        out.push(...translateSessionEvent(session, {
            type: 'assistant/message',
            data: { turn: 1, step: 1, stream: [], message: { content: [{ type: 'reasoning', text: '先看命中率统计，再对比最近改动。' }, { type: 'text', text: '结论：缓存键设计变化是主要原因，需要先回滚键格式再观察一周。' }] } },
        }, runtime));
        out.push(...translateSessionEvent(session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"stat cache"}' } }, runtime));
        out.push(...translateSessionEvent(session, { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'hit rate 71%\noutput: C:\\tmp\\cache-report.md' }] } } }, runtime));
        out.push(...translateSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, runtime));

        const types = out.map((event) => event.type);
        assert.deepEqual(types, ['user.message', 'turn.start', 'assistant.reasoning', 'assistant.message', 'tool.start', 'tool.end', 'turn.end']);
        assert.equal(out[0].text, '调查缓存命中率下降的原因');
        assert.equal(out[0].sourceKind, 'user');
        assert.equal(out[2].text, '先看命中率统计，再对比最近改动。');
        assert.equal(out[2].step, 1);
        assert.equal(out[4].args.command, 'stat cache');
        assert.equal(out[5].ok, true);
        assert.equal(out[5].toolName, 'bash', '工具名从 callId 的调用记录里补回');
        assert.equal(out[5].artifacts.length, 0, '工具结果文本里的路径不再算产物（P0）');
        assert.equal(out[6].aborted, false);
    });

    it('工具错误与中断轮次会被标成失败', () => {
        const runtime = { turn: 0, lastUserText: '' };
        const session = { id: 's2' };
        const result = translateSessionEvent(session, {
            type: 'tool/result',
            data: { turn: 2, step: 1, message: { toolCallId: 'c9', content: [{ type: 'text', text: 'EACCES: permission denied' }] }, error: { name: 'Error', code: 'EACCES' } },
        }, runtime);
        assert.equal(result[0].ok, false);
        assert.match(result[0].error, /EACCES/);
        const ended = translateSessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'interrupted' } } }, runtime);
        assert.equal(ended[0].aborted, true);
    });

    it('detectArtifacts 只认明确产物句式，且去重', () => {
        const found = detectArtifacts('', 'output: C:\\a\\report.md\n已保存到 D:/b/chart.png\noutput: C:\\a\\report.md');
        assert.equal(found.length, 2);
    });
});

describe('translateSessionEvent · P0 来源与交付物', () => {
    it('注入消息不更新 lastUserText，真人消息更新并带 sourceKind', () => {
        const runtime = { turn: 0, lastUserText: '', toolCalls: new Map() };
        const session = { id: 's-src' };
        const injected = translateSessionEvent(session, {
            type: 'user/message',
            data: { id: 'm0', source: { kind: 'time-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1.' }] },
        }, runtime);
        assert.equal(injected[0].sourceKind, 'time-context');
        assert.equal(runtime.lastUserText, '', '注入消息不能成为轮次标题来源');
        const real = translateSessionEvent(session, {
            type: 'user/message',
            data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '检索项目进度' }] },
        }, runtime);
        assert.equal(real[0].sourceKind, 'user');
        assert.equal(runtime.lastUserText, '检索项目进度');
    });

    it('写类工具的真实文件才算产物；文本回显与不存在的路径都不算', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-translate-artifact-'));
        tempRoots.push(dir);
        const file = path.join(dir, 'report.md');
        fs.writeFileSync(file, '# report');
        const runtime = { turn: 1, lastUserText: '', toolCalls: new Map() };
        const session = { id: 's-art', header: { cwd: dir } };
        translateSessionEvent(session, {
            type: 'tool/call',
            data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: file, content: '# report' }) },
        }, runtime);
        const ok = translateSessionEvent(session, {
            type: 'tool/result',
            data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: `wrote ${file}` }] } },
        }, runtime);
        assert.equal(ok[0].toolName, 'write', '工具名从调用记录补回');
        assert.equal(ok[0].artifacts.length, 1);
        assert.equal(ok[0].artifacts[0].value, file);

        const missingRuntime = { turn: 1, lastUserText: '', toolCalls: new Map() };
        translateSessionEvent(session, {
            type: 'tool/call',
            data: { turn: 1, step: 1, callId: 'c2', name: 'write', arguments: JSON.stringify({ file_path: path.join(dir, 'missing.md') }) },
        }, missingRuntime);
        const missing = translateSessionEvent(session, {
            type: 'tool/result',
            data: { turn: 1, step: 1, message: { toolCallId: 'c2', content: [{ type: 'text', text: 'ok' }] } },
        }, missingRuntime);
        assert.equal(missing[0].artifacts.length, 0, '不存在的文件不是交付物');
    });

    it('deliverables/presented 翻译成交付物事件', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-translate-deliverable-'));
        tempRoots.push(dir);
        const file = path.join(dir, 'out.md');
        fs.writeFileSync(file, 'x');
        const runtime = { turn: 1, lastUserText: '', toolCalls: new Map() };
        const session = { id: 's-del', header: { cwd: dir } };
        const out = translateSessionEvent(session, {
            type: 'deliverables/presented',
            data: { turn: 1, callId: 'c9', files: [{ path: file, description: '报告' }] },
        }, runtime);
        assert.equal(out.length, 1);
        assert.equal(out[0].type, 'deliverable.presented');
        assert.equal(out[0].files[0].value, file);
        assert.equal(out[0].files[0].label, '报告');
    });
});

describe('ResearchTraceService', () => {
    it('摄取一轮事件后落图，同一工作区共享 store', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s1', root);
            const events = [
                { type: 'user/message', data: { id: 'm1', content: [{ type: 'text', text: '调查缓存命中率下降的原因' }] } },
                { type: 'turn/start', data: { turn: 1 } },
                { type: 'assistant/message', data: { turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text: '结论：缓存键设计变化是主要原因，需要先回滚键格式再观察一周。' }] } } },
                { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"stat cache"}' } },
                { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'hit rate 71%' }] } } },
                { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
            ];
            for (const event of events) await service.ingestSessionEvent(session, event);

            const snapshot = await service.snapshotFor(root);
            const kinds = snapshot.nodes.map((node) => node.kind);
            assert.ok(kinds.includes('goal'));
            assert.ok(kinds.includes('step'));
            assert.ok(kinds.includes('action'));
            assert.ok(kinds.includes('conclusion'));
            assert.equal(snapshot.stats.nodes, snapshot.nodes.length);
            assert.ok(snapshot.frontier.suggestions.length > 0);

            const again = await service.registry.get(root);
            assert.equal(again, await service.registry.get(root), '同一 root 必须复用同一个 store');
        } finally {
            await service.dispose();
        }
    });

    it('旧版逐调用动作节点在首次读取时被压缩，产物上移一层', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const store = await service.registry.get(root);
            await store.apply({ t: 'addNode', node: { id: 'n1', parentId: null, kind: 'step', title: '旧轮次', status: 'done', origin: 'auto', sessionId: 's0', turn: 1 } });
            await store.apply({ t: 'addNode', node: { id: 'n2', parentId: 'n1', kind: 'action', title: 'read: a.md', status: 'done', origin: 'auto', sessionId: 's0', turn: 1, fingerprint: 'auto:action:x' } });
            await store.apply({ t: 'addNode', node: { id: 'n3', parentId: 'n2', kind: 'artifact', title: 'out.md', status: 'done', origin: 'auto', sessionId: 's0', turn: 1 } });
            const snap = await service.snapshotFor(root);
            assert.ok(!snap.nodes.some((node) => node.kind === 'action'), '历史逐调用动作节点应被移除');
            const artifact = snap.nodes.find((node) => node.kind === 'artifact');
            assert.ok(artifact, '产物必须保留');
            assert.equal(artifact.parentId, 'n1', '产物的父节点上移到 step');
            // 第二次读取不再重复迁移。
            const again = await service.snapshotFor(root);
            assert.equal(again.stats.nodes, snap.stats.nodes);
        } finally {
            await service.dispose();
        }
    });

    it('turn/start 早于 user/message 的历史图：孤立 step 首次读取时挂回目标', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const store = await service.registry.get(root);
            await store.apply({ t: 'addNode', node: { id: 'n1', parentId: null, kind: 'step', title: '第 1 轮研究', status: 'done', origin: 'auto', sessionId: 's0', turn: 1 } });
            await store.apply({ t: 'addNode', node: { id: 'n2', parentId: null, kind: 'goal', title: '解决这个问题', status: 'active', origin: 'auto', sessionId: 's0', turn: 1 } });
            await store.apply({ t: 'session', sessionId: 's0', goalId: 'n2', activeNodeId: 'n1' });
            const snap = await service.snapshotFor(root);
            const step = snap.nodes.find((node) => node.kind === 'step');
            assert.equal(step.parentId, 'n2', '孤立 step 应挂到本会话目标下');
            const again = await service.snapshotFor(root);
            assert.equal(again.nodes.find((node) => node.kind === 'step').parentId, 'n2', '二次读取不重复迁移');
        } finally {
            await service.dispose();
        }
    });

    it('旧图只有一个长结论时，首次读取按小标题展开成推导节点', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const store = await service.registry.get(root);
            const body = [
                '# 解答',
                '开场说明：解释问题的背景与符号约定，这一段足够长以触发拆段逻辑。',
                '',
                '**记号.** 设 A 为矩阵，D 为对角阵，所有 a_i 非零。',
                '',
                '## 情形一：所有 a_i 非零',
                '此时可用 Sherman–Morrison 公式求出逆矩阵，并给出逐元素表达式。',
                '',
                '## 结论',
                '因此矩阵可逆当且仅当求和不为 -1。',
            ].join('\n').repeat(3);
            const step = await store.apply({ t: 'addNode', node: { parentId: null, kind: 'step', title: '第 1 轮研究', status: 'done', origin: 'auto', sessionId: 's0', turn: 1 } });
            const goal = await store.apply({ t: 'addNode', node: { parentId: null, kind: 'goal', title: '解决这个问题', status: 'active', origin: 'auto', sessionId: 's0', turn: 1 } });
            const conclusion = await store.apply({ t: 'addNode', node: { parentId: step.node.id, kind: 'conclusion', title: '解答 记号', summary: body, status: 'done', origin: 'auto', sessionId: 's0', turn: 1 } });
            await store.apply({ t: 'updateNode', id: conclusion.node.id, patch: { hits: 2 } });
            await store.apply({ t: 'session', sessionId: 's0', goalId: goal.node.id, activeNodeId: step.node.id });
            const snap = await service.snapshotFor(root);
            const stepNode = snap.nodes.find((node) => node.kind === 'step');
            assert.equal(stepNode.parentId, goal.node.id);
            const sections = snap.nodes.filter((node) => Array.isArray(node.tags) && node.tags.includes('section'));
            assert.ok(sections.length >= 2, '应展开出推导节点');
            const expandedConclusion = snap.nodes.find((node) => node.kind === 'conclusion');
            assert.equal(expandedConclusion.title, '结论', '结论标题归一到标题');
            assert.ok(sections.every((node) => node.parentId === step.node.id || sections.some((parent) => parent.id === node.parentId)), '推导节点挂在 step 或主要阶段下');
            const again = await service.snapshotFor(root);
            assert.equal(again.nodes.filter((node) => Array.isArray(node.tags) && node.tags.includes('section')).length, sections.length, '二次读取不重复展开');
        } finally {
            await service.dispose();
        }
    });

    it('HTTP 快照与工作区列表可用，非本机请求被拒', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s1', root);
            await service.ingestSessionEvent(session, { type: 'user/message', data: { content: [{ type: 'text', text: '目标：验证缓存键回滚方案' }] } });

            const snap = await httpGet(service, `/explore-tree/snapshot?workspace=${encodeURIComponent(root)}`);
            assert.equal(snap.status, 200);
            assert.equal(snap.body.ok, true);
            assert.ok(snap.body.nodes.length >= 1);
            assert.equal(typeof snap.body.open.visibleCount, 'number');
            assert.equal(snap.body.stats.openUnresolved, snap.body.open.visibleCount);

            const list = await httpGet(service, '/explore-tree/workspaces');
            assert.equal(list.status, 200);
            assert.ok(list.body.workspaces.some((item) => item.root === root));

            const denied = await httpGet(service, `/explore-tree/snapshot?workspace=${encodeURIComponent(root)}`, '10.0.0.7');
            assert.equal(denied.status, 403);
        } finally {
            await service.dispose();
        }
    });

    it('别名/短路径访问同一工作区时复用 canonical store', async () => {
        const root = makeWorkspace();
        const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-tree-alias-'));
        tempRoots.push(aliasParent);
        const alias = path.join(aliasParent, 'workspace-alias');
        fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s-alias', root);
            await service.ingestSessionEvent(session, {
                type: 'user/message',
                data: { content: [{ type: 'text', text: '目标：别名路径也要看到同一张图' }] },
            });
            const snap = await service.snapshotFor(alias);
            assert.equal(snap.workspace.root, root, '快照应归一到 canonical root');
            assert.ok(snap.nodes.length >= 1);

            const viaHttp = await httpGet(service, `/explore-tree/snapshot?workspace=${encodeURIComponent(alias)}`);
            assert.equal(viaHttp.status, 200);
            assert.equal(viaHttp.body.workspace.root, root);
            assert.equal(viaHttp.body.nodes.length, snap.nodes.length, '两种路径应读同一张图');
        } finally {
            await service.dispose();
        }
    });

    it('工具：add 挂到焦点、update/link/close 生效，reopen 死路必须给理由', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s1', root);
            const exec = { agent: { session } };
            const [readTool, recordTool] = buildToolDefinitions(service);

            await service.ingestSessionEvent(session, { type: 'user/message', data: { content: [{ type: 'text', text: '验证缓存键回滚' }] } });
            const goal = await recordTool.execute({ action: 'add', kind: 'goal', title: '缓存命中率调查' }, exec);
            assert.equal(goal.ok, true);

            const hypothesis = await recordTool.execute({ action: 'add', kind: 'hypothesis', title: '键格式变化导致命中率下降', confidence: 0.8 }, exec);
            assert.equal(hypothesis.ok, true);
            const evidence = await recordTool.execute({ action: 'add', kind: 'evidence', title: '命中率从 95% 降到 71%' }, exec);
            assert.equal(evidence.ok, true);
            assert.equal((await recordTool.execute({ action: 'link', from: evidence.id, to: hypothesis.id, edgeKind: 'supports' }, exec)).ok, true);

            const dead = await recordTool.execute({ action: 'add', kind: 'dead_end', title: '换掉整个缓存层', summary: '成本过高且无法解释 30 秒内的命中率骤降' }, exec);
            assert.equal(dead.ok, true);
            const noReason = await recordTool.execute({ action: 'reopen', id: dead.id }, exec);
            assert.equal(noReason.ok, false);
            const reopened = await recordTool.execute({ action: 'reopen', id: dead.id, reason: '新的火焰图显示缓存淘汰线程锁竞争' }, exec);
            assert.equal(reopened.ok, true);

            const overview = await readTool.execute({ action: 'overview' }, exec);
            assert.equal(overview.ok, true);
            assert.match(overview.text, /缓存/);
            const frontier = await readTool.execute({ action: 'frontier' }, exec);
            assert.equal(frontier.ok, true);
            const found = await readTool.execute({ action: 'find', query: '命中率' }, exec);
            assert.equal(found.ok, true);
            const state = await service.registry.get(root).then((store) => store.current());
            assert.equal(state.edges.length, 1);
        } finally {
            await service.dispose();
        }
    });
});

describe('P0 来源过滤、轮次锚点与交付物', () => {
    it('注入消息不建 goal；真实消息成为 goal 并回填轮次标题', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s-p0-source', root);
            const events = [
                { type: 'turn/start', data: { turn: 1 } },
                { type: 'user/message', data: { id: 'm0', source: { kind: 'user-approval' }, content: [{ type: 'text', text: 'The approval policy changed from "ask" to "never".' }] } },
                { type: 'user/message', data: { id: 'm1', source: { kind: 'time-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1.' }] } },
                { type: 'user/message', data: { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '检索项目进度，优化建树算法' }] } },
                { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
            ];
            for (const event of events) await service.ingestSessionEvent(session, event);

            const snapshot = await service.snapshotFor(root);
            const goals = snapshot.nodes.filter((node) => node.kind === 'goal');
            assert.equal(goals.length, 1, '注入消息不应创建 goal');
            assert.match(goals[0].title, /检索项目进度/);
            assert.ok(goals[0].tags.includes('goal:user'));

            const steps = snapshot.nodes.filter((node) => node.kind === 'step');
            assert.equal(steps.length, 1);
            assert.equal(steps[0].title, '第 1 轮：检索项目进度，优化建树算法', '真实消息回填轮次标题');
            assert.ok(!/Time sampled|approval policy/i.test(steps[0].title));
        } finally {
            await service.dispose();
        }
    });

    it('中途接入：turn/start 复用 midway step，同轮只保留一个', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s-p0-midway', root);
            const events = [
                { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"README.md"}' } },
                { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'README' }] } } },
                { type: 'turn/start', data: { turn: 1 } },
                { type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '先读文档再分析' }] } },
            ];
            for (const event of events) await service.ingestSessionEvent(session, event);

            const snapshot = await service.snapshotFor(root);
            const steps = snapshot.nodes.filter((node) => node.kind === 'step');
            assert.equal(steps.length, 1, 'midway step 应被后续 turn/start 复用而非新建');
            assert.equal(steps[0].title, '第 1 轮：先读文档再分析');
            const state = await service.registry.get(root).then((store) => store.current());
            const stepInState = [...state.nodes.values()].find((node) => node.kind === 'step');
            assert.equal(stepInState.fingerprint, fingerprint('auto:step', 's-p0-midway\u00001'), '指纹应升级为正常轮次指纹');
        } finally {
            await service.dispose();
        }
    });

    it('同轮重复 step 在快照时迁移合并，子节点保留', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const store = await service.registry.get(root);
            const keep = await store.apply({ t: 'addNode', node: { parentId: null, kind: 'step', title: '第 1 轮研究', status: 'active', origin: 'auto', sessionId: 's-dup', turn: 1, fingerprint: fingerprint('auto:step', 's-dup\u00001') } });
            const drop = await store.apply({ t: 'addNode', node: { parentId: null, kind: 'step', title: '第 1 轮（缺少开始事件）', status: 'active', origin: 'auto', sessionId: 's-dup', turn: 1, fingerprint: fingerprint('auto:step:midway', 's-dup\u00001') } });
            const child = await store.apply({ t: 'addNode', node: { parentId: drop.node.id, kind: 'question', title: '挂在中途 step 下的问题', status: 'open', origin: 'auto', sessionId: 's-dup', turn: 1 } });

            const snapshot = await service.snapshotFor(root);
            const steps = snapshot.nodes.filter((node) => node.kind === 'step');
            assert.equal(steps.length, 1);
            assert.equal(steps[0].id, keep.node.id, '保留正常轮次 step');
            assert.equal(snapshot.nodes.find((node) => node.id === child.node.id).parentId, keep.node.id, '子节点随合并迁移');

            const again = await service.snapshotFor(root);
            assert.equal(again.nodes.filter((node) => node.kind === 'step').length, 1, '二次读取不重复迁移');
        } finally {
            await service.dispose();
        }
    });

    it('present 交付物落 artifact；读结果里的路径不再落', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s-p0-deliverable', root);
            const file = path.join(root, '报告.md');
            fs.writeFileSync(file, '# 报告');
            const events = [
                { type: 'turn/start', data: { turn: 1 } },
                { type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '产出一份报告' }] } },
                { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ path: file }) } },
                { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: `# 报告\n${file}` }] } } },
                { type: 'deliverables/presented', data: { turn: 1, callId: 'c2', files: [{ path: file, description: '报告' }] } },
            ];
            for (const event of events) await service.ingestSessionEvent(session, event);

            const snapshot = await service.snapshotFor(root);
            const artifacts = snapshot.nodes.filter((node) => node.kind === 'artifact');
            const fromPresent = artifacts.filter((node) => Array.isArray(node.tags) && node.tags.includes('deliverable'));
            assert.equal(fromPresent.length, 1, '读结果文本里的路径不应生成 artifact');
            assert.equal(fromPresent[0].refs[0].value, file);
            assert.equal(fromPresent[0].title, '报告.md');
            assert.equal(fromPresent[0].summary, '报告');
        } finally {
            await service.dispose();
        }
    });
});

describe('ResearchTraceService 补建', () => {
    it('进入旧会话时回放历史事件，从 reasoning 补建研究树（幂等）', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s-backfill', root);
            session.snapshotEvents = () => [
                { type: 'turn/start', data: { turn: 1 } },
                { type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '解决这个问题' }] } },
                {
                    type: 'assistant/message',
                    data: {
                        turn: 1,
                        step: 1,
                        stream: [],
                        message: { content: [{ type: 'reasoning', text: 'The matrix can be written as A = D + 11^T.\n\nCase 1: all a_i are nonzero, so D is invertible and Sherman-Morrison applies.' }] },
                    },
                },
                { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
            ];
            const handled = await service.backfillSession(session);
            assert.ok(handled >= 4, '应回放轮次事件');
            const snap = await service.snapshotFor(root);
            assert.ok(snap.nodes.some((node) => node.kind === 'goal'));
            assert.equal(snap.nodes.filter((node) => node.kind === 'step').length, 1);
            assert.ok(
                snap.nodes.some((node) => ['question', 'hypothesis', 'evidence', 'decision', 'conclusion', 'dead_end'].includes(node.kind)),
                'reasoning 应产出想法节点',
            );
            const again = await service.backfillSession(session);
            assert.equal(again, 0, '已有 step 的会话不重复回放');
        } finally {
            await service.dispose();
        }
    });
});

describe('plugin apply', () => {
    it('注册两个工具、一个静态提示段、两个会话监听与一个 HTTP 路由', async () => {
        const root = makeWorkspace();
        const { ctx, listeners, routes, tools, sections } = mockContext(root);
        apply(ctx, {});
        assert.equal(tools.length, 2);
        assert.deepEqual(tools.map((tool) => tool.name).sort(), ['explore_tree', 'explore_tree_record']);
        assert.equal(sections.length, 1);
        assert.equal(sections[0].text, PROMPT_TEXT);
        assert.equal(routes.length, 1);
        assert.equal(routes[0].kind, 'prefix');
        assert.equal(routes[0].path, '/explore-tree');
        assert.equal(typeof listeners.get('session/event'), 'function');
        assert.equal(typeof listeners.get('session/created'), 'function');
        assert.equal(typeof listeners.get('agent/pre-step'), 'function');

        const session = makeSession('s-plugin', root);
        listeners.get('session/event')(session, { type: 'user/message', data: { content: [{ type: 'text', text: '目标：插件装配测试' }] } });
        const journalPath = path.join(root, '.explore-tree', 'journal.jsonl');
        await waitFor(() => {
            if (!fs.existsSync(journalPath)) return false;
            try {
                return fs.readFileSync(journalPath, 'utf8').includes('addNode');
            } catch {
                return false;
            }
        });
        const journal = fs.readFileSync(journalPath, 'utf8');
        assert.match(journal, /addNode/);
    });

    it('config.enabled=false 时不注册任何东西', () => {
        const { ctx, tools, sections, routes } = mockContext(makeWorkspace());
        apply(ctx, { enabled: false });
        assert.equal(tools.length, 0);
        assert.equal(sections.length, 0);
        assert.equal(routes.length, 0);
    });
});

async function waitFor(predicate, timeoutMs = 2000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('等待超时');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('全局工作区索引', () => {
    it('无对话/无 registry 也能通过索引列出历史图并打开快照', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        await service.ingestSessionEvent(makeSession('s1', root), {
            type: 'user/message',
            data: { content: [{ type: 'text', text: '目标：重启后不用点开对话也能看研究图' }] },
        });
        await service.snapshotFor(root);
        await service.dispose();

        const bare = new ResearchTraceService(
            { ...ctx, workspaceRegistry: { list: () => [] } },
            normalizeConfig({}),
            silentLogger,
        );
        try {
            const list = await bare.listWorkspaces();
            assert.ok(list.some((item) => item.root === root), '索引应记住历史工作区');
            const snap = await httpGet(bare, `/explore-tree/snapshot?workspace=${encodeURIComponent(root)}`);
            assert.equal(snap.status, 200);
            assert.ok(snap.body.nodes.length >= 1);
        } finally {
            await bare.dispose();
        }
    });
});
describe('P4 工具易用性', () => {
    it('add 可一次建一层子节点，省去父子往返', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s1', root);
            const exec = { agent: { session } };
            const [, recordTool] = buildToolDefinitions(service);
            const goal = await recordTool.execute({
                action: 'add',
                kind: 'goal',
                title: '缓存命中率调查',
                parentId: '',
                children: [
                    { kind: 'hypothesis', title: '键格式变化导致命中率下降', summary: '最近改了序列化' },
                    { kind: 'evidence', title: '命中率从 95% 降到 71%', summary: '监控面板' },
                ],
            }, exec);
            assert.equal(goal.ok, true);
            assert.equal(goal.children.length, 2);
            const snapshot = await service.snapshotFor(root);
            assert.equal(snapshot.nodes.find((node) => node.id === goal.children[0].id).parentId, goal.id);
            assert.equal(snapshot.nodes.find((node) => node.id === goal.children[1].id).parentId, goal.id);
        } finally {
            await service.dispose();
        }
    });

    it('overview 只汇总当前会话，不重贴别的会话历史', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const sessionA = makeSession('s-a', root);
            const sessionB = makeSession('s-b', root);
            await service.ingestSessionEvent(sessionA, { type: 'user/message', data: { content: [{ type: 'text', text: '会话甲的研究目标' }] } });
            await service.ingestSessionEvent(sessionB, { type: 'user/message', data: { content: [{ type: 'text', text: '会话乙的研究目标' }] } });
            const [readTool] = buildToolDefinitions(service);
            const overviewA = await readTool.execute({ action: 'overview' }, { agent: { session: sessionA } });
            assert.equal(overviewA.ok, true);
            assert.match(overviewA.text, /会话甲/);
            assert.doesNotMatch(overviewA.text, /会话乙/);
        } finally {
            await service.dispose();
        }
    });

    it('P4：archive 隐藏叶根、trunk archived 可查，rollback 恢复历史摘要', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s1', root);
            const exec = { agent: { session } };
            const [readTool, recordTool] = buildToolDefinitions(service);
            const goal = await recordTool.execute({ action: 'add', kind: 'goal', title: '研究主干', parentId: '' }, exec);
            const topic = await recordTool.execute({ action: 'add', kind: 'topic', title: '处理面板结构问题', parentId: goal.id }, exec);
            const leaf = await recordTool.execute({ action: 'add', kind: 'hypothesis', title: '节点详情过长', parentId: topic.id }, exec);
            assert.equal(topic.ok && leaf.ok, true);

            await recordTool.execute({ action: 'digest', id: topic.id, digest: '摘要 v1' }, exec);
            await recordTool.execute({ action: 'digest', id: topic.id, digest: '摘要 v2' }, exec);
            const found = await readTool.execute({ action: 'find', query: '摘要 v2' }, exec);
            assert.match(found.text, /处理面板结构问题/);
            assert.match((await readTool.execute({ action: 'trunk' }, exec)).text, /节点详情过长/);

            const archived = await recordTool.execute({ action: 'archive', id: leaf.id }, exec);
            assert.equal(archived.ok, true);
            assert.doesNotMatch((await readTool.execute({ action: 'trunk' }, exec)).text, /节点详情过长/);
            assert.match((await readTool.execute({ action: 'trunk', archived: true }, exec)).text, /节点详情过长/);

            const rolled = await recordTool.execute({ action: 'rollback', id: topic.id, version: 1 }, exec);
            assert.equal(rolled.ok, true);
            const snapshot = await service.snapshotFor(root);
            const after = snapshot.nodes.find((node) => node.id === topic.id);
            assert.equal(after.digest, '摘要 v1');
            assert.ok(after.digestHistory.length >= 2);
        } finally {
            await service.dispose();
        }
    });

it('find 命中摘要时给出片段提示', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s1', root);
            const exec = { agent: { session } };
            const [readTool, recordTool] = buildToolDefinitions(service);
            const goal = await recordTool.execute({ action: 'add', kind: 'goal', title: '缓存排查', parentId: '' }, exec);
            await recordTool.execute({
                action: 'add',
                parentId: goal.id,
                kind: 'note',
                title: '观察',
                summary: 'LRU 淘汰顺序可疑：先淘汰了最新键',
            }, exec);
            const found = await readTool.execute({ action: 'find', query: 'LRU' }, exec);
            assert.equal(found.ok, true);
            assert.match(found.text, /LRU 淘汰顺序可疑/);
        } finally {
            await service.dispose();
        }
    });
});

describe('P5 摘要主干与叶节点', () => {
    it('topic/叶根写入后 trunk/brief 带 digest；assign/promote/digest 生效', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s-p5', root);
            const exec = { agent: { session } };
            const [readTool, recordTool] = buildToolDefinitions(service);

            const goal = await recordTool.execute({ action: 'add', kind: 'goal', title: '研究轨迹插件', parentId: '' }, exec);
            assert.equal(goal.ok, true);
            const topic = await recordTool.execute({ action: 'add', kind: 'topic', parentId: goal.id, title: '建树算法' }, exec);
            assert.equal(topic.ok, true);
            const leaf = await recordTool.execute({ action: 'add', kind: 'question', parentId: topic.id, title: '配额为何先到先得？' }, exec);
            assert.equal(leaf.ok, true);
            const evidence = await recordTool.execute({ action: 'add', kind: 'evidence', parentId: leaf.id, title: '回放 97.8% 通过' }, exec);
            assert.equal(evidence.ok, true);

            const trunk = await readTool.execute({ action: 'trunk' }, exec);
            assert.equal(trunk.ok, true);
            assert.match(trunk.text, /1 个主题/);
            assert.match(trunk.text, /建树算法/);
            assert.match(trunk.text, /配额为何先到先得/);

            const brief = await readTool.execute({ action: 'brief' }, exec);
            assert.equal(brief.ok, true);
            assert.match(brief.text, /【研究轨迹简报】/);
            assert.match(brief.text, /建树算法/);
            assert.ok(brief.text.length <= 400, `brief 应 ≤400 字，实际 ${brief.text.length}`);

            const assigned = await recordTool.execute({ action: 'assign', id: topic.id, owner: 'agent-1' }, exec);
            assert.equal(assigned.ok, true);
            let snapshot = await service.snapshotFor(root);
            assert.equal(snapshot.nodes.find((node) => node.id === topic.id).owner, 'agent-1');
            assert.equal(typeof snapshot.nodes.find((node) => node.id === topic.id).leaseUntil, 'string');

            const human = await recordTool.execute({ action: 'digest', id: topic.id, digest: '人工摘要：先到先得挤掉后段结论' }, exec);
            assert.equal(human.ok, true);
            snapshot = await service.snapshotFor(root);
            assert.equal(snapshot.nodes.find((node) => node.id === topic.id).digest, '人工摘要：先到先得挤掉后段结论');
            assert.equal(snapshot.nodes.find((node) => node.id === topic.id).digestSource, 'human');

            const child = await recordTool.execute({ action: 'add', kind: 'question', parentId: topic.id, title: '是否该引入 MMR？' }, exec);
            assert.equal(child.ok, true);
            const promoted = await recordTool.execute({ action: 'promote', id: child.id, parentId: topic.id }, exec);
            assert.equal(promoted.ok, true);
            snapshot = await service.snapshotFor(root);
            const promotedNode = snapshot.nodes.find((node) => node.id === child.id);
            assert.equal(promotedNode.kind, 'topic');
            assert.equal(promotedNode.parentId, topic.id);
            assert.equal(typeof promotedNode.digest, 'string');

            const step = await recordTool.execute({ action: 'add', kind: 'step', parentId: goal.id, title: '第 1 轮研究' }, exec);
            assert.equal(step.ok, true);
            const misplaced = await recordTool.execute({ action: 'add', kind: 'topic', parentId: step.id, title: '错位主干' }, exec);
            assert.equal(misplaced.ok, true);
            snapshot = await service.snapshotFor(root);
            assert.equal(snapshot.nodes.find((node) => node.id === misplaced.id).parentId, goal.id, 'topic 不应挂在 step 下');
        } finally {
            await service.dispose();
        }
    });

    it('P5.1/P5.2：CAS 返回 STALE_REVISION，写域/租约/抢占可判别', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s-p5-cas', root);
            const exec = { agent: { session } };
            const [readTool, recordTool] = buildToolDefinitions(service);
            const leaseUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();

            const goal = await recordTool.execute({ action: 'add', kind: 'goal', title: '多 agent 协作', parentId: '' }, exec);
            const topic = await recordTool.execute({
                action: 'add', kind: 'topic', parentId: goal.id, title: '写域与版本',
                actor: 'agent-a', owner: 'agent-a', leaseUntil,
            }, exec);
            assert.equal(topic.ok, true);
            let snapshot = await service.snapshotFor(root);
            let topicNode = snapshot.nodes.find((node) => node.id === topic.id);
            assert.equal(topicNode.createdBy, 'agent-a');
            assert.equal(topicNode.updatedBy, 'agent-a');
            const detail = await readTool.execute({ action: 'node', id: topic.id }, exec);
            assert.match(detail.text, /nodeVersion \d+/);
            assert.match(detail.text, /leaseEpoch 0/);
            assert.match(detail.text, /agent-a/);

            const outsider = await recordTool.execute({ action: 'add', kind: 'question', parentId: topic.id, title: '越界写', actor: 'agent-b' }, exec);
            assert.equal(outsider.ok, false);
            assert.equal(outsider.code, 'OUT_OF_SCOPE');
            assert.equal(outsider.id, topic.id, 'LeaseError 必须带可序列化的 id（回退 topicId）');
            assert.equal(outsider.topicId, topic.id);
            assert.match(outsider.text, /agent-a/);

            const inside = await recordTool.execute({ action: 'add', kind: 'question', parentId: topic.id, title: '域内写', actor: 'agent-a' }, exec);
            assert.equal(inside.ok, true);

            const held = await recordTool.execute({ action: 'assign', id: topic.id, owner: 'agent-b', actor: 'agent-b' }, exec);
            assert.equal(held.ok, false);
            assert.equal(held.code, 'LEASE_HELD');

            const stolen = await recordTool.execute({ action: 'assign', id: topic.id, owner: 'agent-b', actor: 'lead', steal: true }, exec);
            assert.equal(stolen.ok, true);
            assert.equal(stolen.owner, 'agent-b');
            const stolenEpoch = stolen.leaseEpoch;

            const denied = await recordTool.execute({ action: 'update', id: topic.id, title: '旧 owner 改标题', actor: 'agent-a' }, exec);
            assert.equal(denied.ok, false);
            assert.equal(denied.code, 'OUT_OF_SCOPE');

            snapshot = await service.snapshotFor(root);
            const before = snapshot.nodes.find((node) => node.id === topic.id).nodeVersion;
            const stale = await recordTool.execute({
                action: 'update', id: topic.id, title: '过期版本', actor: 'lead', expectedRevision: before + 5,
            }, exec);
            assert.equal(stale.ok, false);
            assert.equal(stale.code, 'STALE_REVISION');
            assert.equal(stale.currentVersion, before);

            const updated = await recordTool.execute({
                action: 'update', id: topic.id, title: '正确版本', actor: 'lead', expectedRevision: before,
            }, exec);
            assert.equal(updated.ok, true);
            snapshot = await service.snapshotFor(root);
            assert.equal(snapshot.nodes.find((node) => node.id === topic.id).updatedBy, 'lead');
            assert.equal(snapshot.nodes.find((node) => node.id === topic.id).title, '正确版本');

            const renewed = await recordTool.execute({ action: 'assign', id: topic.id, actor: 'agent-b', renew: true }, exec);
            assert.equal(renewed.ok, true);
            assert.equal(renewed.leaseEpoch, stolenEpoch + 1);

            const released = await recordTool.execute({ action: 'assign', id: topic.id, actor: 'agent-b', owner: '' }, exec);
            assert.equal(released.ok, true);
            assert.equal(released.owner, null);
            assert.equal(released.leaseEpoch, renewed.leaseEpoch + 1);

            const afterRelease = await recordTool.execute({ action: 'add', kind: 'question', parentId: topic.id, title: '释放后可写', actor: 'agent-b' }, exec);
            assert.equal(afterRelease.ok, true);
        } finally {
            await service.dispose();
        }
    });

    it('P5.4：handoff 原子转移租约并写交接包', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s-p5-handoff', root);
            const exec = { agent: { session } };
            const [readTool, recordTool] = buildToolDefinitions(service);
            const leaseUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();

            const goal = await recordTool.execute({ action: 'add', kind: 'goal', title: '交接实验', parentId: '' }, exec);
            const topic = await recordTool.execute({
                action: 'add', kind: 'topic', parentId: goal.id, title: '待接手主题',
                actor: 'agent-a', owner: 'agent-a', leaseUntil,
            }, exec);
            const leaf = await recordTool.execute({
                action: 'add', kind: 'question', parentId: topic.id, title: '未决问题', actor: 'agent-a',
            }, exec);
            assert.equal(leaf.ok, true);

            const outsider = await recordTool.execute({ action: 'handoff', id: topic.id, toActor: 'agent-c', actor: 'agent-b' }, exec);
            assert.equal(outsider.ok, false);
            assert.equal(outsider.code, 'OUT_OF_SCOPE');

            const same = await recordTool.execute({ action: 'handoff', id: topic.id, toActor: 'agent-a', actor: 'agent-a' }, exec);
            assert.equal(same.ok, false);
            assert.equal(same.code, 'SAME_ACTOR');

            const handed = await recordTool.execute({ action: 'handoff', id: topic.id, toActor: 'agent-b', actor: 'agent-a' }, exec);
            assert.equal(handed.ok, true);
            assert.equal(handed.owner, 'agent-b');
            assert.equal(handed.leaseEpoch, 1);
            assert.ok(handed.handoffId);

            const snapshot = await service.snapshotFor(root);
            const after = snapshot.nodes.find((node) => node.id === topic.id);
            const handoffNode = snapshot.nodes.find((node) => node.id === handed.handoffId);
            assert.equal(after.owner, 'agent-b');
            assert.equal(after.leaseEpoch, 1);
            assert.equal(handoffNode.kind, 'conclusion');
            assert.equal(handoffNode.parentId, topic.id);
            assert.ok(handoffNode.tags.includes('handoff'));
            assert.equal(handoffNode.createdBy, 'agent-a');
            assert.match(handoffNode.summary, /待接手主题/);
            assert.match(handoffNode.summary, new RegExp(leaf.id));
            assert.match(handoffNode.summary, /agent-a → agent-b/);

            const oldOwner = await recordTool.execute({ action: 'add', kind: 'question', parentId: topic.id, title: '旧 owner 继续写', actor: 'agent-a' }, exec);
            assert.equal(oldOwner.ok, false);
            assert.equal(oldOwner.code, 'OUT_OF_SCOPE');
            const newOwner = await recordTool.execute({ action: 'add', kind: 'question', parentId: topic.id, title: '新 owner 接手写', actor: 'agent-b' }, exec);
            assert.equal(newOwner.ok, true);

            const detail = await readTool.execute({ action: 'node', id: handed.handoffId }, exec);
            assert.match(detail.text, /handoff/);
        } finally {
            await service.dispose();
        }
    });
});

describe('P1 轮首简报注入', () => {
    it('有 topic 时 injectBrief 追加一条带 source 的消息，同一轮只注入一次', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s-brief', root);
            const exec = { agent: { session } };
            const [, recordTool] = buildToolDefinitions(service);
            const goal = await recordTool.execute({ action: 'add', kind: 'goal', title: '研究轨迹插件', parentId: '' }, exec);
            assert.equal(goal.ok, true);
            const topic = await recordTool.execute({ action: 'add', kind: 'topic', parentId: goal.id, title: '建树算法' }, exec);
            assert.equal(topic.ok, true);
            await recordTool.execute({ action: 'add', kind: 'question', parentId: topic.id, title: '配额为何先到先得？' }, exec);

            const decision = { messages: [{ role: 'user', content: [] }] };
            const injected = await service.injectBrief(decision, { session, turn: 1, step: 1 });
            assert.equal(injected.messages.length, 2);
            const message = injected.messages[1];
            assert.equal(message.role, 'user');
            assert.equal(message.source.kind, 'explore-tree-context');
            assert.equal(message.source.form, 'snapshot');
            assert.match(message.content[0].text, /研究轨迹简报/);
            assert.match(message.content[0].text, /建树算法/);

            const again = await service.injectBrief(injected, { session, turn: 1, step: 2 });
            assert.equal(again.messages.length, 2, '同一轮不重复注入');

            await recordTool.execute({ action: 'add', kind: 'decision', parentId: topic.id, title: '先到先得改为配额', status: 'done' }, exec);
            const nextTurn = await service.injectBrief(decision, { session, turn: 2, step: 1 });
            assert.equal(nextTurn.messages.length, 2, '有变化时新一轮注入增量');
            assert.match(nextTurn.messages[1].content[0].text, /研究轨迹增量/);
            assert.match(nextTurn.messages[1].content[0].text, /先到先得改为配额/);

            await service.ingestSessionEvent(session, { type: 'compaction/end', data: { turn: 2 } });
            const afterCompaction = await service.injectBrief(nextTurn, { session, turn: 2, step: 2 });
            assert.equal(afterCompaction.messages.length, 3, 'compaction 后强制补一次');
        } finally {
            await service.dispose();
        }
    });

    it('没有 goal 时原样返回；有 goal 但无 topic 时注入完整简报', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s-brief-empty', root);
            const decision = { messages: [] };
            const injected = await service.injectBrief(decision, { session, turn: 1, step: 1 });
            assert.deepEqual(injected, decision, '空图没有 goal，不注入');

            const exec = { agent: { session } };
            const [, recordTool] = buildToolDefinitions(service);
            const goal = await recordTool.execute({ action: 'add', kind: 'goal', title: '没有主干的目标', parentId: '' }, exec);
            assert.equal(goal.ok, true);
            const withGoal = await service.injectBrief(decision, { session, turn: 1, step: 1 });
            assert.equal(withGoal.messages.length, 1);
            assert.match(withGoal.messages[0].content[0].text, /研究轨迹简报/);
            assert.match(withGoal.messages[0].content[0].text, /主干：尚未建立/);
        } finally {
            await service.dispose();
        }
    });

    it('下一轮只注入增量：新增/完成/放弃，无变化不重复', async () => {
        const root = makeWorkspace();
        const { ctx } = mockContext(root);
        const service = new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
        try {
            const session = makeSession('s-brief-delta', root);
            const exec = { agent: { session } };
            const [, recordTool] = buildToolDefinitions(service);
            const goal = await recordTool.execute({ action: 'add', kind: 'goal', title: '增量简报', parentId: '' }, exec);
            const topic = await recordTool.execute({ action: 'add', kind: 'topic', parentId: goal.id, title: '缓存' }, exec);
            const question = await recordTool.execute({ action: 'add', kind: 'question', parentId: topic.id, title: '缓存键是否会失效？' }, exec);
            const decision = { messages: [{ role: 'user', content: [] }] };

            const full = await service.injectBrief(decision, { session, turn: 1, step: 1 });
            assert.equal(full.messages.length, 2);
            assert.match(full.messages[1].content[0].text, /研究轨迹简报/);

            await recordTool.execute({ action: 'add', kind: 'conclusion', parentId: topic.id, title: '缓存键会随版本变化', status: 'done' }, exec);
            await recordTool.execute({ action: 'close', id: question.id, reason: '已通过实验确认' }, exec);
            const delta = await service.injectBrief(decision, { session, turn: 2, step: 1 });
            assert.equal(delta.messages.length, 2);
            const text = delta.messages[1].content[0].text;
            assert.match(text, /研究轨迹增量/);
            assert.match(text, /缓存键会随版本变化/);
            assert.match(text, /完成：/);
            assert.doesNotMatch(text, /【研究轨迹简报】/);

            const sameTurn = await service.injectBrief(delta, { session, turn: 2, step: 2 });
            assert.equal(sameTurn.messages.length, 2, '同一轮不重复注入');

            const noChange = await service.injectBrief(decision, { session, turn: 3, step: 1 });
            assert.deepEqual(noChange, decision, '没有新增/状态变化时跳过注入');

            await recordTool.execute({ action: 'add', kind: 'decision', parentId: topic.id, title: '下一轮改用 LRU', status: 'done' }, exec);
            const afterEmptyDelta = await service.injectBrief(decision, { session, turn: 3, step: 2 });
            assert.deepEqual(afterEmptyDelta, decision, '空增量的轮次已检查，后续 step 不再补推');

            const next = await service.injectBrief(decision, { session, turn: 4, step: 1 });
            assert.equal(next.messages.length, 2);
            assert.match(next.messages[1].content[0].text, /下一轮改用 LRU/);
        } finally {
            await service.dispose();
        }
    });
});

function httpGet(service, url, remoteAddress = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'GET',
            url,
            socket: { remoteAddress },
        };
        let body = '';
        const res = {
            statusCode: 0,
            setHeader() {},
            end(chunk) {
                body += chunk;
                try {
                    resolve({ status: this.statusCode, body: JSON.parse(body) });
                } catch (error) {
                    reject(error);
                }
            },
        };
        service.handleHttp(req, res).catch(reject);
    });
}
