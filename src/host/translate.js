/**
 * 宿主事件 → 提取器事件 的翻译层。
 *
 * 这一层是**纯函数 + 一点会话内游标**，方便单测；真正的副作用都在 core/extract.js。
 * 设计原则：
 *  - 只翻译，不判断研究语义（规则在 extract.js，迭代时只改那边）；
 *  - 宿主多版本兼容：字段缺失时降级，但绝不抛错打断事件总线；
 *  - 不向主对话注入任何内容（需求 5/6）。
 *
 * v0.5（P0）：透传来源与轮次锚点，并从「交付物事件 / 写类工具」识别真产物，
 * 不再从工具结果文本里扫路径（那会把读文件、列表、回显都变成 artifact）。
 *
 * @module host/translate
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_TEXT = 24000;
const MAX_TOOL_CALLS = 64;

/** 交付物扩展名白名单：只收用户真正会打开的文件。 */
const DELIVERABLE_EXTENSIONS = new Set([
    '.docx', '.xlsx', '.pptx', '.pdf', '.md', '.html', '.htm',
    '.png', '.jpg', '.jpeg', '.svg', '.csv',
]);

/** 写类工具的参数白名单：只从这些工具的这些参数里取产物路径。 */
const WRITE_TOOL_PATH_FIELDS = Object.freeze({
    write: ['file_path', 'path'],
    edit: ['file_path', 'path'],
    str_replace_editor: ['path', 'file_path'],
});

function textOfBlocks(content) {
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n').trim();
}

function reasoningOfBlocks(content) {
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n').trim();
}

function clip(text, max = MAX_TEXT) {
    if (typeof text !== 'string') return '';
    return text.length <= max ? text : `${text.slice(0, max)}\n…[截断]`;
}

/** tool/result 的 message.content 里取正文（tool 结果可能是 text 块）。 */
function toolResultText(message) {
    const text = textOfBlocks(message?.content);
    if (text !== '') return text;
    const raw = message?.content;
    if (typeof raw === 'string') return raw;
    return '';
}

/**
 * 从工具调用参数/结果里尽力识别产物（文件路径或 URL）。
 * 保守策略：只认明确的产物句式与带扩展名的路径，宁缺毋滥。
 *
 * @deprecated v0.5 起不再用于 tool/result（文本扫描误判率高）；保留导出供旧数据/调试使用。
 */
export function detectArtifacts(args, resultText, max = 8) {
    const found = [];
    const seen = new Set();
    const push = (value, label) => {
        const trimmed = String(value).trim().replace(/[),.;，。；、]+$/u, '');
        if (trimmed.length < 3 || trimmed.length > 500) return;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        found.push(label !== undefined && label !== '' ? { value: trimmed, label } : { value: trimmed });
    };

    const blob = `${typeof args === 'string' ? args : JSON.stringify(args ?? {})}\n${resultText ?? ''}`;
    const pattern = /(?:output|outputPath|path|file|filename|artifact|文档|文件|已生成|已保存|保存到|写入|生成)\s*[:=：]\s*["']?([A-Za-z]:[\\/][^\s"',;，。；]+?\.(?:docx|xlsx|pptx|pdf|md|html|json|csv|txt|png|jpe?g|svg))|([A-Za-z]:[\\/](?:[^\s"',;，。；\\/]+[\\/])*[^\s"',;，。；\\/]+?\.(?:docx|xlsx|pptx|pdf|md|html|json|csv|txt|png|jpe?g|svg))/gu;
    for (const match of blob.matchAll(pattern)) {
        push(match[1] ?? match[2]);
        if (found.length >= max) break;
    }
    if (found.length < max) {
        const links = /\[[^\]]*\]\((https?:\/\/[^\s)]+|\/[^\s)]+\.[A-Za-z0-9]{1,6})\)/gu;
        for (const match of blob.matchAll(links)) {
            push(match[1]);
            if (found.length >= max) break;
        }
    }
    return found;
}

/** 把宿主各种错误形状（string / {name,code,reason} / Error）压成可读文本。 */
function errorTextOf(error, message) {
    if (error === undefined) return undefined;
    if (typeof error === 'string') return error;
    const name = typeof error.name === 'string' ? error.name : '';
    const code = typeof error.code === 'string' ? error.code : '';
    const reason = typeof error.reason === 'string'
        ? error.reason
        : (typeof error.message === 'string' ? error.message : '');
    const head = name !== '' && code !== '' && name !== code ? `${name} (${code})` : (name || code);
    const text = [head, reason].filter((part) => part !== '').join(': ');
    return text !== '' ? text : (toolResultText(message) || '工具返回错误（无详情）');
}

// ───────────────────── 来源 / 产物识别（P0） ─────────────────────

/** user/message 的 data 就是 message 本身；source.kind 区分真人/注入。 */
function sourceKindOf(message) {
    const kind = message?.source?.kind;
    return typeof kind === 'string' && kind !== '' ? kind : undefined;
}

function sourceFormOf(message) {
    const form = message?.source?.form;
    return typeof form === 'string' && form !== '' ? form : undefined;
}

/** 没有 source 的旧事件按真人消息处理（兼容 v0.4 之前的历史）。 */
function isRealUserSource(kind) {
    return kind === undefined || kind === 'user';
}

function sessionCwd(session) {
    const cwd = session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

function normalizeForMatch(value) {
    return String(value).replace(/\\/gu, '/').toLowerCase();
}

/** 产物路径过滤：工作区外的 Temp、依赖、插件自身数据目录都不算交付物。 */
function isExcludedArtifactPath(absolutePath, cwd) {
    const target = normalizeForMatch(absolutePath);
    const workspace = normalizeForMatch(cwd);
    const insideWorkspace = target === workspace || target.startsWith(`${workspace}/`);
    if (/\/\.explore-tree\//u.test(target) || /\/node_modules\//u.test(target) || /\/\.git\//u.test(target)) {
        return true;
    }
    if (insideWorkspace) return false;
    const temp = normalizeForMatch(os.tmpdir());
    return target === temp || target.startsWith(`${temp}/`);
}

function rememberToolCall(runtime, callId, name, args) {
    if (typeof callId !== 'string' || callId === '') return;
    if (!(runtime.toolCalls instanceof Map)) runtime.toolCalls = new Map();
    runtime.toolCalls.set(callId, { name, args });
    while (runtime.toolCalls.size > MAX_TOOL_CALLS) {
        const oldest = runtime.toolCalls.keys().next().value;
        if (oldest === undefined) break;
        runtime.toolCalls.delete(oldest);
    }
}

function recallToolCall(runtime, callId) {
    if (!(runtime?.toolCalls instanceof Map) || callId === undefined) return undefined;
    return runtime.toolCalls.get(String(callId));
}

/**
 * 写类工具的产物识别：参数里的路径 + 文件真实存在 + 扩展名白名单。
 * tool/call 早于写入，所以真正的校验发生在 tool/result（此时文件应已存在）。
 */
function artifactPathsFromTool(toolName, args, cwd) {
    const fields = WRITE_TOOL_PATH_FIELDS[toolName];
    if (!Array.isArray(fields) || args === null || typeof args !== 'object') return [];
    const out = [];
    const seen = new Set();
    for (const field of fields) {
        const raw = args[field];
        if (typeof raw !== 'string' || raw.trim() === '') continue;
        const value = path.isAbsolute(raw.trim()) ? raw.trim() : path.resolve(cwd, raw.trim());
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (!DELIVERABLE_EXTENSIONS.has(path.extname(value).toLowerCase())) continue;
        if (isExcludedArtifactPath(value, cwd)) continue;
        try {
            if (!fs.statSync(value).isFile()) continue;
        } catch {
            continue;
        }
        out.push({ kind: 'file', value, label: path.basename(value) });
    }
    return out;
}

/** deliverables/presented 已由宿主校验过文件存在，这里只做去重与描述整理。 */
function normalizePresentedFiles(files, cwd, max = 8) {
    const out = [];
    const seen = new Set();
    for (const file of Array.isArray(files) ? files : []) {
        const raw = typeof file === 'string' ? file : file?.path;
        if (typeof raw !== 'string' || raw.trim() === '') continue;
        const value = path.isAbsolute(raw.trim()) ? raw.trim() : path.resolve(cwd, raw.trim());
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (/\/\.explore-tree\//u.test(normalizeForMatch(value))) continue;
        const description = typeof file?.description === 'string' ? file.description.trim() : '';
        out.push({ kind: 'file', value, ...(description !== '' ? { label: description } : {}) });
        if (out.length >= max) break;
    }
    return out;
}

/**
 * 翻译一条 `session/event`。
 *
 * @param {{id?: string}} session
 * @param {{type: string, data?: any, seq?: number}} event
 * @param {{turn: number, lastUserText: string, toolCalls?: Map<string, {name?: string, args?: any}>}} runtime 每会话游标（会被就地更新）
 * @returns {Array<object>} 归一化事件（0..2 条）
 */
export function translateSessionEvent(session, event, runtime) {
    const sessionId = typeof session?.id === 'string' ? session.id : 'unknown';
    const data = event?.data ?? {};
    const seq = typeof event?.seq === 'number' ? event.seq : undefined;
    const out = [];
    switch (event?.type) {
        case 'turn/start': {
            runtime.turn = Number.isInteger(data.turn) ? data.turn : runtime.turn + 1;
            // 标题不再在这里取「上一条用户文本」：宿主 turn/start 早于本轮真实消息，
            // 此时 lastUserText 往往还是上一轮的注入消息（time-context / background job）。
            out.push({
                type: 'turn.start',
                sessionId,
                turn: runtime.turn,
                seq,
            });
            break;
        }
        case 'user/message': {
            const text = clip(textOfBlocks(data.content));
            const sourceKind = sourceKindOf(data);
            const sourceForm = sourceFormOf(data);
            const realUser = isRealUserSource(sourceKind);
            if (text !== '' && realUser) runtime.lastUserText = text;
            out.push({
                type: 'user.message',
                sessionId,
                text,
                turn: Number.isInteger(data.turn) ? data.turn : runtime.turn,
                messageId: data.id,
                sourceKind,
                sourceForm,
                seq,
            });
            break;
        }
        case 'assistant/message': {
            const message = data.message ?? {};
            const text = clip(textOfBlocks(message.content));
            const reasoning = clip(reasoningOfBlocks(message.content));
            const turn = Number.isInteger(data.turn) ? data.turn : runtime.turn;
            const step = Number.isInteger(data.step) ? data.step : undefined;
            if (reasoning !== '') {
                out.push({ type: 'assistant.reasoning', sessionId, turn, step, text: reasoning, seq });
            }
            if (text !== '') {
                out.push({
                    type: 'assistant.message',
                    sessionId,
                    turn,
                    step,
                    text,
                    final: data.stream !== true && data.interrupted !== true,
                    seq,
                });
            }
            break;
        }
        case 'tool/call': {
            let args = data.arguments;
            if (typeof args === 'string') {
                try {
                    args = JSON.parse(args);
                } catch {
                    // 原始 JSON 不合法时保留字符串，extract 的 summarizeArgs 也能处理。
                }
            }
            if (typeof data.callId === 'string') rememberToolCall(runtime, data.callId, data.name, args);
            out.push({
                type: 'tool.start',
                sessionId,
                turn: Number.isInteger(data.turn) ? data.turn : runtime.turn,
                step: Number.isInteger(data.step) ? data.step : undefined,
                callId: data.callId,
                toolName: data.name,
                args,
                seq,
            });
            break;
        }
        case 'tool/result': {
            const message = data.message ?? {};
            const callId = message.toolCallId ?? data.callId;
            const remembered = recallToolCall(runtime, callId);
            const toolName = data.name ?? remembered?.name;
            const args = message.arguments ?? remembered?.args;
            if (callId !== undefined && runtime?.toolCalls instanceof Map) runtime.toolCalls.delete(String(callId));
            const error = data.error ?? (message.isError === true ? (toolResultText(message) || '工具返回错误（无详情）') : undefined);
            const errorText = errorTextOf(error, message);
            const ok = error === undefined;
            out.push({
                type: 'tool.end',
                sessionId,
                turn: Number.isInteger(data.turn) ? data.turn : runtime.turn,
                step: Number.isInteger(data.step) ? data.step : undefined,
                callId,
                toolName,
                ok,
                result: clip(toolResultText(message)),
                error: errorText,
                artifacts: ok ? artifactPathsFromTool(toolName, args, sessionCwd(session)) : [],
                seq,
            });
            break;
        }
        case 'deliverables/presented': {
            const files = normalizePresentedFiles(data.files, sessionCwd(session));
            if (files.length > 0) {
                out.push({
                    type: 'deliverable.presented',
                    sessionId,
                    turn: Number.isInteger(data.turn) ? data.turn : runtime.turn,
                    callId: data.callId,
                    files,
                    seq,
                });
            }
            break;
        }
        case 'turn/end': {
            const reason = data.reason ?? {};
            const kind = typeof reason === 'string' ? reason : reason.kind;
            out.push({
                type: 'turn.end',
                sessionId,
                turn: Number.isInteger(data.turn) ? data.turn : runtime.turn,
                aborted: kind !== undefined && kind !== 'completed',
                error: kind !== undefined && kind !== 'completed' ? `轮次结束原因：${kind}` : undefined,
                seq,
            });
            break;
        }
        default:
            break;
    }
    return out;
}

/** 会话结束时把游标清掉（图里已落盘的数据不动）。 */
export function finishSession(runtimeMap, sessionId) {
    if (sessionId !== undefined) runtimeMap.delete(sessionId);
}
