#!/usr/bin/env node
/**
 * 研究图离线重建：把旧图（v0.4 及更早）里已知的结构污染整理干净。
 *
 *   node scripts/rebuild.mjs --workspace <dir> [--sessions <dir>] [--apply] [--force]
 *
 * 修复项：
 *   1. 假 goal：标题来自注入消息（Time sampled / background job / approval policy …）→ 换成本会话
 *      第一条真实用户消息（source.kind === 'user'）；
 *   2. 被污染的 step 标题 / 「第 N 轮研究」占位 → 用该轮真实用户消息回填「第 N 轮：意图」；
 *   3. artifact 成为根 → 挂到所属会话的 goal 下；
 *   4. 同一 session+turn 的重复 step → 合并子树/边/标签，保留正常指纹的那个；
 *   5. 旧 note 打 `legacy-note` 标签（面板默认折叠，不再占用视野）。
 *
 * 默认 dry-run，只打印将发生的改动；`--apply` 才会写回，并先备份 graph.json。
 * 宿主进程会把自己内存里的图写回文件，因此 apply 前必须先停掉 dsh web；
 * 脚本会探测 http://127.0.0.1:3080/explore-tree/health，除非 `--force`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fingerprint } from '../src/core/fingerprint.js';

const INJECTION_TITLE_PATTERNS = [
    /^Time sampled\b/i,
    /^background job\b/i,
    /approval policy/i,
    /^Current runtime context\b/i,
    /^Browser time zone\b/i,
    /^You are an AI agent\b/i,
];
const PLACEHOLDER_STEP_PATTERN = /^第\s*\d+\s*轮(?:研究)?$|缺少开始事件/u;

function parseArgs(argv) {
    const options = {
        workspace: process.cwd(),
        sessions: null,
        apply: false,
        force: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--workspace' && argv[i + 1] !== undefined) {
            options.workspace = path.resolve(argv[i + 1]);
            i += 1;
        } else if (arg === '--sessions' && argv[i + 1] !== undefined) {
            options.sessions = path.resolve(argv[i + 1]);
            i += 1;
        } else if (arg === '--apply') {
            options.apply = true;
        } else if (arg === '--force') {
            options.force = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log('用法: node scripts/rebuild.mjs --workspace <dir> [--sessions <dir>] [--apply] [--force]');
            process.exit(0);
        }
    }
    return options;
}

function isInjectionTitle(title) {
    return INJECTION_TITLE_PATTERNS.some((pattern) => pattern.test(String(title ?? '').trim()));
}

function shortTitle(text, max) {
    const cleaned = String(text ?? '')
        .replace(/```[\s\S]*?```/gu, ' ')
        .replace(/[#>*_`~]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/gu, '')
        .trim();
    if (cleaned === '') return '';
    return cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 1))}…` : cleaned;
}

function normalizeSessionKey(value) {
    return String(value ?? '').replace(/^session-/u, '');
}

function matchSessionKey(candidates, sessionId) {
    const wanted = normalizeSessionKey(sessionId);
    for (const key of candidates.keys()) {
        if (key === wanted || wanted.startsWith(key) || key.startsWith(wanted)) return key;
    }
    return null;
}

function decodeSessionEvents(file) {
    const buffer = fs.readFileSync(file);
    const starts = [];
    for (let i = 0; i + 4 <= buffer.length; i += 1) {
        if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i);
    }
    const events = [];
    for (let index = 0; index < starts.length; index += 1) {
        const start = starts[index];
        const end = index + 1 < starts.length ? starts[index + 1] : buffer.length;
        let text;
        try {
            text = zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
        } catch {
            continue;
        }
        for (const line of text.split('\n')) {
            if (line.trim() === '') continue;
            try {
                events.push(JSON.parse(line));
            } catch {
                // 半帧
            }
        }
    }
    return events;
}

function findSessionFiles(root) {
    const found = [];
    const walk = (dir, depth) => {
        if (depth > 3 || !fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const target = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(target, depth + 1);
            } else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') {
                found.push(target);
            }
        }
    };
    walk(root, 0);
    return found;
}

/** 返回 Map<normalizedSessionId, Map<turn, 第一条真实用户消息>>。 */
function collectIntents(sessionsDir) {
    const intents = new Map();
    if (!fs.existsSync(sessionsDir)) return intents;
    for (const file of findSessionFiles(sessionsDir)) {
        const dir = path.dirname(file);
        // session 目录名形如 session-<id>，取其后的 id 前缀做匹配
        const base = path.basename(dir);
        const id = normalizeSessionKey(base);
        let events;
        try {
            events = decodeSessionEvents(file);
        } catch {
            continue;
        }
        const byTurn = new Map();
        let turn = 0;
        for (const event of events) {
            const data = event.data ?? event;
            if (event.type === 'turn/start') turn = data.turn ?? turn;
            if (event.type !== 'user/message') continue;
            const source = data.source ?? {};
            if (source.kind !== 'user') continue;
            const content = data.content ?? data.message?.content ?? [];
            const text = content.filter((block) => block.type === 'text').map((block) => block.text).join(' ').trim();
            if (text === '') continue;
            if (!byTurn.has(turn)) byTurn.set(turn, text);
        }
        if (byTurn.size > 0) intents.set(id, byTurn);
    }
    return intents;
}

function readGraph(workspace) {
    const file = path.join(workspace, '.explore-tree', 'graph.json');
    if (!fs.existsSync(file)) throw new Error(`没有找到研究图：${file}`);
    return { file, graph: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function repair(graph, intents) {
    const changes = [];
    const nodes = graph.nodes ?? {};
    const sessionValues = Object.values(graph.sessions ?? {});
    const intentsOfSession = (sessionId) => {
        const key = matchSessionKey(intents, sessionId);
        return key === null ? null : intents.get(key);
    };
    const goalOfSession = (sessionId) => {
        const entry = sessionValues.find((session) => normalizeSessionKey(session.sessionId) === normalizeSessionKey(sessionId));
        if (entry?.goalId !== undefined && nodes[entry.goalId] !== undefined) return entry.goalId;
        for (const node of Object.values(nodes)) {
            if (node.kind === 'goal' && normalizeSessionKey(node.sessionId) === normalizeSessionKey(sessionId)) return node.id;
        }
        return null;
    };
    const addTag = (node, tag) => {
        node.tags = Array.isArray(node.tags) ? node.tags : [];
        if (!node.tags.includes(tag)) node.tags.push(tag);
    };

    for (const node of Object.values(nodes)) {
        if (node.kind === 'goal' && isInjectionTitle(node.title)) {
            const byTurn = intentsOfSession(node.sessionId);
            const first = byTurn === null ? '' : (byTurn.get(1) ?? [...byTurn.values()][0] ?? '');
            if (first !== '') {
                changes.push({ action: 'retitle-goal', id: node.id, from: node.title, to: shortTitle(first, 60) });
                node.title = shortTitle(first, 60);
                addTag(node, 'p3:rebuilt');
            }
        }
    }

    for (const node of Object.values(nodes)) {
        if (node.kind !== 'step') continue;
        const polluted = isInjectionTitle(node.title) || PLACEHOLDER_STEP_PATTERN.test(String(node.title).trim());
        if (!polluted) continue;
        const byTurn = intentsOfSession(node.sessionId);
        const intent = byTurn?.get(node.turn) ?? '';
        const wanted = intent !== ''
            ? `第 ${node.turn} 轮：${shortTitle(intent, 42)}`
            : `第 ${node.turn} 轮研究`;
        if (wanted !== node.title) {
            changes.push({ action: 'retitle-step', id: node.id, from: node.title, to: wanted });
            node.title = wanted;
            addTag(node, 'p3:rebuilt');
        }
    }

    for (const node of Object.values(nodes)) {
        if (node.kind !== 'artifact') continue;
        if (node.parentId !== null && node.parentId !== undefined) continue;
        const goalId = goalOfSession(node.sessionId);
        if (goalId === null) continue;
        changes.push({ action: 'adopt-artifact', id: node.id, from: null, to: goalId });
        node.parentId = goalId;
        addTag(node, 'p3:rebuilt');
    }

    // 重复 step：保留「正常指纹」的那个，把其余子树/边并过去
    const groups = new Map();
    for (const node of Object.values(nodes)) {
        if (node.kind !== 'step') continue;
        const key = `${normalizeSessionKey(node.sessionId)}|${node.turn ?? '-'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(node);
    }
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const rank = (node) => {
            const expected = fingerprint('step', `${node.sessionId}\u0000${node.turn}`);
            if (node.fingerprint === expected) return 0;
            if (String(node.fingerprint ?? '').length > 0) return 1;
            return 2;
        };
        group.sort((a, b) => rank(a) - rank(b));
        const keep = group[0];
        for (const drop of group.slice(1)) {
            if (nodes[drop.id] === undefined) continue;
            for (const child of Object.values(nodes)) {
                if (child.parentId === drop.id) child.parentId = keep.id;
            }
            for (const edge of graph.edges ?? []) {
                if (edge.from === drop.id) edge.from = keep.id;
                if (edge.to === drop.id) edge.to = keep.id;
            }
            keep.tags = Array.from(new Set([...(keep.tags ?? []), ...(drop.tags ?? [])]));
            keep.refs = Array.from(new Set([...(keep.refs ?? []), ...(drop.refs ?? [])]));
            keep.hits = (keep.hits ?? 1) + (drop.hits ?? 1);
            delete nodes[drop.id];
            changes.push({ action: 'merge-step', id: drop.id, from: drop.title, to: keep.id });
        }
    }

    for (const node of Object.values(nodes)) {
        if (node.kind === 'note') addTag(node, 'legacy-note');
    }

    graph.roots = Object.values(nodes)
        .filter((node) => node.parentId === null || node.parentId === undefined)
        .map((node) => node.id);
    return changes;
}

async function liveHostRunning() {
    try {
        const response = await fetch('http://127.0.0.1:3080/explore-tree/health', { signal: AbortSignal.timeout(1500) });
        return response.ok;
    } catch {
        return false;
    }
}

const options = parseArgs(process.argv.slice(2));
const sessionsDir = options.sessions ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions');
const { file, graph } = readGraph(options.workspace);
const intents = collectIntents(sessionsDir);
console.log(`工作区 ${options.workspace}`);
console.log(`会话   ${intents.size} 个（${sessionsDir}）`);
console.log(`模式   ${options.apply ? 'APPLY（会写回并备份）' : 'dry-run（只打印）'}`);

const changes = repair(graph, intents);
if (changes.length === 0) {
    console.log('没有需要修复的项。');
} else {
    for (const change of changes) {
        console.log(`${change.action.padEnd(14)} ${change.id.padEnd(5)} ${String(change.from ?? '').slice(0, 46)} → ${String(change.to ?? '').slice(0, 46)}`);
    }
    console.log(`共 ${changes.length} 项改动。`);
}

if (!options.apply) {
    console.log('未写回；确认无误后加 --apply。');
    process.exit(0);
}

if (!options.force && await liveHostRunning()) {
    console.error('检测到 dsh web 正在运行：宿主会用自己的内存状态覆盖 graph.json。请先停止宿主，或加 --force 明确风险。');
    process.exit(2);
}

const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14);
const backup = path.join(options.workspace, '.explore-tree', `graph.rebuild-backup-${stamp}.json`);
fs.copyFileSync(file, backup);
graph.meta = { ...(graph.meta ?? {}), lastRebuild: { at: new Date().toISOString(), changes: changes.length, backup: path.basename(backup) } };
fs.writeFileSync(file, `${JSON.stringify(graph, null, 2)}\n`);
console.log(`已写回 ${file}（备份 ${backup}）。`);
