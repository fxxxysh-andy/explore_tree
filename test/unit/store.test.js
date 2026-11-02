import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { GraphRegistry, WorkspaceGraphStore, atomicWriteFile } from '../../src/core/store.js';

const execFileAsync = promisify(execFile);

function tempRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-tree-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('apply 落盘后重新打开能恢复节点/边/会话', async (t) => {
    const root = tempRoot(t);
    const store = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    await store.open();
    const goal = await store.apply({ t: 'addNode', node: { kind: 'goal', title: '目标', status: 'active' } });
    const step = await store.apply({ t: 'addNode', node: { parentId: goal.node.id, kind: 'step', title: '步骤' } });
    await store.apply({ t: 'link', from: goal.node.id, to: step.node.id, kind: 'supports' });
    await store.apply({ t: 'session', sessionId: 's1', activeNodeId: step.node.id, turn: 3 });
    await store.flush();
    await store.close();

    const reopened = new WorkspaceGraphStore({ root });
    await reopened.open();
    assert.equal(reopened.state.nodes.size, 2);
    assert.equal(reopened.state.edges.length, 1);
    assert.equal(reopened.state.sessions.get('s1').turn, 3);
    assert.equal(reopened.state.sessions.get('s1').activeNodeId, step.node.id);
    assert.equal(reopened.state.nodes.get('n2').title, '步骤');
    await reopened.close();
});

test('flush 之后的追加操作通过 journal 重放恢复（id 一致）', async (t) => {
    const root = tempRoot(t);
    const first = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    await first.open();
    await first.apply({ t: 'addNode', node: { kind: 'goal', title: 'G' } });
    await first.flush();
    await first.apply({ t: 'addNode', node: { parentId: 'n1', kind: 'hypothesis', title: 'H' } });
    await first.close();

    const second = new WorkspaceGraphStore({ root });
    await second.open();
    assert.deepEqual([...second.state.nodes.keys()].sort(), ['n1', 'n2']);
    assert.equal(second.state.nodes.get('n2').parentId, 'n1');
    assert.equal(second.state.nodes.get('n2').kind, 'hypothesis');
    await second.close();

    const third = new WorkspaceGraphStore({ root });
    await third.open();
    assert.equal(third.state.nodes.size, 2, '重复打开不应重复重放');
    await third.close();
});

test('handoff 作为单条 journal 操作重放：租约与交接节点都不丢', async (t) => {
    const root = tempRoot(t);
    const store = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    await store.open();
    await store.apply({ t: 'addNode', node: { kind: 'goal', title: 'G' } });
    await store.apply({
        t: 'addNode',
        node: { parentId: 'n1', kind: 'topic', title: 'T', owner: 'agent-a', leaseUntil: new Date(Date.now() + 60_000).toISOString() },
    });
    await store.apply({ t: 'addNode', node: { parentId: 'n2', kind: 'question', title: 'Q' } });
    const result = await store.apply({ t: 'handoff', id: 'n2', to: 'agent-b', actor: 'agent-a', leaseUntil: new Date(Date.now() + 120_000).toISOString(), summary: '交接包摘要' });
    const handoffId = result.node.id;
    await store.flush();
    await store.close();

    const reopened = new WorkspaceGraphStore({ root });
    await reopened.open();
    assert.equal(reopened.state.nodes.get('n2').owner, 'agent-b');
    const restored = reopened.state.nodes.get(handoffId);
    assert.ok(restored);
    assert.equal(restored.kind, 'conclusion');
    assert.equal(restored.parentId, 'n2');
    assert.equal(restored.summary, '交接包摘要');
    assert.ok(restored.tags.includes('handoff'));
    await reopened.close();
});

test('journalOffset 记真实字节数，半行不入图', async (t) => {
    const root = tempRoot(t);
    const dir = path.join(root, '.explore-tree');
    const first = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    await first.open();
    await first.apply({ t: 'addNode', node: { kind: 'goal', title: 'G' } });
    await first.flush();
    await first.apply({ t: 'addNode', node: { parentId: 'n1', kind: 'note', title: 'N' } });
    await first.close();

    const journalFile = path.join(dir, 'journal.jsonl');
    const before = fs.statSync(journalFile).size;
    fs.appendFileSync(journalFile, '{"t":"addNode","node":{"kind":"note"');
    const warnings = [];
    const logger = { info() {}, error() {}, debug() {}, warn: (message) => warnings.push(String(message)) };
    const reopened = new WorkspaceGraphStore({ root, logger });
    await reopened.open();
    assert.equal(reopened.state.nodes.size, 2);
    assert.equal(reopened.appliedJournalBytes, before, '半行不推进 offset');
    assert.equal(reopened.journalBytes, fs.statSync(journalFile).size);
    assert.ok(warnings.some((message) => /不完整/.test(message)), '半行要有可诊断告警');
    await reopened.close();
});

test('recordEvent 前会先吸收别的实例写下的结构操作', async (t) => {
    const root = tempRoot(t);
    const a = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    const b = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    await a.open();
    await b.open();
    const goal = await a.apply({ t: 'addNode', node: { kind: 'goal', title: 'G' } });
    await b.recordEvent({ kind: 'probe' });
    assert.equal(b.state.nodes.size, 1, 'recordEvent 不能把别人的结构写标记为已消费');
    const child = await b.apply({ t: 'addNode', node: { parentId: goal.node.id, kind: 'note', title: 'N' } });
    assert.equal(child.node.parentId, goal.node.id);
    await a.close();
    await b.close();
    const reopened = new WorkspaceGraphStore({ root });
    await reopened.open();
    assert.equal(reopened.state.nodes.size, 2);
    await reopened.close();
});

test('两个进程并发写同一工作区，节点不丢（文件锁 + 重读）', async (t) => {
    const root = tempRoot(t);
    const worker = path.join(root, 'writer.mjs');
    const storeUrl = new URL('../../src/core/store.js', import.meta.url).href;
    fs.writeFileSync(worker, [
        `import { WorkspaceGraphStore } from ${JSON.stringify(storeUrl)};`,
        'const [root, prefix] = process.argv.slice(2);',
        'const store = new WorkspaceGraphStore({ root, flushDelayMs: 60000 });',
        'await store.open();',
        'for (let i = 0; i < 20; i += 1) {',
        '  await store.apply({ t: \'addNode\', node: { kind: \'note\', title: `${prefix}-${i}` } });',
        '}',
        'await store.close();',
        '',
    ].join('\n'));
    await Promise.all([
        execFileAsync(process.execPath, [worker, root, 'A'], { timeout: 30_000 }),
        execFileAsync(process.execPath, [worker, root, 'B'], { timeout: 30_000 }),
    ]);
    const store = new WorkspaceGraphStore({ root });
    await store.open();
    assert.equal(store.state.nodes.size, 40, '两个进程各写 20 个，不应丢');
    assert.equal(new Set([...store.state.nodes.values()].map((node) => node.title)).size, 40);
    assert.equal(fs.existsSync(path.join(root, '.explore-tree', 'graph.lock')), false, '锁应释放');
    await store.close();
});

test('新鲜 graph.lock 被释放后 apply 会等待并成功（不把竞争当失败）', async (t) => {
    const root = tempRoot(t);
    const logger = { info() {}, error() {}, debug() {}, warn() {} };
    const store = new WorkspaceGraphStore({ root, logger, flushDelayMs: 60_000 });
    await store.open();
    const lockFile = path.join(root, '.explore-tree', 'graph.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999, token: 'other-process', at: new Date().toISOString() }), 'utf8');
    let released = false;
    const timer = setTimeout(() => {
        fs.rmSync(lockFile, { force: true });
        released = true;
    }, 100);
    t.after(() => clearTimeout(timer));
    const result = await store.apply({ t: 'addNode', node: { kind: 'goal', title: 'G' } });
    assert.equal(released, true, 'apply 必须在锁释放之后才成功');
    assert.equal(result.node.kind, 'goal');
    assert.equal(fs.existsSync(lockFile), false, '自己加的锁应被清理');
    await store.close();
});

test('陈旧 graph.lock 会被清理并获得锁', async (t) => {
    const root = tempRoot(t);
    const warnings = [];
    const logger = { info() {}, error() {}, debug() {}, warn: (message) => warnings.push(String(message)) };
    const store = new WorkspaceGraphStore({ root, logger, flushDelayMs: 60_000 });
    await store.open();
    const lockFile = path.join(root, '.explore-tree', 'graph.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, token: 'dead-holder', at: new Date().toISOString() }), 'utf8');
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(lockFile, old, old);
    const result = await store.apply({ t: 'addNode', node: { kind: 'goal', title: 'G' } });
    assert.equal(result.node.kind, 'goal');
    assert.ok(warnings.some((message) => /陈旧/.test(message)), '清理陈旧锁要有可诊断告警');
    assert.equal(fs.existsSync(lockFile), false, '清理后自己的锁应正常释放');
    await store.close();
});

test('stat 报告锁不存在时不得删除随后重建的新锁（竞争窗口）', async (t) => {
    const root = tempRoot(t);
    const store = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    await store.open();
    const lockFile = path.join(root, '.explore-tree', 'graph.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 424242, token: 'rival', at: new Date().toISOString() }), 'utf8');
    const originalStat = fsp.stat;
    const originalRm = fsp.rm;
    let injected = false;
    let earlyRm = 0;
    const releaseAt = Date.now() + 200;
    fsp.stat = async function patchedStat(file, ...rest) {
        if (!injected && String(file) === lockFile) {
            injected = true;
            // 模拟「stat 看到锁刚被删掉」的窗口：文件其实已被对手进程重新创建。
            const error = new Error(`ENOENT: no such file or directory, stat '${file}'`);
            error.code = 'ENOENT';
            throw error;
        }
        return originalStat.call(this, file, ...rest);
    };
    fsp.rm = async function patchedRm(file, options) {
        if (String(file) === lockFile && Date.now() < releaseAt) earlyRm += 1;
        return originalRm.call(this, file, options);
    };
    const timer = setTimeout(() => fs.rmSync(lockFile, { force: true }), 200);
    try {
        const result = await store.apply({ t: 'addNode', node: { kind: 'goal', title: 'G' } });
        assert.equal(result.node.kind, 'goal');
        assert.ok(Date.now() >= releaseAt, '必须等对手进程真正释放锁后才能进入临界区');
        assert.equal(earlyRm, 0, 'stat 说锁不存在时不得按旧判断 rm，可能删掉别人刚重建的新锁');
    } finally {
        clearTimeout(timer);
        fsp.stat = originalStat;
        fsp.rm = originalRm;
        await store.close();
    }
});

test('观察到陈旧锁但 rm 前已被新持有者重建时不得删除', async (t) => {
    const root = tempRoot(t);
    const store = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    await store.open();
    const lockFile = path.join(root, '.explore-tree', 'graph.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 111, token: 'stale-holder', at: new Date().toISOString() }), 'utf8');
    const old = new Date(Date.now() - 30_000);
    fs.utimesSync(lockFile, old, old);
    const originalStat = fsp.stat;
    const originalRm = fsp.rm;
    let injected = false;
    let earlyRm = 0;
    const releaseAt = Date.now() + 200;
    fsp.stat = async function patchedStat(file, ...rest) {
        if (!injected && String(file) === lockFile) {
            injected = true;
            // 第一次 stat 看到的是陈旧锁；紧接着另一个清理者/新持有者已把它替换成新鲜的锁。
            const fresh = JSON.stringify({ pid: 222, token: 'fresh-holder', at: new Date().toISOString() });
            fs.writeFileSync(lockFile, fresh, 'utf8');
            const now = new Date();
            fs.utimesSync(lockFile, now, now);
            return { mtimeMs: Date.now() - 30_000, size: Buffer.byteLength(fresh), isFile: () => true };
        }
        return originalStat.call(this, file, ...rest);
    };
    fsp.rm = async function patchedRm(file, options) {
        if (String(file) === lockFile && Date.now() < releaseAt) earlyRm += 1;
        return originalRm.call(this, file, options);
    };
    const timer = setTimeout(() => fs.rmSync(lockFile, { force: true }), 200);
    try {
        const result = await store.apply({ t: 'addNode', node: { kind: 'goal', title: 'G' } });
        assert.equal(result.node.kind, 'goal');
        assert.ok(Date.now() >= releaseAt, '必须等新持有者真正释放锁后才能进入临界区');
        assert.equal(earlyRm, 0, 'rm 前锁已被替换，不能按旧 stat 删掉新持有者的锁');
    } finally {
        clearTimeout(timer);
        fsp.stat = originalStat;
        fsp.rm = originalRm;
        await store.close();
    }
});

test('open 抛瞬时 EPERM 时重试而不是让写进程失败', async (t) => {
    const root = tempRoot(t);
    const store = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    await store.open();
    const originalOpen = fsp.open;
    let injected = 0;
    fsp.open = async function patchedOpen(file, flags, ...rest) {
        if (injected === 0 && flags === 'wx' && String(file).endsWith('graph.lock')) {
            injected += 1;
            const error = new Error(`EPERM: operation not permitted, open '${file}'`);
            error.code = 'EPERM';
            throw error;
        }
        return originalOpen.call(this, file, flags, ...rest);
    };
    try {
        const result = await store.apply({ t: 'addNode', node: { kind: 'goal', title: 'G' } });
        assert.equal(result.node.kind, 'goal');
        assert.equal(injected, 1, '应确实注入过一次 EPERM');
    } finally {
        fsp.open = originalOpen;
        await store.close();
    }
});

test('持续 EPERM 超过 LOCK_WAIT_MS 抛出带最后错误码的超时错误', async (t) => {
    const root = tempRoot(t);
    const store = new WorkspaceGraphStore({ root, flushDelayMs: 60_000 });
    await store.open();
    const originalOpen = fsp.open;
    let attempts = 0;
    fsp.open = async function patchedOpen(file, flags, ...rest) {
        if (flags === 'wx' && String(file).endsWith('graph.lock')) {
            attempts += 1;
            const error = new Error(`EPERM: operation not permitted, open '${file}'`);
            error.code = 'EPERM';
            throw error;
        }
        return originalOpen.call(this, file, flags, ...rest);
    };
    try {
        await assert.rejects(
            store.apply({ t: 'addNode', node: { kind: 'goal', title: 'G' } }),
            (error) => {
                assert.match(error.message, /等待超时/);
                assert.match(error.message, /EPERM/, '超时错误要带上最后一次错误码');
                return true;
            },
        );
        assert.ok(attempts > 1, '应确实重复尝试过获取锁');
        assert.ok(attempts < 1000, `持续 EPERM 不应热循环（实际 ${attempts} 次）`);
    } finally {
        fsp.open = originalOpen;
        await store.close();
    }
});

test('损坏快照被隔离并从空图恢复', async (t) => {
    const root = tempRoot(t);
    const dir = path.join(root, '.explore-tree');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'graph.json'), '{broken json');
    const store = new WorkspaceGraphStore({ root });
    await store.open();
    assert.equal(store.state.nodes.size, 0);
    const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith('graph.json.corrupt-'));
    assert.equal(quarantined.length, 1);
    await store.close();
});

test('GraphRegistry 同一工作区共享实例', async (t) => {
    const root = tempRoot(t);
    const registry = new GraphRegistry();
    const left = await registry.get(root);
    const right = await registry.get(root);
    assert.equal(left, right);
    await registry.closeAll();
});

test('atomicWriteFile 覆盖写且不留临时文件', async (t) => {
    const root = tempRoot(t);
    const file = path.join(root, 'nested', 'a.txt');
    await atomicWriteFile(file, 'one');
    await atomicWriteFile(file, 'two');
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
    const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
});
