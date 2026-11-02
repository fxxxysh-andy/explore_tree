/**
 * 节点/关系的领域常量与输入归一化。
 *
 * 这里不做 I/O，也不依赖宿主；graph.js（结构操作）与 store.js（持久化）都建立在它上面。
 *
 * @module core/model
 */

/** 节点类型。step 表示「一轮研究活动」，action 是其中一次工具动作；topic 是摘要主干（v0.13）。 */
export const KINDS = Object.freeze([
    'goal',
    'topic',
    'question',
    'hypothesis',
    'step',
    'action',
    'evidence',
    'decision',
    'dead_end',
    'conclusion',
    'artifact',
    'note',
]);

/** 摘要主干的 kind。 */
export const TRUNK_KIND = 'topic';

/** 可以充当研究叶根的想法类型（叶根下挂探索细节）。 */
export const LEAF_ROOT_KINDS = Object.freeze(['question', 'hypothesis', 'decision', 'conclusion', 'dead_end']);

/** @param {unknown} value */
export function isLeafRootKind(value) {
    return LEAF_ROOT_KINDS.includes(value);
}

/** 摘要来源：模板合成 / LLM 生成 / 人工编辑。 */
export const DIGEST_SOURCES = Object.freeze(['template', 'llm', 'human']);

/** @param {unknown} value @param {string|null} [fallback] */
export function normalizeDigestSource(value, fallback = null) {
    return DIGEST_SOURCES.includes(value) ? value : fallback;
}

/** 写入者 id 的最大长度。 */
export const MAX_ACTOR = 120;

/** 写入者 id：去空白、截断；空值归一为 null。 */
export function normalizeActor(value) {
    const text = clampText(value, MAX_ACTOR).trim();
    return text === '' ? null : text;
}

/** 优先级（多 agent 排序用）。 */
export const PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);

/** @param {unknown} value */
export function normalizePriority(value) {
    return PRIORITIES.includes(value) ? value : null;
}

/** 服务端状态。abandoned 同时覆盖「失败」与「已放弃的死路」。 */
export const STATUSES = Object.freeze(['open', 'active', 'done', 'abandoned']);

/** 跨分支关系（树关系只由 parentId 表达）。 */
export const EDGE_KINDS = Object.freeze([
    'supports',
    'contradicts',
    'refines',
    'depends',
    'replaces',
    'duplicates',
    'continues',
    'related',
]);

/** 引用类型。 */
export const REF_KINDS = Object.freeze(['url', 'file', 'tool_call', 'artifact', 'session', 'message']);

/** 标题/摘要的硬上限（字符）。UI 与工具输出另有更小的展示上限。 */
export const MAX_TITLE = 200;
export const MAX_SUMMARY = 8000;
export const MAX_TAG = 48;
export const MAX_REF_VALUE = 2000;
/** 摘要主干 digest 的硬上限（展示建议 120 字）。 */
export const MAX_DIGEST = 240;

/** 合法 kind；非法值降级为 note（不抛错，提取器的容错边界）。 */
export function normalizeKind(value, fallback = 'note') {
    return KINDS.includes(value) ? value : fallback;
}

/** 合法 status；非法值降级为 open。 */
export function normalizeStatus(value, fallback = 'open') {
    return STATUSES.includes(value) ? value : fallback;
}

/** 合法关系；非法值降级为 related。 */
export function normalizeEdgeKind(value, fallback = 'related') {
    return EDGE_KINDS.includes(value) ? value : fallback;
}

/** 置信度：0..1 的数，其余为 null。 */
export function normalizeConfidence(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return Math.round(value * 100) / 100;
}

/**
 * 压平空白 + 截断。
 *
 * 研究图是给人看与给模型读的短文本：不保留换行的值会被压成一行；summary 保留换行。
 *
 * @param {unknown} value
 * @param {number} max
 * @param {{keepNewlines?: boolean}} [options]
 */
export function clampText(value, max, options = {}) {
    if (value === null || value === undefined) return '';
    let text = String(value).replace(/\r\n?/g, '\n');
    if (!options.keepNewlines) {
        text = text.replace(/\s+/g, ' ').trim();
    } else {
        text = text
            .split('\n')
            .map((line) => line.replace(/[ \t]+$/g, ''))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
    if (max > 0 && text.length > max) {
        text = `${text.slice(0, Math.max(0, max - 1))}…`;
    }
    return text;
}

/** 标签归一化：去空、去重、截断、最多 24 个。 */
export function normalizeTags(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const item of value) {
        const tag = clampText(item, MAX_TAG).trim();
        if (tag === '' || seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
        if (out.length >= 24) break;
    }
    return out;
}

/** 引用归一化：只收合法 kind，值截断，去重（kind+value）。 */
export function normalizeRefs(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const item of value) {
        if (item === null || typeof item !== 'object') continue;
        const kind = REF_KINDS.includes(item.kind) ? item.kind : null;
        const refValue = clampText(item.value, MAX_REF_VALUE).trim();
        if (kind === null || refValue === '') continue;
        const key = `${kind}\u0000${refValue}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ref = { kind, value: refValue };
        const label = clampText(item.label, MAX_TITLE).trim();
        if (label !== '') ref.label = label;
        out.push(ref);
        if (out.length >= 32) break;
    }
    return out;
}
