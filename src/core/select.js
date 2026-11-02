/**
 * P1 取舍算法：把一轮推理里的候选 claim 变成「≤K 条关键节点」。
 *
 * 七段管线里的 `classify → select` 两段，全部是纯函数：
 *  - 多特征分类矩阵（argmax + margin），替代「首个正则命中」；
 *  - 过程旁白识别（只进轮摘要，不占节点）；
 *  - 标题取触发 kind 的那一句，而不是第一句；
 *  - 轮内近似去重（Jaccard 词面相似）+ 分层配额 + MMR 去冗余；
 *  - note 默认折叠（返回 folded，由 extract.js 计入 step 摘要）。
 *
 * 不做的事：不读写 store、不判断对错、不调用模型。
 *
 * @module core/select
 */

/** 分层配额（note 默认 0：折叠进轮摘要）。 */
export const DEFAULT_THOUGHT_QUOTAS = Object.freeze({
    dead_end: 3,
    conclusion: 1,
    decision: 3,
    hypothesis: 3,
    evidence: 3,
    question: 2,
    note: 0,
});

/** 层的优先级：失败/结论/取舍 > 假设 > 依据 > 问题 > 旁白。 */
export const THOUGHT_TIER = Object.freeze({
    dead_end: 3,
    conclusion: 3,
    decision: 3,
    hypothesis: 2,
    evidence: 1,
    question: 1,
    note: 0,
});

const CODE_FENCE_PATTERN = /```[\s\S]*?```/gu;

const QUESTION_MARK_PATTERN = /[?？]/u;
const QUESTION_PATTERN = /(?:^(?:是否|为什么|为何|如何|怎么|怎么办|哪(?:个|些|里|种))|能否|是不是|有没有|待裁决|需要(?:确认|验证|检查|弄清)|有哪些|为什么|为何|怎么(?![^？?]{0,12}[都也])|如何(?![^？?]{0,12}[都也])|哪(?:个|些|里|种)|谁(?:负责|主导|决定|来|能|会)|多少(?:人|个|次|条|项|节点|文件|行|字节|%)(?![们])|是什么|做什么|[吗呢]\s*[？?]?\s*$)|^(?:what|why|how|whether|which|who)\b|\bwhether\b|^(?:when|where)\s+(?:do|does|did|should|can|could|will|would|is|are|was|were|has|have)\b|\b(?:is|are|was|were)\s+(?:there|here)\b|^(?:can|could|should|would|is|are|was|were|does|do|did|has|have)\s+(?:i|we|you|they|he|she|it|this|that|these|those)\b|^should\s+(?:(?:the|a|an|this|that|these|those)\s+)?(?!exclude\b|use\b|add\b|keep\b|remove\b|update\b|create\b|make\b|write\b|read\b|run\b|check\b|try\b|consider\b|import\b|move\b|fix\b|test\b|call\b|set\b|open\b|close\b|delete\b|copy\b|include\b|prioritize\b|merge\b|split\b|verify\b|inspect\b|look\b|see\b|decide\b|plan\b|implement\b|prepare\b|clean\b|rename\b|refactor\b|revert\b|hide\b|show\b|filter\b|sort\b|limit\b|cap\b|raise\b|lower\b|increase\b|decrease\b|stop\b|start\b|avoid\b|prefer\b|drop\b|pass\b|fail\b|return\b|render\b|display\b|load\b|save\b|parse\b|serialize\b)[\w.$-]+\s+(?:be|have|need|work|exist|fail|pass|throw|return|support|mean|happen|matter|track|run|use|require|accept|modify|change|reset|contain|include|create|update|delete|bump|add|remove|set|keep|move|split|merge|see|show|produce|emit|write|read|check|test|fix|break|affect|help|count|apply|trigger|cause|allow|block|cover|handle|invalidate|reuse|store|cache|depend|expect|find|get|put|call|load|save|parse|render|display|limit|cap|raise|lower|increase|decrease|stop|start|avoid|prefer|drop)\b|\b(?:does|do|did)\s+(?:(?:the|a|an|this|that|these|those)\s+)?(?!not\b|never\b)[\w.$-]+(?:\s+[\w.$-]+)?\s+(?:have|need|work|exist|fail|pass|throw|return|support|mean|happen|matter|track|run|use|require|accept|modify|change|reset|contain|include|create|update|delete|bump|add|remove|set|keep|move|split|merge|see|show|produce|emit|write|read|check|test|fix|break|affect|help|count|apply|trigger|cause|allow|block|cover|handle|invalidate|reuse|store|cache|depend|expect|find|get|put|call|load|save|parse|render|display|limit|cap|raise|lower|increase|decrease|stop|start|avoid|prefer|drop)\b|\b(?:is|are|was|were)\s+(?:(?:the|a|an)\s+)?(?!not\b|never\b)[\w.$-]+\s+(?:valid|correct|wrong|true|false|possible|needed|supported|tracked|available|safe|enough|required|expected|broken|stale)\b/iu;
const FAILURE_PATTERN = /(?:行不通|走不通|不可行|失败了|失败|报错|错误|冲突|阻塞|无法(?:访问|完成|运行|打开|通过)|放弃(?:这个|该)?|死路)|\b(?:failed|fails?|failing|doesn't work|won't work|not possible|impossible|dead end|broken|conflict)\b/iu;
const HYPOTHESIS_PATTERN = /(?:假设|假定|推测|猜测|怀疑|猜想|可能(?:是|会|由|因为)|也许|或许|似乎|看起来|我认为|我猜|大概率|很可能)|\b(?:assume|assumption|suppose|perhaps|maybe|hypothesis|hypotheses|hypothesi[sz](?:e|es|ed|ing)|conjecture|suspect|might be|probably|likely|guess|seems? (?:to|like))\b/iu;
const EVIDENCE_PATTERN = /(?:因为|由于|根据|依据|说明|表明|显示|观察到|数据显示|测试结果|实测|验证|对比|统计|从.{0,20}(?:看|判断))|\b(?:because|since|given|observe|note that|it follows|shows? that|evidence|measured|verified|result|output|log)\b/iu;
const DECISION_PATTERN = /(?:决定|选择|采用|改为|改成|优先|下一步|接下来|计划|需要先|必须先|先.{0,12}再|应该|应当|必须|方案|策略|换成|改用|取舍|回退|备选)|\b(?:let's|we should|we will|choose|decide|decision|approach|plan|next step|instead|fallback|will use|prefer)\b/iu;
const CONCLUSION_PATTERN = /(?:结论|综上|综上所述|因此|所以|最终|总的来说|总结|证明|可见)|\b(?:therefore|thus|hence|conclusion|in summary|overall|final answer|proves?)\b|,\s*so\b/iu;

/** 过程旁白开头：只描述「我要做什么」，不携带研究结论。 */
const NARRATION_LEAD_PATTERN = /^(?:let me|let's|i'?ll|i will|i need to|i should|i'?m going to|i am going to|next i|then i|now i|i can|okay|alright|hmm+)\b/iu;
const NARRATION_LEAD_CJK_PATTERN = /^(?:我先|我来|我先来|接下来|接下来我|现在|那么|好的|让我|我需要|继续|再来看|首先我|然后我|接着|下一步我)/u;
/** 过程开头但带明确结论/失败/取舍的句子仍算 claim。 */
const STRONG_CLAIM_PATTERN = /(?:结论|综上|因此|所以|失败|报错|不可行|走不通|决定|选择|采用|改为|取舍|回退|保留(?:.*备选)?|替代)|\b(?:instead|fallback|rather than|trade-?off|failed|doesn't work|won't work|decision|decided)\b/iu;

/** 具体性：数字、百分比、路径、版本、测试名、对比结果。 */
const SPECIFICITY_PATTERN = /[A-Za-z]:[\\/]|\/[\w.-]+\/|\b\d+(?:\.\d+)?%|\b\d{2,}(?:\.\d+)?\b|\.(?:js|ts|json|md|mjs|yaml|yml)\b|\b\d+\s*\/\s*\d+\b/iu;

const PROPOSITION_PATTERN = /[。！？!?]|(?:是|为|有|会|能|要|应|需|表明|说明|导致|意味着|取决于)|(?:is|are|has|have|will|can|should|means|because|which)/iu;

/** 标题里要去掉的口头/过程前缀。 */
const TITLE_LEAD_PATTERN = /^(?:(?:hmm+|ok(?:ay)?|actually|well|so|now|then|thus|therefore|wait|let me|let's|i'?ll|i will|i need to)\b[,，:：\s-]*)+/iu;
const TITLE_LEAD_CJK_PATTERN = /^(?:那么|好的|现在|接下来|让我|我先|我来|首先我)[,，:：\s-]*/u;
/** 类型标签前缀（假设：/Evidence: …）。 */
const KIND_LABEL_PATTERN = /^(?:假设|假定|推测|猜测|怀疑|猜想|证据|依据|观察|决定|选择|采用|结论|问题|关键问题|answer|hypothesis|evidence|decision|conclusion|question)\s*[:：]\s*/iu;

const KIND_ORDER = ['dead_end', 'conclusion', 'decision', 'hypothesis', 'evidence', 'question', 'note'];

/** 显式类型标签（「假设：」「Decision:」）是强信号：把它按 kind 加权，避免正文里顺带提到的词抢走分类。 */
const KIND_LABEL_START_PATTERNS = [
    ['dead_end', /^(?:dead[ _-]?end|死路|失败)\s*[:：]/iu],
    ['conclusion', /^(?:conclusion|结论|综上|总结)\s*[:：]/iu],
    ['decision', /^(?:decision|决定|选择|采用|取舍|plan|方案)\s*[:：]/iu],
    ['hypothesis', /^(?:hypothesis|assumption|假设|推测|猜测)\s*[:：]/iu],
    ['evidence', /^(?:evidence|证据|依据|观察)\s*[:：]/iu],
    ['question', /^(?:question|问题|疑问)\s*[:：]/iu],
];

const KIND_LABEL_WEIGHT = 1.6;

function firstSentence(text) {
    const sentences = splitSentences(text);
    return sentences.length > 0 ? sentences[0] : String(text ?? '').trim();
}

/** 按句末标点/换行切句（中文零宽切分；英文句号后要求空白，避免切开 v0.4.0 / docs/x.md）。 */
export function splitSentences(text) {
    return String(text ?? '')
        .replace(CODE_FENCE_PATTERN, ' ')
        .replace(/\r\n?/gu, '\n')
        .split(/(?<=[。！？!?；;])\s*|(?<=[.!?])\s+|\n+/u)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence !== '');
}

/**
 * 文本是否像真正的疑问句（含中文疑问词、wh- 开头、助动词+主语，或以问号结尾）。
 * 用于把「被误分类成 question 的陈述句」挡在未决列表外。
 * @param {string} text
 */
export function isQuestionText(text) {
    const value = String(text ?? '').trim();
    if (value === '') return false;
    return QUESTION_MARK_PATTERN.test(value) || QUESTION_PATTERN.test(value);
}

/**
 * 是否纯过程旁白（「Let me / 我先 / 接下来」开头且没有实义结论）。
 * @param {string} text
 */
export function isProcessNarration(text) {
    const value = String(text ?? '').trim();
    if (value === '') return true;
    const lead = firstSentence(value);
    const processLead = NARRATION_LEAD_PATTERN.test(lead) || NARRATION_LEAD_CJK_PATTERN.test(lead);
    if (!processLead) return false;
    return !STRONG_CLAIM_PATTERN.test(value);
}

function looksLikeProposition(value) {
    if (value.length < 16) return false;
    return PROPOSITION_PATTERN.test(value);
}

/**
 * 多特征分类：返回 kind 与置信度；margin 太小或分数太低时归入 note（折叠候选）。
 *
 * @param {string} text
 * @param {{minChars?: number, minScore?: number, margin?: number}} [options]
 */
export function classifyClaim(text, options = {}) {
    const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
    const minChars = Number.isInteger(options.minChars) && options.minChars > 0 ? options.minChars : 8;
    const minScore = typeof options.minScore === 'number' ? options.minScore : 1.2;
    const marginSetting = typeof options.margin === 'number' ? options.margin : 0.35;
    const empty = {
        kind: 'note', score: 0, margin: 0, title: '', claim: '', features: {}, narration: true,
    };
    if (value.length < minChars) return empty;
    const sentences = splitSentences(value);
    if (sentences.length === 0) return empty;

    const features = {
        question: QUESTION_PATTERN.test(value) ? 1 : 0,
        questionMark: /[?？]/u.test(value) ? 1 : 0,
        failure: FAILURE_PATTERN.test(value) ? 1 : 0,
        hypothesis: HYPOTHESIS_PATTERN.test(value) ? 1 : 0,
        evidence: EVIDENCE_PATTERN.test(value) ? 1 : 0,
        decision: DECISION_PATTERN.test(value) ? 1 : 0,
        conclusion: CONCLUSION_PATTERN.test(value) ? 1 : 0,
        specificity: SPECIFICITY_PATTERN.test(value) ? 1 : 0,
        proposition: looksLikeProposition(value) ? 1 : 0,
    };
    const labeledKinds = new Set();
    for (const sentence of sentences) {
        const kind = labeledKindOf(sentence);
        if (kind !== null) labeledKinds.add(kind);
    }
    const narration = isProcessNarration(value);
    if (narration) return { ...empty, claim: value, features: { ...features, narration: 1 } };

    const scores = {
        question: 1.6 * features.question + 2.0 * features.questionMark + 0.25 * features.specificity + 0.2 * features.proposition,
        dead_end: 2.0 * features.failure + 0.4 * features.specificity + 0.2 * features.proposition,
        hypothesis: 2.2 * features.hypothesis + 0.5 * features.proposition + 0.25 * features.specificity,
        evidence: 2.0 * features.evidence + 0.5 * features.specificity + 0.3 * features.proposition,
        decision: 2.0 * features.decision + 0.4 * features.specificity + 0.2 * features.proposition,
        conclusion: 2.0 * features.conclusion + 0.5 * features.proposition + 0.2 * features.specificity,
        note: 0.7,
    };
    for (const kind of labeledKinds) {
        scores[kind] = (scores[kind] ?? 0) + KIND_LABEL_WEIGHT;
    }
    const ranked = KIND_ORDER
        .map((kind) => ({ kind, score: scores[kind] ?? 0 }))
        .sort((a, b) => (b.score - a.score) || (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)));
    const top = ranked[0];
    const second = ranked[1] ?? { score: 0 };
    const margin = top.score - second.score;
    const kind = top.kind !== 'note' && top.score >= minScore && margin >= marginSetting ? top.kind : 'note';
    return {
        kind,
        score: Math.round(top.score * 100) / 100,
        margin: Math.round(margin * 100) / 100,
        title: kind === 'note' ? '' : cleanTitle(triggerSentence(sentences, kind, features), 120),
        claim: triggerSentence(sentences, kind === 'note' ? 'note' : kind, features),
        features,
        narration: false,
    };
}

/** 句首显式类型标签（「假设：」「Decision:」）→ kind。 */
function labeledKindOf(sentence) {
    const value = String(sentence ?? '').replace(/^[-*•·\d.)、\s]+/u, '');
    for (const [kind, pattern] of KIND_LABEL_START_PATTERNS) {
        if (pattern.test(value)) return kind;
    }
    return null;
}

/** 取最像触发该 kind 的那一句（先看显式标签，再看关键词命中数，同分取靠前的句子）。 */
function triggerSentence(sentences, kind, features) {
    if (kind === 'note' || sentences.length === 1) return sentences[0] ?? '';
    const labeled = sentences.find((sentence) => labeledKindOf(sentence) === kind);
    if (labeled !== undefined) return labeled.replace(/^[-*•·\d.)、\s]+/u, '');
    const pattern = {
        question: QUESTION_PATTERN,
        dead_end: FAILURE_PATTERN,
        hypothesis: HYPOTHESIS_PATTERN,
        evidence: EVIDENCE_PATTERN,
        decision: DECISION_PATTERN,
        conclusion: CONCLUSION_PATTERN,
    }[kind];
    if (pattern === undefined) return sentences[0];
    let best = sentences[0];
    let bestHits = -1;
    for (const sentence of sentences) {
        const hits = sentence.match(pattern)?.length ?? 0;
        if (hits > bestHits) {
            bestHits = hits;
            best = sentence;
        }
    }
    // 结论/决策常在句尾：命中数相同时，结论类优先取最后一句。
    if (features.conclusion === 1 && kind === 'conclusion' && bestHits <= 1 && sentences.length > 1) {
        return sentences[sentences.length - 1];
    }
    return best;
}

/** 标题清洗：去 markdown、类型标签、过程前缀、首尾标点与 LaTeX 噪声。 */
function cleanTitle(text, max) {
    const raw = String(text ?? '');
    const isMath = /\\begin\{|\$[^$]{2,}\$/u.test(raw);
    let cleaned = raw
        .replace(CODE_FENCE_PATTERN, ' ')
        .replace(/[#>*_`~]/gu, ' ')
        .replace(/^\s*[-*•·]\s*/u, '')
        .replace(KIND_LABEL_PATTERN, '')
        .replace(TITLE_LEAD_PATTERN, '')
        .replace(TITLE_LEAD_CJK_PATTERN, '')
        .replace(/\s+/gu, ' ')
        .replace(/^[，,、;；:：.\s]+|[，,、;；:：。.!！?？\s]+$/gu, '')
        .trim();
    // 只在确实是数学文本时清 LaTeX，避免把 Windows 路径的 \path 当成命令删掉。
    if (isMath) {
        cleaned = cleaned.replace(/\\[a-zA-Z]+/gu, ' ').replace(/[{}$^]/gu, ' ').replace(/\s+/gu, ' ').trim();
    }
    if (cleaned === '') return '想法';
    const capitalized = /^[a-z]/u.test(cleaned) ? `${cleaned[0].toUpperCase()}${cleaned.slice(1)}` : cleaned;
    return capitalized.length > max ? `${capitalized.slice(0, Math.max(0, max - 1))}…` : capitalized;
}

// ───────────────────────── 近似去重 ─────────────────────────

function tokenSet(text) {
    const value = String(text ?? '').toLowerCase().replace(/[`*_>#]/gu, ' ');
    const tokens = new Set();
    for (const word of value.match(/[a-z0-9][a-z0-9_.:/-]{2,}/gu) ?? []) tokens.add(word);
    for (const run of value.match(/[\u3400-\u9fff]{2,}/gu) ?? []) {
        for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
    }
    return tokens;
}

/** Jaccard 词面相似度（英文词 + 中文 bigram）。 */
export function similarity(a, b) {
    const left = tokenSet(a);
    const right = tokenSet(b);
    if (left.size === 0 || right.size === 0) return 0;
    let overlap = 0;
    for (const token of left) if (right.has(token)) overlap += 1;
    return overlap / (left.size + right.size - overlap);
}

/** 近似重复：归一化文本相同，或 Jaccard ≥ 阈值（过短的文本要求完全一致）。 */
export function isNearDuplicate(a, b, threshold = 0.85) {
    const left = String(a ?? '').trim();
    const right = String(b ?? '').trim();
    if (left === '' || right === '') return false;
    if (left === right) return true;
    const leftTokens = tokenSet(left);
    const rightTokens = tokenSet(right);
    if (leftTokens.size < 4 || rightTokens.size < 4) return false;
    return similarity(left, right) >= threshold;
}

// ───────────────────────── 选择 ─────────────────────────

function clampInt(value, fallback, min, max) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

function quotaOf(kind, quotas, noteNodeMode) {
    if (kind === 'note') return noteNodeMode === 'node' ? 3 : 0;
    const value = quotas?.[kind];
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : (DEFAULT_THOUGHT_QUOTAS[kind] ?? 0);
}

/** 结构节点（会开枝）的 kind。 */
export function isApproachKind(kind) {
    return kind === 'question' || kind === 'hypothesis' || kind === 'decision';
}

/**
 * 从候选池选出本轮要落节点的 claim。
 *
 * @param {Array<{key: string, text: string, kind: string, score: number, title: string, order?: number}>} candidates
 * @param {object} [options]
 * @param {number} [options.maxThoughtNodesPerTurn=10]
 * @param {Record<string, number>} [options.thoughtQuotas]
 * @param {number} [options.mmrLambda=0.7]
 * @param {number} [options.dedupeSimThreshold=0.85]
 * @param {number} [options.reserveConclusionSlots=1]
 * @param {'fold'|'node'} [options.noteNodeMode='fold']
 * @returns {{selected: Array<object>, folded: Array<object>, ranked: Array<object>}}
 */
export function selectClaims(candidates, options = {}) {
    const total = clampInt(options.maxThoughtNodesPerTurn, 10, 0, 500);
    const quotas = { ...DEFAULT_THOUGHT_QUOTAS, ...(options.thoughtQuotas ?? {}) };
    const lambda = Number.isFinite(options.mmrLambda) ? Math.min(1, Math.max(0, options.mmrLambda)) : 0.7;
    const threshold = Number.isFinite(options.dedupeSimThreshold) ? options.dedupeSimThreshold : 0.85;
    const reserve = clampInt(options.reserveConclusionSlots, 1, 0, 4);
    const noteNodeMode = options.noteNodeMode === 'node' ? 'node' : 'fold';
    const folded = [];
    const kept = [];

    // ① 轮内近似去重：保留分更高的那条。
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        if (candidate === null || typeof candidate !== 'object') continue;
        const item = {
            key: String(candidate.key ?? candidate.text ?? ''),
            text: String(candidate.text ?? ''),
            kind: typeof candidate.kind === 'string' ? candidate.kind : 'note',
            score: Number.isFinite(candidate.score) ? candidate.score : 0,
            title: String(candidate.title ?? ''),
            order: Number.isFinite(candidate.order) ? candidate.order : 0,
            seen: Number.isFinite(candidate.seen) ? candidate.seen : 1,
        };
        if (item.kind === 'note' && noteNodeMode === 'fold') {
            folded.push(item);
            continue;
        }
        let duplicateIndex = -1;
        for (let index = 0; index < kept.length; index += 1) {
            if (isNearDuplicate(item.text, kept[index].text, threshold)) {
                duplicateIndex = index;
                break;
            }
        }
        if (duplicateIndex === -1) {
            kept.push(item);
        } else if (item.score > kept[duplicateIndex].score + 0.25) {
            const previous = kept[duplicateIndex];
            kept[duplicateIndex] = { ...item, seen: Math.max(item.seen, previous.seen) };
        } else {
            kept[duplicateIndex] = {
                ...kept[duplicateIndex],
                seen: Math.max(kept[duplicateIndex].seen, item.seen),
            };
        }
    }

    // ② MMR：score - λ·maxSim(已选)，兼顾相关性与多样性。
    const remaining = kept.slice();
    const ranked = [];
    while (remaining.length > 0) {
        let bestIndex = 0;
        let bestValue = -Infinity;
        for (let index = 0; index < remaining.length; index += 1) {
            const item = remaining[index];
            let maxSim = 0;
            for (const chosen of ranked) maxSim = Math.max(maxSim, similarity(item.text, chosen.text));
            const value = item.score - lambda * maxSim;
            if (value > bestValue + 1e-9
                || (Math.abs(value - bestValue) <= 1e-9 && item.order < remaining[bestIndex].order)) {
                bestValue = value;
                bestIndex = index;
            }
        }
        ranked.push(remaining.splice(bestIndex, 1)[0]);
    }

    // ③ 分层配额 + 总分上限；先给结论留 1 个槽，再按 MMR 顺序填。
    const selected = [];
    const counts = {};
    const tryTake = (item, limit) => {
        if (selected.length >= limit) return false;
        const quota = quotaOf(item.kind, quotas, noteNodeMode);
        const used = counts[item.kind] ?? 0;
        if (used >= quota) return false;
        counts[item.kind] = used + 1;
        selected.push(item);
        return true;
    };
    const primaryLimit = Math.max(0, total - Math.min(reserve, total));
    for (const item of ranked) if (item.kind !== 'conclusion') tryTake(item, primaryLimit);
    for (const item of ranked) if (item.kind === 'conclusion' && !selected.includes(item)) tryTake(item, total);
    for (const item of ranked) if (!selected.includes(item)) tryTake(item, total);

    return { selected, folded, ranked };
}
