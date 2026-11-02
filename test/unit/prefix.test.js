/**
 * 前缀稳定回归（需求 6）。
 *
 * 契约：研究图怎么变，都不允许影响「已发送请求的前缀」——也就是：
 *  - 系统提示段落逐字节不变（静态文本，不读图状态）；
 *  - 两个工具的 name/description/parameters 序列化结果不变；
 *  - 图状态只经 `explore_tree` 的返回值出现。
 *
 * 这里用两次装配 + 中途改图来断言，不依赖真实宿主。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../../src/host/config.js';
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, PROMPT_TEXT } from '../../src/host/prompt.js';
import { ResearchTraceService } from '../../src/host/service.js';
import { buildToolDefinitions } from '../../src/host/tools.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeService(root) {
    const ctx = {
        logger: silentLogger,
        workingDirectory: { get: () => root, defaultDirectory: root },
        workspaceRegistry: { list: () => [{ id: 'w1', path: root, title: 'prefix-test' }] },
    };
    return new ResearchTraceService(ctx, normalizeConfig({}), silentLogger);
}

/** 工具面签名：只取真正会进模型提示的字段（ToolSchema whitelist）。 */
function toolSurface(definitions) {
    return JSON.stringify(
        definitions.map((definition) => ({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
        })),
    );
}

describe('前缀稳定契约', () => {
    it('提示段是静态文本', () => {
        assert.equal(PROMPT_SECTION_NAME, 'explore-tree:protocol');
        assert.equal(PROMPT_SECTION_ORDER, 4900);
        assert.ok(PROMPT_TEXT.length > 200);
        // 不含模板占位、时间戳、工作区绝对路径、节点 id 这类动态内容。
        assert.ok(!PROMPT_TEXT.includes('{{'));
        assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(PROMPT_TEXT), '提示段不得含时间戳');
        assert.ok(!/\.explore-tree|D:\\\\|[A-Z]:\\/.test(PROMPT_TEXT), '提示段不得含工作区路径');
        assert.ok(!/\bn\d+\b/.test(PROMPT_TEXT), '提示段不得含节点 id');
    });

    it('图变化前后工具面与提示段逐字节不变', async (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-tree-prefix-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const service = makeService(root);
        try {
            const before = toolSurface(buildToolDefinitions(service));
            const promptBefore = PROMPT_TEXT;

            const session = { id: 's1', header: { cwd: root } };
            const events = [
                { type: 'user/message', data: { id: 'm1', content: [{ type: 'text', text: '调查前缀稳定性与缓存命中率的关系' }] } },
                { type: 'turn/start', data: { turn: 1 } },
                { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"docs/design.md"}' } },
                { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: '设计文档内容' }] } } },
                { type: 'assistant/message', data: { turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text: '结论：静态提示段与固定工具面保证前缀稳定，动态图状态只走工具返回值，因此缓存可以持续命中。' }] } } },
                { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
            ];
            for (const event of events) await service.ingestSessionEvent(session, event);

            const snapshot = await service.snapshotFor(root);
            assert.ok(snapshot.stats.nodes >= 3, '图应已增长');

            const after = toolSurface(buildToolDefinitions(service));
            assert.equal(after, before, '图增长后工具面必须逐字节一致');
            assert.equal(PROMPT_TEXT, promptBefore, '提示段必须逐字节一致');
        } finally {
            await service.dispose();
        }
    });

    it('工具返回值才携带动态图状态', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-tree-prefix-'));
        try {
            const service = makeService(root);
            try {
                const session = { id: 's1', header: { cwd: root } };
                await service.ingestSessionEvent(session, {
                    type: 'user/message',
                    data: { id: 'm1', content: [{ type: 'text', text: '一个会被工具返回的动态目标文本' }] },
                });
                const definitions = buildToolDefinitions(service);
                const readTool = definitions.find((definition) => definition.name === 'explore_tree');
                assert.ok(readTool);
                const result = await readTool.execute({ action: 'overview' }, { callId: 'c1', name: 'explore_tree' });
                assert.ok(JSON.stringify(result).includes('一个会被工具返回的动态目标文本'));
                // 值本身不进 schema。
                assert.ok(!JSON.stringify(readTool.parameters).includes('一个会被工具返回的动态目标文本'));
            } finally {
                await service.dispose();
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});


