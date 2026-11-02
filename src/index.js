/**
 * dsh-explore-tree —— 研究轨迹（explore-tree）插件入口。
 *
 * 三条线在这里汇合：
 *  1. 旁路观察：`session/event` → 翻译 → 确定性提取器 → 工作区研究图（不改对话、不改前缀）；
 *     进入旧会话时还会用 `session/created` + `snapshotEvents()` 回放历史（补建树）；
 *  2. 模型接口：两个固定工具 `explore_tree` / `explore_tree_record`；
 *  3. 人看：会话上栏 `conversation.view` 页签（「研究轨迹」），数据来自 `/explore-tree/snapshot`。
 *
 * 依赖的宿主服务都用 `inject` 声明；webServer 是可选的（headless 环境也能只用工具）。
 *
 * @module dsh-explore-tree
 */
import { normalizeConfig } from './host/config.js';
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, PROMPT_TEXT } from './host/prompt.js';
import { ResearchTraceService } from './host/service.js';
import { buildToolDefinitions } from './host/tools.js';

/** 插件行 id / 包名。 */
export const name = 'dsh-explore-tree';

/** 必需服务：工具面、系统提示、工作区目录解析。 */
export const inject = ['tools', 'systemPrompt', 'workingDirectory'];

/**
 * 不导出 Config（schemastery）：纯 ESM 包不想在求值期依赖宿主安装目录。
 * 没有 Config 时 cordis 把 profile 的 config 原样透传，由 normalizeConfig 兜底。
 */

/**
 * @param {import('cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
    const logger = ctx.logger ?? console;
    let config;
    try {
        config = normalizeConfig(rawConfig);
    } catch (error) {
        logger.warn?.(`[explore-tree] 配置解析失败，使用默认配置：${error instanceof Error ? error.message : String(error)}`);
        config = normalizeConfig({});
    }
    if (config.enabled === false) {
        logger.info?.('[explore-tree] 已禁用（config.enabled=false）。');
        return;
    }

    const service = new ResearchTraceService(ctx, config, logger);

    // 工具面在加载时确定；运行期不增删（前缀稳定）。
    for (const definition of buildToolDefinitions(service)) {
        ctx.effect(() => ctx.tools.register(definition));
    }

    // 静态协议段落：只注册一次，纯静态文本。
    if (config.promptSection) {
        ctx.effect(() => ctx.systemPrompt.section({
            name: PROMPT_SECTION_NAME,
            order: PROMPT_SECTION_ORDER,
            text: PROMPT_TEXT,
        }));
    }

    // 旁路观察：不 await、不抛错；事件由 agent-loop 提交会话日志后触达。
    ctx.effect(() => ctx.on('session/event', (session, event) => {
        void service.ingestSessionEvent(session, event);
    }));

    // 进入一个本工作区还没有图的旧会话：回放历史事件，从 reasoning 补建（异步，不阻塞打开）。
    ctx.effect(() => ctx.on('session/created', (session) => {
        void service.backfillSession(session);
    }));

    // 轮首简报：已有 goal 时，把「目标/主干 digest/未决叶根/建议」推给模型；
    // 首次完整，之后只推树上的增量（新增/完成/放弃/更新），无变化跳过。
    // 与 time-context 同机制：在 pre-step 的 decision.messages 末尾追加一条带 source 的快照消息；
    // 同一轮最多注入一次（injectBrief 内部去重），没有 goal 时不打扰。
    ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
        const decision = typeof next === 'function' ? await next() : payload;
        try {
            return await service.injectBrief(decision, {
                session: payload?.agent?.session ?? payload?.session ?? null,
                turn: payload?.turn,
                step: payload?.step,
            });
        } catch {
            return decision;
        }
    }, { prepend: true }));

    // 浏览器面板数据路由：headless 宿主没有 webServer 时自动跳过。
    if (config.http) {
        ctx.inject(['webServer'], (webCtx) => {
            webCtx.effect(() => webCtx.webServer.register({
                kind: 'prefix',
                path: '/explore-tree',
                handler: (req, res) => service.handleHttp(req, res),
            }));
        });
    }

    // 可选 LLM 辅助：宿主有 llm 服务且配置启用时，轮末异步补语义节点。
    ctx.inject(['llm'], (llmCtx) => {
        const runtime = llmCtx.llm ?? (typeof llmCtx.get === 'function' ? llmCtx.get('llm') : undefined);
        if (runtime !== undefined && runtime !== null) {
            service.attachLlm(runtime);
            logger.info?.('[explore-tree] 已接入宿主 llm 服务（llm.enabled 决定是否实际调用）。');
        }
    });

    // 卸载：先停提取器队列，再落盘关 store。
    ctx.effect(() => () => {
        void service.dispose();
    });

    logger.info?.(`[explore-tree] 已加载：dir=${config.dirName} autoCapture=${config.autoCapture} http=${config.http}`);
}
