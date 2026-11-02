/**
 * 工作区级研究图存储：
 *  - 一个 workspace root 一个内存实例（GraphRegistry 去重）；
 *  - `graph.json` 原子快照 + `journal.jsonl` 追加式操作/事件流水账；
 *  - 写操作串行（进程内队列），落盘 debounce，dispose 时强制 flush；
 *  - 进程崩溃恢复：快照里的 journalOffset 之后的操作行在加载时重放；
 *  - 多进程：best-effort 文件锁 + 追加日志重放，最后写入者优先（v1 不承诺强一致）。
 *
 * 本模块不依赖 DSH 宿主，Node 20+ 即可运行，便于单测。
 *
 * @module core/store
 */
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
    addNode,
    assignLease,
    cloneJson,
    createGraphState,
    ensureRevision,
    fromJSON,
    graphStats,
    handoff,
    linkNodes,
    mergeNodes,
    moveNode,
    nextNodeId,
    nowIso,
    removeNode,
    sessionOf,
    setActiveNode,
    toJSON,
    unlinkEdge,
    updateNode,
} from './graph.js';

export const DEFAULT_DIR_NAME = '.explore-tree';
const DEFAULT_FLUSH_DELAY_MS = 250;
const DEFAULT_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_NODES = 5000;
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 2000;
/** open('wx') 的瞬时竞争错误码：Windows 上锁文件被并发删除/重建时会表现为 EPERM/EACCES/EBUSY；ENOENT 表示锁刚释放。 */
const LOCK_CONTENTION_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'ENOENT']);

/** 默认 logger：宿主有 log 服务时由调用方替换。 */
const defaultLogger = {
    debug: () => {},
    info: () => {},
    warn: (...args) => console.warn('[explore-tree]', ...args),
    error: (...args) => console.error('[explore-tree]', ...args),
};

/**
 * 工作区研究图实例。
 */
export class WorkspaceGraphStore extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.root 工作区根（canonical）
     * @param {string} [options.dirName]
     * @param {object} [options.logger]
     * @param {number} [options.flushDelayMs]
     * @param {number} [options.journalMaxBytes]
     * @param {number} [options.maxNodes]
     * @param {() => string} [options.now]
     */
    constructor(options) {
        super();
        this.root = options.root;
        this.dirName = options.dirName ?? DEFAULT_DIR_NAME;
        this.logger = options.logger ?? defaultLogger;
        this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
        this.journalMaxBytes = options.journalMaxBytes ?? DEFAULT_JOURNAL_MAX_BYTES;
        this.maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
        this.now = options.now ?? nowIso;

        this.dir = path.join(this.root, this.dirName);
        this.graphFile = path.join(this.dir, 'graph.json');
        this.journalFile = path.join(this.dir, 'journal.jsonl');
        this.archiveFile = path.join(this.dir, 'archive.jsonl');
        this.lockFile = path.join(this.dir, 'graph.lock');

        this.state = null;
        this.ready = null;
        this.journalBytes = 0;
        this.appliedJournalBytes = 0;
        this.loadedStamp = null;
        this.lockDepth = 0;
        this.lockToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        this.reloads = 0;
        this.lastFlushAt = null;
        this.flushError = null;
        this.pendingTimer = null;
        this.pendingFlush = null;
        this.queue = Promise.resolve();
        this.closed = false;
        this.rotation = 0;
    }

    /** 打开（幂等）：加载快照 + 重放日志。 */
    async open() {
        if (this.ready !== null) return this;
        this.ready = (async () => {
            await fsp.mkdir(this.dir, { recursive: true });
            let snapshot = null;
            try {
                snapshot = await readJsonFile(this.graphFile);
            } catch (error) {
                await this.#quarantineSnapshot(error);
            }
            if (snapshot === null) {
                this.state = createGraphState({ workspaceRoot: this.root, now: this.now() });
                this.appliedJournalBytes = 0;
            } else {
                try {
                    this.state = fromJSON(snapshot);
                    this.appliedJournalBytes = Number.isInteger(snapshot.meta?.journalOffset)
                        ? snapshot.meta.journalOffset
                        : 0;
                } catch (error) {
                    await this.#quarantineSnapshot(error);
                    this.state = createGraphState({ workspaceRoot: this.root, now: this.now() });
                    this.appliedJournalBytes = 0;
                }
            }
            await this.#replayJournal();
            this.loadedStamp = await fileStamp(this.graphFile);
            return this;
        })();
        return this.ready;
    }

    async #quarantineSnapshot(error) {
        const target = `${this.graphFile}.corrupt-${Date.now()}`;
        try {
            await fsp.rename(this.graphFile, target);
            this.logger.error(`快照损坏，已隔离到 ${target}：${error instanceof Error ? error.message : String(error)}`);
        } catch (renameError) {
            this.logger.error(`快照损坏且隔离失败：${renameError instanceof Error ? renameError.message : String(renameError)}`);
        }
    }

    /** 读取日志并重放 journalOffset 之后的写操作。 */
    async #replayJournal() {
        let text;
        try {
            text = await fsp.readFile(this.journalFile, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                this.journalBytes = 0;
                this.appliedJournalBytes = 0;
                return;
            }
            throw error;
        }
        const bytes = Buffer.byteLength(text, 'utf8');
        this.journalBytes = bytes;
        let start = Number.isInteger(this.appliedJournalBytes) && this.appliedJournalBytes > 0
            ? this.appliedJournalBytes
            : 0;
        if (start > bytes) {
            // 快照已经领先于被截断的 journal：没有可重放的后缀，保持快照状态。
            this.logger.warn(`journal 比快照记录的偏移短（${start} > ${bytes}），跳过重放。`);
            this.appliedJournalBytes = bytes;
            return;
        }
        this.appliedJournalBytes = start;
        if (start >= bytes) return;
        const slice = Buffer.from(text, 'utf8').subarray(start).toString('utf8');
        const lines = slice.split('\n');
        const complete = slice.endsWith('\n');
        let applied = 0;
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            const last = index === lines.length - 1;
            if (last && line === '') break;
            const trimmed = line.trim();
            const entryBytes = Buffer.byteLength(line, 'utf8') + (last && !complete ? 0 : 1);
            if (trimmed === '') {
                applied += entryBytes;
                continue;
            }
            let entry;
            try {
                entry = JSON.parse(trimmed);
            } catch {
                if (last && !complete) {
                    // 进程崩溃留下的半行：停在这里，不吞掉后续可能追加的行。
                    this.logger.warn(`journal 尾部不完整（第 ${start + applied} 字节起），下次打开时重试。`);
                    break;
                }
                this.logger.warn(`跳过无法解析的 journal 行（第 ${start + applied} 字节）：${trimmed.slice(0, 120)}`);
                applied += entryBytes;
                continue;
            }
            if (entry === null || typeof entry !== 'object') {
                applied += entryBytes;
                continue;
            }
            if (entry.t === 'journal-start' || entry.t === 'event') {
                applied += entryBytes;
                continue;
            }
            try {
                this.#applyOp(entry, { replay: true });
            } catch (error) {
                this.logger.warn(`重放日志失败（第 ${start + applied} 字节处）：${error instanceof Error ? error.message : String(error)}`);
                break;
            }
            applied += entryBytes;
        }
        this.appliedJournalBytes = Math.min(bytes, start + applied);
    }

    /**
     * 应用一条操作（内存 + 追加日志）。这是 store 唯一的结构写入口。
     *
     * @param {object} op 见下方 switch
     * @param {{replay?: boolean}} [options]
     */
    async apply(op, options = {}) {
        await this.open();
        return this.#enqueue(async () => {
            const result = await this.#withLock(async () => {
                // 跨进程：先吸收别人已追加的 journal / 已落盘的快照，再应用本地操作。
                await this.#refreshFromDisk();
                const applied = this.#applyOp(op, options);
                if (options.replay !== true) {
                    await this.#appendJournal(op);
                    this.#scheduleFlush();
                }
                return applied;
            });
            this.emit('change', { kind: op.t, op });
            return result ?? op;
        });
    }

    #applyOp(op, options = {}) {
        if (this.state === null) throw new Error('graph store is not open');
        const state = this.state;
        switch (op.t) {
            case 'addNode': {
                // id 必须在写 journal 之前确定：重放要生成同样的 id。
                const input = op.node ?? {};
                if (op.expectedRevision !== undefined) {
                    if (input.parentId === null || input.parentId === undefined) {
                        throw new Error('addNode 的 expectedRevision 只能校验父节点；根节点不适用。');
                    }
                    ensureRevision(state, input.parentId, op.expectedRevision);
                }
                if (typeof input.id !== 'string' || input.id === '') input.id = nextNodeId(state);
                const numeric = /^n(\d+)$/.exec(input.id);
                if (numeric !== null) state.seq = Math.max(state.seq, Number(numeric[1]));
                if (op.actor !== undefined && op.actor !== null && op.actor !== '') {
                    input.createdBy ??= op.actor;
                    input.updatedBy ??= op.actor;
                }
                addNode(state, input, { id: input.id, now: op.at });
                break;
            }
            case 'updateNode':
                updateNode(state, op.id, op.patch ?? {}, {
                    now: op.at,
                    expectedRevision: op.expectedRevision,
                    actor: op.actor,
                });
                break;
            case 'handoff':
                return handoff(state, op.id, {
                    now: op.at,
                    to: op.to ?? null,
                    actor: op.actor,
                    leaseUntil: op.leaseUntil ?? null,
                    summary: op.summary ?? '',
                    expectedRevision: op.expectedRevision,
                });
            case 'assignLease':
                assignLease(state, op.id, {
                    now: op.at,
                    owner: op.owner ?? null,
                    leaseUntil: op.leaseUntil ?? null,
                    actor: op.actor,
                    renew: op.renew === true,
                    steal: op.steal === true,
                    expectedRevision: op.expectedRevision,
                });
                break;
            case 'moveNode':
                moveNode(state, op.id, op.parentId ?? null, {
                    now: op.at,
                    expectedRevision: op.expectedRevision,
                    actor: op.actor,
                });
                break;
            case 'link':
                linkNodes(state, op.from, op.to, op.kind, op.note, { now: op.at });
                break;
            case 'unlink':
                unlinkEdge(state, op.id, { now: op.at });
                break;
            case 'merge':
                mergeNodes(state, op.keepId, op.dropId, {
                    now: op.at,
                    actor: op.actor,
                    expectedRevision: op.expectedRevision,
                });
                break;
            case 'remove':
                removeNode(state, op.id, { now: op.at });
                break;
            case 'session': {
                const session = sessionOf(state, op.sessionId, op.at ?? this.now());
                if (op.goalId !== undefined) session.goalId = op.goalId;
                if (op.activeNodeId !== undefined) {
                    setActiveNode(state, op.sessionId, op.activeNodeId ?? null, op.at ?? this.now());
                }
                if (op.turn !== undefined) session.turn = Number.isInteger(op.turn) ? op.turn : session.turn;
                break;
            }
            case 'meta':
                state.meta = { ...state.meta, ...(op.meta ?? {}) };
                break;
            default:
                throw new Error(`unknown graph op: ${String(op.t)}`);
        }
        if (options.replay === true) {
            // 重放不写日志、不标脏。
            return;
        }
        state.dirty = true;
    }

    #enqueue(fn) {
        const run = this.queue.then(fn, fn);
        this.queue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /**
     * 跨进程互斥：拿不到锁就等待；锁超过 15s 视为陈旧（持有者崩溃）。
     * 注意：锁只覆盖 apply/flush 的读-算-写窗口，不覆盖整个会话。
     */
    async #withLock(fn) {
        await this.#acquireLock();
        try {
            return await fn();
        } finally {
            await this.#releaseLock();
        }
    }

    async #acquireLock() {
        if (this.lockDepth > 0) {
            this.lockDepth += 1;
            return;
        }
        const started = Date.now();
        let lastError = null;
        let retryImmediately = false;
        for (;;) {
            // 超时判定放在取锁之前，保证等待有上界；清理成功后的那一次重试不因刚好跨过
            // 截止时间而被误判（旧实现在 rm 成功后也会直接重试）。
            if (!retryImmediately && Date.now() - started > LOCK_WAIT_MS) {
                throw lockTimeoutError(this.lockFile, lastError);
            }
            retryImmediately = false;
            try {
                const handle = await fsp.open(this.lockFile, 'wx');
                try {
                    await handle.writeFile(JSON.stringify({
                        pid: process.pid,
                        token: this.lockToken,
                        at: new Date().toISOString(),
                    }), 'utf8');
                } finally {
                    await handle.close();
                }
                this.lockDepth = 1;
                return;
            } catch (error) {
                // EEXIST 是锁被持有；EPERM/EACCES/EBUSY 是 Windows 上删除挂起/共享冲突的瞬时竞争；
                // ENOENT 表示锁刚被释放。都按「稍后重试」处理，不能把写进程直接打崩。
                if (!LOCK_CONTENTION_CODES.has(error.code)) throw error;
                lastError = error;
                let stat = null;
                try {
                    stat = await fsp.stat(this.lockFile);
                } catch {
                    stat = null;
                }
                if (stat === null) {
                    // 锁已不存在（刚释放/删除挂起）：EEXIST 保留原有清理告警并立即重试；
                    // 其余错误码稍等再试，避免 EPERM + 锁文件不存在时的热循环。
                    if (error.code === 'EEXIST') {
                        try {
                            await fsp.rm(this.lockFile, { force: true });
                            this.logger.warn('清理陈旧的 graph.lock（持有者可能已崩溃）。');
                            retryImmediately = true;
                            continue;
                        } catch {
                            // 竞争下别人已清理；稍后重试。
                        }
                    }
                    await sleep(5);
                    continue;
                }
                if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
                    try {
                        await fsp.rm(this.lockFile, { force: true });
                        this.logger.warn('清理陈旧的 graph.lock（持有者可能已崩溃）。');
                        retryImmediately = true;
                        continue;
                    } catch {
                        // 竞争下别人已清理，或删除挂起；稍后重试，避免热循环。
                    }
                    await sleep(5);
                    continue;
                }
                await sleep(25);
            }
        }
    }

    async #releaseLock() {
        if (this.lockDepth > 1) {
            this.lockDepth -= 1;
            return;
        }
        this.lockDepth = 0;
        try {
            const text = await fsp.readFile(this.lockFile, 'utf8');
            const parsed = JSON.parse(text);
            if (parsed?.token === this.lockToken) await fsp.rm(this.lockFile, { force: true });
        } catch {
            // 锁文件已不存在/被接管：不删除别人的锁。
        }
    }

    /** 在锁内吸收磁盘上别人的进度；返回是否发生了重载。 */
    async #refreshFromDisk() {
        if (this.state === null) return false;
        const stamp = await fileStamp(this.graphFile);
        const journalSize = await fileSize(this.journalFile);
        const graphChanged = !sameStamp(stamp, this.loadedStamp);
        if (!graphChanged && journalSize === this.journalBytes) return false;
        if (graphChanged || journalSize < this.journalBytes) {
            await this.#reloadFromDisk();
            await this.#replayJournal();
            this.reloads += 1;
            return true;
        }
        this.journalBytes = journalSize;
        await this.#replayJournal();
        return true;
    }

    async #reloadFromDisk() {
        let snapshot = null;
        try {
            snapshot = await readJsonFile(this.graphFile);
        } catch (error) {
            await this.#quarantineSnapshot(error);
        }
        if (snapshot === null) {
            this.state = createGraphState({ workspaceRoot: this.root, now: this.now() });
            this.appliedJournalBytes = 0;
            this.loadedStamp = null;
            return;
        }
        this.state = fromJSON(snapshot);
        this.appliedJournalBytes = Number.isInteger(snapshot.meta?.journalOffset)
            ? snapshot.meta.journalOffset
            : 0;
        this.loadedStamp = await fileStamp(this.graphFile);
    }

    /** journal 末尾若是半行，先补一个换行，避免下一次 append 把新行粘在坏行上。 */
    async #ensureJournalNewline() {
        let size = 0;
        try {
            const stat = await fsp.stat(this.journalFile);
            size = stat.size;
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        if (size === 0) return;
        let last = 0;
        const handle = await fsp.open(this.journalFile, 'r');
        try {
            const buffer = Buffer.alloc(1);
            await handle.read(buffer, 0, 1, size - 1);
            last = buffer[0];
        } finally {
            await handle.close();
        }
        if (last !== 0x0a) {
            await fsp.appendFile(this.journalFile, '\n', 'utf8');
            this.logger.warn('journal 末尾缺少换行，已补一个换行；不完整的行会在下次重放时跳过。');
        }
    }

    /** 查询用：确保加载完成并返回当前状态。 */
    async current() {
        await this.open();
        return this.state;
    }

    /** 序列化快照（UI/HTTP）。 */
    async snapshot() {
        await this.open();
        return {
            workspaceRoot: this.root,
            stats: graphStats(this.state),
            graph: toJSON(this.state),
            loadedAt: this.lastFlushAt,
        };
    }

    /**
     * 写一条原始事件/审计记录到 journal（不进图）。
     *
     * @param {object} entry
     */
    async recordEvent(entry) {
        await this.open();
        if (this.closed) return;
        const line = `${JSON.stringify({ t: 'event', at: this.now(), ...entry })}\n`;
        try {
            await this.#withLock(async () => {
                await this.#refreshFromDisk();
                await this.#ensureJournalNewline();
                await fsp.appendFile(this.journalFile, line, 'utf8');
                this.journalBytes = await fileSize(this.journalFile);
                this.appliedJournalBytes = this.journalBytes;
                this.#scheduleFlush();
            });
        } catch (error) {
            this.logger.warn(`写 journal 失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async #appendJournal(op) {
        const entry = { ...op, at: op.at ?? this.now() };
        const line = `${JSON.stringify(entry)}\n`;
        await this.#ensureJournalNewline();
        await fsp.appendFile(this.journalFile, line, 'utf8');
        this.journalBytes = await fileSize(this.journalFile);
        this.appliedJournalBytes = this.journalBytes;
    }

    #scheduleFlush() {
        if (this.closed) return;
        if (this.pendingTimer !== null) return;
        this.pendingTimer = setTimeout(() => {
            this.pendingTimer = null;
            this.flush().catch((error) => {
                this.flushError = error;
                this.logger.warn(`研究图落盘失败：${error instanceof Error ? error.message : String(error)}`);
            });
        }, this.flushDelayMs);
        if (typeof this.pendingTimer.unref === 'function') this.pendingTimer.unref();
    }

    /** 强制落盘（队列内执行，保证快照与日志一致）。 */
    async flush() {
        if (this.pendingTimer !== null) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
        await this.open();
        if (this.closed) return;
        if (this.pendingFlush !== null) return this.pendingFlush;
        this.pendingFlush = this.#enqueue(async () => {
            await this.#withLock(async () => {
                // 先吸收别人的进度，再把自己的内存态整体落盘；整个过程在文件锁内。
                await this.#refreshFromDisk();
                await this.#enforceCapacity();
                const snapshot = toJSON(this.state);
                const offset = await fileSize(this.journalFile);
                snapshot.meta = { ...snapshot.meta, journalOffset: offset };
                await atomicWriteFile(this.graphFile, `${JSON.stringify(snapshot)}\n`);
                this.journalBytes = offset;
                this.appliedJournalBytes = offset;
                this.loadedStamp = await fileStamp(this.graphFile);
                this.lastFlushAt = this.now();
                this.flushError = null;
                if (offset >= this.journalMaxBytes) await this.#rotateJournal();
                this.state.dirty = false;
            });
        }).finally(() => {
            this.pendingFlush = null;
        });
        return this.pendingFlush;
    }

    async #rotateJournal() {
        this.rotation += 1;
        const target = path.join(this.dir, `journal.${Date.now()}.jsonl`);
        try {
            await fsp.rename(this.journalFile, target);
            this.journalBytes = 0;
            this.appliedJournalBytes = 0;
            const snapshot = toJSON(this.state);
            snapshot.meta = { ...snapshot.meta, journalOffset: 0 };
            await atomicWriteFile(this.graphFile, `${JSON.stringify(snapshot)}\n`);
            const startLine = `${JSON.stringify({ t: 'journal-start', at: this.now(), rotation: this.rotation })}\n`;
            await fsp.writeFile(this.journalFile, startLine, 'utf8');
            this.journalBytes = Buffer.byteLength(startLine, 'utf8');
            this.appliedJournalBytes = this.journalBytes;
            this.loadedStamp = await fileStamp(this.graphFile);
        } catch (error) {
            this.logger.warn(`journal 轮转失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** 超过 maxNodes 时把最旧的已结束叶子下沉到 archive.jsonl。 */
    async #enforceCapacity() {
        if (this.state === null) return;
        let overflow = this.state.nodes.size - this.maxNodes;
        if (overflow <= 0) return;
        const candidates = [...this.state.nodes.values()]
            .filter((node) => {
                const isLeaf = (this.state.index.children.get(node.id) ?? []).length === 0;
                return isLeaf && (node.status === 'done' || node.status === 'abandoned');
            })
            .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
        const archiveLines = [];
        for (const node of candidates) {
            if (overflow <= 0) break;
            archiveLines.push(JSON.stringify({ archivedAt: this.now(), node: cloneJson(node) }));
            try {
                removeNode(this.state, node.id, { now: this.now() });
                overflow -= 1;
            } catch {
                // 单个节点归档失败不阻断。
            }
        }
        if (archiveLines.length > 0) {
            try {
                await fsp.appendFile(this.archiveFile, `${archiveLines.join('\n')}\n`, 'utf8');
            } catch (error) {
                this.logger.warn(`归档写入失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /** 关闭：停定时器、强制 flush，然后再标记关闭。 */
    async close() {
        if (this.closed) return;
        await this.open().catch(() => {});
        if (this.pendingTimer !== null) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
        try {
            await this.flush();
        } catch (error) {
            this.logger.warn(`关闭前落盘失败：${error instanceof Error ? error.message : String(error)}`);
        }
        this.closed = true;
    }
}

/**
 * 工作区注册表：同一个 root 只保留一个实例（进程内共享的前提）。
 */
export class GraphRegistry {
    /**
     * @param {{dirName?: string, logger?: object, flushDelayMs?: number, maxNodes?: number}} [options]
     */
    constructor(options = {}) {
        this.options = options;
        this.stores = new Map();
        this.logger = options.logger ?? defaultLogger;
    }

    /**
     * 取/建某工作区的 store（自动 open）。
     *
     * @param {string} root canonical workspace root
     * @param {{key?: string}} [options]
     */
    async get(root, options = {}) {
        const key = options.key ?? root.toLowerCase();
        const existing = this.stores.get(key);
        if (existing !== undefined) {
            await existing.open();
            return existing;
        }
        const store = new WorkspaceGraphStore({
            root,
            dirName: this.options.dirName,
            logger: this.logger,
            flushDelayMs: this.options.flushDelayMs,
            journalMaxBytes: this.options.journalMaxBytes,
            maxNodes: this.options.maxNodes,
        });
        this.stores.set(key, store);
        await store.open();
        return store;
    }

    /** 已有实例（不创建）。 */
    peek(root) {
        return this.stores.get(root.toLowerCase()) ?? null;
    }

    list() {
        return [...this.stores.values()].map((store) => ({
            root: store.root,
            dir: store.dir,
            nodes: store.state?.nodes.size ?? 0,
            ready: store.state !== null,
        }));
    }

    async closeAll() {
        const stores = [...this.stores.values()];
        this.stores.clear();
        await Promise.allSettled(stores.map((store) => store.close()));
    }
}

// ───────────────────────────── 文件工具 ─────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 锁等待超时：错误信息带上最后一次竞争错误码，便于定位 EPERM/EBUSY 这类瞬时冲突。 */
function lockTimeoutError(lockFile, cause) {
    const code = cause?.code ? `；最后一次错误码 ${cause.code}` : '';
    return new Error(`研究图文件锁等待超时（${LOCK_WAIT_MS}ms）：${lockFile}${code}`, { cause });
}

/** 文件大小；不存在为 0。 */
async function fileSize(file) {
    try {
        const stat = await fsp.stat(file);
        return stat.size;
    } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
    }
}

/** 文件戳（mtime+size）；不存在为 null。 */
async function fileStamp(file) {
    try {
        const stat = await fsp.stat(file);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function sameStamp(a, b) {
    if (a === null || b === null) return a === b;
    return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** 读 JSON 文件；不存在返回 null，损坏抛错。 */
export async function readJsonFile(file) {
    let text;
    try {
        text = await fsp.readFile(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    return JSON.parse(text);
}

/** 原子写文本：临时文件 + fsync + rename（Windows 失败时删旧再 rename 重试）。 */
export async function atomicWriteFile(file, text) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const handle = await fsp.open(tmp, 'w');
    try {
        await handle.writeFile(text, 'utf8');
        await handle.sync().catch(() => {});
    } finally {
        await handle.close();
    }
    try {
        await fsp.rename(tmp, file);
    } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EEXIST', 'EACCES'].includes(error.code)) {
            await fsp.rm(file, { force: true });
            await fsp.rename(tmp, file);
        } else {
            await fsp.rm(tmp, { force: true });
            throw error;
        }
    }
}

/**
 * 内容摘要（journal 用于检测外部改动等场景）。
 *
 * @param {string|Buffer} value
 */
export function digest(value) {
    return createHash('sha1').update(value).digest('hex');
}

export { addNode, graphStats, sessionOf, setActiveNode, toJSON, fromJSON, updateNode, linkNodes, mergeNodes, moveNode, unlinkEdge, nowIso };
