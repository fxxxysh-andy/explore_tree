import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_THOUGHT_QUOTAS,
    classifyClaim,
    isApproachKind,
    isNearDuplicate,
    isProcessNarration,
    isQuestionText,
    selectClaims,
    similarity,
} from '../../src/core/select.js';

test('classifyClaim：多特征矩阵按整句语义分类，不被单个关键词带偏', () => {
    const cases = [
        ['Hypothesis: the 24-node quota is filled by early process narration, so late conclusions never enter the tree.', 'hypothesis'],
        ['Decision: use per-kind quotas (question 2, hypothesis 3, evidence 3) instead of one global FIFO quota.', 'decision'],
        ['失败：midway step 与 turn.start 各建一个 step，造成重复轮次。', 'dead_end'],
        ['数据表明 8/9 轮的 turn 数远超预算，配额在 51 秒内用尽。', 'evidence'],
        ['是否应该把 note 折叠进轮次摘要？', 'question'],
        ['结论：取舍策略应改为分层配额加 MMR，而不是按事件顺序先到先得。', 'conclusion'],
        ['Perhaps the margin should be lower for Chinese sentences; this needs a golden test.', 'hypothesis'],
        ['Could the cache be stale after the first read?', 'question'],
    ];
    for (const [text, expected] of cases) {
        const claim = classifyClaim(text);
        assert.equal(claim.kind, expected, text);
        assert.equal(claim.narration, false, text);
        assert.ok(claim.score >= 1.2, `${text} → ${claim.score}`);
        assert.ok(claim.margin >= 0.35, `${text} margin ${claim.margin}`);
        assert.ok(claim.title.length > 0, '标题不能为空');
    }
});

test('classifyClaim：英语计划句不再被裸助动词误判为问题', () => {
    for (const text of [
        'Could use a Map for the cache',
        'Do sequential in one bash to avoid output mess',
        'Should exclude topics whose parent is the current goal',
        'Maybe include owner',
    ]) {
        assert.notEqual(classifyClaim(text).kind, 'question', text);
    }
    assert.equal(classifyClaim('Could the cache be stale after the first read?').kind, 'question');
    assert.equal(isQuestionText('Could use a Map for the cache'), false);
    assert.equal(isQuestionText('This is a normal declarative sentence.'), false);
    assert.equal(isQuestionText('The file is a JSON document.'), false);
    assert.equal(isQuestionText('It does not work.'), false);
    assert.equal(isQuestionText('The file is not valid.'), false);
    assert.equal(isQuestionText('It is that simple.'), false);
    assert.equal(isQuestionText('Is it safe'), true);
    assert.equal(isQuestionText('But await store.init() — does WorkspaceGraphStore have init method'), true);
    assert.equal(isQuestionText('Should we keep nested details?'), true);
});

test('isQuestionText：口语开头、is there、did+双词主语与中文中置疑问词', () => {
    for (const text of [
        'But does WorkspaceGraphStore have an init method',
        'Interesting: ... is there an actual lock implementation',
        'Did npm test modify package.json',
        'Is there an actual lock implementation',
        'Should version bump to 0.5.0',
        '缓存为什么会失效',
        'note 折叠策略是什么',
    ]) {
        assert.equal(isQuestionText(text), true, text);
    }
    for (const text of [
        'Could use a Map for the cache',
        'Do sequential in one bash to avoid output mess',
        'Should exclude topics whose parent is the current goal',
        'Maybe include owner',
        'It does not work.',
        '这里没有什么问题',
        '没有发现什么问题',
        '代码怎么运行都不稳定',
        '这个方案没有多少收益',
    ]) {
        assert.equal(isQuestionText(text), false, text);
    }
    assert.equal(classifyClaim('Did npm test modify package.json').kind, 'question');
    assert.equal(classifyClaim('Should version bump to 0.5.0').kind, 'question');
});

test('classifyClaim：过程旁白折叠为 note，不占节点', () => {
    const narration = [
        'Let me read the README first.',
        '我先读一下 docs/extractor-optimization.md 的第 4 节。',
        'Next I will run the unit tests and then replay the real session.',
        '好的，我先看一下现有的测试结构。',
        'I need to verify the fingerprint format before changing the comparison.',
    ];
    for (const text of narration) {
        const claim = classifyClaim(text);
        assert.equal(claim.narration, true, text);
        assert.equal(claim.kind, 'note', text);
        assert.equal(isProcessNarration(text), true, text);
    }
    // 带明确结论的过程句仍算 claim。
    assert.equal(classifyClaim('我先确认一点：3/3 的 goal 都来自注入消息，所以来源过滤是首要修复。').narration, false);
});

test('classifyClaim：标题取触发 kind 的句子，而不是第一句', () => {
    const claim = classifyClaim('这一句只是铺垫。假设：配额应该按层分配，而不是先到先得。');
    assert.equal(claim.kind, 'hypothesis');
    assert.equal(claim.title, '配额应该按层分配，而不是先到先得');
    assert.ok(!/^假设/u.test(claim.title));

    const conclusion = classifyClaim('先看两个现象。数据表明 4/4 条假设没有证据。结论：frontier 应改成看边。');
    assert.equal(conclusion.kind, 'conclusion');
    assert.equal(conclusion.title, 'Frontier 应改成看边');
});

test('similarity/isNearDuplicate：词面近似去重，短文本只认完全相等', () => {
    const a = 'the 24-node quota is filled by early process narration so late conclusions never enter the tree';
    const b = 'the 24-node quota is filled by early process narration so late conclusions never enter tree';
    assert.ok(similarity(a, b) >= 0.85);
    assert.equal(isNearDuplicate(a, b, 0.85), true);
    assert.equal(isNearDuplicate('note 折叠', 'note 折叠', 0.85), true);
    assert.equal(isNearDuplicate('note 折叠', 'note 节点', 0.85), false);
    assert.equal(isNearDuplicate(a, 'completely different sentence about graph edges and frontier', 0.85), false);
});

function candidates(list) {
    return list.map((item, index) => ({
        key: item.key ?? `k${index + 1}`,
        text: item.text ?? `候选想法 ${index + 1}`,
        kind: item.kind ?? 'evidence',
        score: item.score ?? 2,
        title: item.title ?? `候选 ${index + 1}`,
        order: item.order ?? index + 1,
    }));
}

test('selectClaims：总配额 + 分层配额生效，note 默认折叠', () => {
    const list = candidates([
        ...Array.from({ length: 5 }, (_, i) => ({ kind: 'hypothesis', score: 3 - i * 0.1, order: i + 1 })),
        ...Array.from({ length: 5 }, (_, i) => ({ kind: 'evidence', score: 2.5 - i * 0.1, order: 6 + i })),
        { kind: 'question', score: 2, order: 11 },
        { kind: 'question', score: 1.9, order: 12 },
        { kind: 'question', score: 1.8, order: 13 },
        { kind: 'note', score: 4, order: 14 },
    ]);
    const out = selectClaims(list, { maxThoughtNodesPerTurn: 10 });
    const byKind = {};
    for (const item of out.selected) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    assert.ok(out.selected.length <= 10);
    assert.equal(byKind.hypothesis, DEFAULT_THOUGHT_QUOTAS.hypothesis);
    assert.equal(byKind.evidence, DEFAULT_THOUGHT_QUOTAS.evidence);
    assert.equal(byKind.question, DEFAULT_THOUGHT_QUOTAS.question);
    assert.equal(byKind.note ?? 0, 0);
    assert.equal(out.folded.length, 1);
});

test('selectClaims：近似重复只留高分，MMR 让高相似候选排在后面', () => {
    const dupA = {
        key: 'a', kind: 'evidence', score: 3, order: 1,
        text: 'the quota is filled by early narration so late conclusions never enter the tree',
    };
    const dupB = {
        key: 'b', kind: 'evidence', score: 2.9, order: 2,
        text: 'the quota is filled by early narration so late conclusions never enter tree',
    };
    const distinct = { key: 'c', kind: 'hypothesis', score: 2.6, order: 3, text: '分层配额应该保留结论槽位' };
    const out = selectClaims(candidates([dupA, dupB, distinct]), { maxThoughtNodesPerTurn: 10, mmrLambda: 0.7 });
    assert.deepEqual(out.selected.map((item) => item.key), ['a', 'c']);
    assert.equal(out.ranked[0].key, 'a');
    assert.equal(out.ranked[1].key, 'c');
});

test('selectClaims：结论预留槽位，配额满了也能进', () => {
    const list = candidates([
        ...Array.from({ length: 8 }, (_, i) => ({ kind: 'hypothesis', score: 5 - i * 0.1, order: i + 1 })),
        { kind: 'evidence', score: 4, order: 9 },
        { kind: 'evidence', score: 3.9, order: 10 },
        { kind: 'conclusion', score: 1.5, order: 20 },
    ]);
    const out = selectClaims(list, { maxThoughtNodesPerTurn: 5, reserveConclusionSlots: 1 });
    assert.equal(out.selected.length, 5, '结论不挤占前四个非结论槽，但总上限内仍要留 1 个');
    assert.ok(out.selected.some((item) => item.kind === 'conclusion'));
});

test('selectClaims：noteNodeMode=node 时 note 也落节点（旧行为回退）', () => {
    const out = selectClaims(candidates([{ kind: 'note', score: 3, order: 1 }, { kind: 'note', score: 2, order: 2 }]), {
        maxThoughtNodesPerTurn: 10,
        noteNodeMode: 'node',
    });
    assert.equal(out.selected.length, 2);
});

test('selectClaims：chronological 的开关在 extract 层，select 只做排序', () => {
    assert.equal(isApproachKind('question'), true);
    assert.equal(isApproachKind('hypothesis'), true);
    assert.equal(isApproachKind('decision'), true);
    assert.equal(isApproachKind('evidence'), false);
    assert.equal(isApproachKind('conclusion'), false);
});
