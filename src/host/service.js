/**
 * 研究轨迹的宿主侧服务：把「会话事件 / 工具调用 / 浏览器请求」接到研究图上。
 *
 * 生命周期与线程安全：
 *  - 一个插件实例一个 service；service 内一个 GraphRegistry（按 canonical 工作区根共享）；
 *  - 每个 store 配一个 ResearchExtractor（它自带串行队列），保证同一工作区的事件按序落图；
 *  - `session/event` 是 fire-and-forget 的旁路观察，不阻塞主对话（需求 5）；
 *  - 不注册任何会改变系统提示/工具面的动态内容（需求 6）。
 *
 * @module host/service
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphRegistry } from '../core/store.js';
import { canonicalWorkspaceRoot, workspaceName } from '../core/paths.js';
import { graphStats } from '../core/graph.js';
import { computeFrontier } from '../core/frontier.js';
import { collectOpenItems } from '../core/hygiene.js';
import { ResearchExtractor, classifySectionKind, splitAnswerSections } from '../core/extract.js';
import { fingerprint, normalizeKey } from '../core/fingerprint.js';
import { renderBrief, renderBriefDelta, snapshotBriefState } from '../core/trunk.js';
import { extractConfigOf } from './config.js';
import { extractClaimsWithLlm, summarizeTopicWithLlm } from './llm.js';
import { finishSession, translateSessionEvent } from './translate.js';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

/** 极简 JSON 响应。 */
function sendJson(res, status, value) {
    const body = `${JSON.stringify(value)}\n`;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
}

function isLoopback(req) {
    if (process.env.DSH_EXPLORE_TREE_ALLOW_REMOTE === '1') return true;
    const address = req?.socket?.remoteAddress ?? '';
    return LOOPBACK_ADDRESSES.has(address);
}

function clipSummary(text, max = 2000) {
    if (typeof text !== 'string') return '';
    return text.length <= max ? text : `${text.slice(0, max)}\n…[截断]`;
}

/** 面向 UI 的节点序列化（字段稳定，避免把内部索引带出去）。 */
function serializeNode(node) {
    return {
        id: node.id,
        parentId: node.parentId ?? null,
        kind: node.kind,
        title: node.title,
        summary: clipSummary(node.summary),
        status: node.status,
        confidence: node.confidence ?? null,
        tags: Array.isArray(node.tags) ? node.tags : [],
        origin: node.origin ?? 'auto',
        sessionId: node.sessionId ?? null,
        turn: node.turn ?? null,
        stepId: node.stepId ?? null,
        hits: node.hits ?? 1,
        order: node.order ?? 0,
        refs: Array.isArray(node.refs) ? node.refs : [],
        digest: node.digest ?? null,
        digestSource: node.digestSource ?? null,
        digestBasis: node.digestBasis ?? null,
        digestHistory: Array.isArray(node.digestHistory) ? node.digestHistory : [],
        owner: node.owner ?? null,
        leaseUntil: node.leaseUntil ?? null,
        leaseEpoch: node.leaseEpoch ?? 0,
        nodeVersion: node.nodeVersion ?? 1,
        createdBy: node.createdBy ?? null,
        updatedBy: node.updatedBy ?? null,
        priority: node.priority ?? null,
        revision: node.revision ?? 1,
        auto: node.auto !== false,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
    };
}

export class ResearchTraceService {
    /**
     * @param {object} ctx cordis context
     * @param {ReturnType<import('./config.js').normalizeConfig>} config
     * @param {object} [logger]
     */
    constructor(ctx, config, logger = console) {
        this.ctx = ctx;
        this.config = config;
        this.logger = logger;
        this.registry = new GraphRegistry({
            dirName: config.dirName,
            logger,
            maxNodes: config.maxNodes,
        });
        /** @type {Map<string, ResearchExtractor>} root(lowercase) → extractor */
        this.extractors = new Map();
        /** @type {Map<string, {turn: number, lastUserText: string, toolCalls: Map<string, {name?: string, args?: any}>}>} sessionId → 翻译游标 */
        this.cursors = new Map();
        /** @type {Map<string, string>} sessionId → workspace root */
        this.sessionRoots = new Map();
        /** 已做过「历史动作节点压缩」的工作区（每进程一次）。 */
        this.compactedRoots = new Set();
        this.repairedRoots = new Set();
        this.expandedRoots = new Set();
        this.mergedStepRoots = new Set();
        /** sessionId → 是否已尝试过历史回放（无论成功与否，避免反复扫描）。 */
        this.backfilledSessions = new Set();
        /** @type {Array<{root: string, name: string, lastSeen: string, nodes: number}>|null} 全局工作区索引缓存 */
        this.workspaceIndex = null;
        this.closed = false;
        /** 宿主 llm 服务（注入后才有；默认关闭 LLM 时不使用）。 */
        this.llmRuntime = null;
        /** 可选 Agent Teams 服务；缺失时 team 只显示树侧租约。 */
        this.agentTeams = null;
        /** sessionId → 已注入 brief 的轮次（同一轮不重复注入）。 */
        this.briefInjections = new Map();
        /** sessionId → 上次注入简报时的节点签名（下一次只推增量）。 */
        this.briefSnapshots = new Map();
        /** compaction/end 后强制补一次完整简报。 */
        this.briefForced = new Set();
    }

    /**
     * 注入 Agent Teams 服务（可选）。Team 插件不存在时保持 null，team 动作仍可用树侧租约。
     * @param {object|null} service ctx.agentTeams
     */
    attachAgentTeams(service) {
        this.agentTeams = service ?? null;
    }

    /**
     * 读取当前调用者所在 Team 的真实成员与任务。调用者必须是 exact live Agent；
     * 服务缺失或调用失败时返回 available=false，由渲染层降级，不影响树侧协作信息。
     * @param {object} exec 工具执行上下文
     */
    async teamContext(exec) {
        const agent = exec?.agent;
        if (this.agentTeams === null || agent === undefined || agent === null) {
            return {
                available: false,
                error: this.agentTeams === null ? 'Agent Teams 服务未接入（未安装/未启用）' : '缺少调用者 Agent',
            };
        }
        try {
            const [members, tasks] = await Promise.all([
                this.agentTeams.listMembers(agent),
                this.agentTeams.listTasks(agent),
            ]);
            return {
                available: true,
                members: Array.isArray(members) ? members : [],
                tasks: Array.isArray(tasks) ? tasks : [],
            };
        } catch (error) {
            return { available: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    /**
     * 注入宿主 LLM 服务；对已创建的提取器立即生效，之后创建的走 extractorFor。
     * @param {object|null} runtime ctx.llm（LlmRuntime）
     */
    attachLlm(runtime) {
        this.llmRuntime = runtime ?? null;
        for (const extractor of this.extractors.values()) {
            extractor.setLlmExtract((payload) => this.runLlmExtract(payload));
            extractor.setDigestWriter((payload) => this.runLlmDigest(payload));
        }
    }

    /** 供提取器轮末调用：提示词 → 模型 → 结构化 claim。 */
    async runLlmExtract(payload) {
        if (this.llmRuntime === null) throw new Error('LLM 服务未就绪');
        if (this.config.llm?.enabled !== true) return [];
        return extractClaimsWithLlm({
            llm: this.llmRuntime,
            config: this.config.llm,
            intent: payload.intent,
            reasoning: payload.reasoning,
            claims: payload.claims,
        });
    }

    /** 供提取器轮末调用：子节点摘要 → 模型 → topic digest（可选，默认关闭）。 */
    async runLlmDigest(payload) {
        if (this.llmRuntime === null) throw new Error('LLM 服务未就绪');
        if (this.config.llm?.enabled !== true || this.config.llm.digest !== true) return '';
        return summarizeTopicWithLlm({
            llm: this.llmRuntime,
            config: this.config.llm,
            topic: { title: payload.title },
            children: payload.children ?? [],
        });
    }

    // ───────────────────────── 工作区解析 ─────────────────────────

    /** 会话对应的 canonical 工作区根（宿主 header.cwd 优先，其次 workingDirectory 服务）。 */
    rootForSession(session) {
        if (session === null || typeof session !== 'object') return null;
        const cached = this.sessionRoots.get(session.id);
        if (cached !== undefined) return cached;
        let cwd = session.header?.cwd;
        if (typeof cwd !== 'string' || cwd === '') {
            try {
                cwd = this.ctx.workingDirectory?.get?.(session);
            } catch {
                cwd = undefined;
            }
        }
        if (typeof cwd !== 'string' || cwd === '') return null;
        const root = canonicalWorkspaceRoot(cwd);
        this.sessionRoots.set(session.id, root);
        return root;
    }

    /** 工具调用所在工作区（必须能解析出 agent 会话根）。 */
    async resolveToolWorkspace(exec) {
        const session = exec?.agent?.session;
        let root = this.rootForSession(session);
        if (root === null) {
            const fallback = this.ctx.workingDirectory?.defaultDirectory;
            if (typeof fallback === 'string' && fallback !== '') root = canonicalWorkspaceRoot(fallback);
        }
        if (root === null) {
            throw new Error('无法确定工作区根：工具调用缺少 agent.session，请从会话内调用，或先设置工作目录。');
        }
        const store = await this.registry.get(root);
        await this.#compactLegacyActions(store);
        await this.#repairOrphanSteps(store);
        await this.#expandLegacyAnswers(store);
        await this.#mergeDuplicateSteps(store);
        return { root, store };
    }

    // ───────────────────────── 事件摄取 ─────────────────────────

    extractorFor(store) {
        const key = store.root.toLowerCase();
        let extractor = this.extractors.get(key);
        if (extractor === undefined) {
            extractor = new ResearchExtractor({
                store,
                actor: 'extractor',
                config: extractConfigOf(this.config),
                logger: this.logger,
                llmExtract: (payload) => this.runLlmExtract(payload),
                digestWriter: (payload) => this.runLlmDigest(payload),
            });
            this.extractors.set(key, extractor);
        }
        return extractor;
    }

    /**
     * 旁路消费一条 `session/event`。
     * 永远不抛错、永远不等待主链路；异常只记日志。
     */
    async ingestSessionEvent(session, event) {
        if (this.closed) return;
        try {
            const root = this.rootForSession(session);
            if (root === null) return;
            const sessionId = typeof session?.id === 'string' ? session.id : 'unknown';
            // 压缩结束后，下一次 pre-step 一定补一次简报（即使同一轮已经注入过）。
            if (event?.type === 'compaction/end') this.briefForced.add(sessionId);
            let cursor = this.cursors.get(sessionId);
            if (cursor === undefined) {
                cursor = { turn: 0, lastUserText: '', toolCalls: new Map() };
                this.cursors.set(sessionId, cursor);
            }
            const events = translateSessionEvent(session, event, cursor);
            if (events.length === 0) return;
            const store = await this.registry.get(root);
            // 兜底：宿主没有发 session/created（或发得比首个事件晚）时，
            // 首次遇到一个「本工作区无节点、历史事件 >1 条」的旧会话，先回放补建。
            if (!this.backfilledSessions.has(sessionId) && typeof session.snapshotEvents === 'function') {
                const hasAny = [...store.state.nodes.values()].some((node) => node.sessionId === sessionId);
                if (!hasAny) {
                    const history = session.snapshotEvents();
                    if (Array.isArray(history) && history.length > 1) await this.backfillSession(session);
                }
            }
            await this.#compactLegacyActions(store);
            await this.#repairOrphanSteps(store);
            await this.#expandLegacyAnswers(store);
            await this.#mergeDuplicateSteps(store);
            const extractor = this.extractorFor(store);
            for (const normalized of events) await extractor.handle(normalized);
            if (event?.type === 'session/end' || event?.type === 'session/end-seed') {
                finishSession(this.cursors, sessionId);
            }
        } catch (error) {
            this.logger.warn?.(`[explore-tree] 会话事件摄取失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 进入一个已有历史、但本工作区还没有图的会话时，回放它的历史事件补建研究树。
     *
     * 场景：插件安装前 / 工作区被清理后重新打开会话（如 temp2）。只做确定性提取，
     * 不调用模型；已有 step 的会话直接跳过，避免重复。
     *
     * @param {object} session host Session（需 id/header/snapshotEvents）
     * @returns {Promise<number>} 回放的事件条数；跳过返回 0
     */
    async backfillSession(session) {
        if (this.closed || this.config.autoCapture === false || this.config.backfillHistory === false) return 0;
        if (session === null || typeof session !== 'object' || typeof session.snapshotEvents !== 'function') return 0;
        try {
            const root = this.rootForSession(session);
            if (root === null) return 0;
            const sessionId = typeof session.id === 'string' ? session.id : null;
            if (sessionId === null || this.backfilledSessions.has(sessionId)) return 0;
            this.backfilledSessions.add(sessionId);
            const store = await this.registry.get(root);
            const hasSteps = [...store.state.nodes.values()].some((node) => node.kind === 'step' && node.sessionId === sessionId);
            if (hasSteps) return 0;
            const all = session.snapshotEvents();
            if (!Array.isArray(all) || all.length === 0) return 0;
            await this.#compactLegacyActions(store);
            await this.#repairOrphanSteps(store);
            await this.#expandLegacyAnswers(store);
            await this.#mergeDuplicateSteps(store);
            const extractor = this.extractorFor(store);
            const cursor = { turn: 0, lastUserText: '', toolCalls: new Map() };
            // 只回放最近一段：非常长的会话留给增量事件，避免进入会话时卡住。
            const events = all.slice(-1200);
            let handled = 0;
            extractor.setBackfilling(true);
            try {
                for (const event of events) {
                    for (const normalized of translateSessionEvent(session, event, cursor)) {
                        await extractor.handle(normalized);
                        handled += 1;
                    }
                }
            } finally {
                extractor.setBackfilling(false);
            }
            if (handled > 0) {
                this.logger.info?.(`[explore-tree] 已从历史会话补建研究树：${sessionId}（${handled} 条事件）`);
            }
            return handled;
        } catch (error) {
            this.logger.warn?.(`[explore-tree] 历史会话补建失败：${error instanceof Error ? error.message : String(error)}`);
            return 0;
        }
    }

    // ───────────────────────── 查询（工具 / HTTP 共用） ─────────────────────────

    /** 有序节点列表（按创建顺序）。 */
    nodesOf(state) {
        return [...state.nodes.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    /** 选一个默认焦点：优先最近活跃会话的活跃节点，其次最新节点。 */
    pickFocus(state) {
        let bestSession = null;
        for (const session of state.sessions.values()) {
            if (bestSession === null || (session.lastSeenAt ?? '') > (bestSession.lastSeenAt ?? '')) bestSession = session;
        }
        if (bestSession !== null && bestSession.activeNodeId !== null && state.nodes.has(bestSession.activeNodeId)) {
            return bestSession.activeNodeId;
        }
        const nodes = this.nodesOf(state);
        return nodes.length > 0 ? nodes[nodes.length - 1].id : null;
    }

    /**
     * 一次性把旧版「每次工具调用一个 action 节点」压缩掉：
     * 动作节点删除、其子节点（产物/死路）上移一层。新版的每轮汇总节点
     * （fingerprint 以 auto:action:agg 开头）保留。结果记在 graph.meta.migrations。
     */
    async #compactLegacyActions(store) {
        if (this.config.compactLegacyActions === false) return;
        const key = store.root.toLowerCase();
        if (this.compactedRoots.has(key)) return;
        this.compactedRoots.add(key);
        try {
            const state = store.state;
            if (state === null) return;
            const migrated = Array.isArray(state.meta?.migrations) ? state.meta.migrations : [];
            if (migrated.includes('compact-legacy-actions')) return;
            const legacy = [...state.nodes.values()].filter((node) =>
                node.kind === 'action'
                && node.origin === 'auto'
                && node.fingerprint !== fingerprint('auto:action:agg', `${node.sessionId ?? ''}\u0000${node.turn ?? 0}`));
            for (const action of legacy) {
                const children = [...state.nodes.values()].filter((node) => node.parentId === action.id);
                for (const child of children) {
                    await store.apply({ t: 'moveNode', id: child.id, parentId: action.parentId ?? null });
                }
                await store.apply({ t: 'remove', id: action.id });
            }
            await store.apply({
                t: 'meta',
                meta: { migrations: [...new Set([...migrated, 'compact-legacy-actions'])] },
            });
            if (legacy.length > 0) {
                this.logger.log?.(`[explore-tree] 已压缩 ${legacy.length} 个历史工具调用节点（产物/死路保留）`);
            }
        } catch (error) {
            this.logger.warn?.(`[explore-tree] 历史动作节点压缩失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 修复历史图：宿主真实事件顺序是 turn/start 先于 user/message，
     * 旧版提取器因此把 step 留成了根节点。把「同会话、有目标、无父节点」的 step 归位。
     */
    async #repairOrphanSteps(store) {
        if (this.config.repairOrphanSteps === false) return;
        const key = store.root.toLowerCase();
        if (this.repairedRoots.has(key)) return;
        try {
            const state = store.state;
            if (state === null) return;
            const migrated = Array.isArray(state.meta?.migrations) ? state.meta.migrations : [];
            if (migrated.includes('adopt-orphan-steps')) {
                this.repairedRoots.add(key);
                return;
            }
            const orphans = [];
            for (const node of state.nodes.values()) {
                if (node.kind !== 'step' || node.parentId !== null) continue;
                const session = state.sessions.get(node.sessionId);
                if (session === undefined || session.goalId === null) continue;
                const goal = state.nodes.get(session.goalId);
                if (goal === undefined || goal.kind !== 'goal') continue;
                orphans.push({ step: node, goalId: goal.id });
            }
            if (orphans.length === 0) return;
            for (const { step, goalId } of orphans) {
                await store.apply({ t: 'moveNode', id: step.id, parentId: goalId });
            }
            await store.apply({
                t: 'meta',
                meta: { migrations: [...new Set([...migrated, 'adopt-orphan-steps'])] },
            });
            if (orphans.length > 0) {
                this.logger.log?.(`[explore-tree] 已把 ${orphans.length} 个孤立步骤归到所属目标下`);
            }
        } catch (error) {
            this.logger.warn?.(`[explore-tree] 孤立步骤修复失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 修复历史图：旧版提取器把「没有推理链的长回答」压成一个 conclusion 节点，
     * 单轮会话因此只有 goal/step/conclusion 三个节点。首次读取时按小标题补出推导链。
     * 只处理「step 下没有 section 子节点」的旧结论，幂等。
     */
    async #expandLegacyAnswers(store) {
        if (this.config.expandLegacyAnswers === false) return;
        const key = store.root.toLowerCase();
        if (this.expandedRoots.has(key)) return;
        try {
            const state = store.state;
            if (state === null) return;
            const migrated = Array.isArray(state.meta?.migrations) ? state.meta.migrations : [];
            if (migrated.includes('expand-conclusion-sections')) {
                this.expandedRoots.add(key);
                return;
            }
            const steps = [...state.nodes.values()].filter((node) => node.kind === 'step');
            let expanded = 0;
            for (const step of steps) {
                const children = [...state.nodes.values()].filter((node) => node.parentId === step.id);
                const hasSections = children.some((node) => Array.isArray(node.tags) && node.tags.includes('section'));
                if (hasSections) continue;
                const conclusion = children.find((node) =>
                    node.kind === 'conclusion'
                    && (node.summary ?? '').length >= this.config.minAnswerChars);
                if (conclusion === undefined) continue;
                const sections = splitAnswerSections(conclusion.summary, {
                    minSectionChars: this.config.minSectionChars,
                    maxSections: this.config.maxAnswerSections,
                    maxChars: this.config.maxSummaryChars,
                });
                if (sections.length < 2) continue;
                let parentId = step.id;
                let majorId = null;
                let made = 0;
                for (const section of sections) {
                    if (section.conclusion) {
                        await store.apply({ t: 'updateNode', id: conclusion.id, patch: { title: section.title, tags: ['key'] } });
                        continue;
                    }
                    const fp = fingerprint('auto:section', `${step.sessionId}\u0000${step.turn}\u0000${normalizeKey(section.title)}`);
                    const exists = [...state.nodes.values()].some((node) => node.fingerprint === fp);
                    if (exists) continue;
                    const kind = classifySectionKind(section.title, section.body);
                    parentId = section.level > 0 ? step.id : (majorId ?? step.id);
                    const op = await store.apply({
                        t: 'addNode',
                        node: {
                            parentId,
                            kind,
                            title: section.title,
                            summary: section.body,
                            status: kind === 'hypothesis' ? 'open' : 'done',
                            origin: 'auto',
                            sessionId: step.sessionId,
                            turn: step.turn ?? null,
                            fingerprint: fp,
                            tags: ['section'],
                        },
                    });
                    if (section.level > 0) majorId = op.node.id;
                    made += 1;
                }
                if (made > 0) expanded += 1;
            }
            await store.apply({
                t: 'meta',
                meta: { migrations: [...new Set([...migrated, 'expand-conclusion-sections'])] },
            });
            if (expanded > 0) {
                this.logger.log?.(`[explore-tree] 已把 ${expanded} 个旧结论展开成推导节点`);
            }
        } catch (error) {
            this.logger.warn?.(`[explore-tree] 旧结论展开失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 修复历史图：同一会话同一轮可能同时存在 turn/start 建的 step 和中途接入补建的
     * midway step（旧版指纹不同，各建一个）。合并时保留正常指纹的节点，其余子节点/
     * hits/refs 并过去后删除副本，保证一轮只有一个 step。
     */
    async #mergeDuplicateSteps(store) {
        if (this.config.mergeDuplicateSteps === false) return;
        const key = store.root.toLowerCase();
        if (this.mergedStepRoots.has(key)) return;
        try {
            const state = store.state;
            if (state === null) return;
            const migrated = Array.isArray(state.meta?.migrations) ? state.meta.migrations : [];
            if (migrated.includes('merge-duplicate-steps')) {
                this.mergedStepRoots.add(key);
                return;
            }
            const groups = new Map();
            for (const node of state.nodes.values()) {
                if (node.kind !== 'step' || !Number.isInteger(node.turn)) continue;
                const groupKey = `${node.sessionId ?? ''}\u0000${node.turn}`;
                const list = groups.get(groupKey) ?? [];
                list.push(node);
                groups.set(groupKey, list);
            }
            let merged = 0;
            for (const steps of groups.values()) {
                if (steps.length < 2) continue;
                steps.sort((a, b) => stepRank(a) - stepRank(b) || (a.order ?? 0) - (b.order ?? 0));
                const keep = steps[0];
                for (const drop of steps.slice(1)) {
                    await store.apply({ t: 'merge', keepId: keep.id, dropId: drop.id });
                    await store.apply({ t: 'remove', id: drop.id });
                    merged += 1;
                }
                if (/缺少开始事件/u.test(String(keep.title ?? ''))) {
                    await store.apply({ t: 'updateNode', id: keep.id, patch: { title: `第 ${keep.turn} 轮研究` } });
                }
            }
            await store.apply({
                t: 'meta',
                meta: { migrations: [...new Set([...migrated, 'merge-duplicate-steps'])] },
            });
            if (merged > 0) this.logger.log?.(`[explore-tree] 已合并 ${merged} 个重复轮次 step`);
        } catch (error) {
            this.logger.warn?.(`[explore-tree] 重复轮次 step 合并失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 研究简报：工作区已有 goal 时返回完整简报；已有上次快照时只返回增量（≤400 字）。
     * 不创建 store（peek），避免只是打开面板就生成新图文件。
     *
     * @param {object} session
     * @param {{previous?: Map<string, object>|null, full?: boolean}} [options]
     * @returns {Promise<{text: string, snapshot: Map<string, object>}|null>}
     */
    async briefForSession(session, options = {}) {
        if (session === null || typeof session !== 'object') return null;
        const root = this.rootForSession(session);
        if (root === null) return null;
        const store = this.registry.peek(root);
        if (store === undefined) return null;
        const state = store.state;
        if (state === null || state === undefined) return null;
        const hasGoal = [...state.nodes.values()].some((node) => node.kind === 'goal');
        if (!hasGoal) return null;
        const sessionId = typeof session.id === 'string' ? session.id : null;
        const previous = options.previous instanceof Map ? options.previous : null;
        const text = options.full === true || previous === null
            ? renderBrief(state, { sessionId, limit: 3, scope: this.config.briefScope })
            : renderBriefDelta(state, previous, { sessionId });
        return { text, snapshot: snapshotBriefState(state) };
    }

    /**
     * 把研究简报注入 agent/pre-step 的 decision（在现有 messages 之后追加一条 user 消息）。
     * 同一 session 同一轮最多注入一次；没有 goal 或配置关闭时原样返回。
     *
     * @param {object} decision
     * @param {{session?: object, turn?: number, step?: number}} [context]
     */
    async injectBrief(decision, context = {}) {
        if (this.config.injectBrief === false) return decision;
        const session = context.session ?? null;
        if (session === null || typeof session !== 'object' || typeof session.id !== 'string') return decision;
        const turn = Number.isInteger(context.turn) ? context.turn : null;
        const step = Number.isInteger(context.step) ? context.step : null;
        const key = turn !== null ? `turn:${turn}` : `step:${step ?? 0}`;
        const forced = this.briefForced.has(session.id);
        if (!forced && this.briefInjections.get(session.id) === key) return decision;
        let payload;
        try {
            payload = await this.briefForSession(session, {
                previous: this.briefSnapshots.get(session.id) ?? null,
                full: forced,
            });
        } catch (error) {
            this.logger.warn?.(`[explore-tree] 生成研究简报失败：${error instanceof Error ? error.message : String(error)}`);
            return decision;
        }
        if (payload === null) return decision;
        if (payload.text === '') {
            // 这一轮树没有值得说的变化：记录已检查，避免同一轮后续 step 又推一条；
            // 但不更新快照，变化会留到下一轮增量里。
            this.briefInjections.set(session.id, key);
            return decision;
        }
        const text = payload.text;
        this.briefInjections.set(session.id, key);
        this.briefSnapshots.set(session.id, payload.snapshot);
        this.briefForced.delete(session.id);
        const message = {
            id: `explore-tree-brief-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'explore-tree-context', form: 'snapshot', sections: [{ name: 'explore-tree-brief', text }] },
        };
        const base = decision !== null && typeof decision === 'object' ? decision : {};
        const messages = Array.isArray(base.messages) ? base.messages : [];
        return { ...base, messages: [...messages, message] };
    }

    /** 完整快照（浏览器面板 + 可能的调试）。 */
    async snapshotFor(root, options = {}) {
        // 浏览器可能带着 8.3/别名/不同大小写的路径来；registry 以 canonical root 为键。
        // 不在这里归一化，就会读到另一个 store，出现「工具写了但快照没有」。
        const store = await this.registry.get(canonicalWorkspaceRoot(root) ?? root);
        await this.#compactLegacyActions(store);
        await this.#repairOrphanSteps(store);
        await this.#expandLegacyAnswers(store);
        await this.#mergeDuplicateSteps(store);
        const state = await store.current();
        await this.#touchIndex(store.root, workspaceName(store.root), state.nodes.size);
        const focusId = typeof options.focusId === 'string' && state.nodes.has(options.focusId)
            ? options.focusId
            : this.pickFocus(state);
        const frontier = computeFrontier(state, { focusId, limit: options.limit ?? 6 });
        const open = collectOpenItems(state, { limit: 8 });
        const stats = graphStats(state);
        return {
            ok: true,
            generatedAt: new Date().toISOString(),
            workspace: { root: store.root, name: workspaceName(store.root) },
            focus: focusId,
            stats: { ...stats, openUnresolved: open.visibleCount, openHidden: open.hiddenCount },
            open: {
                total: open.total,
                visibleCount: open.visibleCount,
                hiddenCount: open.hiddenCount,
                noiseCount: open.noiseCount,
                staleCount: open.staleCount,
                detailCount: open.detailCount,
                items: open.visible.map((item) => serializeNode(item.node)),
            },
            sessions: [...state.sessions.values()],
            nodes: this.nodesOf(state).map(serializeNode),
            edges: state.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, note: edge.note ?? '' })),
            frontier,
        };
    }

    /** 已注册/已打开/被追踪的工作区列表（供面板切换）。 */
    async listWorkspaces() {
        const seen = new Map();
        const add = (root, kind, title, extra = {}) => {
            if (typeof root !== 'string' || root === '') return;
            const canonical = canonicalWorkspaceRoot(root);
            const key = canonical.toLowerCase();
            const current = seen.get(key);
            const nodes = extra.nodes ?? 0;
            if (current !== undefined && current.nodes >= nodes) return;
            seen.set(key, {
                root: canonical,
                key,
                name: title !== undefined && title !== '' ? title : workspaceName(canonical),
                kind,
                nodes,
                updatedAt: extra.updatedAt ?? null,
            });
        };

        let registered = [];
        try {
            const list = this.ctx.workspaceRegistry?.list?.();
            registered = Array.isArray(list) ? list : (list !== null && typeof list === 'object' ? [...list] : []);
        } catch (error) {
            this.logger.warn?.(`[explore-tree] 读取工作区列表失败：${error instanceof Error ? error.message : String(error)}`);
        }
        for (const workspace of registered) {
            const root = workspace?.path;
            const store = typeof root === 'string' ? this.registry.peek(canonicalWorkspaceRoot(root)) : null;
            add(root, 'registered', workspace?.title, {
                nodes: store?.state?.nodes.size ?? 0,
                updatedAt: store?.state?.updatedAt ?? null,
            });
        }
        for (const entry of this.registry.list()) {
            add(entry.root, 'opened', undefined, {
                nodes: entry.nodes,
                updatedAt: this.registry.peek(entry.root)?.state?.updatedAt ?? null,
            });
        }
        for (const root of this.sessionRoots.values()) {
            const store = this.registry.peek(root);
            add(root, 'session', undefined, { nodes: store?.state?.nodes.size ?? 0 });
        }
        for (const entry of await this.#readIndex()) {
            add(entry.root, 'disk', entry.name, { nodes: entry.nodes ?? 0, updatedAt: entry.lastSeen ?? null });
        }
        return [...seen.values()].sort((a, b) => b.nodes - a.nodes || a.name.localeCompare(b.name));
    }

    /** 某个工作区是否允许通过 HTTP 暴露（防任意路径读取）。 */
    async allowsRoot(root) {
        if (typeof root !== 'string' || root === '') return false;
        const canonical = canonicalWorkspaceRoot(root);
        const key = canonical.toLowerCase();
        if (this.registry.peek(canonical) !== null) return true;
        for (const tracked of this.sessionRoots.values()) {
            if (tracked.toLowerCase() === key) return true;
        }
        try {
            const list = this.ctx.workspaceRegistry?.list?.() ?? [];
            for (const workspace of list) {
                if (workspace?.path !== undefined && canonicalWorkspaceRoot(workspace.path).toLowerCase() === key) return true;
            }
        } catch {
            // 无 workspaceRegistry 时只信任已打开/已追踪的根。
        }
        for (const entry of await this.#readIndex()) {
            if (typeof entry.root === 'string' && entry.root.toLowerCase() === key) return true;
        }
        // 磁盘上已有图的目录允许只读打开（无需先有对话）。
        return fs.existsSync(path.join(canonical, this.config.dirName, 'graph.json'));
    }

    // ───────────────────── 全局工作区索引（重启后仍能看到历史图） ─────────────────────

    #indexPath() {
        const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
            ? process.env.DSH_HOME
            : path.join(os.homedir(), '.dsh');
        return path.join(home, 'explore-tree', 'workspaces.json');
    }

    async #readIndex() {
        if (this.workspaceIndex !== null) return this.workspaceIndex;
        try {
            const raw = await fs.promises.readFile(this.#indexPath(), 'utf8');
            const parsed = JSON.parse(raw);
            this.workspaceIndex = Array.isArray(parsed) ? parsed.filter((item) => item !== null && typeof item === 'object') : [];
        } catch {
            this.workspaceIndex = [];
        }
        return this.workspaceIndex;
    }

    async #touchIndex(root, name, nodes) {
        try {
            const list = await this.#readIndex();
            const key = root.toLowerCase();
            const next = list.filter((item) => typeof item.root === 'string' && item.root.toLowerCase() !== key);
            next.unshift({ root, name, nodes, lastSeen: new Date().toISOString() });
            this.workspaceIndex = next.slice(0, 50);
            await fs.promises.mkdir(path.dirname(this.#indexPath()), { recursive: true });
            const temp = `${this.#indexPath()}.${process.pid}.tmp`;
            await fs.promises.writeFile(temp, `${JSON.stringify(this.workspaceIndex, null, 2)}\n`, 'utf8');
            await fs.promises.rename(temp, this.#indexPath());
        } catch (error) {
            this.logger.warn?.(`[explore-tree] 写入工作区索引失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // ───────────────────────── HTTP 路由 ─────────────────────────

    async handleHttp(req, res) {
        try {
            if (!isLoopback(req)) {
                sendJson(res, 403, { ok: false, error: 'forbidden: explore-tree 只接受本机请求' });
                return;
            }
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
            }
            const url = new URL(req.url ?? '/', 'http://localhost');
            const pathname = url.pathname.replace(/\/+$/u, '');
            if (pathname === '/explore-tree/workspaces') {
                sendJson(res, 200, { ok: true, workspaces: await this.listWorkspaces() });
                return;
            }
            if (pathname === '/explore-tree/snapshot') {
                const requested = url.searchParams.get('workspace');
                let root = requested;
                if (root === null || root === '') {
                    const workspaces = await this.listWorkspaces();
                    const first = workspaces.find((item) => item.nodes > 0) ?? workspaces[0];
                    if (first === undefined) {
                        sendJson(res, 200, { ok: true, empty: true, nodes: [], edges: [], stats: graphStats(createEmptyState()) });
                        return;
                    }
                    root = first.root;
                }
                // allowsRoot/snapshotFor 都会 canonical 化；这里传原始路径，避免同一请求
                // 额外做一次同步 realpathSync。
                if (!(await this.allowsRoot(root))) {
                    sendJson(res, 404, { ok: false, error: 'workspace not found or not allowed' });
                    return;
                }
                const focus = url.searchParams.get('focus');
                sendJson(res, 200, await this.snapshotFor(root, { focusId: focus ?? undefined }));
                return;
            }
            if (pathname === '/explore-tree/health') {
                sendJson(res, 200, { ok: true, opened: this.registry.list().length, version: 1 });
                return;
            }
            sendJson(res, 404, { ok: false, error: 'not found' });
        } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    }

    // ───────────────────────── 生命周期 ─────────────────────────

    async dispose() {
        if (this.closed) return;
        this.closed = true;
        const extractors = [...this.extractors.values()];
        this.extractors.clear();
        await Promise.allSettled(extractors.map((extractor) => extractor.dispose()));
        await this.registry.closeAll();
        this.cursors.clear();
        this.sessionRoots.clear();
        this.briefInjections.clear();
        this.briefSnapshots.clear();
        this.briefForced.clear();
    }
}

/** 空图统计（HTTP 首次访问用例）。 */
function createEmptyState() {
    return {
        nodes: new Map(),
        edges: [],
        roots: new Set(),
        sessions: new Map(),
    };
}

/** 重复 step 排序：正常 turn/start 指纹优先，其次 midway，最后旧节点。 */
function stepRank(node) {
    const key = `${node.sessionId ?? ''}\u0000${node.turn ?? 0}`;
    if (node.fingerprint === fingerprint('auto:step', key)) return 0;
    if (node.fingerprint === fingerprint('auto:step:midway', key)) return 1;
    return 2;
}
