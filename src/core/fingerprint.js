/**
 * 去重指纹：同类键归一化后取 sha1 前 12 位。
 *
 * 用途：
 *  - 同一查询/文件/命令在别的轮次或会话被重复做过 → 复用结论、避免重复造轮子；
 *  - 自动提取与 LLM 辅助提取的幂等键。
 *
 * 归一化是刻意保守的：只折叠大小写、空白与常见标点，不删 CJK 字符。
 *
 * @module core/fingerprint
 */
import { createHash } from 'node:crypto';

/**
 * 把键文本归一化成可比较形式。
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function normalizeKey(text, max = 400) {
    return String(text ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/[“”‘’]/g, "'")
        .replace(/[（(]/g, '(')
        .replace(/[）)]/g, ')')
        .replace(/[：:]/g, ':')
        .replace(/[，,]/g, ',')
        .replace(/[。.]/g, '.')
        .replace(/[？?]/g, '?')
        .replace(/[！!]/g, '!')
        .replace(/[、;；]/g, ';')
        .replace(/[ \t\n]+/g, ' ')
        .trim()
        .slice(0, max);
}

/**
 * 计算指纹。
 *
 * @param {string} scope 语义作用域（例如 'query' / 'file' / 'command' / 'goal'）
 * @param {string} key
 * @returns {string} 12 位十六进制
 */
export function fingerprint(scope, key) {
    const normalized = `${scope}\u0000${normalizeKey(key)}`;
    return createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 12);
}
