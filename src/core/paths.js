/**
 * 路径规范化：工作区 root 是「研究图」的共享边界，必须稳定、可比较。
 *
 * Windows 上大小写与分隔符都不敏感，所以比较用 workspaceKey()（小写），
 * 展示与落盘用 canonicalWorkspaceRoot()（realpath 后的原生大小写）。
 *
 * @module core/paths
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * 把任意目录输入规范成绝对、去尾分隔符、尽量真实的路径。
 * realpath 失败（目录还不存在等）时退回 path.resolve 的结果，不抛错。
 *
 * @param {string} input
 * @returns {string|null}
 */
export function canonicalWorkspaceRoot(input) {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (trimmed === '') return null;
    let resolved;
    try {
        resolved = path.resolve(trimmed);
    } catch {
        return null;
    }
    try {
        resolved = realpathSync.native(resolved);
    } catch {
        // 目录不存在/无权限：保留 resolve 结果，调用方自己决定是否创建。
    }
    // 去尾分隔符（保留盘符根，如 "D:\\"）。
    if (resolved.length > 3 && /[\\/]$/.test(resolved)) {
        resolved = resolved.slice(0, -1);
    }
    return resolved;
}

/**
 * 注册表 key：Windows 大小写不敏感。
 *
 * @param {string} root
 * @returns {string}
 */
export function workspaceKey(root) {
    const value = String(root);
    return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** 工作区显示名：目录的最后一段。 */
export function workspaceName(root) {
    const base = path.basename(String(root));
    return base === '' ? String(root) : base;
}
