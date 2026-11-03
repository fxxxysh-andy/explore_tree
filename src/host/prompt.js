/**
 * 静态系统提示段落。
 *
 * 硬约束（需求 6）：这里只允许**静态文本**——不读取图状态、不含时间戳/随机数、
 * 不随会话变化。动态内容只通过 `explore_tree` 的工具返回值进入上下文，
 * 这样每次请求的 system prompt 前缀保持逐字节稳定，KV 缓存可以继续命中。
 *
 * @module host/prompt
 */

export const PROMPT_SECTION_NAME = 'explore-tree:protocol';

/**
 * SECTION_ORDERS 里 TOOLS（1000..3100）之后、TOOLS_SDK=5000 之前。
 * 选 4900 是为了「读完工具清单立刻读到使用约定」。
 */
export const PROMPT_SECTION_ORDER = 4900;

export const PROMPT_TEXT = `## 研究轨迹（explore-tree）

本工作区有一棵**共享的研究树**：它由插件从会话事件旁路提取（**推理链里的关键想法为主，工具调用只做每轮汇总**，外加产物、失败、结论），也接受你显式写入的分支、假设、证据与决策。它不写回对话，但同一工作区的所有会话共享同一棵树。

**读**：\`explore_tree({ action })\`
- \`overview\`：目标、焦点、最近节点、未决问题、死路、产物、结论（不知道从哪看起就用它）
- \`frontier\`：下一步建议（保证同时含「验证/收敛」与「探索」两类）＋ \`avoid\`（已知死路及原因）
- \`walk\`：沿当前分支展开（路径/子节点/未决叶/缺口/下一步 add 模板）；省略 id/focus 用会话游标
- \`team\`：与 Agent Teams 协作（读取真实成员/任务；我的主题/待认领/租约过期/冲突；任务 description 带 [explore-tree:<nodeId>] 即挂回节点）；认领或交接前先看
- \`find\`（关键词）、\`node\`（节点详情）、\`path\`（到根路径）、\`stats\`

**写**：\`explore_tree_record({ action })\`
- \`add\`：新目标/问题/假设/证据/决策/死路/结论/产物（parentId 省略时挂到当前焦点）
- \`update\` / \`link\`（supports/contradicts/refines/depends/replaces/duplicates/continues/related）
- \`close\` / \`reopen\` / \`merge\`

使用约定：
1. **先看再动**：开始一个新方向前先 \`explore_tree overview\`，确认本工作区已有的目标、结论和失败方向，不要重复造轮子。
2. **走错路也有价值**：失败的方向记成 \`dead_end\` 并写清失败原因；\`frontier\` 会避开它，并在「有新证据」时建议 \`reopen\`。
3. **多路径不等于瞎换**：\`frontier\` 同时给出验证/收敛建议与换轨建议；优先做能**证伪**当前假设的最小实验，而不是为不同而不同。过度自信（高置信度但无证据）会被专门标出。沿当前分支推进用 \`walk\`，不要每次从全图重挑旧节点。
4. **落节点要短**：标题一句话，摘要写理由、证据与引用；同一件事重复记录会自动合并计数，不要复制粘贴大段原文。
5. **不要为了同步图而改前缀**：不要请求动态改系统提示或工具面；图状态只从工具返回值读取。
6. **与 Agent Teams 共用任务**：需要把主题分派给真实团队时，用 Team 插件自己的 \`team_task_create\`；description 首行写 \`[explore-tree:<nodeId>]\`，\`team\` 读取时即可挂回主题，不要在树上另建一套任务节点。`;
