/**
 * 研究图的纯内存结构操作：节点 CRUD、树不变量（单父、无环）、旁支关系、
 * 会话游标、合并与校验、JSON 序列化。
 *
 * 设计约束：
 *  - 不依赖宿主、不读写文件（store.js 负责持久化）；
 *  - 所有写操作返回被影响的节点，方便调用方顺手记 journal / 广播变更；
 *  - 输入全部归一化（见 model.js），非法输入降级而不是抛错；
 *  - id 单调递增、永不复用：节点被合并/删除后旧 id 仍可被引用（审计与提示稳定）。
 *
 * @module core/graph
 */
import {
    clampText,
    defaultCloseReasonFor,
    MAX_DIGEST,
    MAX_SUMMARY,
    MAX_TITLE,
    normalizeActor,
    normalizeCloseReason,
    normalizeConfidence,
    normalizeDigestSource,
    normalizeEdgeKind,
    normalizeKind,
    normalizePriority,
    normalizeRefs,
    normalizeResolutionBy,
    normalizeStatus,
    normalizeTags,
} from './model.js';

/** 快照格式版本。v2 起节点可带 closeReason/resolutionBy（v1 仍可读）。 */
export const GRAPH_VERSION = 2;

/** 可读的快照版本；v1 在显式迁移前保持 1，新建图写 GRAPH_VERSION。 */
export const SUPPORTED_GRAPH_VERSIONS = Object.freeze([1, 2]);

/**
 * CAS 冲突：调用方给的 expectedRevision 与节点当前 nodeVersion 不一致。
 * 带上当前快照，方便调用方重读、rebase、重试。
 */
export class StaleRevisionError extends Error {
    constructor(node, expected) {
        super(`stale revision: expected ${expected}, current ${node.nodeVersion}`);
        this.name = 'StaleRevisionError';
        this.code = 'STALE_REVISION';
        this.id = node.id;
        this.expectedVersion = expected;
        this.currentVersion = node.nodeVersion;
        this.currentDigest = node.digest ?? null;
        this.updatedBy = node.updatedBy ?? null;
        this.updatedAt = node.updatedAt ?? null;
    }
}

/** 租约/写域失败；code 用于工具层返回可判别的错误。 */
export class LeaseError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'LeaseError';
        this.code = code;
        Object.assign(this, details);
    }
}

/** 默认 ISO 时间。测试里注入固定值。 */
export function nowIso() {
    return new Date().toISOString();
}

/**
 * 新建一张空图。
 *
 * @param {{workspaceRoot: string, now?: string, meta?: object}} input
 */
export function createGraphState({ workspaceRoot, now = nowIso(), meta = {} }) {
    const state = {
        version: GRAPH_VERSION,
        workspaceRoot,
        createdAt: now,
        updatedAt: now,
        seq: 0,
        edgeSeq: 0,
        nodes: new Map(),
        edges: [],
        roots: new Set(),
        sessions: new Map(),
        meta: { extractor: 'deterministic-v1', ...meta },
        dirty: false,
        index: {
            children: new Map(),
            fingerprints: new Map(),
        },
    };
    return state;
}

/** 下一个节点 id。 */
export function nextNodeId(state) {
    state.seq += 1;
    return `n${state.seq}`;
}

/** 下一个关系 id。 */
export function nextEdgeId(state) {
    state.edgeSeq += 1;
    return `e${state.edgeSeq}`;
}

function touch(state, now) {
    state.updatedAt = now;
    state.dirty = true;
}

// ───────────────────────────── 索引 ─────────────────────────────

function indexChildrenAdd(state, parentId, childId) {
    if (parentId === null) return;
    const list = state.index.children.get(parentId);
    if (list === undefined) state.index.children.set(parentId, [childId]);
    else if (!list.includes(childId)) list.push(childId);
}

function indexChildrenRemove(state, parentId, childId) {
    if (parentId === null) return;
    const list = state.index.children.get(parentId);
    if (list === undefined) return;
    const next = list.filter((id) => id !== childId);
    if (next.length === 0) state.index.children.delete(parentId);
    else state.index.children.set(parentId, next);
}

function indexFingerprintAdd(state, node) {
    if (typeof node.fingerprint !== 'string' || node.fingerprint === '') return;
    const list = state.index.fingerprints.get(node.fingerprint);
    if (list === undefined) state.index.fingerprints.set(node.fingerprint, [node.id]);
    else if (!list.includes(node.id)) list.push(node.id);
}

function indexFingerprintRemove(state, node) {
    if (typeof node.fingerprint !== 'string' || node.fingerprint === '') return;
    const list = state.index.fingerprints.get(node.fingerprint);
    if (list === undefined) return;
    const next = list.filter((id) => id !== node.id);
    if (next.length === 0) state.index.fingerprints.delete(node.fingerprint);
    else state.index.fingerprints.set(node.fingerprint, next);
}

/** 从 nodes 重建全部派生索引（加载/迁移后调用）。 */
export function rebuildIndexes(state) {
    state.roots = new Set();
    state.index.children = new Map();
    state.index.fingerprints = new Map();
    for (const node of state.nodes.values()) {
        if (node.parentId === null || node.parentId === undefined) state.roots.add(node.id);
        else indexChildrenAdd(state, node.parentId, node.id);
        indexFingerprintAdd(state, node);
    }
    for (const [parentId, list] of state.index.children) {
        list.sort((a, b) => compareSiblings(state, a, b));
        state.index.children.set(parentId, list);
    }
}

function compareSiblings(state, a, b) {
    const na = state.nodes.get(a);
    const nb = state.nodes.get(b);
    if (na === undefined || nb === undefined) return a < b ? -1 : 1;
    if (na.order !== nb.order) return na.order - nb.order;
    return na.id < nb.id ? -1 : na.id > nb.id ? 1 : 0;
}

// ───────────────────────────── 节点 ─────────────────────────────

/**
 * 新建节点。
 *
 * @param {object} state
 * @param {object} input
 * @param {{now?: string, id?: string, record?: boolean}} [opts]
 * @returns {object} node
 */
export function addNode(state, input, opts = {}) {
    const now = opts.now ?? nowIso();
    const id = opts.id ?? nextNodeId(state);
    if (state.nodes.has(id)) {
        throw new Error(`duplicate node id: ${id}`);
    }
    const parentId = input.parentId ?? null;
    if (parentId !== null && !state.nodes.has(parentId)) {
        throw new Error(`missing parent node: ${parentId}`);
    }
    const kind = normalizeKind(input.kind);
    const status = normalizeStatus(input.status, kind === 'conclusion' ? 'done' : 'open');
    const order = Number.isInteger(input.order)
        ? input.order
        : nextSiblingOrder(state, parentId);
    const node = {
        id,
        parentId,
        kind,
        title: clampText(input.title, MAX_TITLE) || `（未命名 ${kind}）`,
        summary: clampText(input.summary, MAX_SUMMARY, { keepNewlines: true }),
        status,
        closeReason: status === 'open' || status === 'active'
            ? null
            : normalizeCloseReason(input.closeReason, defaultCloseReasonFor(kind, status)),
        resolutionBy: status === 'open' || status === 'active'
            ? null
            : normalizeResolutionBy(input.resolutionBy, 'auto'),
        confidence: normalizeConfidence(input.confidence),
        tags: normalizeTags(input.tags),
        origin: normalizeOrigin(input.origin),
        sessionId: typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null,
        turn: Number.isInteger(input.turn) ? input.turn : null,
        stepId: typeof input.stepId === 'string' && input.stepId !== '' ? input.stepId : null,
        refs: normalizeRefs(input.refs),
        fingerprint: typeof input.fingerprint === 'string' && input.fingerprint !== '' ? input.fingerprint : null,
        hits: Number.isInteger(input.hits) && input.hits > 0 ? input.hits : 1,
        // 摘要主干（topic）字段；其余 kind 也可携带，UI/同步器按需读取。
        digest: normalizeDigest(input.digest),
        digestSource: normalizeDigestSource(input.digestSource),
        digestBasis: normalizeDigestBasis(input.digestBasis),
        owner: clampText(input.owner, 120) || null,
        leaseUntil: normalizeIso(input.leaseUntil),
        leaseEpoch: Number.isInteger(input.leaseEpoch) && input.leaseEpoch >= 0 ? input.leaseEpoch : 0,
        priority: normalizePriority(input.priority),
        // 节点级版本用于 CAS；与 digest 的 revision（摘要历史）语义分开。
        nodeVersion: Number.isInteger(input.nodeVersion) && input.nodeVersion > 0 ? input.nodeVersion : 1,
        createdBy: normalizeActor(input.createdBy ?? input.updatedBy),
        updatedBy: normalizeActor(input.updatedBy ?? input.createdBy),
        revision: Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1,
        digestHistory: normalizeDigestHistory(input.digestHistory),
        order,
        createdAt: now,
        updatedAt: now,
    };
    if (node.digest !== null && node.digestHistory.length === 0) {
        node.digestHistory = [{ digest: node.digest, source: node.digestSource, at: now, revision: node.revision }];
    }
    if (input.auto !== undefined && input.auto !== null) {
        node.auto = cloneJson(input.auto);
    }
    if (input.mergedFrom !== undefined) node.mergedFrom = [...input.mergedFrom];
    state.nodes.set(id, node);
    if (parentId === null) state.roots.add(id);
    else indexChildrenAdd(state, parentId, id);
    indexFingerprintAdd(state, node);
    touch(state, now);
    return node;
}

function normalizeOrigin(value) {
    return value === 'auto' || value === 'user' || value === 'model' ? value : 'model';
}

/** digest 归一化：单行、截断；空串视为 null。 */
function normalizeDigest(value) {
    const text = clampText(value, MAX_DIGEST);
    return text === '' ? null : text;
}

/** 历史摘要（最多 20 版，旧→新），用于回滚与审计。 */
function normalizeDigestHistory(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value.slice(-20)) {
        if (item === null || typeof item !== 'object') continue;
        const digest = normalizeDigest(item.digest);
        if (digest === null) continue;
        out.push({
            digest,
            source: normalizeDigestSource(item.source),
            at: normalizeIso(item.at),
            revision: Number.isInteger(item.revision) && item.revision > 0 ? item.revision : 1,
        });
    }
    return out;
}

/** digest 依据：子节点 id 列表 + 摘要哈希，用于判断摘要是否过期。 */
function normalizeDigestBasis(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const children = Array.isArray(value.children)
        ? value.children.filter((id) => typeof id === 'string' && id !== '').slice(0, 64)
        : [];
    const hash = typeof value.hash === 'string' && value.hash !== '' ? value.hash.slice(0, 64) : null;
    return { children, hash };
}

/** ISO 时间或 null。 */
function normalizeIso(value) {
    if (typeof value !== 'string' || value === '') return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function nextSiblingOrder(state, parentId) {
    let max = 0;
    if (parentId === null) {
        for (const id of state.roots) {
            const node = state.nodes.get(id);
            if (node !== undefined && node.order > max) max = node.order;
        }
        return max + 1;
    }
    const children = state.index.children.get(parentId) ?? [];
    for (const id of children) {
        const node = state.nodes.get(id);
        if (node !== undefined && node.order > max) max = node.order;
    }
    // 也扫描 nodes，避免索引尚未建立/被外部改坏时出现重复 order。
    for (const node of state.nodes.values()) {
        if (node.parentId === parentId && node.order > max) max = node.order;
    }
    return max + 1;
}

/**
 * 局部更新。只接受下列字段；parentId 请走 moveNode()。
 *
 * @param {object} state
 * @param {string} id
 * @param {object} patch
 * @param {{now?: string}} [opts]
 * @returns {object} node
 */
export function updateNode(state, id, patch, opts = {}) {
    const now = opts.now ?? nowIso();
    const node = state.nodes.get(id);
    if (node === undefined) throw new Error(`unknown node: ${id}`);
    if (Number.isInteger(opts.expectedRevision) && opts.expectedRevision !== node.nodeVersion) {
        throw new StaleRevisionError(node, opts.expectedRevision);
    }
    if (patch === null || typeof patch !== 'object') return node;
    if (patch.kind !== undefined) node.kind = normalizeKind(patch.kind, node.kind);
    if (patch.title !== undefined) {
        const title = clampText(patch.title, MAX_TITLE);
        if (title !== '') node.title = title;
    }
    if (patch.summary !== undefined) {
        node.summary = clampText(patch.summary, MAX_SUMMARY, { keepNewlines: true });
    }
    if (patch.status !== undefined) node.status = normalizeStatus(patch.status, node.status);
    if (patch.closeReason !== undefined) node.closeReason = normalizeCloseReason(patch.closeReason);
    if (patch.resolutionBy !== undefined) node.resolutionBy = normalizeResolutionBy(patch.resolutionBy);
    // 重新打开时清掉旧结束原因；否则展示层会继续把节点算进「已关闭/死路」。
    if (node.status === 'open' || node.status === 'active') {
        node.closeReason = null;
        node.resolutionBy = null;
    } else {
        // P1：只有 status 没有 reason 的旧写法在这里补齐；显式原因永远优先。
        if (node.closeReason === null || node.closeReason === undefined) {
            node.closeReason = defaultCloseReasonFor(node.kind, node.status);
        }
        if (node.resolutionBy === null || node.resolutionBy === undefined) node.resolutionBy = 'auto';
    }
    if (patch.confidence !== undefined) node.confidence = normalizeConfidence(patch.confidence);
    if (patch.tags !== undefined) node.tags = normalizeTags(patch.tags);
    if (patch.refs !== undefined) node.refs = normalizeRefs(patch.refs);
    if (patch.sessionId !== undefined) node.sessionId = patch.sessionId || null;
    if (patch.turn !== undefined) node.turn = Number.isInteger(patch.turn) ? patch.turn : null;
    if (patch.fingerprint !== undefined) {
        indexFingerprintRemove(state, node);
        node.fingerprint = typeof patch.fingerprint === 'string' && patch.fingerprint !== '' ? patch.fingerprint : null;
        indexFingerprintAdd(state, node);
    }
    if (patch.hits !== undefined) {
        node.hits = Number.isInteger(patch.hits) && patch.hits > 0 ? patch.hits : node.hits;
    }
    if (patch.auto !== undefined) node.auto = cloneJson(patch.auto);
    if (patch.stepId !== undefined) node.stepId = typeof patch.stepId === 'string' && patch.stepId !== '' ? patch.stepId : null;
    if (patch.digest !== undefined) {
        const nextDigest = normalizeDigest(patch.digest);
        if (nextDigest !== node.digest) {
            node.digest = nextDigest;
            node.revision = (Number.isInteger(node.revision) ? node.revision : 1) + 1;
            if (nextDigest !== null) {
                const history = Array.isArray(node.digestHistory) ? node.digestHistory : [];
                history.push({
                    digest: nextDigest,
                    source: normalizeDigestSource(patch.digestSource, node.digestSource ?? null),
                    at: now,
                    revision: node.revision,
                });
                node.digestHistory = history.slice(-20);
            }
        } else {
            node.digest = nextDigest;
        }
    }
    if (patch.digestSource !== undefined) node.digestSource = normalizeDigestSource(patch.digestSource, node.digestSource ?? null);
    if (patch.digestBasis !== undefined) node.digestBasis = normalizeDigestBasis(patch.digestBasis);
    if (patch.owner !== undefined) node.owner = clampText(patch.owner, 120) || null;
    if (patch.leaseUntil !== undefined) node.leaseUntil = normalizeIso(patch.leaseUntil);
    if (patch.leaseEpoch !== undefined) {
        node.leaseEpoch = Number.isInteger(patch.leaseEpoch) && patch.leaseEpoch >= 0 ? patch.leaseEpoch : node.leaseEpoch;
    }
    if (patch.createdBy !== undefined) node.createdBy = normalizeActor(patch.createdBy);
    if (patch.updatedBy !== undefined) node.updatedBy = normalizeActor(patch.updatedBy);
    if (patch.priority !== undefined) node.priority = normalizePriority(patch.priority);
    if (patch.revision !== undefined) {
        node.revision = Number.isInteger(patch.revision) && patch.revision > 0 ? patch.revision : node.revision;
    }
    node.nodeVersion = (Number.isInteger(node.nodeVersion) ? node.nodeVersion : 1) + 1;
    if (opts.actor !== undefined && opts.actor !== null && opts.actor !== '') {
        node.updatedBy = normalizeActor(opts.actor);
    }
    node.updatedAt = now;
    touch(state, now);
    return node;
}

/**
 * 认领 / 续租 / 释放 topic。租约是软约束；leaseEpoch 用于诊断和后续 fencing。
 *
 * @param {object} state
 * @param {string} id
 * @param {{owner?: string|null, leaseUntil?: string|null, actor?: string|null, renew?: boolean, steal?: boolean, expectedRevision?: number, now?: string}} input
 * @returns {object} node
 */
export function assignLease(state, id, input = {}) {
    const now = input.now ?? nowIso();
    const node = requireNode(state, id);
    if (node.kind !== 'topic') {
        throw new LeaseError('NOT_TOPIC', `assign 只用于 topic；${id} 是 ${node.kind}。`, { id });
    }
    if (input.expectedRevision !== undefined) ensureRevision(state, id, input.expectedRevision);
    const actor = normalizeActor(input.actor);
    const release = input.owner === null || input.owner === undefined || input.owner === '';
    if (release && input.renew !== true) {
        if (actor !== null && node.owner !== null && node.owner !== actor && actor !== 'lead' && actor !== 'curator') {
            throw new LeaseError('NOT_OWNER', `${id} 当前由 ${node.owner} 持有，不能由 ${actor} 释放。`, { id, owner: node.owner, leaseUntil: node.leaseUntil });
        }
        node.owner = null;
        node.leaseUntil = null;
        node.leaseEpoch = (Number.isInteger(node.leaseEpoch) ? node.leaseEpoch : 0) + 1;
        node.nodeVersion = (Number.isInteger(node.nodeVersion) ? node.nodeVersion : 1) + 1;
        if (actor !== null) node.updatedBy = actor;
        node.updatedAt = now;
        touch(state, now);
        return node;
    }
    const requestedOwner = normalizeActor(input.owner) ?? normalizeActor(input.renew === true ? node.owner : null) ?? actor;
    if (requestedOwner === null) {
        throw new LeaseError('NO_OWNER', 'assign 需要 owner（认领）或 owner:null（释放）。', { id });
    }
    const active = node.owner !== null
        && node.leaseUntil !== null
        && Number.isFinite(Date.parse(node.leaseUntil))
        && Date.parse(node.leaseUntil) > Date.parse(now);
    if (active && node.owner !== requestedOwner && input.steal !== true) {
        throw new LeaseError('LEASE_HELD', `${id} 已被 ${node.owner} 认领（租约至 ${node.leaseUntil}）；如需接管请传 steal:true。`, {
            id,
            owner: node.owner,
            leaseUntil: node.leaseUntil,
            leaseEpoch: node.leaseEpoch ?? 0,
        });
    }
    if (input.renew === true && node.owner !== null && node.owner !== requestedOwner) {
        throw new LeaseError('NOT_OWNER', `${id} 当前由 ${node.owner} 持有，${requestedOwner} 不能续租。`, { id, owner: node.owner });
    }
    node.owner = requestedOwner;
    node.leaseUntil = normalizeIso(input.leaseUntil);
    node.leaseEpoch = (Number.isInteger(node.leaseEpoch) ? node.leaseEpoch : 0) + 1;
    node.nodeVersion = (Number.isInteger(node.nodeVersion) ? node.nodeVersion : 1) + 1;
    if (actor !== null) node.updatedBy = actor;
    node.updatedAt = now;
    touch(state, now);
    return node;
}

/**
 * P5.4 原子交接：把 topic 的租约转给 to，并在 topic 下写一条 handoff conclusion。
 *
 * 交接节点同时充当「交接包」：摘要里带当前 digest、未决叶根与关键节点；
 * owner/leaseUntil/leaseEpoch 在同一个 op 内更新，避免「节点写了但租约没转」的半状态。
 *
 * @param {object} state
 * @param {string} id topic id
 * @param {{to?: string|null, actor?: string|null, leaseUntil?: string|null, summary?: string, expectedRevision?: number, now?: string}} input
 * @returns {{topic: object, node: object}}
 */
export function handoff(state, id, input = {}) {
    const now = input.now ?? nowIso();
    const topic = requireNode(state, id);
    if (topic.kind !== 'topic') {
        throw new LeaseError('NOT_TOPIC', `handoff 只用于 topic；${id} 是 ${topic.kind}。`, { id });
    }
    if (input.expectedRevision !== undefined) ensureRevision(state, id, input.expectedRevision);
    const actor = normalizeActor(input.actor);
    const to = normalizeActor(input.to);
    if (to === null) {
        throw new LeaseError('NO_TARGET', 'handoff 需要 toActor（接手者 id）。', { id });
    }
    if (actor !== null && topic.owner !== null && topic.owner !== actor && actor !== 'lead' && actor !== 'curator') {
        throw new LeaseError('NOT_OWNER', `${id} 当前由 ${topic.owner} 持有，不能由 ${actor} 交接。`, {
            id,
            owner: topic.owner,
            leaseUntil: topic.leaseUntil,
            leaseEpoch: topic.leaseEpoch ?? 0,
        });
    }
    topic.owner = to;
    topic.leaseUntil = normalizeIso(input.leaseUntil);
    topic.leaseEpoch = (Number.isInteger(topic.leaseEpoch) ? topic.leaseEpoch : 0) + 1;
    topic.nodeVersion = (Number.isInteger(topic.nodeVersion) ? topic.nodeVersion : 1) + 1;
    if (actor !== null) topic.updatedBy = actor;
    topic.updatedAt = now;
    const node = addNode(state, {
        parentId: id,
        kind: 'conclusion',
        title: `交接：${actor ?? 'unknown'} → ${to}`,
        summary: typeof input.summary === 'string' ? input.summary : '',
        status: 'done',
        origin: 'model',
        tags: ['handoff', `from:${actor ?? 'unknown'}`, `to:${to}`],
        createdBy: actor ?? undefined,
        updatedBy: actor ?? undefined,
        sessionId: topic.sessionId ?? undefined,
        stepId: topic.stepId ?? undefined,
    }, { now });
    touch(state, now);
    return { topic, node };
}

/** 校验节点当前 nodeVersion（不匹配抛 StaleRevisionError）。 */
export function ensureRevision(state, id, expectedRevision) {
    if (!Number.isInteger(expectedRevision)) return;
    const node = requireNode(state, id);
    if (expectedRevision !== node.nodeVersion) throw new StaleRevisionError(node, expectedRevision);
}

/**
 * 移动节点到新父节点（或根）。禁止把节点移到自己的子树里。
 *
 * @returns {object} node
 */
export function moveNode(state, id, newParentId, opts = {}) {
    const now = opts.now ?? nowIso();
    const node = state.nodes.get(id);
    if (node === undefined) throw new Error(`unknown node: ${id}`);
    if (opts.expectedRevision !== undefined) ensureRevision(state, id, opts.expectedRevision);
    const target = newParentId ?? null;
    if (target !== null) {
        if (!state.nodes.has(target)) throw new Error(`missing parent node: ${target}`);
        if (target === id) throw new Error('cannot move node under itself');
        if (isDescendant(state, id, target)) {
            throw new Error('cannot move node under its own descendant');
        }
    }
    if (node.parentId === target) return node;
    indexChildrenRemove(state, node.parentId, id);
    node.parentId = target;
    if (target === null) state.roots.add(id);
    else state.roots.delete(id);
    indexChildrenAdd(state, target, id);
    node.order = nextSiblingOrder(state, target);
    node.updatedAt = now;
    node.nodeVersion += 1;
    const actor = normalizeActor(opts.actor);
    if (actor !== null) node.updatedBy = actor;
    touch(state, now);
    return node;
}

/** childId 是否是 ancestorId 的后代（含自身由调用方判断）。 */
export function isDescendant(state, ancestorId, childId) {
    let cursor = state.nodes.get(childId);
    const guard = new Set();
    while (cursor !== undefined) {
        if (guard.has(cursor.id)) return false; // 防御：结构损坏时不死循环
        guard.add(cursor.id);
        if (cursor.parentId === ancestorId) return true;
        if (cursor.parentId === null || cursor.parentId === undefined) return false;
        cursor = state.nodes.get(cursor.parentId);
    }
    return false;
}

// ───────────────────────────── 关系 ─────────────────────────────

/**
 * 加一条旁支关系。同一对端点 + 同一种关系只保留一条。
 *
 * @returns {object|null} edge（已存在时返回已有边）
 */
export function linkNodes(state, from, to, kind = 'related', note = '', opts = {}) {
    const now = opts.now ?? nowIso();
    if (!state.nodes.has(from)) throw new Error(`unknown node: ${from}`);
    if (!state.nodes.has(to)) throw new Error(`unknown node: ${to}`);
    if (from === to) throw new Error('cannot link a node to itself');
    const edgeKind = normalizeEdgeKind(kind);
    const existing = state.edges.find((edge) => edge.from === from && edge.to === to && edge.kind === edgeKind);
    if (existing !== undefined) {
        if (note !== '' && existing.note === '') existing.note = clampText(note, 1000);
        return existing;
    }
    const edge = {
        id: opts.id ?? nextEdgeId(state),
        from,
        to,
        kind: edgeKind,
        note: clampText(note, 1000),
        createdAt: now,
    };
    state.edges.push(edge);
    touch(state, now);
    return edge;
}

/** 删除一条关系（按 id）。返回是否删到。 */
export function unlinkEdge(state, edgeId, opts = {}) {
    const now = opts.now ?? nowIso();
    const before = state.edges.length;
    state.edges = state.edges.filter((edge) => edge.id !== edgeId);
    if (state.edges.length !== before) {
        touch(state, now);
        return true;
    }
    return false;
}

/** 端点相关的边。 */
export function edgesOf(state, id) {
    return state.edges.filter((edge) => edge.from === id || edge.to === id);
}

// ───────────────────────────── 查询 ─────────────────────────────

export function getNode(state, id) {
    return state.nodes.get(id) ?? null;
}

export function requireNode(state, id) {
    const node = state.nodes.get(id);
    if (node === undefined) throw new Error(`unknown node: ${id}`);
    return node;
}

/** 直接子节点（按 order 排序）。 */
export function childrenOf(state, id) {
    const ids = state.index.children.get(id) ?? [];
    return ids.map((childId) => state.nodes.get(childId)).filter((node) => node !== undefined);
}

/** 根节点（按 order 排序）。 */
export function rootNodes(state) {
    const list = [...state.roots].map((id) => state.nodes.get(id)).filter((node) => node !== undefined);
    list.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : 1));
    return list;
}

/** 从根到该节点的路径（含自身）。 */
export function pathToRoot(state, id) {
    const path = [];
    let cursor = state.nodes.get(id);
    const guard = new Set();
    while (cursor !== undefined) {
        if (guard.has(cursor.id)) break;
        guard.add(cursor.id);
        path.push(cursor);
        if (cursor.parentId === null || cursor.parentId === undefined) break;
        cursor = state.nodes.get(cursor.parentId);
    }
    return path.reverse();
}

/** 子树 id（默认含自身），前序 DFS。 */
export function subtreeIds(state, id, { includeSelf = true } = {}) {
    const out = [];
    const stack = includeSelf ? [id] : [...(state.index.children.get(id) ?? [])];
    const seen = new Set();
    while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined || seen.has(current) || !state.nodes.has(current)) continue;
        seen.add(current);
        out.push(current);
        const children = state.index.children.get(current) ?? [];
        for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
    return out;
}

/** 按指纹找节点（按创建顺序）。 */
export function findByFingerprint(state, fp) {
    if (typeof fp !== 'string' || fp === '') return [];
    const ids = state.index.fingerprints.get(fp) ?? [];
    return ids.map((id) => state.nodes.get(id)).filter((node) => node !== undefined);
}

/** 旁支关系的另一端。 */
export function relatedNodes(state, id, kind = null) {
    const out = [];
    for (const edge of state.edges) {
        if (kind !== null && edge.kind !== kind) continue;
        if (edge.from === id) {
            const node = state.nodes.get(edge.to);
            if (node !== undefined) out.push({ edge, node });
        } else if (edge.to === id) {
            const node = state.nodes.get(edge.from);
            if (node !== undefined) out.push({ edge, node });
        }
    }
    return out;
}

// ───────────────────────────── 会话 ─────────────────────────────

/** 取/建会话游标。 */
export function sessionOf(state, sessionId, now = nowIso()) {
    const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'anonymous';
    let session = state.sessions.get(key);
    if (session === undefined) {
        session = { sessionId: key, activeNodeId: null, goalId: null, turn: 0, lastSeenAt: now, createdAt: now };
        state.sessions.set(key, session);
    }
    return session;
}

/** 设置会话活跃节点（自动提取的挂载点）。 */
export function setActiveNode(state, sessionId, nodeId, now = nowIso()) {
    const session = sessionOf(state, sessionId, now);
    if (nodeId !== null && !state.nodes.has(nodeId)) throw new Error(`unknown node: ${nodeId}`);
    session.activeNodeId = nodeId;
    session.lastSeenAt = now;
    state.dirty = true;
    return session;
}

/** 推进会话轮次。 */
export function advanceTurn(state, sessionId, turn = null, now = nowIso()) {
    const session = sessionOf(state, sessionId, now);
    session.turn = Number.isInteger(turn) ? turn : session.turn + 1;
    session.lastSeenAt = now;
    state.dirty = true;
    return session;
}

// ───────────────────────────── 合并/删除 ─────────────────────────────

/**
 * 合并两个节点：drop 的子节点、关系、标签、命中数并入 keep，drop 留占位。
 *
 * @returns {{keep: object, drop: object}}
 */
export function mergeNodes(state, keepId, dropId, opts = {}) {
    const now = opts.now ?? nowIso();
    const keep = requireNode(state, keepId);
    const drop = requireNode(state, dropId);
    if (opts.expectedRevision !== undefined) ensureRevision(state, keepId, opts.expectedRevision);
    if (keepId === dropId) throw new Error('cannot merge a node into itself');
    if (isDescendant(state, dropId, keepId)) {
        throw new Error('cannot merge an ancestor into its descendant');
    }
    for (const child of childrenOf(state, dropId)) {
        moveNode(state, child.id, keepId, { now });
    }
    const movedEdges = [];
    for (const edge of state.edges) {
        if (edge.from === dropId && edge.to === dropId) continue;
        if (edge.from === dropId) movedEdges.push({ ...edge, from: keepId });
        else if (edge.to === dropId) movedEdges.push({ ...edge, to: keepId });
    }
    state.edges = state.edges.filter((edge) => edge.from !== dropId && edge.to !== dropId);
    for (const edge of movedEdges) {
        if (edge.from === edge.to) continue;
        try {
            linkNodes(state, edge.from, edge.to, edge.kind, edge.note, { now });
        } catch {
            // 端点缺失等异常：丢弃这条边，不阻断合并。
        }
    }
    const tags = new Set(keep.tags);
    for (const tag of drop.tags) tags.add(tag);
    tags.add('merged');
    keep.tags = [...tags];
    keep.hits += Math.max(1, drop.hits);
    keep.refs = normalizeRefs([...keep.refs, ...drop.refs]);
    keep.summary = clampText(
        `${keep.summary}${keep.summary === '' ? '' : '\n\n'}（合并自 ${drop.id}：${drop.title}）`,
        MAX_SUMMARY,
        { keepNewlines: true },
    );
    keep.mergedFrom = [...(keep.mergedFrom ?? []), drop.id];
    keep.nodeVersion = (Number.isInteger(keep.nodeVersion) ? keep.nodeVersion : 1) + 1;
    drop.nodeVersion = (Number.isInteger(drop.nodeVersion) ? drop.nodeVersion : 1) + 1;
    const mergeActor = normalizeActor(opts.actor);
    if (mergeActor !== null) {
        keep.updatedBy = mergeActor;
        drop.updatedBy = mergeActor;
    }
    keep.updatedAt = now;
    drop.status = 'abandoned';
    drop.closeReason = normalizeCloseReason(opts.closeReason, 'duplicate');
    drop.resolutionBy = normalizeResolutionBy(opts.resolutionBy, 'auto');
    drop.tags = [...new Set([...drop.tags, 'merged-into'])];
    drop.summary = clampText(`已合并进 ${keepId}。${drop.summary}`, MAX_SUMMARY, { keepNewlines: true });
    drop.updatedAt = now;
    touch(state, now);
    return { keep, drop };
}

/**
 * 物理删除节点：子节点上移给它的父节点；相关边删除。
 * 只给测试/维护入口用，工具层不暴露。
 */
export function removeNode(state, id, opts = {}) {
    const now = opts.now ?? nowIso();
    const node = requireNode(state, id);
    const parentId = node.parentId ?? null;
    for (const child of childrenOf(state, id)) moveNode(state, child.id, parentId, { now });
    indexChildrenRemove(state, node.parentId, id);
    indexFingerprintRemove(state, node);
    state.nodes.delete(id);
    state.roots.delete(id);
    state.edges = state.edges.filter((edge) => edge.from !== id && edge.to !== id);
    touch(state, now);
    return node;
}

// ───────────────────────────── 统计/校验 ─────────────────────────────

/** 统计摘要（UI 与工具共用）。 */
export function graphStats(state) {
    const byKind = {};
    const byStatus = {};
    const byCloseReason = {};
    const byResolution = {};
    const byCreator = {};
    const byUpdater = {};
    let repeated = 0;
    for (const node of state.nodes.values()) {
        byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
        byStatus[node.status] = (byStatus[node.status] ?? 0) + 1;
        if (typeof node.closeReason === 'string' && node.closeReason !== '') {
            byCloseReason[node.closeReason] = (byCloseReason[node.closeReason] ?? 0) + 1;
        }
        if (typeof node.resolutionBy === 'string' && node.resolutionBy !== '') {
            byResolution[node.resolutionBy] = (byResolution[node.resolutionBy] ?? 0) + 1;
        }
        const creator = node.createdBy ?? 'unknown';
        const updater = node.updatedBy ?? 'unknown';
        byCreator[creator] = (byCreator[creator] ?? 0) + 1;
        byUpdater[updater] = (byUpdater[updater] ?? 0) + 1;
        if (node.hits > 1) repeated += 1;
    }
    const hypotheses = state.nodes.size > 0
        ? [...state.nodes.values()].filter((node) => node.kind === 'hypothesis')
        : [];
    const unverified = hypotheses.filter((node) => childrenOf(state, node.id).every((child) => child.kind !== 'evidence'));
    return {
        nodes: state.nodes.size,
        edges: state.edges.length,
        roots: state.roots.size,
        sessions: state.sessions.size,
        byKind,
        byStatus,
        byCloseReason,
        byResolution,
        byCreator,
        byUpdater,
        repeated,
        hypotheses: hypotheses.length,
        unverifiedHypotheses: unverified.length,
        deadEnds: byKind.dead_end ?? 0,
        conclusions: byKind.conclusion ?? 0,
        artifacts: byKind.artifact ?? 0,
    };
}

/**
 * 结构不变量校验：父存在、无环、根索引正确、边端点存在、会话游标存在。
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateGraph(state) {
    const errors = [];
    for (const node of state.nodes.values()) {
        if (node.parentId !== null && node.parentId !== undefined && !state.nodes.has(node.parentId)) {
            errors.push(`${node.id}: missing parent ${node.parentId}`);
        }
        if ((node.parentId === null || node.parentId === undefined) && !state.roots.has(node.id)) {
            errors.push(`${node.id}: root not indexed`);
        }
        if (node.parentId !== null && node.parentId !== undefined && state.roots.has(node.id)) {
            errors.push(`${node.id}: indexed as root but has parent`);
        }
    }
    for (const id of state.roots) {
        if (!state.nodes.has(id)) errors.push(`root index references missing node ${id}`);
    }
    for (const node of state.nodes.values()) {
        let cursor = node;
        const seen = new Set();
        while (cursor !== undefined && cursor.parentId !== null && cursor.parentId !== undefined) {
            if (seen.has(cursor.id)) {
                errors.push(`${node.id}: cycle detected`);
                break;
            }
            seen.add(cursor.id);
            if (seen.size > state.nodes.size + 1) {
                errors.push(`${node.id}: cycle detected`);
                break;
            }
            cursor = state.nodes.get(cursor.parentId);
        }
    }
    for (const edge of state.edges) {
        if (!state.nodes.has(edge.from)) errors.push(`${edge.id}: missing from ${edge.from}`);
        if (!state.nodes.has(edge.to)) errors.push(`${edge.id}: missing to ${edge.to}`);
        if (edge.from === edge.to) errors.push(`${edge.id}: self edge`);
    }
    for (const session of state.sessions.values()) {
        if (session.activeNodeId !== null && !state.nodes.has(session.activeNodeId)) {
            errors.push(`session ${session.sessionId}: missing active node ${session.activeNodeId}`);
        }
        if (session.goalId !== null && !state.nodes.has(session.goalId)) {
            errors.push(`session ${session.sessionId}: missing goal ${session.goalId}`);
        }
    }
    return { ok: errors.length === 0, errors };
}

// ───────────────────────────── 序列化 ─────────────────────────────

/** 内存态 → 快照 JSON（可安全 JSON.stringify）。 */
export function toJSON(state) {
    const nodes = {};
    for (const [id, node] of state.nodes) nodes[id] = cloneJson(node);
    const sessions = {};
    for (const [id, session] of state.sessions) sessions[id] = cloneJson(session);
    return {
        version: state.version,
        workspaceRoot: state.workspaceRoot,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        seq: state.seq,
        edgeSeq: state.edgeSeq,
        nodes,
        edges: state.edges.map((edge) => cloneJson(edge)),
        roots: [...state.roots],
        sessions,
        meta: cloneJson(state.meta),
    };
}

/** 快照 JSON → 内存态。结构不合法时抛错（由 store 决定如何恢复）。 */
export function fromJSON(raw) {
    if (raw === null || typeof raw !== 'object') throw new Error('graph snapshot is not an object');
    if (!SUPPORTED_GRAPH_VERSIONS.includes(raw.version)) {
        throw new Error(`unsupported graph version: ${String(raw.version)}`);
    }
    if (typeof raw.workspaceRoot !== 'string' || raw.workspaceRoot === '') {
        throw new Error('graph snapshot has no workspaceRoot');
    }
    const state = createGraphState({
        workspaceRoot: raw.workspaceRoot,
        now: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
        meta: raw.meta !== null && typeof raw.meta === 'object' ? raw.meta : {},
    });
    // 旧图保持 v1，直到显式迁移；否则一次普通写入就会把缺字段的图标成 v2。
    state.version = raw.version;
    state.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : state.createdAt;
    state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : state.updatedAt;
    state.seq = Number.isInteger(raw.seq) ? raw.seq : 0;
    state.edgeSeq = Number.isInteger(raw.edgeSeq) ? raw.edgeSeq : 0;
    if (raw.nodes !== null && typeof raw.nodes === 'object') {
        for (const [id, node] of Object.entries(raw.nodes)) {
            if (node === null || typeof node !== 'object') continue;
            const normalized = sanitizeSnapshotNode(id, node);
            if (normalized === null) continue;
            state.nodes.set(id, normalized);
        }
    }
    state.edges = Array.isArray(raw.edges)
        ? raw.edges.filter((edge) => edge !== null && typeof edge === 'object' && typeof edge.from === 'string' && typeof edge.to === 'string')
            .map((edge, index) => ({
                id: typeof edge.id === 'string' && edge.id !== '' ? edge.id : `e${index + 1}`,
                from: edge.from,
                to: edge.to,
                kind: normalizeEdgeKind(edge.kind),
                note: clampText(edge.note, 1000),
                createdAt: typeof edge.createdAt === 'string' ? edge.createdAt : state.updatedAt,
            }))
        : [];
    state.sessions = new Map();
    if (raw.sessions !== null && typeof raw.sessions === 'object') {
        for (const [id, session] of Object.entries(raw.sessions)) {
            if (session === null || typeof session !== 'object') continue;
            state.sessions.set(id, {
                sessionId: typeof session.sessionId === 'string' ? session.sessionId : id,
                activeNodeId: typeof session.activeNodeId === 'string' ? session.activeNodeId : null,
                goalId: typeof session.goalId === 'string' ? session.goalId : null,
                turn: Number.isInteger(session.turn) ? session.turn : 0,
                lastSeenAt: typeof session.lastSeenAt === 'string' ? session.lastSeenAt : state.updatedAt,
                createdAt: typeof session.createdAt === 'string' ? session.createdAt : state.updatedAt,
            });
        }
    }
    rebuildIndexes(state);
    // seq 至少覆盖现有最大 id，避免 id 复用。
    for (const id of state.nodes.keys()) {
        const match = /^n(\d+)$/.exec(id);
        if (match !== null) {
            const numeric = Number(match[1]);
            if (numeric > state.seq) state.seq = numeric;
        }
    }
    const maxEdge = state.edges.reduce((max, edge) => {
        const match = /^e(\d+)$/.exec(edge.id);
        return match === null ? max : Math.max(max, Number(match[1]));
    }, 0);
    if (maxEdge > state.edgeSeq) state.edgeSeq = maxEdge;
    state.dirty = false;
    return state;
}

function sanitizeSnapshotNode(id, raw) {
    if (typeof id !== 'string' || !/^n\d+$/.test(id)) return null;
    const parentId = typeof raw.parentId === 'string' && raw.parentId !== '' ? raw.parentId : null;
    return {
        id,
        parentId,
        kind: normalizeKind(raw.kind),
        title: clampText(raw.title, MAX_TITLE) || `（未命名 ${normalizeKind(raw.kind)}）`,
        summary: clampText(raw.summary, MAX_SUMMARY, { keepNewlines: true }),
        status: normalizeStatus(raw.status),
        // 旧图没有这两个字段；只有存储里存在时才透传，避免加载即改写全区。
        ...(normalizeCloseReason(raw.closeReason) !== null ? { closeReason: normalizeCloseReason(raw.closeReason) } : {}),
        ...(normalizeResolutionBy(raw.resolutionBy) !== null ? { resolutionBy: normalizeResolutionBy(raw.resolutionBy) } : {}),
        confidence: normalizeConfidence(raw.confidence),
        tags: normalizeTags(raw.tags),
        origin: normalizeOrigin(raw.origin),
        sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
        turn: Number.isInteger(raw.turn) ? raw.turn : null,
        stepId: typeof raw.stepId === 'string' && raw.stepId !== '' ? raw.stepId : null,
        refs: normalizeRefs(raw.refs),
        fingerprint: typeof raw.fingerprint === 'string' && raw.fingerprint !== '' ? raw.fingerprint : null,
        hits: Number.isInteger(raw.hits) && raw.hits > 0 ? raw.hits : 1,
        digest: normalizeDigest(raw.digest),
        digestSource: normalizeDigestSource(raw.digestSource),
        digestHistory: normalizeDigestHistory(raw.digestHistory),
        digestBasis: normalizeDigestBasis(raw.digestBasis),
        owner: clampText(raw.owner, 120) || null,
        leaseUntil: normalizeIso(raw.leaseUntil),
        leaseEpoch: Number.isInteger(raw.leaseEpoch) && raw.leaseEpoch >= 0 ? raw.leaseEpoch : 0,
        priority: normalizePriority(raw.priority),
        nodeVersion: Number.isInteger(raw.nodeVersion) && raw.nodeVersion > 0 ? raw.nodeVersion : 1,
        createdBy: normalizeActor(raw.createdBy ?? raw.updatedBy),
        updatedBy: normalizeActor(raw.updatedBy ?? raw.createdBy),
        revision: Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1,
        order: Number.isInteger(raw.order) ? raw.order : 0,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
        ...(raw.auto !== undefined ? { auto: cloneJson(raw.auto) } : {}),
        ...(Array.isArray(raw.mergedFrom) ? { mergedFrom: raw.mergedFrom.filter((value) => typeof value === 'string') } : {}),
    };
}

/** JSON 深拷贝（对象/数组；其它原样返回）。 */
export function cloneJson(value) {
    if (value === null || typeof value !== 'object') return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
}
