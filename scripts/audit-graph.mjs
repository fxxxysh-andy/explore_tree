#!/usr/bin/env node
/**
 * 研究图体检：对 `<workspace>/.explore-tree/graph.json` 跑一组可机读的断言，不改图。
 *
 *   node scripts/audit-graph.mjs [--workspace <dir>] [--json] [--no-fail]
 *
 * FAIL（退出码 1）：
 *   - 根节点不是 goal（artifact / step 成了根）；
 *   - 假 goal（标题来自注入消息：Time sampled / background job / approval policy …）；
 *   - step 标题被注入消息污染；
 *   - 同一 session+turn 出现多个 step（旧图重复）；
 *   - 父节点悬空；
 *   - topic（摘要主干）父节点不是 goal/topic、子节点不是 topic/叶根、缺 digest；
 *   - v2 图的关闭节点缺 closeReason/resolutionBy，或开放节点仍带结束原因。
 * WARN：
 *   - edges = 0（v0.8 起应有跨轮 continues 边）；
 *   - note 占全部节点 > 30%（旧图的过程旁白）；
 *   - 最大深度 < 3（树没有真正分层）；
 *   - 叶根不在 topic 下、语义节点仍挂在 step 下、主干宽度/深度/摘要长度超限；
 *   - v1 图尚未回填 closeReason/resolutionBy。
 */
import fs from 'node:fs';
import path from 'node:path';

const INJECTION_TITLE_PATTERNS = [
    /^Time sampled\b/i,
    /^background job\b/i,
    /approval policy/i,
    /^Current runtime context\b/i,
    /^Browser time zone\b/i,
    /^You are an AI agent\b/i,
    /^Time sampled while preparing\b/i,
];

const THOUGHT_KINDS = ['question', 'hypothesis', 'evidence', 'decision', 'conclusion', 'dead_end', 'note'];
const LEAF_ROOT_KINDS = ['question', 'hypothesis', 'decision', 'conclusion', 'dead_end'];
const SEMANTIC_KINDS = ['question', 'hypothesis', 'evidence', 'decision', 'dead_end', 'conclusion'];
const TRUNK_MAX_WIDTH = 9;
const TRUNK_MAX_DEPTH = 4;
const DIGEST_MAX = 120;
const CLOSE_REASONS = ['solved', 'dead_end', 'superseded', 'duplicate', 'curated', 'aborted', 'recorded', 'completed'];
const RESOLUTION_BY = ['human', 'auto', 'migrated'];

function parseArgs(argv) {
    const options = { workspace: process.cwd(), json: false, fail: true };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--workspace' && argv[i + 1] !== undefined) {
            options.workspace = path.resolve(argv[i + 1]);
            i += 1;
        } else if (arg === '--json') {
            options.json = true;
        } else if (arg === '--no-fail') {
            options.fail = false;
        } else if (arg === '--help' || arg === '-h') {
            console.log('用法: node scripts/audit-graph.mjs [--workspace <dir>] [--json] [--no-fail]');
            process.exit(0);
        }
    }
    return options;
}

function isInjectionTitle(title) {
    return INJECTION_TITLE_PATTERNS.some((pattern) => pattern.test(String(title ?? '').trim()));
}

function depthOf(node, byId, cache) {
    if (cache.has(node.id)) return cache.get(node.id);
    let depth = 0;
    let current = node;
    const seen = new Set();
    while (current !== undefined && current !== null && current.parentId !== null && current.parentId !== undefined) {
        if (seen.has(current.id)) break; // 防环
        seen.add(current.id);
        current = byId.get(current.parentId);
        depth += 1;
        if (depth > 500) break;
    }
    cache.set(node.id, depth);
    return depth;
}

function loadGraph(workspace) {
    const file = path.join(workspace, '.explore-tree', 'graph.json');
    if (!fs.existsSync(file)) return { file, graph: null };
    return { file, graph: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const options = parseArgs(process.argv.slice(2));
const { file, graph } = loadGraph(options.workspace);

if (graph === null) {
    console.error(`没有找到研究图：${file}`);
    process.exit(options.fail ? 1 : 0);
}

const nodes = Object.values(graph.nodes ?? {});
const byId = new Map(nodes.map((node) => [node.id, node]));
const rootIds = Array.isArray(graph.roots) && graph.roots.length > 0
    ? graph.roots
    : nodes.filter((node) => node.parentId === null || node.parentId === undefined).map((node) => node.id);
const edges = Array.isArray(graph.edges) ? graph.edges : [];
const byKind = {};
const byStatus = {};
const depthCache = new Map();
let maxDepth = 0;
for (const node of nodes) {
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    byStatus[node.status] = (byStatus[node.status] ?? 0) + 1;
    maxDepth = Math.max(maxDepth, depthOf(node, byId, depthCache));
}

const failures = [];
const warnings = [];

const nonGoalRoots = rootIds.filter((id) => {
    const node = byId.get(id);
    return node === undefined || node.kind !== 'goal';
});
if (nonGoalRoots.length > 0) {
    failures.push(`根不是 goal：${nonGoalRoots.map((id) => `${id}(${byId.get(id)?.kind ?? 'missing'})`).join(', ')}`);
}
const fakeGoals = nodes.filter((node) => node.kind === 'goal' && isInjectionTitle(node.title));
if (fakeGoals.length > 0) {
    failures.push(`假 goal ${fakeGoals.length} 个：${fakeGoals.map((node) => `${node.id}「${String(node.title).slice(0, 32)}」`).join('; ')}`);
}
const pollutedSteps = nodes.filter((node) => node.kind === 'step' && isInjectionTitle(node.title));
if (pollutedSteps.length > 0) {
    failures.push(`step 标题被注入消息污染 ${pollutedSteps.length} 个：${pollutedSteps.map((node) => node.id).join(', ')}`);
}
const stepGroups = new Map();
for (const node of nodes) {
    if (node.kind !== 'step') continue;
    const key = `${node.sessionId ?? '-'}|${node.turn ?? '-'}`;
    if (!stepGroups.has(key)) stepGroups.set(key, []);
    stepGroups.get(key).push(node);
}
const duplicates = [...stepGroups.entries()].filter(([, list]) => list.length > 1);
if (duplicates.length > 0) {
    failures.push(`重复 step ${duplicates.length} 组：${duplicates.map(([key, list]) => `${key}×${list.length}`).join('; ')}`);
}
const dangling = nodes.filter((node) => node.parentId !== null && node.parentId !== undefined && !byId.has(node.parentId));
if (dangling.length > 0) {
    failures.push(`父节点悬空 ${dangling.length} 个：${dangling.slice(0, 8).map((node) => node.id).join(', ')}${dangling.length > 8 ? ' …' : ''}`);
}

// ── 结束原因（P2）──
const graphVersion = Number(graph.version ?? 1);
const closedNodes = nodes.filter((node) => node.status === 'done' || node.status === 'abandoned');
const byCloseReason = {};
const byResolution = {};
for (const node of nodes) {
    if (CLOSE_REASONS.includes(node.closeReason)) byCloseReason[node.closeReason] = (byCloseReason[node.closeReason] ?? 0) + 1;
    if (RESOLUTION_BY.includes(node.resolutionBy)) byResolution[node.resolutionBy] = (byResolution[node.resolutionBy] ?? 0) + 1;
}
if (graphVersion >= 2) {
    const missingReason = closedNodes.filter((node) => !CLOSE_REASONS.includes(node.closeReason)
        || !RESOLUTION_BY.includes(node.resolutionBy));
    if (missingReason.length > 0) {
        failures.push(`v2 关闭节点缺少合法 closeReason/resolutionBy ${missingReason.length} 个：${missingReason.slice(0, 8).map((node) => node.id).join(', ')}${missingReason.length > 8 ? ' …' : ''}`);
    }
    const openWithReason = nodes.filter((node) => (node.status === 'open' || node.status === 'active')
        && (node.closeReason !== null && node.closeReason !== undefined
            || (node.resolutionBy !== null && node.resolutionBy !== undefined)));
    if (openWithReason.length > 0) {
        failures.push(`开放节点仍带结束原因 ${openWithReason.length} 个：${openWithReason.slice(0, 8).map((node) => node.id).join(', ')}${openWithReason.length > 8 ? ' …' : ''}`);
    }
} else {
    warnings.push(`graph.version=${graph.version ?? '?'}：尚未回填 closeReason/resolutionBy（运行 npm run migrate-close-reason -- --apply）`);
}

const thoughts = nodes.filter((node) => THOUGHT_KINDS.includes(node.kind));
const noteRatio = thoughts.length === 0 ? 0 : (byKind.note ?? 0) / thoughts.length;
if (edges.length === 0) warnings.push('edges = 0：v0.8 起同会话每轮应与上一轮建 continues 边；旧图不回溯补边，重启宿主后新事件才生成');
if (noteRatio > 0.3) warnings.push(`note 占想法节点 ${(noteRatio * 100).toFixed(1)}%（>30%）：旧图过程旁白偏多，面板默认折叠`);
if (maxDepth < 3 && (byKind.topic ?? 0) === 0) warnings.push(`最大深度 ${maxDepth}（<3）：树没有真正分层`);

// ── 摘要主干（v0.13 P0）──
const topics = nodes.filter((node) => node.kind === 'topic');
const kidsOf = new Map();
for (const node of nodes) {
    const parentId = node.parentId ?? null;
    if (parentId === null) continue;
    if (!kidsOf.has(parentId)) kidsOf.set(parentId, []);
    kidsOf.get(parentId).push(node);
}
for (const topic of topics) {
    const parent = topic.parentId !== null && topic.parentId !== undefined ? byId.get(topic.parentId) : undefined;
    if (parent !== undefined && parent.kind !== 'goal' && parent.kind !== 'topic') {
        failures.push(`topic ${topic.id} 的父节点是 ${parent.id}/${parent.kind}，必须是 goal/topic`);
    }
    const kids = kidsOf.get(topic.id) ?? [];
    for (const kid of kids) {
        if (kid.kind === 'topic' || LEAF_ROOT_KINDS.includes(kid.kind)) continue;
        failures.push(`topic ${topic.id} 的子节点 ${kid.id}（${kid.kind}）不是 topic/叶根`);
    }
    if (typeof topic.digest !== 'string' || topic.digest.trim() === '') {
        failures.push(`topic ${topic.id} 缺少 digest`);
    } else if (topic.digest.length > DIGEST_MAX) {
        warnings.push(`topic ${topic.id} 的 digest ${topic.digest.length} 字，超过建议 ${DIGEST_MAX}`);
    }
    if (kids.length > TRUNK_MAX_WIDTH) {
        warnings.push(`topic ${topic.id} 主干宽度 ${kids.length}，建议拆分（上限 ${TRUNK_MAX_WIDTH}）`);
    }
    const topicDepth = depthOf(topic, byId, depthCache);
    if (topicDepth > TRUNK_MAX_DEPTH) {
        warnings.push(`topic ${topic.id} 主干深度 ${topicDepth}，超过 ${TRUNK_MAX_DEPTH}`);
    }
}
if (topics.length > 0) {
    const misplacedLeafRoots = nodes.filter((node) => LEAF_ROOT_KINDS.includes(node.kind)
        && node.parentId !== null
        && node.parentId !== undefined
        && byId.get(node.parentId)?.kind !== 'topic'
        && !(node.tags ?? []).includes('leaf-root'));
    if (misplacedLeafRoots.length > 0) {
        warnings.push(`${misplacedLeafRoots.length} 个叶根不在 topic 下：${misplacedLeafRoots.slice(0, 6).map((node) => node.id).join(', ')}${misplacedLeafRoots.length > 6 ? ' …' : ''}`);
    }
}
const semanticUnderStep = nodes.filter((node) => SEMANTIC_KINDS.includes(node.kind)
    && node.parentId !== null
    && node.parentId !== undefined
    && byId.get(node.parentId)?.kind === 'step');
if (semanticUnderStep.length > 0) {
    warnings.push(`${semanticUnderStep.length} 个语义节点仍挂在 step 下（旧图迁移未完成）`);
}

const summary = {
    workspace: options.workspace,
    file,
    version: graph.version ?? null,
    nodes: nodes.length,
    edges: edges.length,
    sessions: Object.keys(graph.sessions ?? {}).length,
    roots: rootIds.length,
    maxDepth,
    topics: topics.length,
    byKind,
    byStatus,
    byCloseReason,
    byResolution,
    noteRatio: Math.round(noteRatio * 1000) / 10,
    failures,
    warnings,
    ok: failures.length === 0,
};

if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
} else {
    console.log(`研究图体检：${file}`);
    console.log(`节点 ${summary.nodes} · 边 ${summary.edges} · 会话 ${summary.sessions} · 根 ${summary.roots} · 主干 ${summary.topics} · 最大深度 ${summary.maxDepth}`);
    console.log(`kinds  ${Object.entries(byKind).map(([kind, count]) => `${kind}:${count}`).join(' ')}`);
    console.log(`status ${Object.entries(byStatus).map(([status, count]) => `${status}:${count}`).join(' ')}`);
    if (Object.keys(byCloseReason).length > 0) {
        console.log(`close  ${Object.entries(byCloseReason).map(([reason, count]) => `${reason}:${count}`).join(' ')} · by ${Object.entries(byResolution).map(([by, count]) => `${by}:${count}`).join(' ')}`);
    }
    for (const failure of failures) console.log(`FAIL  ${failure}`);
    for (const warning of warnings) console.log(`WARN  ${warning}`);
    console.log(failures.length === 0 ? '结论：PASS' : '结论：FAIL');
}

if (options.fail && failures.length > 0) process.exit(1);
