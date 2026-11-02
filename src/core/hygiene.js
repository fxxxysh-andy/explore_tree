/**
 * 未决卫生（v0.21）：把自动提取的推理旁白、已关闭主题下的陈旧未决从「待办」里分离出来。
 *
 * 设计原则：
 *  - 只读纯函数，不直接改图；planOpenCleanup 产出可审计、可回滚的变更计划；
 *  - 只处理自动提取（origin=auto）且无细节子节点/无重复命中的问题/假设，人工写入的未决一律保留；
 *  - 「已关闭主题」下的未决不直接删除，而是标成历史（stale），由调用方决定是否归档；
 *  - 平衡只隐藏已完成/已放弃的叶根，不动真正的未决叶根。
 *
 * @module core/hygiene
 */
import { childrenOf } from './graph.js';
import { isLeafRootKind } from './model.js';
import { isQuestionText } from './select.js';

/** 待解决的节点状态。 */
export const OPEN_STATUSES = Object.freeze(['open', 'active']);
/** 会进入「未决」列表的 kind。 */
export const OPEN_KINDS = Object.freeze(['question', 'hypothesis', 'decision']);
/** 自动收敛留下的标签，便于回滚/审计。 */
export const AUTO_CURATED_TAG = 'auto-curated';
export const STALE_TOPIC_TAG = 'stale-topic';
export const NOISE_TAG = 'reasoning-noise';

/** 显式阻塞项的标签：无论标题多像旁白，都不参与自动收敛。 */
export function hasBlockerTag(node) {
    return node !== null && node !== undefined
        && Array.isArray(node.tags) && node.tags.includes('blocker');
}

/** 自动收敛产生的历史项：不应再被当成真正的死路/未决参与建议。 */
export function isAutoCuratedNode(node) {
    return node !== null && node !== undefined
        && Array.isArray(node.tags) && node.tags.includes(AUTO_CURATED_TAG);
}

/** 过程旁白开头：描述「我要做什么」，不是研究问题/假设。 */
const PROCESS_LEAD_PATTERN = /^(?:now|also|but|then|next|first|second|finally|wait|hmm+|interesting|okay|alright|actually|alternatively|let me|let's|i(?:'ll| will| need| should| can|could| think| wonder| want|'d| am| have)|we(?:'ll| will| need| should| can|could| have)|the user|the task|the examples|deliverable|keys:|need to|try|check|read|run|verify|look|consider|add|update|write|test|use|keep|make|move|set|remove|delete|create|copy|inspect|see|decide|plan|implement|prepare|clean|rename|refactor|revert|hide|show|filter|sort|limit|cap|raise|lower|increase|decrease|stop|start|avoid|prefer|drop|pass|return|render|display|load|save|parse|serialize|could (?:use|add|create|restart|split|be|try)|maybe (?:use|take|include|simpler|second|faster)|perhaps (?:use|do|take))/iu;

/** 小标题/结构说明开头。 */
const META_LEAD_PATTERN = /^(?:the (?:user|task|goal|deliverable|answer|examples)|deliverable|outline|refs?:|keys?:|analysis:|todo:|note:|this (?:is|means)|that's|there (?:is|are)|user:)/iu;

/** 以标点/代码片段开头，通常是上一句被切开的残留。 */
const FRAGMENT_LEAD_PATTERN = /^[)\]}>,;:，。；：、]/u;

/** 第一人称计划句：「I/we ... should/need/can ...」。 */
const FIRST_PERSON_PLAN_PATTERN = /\b(?:i|we)\b[^.!?]{0,120}\b(?:should|need|can|could|will|would|have to|want|try|check|read|run|verify|look|add|update|fix|use|make|write|test|call|set|move|close|open|delete|copy|create)\b/iu;

/** 常见的计划短语（避免把真正的 wh- 问题误判成旁白）。 */
const PLANNING_PHRASE_PATTERN = /\b(?:could use|could add|could create|could restart|could split|could be|maybe include|maybe second|maybe faster|maybe simpler|perhaps do|need decide|need maybe|we should|we need|we'll|we can|i'll|i need|i should)\b/iu;

/** 英文命令式开头（没有问号、没有中文问题词时才判旁白）。 */
const IMPERATIVE_EN_PATTERN = /^(?:add|use|read|run|check|try|consider|import|move|update|fix|make|write|test|call|set|open|close|remove|delete|create|copy|exclude|include|prioritize|merge|split|verify|inspect|look|see|decide|plan|implement|prepare|clean|rename|refactor|revert|hide|show|filter|sort|limit|cap|raise|lower|increase|decrease|stop|start|avoid|prefer|keep|drop|pass|fail|return|render|display|load|save|parse|serialize)\b/iu;

/** 工程工具/文件引用；没有明确疑问时更像过程记录。 */
const TOOL_TEXT_PATTERN = /\b(?:explore_tree|npm test|node --test|git (?:add|commit|diff|status|stash)|bash|grep|rg |screenshot|subagent|graph\.json|package\.json|change?log|readme|src\/|test\/unit|docs\/|host\b)/iu;

/** 明确以疑问词/助动词开头：即使命中工具词，也优先保留。 */
const QUESTION_START_PATTERN = /^(?:what|why|how|whether|which|who|when|where|did|does|is|are|was|were|can|could|should|would|will|has|have)\b/iu;

/** 中文疑问/裁决词。 */
const CJK_INTERROGATIVE_PATTERN = /(?:是否|为什么|为何|如何|怎么|哪(?:个|些|里|种)|能否|是不是|有没有|待裁决|需要(?:确认|验证|检查|弄清))/u;

/** 假设句信号：推测语气、条件句、因果解释。没有这些信号的 auto hypothesis 多半是观察记录。 */
const HYPOTHESIS_SIGNAL_PATTERN = /(?:假设|推测|猜测|怀疑|猜想|可能|也许|或许|似乎|看起来|大概率|很可能|应该|会不会|因为|由于|所以|因此|导致|说明|表明|意味着|取决于)|\b(?:maybe|perhaps|likely|probably|might|could|would|should|may|seems?|appears?|suspect|assum(?:e|es|ed|ption)|guess|predict|expect|because|since|therefore|thus|if)\b/iu;

/** 节点是否处于待解决状态。 */
export function isOpenNode(node) {
    return node !== null && typeof node === 'object'
        && typeof node.kind === 'string' && OPEN_KINDS.includes(node.kind)
        && OPEN_STATUSES.includes(node.status);
}

/** 最近的 topic 祖先（含自身）；找不到返回 null。 */
export function nearestTopic(state, nodeId) {
    let current = state.nodes.get(nodeId);
    const seen = new Set();
    while (current !== undefined && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.kind === 'topic') return current;
        current = current.parentId === null || current.parentId === undefined
            ? undefined
            : state.nodes.get(current.parentId);
    }
    return null;
}

/** 主题是否已关闭（完成/放弃）。 */
export function isClosedTopic(topic) {
    return topic !== null && topic !== undefined
        && (topic.status === 'done' || topic.status === 'abandoned');
}

/**
 * 文本是否像推理旁白/过程计划。
 * 只做保守判定：命中明确开头/计划句式，或英文命令式且没有问号/中文疑问词。
 */
function isPlanLikeText(value) {
    if (PROCESS_LEAD_PATTERN.test(value)) return true;
    if (META_LEAD_PATTERN.test(value)) return true;
    if (FIRST_PERSON_PLAN_PATTERN.test(value)) return true;
    if (PLANNING_PHRASE_PATTERN.test(value)) return true;
    if (FRAGMENT_LEAD_PATTERN.test(value)) return true;
    if (QUESTION_START_PATTERN.test(value)) return false;
    if (CJK_INTERROGATIVE_PATTERN.test(value)) return false;
    return IMPERATIVE_EN_PATTERN.test(value) && !/[?？]/u.test(value);
}

export function isReasoningNoiseText(text) {
    const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
    if (value === '') return true;
    // 先判疑问句：But/Also/Interesting 等口语开头不应把真正的提问送进计划句门。
    if (isQuestionText(value)) return false;
    if (isPlanLikeText(value)) return true;
    if (QUESTION_START_PATTERN.test(value)) return false;
    if (CJK_INTERROGATIVE_PATTERN.test(value)) return false;
    if (TOOL_TEXT_PATTERN.test(value) && !/[?？]/u.test(value)) return true;
    return false;
}

/**
 * auto hypothesis 是否有假设味：推测语气/条件/因果解释。
 * 纯观察、计算结果、测试断言通常没有这些信号，应归为推理细节而不是待验证假设。
 */
export function isSubstantiveHypothesisText(text) {
    const value = String(text ?? '').trim();
    if (value === '') return false;
    return HYPOTHESIS_SIGNAL_PATTERN.test(value);
}

/**
 * 是否「有内容的」未决：人工写入、blocker、明确的疑问句、有重复命中、已有细节子节点。
 * 这些节点即使落在已关闭主题下也保留，避免误伤真正的研究问题。
 */
export function isSubstantiveOpenNode(state, node) {
    if (node === null || node === undefined) return false;
    if (hasBlockerTag(node)) return true;
    if (node.origin !== 'auto') return true;
    // 被分类成 question 的陈述句本身就是误分类，即使有子节点/重复命中也不算实质未决。
    if (node.kind === 'question') {
        if (!isQuestionText(node.title)) return false;
        // cleanTitle 会去掉末尾问号，不能用「结尾是否有问号」来判断英文问句。
        return true;
    }
    if (node.kind === 'hypothesis' && !isSubstantiveHypothesisText(node.title)) return false;
    if ((node.hits ?? 1) > 1) return true;
    if (childrenOf(state, node.id).length > 0) return true;
    const title = String(node.title ?? '');
    if (/[?？]\s*$/u.test(title)) return true;
    if (CJK_INTERROGATIVE_PATTERN.test(title)) return true;
    return false;
}

/** 自动提取的推理旁白：仅 origin=auto；question 必须像疑问句，hypothesis 必须有假设信号。 */
export function isReasoningNoiseNode(state, node) {
    if (node === null || node === undefined || node.origin !== 'auto') return false;
    if (hasBlockerTag(node)) return false;
    const title = String(node.title ?? '').replace(/\s+/gu, ' ').trim();
    // 明确疑问句优先于「过程旁白」判定，避免 But/Also/Interesting 开头的真问题被丢弃。
    if (node.kind === 'question' && isQuestionText(title)) return false;
    if (isPlanLikeText(title)) return true;
    if (node.kind === 'question' && !isQuestionText(title)) return true;
    if (node.kind === 'hypothesis' && !isSubstantiveHypothesisText(title)) return true;
    if ((node.hits ?? 1) > 1) return false;
    if (childrenOf(state, node.id).length > 0) return false;
    return false;
}

/**
 * 是否值得放进「未决」首屏：直接挂在 topic/step/goal 下的未决、人工写入、或带 blocker 标签。
 * step/goal 是时间线/根结构，不是想法节点；旧图没有 topic 时也必须可见。
 * 更深的推理细节（挂在想法节点下）留给树面板，避免把每个思考碎片都算成待办。
 */
export function isActionableOpenNode(state, node) {
    if (node === null || node === undefined) return false;
    if (node.origin !== 'auto') return true;
    if (hasBlockerTag(node)) return true;
    const parent = node.parentId === null || node.parentId === undefined ? undefined : state.nodes.get(node.parentId);
    // step/goal 是时间线/根结构，不是想法节点：直接挂在它们下面的未决是「未归档」，
    // 旧图没有 topic 时也必须进首屏，否则会出现「open:44 / 未决（0）」。
    return parent === undefined || parent.kind === 'topic' || parent.kind === 'step' || parent.kind === 'goal';
}

/**
 * 分类一个未决节点：
 *  - noise：推理旁白/工具计划，建议收敛；
 *  - stale-topic：挂在已完成/已放弃主题下，且不是有内容的未决；
 *  - current：仍值得展示。
 */
export function classifyOpenNode(state, node) {
    if (!isOpenNode(node)) return null;
    const topic = nearestTopic(state, node.parentId ?? node.id);
    // 先判主题生命周期：同样一条噪音，挂在已关闭主题下更准确的标签是「陈旧未决」。
    if (isClosedTopic(topic) && !isSubstantiveOpenNode(state, node)) {
        return {
            state: 'stale-topic',
            topic,
            reason: `主题 ${topic.id} 已${topic.status === 'done' ? '完成' : '放弃'}，未决项转为历史`,
        };
    }
    if (isReasoningNoiseNode(state, node)) {
        return { state: 'noise', topic, reason: '推理旁白或工具计划，不是待研究问题' };
    }
    return { state: 'current', topic, reason: '' };
}

/** 未决排序分：人工/有细节/阻塞项优先，其次按最近更新。 */
export function openNodeImportance(state, node) {
    let score = 0;
    if (node.origin !== 'auto') score += 10;
    if (node.kind === 'decision') score += 2;
    if (node.kind === 'hypothesis') score += 1;
    if (childrenOf(state, node.id).length > 0) score += 3;
    if ((node.hits ?? 1) > 1) score += Math.min(3, node.hits);
    if (Array.isArray(node.tags) && node.tags.includes('blocker')) score += 5;
    return score;
}

/**
 * 收集当前未决项，并把噪音/陈旧项折叠成计数。
 * @param {object} state
 * @param {{sessionId?: string|null, limit?: number}} [options]
 */
export function collectOpenItems(state, options = {}) {
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    const limit = Number.isInteger(options.limit) ? Math.max(1, options.limit) : 8;
    const visible = [];
    const noise = [];
    const stale = [];
    const details = [];
    for (const node of state.nodes.values()) {
        if (!isOpenNode(node)) continue;
        if (sessionId !== null && node.sessionId !== sessionId) continue;
        const classification = classifyOpenNode(state, node);
        if (classification === null) continue;
        if (classification.state === 'noise') {
            noise.push({ node, ...classification });
        } else if (classification.state === 'stale-topic') {
            stale.push({ node, ...classification });
        } else if (!isActionableOpenNode(state, node)) {
            details.push({ node, ...classification });
        } else {
            visible.push({ node, ...classification });
        }
    }
    visible.sort((a, b) => openNodeImportance(state, b.node) - openNodeImportance(state, a.node)
        || String(b.node.updatedAt ?? '').localeCompare(String(a.node.updatedAt ?? '')));
    return {
        total: visible.length + noise.length + stale.length + details.length,
        visible: visible.slice(0, limit),
        visibleCount: visible.length,
        hiddenCount: noise.length + stale.length + details.length,
        noiseCount: noise.length,
        staleCount: stale.length,
        detailCount: details.length,
        noise,
        stale,
        details,
    };
}

/**
 * 生成未决收敛计划（纯函数，不写图）：
 *  - 自动推理旁白 → status=abandoned + auto-curated/reasoning-noise + archived；
 *  - 已关闭主题下的非实质未决 → status=abandoned + auto-curated/stale-topic + archived；
 *  - 主题直接叶根超过宽度时，隐藏最旧的自动提取已完成/已放弃叶根（status 不变；人工项保留）。
 *
 * 返回的 changes 可直接交给宿主逐条 updateNode；全部保留节点，不删除。
 *
 * @param {object} state
 * @param {{maxWidth?: number}} [options]
 */
export function planOpenCleanup(state, options = {}) {
    const maxWidth = Number.isInteger(options.maxWidth) ? Math.max(1, options.maxWidth) : 9;
    const changes = [];
    const changed = new Set();
    const stats = { openBefore: 0, noise: 0, staleTopic: 0, hiddenLeaves: 0, openAfter: 0 };

    for (const node of state.nodes.values()) {
        if (!isOpenNode(node)) continue;
        stats.openBefore += 1;
        // 显式 blocker 即使标题像计划句也保留，交给人工裁决。
        if (hasBlockerTag(node)) continue;
        const classification = classifyOpenNode(state, node);
        if (classification === null || classification.state === 'current') continue;
        const tags = Array.isArray(node.tags) ? [...node.tags] : [];
        if (!tags.includes(AUTO_CURATED_TAG)) tags.push(AUTO_CURATED_TAG);
        if (classification.state === 'noise' && !tags.includes(NOISE_TAG)) tags.push(NOISE_TAG);
        if (classification.state === 'stale-topic' && !tags.includes(STALE_TOPIC_TAG)) tags.push(STALE_TOPIC_TAG);
        if (!tags.includes('archived')) tags.push('archived');
        const summary = typeof node.summary === 'string' ? node.summary : '';
        changes.push({
            id: node.id,
            action: 'abandon',
            kind: node.kind,
            title: node.title,
            status: 'abandoned',
            tags,
            summary: `${summary === '' ? '' : `${summary}\n\n`}自动收敛：${classification.reason}`,
            reason: classification.reason,
        });
        changed.add(node.id);
        if (classification.state === 'noise') stats.noise += 1;
        else stats.staleTopic += 1;
    }

    // 平衡：只隐藏已完成/已放弃的叶根，优先最旧的；真正的 open 叶根不动。
    for (const topic of state.nodes.values()) {
        if (topic.kind !== 'topic') continue;
        const leaves = childrenOf(state, topic.id).filter((node) => isLeafRootKind(node.kind));
        let visible = leaves.filter((node) => !changed.has(node.id)
            && !(Array.isArray(node.tags) && node.tags.includes('archived')));
        if (visible.length <= maxWidth) continue;
        // 只压缩自动提取的叶根；人工写入的完成项可能仍要回看，不因宽度水位线被隐藏。
        const hideable = visible
            .filter((node) => node.origin === 'auto'
                && (node.status === 'done' || node.status === 'abandoned' || changed.has(node.id)))
            .sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')));
        for (const node of hideable) {
            if (visible.length <= maxWidth) break;
            if (changed.has(node.id)) continue;
            const tags = Array.isArray(node.tags) ? [...node.tags] : [];
            if (tags.includes('archived')) continue;
            tags.push('archived');
            if (!tags.includes(AUTO_CURATED_TAG)) tags.push(AUTO_CURATED_TAG);
            changes.push({
                id: node.id,
                action: 'hide',
                kind: node.kind,
                title: node.title,
                status: node.status,
                tags,
                summary: node.summary,
                reason: `主题 ${topic.id} 可见叶根超过 ${maxWidth}，隐藏已完成/已放弃项`,
            });
            changed.add(node.id);
            visible = visible.filter((item) => item.id !== node.id);
            stats.hiddenLeaves += 1;
        }
    }

    stats.openAfter = stats.openBefore - stats.noise - stats.staleTopic;
    return { changes, stats, maxWidth };
}
