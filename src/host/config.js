/**
 * 插件配置归一化。
 *
 * 设计取舍：不导出 `Config`（schemastery schema）——本插件是纯 ESM 单文件包，
 * 不希望在模块求值期依赖宿主安装目录里的 schemastery。cordis 在插件没有
 * Config 时把 profile 里的 config 原样透传，因此这里自己兜默认值即可。
 * 需要设置页时再补 Config，不影响运行时字段。
 *
 * @module host/config
 */

/** 配置默认值（文档同步维护在 README 的 Config 一节）。 */
export const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    /** 自动从会话事件提取（关掉后仍可手动 record）。 */
    autoCapture: true,
    captureReasoning: true,
    /** 把推理链切成「想法节点」：研究图以推理为主，工具动作只是旁证（需求 5/7）。 */
    captureReasoningNodes: true,
    captureToolCalls: true,
    /** 工具调用记录方式（aggregate 只留每轮汇总节点；nodes 逐调用；off 不记）。 */
    toolCallMode: 'aggregate',
    captureArtifacts: true,
    detectConclusions: true,
    /** 没有推理链时，把长回答按 Markdown 小标题拆成推导节点（一问一答也能成树）。 */
    captureAnswerSections: true,
    minAnswerChars: 400,
    minSectionChars: 16,
    maxAnswerSections: 10,
    /** 没有 topic 时，单轮想法达到 topicSeedMinClaims 后自动建候选主题。 */
    autoSeedTopic: true,
    topicSeedMinClaims: 5,
    /** 单个 topic 最多承接的未决叶根；满仓后新想法优先挂到其他主题/另起候选主题。 */
    maxOpenLeavesPerTopic: 9,
    /** 用户意图与 topic 的最低词面相似度；低于它视为新请求，不再复用旧主题。 */
    topicIntentThreshold: 0.12,
    /** 轮首向模型注入「研究轨迹简报」（仅当图里已有 topic；默认开，可在设置里关）。 */
    injectBrief: true,
    /** 简报范围：workspace=含同工作区其他 goal 的主干（多 agent 默认）；goal=只看当前会话 goal。 */
    briefScope: 'workspace',
    /** 单次注入的研究简报长度上限（字符；默认 1200，约 300 token）。 */
    briefMaxChars: 1200,
    /** 自动提取忽略的工具名（本插件自身的读写工具不能反向污染图）。 */
    ignoreTools: ['explore_tree', 'explore_tree_record'],
    /** 首次打开旧图时，把「每次调用一个动作节点」的历史数据压缩成每轮汇总。 */
    compactLegacyActions: true,
    /** 首次打开旧图时，把错挂成根的孤立 step 归到所属目标下（修 turn/start 先到的问题）。 */
    repairOrphanSteps: true,
    /** 首次打开旧图时，把「只有一个长结论」的旧轮次按小标题展开成推导链。 */
    expandLegacyAnswers: true,
    /** 首次打开旧图时，合并同会话同轮的重复 step（如 turn/start 与 midway 各建一个）。 */
    mergeDuplicateSteps: true,
    /**
     * 打开一个「本工作区还没有图」的旧会话时，回放它的历史事件，
     * 从 reasoning 块补建研究树（不调用模型、只做确定性提取）。
     */
    backfillHistory: true,
    /** 单轮自动节点上限：防止长会话把图撑爆（超限后只保留轮次摘要）。 */
    maxAutoNodesPerTurn: 80,
    /** 单轮想法节点上限：ranked 策略下一屏可读的关键想法条数。 */
    maxThoughtNodesPerTurn: 10,
    maxThoughtUnitsPerBlock: 8,
    minThoughtChars: 12,
    maxThoughtChars: 400,
    /**
     * 想法节点取舍策略：
     * - ranked（默认）：多特征分类 + 近似去重 + 分层配额 + MMR，只留关键想法；
     * - chronological：旧行为，按事件顺序落节点（调试/对比用）。
     */
    selectionStrategy: 'ranked',
    /** 分层配额（超出同层配额的候选折叠进轮次摘要）。 */
    thoughtQuotas: Object.freeze({
        dead_end: 3,
        conclusion: 1,
        decision: 3,
        hypothesis: 3,
        evidence: 3,
        question: 2,
        note: 0,
    }),
    /** 轮内近似去重阈值（Jaccard 词面相似）。 */
    dedupeSimThreshold: 0.85,
    /** MMR 去冗余强度：score - λ·maxSim(已选)。 */
    mmrLambda: 0.7,
    /** 给结论预留的槽位（结论常在轮次末尾出现）。 */
    reserveConclusionSlots: 1,
    /** 分类置信门槛：分数或 top1-top2 差值不足时折叠成 note。 */
    claimMinConfidence: 1.2,
    claimMargin: 0.35,
    /** 主题关联阈值：跨轮 supports/refines 边与同轮子方法嵌套的相似度门槛。 */
    threadLinkThreshold: 0.55,
    /** 同轮嵌套阈值：比跨轮更宽松，让主问题→子假设→证据形成逻辑深度。 */
    intraTurnLinkThreshold: 0.15,
    /** note 处理方式：fold=不建节点、计入轮摘要；node=旧行为（调试）。 */
    noteNodeMode: 'fold',
    /** 想法节点的最低信息量分数（仅 chronological 模式使用）。 */
    minThoughtScore: 1,
    /** 从一段推理里最多读取多少字符（超长时取头+尾，兼顾开头的问题与末尾的结论）。 */
    maxThoughtSourceChars: 60000,
    maxReasoningChars: 2400,
    maxSummaryChars: 1200,
    maxTitleChars: 120,
    /** 研究图目录名（相对工作区根）。 */
    dirName: '.explore-tree',
    /** 图节点上限，超过后把最旧的 done 节点下沉到 archive.jsonl。 */
    maxNodes: 5000,
    /** 是否注册静态系统提示段落（需求 6：段落纯静态，不随图变化）。 */
    promptSection: true,
    /** 是否注册 Web 面板数据路由。 */
    http: true,
    /** 后台 LLM 辅助提取。默认关闭：默认路径不产生额外模型调用。 */
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
    /** 独立的研究图解析（概览页「AI 解析」按钮，手动触发，不属于自动提取链路）。 */
    analysis: Object.freeze({
        enabled: true,
        provider: undefined,
        model: undefined,
        maxInputChars: 12000,
        timeoutMs: 60000,
        maxOutputTokens: 1600,
        cacheTtlMs: 600000,
    }),
});

function num(value, fallback, min, max) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function toolCallModeOf(value) {
    return value === 'nodes' || value === 'off' || value === 'aggregate' ? value : DEFAULT_CONFIG.toolCallMode;
}

function strategyOf(value) {
    return value === 'chronological' ? 'chronological' : DEFAULT_CONFIG.selectionStrategy;
}

function briefScopeOf(value) {
    return value === 'goal' ? 'goal' : DEFAULT_CONFIG.briefScope;
}

function noteModeOf(value) {
    return value === 'node' ? 'node' : DEFAULT_CONFIG.noteNodeMode;
}

function floatNum(value, fallback, min, max) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/** 分层配额：未知 kind 忽略，数字做 0..20 收敛。 */
function quotasOf(value) {
    const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = {};
    for (const [kind, fallback] of Object.entries(DEFAULT_CONFIG.thoughtQuotas)) {
        const n = typeof input[kind] === 'number' ? input[kind] : Number(input[kind]);
        out[kind] = Number.isFinite(n) ? Math.min(20, Math.max(0, Math.floor(n))) : fallback;
    }
    return out;
}

function stringList(value, fallback) {
    if (!Array.isArray(value)) return [...fallback];
    const out = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
    return out.length > 0 ? out : [...fallback];
}

/**
 * 把 profile 的原始 config 归一化成运行时配置。
 *
 * 未知字段原样保留（向前兼容），已知字段做类型与范围收敛；任何错误都回退到
 * 默认值，绝不让一份坏配置阻止插件加载。
 *
 * @param {unknown} raw
 */
export function normalizeConfig(raw) {
    const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const extract = input.extract !== null && typeof input.extract === 'object' ? input.extract : {};
    const llm = input.llm !== null && typeof input.llm === 'object' ? input.llm : {};
    const analysis = input.analysis !== null && typeof input.analysis === 'object' ? input.analysis : {};
    const merged = { ...DEFAULT_CONFIG, ...input };
    return {
        ...merged,
        enabled: bool(input.enabled, DEFAULT_CONFIG.enabled),
        autoCapture: bool(input.autoCapture, DEFAULT_CONFIG.autoCapture),
        captureReasoning: bool(extract.captureReasoning ?? input.captureReasoning, DEFAULT_CONFIG.captureReasoning),
        captureReasoningNodes: bool(extract.captureReasoningNodes ?? input.captureReasoningNodes, DEFAULT_CONFIG.captureReasoningNodes),
        captureToolCalls: bool(extract.captureToolCalls ?? input.captureToolCalls, DEFAULT_CONFIG.captureToolCalls),
        toolCallMode: toolCallModeOf(extract.toolCallMode ?? input.toolCallMode),
        captureArtifacts: bool(extract.captureArtifacts ?? input.captureArtifacts, DEFAULT_CONFIG.captureArtifacts),
        detectConclusions: bool(extract.detectConclusions ?? input.detectConclusions, DEFAULT_CONFIG.detectConclusions),
        captureAnswerSections: bool(extract.captureAnswerSections ?? input.captureAnswerSections, DEFAULT_CONFIG.captureAnswerSections),
        minAnswerChars: num(extract.minAnswerChars ?? input.minAnswerChars, DEFAULT_CONFIG.minAnswerChars, 80, 20000),
        minSectionChars: num(extract.minSectionChars ?? input.minSectionChars, DEFAULT_CONFIG.minSectionChars, 2, 2000),
        maxAnswerSections: num(extract.maxAnswerSections ?? input.maxAnswerSections, DEFAULT_CONFIG.maxAnswerSections, 1, 50),
        autoSeedTopic: bool(extract.autoSeedTopic ?? input.autoSeedTopic, DEFAULT_CONFIG.autoSeedTopic),
        topicSeedMinClaims: num(extract.topicSeedMinClaims ?? input.topicSeedMinClaims, DEFAULT_CONFIG.topicSeedMinClaims, 1, 50),
        maxOpenLeavesPerTopic: num(extract.maxOpenLeavesPerTopic ?? input.maxOpenLeavesPerTopic, DEFAULT_CONFIG.maxOpenLeavesPerTopic, 1, 100),
        topicIntentThreshold: floatNum(extract.topicIntentThreshold ?? input.topicIntentThreshold, DEFAULT_CONFIG.topicIntentThreshold, 0, 1),
        injectBrief: bool(input.injectBrief ?? extract.injectBrief, DEFAULT_CONFIG.injectBrief),
        briefScope: briefScopeOf(input.briefScope ?? extract.briefScope),
        briefMaxChars: num(input.briefMaxChars ?? extract.briefMaxChars, DEFAULT_CONFIG.briefMaxChars, 200, 4000),
        ignoreTools: stringList(extract.ignoreTools ?? input.ignoreTools, DEFAULT_CONFIG.ignoreTools),
        compactLegacyActions: bool(extract.compactLegacyActions ?? input.compactLegacyActions, DEFAULT_CONFIG.compactLegacyActions),
        repairOrphanSteps: bool(extract.repairOrphanSteps ?? input.repairOrphanSteps, DEFAULT_CONFIG.repairOrphanSteps),
        expandLegacyAnswers: bool(extract.expandLegacyAnswers ?? input.expandLegacyAnswers, DEFAULT_CONFIG.expandLegacyAnswers),
        mergeDuplicateSteps: bool(extract.mergeDuplicateSteps ?? input.mergeDuplicateSteps, DEFAULT_CONFIG.mergeDuplicateSteps),
        backfillHistory: bool(extract.backfillHistory ?? input.backfillHistory, DEFAULT_CONFIG.backfillHistory),
        maxAutoNodesPerTurn: num(extract.maxAutoNodesPerTurn ?? input.maxAutoNodesPerTurn, DEFAULT_CONFIG.maxAutoNodesPerTurn, 1, 2000),
        maxThoughtNodesPerTurn: num(extract.maxThoughtNodesPerTurn ?? input.maxThoughtNodesPerTurn, DEFAULT_CONFIG.maxThoughtNodesPerTurn, 0, 500),
        maxThoughtUnitsPerBlock: num(extract.maxThoughtUnitsPerBlock ?? input.maxThoughtUnitsPerBlock, DEFAULT_CONFIG.maxThoughtUnitsPerBlock, 1, 50),
        minThoughtChars: num(extract.minThoughtChars ?? input.minThoughtChars, DEFAULT_CONFIG.minThoughtChars, 2, 1000),
        maxThoughtChars: num(extract.maxThoughtChars ?? input.maxThoughtChars, DEFAULT_CONFIG.maxThoughtChars, 40, 4000),
        minThoughtScore: num(extract.minThoughtScore ?? input.minThoughtScore, DEFAULT_CONFIG.minThoughtScore, -10, 10),
        selectionStrategy: strategyOf(extract.selectionStrategy ?? input.selectionStrategy),
        thoughtQuotas: quotasOf(extract.thoughtQuotas ?? input.thoughtQuotas),
        dedupeSimThreshold: floatNum(extract.dedupeSimThreshold ?? input.dedupeSimThreshold, DEFAULT_CONFIG.dedupeSimThreshold, 0.5, 1),
        mmrLambda: floatNum(extract.mmrLambda ?? input.mmrLambda, DEFAULT_CONFIG.mmrLambda, 0, 1),
        reserveConclusionSlots: num(extract.reserveConclusionSlots ?? input.reserveConclusionSlots, DEFAULT_CONFIG.reserveConclusionSlots, 0, 4),
        claimMinConfidence: floatNum(extract.claimMinConfidence ?? input.claimMinConfidence, DEFAULT_CONFIG.claimMinConfidence, 0, 10),
        claimMargin: floatNum(extract.claimMargin ?? input.claimMargin, DEFAULT_CONFIG.claimMargin, 0, 10),
        threadLinkThreshold: floatNum(extract.threadLinkThreshold ?? input.threadLinkThreshold, DEFAULT_CONFIG.threadLinkThreshold, 0.2, 1),
        intraTurnLinkThreshold: floatNum(extract.intraTurnLinkThreshold ?? input.intraTurnLinkThreshold, DEFAULT_CONFIG.intraTurnLinkThreshold, 0.05, 1),
        noteNodeMode: noteModeOf(extract.noteNodeMode ?? input.noteNodeMode),
        maxThoughtSourceChars: num(extract.maxThoughtSourceChars ?? input.maxThoughtSourceChars, DEFAULT_CONFIG.maxThoughtSourceChars, 2000, 200000),
        maxReasoningChars: num(extract.maxReasoningChars ?? input.maxReasoningChars, DEFAULT_CONFIG.maxReasoningChars, 0, 20000),
        maxSummaryChars: num(extract.maxSummaryChars ?? input.maxSummaryChars, DEFAULT_CONFIG.maxSummaryChars, 100, 20000),
        maxTitleChars: num(extract.maxTitleChars ?? input.maxTitleChars, DEFAULT_CONFIG.maxTitleChars, 16, 400),
        dirName: typeof input.dirName === 'string' && input.dirName.trim() !== '' ? input.dirName.trim() : DEFAULT_CONFIG.dirName,
        maxNodes: num(input.maxNodes, DEFAULT_CONFIG.maxNodes, 50, 200000),
        promptSection: bool(input.promptSection, DEFAULT_CONFIG.promptSection),
        http: bool(input.http, DEFAULT_CONFIG.http),
        llm: {
            enabled: bool(llm.enabled, false),
            provider: nonEmptyString(llm.provider),
            model: nonEmptyString(llm.model),
            maxClaims: num(llm.maxClaims, DEFAULT_CONFIG.llm.maxClaims, 1, 20),
            maxInputChars: num(llm.maxInputChars, DEFAULT_CONFIG.llm.maxInputChars, 1000, 60000),
            timeoutMs: num(llm.timeoutMs, DEFAULT_CONFIG.llm.timeoutMs, 1000, 120000),
            maxOutputTokens: num(llm.maxOutputTokens, DEFAULT_CONFIG.llm.maxOutputTokens, 128, 8192),
            digest: bool(llm.digest, false),
        },
        analysis: {
            enabled: bool(analysis.enabled, DEFAULT_CONFIG.analysis.enabled),
            provider: nonEmptyString(analysis.provider),
            model: nonEmptyString(analysis.model),
            maxInputChars: num(analysis.maxInputChars, DEFAULT_CONFIG.analysis.maxInputChars, 2000, 40000),
            timeoutMs: num(analysis.timeoutMs, DEFAULT_CONFIG.analysis.timeoutMs, 5000, 180000),
            maxOutputTokens: num(analysis.maxOutputTokens, DEFAULT_CONFIG.analysis.maxOutputTokens, 256, 4000),
            cacheTtlMs: num(analysis.cacheTtlMs, DEFAULT_CONFIG.analysis.cacheTtlMs, 0, 3600000),
        },
    };
}

/** 提取器配置视图（core/extract.js 只关心这几个键）。 */
export function extractConfigOf(config) {
    return {
        enabled: config.autoCapture !== false,
        captureReasoning: config.captureReasoning,
        captureReasoningNodes: config.captureReasoningNodes,
        captureToolCalls: config.captureToolCalls,
        toolCallMode: config.toolCallMode,
        captureArtifacts: config.captureArtifacts,
        detectConclusions: config.detectConclusions,
        captureAnswerSections: config.captureAnswerSections,
        minAnswerChars: config.minAnswerChars,
        minSectionChars: config.minSectionChars,
        maxAnswerSections: config.maxAnswerSections,
        autoSeedTopic: config.autoSeedTopic,
        topicSeedMinClaims: config.topicSeedMinClaims,
        maxOpenLeavesPerTopic: config.maxOpenLeavesPerTopic,
        topicIntentThreshold: config.topicIntentThreshold,
        ignoreTools: config.ignoreTools,
        compactLegacyActions: config.compactLegacyActions,
        repairOrphanSteps: config.repairOrphanSteps,
        maxAutoNodesPerTurn: config.maxAutoNodesPerTurn,
        maxThoughtNodesPerTurn: config.maxThoughtNodesPerTurn,
        maxThoughtUnitsPerBlock: config.maxThoughtUnitsPerBlock,
        minThoughtChars: config.minThoughtChars,
        maxThoughtChars: config.maxThoughtChars,
        minThoughtScore: config.minThoughtScore,
        selectionStrategy: config.selectionStrategy,
        thoughtQuotas: config.thoughtQuotas,
        dedupeSimThreshold: config.dedupeSimThreshold,
        mmrLambda: config.mmrLambda,
        reserveConclusionSlots: config.reserveConclusionSlots,
        claimMinConfidence: config.claimMinConfidence,
        claimMargin: config.claimMargin,
        threadLinkThreshold: config.threadLinkThreshold,
        intraTurnLinkThreshold: config.intraTurnLinkThreshold,
        noteNodeMode: config.noteNodeMode,
        maxThoughtSourceChars: config.maxThoughtSourceChars,
        maxReasoningChars: config.maxReasoningChars,
        maxSummaryChars: config.maxSummaryChars,
        maxTitleChars: config.maxTitleChars,
        llm: config.llm,
    };
}
