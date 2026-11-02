import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ResearchExtractor } from '../../src/core/extract.js';
import { WorkspaceGraphStore } from '../../src/core/store.js';

const SESSION = 'llm-s1';

function make(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-llm-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
}

test('LLM 辅助：轮末异步补 claim，父节点与指纹去重生效', async (t) => {
    const store = make(t);
    const calls = [];
    const extractor = new ResearchExtractor({
        store,
        config: { llm: { enabled: true, provider: 'p', model: 'm', maxClaims: 4 } },
        logger: { warn: () => {}, error: () => {} },
        llmExtract: async (payload) => {
            calls.push(payload);
            return [
                { kind: 'hypothesis', title: '配额先到先得导致结论进不来', summary: '24 个槽位被过程旁白占满' },
                { kind: 'evidence', title: '第 1 轮 965 条通过只有 3 条高价值', summary: '回放统计', parentId: payload.stepId },
            ];
        },
    });
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '优化建树算法' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    const reasoning = '假设：固定 24 个配额且按事件顺序先到先得，会让真正重要的结论被前面的过程旁白挤掉。'.repeat(6);
    await extractor.handle({ type: 'assistant.reasoning', sessionId: SESSION, turn: 1, text: reasoning });
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1 });
    await extractor.settleLlm();

    assert.equal(calls.length, 1, '轮末应调用一次 LLM');
    assert.equal(calls[0].intent, '优化建树算法');
    assert.ok(calls[0].reasoning.includes('先到先得'));
    assert.equal(calls[0].stepId.startsWith('n'), true);
    const step = [...store.state.nodes.values()].find((node) => node.kind === 'step');
    const llmNodes = [...store.state.nodes.values()].filter((node) => (node.tags ?? []).includes('llm'));
    assert.equal(llmNodes.length, 2);
    assert.ok(llmNodes.every((node) => node.parentId === step.id || store.state.nodes.get(node.parentId)?.kind === 'hypothesis'));
    assert.ok(llmNodes.every((node) => node.origin === 'auto' && node.sessionId === SESSION));

    await extractor.handle({ type: 'assistant.reasoning', sessionId: SESSION, turn: 1, text: reasoning });
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1 });
    await extractor.settleLlm();
    const after = [...store.state.nodes.values()].filter((node) => (node.tags ?? []).includes('llm'));
    assert.equal(after.length, 2, '同样 claim 再来一次不重复造节点');
    assert.ok(after.every((node) => node.hits >= 2));
});

test('LLM 辅助默认关闭：不调用也不建 llm 节点', async (t) => {
    const store = make(t);
    let calls = 0;
    const extractor = new ResearchExtractor({
        store,
        logger: { warn: () => {}, error: () => {} },
        llmExtract: async () => {
            calls += 1;
            return [];
        },
    });
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '默认不调用模型' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    await extractor.handle({ type: 'assistant.reasoning', sessionId: SESSION, turn: 1, text: '推理内容'.repeat(80) });
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1 });
    await extractor.settleLlm();
    assert.equal(calls, 0);
    assert.equal([...store.state.nodes.values()].filter((node) => (node.tags ?? []).includes('llm')).length, 0);
});

test('LLM digest：开启 llm.digest 后轮末重写 topic 摘要，人工摘要不被覆盖', async (t) => {
    const store = make(t);
    const calls = [];
    const extractor = new ResearchExtractor({
        store,
        config: {
            autoSeedTopic: true,
            topicSeedMinClaims: 1,
            llm: { enabled: true, provider: 'p', model: 'm', digest: true, maxClaims: 1 },
        },
        logger: { warn: () => {}, error: () => {} },
        digestWriter: async (payload) => {
            calls.push(payload);
            return '  模型生成的摘要：配额按信息量分层  ';
        },
    });
    await extractor.handle({ type: 'user.message', sessionId: SESSION, text: '优化建树算法' });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 1 });
    const reasoning = '假设：固定 24 个配额且按事件顺序先到先得，会让真正重要的结论被过程旁白挤掉，因此应当分层配额。';
    await extractor.handle({ type: 'assistant.reasoning', sessionId: SESSION, turn: 1, text: reasoning });
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 1 });
    await extractor.settleLlm();

    assert.equal(calls.length, 1);
    const topic = [...store.state.nodes.values()].find((node) => node.kind === 'topic');
    assert.ok(topic !== undefined, '应自动种子出 topic');
    assert.equal(topic.digest, '模型生成的摘要：配额按信息量分层');
    assert.equal(topic.digestSource, 'llm');

    // 人工摘要优先：再次轮末不应调用写手覆盖
    await store.apply({ t: 'updateNode', id: topic.id, patch: { digest: '人工确认的摘要', digestSource: 'human' } });
    await extractor.handle({ type: 'turn.start', sessionId: SESSION, turn: 2 });
    await extractor.handle({ type: 'turn.end', sessionId: SESSION, turn: 2 });
    await extractor.settleLlm();
    assert.equal(calls.length, 1);
    assert.equal(store.state.nodes.get(topic.id).digest, '人工确认的摘要');
});
