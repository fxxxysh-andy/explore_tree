/**
 * 确定性研究图提取器：把归一化的会话事件变成研究树操作。
 *
 * 设计要点：
 *  - **旁路**：只订阅事件、只写研究图，绝不向主对话注入内容（需求 5）；
 *  - **不干扰前缀**：不修改系统提示、不动态增删工具（需求 6）；
 *  - **去重优先**：相同工具/相同参数/相同目标指纹 → 命中计数，不重复造节点（需求 2）；
 *  - **失败也是资产**：工具失败/轮次中断记录成 abandoned / dead_end，供 frontier 避开（需求 7）；
 *  - 所有操作走 store.apply（串行、可重放、可审计）；纯函数规则便于迭代与单测。
 *
 * 事件协议（由宿主适配器负责把 DSH 事件翻译成下列形状）：
 *   {type:'session.start', sessionId, workspaceRoot?, title?}
 *   {type:'user.message', sessionId, text, turn?, messageId?, sourceKind?, sourceForm}
 *   {type:'turn.start', sessionId, turn, seq?}
 *   {type:'assistant.reasoning', sessionId, turn?, step?, text}
 *   {type:'assistant.message', sessionId, turn?, step?, text, final?}
 *   {type:'tool.start', sessionId, turn?, step?, callId, toolName, args?}
 *   {type:'tool.end', sessionId, turn?, step?, callId, toolName, ok?, result?, error?, artifacts?}
 *   {type:'deliverable.presented', sessionId, turn?, callId?, files:[{value,label?}]}
 *   {type:'turn.end', sessionId, turn, text?, aborted?, error?, durationMs?}
 *   {type:'session.end', sessionId}
 *
 * 关键约束（v0.5）：只有 sourceKind 为空或 `user` 的消息才是真人输入；注入消息
 * （time-context / user-approval / tool-jobs …）只进运行时上下文，不建 goal、不碰标题。
 *
 * @module core/extract
 */
import { fingerprint, normalizeKey } from './fingerprint.js';
import {
    childrenOf,
    findByFingerprint,
    nowIso,
    sessionOf,
} from './graph.js';
import { isReasoningNoiseText } from './hygiene.js';
import { clampText, isLeafRootKind } from './model.js';
import { classifyClaim, isApproachKind, isQuestionText, selectClaims, similarity, splitSentences } from './select.js';
import { digestBasisOf, topicDigest } from './trunk.js';

/** 默认配置（宿主 Config 会覆盖）。 */
export const DEFAULT_EXTRACT_CONFIG = Object.freeze({
    enabled: true,
    captureReasoning: true,
    /**
     * 把推理链切成「想法节点」。研究图以推理为主、工具动作为辅：
     * 推理里对错未定的猜测、观察、取舍都值得留痕，不要求结论正确。
     */
    captureReasoningNodes: true,
    /** 没有任何 topic 时，单轮产出足够多想法后自动建一个候选主题（之后的想法自动挂上去）。 */
    autoSeedTopic: true,
    topicSeedMinClaims: 5,
    /** 单个 topic 下最多保留的未决叶根；超出后新想法挂到其他主题/新主题，避免一棵巨仓。 */
    maxOpenLeavesPerTopic: 9,
    captureToolCalls: true,
    /**
     * 工具调用的记录方式：
     * - aggregate（默认）：每轮只留一个「工具调用 ×N」汇总节点，避免每个调用都占一个节点；
     * - nodes：每次调用一个 action 节点（旧行为，适合调试）；
     * - off：完全不记录工具调用（失败/产物也不记）。
     */
    toolCallMode: 'aggregate',
    captureArtifacts: true,
    detectConclusions: true,
    /**
     * 没有推理链时的兜底：把长最终回答按 Markdown 标题/加粗小标题拆成推导节点，
     * 让「只有一问一答」的会话也能得到一棵像样的树。
     */
    captureAnswerSections: true,
    minAnswerChars: 400,
    minSectionChars: 16,
    maxAnswerSections: 10,
    ignoreTools: ['explore_tree', 'explore_tree_record'],
    maxAutoNodesPerTurn: 80,
    /**
     * 想法节点的取舍策略：
     * - ranked（默认）：多特征分类 + 近似去重 + 分层配额 + MMR，只留本轮 ≤K 条关键想法；
     * - chronological：旧行为，按事件顺序落节点（调试/对比用）。
     */
    selectionStrategy: 'ranked',
    /** 单轮最多落多少条推理节点（一屏可读）。 */
    maxThoughtNodesPerTurn: 10,
    /** 单段推理最多切几个想法（其余并回轮次摘要）。 */
    maxThoughtUnitsPerBlock: 8,
    /** 分层配额：超出的同层候选不落节点。 */
    thoughtQuotas: Object.freeze({
        dead_end: 3,
        conclusion: 1,
        decision: 3,
        hypothesis: 3,
        evidence: 3,
        question: 2,
        note: 0,
    }),
    /** 近似去重阈值（Jaccard 词面相似）。 */
    dedupeSimThreshold: 0.85,
    /** MMR 去冗余强度：score - λ·maxSim(已选)。 */
    mmrLambda: 0.7,
    /** 给结论预留的槽位（结论常在轮次末尾出现）。 */
    reserveConclusionSlots: 1,
    /** 分类置信门槛：top1 分数或 top1-top2 差值不足时折叠成 note。 */
    claimMinConfidence: 1.2,
    claimMargin: 0.35,
    /**
     * 主题关联阈值：跨轮证据/结论与假设、同轮新 approach 与活跃分支的相似度
     * 达到该值才建边或嵌套，避免把无关节点连成一团。
     */
    threadLinkThreshold: 0.55,
    /**
     * 同轮嵌套阈值：新 claim 挂到同轮更早 claim 下的相似度门槛。
     * 比跨轮的 threadLinkThreshold 宽松，让「主问题 → 子假设 → 证据 → 结论」形成逻辑深度，
     * 而不是全部平铺在 step 下。
     */
    intraTurnLinkThreshold: 0.15,
    /**
     * note 的处理方式：
     * - fold（默认）：不建节点，计入 step 摘要的「过程观察 ×N」；
     * - node：旧行为，note 也落节点（调试/对比用）。
     */
    noteNodeMode: 'fold',
    /**
     * 想法的最低信息量分数（仅 chronological 模式使用）。默认 1：有信息就留。
     */
    minThoughtScore: 1,
    minThoughtChars: 12,
    maxThoughtChars: 400,
    /** 一段推理最多读取多少字符；超长时取「头 + 尾」，兼顾问题与末尾结论。 */
    maxThoughtSourceChars: 60000,
    maxReasoningChars: 2400,
    maxSummaryChars: 1200,
    maxTitleChars: 120,
    newGoalOnTurnConclusion: false,
    /** 可选 LLM 辅助：默认关闭，配置齐全才在轮末异步补节点。 */
    llm: Object.freeze({
        enabled: false,
        provider: undefined,
        model: undefined,
        maxClaims: 6,
        maxInputChars: 12000,
        timeoutMs: 20000,
        maxOutputTokens: 1200,
        /** 轮末用 LLM 重写 topic digest（默认关，失败回退模板摘要）。 */
        digest: false,
    }),
});

const CONCLUSION_PATTERN = /(^|\n)\s*(?:#{1,6}\s*)?(?:结论|小结|总结|综上|因此|所以|最终答案|答案[:：]|结论[:：])/;

/** 想法节点的默认状态：不预判对错，只表达「还没定 / 已记下 / 已撞墙」。 */
const THOUGHT_STATUS = Object.freeze({
    question: 'open',
    hypothesis: 'open',
    dead_end: 'abandoned',
    evidence: 'done',
    decision: 'done',
    conclusion: 'done',
    note: 'done',
});

/**
 * 旁路提取器。
 */
export class ResearchExtractor {
    /**
     * @param {object} options
     * @param {import('./store.js').WorkspaceGraphStore} options.store
     * @param {object} [options.config]
     * @param {object} [options.logger]
     * @param {() => string} [options.now]
     * @param {string} [options.actor] 自动提取的写入者 id；缺省 extractor。
     */
    constructor(options) {
        this.store = options.store;
        this.config = { ...DEFAULT_EXTRACT_CONFIG, ...(options.config ?? {}) };
        this.logger = options.logger ?? console;
        this.now = options.now ?? nowIso;
        // P5.6：自动提取也要有可审计的 actor，否则 journal 里 96% 写事件无归属。
        this.actor = typeof options.actor === 'string' && options.actor.trim() !== '' ? options.actor.trim() : 'extractor';

        /** @type {Map<string, {turn: number, startedTurn: number|null, stepId: string|null, lastUserText: string, lastInjectionText: string, pendingUserIntents: Array<{turn: number, text: string, messageId?: string}>, actionNodes: Map<string, string>, activeActionId: string|null, autoCount: number, claimNodes: Map<string, string>, claimCreatedNodes: Set<string>, warned: Set<string>}>} */
        this.runtime = new Map();
        this.queue = Promise.resolve();
        this.disposed = false;
        /** 可选：轮末异步 LLM 提取（由宿主注入）。 */
        this.llmExtract = typeof options.llmExtract === 'function' ? options.llmExtract : null;
        /** 可选：轮末异步 LLM 摘要（由宿主注入）。 */
        this.digestWriter = typeof options.digestWriter === 'function' ? options.digestWriter : null;
        /** 未完成的 LLM 旁路任务（dispose / 测试用）。 */
        this.llmJobs = new Set();
        /** 回放历史期不触发 LLM（避免进入旧会话时刷一堆模型调用）。 */
        this.backfilling = false;
    }

    /** 回放历史期间关闭 LLM 旁路。 */
    setBackfilling(value) {
        this.backfilling = value === true;
    }

    /** 宿主在 llm 服务就绪后注入提取函数。 */
    setLlmExtract(fn) {
        this.llmExtract = typeof fn === 'function' ? fn : null;
    }

    /** 宿主在 llm 服务就绪后注入摘要函数。 */
    setDigestWriter(fn) {
        this.digestWriter = typeof fn === 'function' ? fn : null;
    }

    /** 等待所有 LLM 旁路任务结束（测试 / 卸载时用）。 */
    async settleLlm() {
        while (this.llmJobs.size > 0) {
            await Promise.allSettled([...this.llmJobs]);
        }
    }

    /** 串行处理一条事件；返回处理结果（测试用）。 */
    async handle(event) {
        if (this.disposed) return null;
        const run = this.queue.then(
            () => this.#handle(event),
            () => this.#handle(event),
        );
        this.queue = run.then(
            () => undefined,
            () => undefined,
        );
        try {
            return await run;
        } catch (error) {
            this.logger.warn?.(`[explore-tree] 事件提取失败（${event?.type}）：${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    async dispose() {
        this.disposed = true;
        try {
            await this.queue;
        } catch {
            // ignore
        }
        try {
            await this.settleLlm();
        } catch {
            // ignore
        }
    }

    async #handle(event) {
        if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return null;
        await this.store.open();
        if (!this.config.enabled) return null;
        switch (event.type) {
            case 'session.start':
                return this.#onSessionStart(event);
            case 'user.message':
                return this.#onUserMessage(event);
            case 'turn.start':
                return this.#onTurnStart(event);
            case 'assistant.reasoning':
                return this.#onReasoning(event);
            case 'assistant.message':
                return this.#onAssistantMessage(event);
            case 'tool.start':
                return this.#onToolStart(event);
            case 'tool.end':
                return this.#onToolEnd(event);
            case 'deliverable.presented':
                return this.#onDeliverable(event);
            case 'turn.end':
                return this.#onTurnEnd(event);
            case 'session.end':
                return this.#onSessionEnd(event);
            default:
                return null;
        }
    }

    // ─────────────────────────── 事件处理 ───────────────────────────

    async #onSessionStart(event) {
        const session = this.#ensureSession(event);
        this.#runtime(event.sessionId, event.turn ?? 0);
        return session;
    }

    async #onUserMessage(event) {
        const text = clampText(event.text, 4000, { keepNewlines: true });
        if (text === '') return null;
        const runtime = this.#runtime(event.sessionId, event.turn ?? 0);
        // 注入消息（time-context / user-approval / tool-jobs …）只更新运行时上下文：
        // 它们不能建 goal，不能被当作轮次标题，也不触发任何锚点回填。
        if (!isRealUserEvent(event)) {
            runtime.lastInjectionText = text;
            return null;
        }
        runtime.lastUserText = text;
        const session = this.#ensureSession(event);
        const state = this.store.state;
        const existingGoal = session.goalId !== null ? state.nodes.get(session.goalId) : undefined;
        let goal = existingGoal;
        if (goal === undefined) {
            goal = await this.#addNode({
                parentId: null,
                kind: 'goal',
                title: titleFromText(text, this.config.maxTitleChars),
                summary: text,
                status: 'active',
                origin: 'auto',
                sessionId: event.sessionId,
                turn: event.turn ?? null,
                tags: ['goal:user'],
                refs: event.messageId !== undefined ? [{ kind: 'message', value: String(event.messageId) }] : [],
                fingerprint: fingerprint('auto:goal', normalizeKey(text)),
            });
            await this.#setSession(event.sessionId, { goalId: goal.id, activeNodeId: goal.id });
            await this.#adoptRootSteps(event.sessionId, goal.id);
        } else {
            // 同一会话：目标已存在，后续用户消息进入本轮 step 的摘要（不新建目标，避免图膨胀）。
            if (existingGoal.status === 'done') await this.#updateNode(existingGoal.id, { status: 'active' });
            await this.#setSession(event.sessionId, { activeNodeId: existingGoal.id });
            await this.#adoptRootSteps(event.sessionId, existingGoal.id);
        }
        await this.#applyUserIntent(event, runtime, text);
        return goal;
    }

    /**
     * 真人消息是轮次的真实锚点：到达后回填 step 的标题/摘要。
     *
     * 宿主顺序是 turn/start 先到（此时还没有本轮用户文本），所以标题不能在建 step 时定；
     * 这里负责补上「第 N 轮：<意图>」。若 step 还没建（用户消息先到），先暂存到
     * runtime.pendingUserIntents，等 turn.start 建 step 时再落。
     */
    async #applyUserIntent(event, runtime, text) {
        const turn = Number.isInteger(event.turn) && event.turn > 0 ? event.turn : runtime.turn;
        const step = this.#findStepNode(event.sessionId, turn);
        if (step === undefined) {
            runtime.pendingUserIntents = runtime.pendingUserIntents ?? [];
            runtime.pendingUserIntents.push({ turn, text, messageId: event.messageId });
            if (runtime.pendingUserIntents.length > 5) runtime.pendingUserIntents.shift();
            return;
        }
        const intentTitle = `第 ${turn} 轮：${titleFromText(text, 80)}`;
        const userLine = `用户输入：${text}`;
        const summary = (step.summary ?? '').includes(userLine)
            ? (step.summary ?? '')
            : `${step.summary ?? ''}${step.summary ? '\n\n' : ''}${userLine}`;
        const patch = {
            summary: clampText(summary, this.config.maxSummaryChars, { keepNewlines: true }),
            refs: mergeUniqueRefs(step.refs, event.messageId !== undefined ? [{ kind: 'message', value: String(event.messageId) }] : []),
        };
        // 只在标题还是默认占位（「第 N 轮研究」「第 N 轮（缺少开始事件）」或被注入文本污染）时回填，
        // 不覆盖已经写下的真实意图。
        if (isPlaceholderStepTitle(step.title)) patch.title = intentTitle;
        await this.#updateNode(step.id, patch);
        runtime.stepId = step.id;
        await this.#setSession(event.sessionId, { activeNodeId: step.id, turn });
    }

    /**
     * 宿主真实事件顺序可能是 `turn/start` 先于 `user/message`：此时 step 先建、
     * goal 后建，step 会残留成根节点。用户消息落库后把同会话的孤立根 step 归到目标下。
     */
    async #adoptRootSteps(sessionId, goalId) {
        if (goalId === null || goalId === undefined) return;
        const state = this.store.state;
        const steps = [];
        for (const node of state.nodes.values()) {
            if (node.kind !== 'step' || node.parentId !== null) continue;
            if (node.sessionId !== sessionId) continue;
            steps.push(node);
        }
        for (const step of steps) {
            await this.store.apply({ t: 'moveNode', id: step.id, parentId: goalId });
        }
    }

    async #onTurnStart(event) {
        const runtime = this.#runtime(event.sessionId, event.turn ?? 0);
        const incomingTurn = Number.isInteger(event.turn) ? event.turn : runtime.turn + 1;
        // 迟到的旧轮 turn.start：只复用已有 step，不回退当前轮的运行时状态。
        if (incomingTurn < runtime.turn) {
            return this.#findStepNode(event.sessionId, incomingTurn) ?? null;
        }
        // 重复投递的 turn.start 不能重置轮级状态；但 user.message 可能先把 runtime.turn
        // 抬到新轮，所以用 startedTurn 判断该轮是否已经初始化，而不是比较 runtime.turn。
        const shouldReset = runtime.startedTurn !== incomingTurn;
        runtime.turn = incomingTurn;
        if (shouldReset) {
            runtime.startedTurn = incomingTurn;
            runtime.autoCount = 0;
            runtime.thoughtCount = 0;
            runtime.thoughtParentId = null;
            runtime.thoughtSkipped = 0;
            runtime.claims = new Map();
            runtime.claimNodes = new Map();
            runtime.claimCreatedNodes = new Set();
            if (runtime.warned === undefined) runtime.warned = new Set();
            else runtime.warned.clear();
            runtime.claimSeq = 0;
            runtime.prunedNoteCount = 0;
            runtime.turnReasoning = '';
            runtime.foldedNotes = [];
            runtime.narrationCount = 0;
            runtime.sectionsCreated = false;
            runtime.sectionLastId = null;
            runtime.answerSectionCount = 0;
            runtime.actionNodes.clear();
            runtime.aggActionId = null;
            runtime.activeActionId = null;
            runtime.toolCounts = new Map();
        }
        const session = this.#ensureSession(event);
        const state = this.store.state;
        const goal = session.goalId !== null ? state.nodes.get(session.goalId) : undefined;
        const pending = this.#takePendingIntents(runtime, runtime.turn);
        const stepTitle = pending.length > 0
            ? `第 ${runtime.turn} 轮：${titleFromText(pending[0].text, 80)}`
            : `第 ${runtime.turn} 轮研究`;
        const summary = clampText(
            pending.map((intent) => `用户输入：${intent.text}`).join('\n\n'),
            this.config.maxSummaryChars,
            { keepNewlines: true },
        );

        // 复用同 session+turn 的 step（中途接入补建的 midway step / 重复投递的 turn.start），
        // 避免出现 n434+n435 这类重复轮次。
        const existing = this.#findStepNode(event.sessionId, runtime.turn);
        if (existing !== undefined) {
            const patch = { status: 'active', turn: runtime.turn };
            // 占位标题才升级；重复投递的 turn/start 不能覆盖已回填的真实意图。
            if (isPlaceholderStepTitle(existing.title)) patch.title = stepTitle;
            if (summary !== '') patch.summary = summary;
            if (isMidwayFingerprint(existing.fingerprint, event.sessionId, runtime.turn)) {
                patch.fingerprint = fingerprint('auto:step', `${event.sessionId}\u0000${runtime.turn}`);
            }
            await this.#updateNode(existing.id, patch);
            if (goal !== undefined && existing.parentId !== goal.id) {
                await this.store.apply({ t: 'moveNode', id: existing.id, parentId: goal.id });
            }
            runtime.stepId = existing.id;
            await this.#setSession(event.sessionId, { activeNodeId: existing.id, turn: runtime.turn });
            await this.#linkStepContinuity(event.sessionId, runtime, existing);
            return existing;
        }

        const step = await this.#addOrHit({
            parentId: goal?.id ?? null,
            kind: 'step',
            title: stepTitle,
            summary,
            status: 'active',
            origin: 'auto',
            sessionId: event.sessionId,
            turn: runtime.turn,
            refs: pending
                .filter((intent) => intent.messageId !== undefined)
                .map((intent) => ({ kind: 'message', value: String(intent.messageId) })),
            fingerprint: fingerprint('auto:step', `${event.sessionId}\u0000${runtime.turn}`),
        });
        runtime.stepId = step.id;
        await this.#setSession(event.sessionId, { activeNodeId: step.id, turn: runtime.turn });
        await this.#linkStepContinuity(event.sessionId, runtime, step);
        return step;
    }

    /**
     * 跨轮结构：把本轮 step 挂到上一轮 step 之后（continues 边）。
     * 树只表达父子，轮次之间的「同一研究在推进」用边表达；只连最近一轮。
     */
    async #linkStepContinuity(sessionId, runtime, step) {
        const state = this.store.state;
        let previous = null;
        for (const node of state.nodes.values()) {
            if (node.kind !== 'step' || node.sessionId !== sessionId || node.id === step.id) continue;
            if (!Number.isInteger(node.turn) || !Number.isInteger(runtime.turn) || node.turn >= runtime.turn) continue;
            if (previous === null || node.turn > previous.turn) previous = node;
        }
        if (previous === null) return;
        await this.store.apply({
            t: 'link',
            from: previous.id,
            to: step.id,
            kind: 'continues',
            note: `第 ${previous.turn} 轮 → 第 ${runtime.turn} 轮`,
        });
    }

    /** 取出并清掉适用于本轮的暂存用户意图（用户消息先于 turn.start 的兜底路径）。 */
    #takePendingIntents(runtime, turn) {
        const pending = runtime.pendingUserIntents ?? [];
        if (pending.length === 0) return [];
        const taken = pending.filter((intent) => intent.turn === turn || intent.turn <= 0 || turn <= 0);
        if (taken.length === 0) return [];
        runtime.pendingUserIntents = pending.filter((intent) => !taken.includes(intent));
        return taken;
    }

    /** 同会话同轮的 step（优先正常指纹，其次 midway，最后旧节点）。 */
    #findStepNode(sessionId, turn) {
        if (!Number.isInteger(turn) || turn <= 0) return undefined;
        const state = this.store.state;
        const normalFingerprint = fingerprint('auto:step', `${sessionId}\u0000${turn}`);
        let normal;
        let midway;
        let other;
        for (const node of state.nodes.values()) {
            if (node.kind !== 'step' || node.sessionId !== sessionId || node.turn !== turn) continue;
            const fp = String(node.fingerprint ?? '');
            if (fp === normalFingerprint) {
                if (normal === undefined || (node.order ?? 0) < (normal.order ?? 0)) normal = node;
            } else if (isMidwayFingerprint(fp, sessionId, turn)) {
                if (midway === undefined || (node.order ?? 0) < (midway.order ?? 0)) midway = node;
            } else if (other === undefined || (node.order ?? 0) < (other.order ?? 0)) {
                other = node;
            }
        }
        return normal ?? midway ?? other;
    }

    /**
     * 跨轮结构边：新节点与「更早轮次」里主题最接近的节点连一条关系。
     * 只连同 session、跨轮、词面相似 ≥ threadLinkThreshold 的最佳一条，避免噪音。
     */
    async #linkThreadEdges(sessionId, turn, node) {
        if (node === undefined || !Number.isInteger(turn) || turn <= 0) return;
        const state = this.store.state;
        const text = `${node.title} ${node.summary ?? ''}`;
        let best = null;
        for (const other of state.nodes.values()) {
            if (other.id === node.id || other.sessionId !== sessionId) continue;
            if (other.kind === 'goal' || other.kind === 'step' || other.kind === 'action'
                || other.kind === 'artifact' || other.kind === 'note') continue;
            if (other.turn === turn) continue; // 同轮关系由 parentId 表达
            if (other.status === 'abandoned' && node.kind !== 'dead_end') continue;
            const kind = this.#threadCandidateKind(node, other);
            if (kind === null) continue;
            const fullScore = similarity(text, `${other.title} ${other.summary ?? ''}`);
            const titleScore = similarity(node.title, other.title);
            const score = Math.max(fullScore, titleScore);
            if (score < this.config.threadLinkThreshold) continue;
            if (best === null || score > best.score) best = { other, kind, score };
        }
        if (best === null) return;
        await this.store.apply({
            t: 'link',
            from: node.id,
            to: best.other.id,
            kind: best.kind,
            note: `跨轮关联 ${Math.round(best.score * 100)}%（第 ${turn} 轮 → 第 ${best.other.turn} 轮）`,
        });
    }

    /** 新节点 → 更早节点允许的关系；返回 null 表示不自动连。 */
    #threadCandidateKind(node, other) {
        const text = `${node.title} ${node.summary ?? ''}`;
        if (node.kind === 'evidence') {
            if (other.kind !== 'hypothesis' && other.kind !== 'question' && other.kind !== 'decision') return null;
            return /(?:不支持|矛盾|相反|不符|不成立|contradicts?)/iu.test(text) ? 'contradicts' : 'supports';
        }
        if (node.kind === 'conclusion') {
            if (other.kind === 'hypothesis') return 'supports';
            if (other.kind === 'decision' || other.kind === 'conclusion') return 'refines';
            return null;
        }
        if (node.kind === 'dead_end') {
            return other.kind === 'hypothesis' ? 'contradicts' : null;
        }
        if (node.kind === 'decision') {
            if (other.kind === 'decision') return 'replaces';
            if (other.kind === 'question' || other.kind === 'hypothesis') return 'refines';
            return null;
        }
        if (node.kind === 'hypothesis') {
            if (other.kind === 'hypothesis' || other.kind === 'decision' || other.kind === 'conclusion') return 'refines';
            if (other.kind === 'question') return 'related';
            return null;
        }
        return null;
    }

    async #onReasoning(event) {
        if (!this.config.captureReasoning) return null;
        const summaryText = clampText(event.text, this.config.maxReasoningChars, { keepNewlines: true });
        const source = thoughtSource(event.text, this.config.maxThoughtSourceChars);
        if (source.trim() === '') return null;
        const runtime = this.#runtime(event.sessionId, event.turn ?? 0);
        const stepId = await this.#connectStep(event, runtime);
        if (stepId === null) return null;
        const step = this.store.state.nodes.get(stepId);
        if (step === undefined) return null;

        // 供轮末 LLM 旁路使用：保留本轮原始推理（按配置上限截断，避免无限增长）。
        const reasoningLimit = Math.max(24000, (this.config.llm?.maxInputChars ?? 12000) * 2);
        runtime.turnReasoning = clampText(
            `${runtime.turnReasoning ?? ''}${runtime.turnReasoning ? '\n\n' : ''}${source}`,
            reasoningLimit,
            { keepNewlines: true },
        );

        // 步骤摘要只留前 maxReasoningChars 字符，完整推理进想法节点，避免步骤摘要无限增长。
        runtime.reasoningChars = (runtime.reasoningChars ?? 0) + summaryText.length;
        if (runtime.reasoningChars <= this.config.maxReasoningChars && summaryText !== '') {
            const merged = step.summary.includes(summaryText)
                ? step.summary
                : `${step.summary}${step.summary === '' ? '' : '\n\n'}推理摘要：${summaryText}`;
            await this.#updateNode(step.id, {
                summary: clampText(merged, this.config.maxSummaryChars, { keepNewlines: true }),
            });
        }

        if (!this.config.captureReasoningNodes) return step;

        const units = splitThoughts(source, {
            minChars: this.config.minThoughtChars,
            maxChars: this.config.maxThoughtChars,
            maxUnits: this.config.maxThoughtUnitsPerBlock,
            // ranked 模式让分类器自己判旁白（并计入「过程观察 ×N」）；chronological 保留旧分数过滤。
            minScore: this.config.selectionStrategy === 'chronological' ? this.config.minThoughtScore : -10,
            fallback: true,
        });

        if (this.config.selectionStrategy === 'chronological') {
            await this.#recordThoughtsInOrder(event, runtime, step, units);
            return step;
        }

        // ranked（默认）：先把本段推理收进候选池，再由 selectClaims 决定「谁值得落节点」。
        this.#collectClaims(event, runtime, units);
        await this.#flushClaims(event, runtime, step);
        return step;
    }

    /**
     * 旧行为：按事件顺序把每个通过阈值的思想片段都落节点。
     * 仅 selectionStrategy='chronological' 时使用（调试/对比）。语义不判断对错。
     */
    async #recordThoughtsInOrder(event, runtime, step, units) {
        for (const unit of units) {
            if ((runtime.thoughtCount ?? 0) >= this.config.maxThoughtNodesPerTurn) {
                this.#warnOnce(runtime, 'thought', `第 ${runtime.turn} 轮推理节点超过上限 ${this.config.maxThoughtNodesPerTurn}`);
                break;
            }
            if (runtime.autoCount >= this.config.maxAutoNodesPerTurn) {
                this.#warnOnce(runtime, 'limit', `第 ${runtime.turn} 轮自动节点超过上限 ${this.config.maxAutoNodesPerTurn}`);
                break;
            }
            const kind = classifyThought(unit);
            const score = scoreThought(unit, kind);
            if (score < this.config.minThoughtScore) {
                runtime.thoughtSkipped = (runtime.thoughtSkipped ?? 0) + 1;
                continue;
            }
        const approach = kind === 'hypothesis' || kind === 'question' || kind === 'decision';
        let parentId = approach
            ? step.id
            : (runtime.thoughtParentId ?? step.id);
        parentId = this.#topicAwareParent(kind, parentId, step.id, runtime, event.sessionId);
            runtime.autoCount += 1;
            runtime.thoughtCount = (runtime.thoughtCount ?? 0) + 1;
            const node = await this.#addOrHit({
                parentId,
                kind,
                title: thoughtTitle(unit, this.config.maxTitleChars),
                summary: clampText(unit, this.config.maxThoughtChars, { keepNewlines: true }),
                status: THOUGHT_STATUS[kind] ?? 'open',
                origin: 'auto',
                sessionId: event.sessionId,
                turn: runtime.turn,
                fingerprint: fingerprint('auto:thought', `${event.sessionId}\u0000${normalizeKey(unit)}`),
                tags: [score >= 6 ? 'key' : 'thought'],
            });
            if (approach) runtime.thoughtParentId = node.id;
        }
    }

    /**
     * ranked 模式的候选池：多特征分类后同一片段（按 claim 文本归一化）只留一条，
     * 片段重复出现时累加 seen；分类可能随上下文变化，取分更高的那次。
     */
    #collectClaims(event, runtime, units) {
        if (!(runtime.claims instanceof Map)) runtime.claims = new Map();
        for (const unit of units) {
            for (const segment of this.#claimSegments(unit)) {
                const claim = classifyClaim(segment, {
                    minChars: this.config.minThoughtChars,
                    minScore: this.config.claimMinConfidence,
                    margin: this.config.claimMargin,
                });
                if (claim.narration) {
                    runtime.narrationCount = (runtime.narrationCount ?? 0) + 1;
                    continue;
                }
                // 分类器仍可能把「Could use / Need decide / Add ...」这类计划句判成问题/假设；
                // 它们只该进轮摘要，不该变成永久 open 的未决节点。
                // question 额外要求真的像疑问句：陈述句被标成 question 时只留摘要。
                if (claim.kind === 'question' && !isQuestionText(claim.claim || segment)) {
                    runtime.narrationCount = (runtime.narrationCount ?? 0) + 1;
                    continue;
                }
                if ((claim.kind === 'question' || claim.kind === 'hypothesis')
                    && isReasoningNoiseText(claim.claim || segment)) {
                    runtime.narrationCount = (runtime.narrationCount ?? 0) + 1;
                    continue;
                }
                const key = `${event.sessionId}\u0000${normalizeKey(claim.claim || segment)}`;
                const existing = runtime.claims.get(key);
                if (existing === undefined) {
                    // 上限约束的是驻留候选数，不是累计出现次数；晚到结论必须仍有机会入选。
                    // 保留已发布节点，淘汰未入选候选中最低分（同分最早）的一条。
                    // 大配额配置至少留一个探索槽；selectClaims 的总配额最多为 500。
                    const thoughtLimit = Number(this.config.maxThoughtNodesPerTurn);
                    const poolLimit = Math.max(60, (Number.isFinite(thoughtLimit)
                        ? Math.min(500, Math.max(0, Math.floor(thoughtLimit))) : 10) + 1);
                    if (runtime.claims.size >= poolLimit) {
                        let victim = null;
                        for (const candidate of runtime.claims.values()) {
                            if (runtime.claimNodes.has(candidate.key)) continue;
                            if (victim === null || candidate.score < victim.score
                                || (candidate.score === victim.score && candidate.order < victim.order)) victim = candidate;
                        }
                        if (victim !== null) {
                            runtime.claims.delete(victim.key);
                            if (victim.kind === 'note') runtime.prunedNoteCount = (runtime.prunedNoteCount ?? 0) + 1;
                        }
                    }
                    runtime.claimSeq = (runtime.claimSeq ?? 0) + 1;
                    runtime.claims.set(key, {
                        key,
                        text: segment,
                        kind: claim.kind,
                        score: claim.score,
                        title: claim.title,
                        order: runtime.claimSeq,
                        seen: 1,
                    });
                } else {
                    existing.seen += 1;
                    if (claim.kind !== 'note' && claim.score > existing.score + 0.25) {
                        existing.kind = claim.kind;
                        existing.score = claim.score;
                        existing.title = claim.title;
                        existing.text = segment;
                    }
                }
            }
        }
    }

    /**
     * 把一个想法片段切成「一句一 claim」：分类和标题都以单句为准，
     * 避免 400 字段落里前面是旁白、后面是结论时分类被带偏。
     * 过短句并回上一句；一段最多 4 个 claim，其余并成最后一条。
     */
    #claimSegments(unit) {
        const sentences = splitSentences(unit);
        if (sentences.length <= 1) return [unit];
        const merged = [];
        for (const sentence of sentences) {
            if (merged.length > 0 && sentence.length < this.config.minThoughtChars) {
                merged[merged.length - 1] = `${merged[merged.length - 1]} ${sentence}`;
            } else {
                merged.push(sentence);
            }
        }
        if (merged.length > 4) {
            return [...merged.slice(0, 3), merged.slice(3).join(' ')];
        }
        return merged;
    }

    /**
     * 按当前候选池重算本轮节点集合：新建/更新/删除，并把 dependent 挂到
     * 最近一个已选中的 approach（question/hypothesis/decision）下。
     */
    async #flushClaims(event, runtime, step) {
        if (step === undefined || !(runtime.claims instanceof Map)) return;
        const candidates = [...runtime.claims.values()];
        if (candidates.length === 0) {
            runtime.thoughtCount = 0;
            return;
        }
        const { selected, folded } = selectClaims(candidates, {
            maxThoughtNodesPerTurn: this.config.maxThoughtNodesPerTurn,
            thoughtQuotas: this.config.thoughtQuotas,
            mmrLambda: this.config.mmrLambda,
            dedupeSimThreshold: this.config.dedupeSimThreshold,
            reserveConclusionSlots: this.config.reserveConclusionSlots,
            noteNodeMode: this.config.noteNodeMode,
        });
        runtime.foldedNotes = folded;
        const wanted = new Set(selected.map((item) => item.key));

        // ① 删掉本轮已经发布、但不再入选的节点（长轮次增量替换）。
        // 只删「本轮 #flushClaims 新建」的节点；adopted（指纹命中上一轮）的历史节点
        // 落选时仅解除 claim→node 映射，绝不能跨轮删除。
        for (const [key, nodeId] of [...runtime.claimNodes.entries()]) {
            if (wanted.has(key)) continue;
            runtime.claimNodes.delete(key);
            if (!runtime.claimCreatedNodes.has(nodeId)) continue;
            runtime.claimCreatedNodes.delete(nodeId);
            if (this.store.state.nodes.has(nodeId)) {
                await this.store.apply({ t: 'remove', id: nodeId });
                runtime.autoCount = Math.max(0, runtime.autoCount - 1);
            }
        }

        // ② 先建/更新 approach（dependent 要挂它们），再建/更新其余。
        const ordered = [
            ...selected.filter((item) => isApproachKind(item.kind)),
            ...selected.filter((item) => !isApproachKind(item.kind)),
        ];
        for (const item of ordered) {
            const rawParentId = this.#claimParentId(item, selected, step.id, runtime);
            const parentId = this.#topicAwareParent(item.kind, rawParentId, step.id, runtime, event.sessionId);
            const existingId = runtime.claimNodes.get(item.key);
            const cached = existingId === undefined ? undefined : this.store.state.nodes.get(existingId);
            const title = clampText(item.title || thoughtTitle(item.text, this.config.maxTitleChars), this.config.maxTitleChars);
            const summary = clampText(item.text, this.config.maxThoughtChars, { keepNewlines: true });
            const status = THOUGHT_STATUS[item.kind] ?? 'open';
            if (cached !== undefined) {
                const patch = {};
                if (cached.kind !== item.kind) patch.kind = item.kind;
                if (cached.title !== title) patch.title = title;
                if ((cached.summary ?? '') !== summary) patch.summary = summary;
                if (cached.status !== status) patch.status = status;
                if (cached.stepId === null || cached.stepId === undefined) patch.stepId = step.id;
                const hits = Math.max(cached.hits ?? 1, item.seen ?? 1);
                if (hits !== (cached.hits ?? 1)) patch.hits = hits;
                if (Object.keys(patch).length > 0) await this.#updateNode(cached.id, patch);
                if (cached.parentId !== parentId) {
                    await this.store.apply({ t: 'moveNode', id: cached.id, parentId });
                }
                continue;
            }
            const fingerprintValue = fingerprint('auto:thought', item.key);
            const adopted = findByFingerprint(this.store.state, fingerprintValue);
            if (adopted.length > 0) {
                runtime.claimNodes.set(item.key, adopted[0].id);
                continue;
            }
            if (runtime.autoCount >= this.config.maxAutoNodesPerTurn) {
                this.#warnOnce(runtime, 'limit', `第 ${runtime.turn} 轮自动节点超过上限 ${this.config.maxAutoNodesPerTurn}`);
                break;
            }
            runtime.autoCount += 1;
            const node = await this.#addOrHit({
                parentId,
                kind: item.kind,
                title,
                summary,
                status,
                origin: 'auto',
                sessionId: event.sessionId,
                turn: runtime.turn,
                stepId: step.id,
                fingerprint: fingerprintValue,
                tags: ['ranked', item.score >= 3 ? 'key' : 'thought'],
            });
            runtime.claimNodes.set(item.key, node.id);
            runtime.claimCreatedNodes.add(node.id);
            await this.#linkThreadEdges(event.sessionId, runtime.turn, node);
        }
        runtime.thoughtCount = runtime.claimNodes.size;
    }

    /**
     * 一个 claim 的父节点：
     * - approach：挂到「同轮更早、主题相近」的 approach 下（子假设/子方法），否则开新枝（step）；
     * - dependent：优先挂到同轮更早的相关 claim（证据链/推理链），否则挂最近的 approach，再否则 step。
     * 同轮嵌套用 intraTurnLinkThreshold（比跨轮的 threadLinkThreshold 宽松）。
     */
    #claimParentId(item, selected, stepId, runtime) {
        const threshold = this.config.intraTurnLinkThreshold;
        const nodeOf = (other) => {
            const nodeId = runtime.claimNodes.get(other.key);
            return nodeId === undefined ? undefined : this.store.state.nodes.get(nodeId);
        };
        let best = null;
        for (const other of selected) {
            if (other.order >= item.order) continue;
            const node = nodeOf(other);
            if (node === undefined || node.kind === 'note') continue;
            const approach = isApproachKind(other.kind);
            if (isApproachKind(item.kind) && !approach) continue;
            // 决策是并列行动，不把后一个决策挂到前一个决策下面（避免「为深而深」的假层级）。
            if (item.kind === 'decision' && other.kind === 'decision') continue;
            const score = similarity(item.text, `${node.title} ${node.summary ?? ''}`) + (approach ? 0.06 : 0);
            if (score < threshold) continue;
            const depth = this.#nodeDepth(node);
            if (best === null || score > best.score + 1e-9
                || (Math.abs(score - best.score) <= 0.03 && depth > best.depth)) {
                best = { node, score, depth };
            }
        }
        if (best !== null) return best.node.id;
        if (isApproachKind(item.kind)) return stepId;
        let latestApproach = null;
        for (const other of selected) {
            if (!isApproachKind(other.kind) || other.order >= item.order) continue;
            const node = nodeOf(other);
            if (node !== undefined) latestApproach = node.id;
        }
        return latestApproach ?? stepId;
    }

    #nodeDepth(node) {
        let depth = 0;
        let current = node;
        const seen = new Set();
        while (current !== undefined && current.parentId !== null && current.parentId !== undefined && depth < 100) {
            if (seen.has(current.id)) break;
            seen.add(current.id);
            current = this.store.state.nodes.get(current.parentId);
            depth += 1;
        }
        return depth;
    }

    /** 主题下仍处于 open/active 的叶根数（容量用水位线，避免把新想法继续塞进巨仓）。 */
    #openLeafRootCount(topicId) {
        return [...this.store.state.nodes.values()].filter((node) => node.parentId === topicId
            && isLeafRootKind(node.kind)
            && (node.status === 'open' || node.status === 'active')
            && !(Array.isArray(node.tags) && node.tags.includes('archived'))).length;
    }

    /** 本轮挂到哪个 topic：优先 activeTopicId；已关闭或叶根过多的主题不再接收新想法。 */
    #pickTurnTopic(sessionId, runtime) {
        const state = this.store.state;
        const goalId = this.#goalId(sessionId);
        if (goalId === null) return null;
        const maxOpen = Number.isFinite(this.config.maxOpenLeavesPerTopic)
            ? Math.max(1, Math.floor(this.config.maxOpenLeavesPerTopic))
            : 9;
        const isOpenTopic = (node) => node !== undefined
            && node.kind === 'topic'
            && node.parentId === goalId
            && node.status !== 'done'
            && node.status !== 'abandoned'
            && !(Array.isArray(node.tags) && node.tags.includes('archived'));
        if (runtime.activeTopicId !== null) {
            const active = state.nodes.get(runtime.activeTopicId);
            if (isOpenTopic(active) && this.#openLeafRootCount(active.id) < maxOpen) return active.id;
            runtime.activeTopicId = null;
        }
        const topics = [...state.nodes.values()].filter(isOpenTopic);
        if (topics.length === 0) return null;
        // 优先选未决叶根少的主题，避免所有新想法继续堆在最近更新的巨仓里。
        topics.sort((a, b) => this.#openLeafRootCount(a.id) - this.#openLeafRootCount(b.id)
            || (a.updatedAt < b.updatedAt ? 1 : -1));
        const chosen = topics[0];
        if (this.#openLeafRootCount(chosen.id) >= maxOpen) return null;
        runtime.activeTopicId = chosen.id;
        return chosen.id;
    }

    /** topic 下最近更新的、仍可承接细节的叶根（dependent claim 无处可挂时的兜底）。 */
    #latestTopicLeafRoot(topicId) {
        const leaves = [...this.store.state.nodes.values()]
            .filter((node) => node.parentId === topicId
                && isLeafRootKind(node.kind)
                && node.status !== 'done'
                && node.status !== 'abandoned'
                && !(Array.isArray(node.tags) && node.tags.includes('archived')));
        leaves.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        return leaves[0]?.id ?? null;
    }

    /**
     * 把「本应挂 step」的 claim 改挂到主干：
     * - approach / 结论 / 死路 → 直接作为 topic 的叶根；
     * - evidence 等依赖型 → 同轮最近一个挂在 topic 下的 approach，否则 topic 下最近的叶根；
     * 找不到 topic/叶根时保持原父节点（旧图仍可运行）。
     */
    #topicAwareParent(kind, parentId, stepId, runtime, sessionId) {
        if (parentId !== stepId) return parentId;
        const topicId = this.#pickTurnTopic(sessionId, runtime);
        if (topicId === null) return parentId;
        if (isApproachKind(kind) || kind === 'conclusion' || kind === 'dead_end') return topicId;
        for (const nodeId of [...runtime.claimNodes.values()].reverse()) {
            const node = this.store.state.nodes.get(nodeId);
            if (node !== undefined && node.parentId === topicId && isApproachKind(node.kind)) return node.id;
        }
        return this.#latestTopicLeafRoot(topicId) ?? parentId;
    }

    async #onAssistantMessage(event) {
        const runtime = this.#runtime(event.sessionId, event.turn ?? 0);
        runtime.lastAssistantText = clampText(event.text, 4000, { keepNewlines: true });
        if (event.final !== false && this.config.captureAnswerSections
            && runtime.thoughtCount === 0
            && runtime.lastAssistantText.length >= this.config.minAnswerChars) {
            await this.#recordAnswerSections(event, runtime);
        }
        if (event.final !== false && this.config.detectConclusions && runtime.sectionsCreated !== true
            && runtime.lastAssistantText !== '' && looksLikeConclusion(runtime.lastAssistantText)) {
            await this.#recordConclusion(event, runtime);
        }
        return null;
    }

    /**
     * 兜底结构化：没有推理节点时，用最终回答的 Markdown 标题（或独立加粗小标题）
     * 切出推导阶段，按出现顺序链成子树。只在前 10 段、每段有实际内容时落节点。
     */
    async #recordAnswerSections(event, runtime) {
        const sections = splitAnswerSections(runtime.lastAssistantText, {
            minSectionChars: this.config.minSectionChars,
            maxSections: this.config.maxAnswerSections,
            maxChars: this.config.maxSummaryChars,
        });
        if (sections.length < 2) return null;
        const stepId = await this.#connectStep(event, runtime);
        if (stepId === null) return null;
        let parentId = stepId;
        let majorId = null;
        let lastId = null;
        let created = 0;
        for (const section of sections) {
            if (created >= this.config.maxAnswerSections) break;
            if (runtime.autoCount >= this.config.maxAutoNodesPerTurn) {
                this.#warnOnce(runtime, 'limit', `第 ${runtime.turn} 轮自动节点超过上限 ${this.config.maxAutoNodesPerTurn}`);
                break;
            }
            const kind = section.conclusion ? 'conclusion' : classifySectionKind(section.title, section.body);
            runtime.autoCount += 1;
            // 标题是主要阶段（挂 step 下、彼此并列）；加粗小标题是当前阶段的子论点。
            let parentId = section.level > 0 ? stepId : (majorId ?? stepId);
            parentId = this.#topicAwareParent(kind, parentId, stepId, runtime, event.sessionId);
            const node = await this.#addOrHit({
                parentId,
                kind,
                title: clampText(section.title, this.config.maxTitleChars),
                summary: clampText(section.body, this.config.maxSummaryChars, { keepNewlines: true }),
                status: kind === 'hypothesis' ? 'open' : 'done',
                origin: 'auto',
                sessionId: event.sessionId,
                turn: runtime.turn,
                fingerprint: fingerprint('auto:section', `${event.sessionId}\u0000${runtime.turn}\u0000${normalizeKey(section.title)}`),
                tags: [section.conclusion ? 'key' : 'section'],
            });
            if (node === null) break;
            created += 1;
            lastId = node.id;
            if (section.level > 0) majorId = node.id;
            if (section.conclusion) runtime.sawConclusion = true;
        }
        if (created > 0) {
            runtime.sectionsCreated = true;
            runtime.sectionLastId = lastId;
            runtime.answerSectionCount = created;
        }
        return lastId;
    }

    /**
     * 返回动作应挂到的父节点。
     * - 正常：当前轮的 step（或会话焦点里的 step）。
     * - 没有 step（插件在轮次中途接入 / 宿主漏了 turn 开始事件）：补一个容器 step，
     *   有 goal 时挂 goal、没有 goal 时作根；避免动作全部扁平成根节点或直接挂到目标上。
     */
    /** 同一会话同一轮里最近的 step（runtime.stepId 丢失时兜底，避免重复补建 midway step）。 */
    #latestStepId(event, runtime) {
        return this.#findStepNode(event.sessionId, runtime.turn)?.id ?? null;
    }

    async #connectStep(event, runtime) {
        const known = runtime.stepId ?? this.#activeNodeId(event.sessionId);
        const knownNode = known !== null ? this.store.state.nodes.get(known) : undefined;
        // 只复用本轮的 step；runtime.stepId 可能还停在上一个 turn。
        if (knownNode?.kind === 'step' && (runtime.turn <= 0 || knownNode.turn === runtime.turn || knownNode.turn === null)) {
            return knownNode.id;
        }
        const existing = this.#findStepNode(event.sessionId, runtime.turn);
        if (existing !== undefined) {
            if (isMidwayFingerprint(existing.fingerprint, event.sessionId, runtime.turn)) {
                await this.#updateNode(existing.id, {
                    fingerprint: fingerprint('auto:step', `${event.sessionId}\u0000${runtime.turn}`),
                });
            }
            runtime.stepId = existing.id;
            await this.#setSession(event.sessionId, { activeNodeId: existing.id });
            return existing.id;
        }
        const goalId = this.#goalId(event.sessionId);
        const step = await this.#addOrHit({
            parentId: goalId,
            kind: 'step',
            title: clampText(runtime.turn > 0 ? `第 ${runtime.turn} 轮（缺少开始事件）` : '接入前的研究过程', this.config.maxTitleChars),
            summary: '插件在当前轮次中途接入或宿主没有发出轮次开始事件：此前的推理没有记录，后续动作暂时挂在这里。',
            status: 'active',
            origin: 'auto',
            sessionId: event.sessionId,
            turn: runtime.turn,
            fingerprint: fingerprint('auto:step:midway', `${event.sessionId}\u0000${runtime.turn}`),
        });
        if (step === null) return null;
        runtime.stepId = step.id;
        await this.#setSession(event.sessionId, { activeNodeId: step.id });
        return step.id;
    }

    async #onToolStart(event) {
        if (!this.config.captureToolCalls) return null;
        if (this.#isIgnoredTool(event.toolName)) return null;
        const mode = this.config.toolCallMode ?? 'aggregate';
        if (mode === 'off') return null;
        const runtime = this.#runtime(event.sessionId, event.turn ?? 0);
        const stepId = await this.#connectStep(event, runtime);
        if (stepId === null) return null;
        if (mode === 'nodes') return this.#recordToolNodeStart(event, runtime, stepId);
        return this.#recordToolAggregate(event, runtime, stepId, { phase: 'start' });
    }

    /** 旧行为：每次工具调用一个 action 节点（toolCallMode=nodes，调试用）。 */
    async #recordToolNodeStart(event, runtime, stepId) {
        const argsDigest = summarizeArgs(event.args);
        const state = this.store.state;
        const parent = stepId !== null ? state.nodes.get(stepId) : undefined;
        const parentId = parent?.id ?? this.#goalId(event.sessionId);
        const title = event.toolName !== undefined ? `${event.toolName}${argsDigest !== '' ? `: ${argsDigest}` : ''}` : '工具调用';
        const action = await this.#addBudgetedNode({
            parentId,
            kind: 'action',
            title: clampText(title, this.config.maxTitleChars),
            summary: argsDigest,
            status: 'active',
            origin: 'auto',
            sessionId: event.sessionId,
            turn: runtime.turn,
            refs: event.callId !== undefined ? [{ kind: 'tool_call', value: String(event.callId), label: event.toolName }] : [],
            fingerprint: fingerprint('auto:action', `${event.sessionId}\u0000${runtime.turn}\u0000${event.toolName ?? '?'}\u0000${normalizeKey(argsDigest)}`),
        }, runtime);
        if (action !== null && event.callId !== undefined) runtime.actionNodes.set(String(event.callId), action.id);
        if (action !== null) {
            runtime.activeActionId = action.id;
            await this.#setSession(event.sessionId, { activeNodeId: action.id });
        }
        return action;
    }

    async #onToolEnd(event) {
        if (!this.config.captureToolCalls) return null;
        if (this.#isIgnoredTool(event.toolName)) return null;
        const mode = this.config.toolCallMode ?? 'aggregate';
        if (mode === 'off') return null;
        const runtime = this.#runtime(event.sessionId, event.turn ?? 0);
        const stepId = await this.#connectStep(event, runtime);
        if (stepId === null) return null;
        const ok = event.ok !== false && (event.error === undefined || event.error === null);
        if (mode === 'nodes') return this.#recordToolNodeEnd(event, runtime, stepId, ok);
        return this.#recordToolAggregate(event, runtime, stepId, { phase: 'end', ok });
    }

    /** 旧行为：每次工具调用一个 action 节点（toolCallMode=nodes，调试用）。 */
    async #recordToolNodeEnd(event, runtime, stepId, ok) {
        let actionId = event.callId !== undefined ? runtime.actionNodes.get(String(event.callId)) : undefined;
        if (actionId === undefined) actionId = runtime.activeActionId;
        const state = this.store.state;
        let action = actionId !== undefined ? state.nodes.get(actionId) : undefined;
        if (action === undefined) {
            // 没看到 start（宿主事件缺失）：补一条短动作节点，保证图完整。
            action = await this.#addBudgetedNode({
                parentId: stepId ?? this.#goalId(event.sessionId),
                kind: 'action',
                title: clampText(`${event.toolName ?? '工具'}（补录）`, this.config.maxTitleChars),
                status: 'done',
                origin: 'auto',
                sessionId: event.sessionId,
                turn: runtime.turn,
                refs: event.callId !== undefined ? [{ kind: 'tool_call', value: String(event.callId), label: event.toolName }] : [],
            }, runtime);
            if (action === null) return null;
        }
        const summary = summarizeToolResult(event);
        await this.#updateNode(action.id, {
            status: ok ? 'done' : 'abandoned',
            summary: clampText(summary, this.config.maxSummaryChars, { keepNewlines: true }),
            refs: mergeRefs(action.refs, event),
        });
        if (!ok) {
            const errorText = clampText(event.error ?? '工具执行失败（无错误信息）', 500, { keepNewlines: true });
            await this.#addBudgetedNode({
                parentId: action.id,
                kind: 'dead_end',
                title: clampText(`失败：${event.toolName ?? '工具'}`, this.config.maxTitleChars),
                summary: errorText,
                status: 'abandoned',
                origin: 'auto',
                sessionId: event.sessionId,
                turn: runtime.turn,
                fingerprint: fingerprint('auto:deadend', `${event.sessionId}\u0000${runtime.turn}\u0000${normalizeKey(errorText)}`),
            }, runtime);
            await this.#setSession(event.sessionId, { activeNodeId: action.id });
        }
        if (ok && this.config.captureArtifacts) await this.#recordArtifacts(event, runtime, action.id);
        return action;
    }

    /** 汇总节点标题/摘要只在轮末定稿，轮内保持稳定，避免每次工具调用都重写同一节点。 */
    #toolAggregateText(counts) {
        const total = [...counts.values()].reduce((sum, item) => sum + item.count, 0);
        const names = [...counts.keys()];
        return {
            title: clampText(`工具调用 ×${total}（${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}）`, this.config.maxTitleChars),
            summary: clampText(
                [...counts.entries()].map(([tool, item]) => `${tool} ×${item.count}${item.failures > 0 ? `（失败 ${item.failures}）` : ''}`).join('\n'),
                this.config.maxSummaryChars,
                { keepNewlines: true },
            ),
        };
    }

    /** 默认行为：每轮一个汇总动作节点（工具调用 ×N），失败/产物仍单独留节点。 */
    async #recordToolAggregate(event, runtime, stepId, info) {
        const state = this.store.state;
        const counts = runtime.toolCounts ?? (runtime.toolCounts = new Map());
        const name = event.toolName ?? '工具';
        const entry = counts.get(name) ?? { count: 0, failures: 0 };
        if (info.phase === 'start') entry.count += 1;
        else if (entry.count === 0) entry.count = 1;
        if (info.phase === 'end' && info.ok === false) entry.failures += 1;
        counts.set(name, entry);
        let node = (runtime.aggActionId !== null && runtime.aggActionId !== undefined)
            ? state.nodes.get(runtime.aggActionId)
            : undefined;
        if (node === undefined) {
            // 轮内标题固定；计数与工具名在轮末一次性定稿（见 #onTurnEnd）。
            node = await this.#addBudgetedNode({
                parentId: stepId,
                kind: 'action',
                title: '工具调用（本轮）',
                summary: this.#toolAggregateText(counts).summary,
                status: 'active',
                origin: 'auto',
                sessionId: event.sessionId,
                turn: runtime.turn,
                fingerprint: fingerprint('auto:action:agg', `${event.sessionId}\u0000${runtime.turn}`),
            }, runtime);
            if (node === null) return null;
            runtime.aggActionId = node.id;
        }
        if (info.phase === 'end' && info.ok === false) {
            const errorText = clampText(event.error ?? '工具执行失败（无错误信息）', 500, { keepNewlines: true });
            await this.#addBudgetedNode({
                parentId: stepId,
                kind: 'dead_end',
                title: clampText(`失败：${event.toolName ?? '工具'}`, this.config.maxTitleChars),
                summary: errorText,
                status: 'abandoned',
                origin: 'auto',
                sessionId: event.sessionId,
                turn: runtime.turn,
                fingerprint: fingerprint('auto:deadend', `${event.sessionId}\u0000${runtime.turn}\u0000${normalizeKey(errorText)}`),
            }, runtime);
        }
        if (info.phase === 'end' && info.ok !== false && this.config.captureArtifacts) {
            await this.#recordArtifacts(event, runtime, stepId);
        }
        await this.#setSession(event.sessionId, { activeNodeId: stepId });
        return node;
    }

    /**
     * 宿主声明过的交付物（present 工具成功后发的 deliverables/presented）。
     * 这是 artifact 的唯一可信来源之一；另一个是写类工具参数里的真实文件。
     */
    async #onDeliverable(event) {
        if (!this.config.captureArtifacts) return null;
        const files = Array.isArray(event.files) ? event.files : [];
        if (files.length === 0) return null;
        const runtime = this.#runtime(event.sessionId, event.turn ?? 0);
        const stepId = await this.#connectStep(event, runtime);
        if (stepId === null) return null;
        for (const file of files.slice(0, 8)) {
            const value = typeof file === 'string' ? file : file?.value;
            if (typeof value !== 'string' || value.trim() === '') continue;
            const label = typeof file?.label === 'string' && file.label.trim() !== '' ? file.label.trim() : undefined;
            await this.#addBudgetedNode({
                parentId: stepId,
                kind: 'artifact',
                title: clampText(basename(value), this.config.maxTitleChars),
                summary: label !== undefined ? label : '',
                status: 'done',
                origin: 'auto',
                sessionId: event.sessionId,
                turn: runtime.turn,
                tags: ['deliverable'],
                refs: [{ kind: 'file', value: value.trim(), ...(label !== undefined ? { label } : {}) }],
                fingerprint: fingerprint('auto:artifact', `${event.sessionId}\u0000${normalizeKey(value)}`),
            }, runtime);
        }
        return stepId;
    }

    async #recordArtifacts(event, runtime, parentId) {
        const artifacts = Array.isArray(event.artifacts) ? event.artifacts : [];
        for (const artifact of artifacts.slice(0, 8)) {
            const value = typeof artifact === 'string' ? artifact : artifact?.value;
            if (typeof value !== 'string' || value.trim() === '') continue;
            const kind = artifact?.kind === 'url' ? 'url' : 'file';
            await this.#addBudgetedNode({
                parentId,
                kind: 'artifact',
                title: clampText(artifact?.label ?? basename(value), this.config.maxTitleChars),
                summary: '',
                status: 'done',
                origin: 'auto',
                sessionId: event.sessionId,
                turn: runtime.turn,
                refs: [{ kind, value }],
                fingerprint: fingerprint('auto:artifact', `${event.sessionId}\u0000${normalizeKey(value)}`),
            }, runtime);
        }
    }

    async #onTurnEnd(event) {
        const runtime = this.#runtime(event.sessionId, event.turn ?? 0);
        const state = this.store.state;
        let step = runtime.stepId !== null ? state.nodes.get(runtime.stepId) : undefined;
        // 轮末定稿：长轮次里被替换/折叠的节点在这里收敛。
        if (this.config.selectionStrategy !== 'chronological' && step !== undefined) {
            await this.#flushClaims(event, runtime, step);
            step = this.store.state.nodes.get(step.id) ?? step;
        }
        const aborted = event.aborted === true || (event.error !== undefined && event.error !== null);
        if (step !== undefined) {
            let summary = step.summary;
            if (typeof event.durationMs === 'number') summary = `${summary}${summary === '' ? '' : '\n'}轮次耗时：${Math.round(event.durationMs)}ms`;
            if (event.error !== undefined && event.error !== null) {
                summary = `${summary}${summary === '' ? '' : '\n'}错误：${clampText(event.error, 500)}`;
            }
            const foldedCount = (runtime.foldedNotes?.length ?? 0) + (runtime.narrationCount ?? 0) + (runtime.prunedNoteCount ?? 0);
            if (this.config.selectionStrategy !== 'chronological' && this.config.noteNodeMode === 'fold'
                && foldedCount > 0 && !summary.includes('过程观察 ×')) {
                summary = `${summary}${summary === '' ? '' : '\n'}过程观察 ×${foldedCount}（已折叠，未建节点）`;
            }
            if (this.config.selectionStrategy !== 'chronological' && !summary.includes('关键：')) {
                const digest = this.#turnDigest(runtime);
                if (digest !== '') summary = `${summary}${summary === '' ? '' : '\n'}${digest}`;
            }
            await this.#updateNode(step.id, {
                status: aborted ? 'abandoned' : 'done',
                summary: clampText(summary, this.config.maxSummaryChars * 2, { keepNewlines: true }),
            });
            if (runtime.aggActionId !== null && runtime.aggActionId !== undefined) {
                const agg = this.store.state.nodes.get(runtime.aggActionId);
                if (agg !== undefined) {
                    // 一轮只写一次：把轮内累计的工具计数一次性定稿到标题/摘要。
                    const counts = runtime.toolCounts ?? new Map();
                    const text = this.#toolAggregateText(counts);
                    await this.#updateNode(agg.id, {
                        status: aborted ? 'abandoned' : 'done',
                        title: text.title,
                        summary: text.summary,
                    });
                }
            }
            if (aborted && event.error !== undefined) {
                await this.#addBudgetedNode({
                    parentId: step.id,
                    kind: 'dead_end',
                    title: '轮次中断',
                    summary: clampText(event.error, 500),
                    status: 'abandoned',
                    origin: 'auto',
                    sessionId: event.sessionId,
                    turn: runtime.turn,
                    fingerprint: fingerprint('auto:deadend', `${event.sessionId}\u0000${normalizeKey(String(event.error))}`),
                }, runtime);
            }
        }
        const finalText = clampText(event.text ?? runtime.lastAssistantText ?? '', 4000, { keepNewlines: true });
        if (this.config.detectConclusions && finalText !== '' && looksLikeConclusion(finalText)) {
            await this.#recordConclusion(event, runtime);
        }
        if (this.config.newGoalOnTurnConclusion && runtime.sawConclusion === true) {
            await this.#setSession(event.sessionId, { goalId: null });
        }
        await this.#maybeSeedTopic(event, runtime, step ?? null);
        this.#scheduleTopicDigest(event, runtime);
        this.#scheduleLlmExtract(event, runtime, step ?? null);
        await this.#setSession(event.sessionId, {
            activeNodeId: step?.id ?? this.#goalId(event.sessionId),
            turn: runtime.turn,
        });
        return step;
    }

    /**
     * P2 自动种子：goal 下还没有 topic 时，单轮想法达到阈值后建一个候选主题；
     * 已有主题但全部满仓/关闭时，本轮即使只有一条想法也会另起候选主题。
     * 把本轮直接挂在 step 下的想法迁到 topic/叶根，并记 activeTopicId 供后续轮次挂载。
     */
    async #maybeSeedTopic(event, runtime, step) {
        if (!this.config.autoSeedTopic || this.backfilling || step === null || step === undefined) return null;
        const claimCount = runtime.claimNodes instanceof Map ? runtime.claimNodes.size : 0;
        const goalId = this.#goalId(event.sessionId);
        if (goalId === null) return null;
        const state = this.store.state;
        const maxOpen = Number.isFinite(this.config.maxOpenLeavesPerTopic)
            ? Math.max(1, Math.floor(this.config.maxOpenLeavesPerTopic))
            : 9;
        const topics = [...state.nodes.values()].filter((node) => node.kind === 'topic' && node.parentId === goalId);
        const hasCapacity = topics.some((topic) => topic.status !== 'done'
            && topic.status !== 'abandoned'
            && !(Array.isArray(topic.tags) && topic.tags.includes('archived'))
            && this.#openLeafRootCount(topic.id) < maxOpen);
        if (hasCapacity) return null;
        // 阈值只约束「还没有任何 topic」的首次建树；已有主题但全部满仓/关闭时，
        // 即使本轮只有 1 条想法也要另起候选主题，否则新问题会永久留在 step 下。
        if (topics.length === 0 && claimCount < this.config.topicSeedMinClaims) return null;
        const raw = String(step.title ?? '').replace(/^第\s*\d+\s*轮[：:]\s*/u, '').trim();
        const title = clampText(raw.length >= 4 ? raw : '本轮研究', 60);
        const topic = await this.#addNode({
            parentId: goalId,
            kind: 'topic',
            title,
            status: 'active',
            origin: 'auto',
            sessionId: event.sessionId,
            turn: runtime.turn,
            stepId: step.id,
            tags: ['candidate', 'auto-topic'],
        });
        const direct = [...runtime.claimNodes.values()]
            .map((id) => state.nodes.get(id))
            .filter((node) => node !== undefined && node.parentId === step.id);
        const roots = [];
        for (const node of direct) {
            if (isApproachKind(node.kind) || node.kind === 'conclusion' || node.kind === 'dead_end') {
                await this.store.apply({ t: 'moveNode', id: node.id, parentId: topic.id });
                roots.push(node.id);
            }
        }
        const fallback = roots[roots.length - 1] ?? null;
        if (fallback !== null) {
            for (const node of direct) {
                if (roots.includes(node.id)) continue;
                await this.store.apply({ t: 'moveNode', id: node.id, parentId: fallback });
            }
        }
        const topicNode = this.store.state.nodes.get(topic.id);
        if (topicNode !== undefined && typeof topicDigest === 'function') {
            const digest = topicDigest(this.store.state, topicNode);
            const basis = digestBasisOf(this.store.state, topicNode, digest);
            await this.store.apply({
                t: 'updateNode',
                id: topic.id,
                patch: { digest, digestSource: 'template', digestBasis: basis },
            });
        }
        runtime.activeTopicId = topic.id;
        return topic;
    }

    /**
     * 轮末异步 LLM 摘要：有 active topic 且 llm.digest=true 时，用子节点标题/摘要重写 digest。
     * 失败只记日志，模板摘要保留；人工摘要（human）不覆盖。
     */
    #scheduleTopicDigest(event, runtime) {
        const llm = this.config.llm;
        if (this.disposed || this.backfilling) return;
        if (this.digestWriter === null || llm?.enabled !== true || llm.digest !== true) return;
        const topicId = this.#pickTurnTopic(event.sessionId, runtime);
        if (topicId === null) return;
        const state = this.store.state;
        const topic = state.nodes.get(topicId);
        if (topic === undefined || topic.digestSource === 'human') return;
        const children = childrenOf(state, topic.id).slice(0, 20).map((node) => ({
            kind: node.kind,
            title: node.title,
            digest: node.digest ?? null,
        }));
        if (children.length === 0) return;
        const job = Promise.resolve()
            .then(() => this.digestWriter({
                sessionId: event.sessionId,
                turn: runtime.turn,
                topicId: topic.id,
                title: topic.title,
                children,
            }))
            .then(async (digest) => {
                const text = typeof digest === 'string' ? digest.trim() : '';
                if (text === '') return;
                const current = this.store.state.nodes.get(topicId);
                if (current === undefined || current.digestSource === 'human') return;
                const basis = digestBasisOf(this.store.state, current, text);
                await this.#updateNode(topicId, {
                    digest: clampText(text, 120),
                    digestSource: 'llm',
                    digestBasis: basis,
                });
            })
            .catch((error) => {
                this.logger.warn?.(`[explore-tree] LLM 摘要失败：${error instanceof Error ? error.message : String(error)}`);
            })
            .finally(() => {
                this.llmJobs.delete(job);
            });
        this.llmJobs.add(job);
    }

    /** 轮末收束摘要：关键（decision/hypothesis/question）与结果（conclusion/evidence/dead_end）。 */
    #turnDigest(runtime) {
        const state = this.store.state;
        const nodes = [...(runtime.claimNodes?.values?.() ?? [])]
            .map((id) => state.nodes.get(id))
            .filter((node) => node !== undefined);
        const key = nodes
            .filter((node) => node.kind === 'decision' || node.kind === 'hypothesis' || node.kind === 'question')
            .slice(0, 3);
        const result = nodes
            .filter((node) => node.kind === 'conclusion' || node.kind === 'evidence' || node.kind === 'dead_end')
            .slice(0, 3);
        const lines = [];
        if (key.length > 0) lines.push(`关键：${key.map((node) => node.title).join('；')}`);
        if (result.length > 0) lines.push(`结果：${result.map((node) => node.title).join('；')}`);
        return lines.join('\n');
    }

    /**
     * 轮末异步 LLM 旁路：把本轮推理交给宿主模型换回结构化 claim。
     * 不阻塞事件摄取；失败只记日志，确定性提取结果不受影响。
     */
    #scheduleLlmExtract(event, runtime, step) {
        const llm = this.config.llm;
        if (this.backfilling) return;
        if (this.llmExtract === null || llm?.enabled !== true) return;
        if (typeof llm.provider !== 'string' || llm.provider === '' || typeof llm.model !== 'string' || llm.model === '') return;
        if (step === null || step === undefined) return;
        const reasoning = String(runtime.turnReasoning ?? '');
        if (reasoning.length < 200) return;
        const claims = [...(runtime.claimNodes?.values?.() ?? [])]
            .map((id) => this.store.state.nodes.get(id))
            .filter((node) => node !== undefined)
            .map((node) => ({ id: node.id, kind: node.kind, title: node.title }));
        const payload = {
            sessionId: event.sessionId,
            turn: runtime.turn,
            stepId: step.id,
            intent: runtime.lastUserText,
            reasoning,
            claims,
        };
        const job = Promise.resolve()
            .then(() => this.llmExtract(payload))
            .then((result) => this.#applyLlmClaims(payload, result))
            .catch((error) => {
                this.logger.warn?.(`[explore-tree] LLM 辅助提取失败：${error instanceof Error ? error.message : String(error)}`);
            })
            .finally(() => {
                this.llmJobs.delete(job);
            });
        this.llmJobs.add(job);
    }

    /** 落库 LLM 产出的 claim：kind/parent 白名单校验 + 指纹去重 + 跨轮关系。 */
    async #applyLlmClaims(payload, claims) {
        if (!Array.isArray(claims) || claims.length === 0 || this.disposed) return;
        const state = this.store.state;
        const step = state.nodes.get(payload.stepId);
        if (step === undefined) return;
        const turnParentIds = new Set([payload.stepId]);
        for (const node of state.nodes.values()) {
            if (node.sessionId !== payload.sessionId || node.turn !== payload.turn) continue;
            if (THOUGHT_STATUS[node.kind] === undefined) continue;
            turnParentIds.add(node.id);
        }
        const maxClaims = this.config.llm?.maxClaims ?? 6;
        const runtime = this.#runtime(payload.sessionId, payload.turn);
        for (const claim of claims.slice(0, maxClaims)) {
            if (claim === null || typeof claim !== 'object') continue;
            if (THOUGHT_STATUS[claim.kind] === undefined) continue;
            const title = typeof claim.title === 'string' ? claim.title.trim() : '';
            if (title === '') continue;
            const rawParentId = typeof claim.parentId === 'string' && turnParentIds.has(claim.parentId)
                ? claim.parentId
                : payload.stepId;
            const parentId = this.#topicAwareParent(claim.kind, rawParentId, payload.stepId, runtime, payload.sessionId);
            const node = await this.#addOrHit({
                parentId,
                kind: claim.kind,
                title: clampText(title, this.config.maxTitleChars),
                summary: clampText(typeof claim.summary === 'string' ? claim.summary : '', this.config.maxSummaryChars),
                status: THOUGHT_STATUS[claim.kind],
                tags: ['llm', claim.kind],
                origin: 'auto',
                sessionId: payload.sessionId,
                turn: payload.turn,
                stepId: payload.stepId,
                refs: [{ kind: 'llm', value: `${this.config.llm?.provider ?? ''}/${this.config.llm?.model ?? ''}` }],
                fingerprint: fingerprint('auto:llm', `${payload.sessionId}\u0000${normalizeKey(title)}`),
            });
            if (node !== null && node !== undefined) await this.#linkThreadEdges(payload.sessionId, payload.turn, node);
        }
    }

    async #onSessionEnd(event) {
        await this.#setSession(event.sessionId, { activeNodeId: null });
        this.runtime.delete(event.sessionId);
        return null;
    }

    // ─────────────────────────── 结论 ───────────────────────────

    async #recordConclusion(event, runtime) {
        if (runtime.sectionsCreated === true) return null;
        const text = clampText(event.text ?? runtime.lastAssistantText ?? '', 3000, { keepNewlines: true });
        if (text === '') return null;
        const stepId = runtime.stepId ?? this.#activeNodeId(event.sessionId);
        const state = this.store.state;
        const step = stepId !== null ? state.nodes.get(stepId) : undefined;
        if (step === undefined) return null;
        const title = conclusionTitle(text);
        const conclusion = await this.#addOrHit({
            parentId: this.#topicAwareParent('conclusion', step.id, step.id, runtime, event.sessionId),
            kind: 'conclusion',
            title: clampText(title, this.config.maxTitleChars),
            summary: text,
            status: 'done',
            origin: 'auto',
            sessionId: event.sessionId,
            turn: runtime.turn,
            fingerprint: fingerprint('auto:conclusion', `${event.sessionId}\u0000${normalizeKey(title)}`),
        });
        if (conclusion !== null) {
            runtime.sawConclusion = true;
            await this.#setSession(event.sessionId, { activeNodeId: conclusion.id });
        }
        return conclusion;
    }

    // ─────────────────────────── 工具集 ───────────────────────────

    #ensureSession(event) {
        const now = this.now();
        const sessionId = typeof event.sessionId === 'string' && event.sessionId !== '' ? event.sessionId : 'anonymous';
        return sessionOf(this.store.state, sessionId, now);
    }

    #runtime(sessionId, turn) {
        const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'anonymous';
        let runtime = this.runtime.get(key);
        if (runtime === undefined) {
            runtime = {
                turn: Number.isInteger(turn) ? turn : 0,
                startedTurn: null,
                stepId: null,
                lastUserText: '',
                lastInjectionText: '',
                pendingUserIntents: [],
                lastAssistantText: '',
                actionNodes: new Map(),
                activeActionId: null,
                aggActionId: null,
                toolCounts: new Map(),
                autoCount: 0,
                sawConclusion: false,
                reasoningChars: 0,
                turnReasoning: '',
                thoughtCount: 0,
                thoughtParentId: null,
                thoughtSkipped: 0,
                claims: new Map(),
                claimNodes: new Map(),
                claimCreatedNodes: new Set(),
                claimSeq: 0,
                foldedNotes: [],
                narrationCount: 0,
                sectionsCreated: false,
                sectionLastId: null,
                answerSectionCount: 0,
                activeTopicId: null,
                warned: new Set(),
            };
            this.runtime.set(key, runtime);
        }
        if (Number.isInteger(turn) && turn > runtime.turn) runtime.turn = turn;
        return runtime;
    }

    #isIgnoredTool(toolName) {
        return typeof toolName === 'string' && this.config.ignoreTools.includes(toolName);
    }

    /** 同一轮同一类超限提示只打一次日志（想法节点与工具节点共用轮次预算）。 */
    #warnOnce(runtime, key, message) {
        if (runtime.warned === undefined) runtime.warned = new Set();
        if (runtime.warned.has(key)) return;
        runtime.warned.add(key);
        this.logger.warn?.(`[explore-tree] ${message}，后续同类事件只保留轮次摘要。`);
    }

    #goalId(sessionId) {
        const session = this.store.state.sessions.get(sessionId);
        return session?.goalId ?? null;
    }

    #activeNodeId(sessionId) {
        const session = this.store.state.sessions.get(sessionId);
        return session?.activeNodeId ?? null;
    }

    async #addNode(input) {
        const op = await this.store.apply({ t: 'addNode', actor: this.actor, node: input });
        return op.node;
    }

    /**
     * 指纹去重的新增：命中已有节点时只增加 hits 并补摘要。
     */
    async #addOrHit(input) {
        const state = this.store.state;
        if (typeof input.fingerprint === 'string' && input.fingerprint !== '') {
            const existing = findByFingerprint(state, input.fingerprint);
            if (existing.length > 0) {
                const node = existing[0];
                const patch = { hits: node.hits + 1 };
                if ((node.summary ?? '') === '' && (input.summary ?? '') !== '') patch.summary = input.summary;
                await this.#updateNode(node.id, patch);
                return node;
            }
        }
        return this.#addNode(input);
    }

    /**
     * 预算内的自动节点写入（工具聚合动作、失败 dead_end、artifact、轮末中断等）。
     * 与 #addOrHit 的差别只有两点：
     *  - 指纹命中只累加 hits，不重复占用轮次预算；
     *  - 新建前检查 maxAutoNodesPerTurn，预算耗尽时用 #warnOnce 记一次日志并跳过（返回 null）。
     * step/goal/topic 等结构节点仍走 #addNode，不占预算。
     */
    async #addBudgetedNode(input, runtime) {
        const state = this.store.state;
        if (typeof input.fingerprint === 'string' && input.fingerprint !== '') {
            const existing = findByFingerprint(state, input.fingerprint);
            if (existing.length > 0) {
                const node = existing[0];
                const patch = { hits: node.hits + 1 };
                if ((node.summary ?? '') === '' && (input.summary ?? '') !== '') patch.summary = input.summary;
                await this.#updateNode(node.id, patch);
                return node;
            }
        }
        if (runtime.autoCount >= this.config.maxAutoNodesPerTurn) {
            this.#warnOnce(runtime, 'limit', `第 ${runtime.turn} 轮自动节点超过上限 ${this.config.maxAutoNodesPerTurn}`);
            return null;
        }
        runtime.autoCount += 1;
        return this.#addNode(input);
    }

    async #updateNode(id, patch) {
        const state = this.store.state;
        if (!state.nodes.has(id)) return null;
        const op = await this.store.apply({ t: 'updateNode', id, patch, actor: this.actor });
        return op;
    }

    async #setSession(sessionId, patch) {
        return this.store.apply({ t: 'session', sessionId, ...patch });
    }
}

// ─────────────────────────── 纯函数规则 ───────────────────────────

/** 文本是否像结论/收敛段落。 */
export function looksLikeConclusion(text) {
    if (typeof text !== 'string' || text.trim().length < 24) return false;
    return CONCLUSION_PATTERN.test(text);
}

/** 从用户文本抽出标题（首个非空行/首句，去 markdown 标记）。 */
export function titleFromText(text, max = 120) {
    const source = String(text).replace(/```[\s\S]*?```/g, ' ');
    const firstLine = source.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? source;
    const cleaned = firstLine
        .replace(/[#>*_`]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (cleaned === '') return '未命名研究';
    const firstSentence = cleaned.split(/(?<=[。！？.!?])\s*/)[0] ?? cleaned;
    return firstSentence.length > max ? `${firstSentence.slice(0, Math.max(0, max - 1))}…` : firstSentence;
}

/** 结论标题：取首句并去掉「结论：」前缀。 */
export function conclusionTitle(text) {
    const cleaned = String(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[#>*_`]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const stripped = cleaned.replace(/^(结论|小结|总结|综上|因此|所以|最终答案|答案)[:：\s]*/u, '');
    const firstSentence = stripped.split(/(?<=[。！？.!?])\s*/)[0] ?? stripped;
    const title = firstSentence.trim().replace(/[。！？.!?]+$/u, '').trim() === ''
        ? '结论'
        : firstSentence.trim().replace(/[。！？.!?]+$/u, '').trim();
    return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

// ─────────────────────────── 推理链 → 想法 ───────────────────────────

const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;
const BULLET_PATTERN = /^(?:[-*•·]\s+|\d{1,3}[.)、]\s*|\(\d{1,3}\)\s*)/u;
const SENTENCE_SPLIT = /(?<=[。！？!?；;])\s*/u;

/**
 * 想法类型规则：只看句式线索，不评价对错。命中不了就是 note。
 * 顺序有意义：疑问 > 撞墙 > 假设 > 依据 > 取舍 > 收敛。
 */
const THOUGHT_RULES = Object.freeze([
    ['question', /(?:[?？]\s*$)|(?:是否|为什么|为何|如何|怎么|怎么办|哪(?:个|些|里|种)|能否|是不是|有没有|需要(?:确认|验证|检查|弄清))|\b(?:what|why|how|whether|which|can we|is it|does it|do we)\b/i],
    ['hypothesis', /(?:假设|假定|推测|猜测|怀疑|猜想|可能(?:是|会|由|因为)|也许|或许|似乎|看起来|我认为|我猜|大概率)|\b(?:assume|suppose|hypothes|conjecture|suspect|might be|probably|likely|guess)\b/i],
    ['dead_end', /(?:行不通|走不通|不可行|失败了|失败|报错|无法(?:访问|完成|运行|打开)|放弃(?:这个|该)?|死路)|\b(?:failed|failing|doesn't work|won't work|not possible|impossible|dead end)\b/i],
    ['evidence', /(?:因为|由于|根据|依据|说明|表明|显示|观察到|数据显示|测试结果|实测|从.{0,20}(?:看|判断))|\b(?:because|since|given|observe|note that|it follows|shows? that|case \d|cases?\b|when .*,)\b/i],
    ['decision', /(?:决定|选择|采用|改为|改成|优先|下一步|接下来|计划|需要先|必须先|先.{0,12}再|应该|应当|必须)|\b(?:let's|we should|we will|choose|decide|approach|plan|next step|instead)\b/i],
    ['conclusion', /(?:结论|综上|综上所述|因此|所以|最终|总的来说|总结)|\b(?:therefore|thus|hence|conclusion|in summary|overall|final answer)\b/i],
]);

const NOISE_PATTERNS = [
    /\b(?:let me|let's|i'?ll|i will|i need to|i should|i'?m going to|i am going to|next i|then i)\b/i,
    /(?:remaining tasks?|next steps?|todo list|to-do|i'?m in the middle|in the middle of|剩余任务|待办事项|下一步(?:做|要|任务|计划)?)/i,
    /\b(?:npm test|node --check|git (?:commit|status|log|diff|add)|pnpm|package\.json|changelog|scripts\/)/i,
];

/** 技术/数学信号：出现即说明这段推理在讲可复用的机制或推导。 */
const TECH_PATTERN = /\b(?:matrix|matrices|invertib|determinant|eigen|formula|equation|theorem|lemma|proof|derivative|integral|probability|algorithm|complexity|cache|schema|api|module|plugin|node|tree|graph|protocol|token|compression|parse|regex)\b|\\[a-zA-Z]+|\\begin\{|\$[^$]{2,}\$/i;

/** 推理连接词：说明前后句之间有论证关系，而不是流水账。 */
const CONNECTIVE_PATTERN = /\b(?:because|since|so that|therefore|thus|hence|if .* then|implies|means that|we get|yields|gives|note that|observe|assume|suppose)\b/i;

/** 分支/情形展开：结构化的探索，通常值得保留。 */
const CASE_PATTERN = /\bcase\s*\d|\bcases?\b|情形|情况|分支/i;

/**
 * 思考片段的信息量分数：越高越值得建节点。
 *
 * 规则只看「有没有可复用的信息」（决定/假设/证据/失败/结论/机制/数字/分支），
 * 不判断对错；只有「接下来我要…」这类过程旁白才降到负分。
 *
 * @param {string} text
 * @param {string} [kind] classifyThought 的结果
 * @returns {number} -10..10
 */
export function scoreThought(text, kind = 'note') {
    const value = String(text ?? '').trim();
    if (value.length < 8) return -10;
    let score = 1;
    let noise = 0;
    for (const pattern of NOISE_PATTERNS) if (pattern.test(value)) noise -= 4;
    if (/^(?:run|test|check|verify|commit|bump|update|add|fix|write|read|open|close|remove|rename|ensure|make sure|use)\s+[a-z0-9_./\\-]+/i.test(value)) noise -= 3;
    score += Math.max(-6, noise);
    if (TECH_PATTERN.test(value)) score += 2;
    if (CASE_PATTERN.test(value)) score += 2;
    if (CONNECTIVE_PATTERN.test(value) && value.length > 40) score += 1;
    if (/["“「]|用户说|user says|user feedback|m0\d{5}/i.test(value)) score += 3;
    if (/(决定|选择|改为|采用|优先|方案|策略|换成|改用|approach|decide|choose|instead|will use|strategy|plan)/i.test(value)) score += 3;
    if (/(失败|报错|错误|不行|走不通|放弃|不可行|failed|fails?|error|broken|doesn't work|won't work|cannot|dead end)/i.test(value)) score += 3;
    if (/(结论|因此|所以|综上|总之|最终|说明|conclusion|therefore|overall|which means)/i.test(value)) score += 2;
    if (/(因为|由于|根据|数据|结果|表明|显示|证明|日志|because|since|evidence|shows?|result|log|output|indicates)/i.test(value)) score += 2;
    if (value.length > 30 && /[0-9]+(?:\.[0-9]+)?%|[0-9]{2,}|[A-Za-z]:\\|\/[\w.-]+\/|\.(?:js|ts|json|md|yaml|yml)\b/.test(value)) score += 2;
    if (kind === 'dead_end' || kind === 'conclusion' || kind === 'decision') score += 2;
    if (kind === 'hypothesis') score += 2;
    if (kind === 'question' && value.length > 24) score += 1;
    return Math.max(-10, Math.min(10, score));
}

/** 判断一条想法的信息类型（不判断真伪）。 */
export function classifyThought(text) {
    if (typeof text !== 'string' || text.trim() === '') return 'note';
    for (const [kind, pattern] of THOUGHT_RULES) {
        if (pattern.test(text)) return kind;
    }
    return 'note';
}

/** 把常见 LaTeX 命令压成可读文本（标题用；正文保留原样）。 */
function stripLatex(text) {
    return String(text)
        .replace(/\\begin\{[^}]+\}|\\end\{[^}]+\}/gu, ' ')
        .replace(/\\(?:mathbf|mathsf|operatorname|text|mathrm|mathcal)\{([^}]*)\}/gu, '$1')
        .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/gu, '($1)/($2)')
        .replace(/\\sqrt\{([^}]*)\}/gu, '√($1)')
        .replace(/\\(?:neq|ne)\b/gu, '≠')
        .replace(/\\le\b/gu, '≤')
        .replace(/\\ge\b/gu, '≥')
        .replace(/\\times\b/gu, '×')
        .replace(/\\cdot\b/gu, '·')
        .replace(/\\dots\b/gu, '…')
        .replace(/\\sum\b/gu, '∑')
        .replace(/\\infty\b/gu, '∞')
        .replace(/\\alpha\b/gu, 'α')
        .replace(/\\beta\b/gu, 'β')
        .replace(/\\gamma\b/gu, 'γ')
        .replace(/\\delta\b/gu, 'δ')
        .replace(/\\lambda\b/gu, 'λ')
        .replace(/\\mu\b/gu, 'μ')
        .replace(/\\pi\b/gu, 'π')
        .replace(/\\[a-zA-Z]+/gu, ' ')
        .replace(/\\\\/gu, ' ')
        .replace(/\s*&\s*/gu, ' ')
        .replace(/[{}$_]/gu, ' ')
        .replace(/\^\s+/gu, '^')
        .replace(/\s+/gu, ' ')
        .trim();
}

/** 想法节点标题：首个句子，去掉列表符号、markdown、口癖与常见 LaTeX 标记。 */
export function thoughtTitle(text, max = 120) {
    const cleaned = stripLatex(
        String(text)
            .replace(CODE_FENCE_PATTERN, ' ')
            .replace(BULLET_PATTERN, '')
            .replace(/[#>*_`]+/gu, ' ')
            .replace(/\s+/gu, ' '),
    );
    if (cleaned === '') return '想法';
    const first = (cleaned.split(SENTENCE_SPLIT)[0] ?? cleaned)
        .replace(/^(?:(?:hmm+|ok(?:ay)?|actually|well|so|now|thus|therefore|wait|let me|let's)\b[,，:：\s-]*)+/iu, '')
        .trim();
    const title = first.replace(/^[，,、;；:：\s]+|[，,、;；:：\s]+$/gu, '') || '想法';
    return title.length > max ? `${title.slice(0, Math.max(0, max - 1))}…` : title;
}

const DISPLAY_MATH_PATTERN = /(?:\$\$[\s\S]*?\$\$)|(?:\\\[[\s\S]*?\\\])|(?:\\begin\{(?:bmatrix|pmatrix|matrix|aligned|cases|array)\})/u;
const CONTINUATION_PREFIX = /^(?:and|or|but|so|then|thus|hence|where|which|that|this|with|for|from|as|is|are|was|were|if|when|while)\b|^[a-z]/u;
const CONTINUATION_SUFFIX = /[=+\\,，(（\[]\s*$/u;

/**
 * 超长推理的读取策略：头 + 尾（开头通常是任务与问题，末尾是结论），中间省略。
 * 纯本地字符串操作，不起模型调用。
 */
export function thoughtSource(text, maxChars = 60000) {
    const source = String(text ?? '');
    if (source.length <= maxChars) return source;
    const head = Math.floor(maxChars * 0.6);
    const tail = Math.max(0, maxChars - head - 24);
    return `${source.slice(0, head)}\n\n…（中间推理省略）…\n\n${source.slice(source.length - tail)}`;
}

/**
 * 把一段推理切成 1..maxUnits 条自包含想法。
 *
 * 与旧版相比：按「段落/显示公式」为单位，识别续行并把碎片并回上一段，
 * 再按信息量打分筛选（默认阈值 1），只保留有内容的单元——不判断对错。
 *
 * @param {string} text
 * @param {{minChars?: number, maxChars?: number, maxUnits?: number, minScore?: number, fallback?: boolean}} [options]
 * @returns {string[]}
 */
export function splitThoughts(text, options = {}) {
    const minChars = Number.isInteger(options.minChars) && options.minChars > 0 ? options.minChars : 12;
    const maxChars = Number.isInteger(options.maxChars) && options.maxChars > minChars ? options.maxChars : 400;
    const maxUnits = Number.isInteger(options.maxUnits) && options.maxUnits > 0 ? options.maxUnits : 12;
    const minScore = Number.isInteger(options.minScore) ? options.minScore : 1;
    const fallback = options.fallback !== false;
    if (typeof text !== 'string' || text.trim() === '') return [];

    const cleaned = text.replace(CODE_FENCE_PATTERN, '\n').replace(/\r\n?/gu, '\n');
    const blocks = cleaned.split(/\n\s*\n+/u);

    // 第一遍：先按行内列表项拆开（每个 bullet 是一个独立想法），
    // 再把「续行/公式碎片/短块」并回上一段，避免把公式拆成孤立的 is/are。
    const candidates = [];
    const appendBlock = (raw) => {
        const normalized = String(raw)
            .replace(BULLET_PATTERN, '')
            .replace(/^[#>\s]+/u, '')
            .replace(/\s+/gu, ' ')
            .trim();
        if (normalized === '') return;
        const previous = candidates.length > 0 ? candidates[candidates.length - 1] : null;
        const shouldMerge = previous !== null
            && (normalized.length < minChars
                || CONTINUATION_PREFIX.test(normalized)
                || CONTINUATION_SUFFIX.test(previous)
                || (/^[$\\]/u.test(normalized) && !DISPLAY_MATH_PATTERN.test(normalized)));
        if (shouldMerge) {
            candidates[candidates.length - 1] = `${previous} ${normalized}`.trim();
        } else {
            candidates.push(normalized);
        }
    };

    for (const raw of blocks) {
        let chunk = '';
        for (const line of String(raw).split('\n').map((item) => item.trim()).filter((item) => item !== '')) {
            if (BULLET_PATTERN.test(line)) {
                if (chunk !== '') appendBlock(chunk);
                chunk = line;
            } else {
                chunk = chunk === '' ? line : `${chunk} ${line}`;
            }
        }
        if (chunk !== '') appendBlock(chunk);
    }

    // 第二遍：把长段落按句子切成不超过 maxChars 的单元；显示公式保持整块。
    const pieces = [];
    for (const candidate of candidates) {
        if (DISPLAY_MATH_PATTERN.test(candidate) && !CONTINUATION_SUFFIX.test(candidate)) {
            pieces.push(candidate.length > maxChars * 4 ? candidate.slice(0, maxChars * 4) : candidate);
            continue;
        }
        for (const piece of splitByLength(candidate, maxChars)) {
            if (piece.length >= minChars) pieces.push(piece);
        }
    }

    // 第三遍：信息量过滤（同一单元只算一次分数），低分单元不建节点。
    const scored = pieces.map((value, index) => {
        const kind = classifyThought(value);
        return { value, index, kind, score: scoreThought(value, kind) };
    });
    let kept = scored.filter((item) => item.score >= minScore);
    if (kept.length === 0 && fallback) {
        kept = scored
            .filter((item) => item.score > -3 && item.value.length >= Math.max(24, minChars))
            .sort((a, b) => b.score - a.score)
            .slice(0, 2)
            .sort((a, b) => a.index - b.index);
    }
    if (kept.length > maxUnits) {
        kept = kept
            .slice()
            .sort((a, b) => (b.score - a.score) || (a.index - b.index))
            .slice(0, maxUnits)
            .sort((a, b) => a.index - b.index);
    }
    return kept.map((item) => item.value);
}

const SECTION_CONCLUSION_PATTERN = /^(?:结论|总结|小结|答案|综上|最终)/u;
const SECTION_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;
const SECTION_BOLD_PATTERN = /^\*\*([^*\n]{2,60}?)[.。:：]?\*\*[ \t]*(.*)$/u;

/**
 * 把长回答按 Markdown 标题（`## 情形一`）或独立加粗小标题（`**记号.**`）切成推导阶段。
 * 标题是观测点，会被清理成一句可读标题；切不出至少两段时返回空数组（交给结论兜底）。
 */
export function splitAnswerSections(text, options = {}) {
    const minSectionChars = Number.isInteger(options.minSectionChars) ? options.minSectionChars : 16;
    const maxSections = Number.isInteger(options.maxSections) ? options.maxSections : 10;
    const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : 1200;
    const source = String(text ?? '').replace(/\r\n?/gu, '\n').trim();
    if (source === '') return [];
    const lines = source.split('\n');
    const markers = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        const heading = SECTION_HEADING_PATTERN.exec(line);
        if (heading !== null) {
            const title = cleanSectionTitle(heading[2]);
            if (title !== '') markers.push({ index, title, inline: '', level: heading[1].length });
            continue;
        }
        const bold = SECTION_BOLD_PATTERN.exec(line);
        if (bold !== null) {
            const title = cleanSectionTitle(bold[1]);
            if (title !== '') markers.push({ index, title, inline: String(bold[2] ?? '').trim(), level: 0 });
        }
    }
    if (markers.length === 0) return [];
    const sections = [];
    if (markers[0].index > 0) {
        const preamble = lines.slice(0, markers[0].index).join('\n').trim();
        if (preamble.length >= minSectionChars) sections.push({ title: '前言', body: preamble, conclusion: false, level: 1 });
    }
    for (let index = 0; index < markers.length; index += 1) {
        const start = markers[index].index + 1;
        const end = index + 1 < markers.length ? markers[index + 1].index : lines.length;
        const tail = lines.slice(start, end).join('\n').replace(/^\s*---+\s*$/gmu, '').trim();
        const body = [markers[index].inline ?? '', tail].filter((piece) => piece !== '').join('\n').trim();
        const conclusion = SECTION_CONCLUSION_PATTERN.test(markers[index].title);
        if (body.length < minSectionChars && !conclusion) continue;
        sections.push({ title: markers[index].title, body, conclusion, level: markers[index].level ?? 0 });
        if (sections.length >= maxSections) break;
    }
    return sections.map((section) => ({
        ...section,
        body: section.body.length > maxChars ? `${section.body.slice(0, maxChars - 1)}…` : section.body,
    }));
}

/** 回答分段的节点类型：只表达「这一段在论证什么」，不预判正误。 */
export function classifySectionKind(title, body = '') {
    const key = `${title ?? ''} ${String(body ?? '').slice(0, 80)}`;
    if (SECTION_CONCLUSION_PATTERN.test(String(title ?? ''))) return 'conclusion';
    if (/假设|猜测|推测|猜想|可能性/u.test(key)) return 'hypothesis';
    if (/失败|错误|反例|行不通|不可行|阻塞/u.test(key)) return 'dead_end';
    if (/证据|数据|结果|实验|验证|情形|案例|反证/u.test(key)) return 'evidence';
    if (/决定|方案|选择|计划|步骤|方法/u.test(key)) return 'decision';
    return 'note';
}

function cleanSectionTitle(value) {
    const text = String(value ?? '')
        .replace(/\\mathbf\{([^{}]*)\}/gu, '$1')
        .replace(/\\mathsf\{([^{}]*)\}/gu, '$1')
        .replace(/\\operatorname\{([^{}]*)\}/gu, '$1')
        .replace(/\\text\{([^{}]*)\}/gu, '$1')
        .replace(/\\(?:neq|ne)(?![a-zA-Z])/gu, '≠')
        .replace(/\\(?:dots|ldots|cdots)(?![a-zA-Z])/gu, '…')
        .replace(/\\times(?![a-zA-Z])/gu, '×')
        .replace(/\\sum(?![a-zA-Z])/gu, '∑')
        .replace(/\\beta(?![a-zA-Z])/gu, 'β')
        .replace(/\\alpha(?![a-zA-Z])/gu, 'α')
        .replace(/\\gamma(?![a-zA-Z])/gu, 'γ')
        .replace(/\\delta(?![a-zA-Z])/gu, 'δ')
        .replace(/\\theta(?![a-zA-Z])/gu, 'θ')
        .replace(/\\lambda(?![a-zA-Z])/gu, 'λ')
        .replace(/\\mu(?![a-zA-Z])/gu, 'μ')
        .replace(/\\sigma(?![a-zA-Z])/gu, 'σ')
        .replace(/\\phi(?![a-zA-Z])/gu, 'φ')
        .replace(/\\psi(?![a-zA-Z])/gu, 'ψ')
        .replace(/\\rho(?![a-zA-Z])/gu, 'ρ')
        .replace(/\\[a-zA-Z]+\s*/gu, ' ')
        .replace(/[{}]/gu, '')
        .replace(/[`*_~$]/gu, '')
        .replace(/\s+/gu, ' ')
        .replace(/^[.:：、，,;；\s]+|[.:：、，,;；\s]+$/gu, '')
        .trim();
    if (text === '') return '';
    return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

/** 长段落按句子聚合到 maxChars；单句仍超长时按长度硬切（最多 8 片）。 */
function splitByLength(value, maxChars) {    if (value.length <= maxChars) return [value];
    const sentences = value.split(SENTENCE_SPLIT).map((item) => item.trim()).filter((item) => item !== '');
    if (sentences.length <= 1) {
        const out = [];
        for (let index = 0; index < value.length && out.length < 8; index += maxChars) {
            out.push(value.slice(index, index + maxChars));
        }
        return out;
    }
    const out = [];
    let buffer = '';
    for (const sentence of sentences) {
        if (buffer === '') {
            buffer = sentence;
        } else if ((buffer + ' ' + sentence).length <= maxChars) {
            buffer = `${buffer} ${sentence}`;
        } else {
            out.push(buffer);
            buffer = sentence;
        }
        if (buffer.length > maxChars) {
            out.push(buffer.slice(0, maxChars));
            buffer = buffer.slice(maxChars);
        }
    }
    if (buffer !== '') out.push(buffer);
    return out;
}

/** 工具参数摘要（单行、截断、去掉噪音键）。 */
export function summarizeArgs(args) {
    if (args === null || args === undefined) return '';
    let text;
    if (typeof args === 'string') text = args;
    else {
        try {
            text = JSON.stringify(args, (key, value) => {
                if (key === 'timeoutMs' || key === 'signal') return undefined;
                if (typeof value === 'string' && value.length > 240) return `${value.slice(0, 239)}…`;
                return value;
            });
        } catch {
            text = String(args);
        }
    }
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > 400 ? `${compact.slice(0, 399)}…` : compact;
}

/** 工具结果摘要（优先取文本输出，其次取错误）。 */
export function summarizeToolResult(event) {
    if (event.error !== undefined && event.error !== null) {
        return clampText(`失败：${typeof event.error === 'string' ? event.error : JSON.stringify(event.error)}`, 1200, { keepNewlines: true });
    }
    const result = event.result;
    if (result === null || result === undefined) return '完成';
    if (typeof result === 'string') return clampText(result, 1200, { keepNewlines: true });
    try {
        return clampText(JSON.stringify(result), 1200, { keepNewlines: true });
    } catch {
        return '完成';
    }
}

function mergeRefs(refs, event) {
    const out = [...(refs ?? [])];
    if (Array.isArray(event.refs)) {
        for (const ref of event.refs) {
            if (ref !== null && typeof ref === 'object' && typeof ref.value === 'string') out.push(ref);
        }
    }
    return out;
}

/** 归一化事件里怎么判断真人消息：缺省兼容旧事件，只有明确的非 user kind 才算注入。 */
function isRealUserEvent(event) {
    const kind = event?.sourceKind;
    return kind === undefined || kind === null || kind === 'user';
}

function isMidwayFingerprint(value, sessionId, turn) {
    return value === fingerprint('auto:step:midway', `${sessionId}\u0000${turn}`);
}

/** 轮次标题是否还是占位（可被真实用户意图回填）。 */
function isPlaceholderStepTitle(title) {
    const text = String(title ?? '').trim();
    if (text === '') return true;
    if (/^第 \d+ 轮(?:研究|（缺少开始事件）|（续）)?$/u.test(text)) return true;
    return /Time sampled|background job|approval policy|user-approval|time-context|runtime-context|tool-jobs/iu.test(text);
}

function mergeUniqueRefs(refs, extra) {
    const out = Array.isArray(refs) ? [...refs] : [];
    const seen = new Set(out.map((ref) => `${ref?.kind ?? ''}\u0000${ref?.value ?? ''}`));
    for (const ref of extra) {
        if (ref === null || typeof ref !== 'object' || typeof ref.value !== 'string') continue;
        const key = `${ref.kind ?? ''}\u0000${ref.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ref);
    }
    return out;
}

function basename(value) {
    const parts = String(value).split(/[\\/]/);
    return parts[parts.length - 1] || String(value);
}
