import assert from 'node:assert/strict';
import test from 'node:test';

import {
    clampText,
    normalizeConfidence,
    normalizeEdgeKind,
    normalizeKind,
    normalizeRefs,
    normalizeStatus,
    normalizeTags,
} from '../../src/core/model.js';

test('kind/status/edge 归一化容错', () => {
    assert.equal(normalizeKind('hypothesis'), 'hypothesis');
    assert.equal(normalizeKind('bogus'), 'note');
    assert.equal(normalizeKind('bogus', 'goal'), 'goal');
    assert.equal(normalizeStatus('done'), 'done');
    assert.equal(normalizeStatus('bogus'), 'open');
    assert.equal(normalizeEdgeKind('contradicts'), 'contradicts');
    assert.equal(normalizeEdgeKind('bogus'), 'related');
});

test('confidence 截断到 0..1 并保留两位', () => {
    assert.equal(normalizeConfidence(0.12345), 0.12);
    assert.equal(normalizeConfidence(-3), 0);
    assert.equal(normalizeConfidence(7), 1);
    assert.equal(normalizeConfidence('0.5'), null);
    assert.equal(normalizeConfidence(null), null);
});

test('clampText 压空白/保留换行/截断', () => {
    assert.equal(clampText('  a \n b  ', 100), 'a b');
    assert.equal(clampText('a\n\n\n b', 100, { keepNewlines: true }), 'a\n\n b');
    assert.equal(clampText('abcdef', 4), 'abc…');
    assert.equal(clampText(undefined, 10), '');
});

test('tags/refs 去重与清洗', () => {
    assert.deepEqual(normalizeTags(['a', 'a', ' b ', '', 3]), ['a', 'b', '3']);
    const refs = normalizeRefs([
        { kind: 'url', value: 'https://example.com' },
        { kind: 'url', value: 'https://example.com', label: 'dup' },
        { kind: 'bogus', value: 'x' },
        { kind: 'file', value: '' },
        { kind: 'file', value: 'a.txt', label: '证据' },
    ]);
    assert.deepEqual(refs, [
        { kind: 'url', value: 'https://example.com' },
        { kind: 'file', value: 'a.txt', label: '证据' },
    ]);
});
