import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyCloseReasonMigration,
    countStatuses,
    inferMigrationFields,
    planCloseReasonMigration,
    revertCloseReasonMigration,
    validateCloseReasonMigration,
} from '../../src/core/migrate-close-reason.js';

function rawNode(id, kind, status, extra = {}) {
    return { id, kind, status, title: id, summary: '', createdAt: '2026-01-01T00:00:00.000Z', ...extra };
}

function snapshot() {
    return {
        version: 1,
        nodes: {
            n1: rawNode('n1', 'question', 'open'),
            n2: rawNode('n2', 'question', 'abandoned', { tags: ['auto-curated'] }),
            n3: rawNode('n3', 'question', 'abandoned', { tags: ['merged-into'] }),
            n4: rawNode('n4', 'dead_end', 'abandoned', { title: '失败：run_code' }),
            n5: rawNode('n5', 'dead_end', 'abandoned'),
            n6: rawNode('n6', 'evidence', 'done'),
            n7: rawNode('n7', 'decision', 'done'),
            n8: rawNode('n8', 'goal', 'done'),
            n9: rawNode('n9', 'step', 'done'),
            n10: rawNode('n10', 'dead_end', 'done'),
            n11: rawNode('n11', 'note', 'done', { closeReason: 'recorded', resolutionBy: 'human' }),
            n12: rawNode('n12', 'dead_end', 'abandoned', { title: '失败：x', tags: ['auto-curated'] }),
        },
    };
}

test('P2：迁移规则按优先级推断 closeReason/resolutionBy', () => {
    assert.equal(inferMigrationFields({ kind: 'question', status: 'open' }), null);
    assert.deepEqual(
        inferMigrationFields({ kind: 'question', status: 'abandoned', tags: ['auto-curated'] }),
        { closeReason: 'curated', resolutionBy: 'auto', rule: 'auto-curated' },
    );
    assert.deepEqual(
        inferMigrationFields({ kind: 'question', status: 'abandoned', tags: ['auto-curated', 'merged-into'] }),
        { closeReason: 'curated', resolutionBy: 'auto', rule: 'auto-curated' },
        '自动收敛优先于合并',
    );
    assert.equal(inferMigrationFields({ kind: 'dead_end', status: 'abandoned', title: '失败：run_code' }).closeReason, 'aborted');
    assert.equal(inferMigrationFields({ kind: 'dead_end', status: 'abandoned', title: '真死路' }).closeReason, 'dead_end');
    assert.equal(inferMigrationFields({ kind: 'evidence', status: 'done' }).closeReason, 'recorded');
    assert.equal(inferMigrationFields({ kind: 'decision', status: 'done' }).closeReason, 'recorded');
    assert.equal(
        inferMigrationFields({ kind: 'decision', status: 'done', tags: ['auto-curated'] }).closeReason,
        'recorded',
        '记录类先于 auto-curated，回填计数才与报告一致',
    );
    assert.equal(inferMigrationFields({ kind: 'goal', status: 'done' }).closeReason, 'solved');
    assert.equal(inferMigrationFields({ kind: 'step', status: 'done' }).closeReason, 'completed');
    assert.equal(inferMigrationFields({ kind: 'dead_end', status: 'done' }).closeReason, 'dead_end');
});

test('P2：计划计数、幂等与 status 不变', () => {
    const raw = snapshot();
    const before = countStatuses(raw);
    const plan = planCloseReasonMigration(raw, { sample: 2 });
    assert.equal(plan.total, 12);
    assert.equal(plan.changed, 10);
    assert.equal(plan.skipped, 1, '已有 closeReason 跳过');
    assert.deepEqual(plan.counts, {
        'curated/auto': 2,
        'duplicate/auto': 1,
        'aborted/auto': 1,
        'dead_end/migrated': 2,
        'recorded/migrated': 2,
        'solved/migrated': 1,
        'completed/migrated': 1,
    });
    assert.deepEqual(plan.statusCounts, before);
    assert.equal(plan.sample.length, 2);
    assert.equal(raw.nodes.n2.closeReason, undefined, '计划不修改入参');

    const applied = applyCloseReasonMigration(raw, plan);
    assert.equal(applied.applied, 10);
    assert.equal(raw.version, 2);
    assert.equal(raw.nodes.n2.closeReason, 'curated');
    assert.equal(raw.nodes.n2.resolutionBy, 'auto');
    assert.equal(raw.nodes.n5.closeReason, 'dead_end');
    assert.equal(raw.nodes.n5.resolutionBy, 'migrated');
    assert.equal(raw.nodes.n11.resolutionBy, 'human', '人工字段不覆盖');
    const validation = validateCloseReasonMigration(raw, before);
    assert.equal(validation.ok, true);
    assert.equal(validation.statusUnchanged, true);
    assert.deepEqual(validation.statusCounts, before);

    const again = planCloseReasonMigration(raw);
    assert.equal(again.changed, 0, '迁移可重跑');
    assert.equal(again.skipped, 11);
});

test('P2：校验能发现开放节点带原因、关闭节点缺字段与非法枚举', () => {
    const raw = snapshot();
    const before = countStatuses(raw);
    applyCloseReasonMigration(raw, planCloseReasonMigration(raw));
    assert.equal(validateCloseReasonMigration(raw, before).ok, true);

    raw.nodes.n1.closeReason = 'solved';
    delete raw.nodes.n6.closeReason;
    raw.nodes.n7.closeReason = 'bogus';
    const bad = validateCloseReasonMigration(raw, before);
    assert.equal(bad.ok, false);
    assert.equal(bad.badOpen, 1);
    assert.equal(bad.missing, 1);
    assert.equal(bad.invalid, 1);
    assert.deepEqual(bad.badOpenIds, ['n1']);
});

test('P2：回滚只清 migrated，保留 auto/human；全部清空时回到 v1', () => {
    const raw = snapshot();
    const before = countStatuses(raw);
    applyCloseReasonMigration(raw, planCloseReasonMigration(raw));
    const result = revertCloseReasonMigration(raw);
    assert.equal(result.reverted, 6);
    assert.equal(result.version, 2, '仍有人工/自动写入的字段');
    assert.equal(raw.nodes.n2.closeReason, 'curated');
    assert.equal(raw.nodes.n11.resolutionBy, 'human');
    assert.equal(raw.nodes.n5.closeReason, undefined);
    assert.equal(raw.nodes.n6.resolutionBy, undefined);

    const onlyMigrated = {
        version: 2,
        nodes: {
            n1: rawNode('n1', 'goal', 'done', { closeReason: 'solved', resolutionBy: 'migrated' }),
            n2: rawNode('n2', 'question', 'open'),
        },
    };
    const fully = revertCloseReasonMigration(onlyMigrated);
    assert.equal(fully.reverted, 1);
    assert.equal(fully.remains, false);
    assert.equal(onlyMigrated.version, 1);
    assert.equal(onlyMigrated.nodes.n1.closeReason, undefined);
    assert.deepEqual(countStatuses(onlyMigrated), { done: 1, open: 1 });
});
