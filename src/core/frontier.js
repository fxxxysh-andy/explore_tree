/**
 * frontier：研究图的「下一步」建议引擎。
 *
 * 目标不是罗列所有可做之事，而是给出**混合**建议：
 *  - 既推进当前路径（verify / deepen / resolve），也提醒换路径（branch）与回看死路（revive）；
 *  - 既鼓励发散（建立互斥假设、探索兄弟分支），也强制收敛（consolidate / stop）；
 *  - 每个建议都带可核对的依据（节点 id），避免变成空泛口号。
 *
 * 纯函数：输入 graph state，输出结构化建议；不读文件、不调 LLM。
 *
 * @module core/frontier
 */
import { childrenOf, edgesOf, graphStats, pathToRoot, rootNodes, subtreeIds } from './graph.js';
import { isAutoCuratedNode } from './hygiene.js';

const TYPE_ORDER = Object.freeze({
    stop: 0,
    verify: 1,
    resolve: 2,
    consolidate: 3,
    branch: 4,
    deepen: 5,
    revive: 6,
    seed: 7,
});

const MAX_BRANCH_SUGGESTIONS = 2;
const MAX_REVIVE_SUGGESTIONS = 1;

/**
 * 计算建议。
 *
 * @param {object} state graph state
 * @param {{sessionId?: string|null, focusId?: string|null, limit?: number}} [options]
 */
export function computeFrontier(state, options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 8) : 5;
    const session = options.sessionId !== null && options.sessionId !== undefined
        ? state.sessions.get(options.sessionId)
        : undefined;
    const focus = resolveFocus(state, options.focusId ?? session?.activeNodeId ?? null);
    const stats = graphStats(state);
    const notes = [];
    const suggestions = [];
    const avoid = [];

    if (stats.nodes === 0) {
        return {
            focus: null,
            suggestions: [{
                type: 'seed',
                priority: 100,
                nodeId: null,
                targetId: null,
                title: '建立第一个目标',
                reason: '研究图为空：先用 explore_tree_record add 记录目标（goal），再拆出 1-2 个可验证的问题或假设。',
                basis: [],
            }],
            avoid,
            notes: ['空图：任何研究都应该先写下来目标和第一组假设，后续自动提取才有挂载点。'],
            stats,
            generatedAt: new Date().toISOString(),
        };
    }

    const openNodes = [...state.nodes.values()].filter((node) => node.status === 'open' || node.status === 'active');
    const allNodes = [...state.nodes.values()];
    const hypotheses = allNodes.filter((node) => node.kind === 'hypothesis');
    const unverified = hypotheses.filter((node) => !hasEvidence(state, node.id));
    const conflicted = hypotheses.filter((node) => hasContradiction(state, node.id));
    const deadEnds = allNodes.filter((node) => (node.kind === 'dead_end' || node.status === 'abandoned')
        && !isAutoCuratedNode(node));
    const conclusions = allNodes.filter((node) => node.kind === 'conclusion');
    const artifacts = allNodes.filter((node) => node.kind === 'artifact');
    const duplicates = duplicateGroups(state);

    // ── stop：全部收敛 ──
    if (openNodes.length === 0 && (conclusions.length > 0 || stats.byStatus.done > 0)) {
        suggestions.push({
            type: 'stop',
            priority: 120,
            nodeId: conclusions.length > 0 ? conclusions[conclusions.length - 1].id : focus?.id ?? null,
            targetId: null,
            title: '研究已收敛',
            reason: '没有 open/active 节点，且已有结论或完成项。停止扩张；若要继续，先显式记录一个新目标并说明它与既有结论的关系。',
            basis: conclusions.slice(-3).map((node) => node.id),
        });
    }

    // ── verify：假设没有证据 ──
    for (const hypothesis of unverified.slice(0, 3)) {
        const overconfident = typeof hypothesis.confidence === 'number' && hypothesis.confidence >= 0.75;
        suggestions.push({
            type: 'verify',
            priority: overconfident ? 95 : 88,
            nodeId: hypothesis.id,
            targetId: hypothesis.id,
            title: `验证「${shortTitle(hypothesis)}」`,
            reason: `假设 ${hypothesis.id} 尚无证据支撑（子树里的 evidence 与指向它的 supports 边都没有）${overconfident ? `，但置信度已达 ${hypothesis.confidence}（过度自信风险）` : ''}。优先设计一个能证伪它的最小实验/检索，而不是继续加码。`,
            basis: [hypothesis.id, ...childrenOf(state, hypothesis.id).slice(0, 4).map((node) => node.id)],
        });
    }

    // ── resolve：开放问题/未决决策 ──
    const unresolved = allNodes.filter(
        (node) => (node.kind === 'question' || node.kind === 'decision') && (node.status === 'open' || node.status === 'active'),
    );
    for (const node of unresolved.slice(0, 2)) {
        suggestions.push({
            type: 'resolve',
            priority: node.kind === 'decision' ? 78 : 72,
            nodeId: node.id,
            targetId: node.id,
            title: `收敛「${shortTitle(node)}」`,
            reason: `${node.kind === 'decision' ? '决策' : '问题'} ${node.id} 仍处于 ${node.status}。给出一个明确答案或决定，并记录成结论节点（kind=conclusion）。`,
            basis: [node.id],
        });
    }

    // ── branch：换一条路径 / 建立互斥假设 ──
    if (!hasDivergedHypotheses(state, hypotheses)) {
        suggestions.push({
            type: 'branch',
            priority: 68,
            nodeId: focus?.id ?? null,
            targetId: null,
            title: '建立互斥假设',
            reason: `当前只有 ${hypotheses.length} 条假设${hypotheses.length === 0 ? '' : '，且同层没有真正的竞争解释'}。写下至少两条互斥假设（hypothesis）并说明各自的可证伪点，再决定先验证哪条。`,
            basis: hypotheses.slice(0, 4).map((node) => node.id),
        });
    } else if (focus !== null) {
        const alternative = leastExploredSiblingPath(state, focus.id);
        if (alternative !== null) {
            suggestions.push({
                type: 'branch',
                priority: 64,
                nodeId: focus.id,
                targetId: alternative.node.id,
                title: `换路径：${shortTitle(alternative.node)}`,
                reason: `当前焦点在 ${focus.id}（路径深度 ${alternative.focusDepth}，子树 ${alternative.focusSize} 个节点）；兄弟分支 ${alternative.node.id} 只有 ${alternative.size} 个节点，可能被过早放弃。收益：避免在一个解释上过拟合；成本：需要重新取证。`,
                basis: [focus.id, alternative.node.id],
            });
        }
        const otherRoot = leastExploredOtherRoot(state, focus.id);
        if (otherRoot !== null) {
            suggestions.push({
                type: 'branch',
                priority: 60,
                nodeId: focus.id,
                targetId: otherRoot.node.id,
                title: `激活另一目标：${shortTitle(otherRoot.node)}`,
                reason: `当前会话只推进 ${firstRootId(focus.id, state) ?? focus.id} 这条根路径；目标 ${otherRoot.node.id}（${otherRoot.size} 个节点）长期未更新。跨目标换轨可打断局部最优。`,
                basis: [otherRoot.node.id],
            });
        }
    }

    // ── deepen：沿当前路径推进 ──
    if (focus !== null && (focus.status === 'open' || focus.status === 'active')) {
        const depth = pathToRoot(state, focus.id).length;
        const leafish = childrenOf(state, focus.id).length === 0;
        suggestions.push({
            type: 'deepen',
            priority: leafish ? 62 : 54,
            nodeId: focus.id,
            targetId: focus.id,
            title: '推进当前节点',
            reason: `焦点 ${focus.id}（${focus.kind}）仍 ${focus.status}，位于第 ${depth} 层${leafish ? '且还没有子节点' : ''}。把它拆成一个可执行的下一步并记录（step/action），或写下当前遇到的阻塞。`,
            basis: [focus.id],
        });
    }

    // ── consolidate：重复/发散过多/缺结论 ──
    if (duplicates.length > 0) {
        const first = duplicates[0];
        suggestions.push({
            type: 'consolidate',
            priority: 74,
            nodeId: first.nodes[0].id,
            targetId: first.nodes[0].id,
            title: '合并重复节点',
            reason: `${duplicates.length} 组节点指纹重复（如 ${first.nodes.map((node) => node.id).join(' / ')}，主题「${shortTitle(first.nodes[0])}」）。用 explore_tree_record merge 保留信息最全的一个，避免同一结论在多处漂移。`,
            basis: first.nodes.map((node) => node.id),
        });
    }
    if (openNodes.length >= 4 && conclusions.length === 0) {
        suggestions.push({
            type: 'consolidate',
            priority: 58,
            nodeId: focus?.id ?? null,
            targetId: null,
            title: '阶段性收敛',
            reason: `已有 ${openNodes.length} 个未决节点但还没有任何结论。先写一条阶段性 conclusion（哪怕带不确定性），明确已知/未知，再继续扩张。`,
            basis: openNodes.slice(0, 5).map((node) => node.id),
        });
    }
    if (conclusions.length === 0 && openNodes.length >= 2 && artifacts.length > 0) {
        suggestions.push({
            type: 'consolidate',
            priority: 50,
            nodeId: focus?.id ?? null,
            targetId: null,
            title: '总结产物',
            reason: `已有 ${artifacts.length} 个产物节点但没有结论：把产物隐含的判断提炼成 conclusion，否则下次会话无法复用人造结论。`,
            basis: artifacts.slice(0, 4).map((node) => node.id),
        });
    }

    // ── revive：死路可能是错误结论（模型会犯错）──
    for (const dead of deadEnds.slice(0, MAX_REVIVE_SUGGESTIONS)) {
        const reason = dead.summary !== '' ? firstLine(dead.summary, 120) : '没有记录失败原因';
        const contradicts = edgesOf(state, dead.id)
            .filter((edge) => edge.kind === 'contradicts' && edge.from === dead.id)
            .map((edge) => state.nodes.get(edge.to))
            .filter((node) => node !== undefined && node.kind === 'hypothesis');
        const conflictNote = contradicts.length > 0
            ? `；它通过 contradicts 边否定了假设 ${contradicts.map((node) => node.id).join(' / ')}，复查时要重新评估这条否定是否成立`
            : '';
        suggestions.push({
            type: 'revive',
            priority: 34,
            nodeId: dead.id,
            targetId: dead.id,
            title: `复查死路「${shortTitle(dead)}」`,
            reason: `死路 ${dead.id}（${reason}）是「当时认为走不通」，不是「已被证明不可能」${conflictNote}。只有在出现新证据/新工具时 reopen 并补一条 contradicts 关系；否则保持关闭。`,
            basis: [dead.id, ...contradicts.slice(0, 2).map((node) => node.id)],
        });
        avoid.push({ nodeId: dead.id, reason: `已失败/放弃：${reason}` });
    }

    // ── notes：覆盖度与边提示 ──
    if (hypotheses.length > 0 && unverified.length / hypotheses.length >= 0.5) {
        notes.push(`${unverified.length}/${hypotheses.length} 条假设没有证据；继续加假设之前先验证。`);
    }
    const supportsEdges = state.edges.filter((edge) => edge.kind === 'supports');
    if (supportsEdges.length > 0) {
        notes.push(`${supportsEdges.length} 条 supports 边把证据接到假设；验证时先复用已有证据，避免重复取证。`);
    }
    if (conflicted.length > 0) {
        notes.push(`${conflicted.length} 条假设存在 contradicts 证据：先解释冲突，再决定加码还是换路径。`);
    }
    if (conclusions.length === 0 && stats.nodes >= 6) {
        notes.push('尚无 conclusion：研究图缺少可复用的沉淀。');
    }
    if (artifacts.length === 0 && stats.nodes >= 8) {
        notes.push('尚无 artifact：产物没有回写研究图，换会话会丢失上下文。');
    }
    if (stats.byKind.dead_end === 0 && stats.nodes >= 12) {
        notes.push('没有记录任何 dead_end：可能把失败路径直接删掉/忽略了；失败原因是后续最有价值的线索。');
    }
    const depth = maxDepth(state);
    notes.push(`最大深度 ${depth} 层；类型覆盖 ${formatCounts(stats.byKind)}。`);

    // ── 混合与截断 ──
    const sorted = suggestions.sort((left, right) => {
        if (left.priority !== right.priority) return right.priority - left.priority;
        const typeDelta = (TYPE_ORDER[left.type] ?? 99) - (TYPE_ORDER[right.type] ?? 99);
        if (typeDelta !== 0) return typeDelta;
        return String(left.nodeId ?? '').localeCompare(String(right.nodeId ?? ''));
    });
    const limited = mixSuggestions(sorted, limit);

    return {
        focus: focus === null ? null : { id: focus.id, kind: focus.kind, status: focus.status, title: focus.title },
        suggestions: limited,
        avoid: dedupeBy(avoid, (item) => item.nodeId),
        notes,
        stats,
        generatedAt: new Date().toISOString(),
    };
}

function mixSuggestions(sorted, limit) {
    const picked = [];
    const counts = new Map();
    const push = (item) => {
        picked.push(item);
        counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    };
    // 先保证至少一条验证类、一条收敛/停止类（如果存在）。
    const verify = sorted.find((item) => item.type === 'verify' || item.type === 'resolve');
    const converge = sorted.find((item) => item.type === 'consolidate' || item.type === 'stop');
    if (converge !== undefined) push(converge);
    if (verify !== undefined && verify !== converge) push(verify);
    for (const item of sorted) {
        if (picked.length >= limit) break;
        if (picked.includes(item)) continue;
        if (item.type === 'branch' && (counts.get('branch') ?? 0) >= MAX_BRANCH_SUGGESTIONS) continue;
        if (item.type === 'revive' && (counts.get('revive') ?? 0) >= MAX_REVIVE_SUGGESTIONS) continue;
        if (item.type === 'stop' && (counts.get('stop') ?? 0) >= 1) continue;
        push(item);
    }
    return picked;
}

function resolveFocus(state, focusId) {
    if (focusId !== null && focusId !== undefined) {
        const node = state.nodes.get(focusId);
        if (node !== undefined) return node;
    }
    let latest = null;
    for (const node of state.nodes.values()) {
        if (latest === null || node.updatedAt > latest.updatedAt) latest = node;
        else if (node.updatedAt === latest.updatedAt && node.id > latest.id) latest = node;
    }
    if (latest !== null) return latest;
    const roots = rootNodes(state);
    return roots.length > 0 ? roots[0] : null;
}

/** 假设是否有证据：子树里的 evidence，或跨轮 supports/refines 边从证据/结论指向它。 */
function hasEvidence(state, id) {
    if (hasEvidenceInSubtree(state, id)) return true;
    return edgesOf(state, id).some((edge) => {
        if (edge.to !== id || (edge.kind !== 'supports' && edge.kind !== 'refines')) return false;
        const other = state.nodes.get(edge.from);
        return other !== undefined
            && (other.kind === 'evidence' || other.kind === 'conclusion')
            && other.status !== 'abandoned';
    });
}

/** 假设是否被 contradicts 边否定（证据/死路 → 假设）。 */
function hasContradiction(state, id) {
    return edgesOf(state, id).some((edge) => {
        if (edge.to !== id || edge.kind !== 'contradicts') return false;
        const other = state.nodes.get(edge.from);
        return other !== undefined && other.status !== 'abandoned';
    });
}

function hasEvidenceInSubtree(state, id) {
    const ids = subtreeIds(state, id, { includeSelf: false });
    for (const childId of ids) {
        const node = state.nodes.get(childId);
        if (node !== undefined && node.kind === 'evidence' && node.status !== 'abandoned') return true;
    }
    return false;
}

function hasDivergedHypotheses(state, hypotheses) {
    if (hypotheses.length < 2) return false;
    // 互斥假设：同父竞争解释，或两条假设之间有 contradicts 边。
    const hypothesisIds = new Set(hypotheses.map((node) => node.id));
    if (state.edges.some((edge) => edge.kind === 'contradicts'
        && hypothesisIds.has(edge.from) && hypothesisIds.has(edge.to))) return true;
    const parentCount = new Map();
    for (const hypothesis of hypotheses) {
        const key = hypothesis.parentId ?? 'root';
        parentCount.set(key, (parentCount.get(key) ?? 0) + 1);
    }
    return [...parentCount.values()].some((count) => count >= 2);
}

function leastExploredSiblingPath(state, focusId) {
    const path = pathToRoot(state, focusId);
    const sizes = new Map();
    const sizeOf = (id) => {
        if (!sizes.has(id)) sizes.set(id, subtreeIds(state, id).length);
        return sizes.get(id);
    };
    let best = null;
    // 从焦点向上找：最近一个「有兄弟分支」的祖先。
    for (let index = path.length - 1; index >= 0; index -= 1) {
        const parent = path[index];
        const siblings = childrenOf(state, parent.id).filter((node) => node.id !== focusId);
        if (siblings.length === 0) continue;
        for (const sibling of siblings) {
            const size = sizeOf(sibling.id);
            if (size <= 2) {
                if (best === null || size < best.size) {
                    best = { node: sibling, size, focusDepth: path.length, focusSize: sizeOf(focusId) };
                }
            }
        }
        if (best !== null) return best;
    }
    return best;
}

function leastExploredOtherRoot(state, focusId) {
    const focusRoot = rootNodes(state).find((root) => subtreeIds(state, root.id).includes(focusId));
    const roots = rootNodes(state).filter((root) => focusRoot === undefined || root.id !== focusRoot.id);
    if (roots.length === 0) return null;
    let best = null;
    for (const root of roots) {
        const size = subtreeIds(state, root.id).length;
        if (best === null || size < best.size) best = { node: root, size };
    }
    return best;
}

function firstRootId(focusId, state) {
    const path = pathToRoot(state, focusId);
    return path.length > 0 ? path[0].id : null;
}

function duplicateGroups(state) {
    const groups = [];
    for (const [fingerprint, ids] of state.index.fingerprints) {
        if (ids.length < 2) continue;
        const nodes = ids.map((id) => state.nodes.get(id)).filter((node) => node !== undefined);
        if (nodes.length >= 2) groups.push({ fingerprint, nodes });
    }
    return groups.sort((left, right) => right.nodes.length - left.nodes.length);
}

function maxDepth(state) {
    let max = 0;
    for (const node of state.nodes.values()) {
        const depth = pathToRoot(state, node.id).length;
        if (depth > max) max = depth;
    }
    return max;
}

function shortTitle(node) {
    return node.title.length > 40 ? `${node.title.slice(0, 39)}…` : node.title;
}

function firstLine(text, max) {
    const line = text.split('\n')[0] ?? '';
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function dedupeBy(items, key) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const value = key(item);
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(item);
    }
    return out;
}

function formatCounts(counts) {
    return Object.entries(counts).map(([key, value]) => `${key}:${value}`).join(' ');
}
