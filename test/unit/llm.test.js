import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../../src/host/config.js';
import { buildDigestPrompt, buildExtractPrompt, callLlmText, parseExtractResponse, summarizeTopicWithLlm } from '../../src/host/llm.js';

function fakeLlm(chunks) {
    const calls = [];
    const llm = {
        async prepareCall(config, signal) {
            calls.push({ config, signal });
            assert.ok(signal === undefined || typeof signal.throwIfAborted === 'function');
            return {
                config,
                stream: async function* stream(options) {
                    calls.push({ options });
                    for (const chunk of chunks) yield chunk;
                },
            };
        },
    };
    return { llm, calls };
}

test('parseExtractResponse：容错代码块、过滤非法 kind、限制条数与父节点', () => {
    const text = '```json\n{"claims":[\n'
        + '{"kind":"hypothesis","title":"缓存失配源于工具顺序","summary":"diff 显示 system 段多了 214 字节","parentId":"n12"},\n'
        + '{"kind":"goal","title":"非法类型不应落库"},\n'
        + '{"kind":"evidence","title":"  "},\n'
        + '{"kind":"evidence","title":"请求前缀多了 214 字节","parentId":"not-a-node"}\n'
        + ']}\n```';
    const claims = parseExtractResponse(text, 5);
    assert.equal(claims.length, 2);
    assert.equal(claims[0].kind, 'hypothesis');
    assert.equal(claims[0].parentId, 'n12');
    assert.equal(claims[1].parentId, null, '非法 parentId 要丢掉');
    assert.ok(parseExtractResponse('not json').length === 0);
    assert.ok(parseExtractResponse('{"claims":[{"kind":"hypothesis","title":"a"},{"kind":"hypothesis","title":"b"}]}', 1).length === 1);
});

test('buildExtractPrompt：包含意图、已有节点与推理摘录', () => {
    const prompt = buildExtractPrompt({
        intent: '优化建树算法',
        reasoning: '假设：配额先到先得导致后面真正重要的结论进不来。'.repeat(6),
        claims: [{ id: 'n3', kind: 'hypothesis', title: '配额先到先得' }],
        maxClaims: 4,
        maxInputChars: 2000,
    });
    assert.ok(prompt.includes('优化建树算法'));
    assert.ok(prompt.includes('n3 hypothesis: 配额先到先得'));
    assert.ok(prompt.includes('最多 4 条'));
    assert.ok(prompt.includes('推理摘录'));
});

test('callLlmText：走宿主 llm 服务并用 text-delta 拼出回复', async () => {
    const { llm, calls } = fakeLlm([
        { type: 'text-delta', text: '{"claims":[' },
        { type: 'text-delta', text: '{"kind":"conclusion","title":"固定工具面"}]}' },
        { type: 'finish', reason: { kind: 'stop' } },
    ]);
    const text = await callLlmText({ llm, provider: 'deepseek', model: 'chat', prompt: 'hi', system: 'sys' });
    assert.ok(text.includes('固定工具面'));
    assert.equal(calls[0].config.provider, 'deepseek');
    assert.equal(calls[0].config.model, 'chat');
    assert.equal(calls[1].options.messages[0].role, 'user');
    assert.equal(calls[1].options.system, 'sys');
});

test('callLlmText：终端 finish 为 error 时抛错', async () => {
    const { llm } = fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota exceeded' } } }]);
    await assert.rejects(() => callLlmText({ llm, provider: 'p', model: 'm', prompt: 'hi' }), /quota/);
});

test('normalizeConfig：llm 字段收敛与默认值', () => {
    const defaults = normalizeConfig({});
    assert.equal(defaults.llm.enabled, false);
    assert.equal(defaults.llm.maxClaims, 6);
    const custom = normalizeConfig({ llm: { enabled: true, provider: ' deepseek ', model: 'chat', maxClaims: 99, timeoutMs: 10, unknown: 1 } });
    assert.equal(custom.llm.enabled, true);
    assert.equal(custom.llm.provider, 'deepseek');
    assert.equal(custom.llm.model, 'chat');
    assert.equal(custom.llm.maxClaims, 20, '超界值收敛到上限');
    assert.equal(custom.llm.timeoutMs, 1000, '低于下限收敛');
});

test('summarizeTopicWithLlm：清洗代码块并截断到 120 字', async () => {
    const { llm, calls } = fakeLlm([
        { type: 'text-delta', text: '```\n核心结论：' },
        { type: 'text-delta', text: '长'.repeat(140) + '\n```' },
        { type: 'finish', reason: { kind: 'stop' } },
    ]);
    const digest = await summarizeTopicWithLlm({
        llm,
        config: { provider: 'deepseek', model: 'chat', timeoutMs: 5000, maxOutputTokens: 300 },
        topic: { title: '处理面板结构问题' },
        children: [{ kind: 'hypothesis', title: '节点详情过长', digest: '收成摘要 + 展开' }],
    });
    assert.ok(digest.startsWith('核心结论'));
    assert.ok(digest.length <= 120);
    const prompt = buildDigestPrompt({ title: '处理面板结构问题' }, [
        { kind: 'hypothesis', title: '节点详情过长', digest: '收成摘要 + 展开' },
    ]);
    assert.ok(prompt.includes('1. [hypothesis] 节点详情过长（收成摘要 + 展开）'));
    assert.ok(prompt.includes('不得补充新事实'));
    assert.equal(calls[1].options.purpose, 'explore-tree-digest');
});
