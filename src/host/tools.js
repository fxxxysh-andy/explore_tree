/**
 * 提供给模型的两个固定工具。
 *
 * 前缀稳定契约（需求 6）：
 *  - 工具名/描述/参数 schema 在插件加载时确定，运行期不增删、不改写；
 *  - 工具返回值是唯一携带动态图状态的通道；
 *  - 工具描述里不写「当前有 N 个节点」之类会漂移的信息。
 *
 * @module host/tools
 */
import {
    nodeDetail,
    renderFrontier,
    renderOverview,
    renderPath,
    renderSearch,
    renderStats,
    renderTree,
} from '../core/compact.js';
import { computeFrontier } from '../core/frontier.js';
import { childrenOf, ensureRevision, graphStats, LeaseError, requireNode, StaleRevisionError } from '../core/graph.js';
import {
    digestBasisOf,
    isLeafRoot,
    isTopic,
    leafRootImportance,
    leafRootsOf,
    renderBrief,
    renderHandoff,
    renderTrunk,
    topicDigest,
    trunkFrontier,
    trunkStats,
} from '../core/trunk.js';

const READ_ACTIONS = ['overview', 'stats', 'frontier', 'find', 'node', 'path', 'tree', 'subtree', 'trunk', 'brief'];
const RECORD_ACTIONS = ['add', 'update', 'link', 'close', 'reopen', 'merge', 'move', 'promote', 'assign', 'handoff', 'digest', 'archive', 'rollback'];

const commonTextOutput = {
    type: 'object',
    properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        text: { type: 'string' },
    },
    additionalProperties: true,
};

function textResult(value) {
    return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }];
}

function sessionIdOf(exec) {
    const session = exec?.agent?.session;
    return typeof session?.id === 'string' ? session.id : null;
}

function explicitActorOf(args) {
    return typeof args?.actor === 'string' && args.actor.trim() !== '' ? args.actor.trim() : null;
}

/** 审计用 actor：显式 actor 优先，否则退回会话 id。 */
function actorOf(args, exec) {
    return explicitActorOf(args) ?? sessionIdOf(exec);
}

function isCurator(actor) {
    return actor === 'lead' || actor === 'curator';
}

/** 最近的已认领 topic（含自身）；用于写域判定。 */
function owningTopicOf(state, nodeId) {
    let cursor = state.nodes.get(nodeId);
    const guard = new Set();
    while (cursor !== undefined && !guard.has(cursor.id)) {
        guard.add(cursor.id);
        if (cursor.kind === 'topic' && typeof cursor.owner === 'string' && cursor.owner !== '') return cursor;
        cursor = cursor.parentId === null || cursor.parentId === undefined ? undefined : state.nodes.get(cursor.parentId);
    }
    return null;
}

/**
 * 显式 actor 的写域校验：只能写自己有效租约覆盖的子树；
 * 没有显式 actor 时保持旧的「谁都能记录」行为。
 */
function assertLeaseWrite(state, nodeId, actor, strict) {
    if (!strict || actor === null || isCurator(actor)) return;
    const topic = owningTopicOf(state, nodeId);
    if (topic === null) return;
    if (topic.owner !== actor) {
        throw new LeaseError('OUT_OF_SCOPE', `${topic.id} 由 ${topic.owner} 持有租约，${actor} 不在写域内；先认领或改用 proposal。`, {
            topicId: topic.id,
            owner: topic.owner,
            leaseUntil: topic.leaseUntil,
        });
    }
    if (typeof topic.leaseUntil === 'string' && Date.parse(topic.leaseUntil) <= Date.now()) {
        throw new LeaseError('LEASE_EXPIRED', `${topic.id} 的租约已于 ${topic.leaseUntil} 过期，${actor} 需先续租再写。`, {
            topicId: topic.id,
            owner: topic.owner,
            leaseUntil: topic.leaseUntil,
        });
    }
}

function expectedRevisionOf(args) {
    return Number.isInteger(args?.expectedRevision) ? args.expectedRevision : undefined;
}

/** 当前焦点：活跃节点 → 最新节点 → null。 */
function resolveFocusId(state, requested, sessionId) {
    if (typeof requested === 'string' && state.nodes.has(requested)) return requested;
    if (sessionId !== null) {
        const session = state.sessions.get(sessionId);
        if (session !== undefined && session.activeNodeId !== null && state.nodes.has(session.activeNodeId)) {
            return session.activeNodeId;
        }
    }
    const nodes = [...state.nodes.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return nodes.length > 0 ? nodes[nodes.length - 1].id : null;
}

/** 记录写操作后，把会话焦点移到新节点（只改图内会话状态，不动对话）。 */
async function focusSession(store, sessionId, nodeId) {
    if (sessionId === null || nodeId === null) return;
    try {
        await store.apply({ t: 'session', sessionId, activeNodeId: nodeId });
    } catch {
        // 焦点是锦上添花，失败不影响主写入。
    }
}

function pickList(value) {
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim() !== '');
    return undefined;
}

/**
 * 构建工具定义（纯对象，注册由 index.js 做，便于单测直接调用 execute）。
 *
 * @param {import('./service.js').ResearchTraceService} service
 */
export function buildToolDefinitions(service) {
    const readTool = {
        name: 'explore_tree',
        description: '读取当前工作区的研究轨迹树（只读，返回缩略视图而不是整棵树）。action: overview=目标/焦点/未决/死路/最近/建议; trunk=摘要主干（goal→topic→叶根，含 digest，交流/交接用）; brief=≤400 字研究简报（轮首/压缩后读）; frontier=下一步建议与应避免方向; stats=统计（含 per-actor 创建/更新分布）; find=按关键词找节点; node=节点详情; path=到根路径; tree=从根/指定节点的缩略子树（受 depth 限制）; subtree=以某节点为根的子树（需 id）。开始新方向前先 overview；接续长期研究先 trunk/brief，避免重复造轮子。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: READ_ACTIONS, description: '要执行的查询；省略=overview。' },
                query: { type: 'string', description: 'find 的关键词（标题/摘要/标签/引用里匹配）。' },
                id: { type: 'string', description: 'node/path 的节点 id，如 n12。' },
                focus: { type: 'string', description: '可选：指定焦点节点 id，影响 overview/frontier 的「最近/建议」。' },
                limit: { type: 'number', description: '可选：建议/结果条数上限（1-20）。' },
                depth: { type: 'number', description: '可选：tree/subtree 的层数（1-8，默认 3；读缩略树用 2）。' },
                archived: { type: 'boolean', description: '可选：trunk 时包含已归档叶根（默认隐藏）。' },
                scope: { type: 'string', enum: ['workspace', 'goal'], description: '可选：brief 的范围；workspace（默认）含其他 goal 的主干，goal 只看当前 goal。' },
            },
            additionalProperties: false,
        },
        output: { schema: commonTextOutput, render: (_args, value) => textResult(value) },
        async execute(rawArgs, exec) {
            const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {};
            try {
                const { store } = await service.resolveToolWorkspace(exec);
                const state = await store.current();
                const sessionId = sessionIdOf(exec);
                const action = typeof args.action === 'string' ? args.action : 'overview';
                const limit = Number.isInteger(args.limit) ? Math.min(20, Math.max(1, args.limit)) : undefined;
                const focusId = resolveFocusId(state, args.focus, sessionId);
                switch (action) {
                    case 'stats':
                        return { ok: true, action, text: renderStats(state) };
                    case 'frontier': {
                        const result = computeFrontier(state, { sessionId, focusId, limit: limit ?? 6 });
                        const trunk = trunkFrontier(state, { limit: 3 });
                        let text = renderFrontier(result);
                        if (trunk.length > 0) {
                            const trunkText = trunk.map((item) => `  [${item.type}] ${item.targetId} ${item.reason}`).join('\n');
                            text = `主干建议（${trunk.length}）：\n${trunkText}\n\n${text}`;
                        }
                        return { ok: true, action, text };
                    }
                    case 'find': {
                        const query = typeof args.query === 'string' ? args.query.trim() : '';
                        if (query === '') return { ok: false, action, text: 'find 需要 query。' };
                        const matched = searchNodes(state, query, limit ?? 10);
                        return { ok: true, action, text: renderSearch(state, matched, query) };
                    }
                    case 'node': {
                        if (typeof args.id !== 'string') return { ok: false, action, text: 'node 需要 id（如 n12）。' };
                        const node = requireNode(state, args.id);
                        return { ok: true, action, text: nodeDetail(state, node) };
                    }
                    case 'path': {
                        if (typeof args.id !== 'string') return { ok: false, action, text: 'path 需要 id（如 n12）。' };
                        return { ok: true, action, text: renderPath(state, args.id) };
                    }
                    case 'tree': {
                        const depth = Number.isInteger(args.depth) ? Math.min(8, Math.max(1, args.depth)) : 3;
                        const text = renderTree(state, {
                            rootId: typeof args.id === 'string' ? args.id : null,
                            focusId,
                            maxDepth: depth,
                            maxNodes: depth <= 2 ? 40 : 60,
                        });
                        return { ok: true, action, text: `缩略子树（depth=${depth}）\n${text}` };
                    }
                    case 'subtree': {
                        if (typeof args.id !== 'string') return { ok: false, action, text: 'subtree 需要 id（如 n12）。' };
                        const node = requireNode(state, args.id);
                        const depth = Number.isInteger(args.depth) ? Math.min(8, Math.max(1, args.depth)) : 4;
                        return {
                            ok: true,
                            action,
                            text: `${nodeDetail(state, node)}\n\n--- 子树（depth=${depth}）---\n${renderTree(state, { rootId: node.id, focusId, maxDepth: depth, maxNodes: 60 })}`,
                        };
                    }
                    case 'trunk': {
                        const goalId = typeof args.id === 'string' ? args.id : null;
                        return { ok: true, action, text: renderTrunk(state, { goalId, includeArchived: args.archived === true }) };
                    }
                    case 'brief': {
                        return {
                            ok: true,
                            action,
                            text: renderBrief(state, { sessionId, focusId, limit: limit ?? 3, scope: args.scope === 'goal' ? 'goal' : 'workspace' }),
                        };
                    }
                    case 'overview':
                    default:
                        return {
                            ok: true,
                            action: 'overview',
                            text: renderOverview(state, { sessionId, focusId, limit: limit ?? 12 }),
                        };
                }
            } catch (error) {
                return { ok: false, action: 'error', text: `读取研究图失败：${errorText(error)}` };
            }
        },
    };

    const recordTool = {
        name: 'explore_tree_record',
        description: '写入当前工作区的研究轨迹树。action: add=新建节点(goal/topic/question/hypothesis/step/action/evidence/decision/dead_end/conclusion/artifact/note); update=改字段; link=加旁支关系(supports/contradicts/refines/depends/replaces/duplicates/continues/related); close=标记完成; reopen=重新打开(用于有新证据的死路/放弃项); merge=合并重复节点; move=改父节点; promote=把叶根提升为摘要主干 topic; assign=认领（owner/leaseUntil，多 agent）; handoff=把 topic 租约与交接包转给接手者; digest=人工修订 topic 摘要; archive=归档(done 叶根下沉,主干默认隐藏,unarchive 恢复); rollback=回滚 topic 摘要到历史版本。失败方向记 dead_end 并写原因，frontier 会据此避坑。主干结构：goal→topic→叶根→叶，时间轴用 stepId 记录，不再用 step 当语义父节点。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: RECORD_ACTIONS, description: '写操作类型。' },
                id: { type: 'string', description: 'update/close/reopen/merge(keepId)/move 的目标节点 id。' },
                actor: { type: 'string', description: '写入者 id（如 agent 名）。显式传入时启用租约写域校验，并记入节点的 createdBy/updatedBy；省略则退回会话 id。' },
                expectedRevision: { type: 'integer', minimum: 1, description: 'CAS：期望目标节点（add 为父节点）当前的 nodeVersion；不匹配返回 STALE_REVISION，调用方应重读后再写。' },
                renew: { type: 'boolean', description: 'assign：续租而不是释放/换人。' },
                steal: { type: 'boolean', description: 'assign：强制抢占（仅 curator 使用；保留旧 owner 的审计字段）。' },
                parentId: { type: 'string', description: 'add/move 的父节点 id；add 省略时挂到当前焦点，传空字符串表示新建根。' },
                kind: { type: 'string', description: 'add 的节点类型；update 时可改。' },
                title: { type: 'string', description: '节点标题（一句话）。' },
                summary: { type: 'string', description: '摘要：理由、证据、引用；失败节点必须写失败原因。' },
                status: { type: 'string', description: 'open/active/done/abandoned。' },
                confidence: { type: 'number', description: '0-1 置信度；高置信度但无证据会被 frontier 标成过度自信。' },
                tags: { type: 'array', items: { type: 'string' }, description: '标签。' },
                refs: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '引用 [{kind:url|file|tool_call|artifact|session|message, value, label}]。' },
                from: { type: 'string', description: 'link 的起点节点 id。' },
                to: { type: 'string', description: 'link 的终点节点 id。' },
                edgeKind: { type: 'string', description: 'link 关系类型，默认 related。' },
                note: { type: 'string', description: 'link 的说明。' },
                dropId: { type: 'string', description: 'merge 时被合并掉的节点 id。' },
                reason: { type: 'string', description: 'close/reopen/merge 的原因（写入摘要）。' },
                digest: { type: 'string', description: 'topic 的摘要（digest 动作人工修订；add/update 也可直接带）。≤120 字，父摘要只由子节点摘要合成。' },
                owner: { type: 'string', description: 'assign/update：认领者 id；空字符串表示释放。assign 只传 id（省略 owner）也按旧语义释放；认领自己请显式写 owner 或 renew:true。' },
                toActor: { type: 'string', description: 'handoff：接手者 id（必填）。交接会把 topic 的 owner/leaseUntil/leaseEpoch 一起转给该 actor。' },
                leaseUntil: { type: 'string', description: 'assign/update/handoff：租约到期时间（ISO）；assign 省略默认 30 分钟，handoff 省略默认 30 分钟。' },
                priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'update：优先级（多 agent 排序）。' },
                version: { type: 'integer', description: 'rollback：回滚到第几版（0=最新历史版本，1=上一版…）。' },
                unarchive: { type: 'boolean', description: 'archive 时传 true 表示取消归档。' },
                stepId: { type: 'string', description: 'add/update：产生该节点的时间线 step id（保留时间轴，不再当父节点）。' },
                children: {
                    type: 'array',
                    description: 'add 时可一次创建一层子节点（最多 20 个），省去「先建父、再逐个挂子」的往返；不支持子节点再带 children。',
                    items: {
                        type: 'object',
                        properties: {
                            kind: { type: 'string' },
                            title: { type: 'string' },
                            summary: { type: 'string' },
                            status: { type: 'string' },
                            confidence: { type: 'number' },
                            tags: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['kind', 'title'],
                        additionalProperties: false,
                    },
                },
            },
            additionalProperties: false,
        },
        output: { schema: commonTextOutput, render: (_args, value) => textResult(value) },
        isConcurrencySafe: () => false,
        async execute(rawArgs, exec) {
            const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {};
            try {
                const { store } = await service.resolveToolWorkspace(exec);
                const state = await store.current();
                const sessionId = sessionIdOf(exec);
                const action = typeof args.action === 'string' ? args.action : '';
                switch (action) {
                    case 'add': {
                        if (typeof args.kind !== 'string' || typeof args.title !== 'string') {
                            return { ok: false, action, text: 'add 需要 kind 与 title。' };
                        }
                        let parentId = args.parentId === undefined
                            ? resolveFocusId(state, undefined, sessionId)
                            : (args.parentId === '' ? null : args.parentId);
                        if (args.kind === 'topic') {
                            const parent = parentId === null ? undefined : state.nodes.get(parentId);
                            if (parentId !== null && parent === undefined) {
                                return { ok: false, action, text: `add topic：父节点 ${parentId} 不存在。` };
                            }
                            if (parentId === null || (parent.kind !== 'goal' && parent.kind !== 'topic')) {
                                const goalId = sessionGoalId(state, sessionId)
                                    ?? [...state.nodes.values()].filter((node) => node.kind === 'goal').pop()?.id
                                    ?? null;
                                if (goalId === null) {
                                    return { ok: false, action, text: 'add topic 需要一个 goal 作父节点：先 record add kind=goal。' };
                                }
                                parentId = goalId;
                            }
                        }
                        const actor = actorOf(args, exec);
                        const expectedRevision = expectedRevisionOf(args);
                        if (parentId !== null) {
                            assertLeaseWrite(state, parentId, actor, explicitActorOf(args) !== null);
                        }
                        const op = await store.apply({
                            t: 'addNode',
                            ...(expectedRevision !== undefined && parentId !== null ? { expectedRevision } : {}),
                            actor: actor ?? undefined,
                            node: {
                                parentId,
                                kind: args.kind,
                                title: args.title,
                                summary: typeof args.summary === 'string' ? args.summary : '',
                                status: typeof args.status === 'string' ? args.status : undefined,
                                confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
                                tags: pickList(args.tags),
                                refs: Array.isArray(args.refs) ? args.refs : undefined,
                                origin: 'model',
                                sessionId: sessionId ?? undefined,
                                stepId: typeof args.stepId === 'string' ? args.stepId : undefined,
                                digest: typeof args.digest === 'string' ? args.digest : undefined,
                                digestSource: typeof args.digest === 'string' ? 'human' : undefined,
                                owner: typeof args.owner === 'string' ? args.owner : undefined,
                                leaseUntil: typeof args.leaseUntil === 'string' ? args.leaseUntil : undefined,
                                priority: typeof args.priority === 'string' ? args.priority : undefined,
                            },
                        });
                        const created = op.node;
                        const childInputs = Array.isArray(args.children) ? args.children.slice(0, 20) : [];
                        const createdChildren = [];
                        for (const child of childInputs) {
                            if (child === null || typeof child !== 'object') continue;
                            if (typeof child.kind !== 'string' || typeof child.title !== 'string') continue;
                            const childOp = await store.apply({
                                t: 'addNode',
                                actor: actor ?? undefined,
                                node: {
                                    parentId: created.id,
                                    kind: child.kind,
                                    title: child.title,
                                    summary: typeof child.summary === 'string' ? child.summary : '',
                                    status: typeof child.status === 'string' ? child.status : undefined,
                                    confidence: typeof child.confidence === 'number' ? child.confidence : undefined,
                                    tags: pickList(child.tags),
                                    origin: 'model',
                                    sessionId: sessionId ?? undefined,
                                    stepId: typeof args.stepId === 'string' ? args.stepId : undefined,
                                },
                            });
                            createdChildren.push(childOp.node);
                        }
                        await refreshTrunkUp(store, created.id);
                        await focusSession(store, sessionId, created.id);
                        const tail = createdChildren.length > 0
                            ? `；子节点 ${createdChildren.length} 个：${createdChildren.map((node) => `${node.id}(${node.kind})`).join('、')}`
                            : '';
                        return {
                            ok: true,
                            action,
                            id: created.id,
                            children: createdChildren.map((node) => ({ id: node.id, kind: node.kind, title: node.title })),
                            text: `已记录 ${created.id} (${created.kind})「${created.title}」${parentId !== null ? `，父节点 ${parentId}` : '，根节点'}${tail}。`,
                        };
                    }
                    case 'update': {
                        const id = requireString(args.id, 'update');
                        const patch = {};
                        for (const key of ['kind', 'title', 'summary', 'status', 'confidence', 'tags', 'refs', 'owner', 'leaseUntil', 'priority', 'stepId']) {
                            if (args[key] !== undefined) patch[key] = args[key];
                        }
                        if (args.digest !== undefined) {
                            patch.digest = args.digest;
                            patch.digestSource = 'human';
                        }
                        if (args.reason !== undefined) {
                            const node = requireNode(state, id);
                            patch.summary = `${node.summary}${node.summary === '' ? '' : '\n'}${args.reason}`;
                        }
                        const actor = actorOf(args, exec);
                        const expectedRevision = expectedRevisionOf(args);
                        assertLeaseWrite(state, id, actor, explicitActorOf(args) !== null);
                        await store.apply({
                            t: 'updateNode',
                            id,
                            patch,
                            actor: actor ?? undefined,
                            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                        });
                        await refreshTrunkUp(store, id);
                        const node = requireNode(await store.current(), id);
                        return { ok: true, action, id, text: `已更新 ${id}：${node.kind}/${node.status}「${node.title}」。` };
                    }
                    case 'move': {
                        const id = requireString(args.id, 'move');
                        if (args.parentId === undefined) return { ok: false, action, text: 'move 需要 parentId（空字符串表示根）。' };
                        const before = requireNode(state, id);
                        const oldParentId = before.parentId ?? null;
                        const newParentId = args.parentId === '' ? null : args.parentId;
                        const actor = actorOf(args, exec);
                        const expectedRevision = expectedRevisionOf(args);
                        const strict = explicitActorOf(args) !== null;
                        assertLeaseWrite(state, id, actor, strict);
                        if (newParentId !== null) assertLeaseWrite(state, newParentId, actor, strict);
                        await store.apply({
                            t: 'moveNode',
                            id,
                            parentId: newParentId,
                            actor: actor ?? undefined,
                            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                        });
                        if (oldParentId !== null) await refreshTrunkUp(store, oldParentId);
                        await refreshTrunkUp(store, id);
                        return { ok: true, action, id, text: `已移动 ${id} → ${args.parentId === '' ? '根' : args.parentId}。` };
                    }
                    case 'link': {
                        const from = requireString(args.from, 'link');
                        const to = requireString(args.to, 'link');
                        await store.apply({
                            t: 'link',
                            from,
                            to,
                            kind: typeof args.edgeKind === 'string' ? args.edgeKind : 'related',
                            note: typeof args.note === 'string' ? args.note : '',
                        });
                        return { ok: true, action, text: `已建关系 ${from} —${typeof args.edgeKind === 'string' ? args.edgeKind : 'related'}→ ${to}。` };
                    }
                    case 'close': {
                        const id = requireString(args.id, 'close');
                        const patch = { status: 'done' };
                        const node = requireNode(state, id);
                        const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
                        patch.summary = reason === '' ? node.summary : `${node.summary}${node.summary === '' ? '' : '\n'}关闭说明：${reason}`;
                        const actor = actorOf(args, exec);
                        const expectedRevision = expectedRevisionOf(args);
                        assertLeaseWrite(state, id, actor, explicitActorOf(args) !== null);
                        await store.apply({
                            t: 'updateNode',
                            id,
                            patch,
                            actor: actor ?? undefined,
                            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                        });
                        await refreshTrunkUp(store, id);
                        return { ok: true, action, id, text: `已关闭 ${id}（done）${reason === '' ? '' : `：${reason}`}` };
                    }
                    case 'reopen': {
                        const id = requireString(args.id, 'reopen');
                        const node = requireNode(state, id);
                        const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
                        if (node.kind === 'dead_end' && reason === '') {
                            return { ok: false, action, text: `reopen 死路 ${id} 需要 reason：写清这次有什么新证据，否则 frontier 会继续把它当死路。` };
                        }
                        const patch = { status: 'active' };
                        if (reason !== '') patch.summary = `${node.summary}${node.summary === '' ? '' : '\n'}重开原因：${reason}`;
                        const actor = actorOf(args, exec);
                        const expectedRevision = expectedRevisionOf(args);
                        assertLeaseWrite(state, id, actor, explicitActorOf(args) !== null);
                        await store.apply({
                            t: 'updateNode',
                            id,
                            patch,
                            actor: actor ?? undefined,
                            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                        });
                        await refreshTrunkUp(store, id);
                        return { ok: true, action, id, text: `已重新打开 ${id}${reason === '' ? '' : `：${reason}`}` };
                    }
                    case 'merge': {
                        const keepId = requireString(args.id, 'merge');
                        const dropId = requireString(args.dropId, 'merge(dropId)');
                        const actor = actorOf(args, exec);
                        const strict = explicitActorOf(args) !== null;
                        assertLeaseWrite(state, keepId, actor, strict);
                        assertLeaseWrite(state, dropId, actor, strict);
                        const expectedRevision = expectedRevisionOf(args);
                        await store.apply({
                            t: 'merge',
                            keepId,
                            dropId,
                            actor: actor ?? undefined,
                            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                        });
                        await refreshTrunkUp(store, keepId);
                        return { ok: true, action, id: keepId, text: `已把 ${dropId} 合并进 ${keepId}。` };
                    }
                    case 'promote': {
                        const id = requireString(args.id, 'promote');
                        const node = requireNode(state, id);
                        const actor = actorOf(args, exec);
                        const expectedRevision = expectedRevisionOf(args);
                        if (node.kind === 'topic') {
                            ensureRevision(state, id, expectedRevision);
                            return { ok: true, action, id, text: `${id} 已经是 topic。` };
                        }
                        if (node.kind === 'goal' || node.kind === 'step' || node.kind === 'action') {
                            return { ok: false, action, text: `promote 只接受想法类节点（question/hypothesis/decision/conclusion/dead_end），${id} 是 ${node.kind}。` };
                        }
                        let parentId = args.parentId === undefined
                            ? (node.parentId ?? null)
                            : (args.parentId === '' ? null : args.parentId);
                        const parent = parentId === null ? undefined : state.nodes.get(parentId);
                        if (parentId !== null && parent === undefined) {
                            return { ok: false, action, text: `promote：父节点 ${parentId} 不存在。` };
                        }
                        if (parentId === null || (parent.kind !== 'goal' && parent.kind !== 'topic')) {
                            const goalId = sessionGoalId(state, sessionId)
                                ?? [...state.nodes.values()].filter((item) => item.kind === 'goal').pop()?.id
                                ?? null;
                            if (goalId === null) {
                                return { ok: false, action, text: 'promote 需要一个 goal/topic 作父节点：先建 goal，或用 parentId 指定。' };
                            }
                            parentId = goalId;
                        }
                        const tags = Array.isArray(node.tags) ? [...node.tags] : [];
                        if (!tags.includes('promoted')) tags.push('promoted');
                        assertLeaseWrite(state, id, actor, explicitActorOf(args) !== null);
                        if (parentId !== null) assertLeaseWrite(state, parentId, actor, explicitActorOf(args) !== null);
                        await store.apply({
                            t: 'updateNode',
                            id,
                            patch: { kind: 'topic', tags, status: node.status === 'done' ? 'done' : 'open' },
                            actor: actor ?? undefined,
                            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                        });
                        if ((node.parentId ?? null) !== parentId) {
                            await store.apply({ t: 'moveNode', id, parentId, actor: actor ?? undefined });
                        }
                        await refreshTrunkUp(store, id);
                        return {
                            ok: true,
                            action,
                            id,
                            text: `已把 ${id} 提升为 topic「${node.title}」，父节点 ${parentId}；可继续用 digest 动作修订摘要。`,
                        };
                    }
                    case 'handoff': {
                        const id = requireString(args.id, 'handoff');
                        const topic = requireNode(state, id);
                        if (topic.kind !== 'topic') {
                            return { ok: false, action, code: 'NOT_TOPIC', text: `handoff 只用于 topic；${id} 是 ${topic.kind}。` };
                        }
                        const toActor = typeof args.toActor === 'string' ? args.toActor.trim() : '';
                        if (toActor === '') {
                            return { ok: false, action, code: 'NO_TARGET', text: 'handoff 需要 toActor（接手者 id）。' };
                        }
                        const actor = actorOf(args, exec);
                        if (actor === null) {
                            return { ok: false, action, code: 'NO_ACTOR', text: 'handoff 需要 actor（或会话 id）来执行交接。' };
                        }
                        if (toActor === actor) {
                            return { ok: false, action, code: 'SAME_ACTOR', text: `handoff 的接手者不能是自己（${actor}）。` };
                        }
                        assertLeaseWrite(state, id, actor, true);
                        const leaseUntil = typeof args.leaseUntil === 'string' && args.leaseUntil !== ''
                            ? args.leaseUntil
                            : new Date(Date.now() + 30 * 60 * 1000).toISOString();
                        const summary = renderHandoff(state, id, { from: topic.owner ?? actor, to: toActor });
                        const expectedRevision = expectedRevisionOf(args);
                        const result = await store.apply({
                            t: 'handoff',
                            id,
                            to: toActor,
                            actor,
                            leaseUntil,
                            summary,
                            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                        });
                        await refreshTrunkUp(store, id);
                        const after = requireNode(await store.current(), id);
                        const handoffId = result?.node?.id ?? null;
                        return {
                            ok: true,
                            action,
                            id,
                            handoffId,
                            owner: after.owner,
                            leaseUntil: after.leaseUntil,
                            leaseEpoch: after.leaseEpoch,
                            text: `已把 ${id} 交接给 ${after.owner}（租约至 ${after.leaseUntil}，leaseEpoch ${after.leaseEpoch}${handoffId === null ? '' : `，交接包 ${handoffId}`}）。`,
                        };
                    }
                    case 'assign': {
                        const id = requireString(args.id, 'assign');
                        const node = requireNode(state, id);
                        if (node.kind !== 'topic') {
                            return { ok: false, action, code: 'NOT_TOPIC', text: `assign 只用于 topic；${id} 是 ${node.kind}。` };
                        }
                        const actor = actorOf(args, exec);
                        const explicit = explicitActorOf(args);
                        const renew = args.renew === true;
                        const steal = args.steal === true;
                        if (steal && !isCurator(actor)) {
                            return { ok: false, action, code: 'STEAL_REQUIRES_CURATOR', text: `steal 只允许 lead/curator 使用；${actor ?? '当前调用方'} 请等租约过期或联系 curator。` };
                        }
                        const hasOwner = args.owner !== undefined;
                        const rawOwner = hasOwner
                            ? (args.owner === null || String(args.owner).trim() === '' ? null : String(args.owner).trim())
                            : undefined;
                        let owner;
                        if (renew) {
                            owner = rawOwner !== undefined ? rawOwner : (node.owner ?? actor);
                            if (owner === null) {
                                return { ok: false, action, code: 'NO_ACTOR', text: 'renew 需要 owner 或显式 actor。' };
                            }
                        } else if (rawOwner !== undefined) {
                            owner = rawOwner;
                        } else {
                            owner = null; // 兼容旧语义：只传 id = 释放。
                        }
                        if (owner !== null && explicit !== null && owner !== explicit && !isCurator(actor)) {
                            return { ok: false, action, code: 'ASSIGN_OTHER_DENIED', text: `${explicit} 不能替 ${owner} 认领；只有 lead/curator 可以代为分配。` };
                        }
                        const leaseUntil = owner === null
                            ? null
                            : (typeof args.leaseUntil === 'string' && args.leaseUntil !== ''
                                ? args.leaseUntil
                                : new Date(Date.now() + 30 * 60 * 1000).toISOString());
                        const expectedRevision = expectedRevisionOf(args);
                        await store.apply({
                            t: 'assignLease',
                            id,
                            owner,
                            leaseUntil,
                            actor: actor ?? undefined,
                            renew,
                            steal,
                            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                        });
                        const after = requireNode(await store.current(), id);
                        const text = after.owner === null
                            ? `已释放 ${id}（leaseEpoch ${after.leaseEpoch}）。`
                            : `${renew ? '已续租' : '已认领'} ${id} → ${after.owner}（租约至 ${after.leaseUntil}，leaseEpoch ${after.leaseEpoch}）。`;
                        return {
                            ok: true,
                            action,
                            id,
                            owner: after.owner,
                            leaseUntil: after.leaseUntil,
                            leaseEpoch: after.leaseEpoch,
                            text,
                        };
                    }
                    case 'digest': {
                        const id = requireString(args.id, 'digest');
                        const node = requireNode(state, id);
                        if (node.kind !== 'topic') {
                            return { ok: false, action, text: `digest 只用于 topic；${id} 是 ${node.kind}，请改 title/summary。` };
                        }
                        const text = typeof args.digest === 'string' ? args.digest.trim() : '';
                        if (text === '') return { ok: false, action, text: 'digest 需要非空文本（≤120 字）。' };
                        const basis = digestBasisOf(state, node, text);
                        const actor = actorOf(args, exec);
                        const expectedRevision = expectedRevisionOf(args);
                        assertLeaseWrite(state, id, actor, explicitActorOf(args) !== null);
                        await store.apply({
                            t: 'updateNode',
                            id,
                            patch: { digest: text, digestSource: 'human', digestBasis: basis },
                            actor: actor ?? undefined,
                            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                        });
                        await refreshTrunkUp(store, id);
                        const after = requireNode(await store.current(), id);
                        return { ok: true, action, id, text: `已更新 ${id} 的摘要（人工）：${after.digest}` };
                    }
                    case 'archive': {
                        const id = requireString(args.id, 'archive');
                        const node = requireNode(state, id);
                        const unarchive = args.unarchive === true;
                        const tags = (Array.isArray(node.tags) ? node.tags : []).filter((tag) => tag !== 'archived');
                        if (!unarchive) tags.push('archived');
                        const status = unarchive
                            ? (node.status === 'done' ? 'open' : node.status)
                            : 'done';
                        const actor = actorOf(args, exec);
                        const expectedRevision = expectedRevisionOf(args);
                        assertLeaseWrite(state, id, actor, explicitActorOf(args) !== null);
                        await store.apply({
                            t: 'updateNode',
                            id,
                            patch: { tags, status },
                            actor: actor ?? undefined,
                            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                        });
                        if (!isTopic(node)) await refreshTrunkUp(store, id);
                        return {
                            ok: true,
                            action,
                            id,
                            text: unarchive
                                ? `已取消归档 ${id}（status=${status}）。`
                                : `已归档 ${id}：主干默认隐藏，trunk 传 archived:true 可查看。`,
                        };
                    }
                    case 'rollback': {
                        const id = requireString(args.id, 'rollback');
                        const node = requireNode(state, id);
                        const history = Array.isArray(node.digestHistory) ? node.digestHistory : [];
                        if (history.length === 0) {
                            return { ok: false, action, text: `rollback：${id} 还没有摘要历史。` };
                        }
                        const version = Number.isInteger(args.version) ? args.version : 0;
                        const index = history.length - 1 - version;
                        if (index < 0 || index >= history.length) {
                            return { ok: false, action, text: `rollback：version 需在 0..${history.length - 1}。` };
                        }
                        const target = history[index];
                        const actor = actorOf(args, exec);
                        const expectedRevision = expectedRevisionOf(args);
                        assertLeaseWrite(state, id, actor, explicitActorOf(args) !== null);
                        await store.apply({
                            t: 'updateNode',
                            id,
                            patch: { digest: target.digest, digestSource: 'human' },
                            actor: actor ?? undefined,
                            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                        });
                        if (isTopic(node)) await refreshTrunkUp(store, id);
                        const after = requireNode(await store.current(), id);
                        return {
                            ok: true,
                            action,
                            id,
                            text: `已回滚 ${id} 摘要到第 ${version} 版（revision ${target.revision}，${target.source}）：${after.digest}`,
                        };
                    }
                    default:
                        return { ok: false, action: 'error', text: '未知 action。可用：add/update/link/close/reopen/merge/move/promote/assign/handoff/digest/archive/rollback。' };
                }
            } catch (error) {
                const actionName = typeof args.action === 'string' ? args.action : 'error';
                if (error instanceof StaleRevisionError) {
                    return {
                        ok: false,
                        action: actionName,
                        code: error.code,
                        id: error.id,
                        expectedVersion: error.expectedVersion,
                        currentVersion: error.currentVersion,
                        currentDigest: error.currentDigest,
                        updatedBy: error.updatedBy,
                        updatedAt: error.updatedAt,
                        text: `写入冲突（STALE_REVISION）：${error.id} 期望 nodeVersion=${error.expectedVersion}，当前 ${error.currentVersion}（updatedBy=${error.updatedBy ?? '未知'}）。请先 node 重读，合并改动后带新的 expectedRevision 重试。`,
                    };
                }
                if (error instanceof LeaseError) {
                    return {
                        ok: false,
                        action: actionName,
                        code: error.code,
                        id: error.id ?? error.topicId ?? null,
                        topicId: error.topicId ?? null,
                        owner: error.owner ?? null,
                        leaseUntil: error.leaseUntil ?? null,
                        text: `租约/写域拒绝（${error.code}）：${error.message}`,
                    };
                }
                return { ok: false, action: 'error', text: `写入研究图失败：${errorText(error)}` };
            }
        },
    };

    return [readTool, recordTool];
}

function requireString(value, where) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${where} 需要节点 id。`);
    return value.trim();
}

function errorText(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

/** find 的检索：标题/摘要/标签/引用值，简单包含匹配（大小写不敏感）；标题命中的排前面。 */
function searchNodes(state, query, limit) {
    const needle = query.toLowerCase();
    const hits = [];
    for (const node of state.nodes.values()) {
        const title = typeof node.title === 'string' ? node.title.toLowerCase() : '';
        const summary = typeof node.summary === 'string' ? node.summary.toLowerCase() : '';
        const digest = typeof node.digest === 'string' ? node.digest.toLowerCase() : '';
        const tags = Array.isArray(node.tags) ? node.tags.map((tag) => String(tag).toLowerCase()) : [];
        const refs = Array.isArray(node.refs) ? node.refs.map((ref) => String(ref.value ?? '').toLowerCase()) : [];
        let score = 0;
        if (title.includes(needle) || digest.includes(needle)) score = 2;
        else if (summary.includes(needle) || tags.some((tag) => tag.includes(needle)) || refs.some((value) => value.includes(needle))) score = 1;
        if (score === 0) continue;
        hits.push({ node, score });
    }
    hits.sort((a, b) => (b.score - a.score) || (a.node.updatedAt < b.node.updatedAt ? 1 : -1));
    return hits.slice(0, limit).map((hit) => hit.node);
}

export { graphStats };

/** 当前会话的 goal id（没有则 null）。 */
function sessionGoalId(state, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    const session = state.sessions.get(sessionId);
    return session?.goalId ?? null;
}

/**
 * 从某个节点向上重算 topic 摘要（含自身为 topic）。写回走 store.apply，
 * 因此 revision/updatedAt 只增加一次。
 */
async function refreshTrunkUp(store, nodeId, opts = {}) {
    const seen = new Set();
    let state = await store.current();
    let current = state.nodes.get(nodeId);
    if (isTopic(current)) await refreshOneTopic(store, current.id, opts);
    while (current !== undefined
        && current.parentId !== null
        && current.parentId !== undefined
        && !seen.has(current.parentId)) {
        seen.add(current.parentId);
        state = await store.current();
        current = state.nodes.get(current.parentId);
        if (isTopic(current)) await refreshOneTopic(store, current.id, opts);
    }
}

async function refreshOneTopic(store, topicId, opts = {}) {
    const state = await store.current();
    const topic = state.nodes.get(topicId);
    if (!isTopic(topic)) return;
    if (topic.digestSource === 'human' && opts.force !== true) return;
    const digest = topicDigest(state, topic);
    const basis = digestBasisOf(state, topic, digest);
    const same = topic.digest === digest
        && topic.digestBasis !== null
        && typeof topic.digestBasis === 'object'
        && topic.digestBasis.hash === basis.hash;
    if (same) return;
    await store.apply({
        t: 'updateNode',
        id: topicId,
        patch: { digest, digestSource: 'template', digestBasis: basis },
    });
}

