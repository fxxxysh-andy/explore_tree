/**
 * 可选的 LLM 辅助提取：把一轮推理交给宿主已注册的模型，换回结构化 claim。
 *
 * 设计约束：
 * - 只有显式配置 `llm.enabled` + `llm.provider` + `llm.model` 才会被调用，默认零额外请求；
 * - 调用是轮末异步旁路，不阻塞事件摄取；失败只记日志，不影响确定性提取；
 * - 模型只做「语义判断」（哪些想法值得成为节点、彼此什么关系），落库仍走指纹去重。
 *
 * 宿主服务：`ctx.llm`（@deepseek-ai/dsh-llm 的 LlmRuntime）。这里不 import 该包：
 * 插件是 link 安装的独立包，运行期只依赖注入进来的服务对象。
 *
 * @module dsh-explore-tree/host/llm
 */
import { randomUUID } from 'node:crypto';

/** 允许 LLM 产出的节点类型（不含 goal/step/artifact/action）。 */
export const LLM_CLAIM_KINDS = ['hypothesis', 'evidence', 'decision', 'conclusion', 'dead_end', 'question'];

const KIND_LABEL = {
    hypothesis: '假设',
    evidence: '证据',
    decision: '决策',
    conclusion: '结论',
    dead_end: '死路',
    question: '问题',
};

export const LLM_SYSTEM_PROMPT = [
    '你是研究轨迹提取器，负责从一轮 AI 推理中挑出真正有信息量的想法，组成研究树的节点。',
    '你只输出 JSON，不要解释、不要 Markdown 代码块。',
].join('\n');

/**
 * 生成本轮提取提示词。
 * @param {{intent?: string, reasoning?: string, claims?: Array<{id:string,kind:string,title:string}>, maxClaims?: number, maxInputChars?: number}} input
 * @returns {string}
 */
export function buildExtractPrompt(input) {
    const maxClaims = input.maxClaims ?? 6;
    const maxInputChars = input.maxInputChars ?? 12000;
    const intent = typeof input.intent === 'string' && input.intent.trim() !== '' ? input.intent.trim().slice(0, 400) : '（未捕获）';
    const reasoning = clipMiddle(String(input.reasoning ?? ''), maxInputChars);
    const known = Array.isArray(input.claims) ? input.claims.slice(0, 24) : [];
    const knownLines = known.map((claim) => `- ${claim.id} ${claim.kind}: ${claim.title}`);
    return [
        '## 本轮用户意图',
        intent,
        '',
        knownLines.length > 0 ? '## 本轮已提取的节点（可作为父节点 parentId）' : '## 本轮已提取的节点',
        knownLines.length > 0 ? knownLines.join('\n') : '（无）',
        '',
        '## 推理摘录',
        reasoning,
        '',
        '## 输出格式',
        `{"claims":[{"kind":"hypothesis|evidence|decision|conclusion|dead_end|question","title":"…","summary":"…","parentId":"n123"}]}`,
        '',
        '## 规则',
        `1. 最多 ${maxClaims} 条；没有值得保留的想法就输出 {"claims":[]}。`,
        '2. kind 只能取上面列出的六种：提出可验证判断=hypothesis；支撑/反驳判断的事实=evidence；做出取舍=decision；收敛结论=conclusion；确认走不通=dead_end；仍需回答的问题=question。',
        '3. title ≤ 40 个字符，具体可检索；不要写「继续分析」「让我看看」这类过程旁白。',
        '4. summary ≤ 120 字，写清依据或结论要点，不要复述标题。',
        '5. parentId 可选，只能引用上面列出的节点 id；省略表示挂在当前轮次下。',
        '6. 不要重复「已提取的节点」里已有的想法。',
    ].join('\n');
}

/**
 * 调用宿主的 llm 服务，收集文本回复。
 * @param {{llm: object, provider: string, model: string, prompt: string, system?: string, maxTokens?: number, timeoutMs?: number, purpose?: string}} options
 * @returns {Promise<string>}
 */
export async function callLlmText(options) {
    const { llm, provider, model } = options;
    if (llm === null || typeof llm !== 'object' || typeof llm.prepareCall !== 'function') {
        throw new Error('宿主未提供可用的 llm 服务');
    }
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
        throw new Error('llm.provider 与 llm.model 必须同时配置');
    }
    const timeoutMs = options.timeoutMs ?? 20000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const maxTokens = options.maxTokens ?? 1200;
        const call = await llm.prepareCall({ provider, model, maxTokens }, controller.signal);
        const messages = [{
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: options.prompt }],
            source: { kind: 'explore-tree-llm' },
        }];
        let text = '';
        let finish = null;
        const stream = call.stream({
            ...call.config,
            messages,
            ...(typeof options.system === 'string' && options.system !== '' ? { system: options.system } : {}),
            purpose: options.purpose ?? 'explore-tree-extract',
            signal: controller.signal,
        });
        for await (const chunk of stream) {
            if (chunk === null || typeof chunk !== 'object') continue;
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
            else if (chunk.type === 'finish') finish = chunk.reason ?? null;
        }
        if (finish !== null && typeof finish === 'object') {
            if (finish.kind === 'error') throw new Error(finish.failure?.message ?? 'LLM 调用失败');
            if (finish.kind === 'aborted') throw new Error('LLM 调用被取消');
        }
        return text;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 解析模型返回的 JSON；容错代码块/前后缀，过滤非法条目。
 * @param {string} text
 * @param {number} [maxClaims]
 * @returns {Array<{kind: string, title: string, summary: string, parentId: string|null}>}
 */
export function parseExtractResponse(text, maxClaims = 6) {
    if (typeof text !== 'string' || text.trim() === '') return [];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced === null ? text : fenced[1];
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    let parsed;
    try {
        parsed = JSON.parse(body.slice(start, end + 1));
    } catch {
        return [];
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.claims)) return [];
    const out = [];
    for (const raw of parsed.claims) {
        if (raw === null || typeof raw !== 'object') continue;
        if (!LLM_CLAIM_KINDS.includes(raw.kind)) continue;
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        if (title === '') continue;
        const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
        const parentId = typeof raw.parentId === 'string' && /^n\d+$/u.test(raw.parentId) ? raw.parentId : null;
        out.push({
            kind: raw.kind,
            title: title.slice(0, 80),
            summary: summary.slice(0, 400),
            parentId,
            label: KIND_LABEL[raw.kind] ?? raw.kind,
        });
        if (out.length >= maxClaims) break;
    }
    return out;
}

/**
 * 一次提取：提示词 → 模型 → 解析。
 * @param {{llm: object, config: {provider?: string, model?: string, maxClaims?: number, maxInputChars?: number, timeoutMs?: number, maxOutputTokens?: number}, intent?: string, reasoning: string, claims?: Array<{id:string,kind:string,title:string}>}} input
 */
export async function extractClaimsWithLlm(input) {
    const config = input.config ?? {};
    const prompt = buildExtractPrompt({
        intent: input.intent,
        reasoning: input.reasoning,
        claims: input.claims,
        maxClaims: config.maxClaims,
        maxInputChars: config.maxInputChars,
    });
    const text = await callLlmText({
        llm: input.llm,
        provider: config.provider,
        model: config.model,
        prompt,
        system: LLM_SYSTEM_PROMPT,
        maxTokens: config.maxOutputTokens,
        timeoutMs: config.timeoutMs,
    });
    return parseExtractResponse(text, config.maxClaims ?? 6);
}

/**
 * 生成 topic 摘要用的提示词：只读子节点标题/摘要，不允许补充新事实。
 *
 * @param {{title: string, digest?: string|null}} topic
 * @param {Array<{kind: string, title: string, digest?: string|null}>} children
 */
export function buildDigestPrompt(topic, children) {
    const lines = [
        `用不超过 120 个汉字总结研究主题「${topic.title}」当前的进展。`,
        '只能使用下面的子节点信息，不得补充新事实；输出纯文本摘要，不要 JSON、不要标题、不要列表符号。',
    ];
    for (const [index, child] of children.entries()) {
        const digest = typeof child.digest === 'string' && child.digest !== '' ? `（${child.digest}）` : '';
        lines.push(`${index + 1}. [${child.kind}] ${child.title}${digest}`);
    }
    return lines.join('\n');
}

/**
 * 让宿主模型生成 topic digest（可选，默认关闭）。失败由调用方回退模板摘要。
 *
 * @param {{llm: object, config: object, topic: object, children: object[]}} input
 * @returns {Promise<string>}
 */
export async function summarizeTopicWithLlm(input) {
    const config = input.config ?? {};
    const prompt = buildDigestPrompt(input.topic, input.children ?? []);
    const text = await callLlmText({
        llm: input.llm,
        provider: config.provider,
        model: config.model,
        prompt,
        system: '你是研究树的摘要器：只输出一段不超过 120 字的摘要正文。',
        maxTokens: Math.min(Number.isInteger(config.maxOutputTokens) ? config.maxOutputTokens : 1200, 600),
        timeoutMs: config.timeoutMs,
        purpose: 'explore-tree-digest',
    });
    const cleaned = String(text ?? '')
        .replace(/```[a-z]*\n?/giu, '')
        .replace(/```/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
    return cleaned.slice(0, 120);
}

/** 保留头尾的截断，避免把「结论在最后」的推理丢掉。 */function clipMiddle(text, limit) {
    if (typeof text !== 'string') return '';
    if (limit <= 0 || text.length <= limit) return text;
    const head = Math.floor(limit * 0.7);
    const tail = limit - head;
    return `${text.slice(0, head)}\n…（中间省略 ${text.length - limit} 字）…\n${text.slice(-tail)}`;
}
