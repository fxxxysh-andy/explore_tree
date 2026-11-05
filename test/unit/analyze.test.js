import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAnalysisInput, buildAnalysisPrompt, parseAnalysisResponse } from '../../src/core/analyze.js';

function node(id, kind, title, extra = {}) {
    return {
        id,
        parentId: extra.parentId ?? null,
        kind,
        title,
        summary: extra.summary ?? '',
        status: extra.status ?? 'open',
        phase: extra.phase ?? 'todo',
        digest: extra.digest ?? null,
        createdAt: extra.createdAt ?? '2026-11-01T00:00:00.000Z',
        updatedAt: extra.updatedAt ?? '2026-11-02T00:00:00.000Z',
        ...extra,
    };
}

function fixture() {
    return {
        ok: true,
        generatedAt: '2026-11-05T12:00:00.000Z',
        workspace: { root: 'D:/demo', name: 'demo' },
        stats: { nodes: 6, edges: 2, sessions: 1, byKind: { goal: 1, topic: 1, question: 2 } },
        digest: {
            scope: 'workspace',
            total: 6,
            phaseCounts: { todo: 2, doing: 1, completed: 3 },
            todo: { total: 2, visible: 2, strong: 1, weak: 1, hidden: 0 },
            completed: 3,
            deadEnd: 0,
        },
        open: { total: 2, items: [node('n3', 'question', '还要不要继续？'), node('n4', 'hypothesis', '缓存失配')] },
        frontier: { suggestions: [{ type: 'verify', title: '验证缓存假设', reason: '证据不足', nodeId: 'n3' }] },
        nodes: [
            node('n1', 'goal', '优化性能', { children: 2 }),
            node('n2', 'topic', '缓存命中率', { parentId: 'n1', digest: '定位到键格式变化', phase: 'doing' }),
            node('n3', 'question', '还要不要继续？', { parentId: 'n2' }),
            node('n4', 'hypothesis', '缓存失配', { parentId: 'n2' }),
            node('n5', 'evidence', '命中率 71%', { parentId: 'n2', phase: 'recorded', status: 'done' }),
            node('n6', 'dead_end', '回滚中间件', { parentId: 'n1', phase: 'dead_end', status: 'abandoned' }),
        ],
        edges: [{ id: 'e1', from: 'n3', to: 'n4', kind: 'supports' }],
        sessions: [{ sessionId: 's1' }],
    };
}

test('buildAnalysisInput：压缩快照，保留目标/主题/待办/死路/最近动态', () => {
    const input = buildAnalysisInput(fixture());
    assert.equal(input.workspace, 'demo');
    assert.equal(input.totals.nodes, 6);
    assert.equal(input.goals.length, 1);
    assert.equal(input.goals[0].children, 2);
    assert.equal(input.topics[0].digest, '定位到键格式变化');
    assert.deepEqual(input.open.map((item) => item.id), ['n3', 'n4']);
    assert.deepEqual(input.deadEnds.map((item) => item.id), ['n6']);
    assert.equal(input.frontier[0].nodeId, 'n3');
    assert.equal(input.digest.todo.visible, 2);
});

test('buildAnalysisInput：超长输入按上限裁剪', () => {
    const snapshot = fixture();
    snapshot.nodes = [];
    for (let i = 0; i < 40; i += 1) {
        snapshot.nodes.push(node('n' + (100 + i), 'topic', '主题 ' + i, { digest: '很长的摘要'.repeat(30) }));
    }
    const input = buildAnalysisInput(snapshot, { maxInputChars: 2500 });
    assert.ok(JSON.stringify(input).length <= 2500);
    assert.ok(input.topics.length <= 8);
});

test('buildAnalysisPrompt：包含事实与输出格式，长输入会截断', () => {
    const input = buildAnalysisInput(fixture());
    const prompt = buildAnalysisPrompt(input);
    assert.ok(prompt.includes('缓存命中率'));
    assert.ok(prompt.includes('"findings"'));
    assert.ok(prompt.includes('nodeIds 只能引用'));
    const bulky = Object.assign({}, input, {
        topics: Array.from({ length: 40 }, (_item, index) => ({ id: 'n' + index, title: '主题 ' + index, digest: '很长的摘要'.repeat(40) })),
    });
    const clipped = buildAnalysisPrompt(bulky, { maxInputChars: 2000 });
    assert.ok(clipped.includes('[事实已截断]'));
});

test('parseAnalysisResponse：容错代码块、过滤非法 kind 与未知 nodeId、限制条数', () => {
    const text = '前言\n```json\n' + JSON.stringify({
        headline: '缓存是主线',
        summary: '当前聚焦缓存命中率。',
        findings: [
            { kind: 'progress', title: '定位键格式', detail: 'hit 71%', nodeIds: ['n2', 'n999', 'bad'] },
            { kind: 'unknown', title: '非法类型' },
            { kind: 'risk', title: '回滚有风险', detail: '影响面未评估', nodeIds: ['n2', 'n3', 'n4', 'n5'] },
        ],
        recommendations: [{ title: '先补对照实验', detail: '确认因果', nodeIds: ['n3'] }],
    }) + '\n```\n后记';
    const parsed = parseAnalysisResponse(text, { nodeIds: ['n2', 'n3', 'n4', 'n5', 'n6'] });
    assert.equal(parsed.headline, '缓存是主线');
    assert.equal(parsed.findings.length, 2);
    assert.deepEqual(parsed.findings[0].nodeIds, ['n2']);
    assert.deepEqual(parsed.findings[1].nodeIds, ['n2', 'n3', 'n4'], '最多 3 个且只保留已知 id');
    assert.equal(parsed.recommendations.length, 1);
});

test('parseAnalysisResponse：无效响应返回 null', () => {
    assert.equal(parseAnalysisResponse(''), null);
    assert.equal(parseAnalysisResponse('not json'), null);
    assert.equal(parseAnalysisResponse('{"headline":"","summary":"","findings":[],"recommendations":[]}'), null);
    assert.equal(parseAnalysisResponse('{"findings":"x"}'), null);
});
