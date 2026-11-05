/**
 * 大模型研究图解析：把快照压成一份紧凑事实，生成提示词，解析模型返回的 JSON。
 *
 * 设计约束：
 * - 纯函数，不读文件、不调网络；宿主服务负责缓存与模型调用；
 * - 输入只包含分析必需的事实（目标/主题/待办/死路/最近动态/前端建议），并做硬性长度上限；
 * - 模型只做归纳与建议，不写图；nodeId 必须来自输入，避免把幻觉节点带进 UI。
 *
 * @module dsh-explore-tree/core/analyze
 */

export const ANALYSIS_FINDING_KINDS = ['progress', 'blocker', 'risk', 'insight'];

export const ANALYSIS_SYSTEM_PROMPT = [
    '你是研究轨迹分析器，负责阅读一张 AI 研究图的快照，总结进展、阻塞、风险与下一步。',
    '只输出 JSON，不要解释、不要 Markdown 代码块。',
    '不得编造输入里不存在的节点 id 或数字。',
].join('\n');

const FINDING_LIMIT = 6;
const RECOMMENDATION_LIMIT = 5;
const NODE_ID_RE = /^n\d+$/u;

function text(value, limit) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
}

function when(node) {
    const value = node?.updatedAt ?? node?.createdAt ?? '';
    return typeof value === 'string' ? value : '';
}

function phaseOf(node) {
    if (typeof node?.phase === 'string' && node.phase !== '') return node.phase;
    if (node?.status === 'done') return 'completed';
    if (node?.status === 'abandoned') return 'dead_end';
    return 'todo';
}

function byUpdatedDesc(a, b) {
    return when(b).localeCompare(when(a));
}

/**
 * 把浏览器快照压成模型可读的紧凑事实。
 * @param {object} snapshot GET /explore-tree/snapshot 的返回（或同形对象）
 * @param {{maxInputChars?: number}} [options]
 */
export function buildAnalysisInput(snapshot, options = {}) {
    const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
    const digest = snapshot?.digest ?? null;
    const byId = new Map();
    const openChildren = new Map();
    for (const node of nodes) {
        if (node === null || typeof node !== 'object' || typeof node.id !== 'string') continue;
        byId.set(node.id, node);
        openChildren.set(node.id, 0);
    }
    for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue;
        if (node.parentId === null || node.parentId === undefined || !byId.has(node.parentId)) continue;
        openChildren.set(node.parentId, (openChildren.get(node.parentId) ?? 0) + 1);
    }
    const goals = nodes
        .filter((node) => node.kind === 'goal')
        .sort(byUpdatedDesc)
        .slice(0, 6)
        .map((node) => ({
            id: node.id,
            title: text(node.title, 120),
            phase: phaseOf(node),
            children: openChildren.get(node.id) ?? 0,
        }));
    const topics = nodes
        .filter((node) => node.kind === 'topic')
        .sort(byUpdatedDesc)
        .slice(0, 16)
        .map((node) => ({
            id: node.id,
            title: text(node.title, 120),
            digest: text(node.digest, 180),
            phase: phaseOf(node),
            children: openChildren.get(node.id) ?? 0,
        }));
    const openFromSnapshot = Array.isArray(snapshot?.open?.items)
        ? snapshot.open.items.slice(0, 12).map((node) => ({
            id: node?.id,
            kind: node?.kind,
            title: text(node?.title, 120),
            phase: phaseOf(node),
        })).filter((item) => typeof item.id === 'string')
        : [];
    const open = openFromSnapshot.length > 0
        ? openFromSnapshot
        : nodes.filter((node) => phaseOf(node) === 'todo')
            .sort(byUpdatedDesc)
            .slice(0, 12)
            .map((node) => ({ id: node.id, kind: node.kind, title: text(node.title, 120), phase: 'todo' }));
    const doing = nodes
        .filter((node) => phaseOf(node) === 'doing')
        .sort(byUpdatedDesc)
        .slice(0, 8)
        .map((node) => ({ id: node.id, kind: node.kind, title: text(node.title, 120) }));
    const deadEnds = nodes
        .filter((node) => phaseOf(node) === 'dead_end')
        .sort(byUpdatedDesc)
        .slice(0, 8)
        .map((node) => ({ id: node.id, title: text(node.title, 120) }));
    const recent = nodes
        .slice()
        .sort(byUpdatedDesc)
        .slice(0, 12)
        .map((node) => ({ id: node.id, kind: node.kind, title: text(node.title, 120), phase: phaseOf(node), at: when(node) }));
    const frontier = Array.isArray(snapshot?.frontier?.suggestions)
        ? snapshot.frontier.suggestions.slice(0, 6).map((item) => ({
            type: item?.type,
            title: text(item?.title, 120),
            reason: text(item?.reason, 160),
            nodeId: typeof item?.nodeId === 'string' ? item.nodeId : undefined,
            targetId: typeof item?.targetId === 'string' ? item.targetId : undefined,
        }))
        : [];
    const stats = snapshot?.stats ?? {};
    const input = {
        workspace: text(snapshot?.workspace?.name, 80),
        generatedAt: typeof snapshot?.generatedAt === 'string' ? snapshot.generatedAt : '',
        totals: {
            nodes: nodes.length,
            edges: Array.isArray(snapshot?.edges) ? snapshot.edges.length : 0,
            sessions: Array.isArray(snapshot?.sessions) ? snapshot.sessions.length : 0,
        },
        digest: digest === null || typeof digest !== 'object'
            ? null
            : {
                scope: digest.scope === 'session' ? 'session' : 'workspace',
                total: digest.total ?? nodes.length,
                phases: digest.phaseCounts ?? {},
                todo: digest.todo ?? null,
                completed: digest.completed ?? 0,
                deadEnd: digest.deadEnd ?? 0,
            },
        kindCounts: stats.byKind ?? {},
        goals,
        topics,
        open,
        doing,
        deadEnds,
        recent,
        frontier,
    };
    return trimInput(input, options.maxInputChars ?? 12000);
}

/** 超长时先丢低价值列表，再缩主题/待办条数；保证提示词不会把整张图塞给模型。 */
function trimInput(input, maxInputChars) {
    const limit = Number.isFinite(maxInputChars) ? Math.max(2000, Math.floor(maxInputChars)) : 12000;
    const steps = [
        () => { if (input.recent.length > 6) { input.recent = input.recent.slice(0, 6); return true; } return false; },
        () => { if (input.deadEnds.length > 4) { input.deadEnds = input.deadEnds.slice(0, 4); return true; } return false; },
        () => { if (input.doing.length > 4) { input.doing = input.doing.slice(0, 4); return true; } return false; },
        () => { if (input.frontier.length > 3) { input.frontier = input.frontier.slice(0, 3); return true; } return false; },
        () => { if (input.topics.length > 8) { input.topics = input.topics.slice(0, 8); return true; } return false; },
        () => { if (input.open.length > 8) { input.open = input.open.slice(0, 8); return true; } return false; },
        () => { if (input.topics.length > 5) { input.topics = input.topics.slice(0, 5); return true; } return false; },
        () => { if (input.open.length > 5) { input.open = input.open.slice(0, 5); return true; } return false; },
        () => { if (input.recent.length > 0) { input.recent = []; return true; } return false; },
        () => { if (input.deadEnds.length > 0) { input.deadEnds = []; return true; } return false; },
        () => { if (input.doing.length > 0) { input.doing = []; return true; } return false; },
        () => { if (input.frontier.length > 0) { input.frontier = []; return true; } return false; },
    ];
    let index = 0;
    while (JSON.stringify(input).length > limit && index < steps.length) {
        if (!steps[index]()) index += 1;
        else index = 0;
    }
    return input;
}

/**
 * 生成解析提示词。
 * @param {ReturnType<typeof buildAnalysisInput>} input
 * @param {{maxInputChars?: number}} [options]
 */
export function buildAnalysisPrompt(input, options = {}) {
    const limit = Number.isFinite(options.maxInputChars) ? Math.max(2000, Math.floor(options.maxInputChars)) : 12000;
    let facts = JSON.stringify(input);
    if (facts.length > limit) {
        facts = facts.slice(0, limit) + '\n…[事实已截断]';
    }
    return [
        '## 研究图事实（JSON）',
        facts,
        '',
        '## 输出格式',
        '{"headline":"一句话结论（≤24字）","summary":"整体判断（≤120字）","findings":[{"kind":"progress|blocker|risk|insight","title":"≤20字","detail":"≤120字","nodeIds":["n123"]}],"recommendations":[{"title":"≤20字","detail":"≤120字","nodeIds":["n123"]}]}',
        '',
        '## 规则',
        '1. 只依据上面的 JSON 归纳，不补新事实；数字要与输入一致。',
        '2. findings 3-6 条：progress=正在推进，blocker=被阻塞/死路，risk=风险或隐患，insight=值得注意的结论。',
        '3. recommendations 2-5 条，写清「做什么 + 为什么」，优先能继续推进目标的动作。',
        '4. nodeIds 只能引用 JSON 里出现过的节点 id；没有对应节点就省略该字段或给空数组。',
        '5. 中文输出；不要 Markdown 代码块、不要解释、不要输出 JSON 以外的内容。',
    ].join('\n');
}

function nodeIdsOf(value, known) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const raw of value) {
        if (typeof raw !== 'string' || !NODE_ID_RE.test(raw)) continue;
        if (known !== null && !known.has(raw)) continue;
        if (!out.includes(raw)) out.push(raw);
        if (out.length >= 3) break;
    }
    return out;
}

/**
 * 解析模型返回；容错代码块与前后缀，过滤非法条目。
 * @param {string} raw
 * @param {{nodeIds?: Iterable<string>}} [options] 允许引用的节点 id 集合（防幻觉）
 * @returns {{headline:string, summary:string, findings:Array<object>, recommendations:Array<object>}|null}
 */
export function parseAnalysisResponse(raw, options = {}) {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
    const body = fenced === null ? raw : fenced[1];
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let parsed;
    try {
        parsed = JSON.parse(body.slice(start, end + 1));
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const known = options.nodeIds === undefined || options.nodeIds === null ? null : new Set(options.nodeIds);
    const headline = text(parsed.headline, 60);
    const summary = text(parsed.summary, 600);
    const findings = [];
    if (Array.isArray(parsed.findings)) {
        for (const item of parsed.findings) {
            if (item === null || typeof item !== 'object') continue;
            if (!ANALYSIS_FINDING_KINDS.includes(item.kind)) continue;
            const title = text(item.title, 60);
            if (title === '') continue;
            findings.push({
                kind: item.kind,
                title,
                detail: text(item.detail, 300),
                nodeIds: nodeIdsOf(item.nodeIds, known),
            });
            if (findings.length >= FINDING_LIMIT) break;
        }
    }
    const recommendations = [];
    if (Array.isArray(parsed.recommendations)) {
        for (const item of parsed.recommendations) {
            if (item === null || typeof item !== 'object') continue;
            const title = text(item.title, 60);
            if (title === '') continue;
            recommendations.push({
                title,
                detail: text(item.detail, 300),
                nodeIds: nodeIdsOf(item.nodeIds, known),
            });
            if (recommendations.length >= RECOMMENDATION_LIMIT) break;
        }
    }
    if (headline === '' && summary === '' && findings.length === 0 && recommendations.length === 0) return null;
    return { headline, summary, findings, recommendations };
}
