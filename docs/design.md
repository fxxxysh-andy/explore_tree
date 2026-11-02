# 研究轨迹（dsh-explore-tree）设计

> 状态：v1 已实现。本文是实现契约；与代码不一致时以代码 + `test/` 为准，并回写本文。
> 包名：`dsh-explore-tree`；插件行 id：`explore-tree`；UI 名称：研究轨迹。

## 1. 目标与边界

### 1.1 目标

在 DSH 里提供一条**研究工作区级**的研究轨迹：

1. **完整记录**模型的研究图：目标、研究步骤、动作、证据、假设、决策、死路、结论、产物；
   原始操作另存流水账（journal），结构化节点只是它的视图，不丢原始信息。
2. **可观测**：给模型一组稳定、低成本、token 友好的工具，先查树再动手，避免重复造轮子；
   也给人和模型看「当前研究到哪了、哪些还没验证、哪些路已经死了」。
3. **树为核心**：`parentId` 构成唯一树；跨分支关系（支持/反驳/细化/依赖/替代/重复）是附加边。
4. **DSH 内可视化**：浏览器插件把树画出来（节点详情、状态、frontier、自动刷新）。
5. **自动产生，不干扰主对话**：从会话事件旁路确定性提取；可选后台 LLM 辅助为预留能力；
   任何提取都不写入主对话、不触发主对话。
6. **前缀稳定**：研究图变化不改变任何已存在请求前缀（系统提示段静态、工具面固定、
   动态内容只进工具返回值；不往历史消息里插东西）。
7. **引导探索又防止瞎探索**：`frontier` 给出「验证已有结论 / 开辟新假设 / 回溯死路 /
   收敛去重」混合建议，并显式标注「不要重复的死路」。
8. **工作区内共享**：同一工作区（workspace root）下所有会话/子代理共用一棵树；
   文件落在 `<workspace>/.explore-tree/`，跨会话、跨重启持久。

### 1.2 非目标（v1 明确不做）

- 不做跨机强一致的分布式图数据库：同一 DSH 进程内多会话共享是硬要求；同机多个宿主实例
  写同一工作区用 `.explore-tree/graph.lock` 串行化（v0.19），跨机/分布式共识不在范围内。
- 不改写/裁剪主对话，不做上下文压缩，不替换任何宿主消息投影。
- 不做知识图谱通用推理；树是研究过程记录，不是事实数据库。
- 可视化不引入第三方图库：纯 SVG + React 手写布局（v0.18 起支持缩放与拖动平移，只读浏览）。
- 后台 LLM 辅助提取：默认关闭，显式配置 `llm.provider`/`llm.model` 后在轮末异步补节点（v0.12）；确定性提取始终是主路径，LLM 只做语义补充。

## 2. 需求映射

| 需求 | 落点（实现） |
|---|---|
| 1 完整记录研究图 | `src/core/extract.js` 自动提取 + `journal.jsonl` 操作流水 + `explore_tree_record` 显式记录 |
| 2 提供观察接口 | 工具 `explore_tree`（overview/frontier/stats/find/node/path/tree/subtree，缩略返回 + `depth`，`src/host/tools.js`） |
| 3 树为核心 | `src/core/graph.js`：`Node.parentId` 单树，禁成环；`graph.edges` 存旁支关系 |
| 4 DSH 内可视化 | `lib/client.js` 会话上栏页签（`conversation.view`）+ `GET /explore-tree/snapshot`（`src/host/service.js`） |
| 5 自动产生、不干扰 | `ctx.on('session/event')` 旁路订阅 → `src/host/translate.js` → extractor；不写会话 |
| 6 前缀不变 | `src/host/prompt.js` 静态段 + 固定工具面 + 动态状态只进工具返回；`test/unit/prefix.test.js` |
| 7 引导探索 | `src/core/frontier.js` 混合建议 + `avoid`；静态协议提示（prompt.js） |
| 8 工作区共享 | `GraphRegistry` 按 canonical workspace root 复用 store（`src/host/service.js` + `src/core/store.js`） |

## 3. 总体架构

```
                       ┌──────────────────────────── 浏览器（DSH Web） ──────────────┐
                       │ lib/client.js: conversation.view tab (cards+detail)    │
23└───────────────▲─────────────────────────────────────────────────────────────┘
                                       │ GET /explore-tree/workspaces
                                       │ GET /explore-tree/snapshot?workspace=…
┌──────────────── DSH Host 进程 ──────┴───────────────────────────────────────────┐
│ explore-tree 插件（src/index.js）                                                 │
│  ┌────────────────────┐  会话事件（旁路）   ┌────────────────────┐               │
│  │ session/event 监听 │ ──────────────────▶ │ translate.js 归一化 │               │
│  └────────────────────┘                     └─────────┬──────────┘               │
│                                                       ▼                          │
│                                            ┌────────────────────┐                │
│  ┌──────────────────┐   读/写              │ ResearchExtractor  │                │
│  │ tools             │◀──────────────────▶│ (确定性规则)       │                │
│  │ explore_tree      │                     └─────────┬──────────┘                │
│  │ explore_tree_record│                             ▼                           │
│  └──────────────────┘                     ┌──────────────────────────┐           │
│  ┌──────────────────┐                     │ GraphRegistry            │           │
│  │ prompt 静态段     │                     │ └ WorkspaceGraphStore    │           │
│  └──────────────────┘                     │   内存图 + graph.json    │           │
│  ┌──────────────────┐                     │   + journal.jsonl        │           │
│  │ webServer 路由    │◀───────────────────│   + archive.jsonl        │           │
│  └──────────────────┘                     └──────────────────────────┘           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

模块职责：

| 路径 | 职责 |
|---|---|
| `src/core/model.js` | 节点/边/状态/引用枚举与归一化、文本截断 |
| `src/core/fingerprint.js` | 去重指纹（scope + 键 → sha1 前 12 位） |
| `src/core/graph.js` | 纯函数图操作：增删改查、移动、合并、校验、序列化 |
| `src/core/store.js` | 工作区级持久化：快照 + journal 重放 + 原子写 + 归档 |
| `src/core/extract.js` | 会话事件 → 研究图节点（确定性规则、预算、去重、中途接入兜底） |
| `src/core/hygiene.js` | 未决卫生：open 节点分类/折叠计数/主题宽度平衡（只读纯函数，变更计划可审计） |
| `src/core/frontier.js` | 探索建议引擎（verify/resolve/branch/deepen/consolidate/revive/stop + avoid） |
| `src/core/compact.js` | 工具返回的紧凑文本渲染（控制在几百 token） |
| `src/host/translate.js` | DSH `SessionEvent` → 内部归一化事件（纯函数，字段变化只改这里） |
| `src/host/service.js` | 生命周期编排：每 store 一个 extractor、游标、HTTP 快照/列表、dispose |
| `src/host/tools.js` | 两个工具的定义与执行（普通对象、输出 schema、错误不抛栈） |
| `src/host/prompt.js` | 静态系统提示段（逐字节稳定） |
| `src/host/config.js` | 配置归一化与默认值（不依赖 schemastery） |
| `src/index.js` | 插件入口：注册工具/提示段/事件监听/HTTP 路由 |
| `lib/client.js` | 浏览器 bundle（手写，无构建）：conversation.view 页签 |

## 4. 数据模型

存储目录：`<workspace>/.explore-tree/`（可由 `dirName` 改）

- `graph.json`：当前快照（临时文件 + rename 原子写）。
- `journal.jsonl`：追加式操作流水（addNode/updateNode/removeNode/link/unlink/session/event），
  快照的 `meta.journalOffset` 之后的行用于恢复/审计；超过阈值轮转。
- `archive.jsonl`：`maxNodes` 超限时下沉的旧节点（含边），主图删除指针。
- `graph.json.corrupt-<ts>`：快照损坏时的隔离备份（随后从空图 + journal 重放恢复）。

### 4.1 Node

```jsonc
{
  "id": "n12",                    // 单调编号，稳定、短、可 grep
  "parentId": "n1",               // null = 根
  "kind": "goal",                 // goal|topic|question|hypothesis|step|action|evidence|decision|dead_end|conclusion|artifact|note
  "title": "一句话标题（<=120 字）",
  "summary": "摘要（换行保留，<=8000 字）",
  "status": "open",               // open|active|done|abandoned；conclusion 默认 done
  "confidence": null,             // 0..1 两位小数
  "tags": ["web", "unverified"],
  "origin": "auto",               // auto|model|user
  "sessionId": "session-…",       // 产生它的会话（跨会话共享时仍保留 provenance）
  "turn": 3,
  "stepId": "n9",               // 时间线（step 只作时间标记，不再当语义父节点）
  "digest": "子节点摘要的摘要",  // topic 专用；<=120 字，模板合成或人工/LLM 编辑
  "digestSource": "template",    // template|llm|human
  "digestBasis": { "children": ["n13"], "hash": "…" }, // 摘要依据（判断过期）
  "owner": "agent-1",            // 可选：多 agent 认领者
  "leaseUntil": "…",             // 可选：租约到期（ISO）
  "leaseEpoch": 2,               // 租约代数：认领/续租/释放/抢占都 +1（P5.2 fencing）
  "nodeVersion": 5,              // 节点写版本：每次结构/字段写入 +1（P5.1 CAS）
  "createdBy": "agent-a",        // 首次写入者（P5.0 actor）
  "updatedBy": "agent-b",        // 最后写入者
  "priority": "P1",              // 可选：P0..P3
  "revision": 3,                 // digest 修订号（摘要历史；与 nodeVersion 分开）
  "refs": [{ "kind": "url|file|tool_call|artifact|session|message", "value": "…", "label": "…" }],
  "fingerprint": "a1b2c3d4e5",    // 去重指纹
  "hits": 1,                      // 指纹命中次数（重复劳动信号）
  "order": 17,                    // 兄弟排序
  "createdAt": "…", "updatedAt": "…",
  "mergedFrom": ["n7"],           // 合并过的节点（可选）
  "auto": { "rule": "tool-call" } // 诊断信息（可选）
}
```

`kind` 语义：`goal` 目标/用户请求；`topic` 摘要主干（父节点是子节点摘要的摘要，v0.13）；`question` 子问题；`hypothesis` 可验证假设；
`step` 一轮研究活动（reasoning 摘要放这里）；`action` 一次工具动作；`evidence` 证据；
`decision` 取舍；`dead_end` 确认走不通（带原因）；`conclusion` 结论/答案；`artifact` 产物；`note` 笔记。
`step` 是时间线标记（`stepId` 记录），主干视图隐藏；语义节点应挂在 topic/叶根下。
自动种子（v0.15）：goal 下没有任何 topic、且单轮想法 ≥ `topicSeedMinClaims` 时，提取器自动建一个
`tags:[candidate,auto-topic]` 的 topic（标题取轮次意图），把本轮直接挂在 step 下的想法迁到该 topic，
记 `activeTopicId`；已有 topic 但全部满仓/关闭时（v0.22.1），单条想法也可另起候选主题。
后续轮次按 activeTopic 挂载，人工可改名/合并/promote。
自动挂载（v0.14）：goal 下有 topic 时，提取器把 approach 直接挂到 `activeTopic` 下（成为叶根），
dependent 挂同轮最近的 approach（否则 topic 下最近的叶根），并写 `stepId` 保留时间线。

### 4.2 Edge（旁支关系）

```jsonc
{ "id": "e3", "from": "n4", "to": "n7", "kind": "supports", "note": "…", "createdAt": "…" }
```

`kind`: `supports|contradicts|refines|depends|replaces|duplicates|continues|related`。
边不参与树遍历，只参与查重、矛盾提示与 UI 展示。

### 4.3 Graph

```jsonc
{
  "version": 1,
  "workspaceRoot": "<workspace>",
  "createdAt": "…", "updatedAt": "…",
  "seq": 42,                       // 下一个节点号
  "nodes": { "n1": {…} },
  "edges": { "e1": {…} },
  "roots": ["n1"],
  "sessions": {
    "session-…": { "sessionId": "…", "activeNodeId": "n9", "goalId": "n1", "turn": 3,
                   "createdAt": "…", "lastSeenAt": "…" }
  },
  "meta": { "extractor": "deterministic-v1", "journalOffset": 1234 }
}
```

不变量（`validateGraph`）：父节点存在、无环、无自父、`parentId` 单父；边端点存在且不重复；
主干约束（`core/trunk.validateTrunk`）：topic 父节点必须是 goal/topic、子节点必须是 topic 或叶根、
topic 必须有 digest；叶根应挂在 topic 下；主干深度 ≤4、宽度 ≤9（WARN）。
`roots`/子索引/指纹索引与节点一致。

## 5. 工作区共享与持久化

- `GraphRegistry` 每个 canonical workspace root 一个 `WorkspaceGraphStore`（进程内单例）。
  key = realpath 归一后的根路径（Windows 大小写不敏感、分隔符统一；失败回退 resolve）。
- 会话根解析：`session.header.cwd` 优先，`ctx.workingDirectory.get(session)` 兜底。
  子代理会话与主会话同 cwd 时共享同一棵树（需求 8）。
- 写入：操作先改内存 → 追加 journal → 250ms debounce flush 原子写 `graph.json`；
  写队列串行，避免并发写坏文件。
- 恢复：启动/首次访问时读 `graph.json`，重放 `meta.journalOffset` 之后的 journal 行；
  快照损坏则隔离为 `.corrupt-<ts>`，从空图 + journal 恢复。
- 容量：`maxNodes` 超限把最旧的 done/abandoned 叶子下沉 `archive.jsonl`；journal 超限轮转。
- 跨进程：不做锁（非目标）；同一 host 进程内的多会话是主要场景。

## 6. 自动提取（不干扰主对话）

### 6.1 事件源

`ctx.on('session/event', (session, event) => …)` 旁路订阅（post-commit），只读。
`src/host/translate.js` 把宿主 `SessionEvent` 归一化成内部事件：

| 宿主事件 | 内部事件 |
|---|---|
| `user/message` | `user.message`（文本 + `sourceKind`；只有 `source.kind === 'user'` 或旧事件缺省是真人，其余注入消息只更新运行时上下文） |
| `turn/start` / `turn/end` | `turn.start` / `turn.end`（含 turn/seq；`turn.start` 不再借用上一轮用户文本当标题） |
| `assistant/message` | `assistant.reasoning`（content 里的 reasoning 块）+ `assistant.message`（文本；带 turn/step） |
| `tool/call` | `tool.start`（callId、工具名、参数） |
| `tool/result` | `tool.end`（成功/失败、结果摘要；工具名/参数从 callId 的调用记录补回） |
| `deliverables/presented` | `deliverable.presented`（path/description，交付物） |

不写会话、不触发新回合；事件原文只按截断摘要进图/流水账。

### 6.2 确定性规则（默认开启）

| 信号 | 规则 | 产物 |
|---|---|---|
| 真实用户消息 | 只认 `source.kind === 'user'`（旧事件缺省兼容）；首句截断为标题；同会话重复请求按指纹合并 `hits++` | `goal` |
| 注入消息 | 时间采样/审批策略/工具通知等只写 runtime 上下文，不建节点、不当标题 | 无 |
| 一轮开始 | 建/复用本轮 `step`：优先正常指纹，其次中途接入的 midway step（升级指纹并 move 到目标下）；标题先占位，真实用户消息到达后回填「第 N 轮：意图」 | `step` |
| 推理文本（主） | 先 `thoughtSource` 取头+尾（默认 ≤60000 字符），`splitThoughts` 切分（去代码块、bullet 独立、续行/公式碎片并回上一段、12–400 字符）→ **句级 claim 切分**（`#claimSegments`：一句一 claim，短句并回上句，一段最多 4 条）→ `classifyClaim` 多特征矩阵（question/failure/hypothesis/evidence/decision/conclusion + 具体性/命题性，argmax + margin 阈值；过程旁白折叠）→ 候选池 → `selectClaims`（轮内近似去重、MMR 去冗余、分层配额、结论预留槽、`maxThoughtNodesPerTurn` 总上限）→ 对账落节点。`selectionStrategy=chronological` 可回退旧「先到先得」逻辑（配 `minThoughtScore`） | `question` / `hypothesis` / `evidence` / `dead_end` / `decision` / `conclusion`（`note` 默认折叠） |
| 英文/数学推理 | 规则同时覆盖中英文线索（`because/case/hypothesis/therefore` 等）与 LaTeX 公式；不按语言扣分；英文句号按「句号+空白」切分，避免切开 `v0.4.0`/`docs/x.md` | 同上 |
| 推理文本（摘要） | 前 `maxReasoningChars` 字符截断追加到本轮 step.summary | `step.summary` |
| 工具调用 | **默认每轮一个汇总节点**：轮内标题固定「工具调用（本轮）」，轮末一次性定稿「工具调用 ×N（read、grep…）」+ 各工具次数；`toolCallMode=nodes` 可切回逐调用节点 | `action` |
| 工具失败 | step 下直接建 `dead_end`（错误摘要），不套动作节点 | `dead_end` |
| 交付物 | `deliverables/presented` 的 files（path/description）建 `artifact`（tags `deliverable`）；写类工具（`WRITE_TOOL_PATH_FIELDS`：write/edit/str_replace_editor）参数里的文件经存在性、扩展名白名单与目录排除校验后建 `artifact`；读文件/回显文本里的路径不再算产物 | `artifact` |
| 轮末/助手文本 | 含「结论/小结/总结/综上/因此/最终答案」等标记句 | `conclusion` |
| 无推理链的长回答 | **兜底结构化**：`splitAnswerSections` 按 Markdown 标题（`##`）或独立加粗小标题（`**记号.**`）切段；标题是主要阶段挂 step 下，加粗小标题是当前阶段的子论点；结论标题落 `conclusion`；无分段时才走上一行的整篇结论 | `note`/`evidence`/`hypothesis`/`conclusion` |
| 事件顺序错位 | 宿主真实顺序可能是 `turn/start` 先于 `user/message`；goal 落库后把同会话孤立 root step 归到目标下（`#adoptRootSteps`），旧图由 `adopt-orphan-steps` 迁移修复；中途接入的 midway step 被后续 `turn/start` 复用，不再建第二个 | `step.parentId` 修正 |
| 进入旧会话但本工作区无图 | `session/created` → `backfillSession` 回放 `session.snapshotEvents()`（最近 1200 条），按同一套规则补建；已有 step 的会话跳过。宿主未发 `session/created` 时，首个事件也会触发同一回放（`backfillHistory`） | 整棵树 |
| 轮次中断/失败 | step 标 `abandoned`；未完成 action 标失败 | 状态更新 |
| 插件中途接入 | 既无 goal 也无 step 时补「接入前」容器 step，避免动作散落成根；后续轮次开始会复用 | `step` |
| 同轮重复 step（旧图） | 首次读取时 `merge-duplicate-steps` 迁移：按 session+turn 分组，保留正常指纹节点，其余子树/命中/引用并过去后删除 | 图修正 |
| 跨轮延续 | 新 step 与同会话上一 step 建 `continues` 边；新 claim 与往轮节点按标题/整段相似度（max，≥`threadLinkThreshold`）建 `supports`/`refines`/`replaces`/`contradicts` 边，每节点取最佳一条（evidence→假设 supports；结论→假设 supports；decision→旧 decision replaces；dead_end→假设 contradicts；假设→假设/结论 refines） | `edges` |
| 同轮子方法 | approach（question/hypothesis/decision）与同轮更早的 approach 相似度 ≥ 门槛时挂成它的子节点（子方法/子假设），否则挂 step | `parentId` |
| 轮次收束 | ranked 模式 turn 结束把 decision/hypothesis/question 写成「关键：」、conclusion/evidence/dead_end 写成「结果：」，追加进 step.summary（不覆盖已有人工摘要） | `step.summary` |
| 重复指纹 | `hits++`，UI/工具里可见「重复劳动」信号 | 节点字段 |

推理链是树的主要来源：先切「想法单元」，再切句、按多特征矩阵分信息类型，再按信息量取舍；对错都保留，
节点只表达「这是什么信息」与「当前状态」，不做正确性判定。取舍阶段只回答「这一轮哪 ≤10 条值得上树」：
过程旁白折叠进 step 摘要（`过程观察 ×N`），同层超额候选不落节点，近似重复只留一条，结论单独留槽。
层级规则：假设/问题/决策作为「思路节点」挂在当前 step 下，后续证据/观察/结论优先挂到这条思路上，
形成多层树；工具调用只作为动作/产物旁证。

**不记录**：`ignoreTools` 里的工具（默认两个插件自身工具，防止反向污染）；每轮自动节点数
上限 `maxAutoNodesPerTurn`（默认 80）与想法节点上限 `maxThoughtNodesPerTurn`（默认 10），
单条 reasoning 最多切 `maxThoughtUnitsPerBlock`（默认 8）个想法，读取上限
`maxThoughtSourceChars`（默认 60000，超长取头+尾）。

轮次预算由想法节点与自动结构节点共用：工具聚合动作、失败 `dead_end`、产物/交付物、
轮末中断都检查同一 `maxAutoNodesPerTurn`；指纹命中只累加 `hits`，不占预算；`step`/`goal`
不占。跨轮 adopted 的候选落选时只解除本轮 `claimNodes` 映射，不删除历史节点。

轮级状态只在该轮第一次 `turn.start` 时初始化（`runtime.startedTurn`）：重复投递的 `turn.start`
不会重置预算/告警/claim；迟到的旧轮 `turn.start` 只返回已有 step，不回退 `runtime.turn`。

**未决卫生与主题平衡（v0.21）**：`src/core/hygiene.js` 把 open/active 的
`question/hypothesis/decision` 分成四类：

- `current`：人工写入、带 blocker 标签、或直接挂在 topic/step/goal 下的当前未决；进首屏；
  step/goal 是结构与时间节点，不是想法节点；旧图没有 topic 时，step 下的真实未决也可见（v0.22.1）；
- `noise`：自动提取的过程旁白/计划句、被误分类成 question 的陈述句、无假设信号的 observation；
- `stale-topic`：最近 topic 已 done/abandoned 且节点本身不实质；
- `detail`：current 但嵌套在想法节点下，不是当前行动项；只折叠计数。

`collectOpenItems` 返回 `total/visible/visibleCount/hiddenCount/noiseCount/staleCount/detailCount`，
`overview`、前端快照和未决面板共用它，不再平铺全部 open 节点。`planOpenCleanup` 只产出计划：
噪音/陈旧项改为 `abandoned` 并加 `auto-curated` + `reasoning-noise`/`stale-topic` + `archived`，
summary 追加「自动收敛：原因」；带 blocker 的节点不收敛；topic 直接叶根超过
`maxOpenLeavesPerTopic`（默认 9）时，只隐藏 origin 为 `auto` 的 done/abandoned 叶根（补 `archived`
与 `auto-curated` 标签），人工完成项与真正的 open 叶根不动。执行方逐条 `updateNode`，不删除节点，
可按 tags 审计或回滚。

提取侧同步收紧：`claim.kind=question` 但 `isQuestionText` 为 false 的陈述句只计轮次旁白；
question/hypothesis 命中过程旁白同样不落节点；疑问句在计划句判定之前放行（But/Also/Interesting、
is there、did/do/does + 双词主语、should + 名词主语、中文中置疑问词），`cleanTitle` 去掉末尾问号后
仍按 `isQuestionText` 保留为实质未决（v0.22.1）。`#pickTurnTopic` 按「open 叶根数升序、更新时间降序」
选主题，满仓的 active topic 不再复用；已有 topic 全部满仓/关闭时，单条想法也由 `#maybeSeedTopic`
另起候选主题，只有完全没有任何 topic 才要求 `topicSeedMinClaims`。
`frontier.deadEnds`、`overview` 的死路统计与轮首增量的「放弃」都排除 `auto-curated`，
避免自动收敛项被误当死路。

### 6.3 可选 LLM 辅助（v0.12，默认关闭）

`config.llm.enabled=false`。开启且 `provider`/`model` 成对配置时，提取器在轮末把
「用户意图 + 本轮已提取节点 + 推理摘录（头 70% + 尾 30%，≤`maxInputChars`）」交给宿主
`ctx.llm`，要求严格 JSON：`{"claims":[{kind,title,summary,parentId}]}`。

- 调用：`ctx.llm.prepareCall({provider,model,maxTokens})` + `call.stream({...config,messages,system,purpose:'explore-tree-extract'})`；
  插件不 import DSH 包（link 安装的独立包只依赖注入进来的服务对象）；
- 时序：轮末异步，不阻塞事件摄取；任务登记在 `llmJobs`，超时 `timeoutMs`，失败只记日志；
- 校验：解析容错代码块/前后缀；kind 白名单（hypothesis/evidence/decision/conclusion/dead_end/question），
  parentId 必须指向本轮已有节点或 step；
- 落库：仍走 `#addOrHit`（指纹 `auto:llm` 去重），tags 带 `llm` + kind，UI 显示 `AI`；
  不覆盖确定性节点，不写主会话。
- digest（`llm.digest=true`，默认关）：轮末把 topic 的直接子节点标题/摘要交给模型重写 digest
  （≤120 字）；失败保留模板摘要，`digestSource=human` 不覆盖。

### 6.4 多 agent 协作（v0.16，P5 写安全 v0.19）

- **租约**：`assign` 默认写 `owner` + 30 分钟 `leaseUntil`；`leaseStatus` 判定
  unowned / leased / expired / owned，`claimableTopics` 汇总未认领与过期的 topic。
- **建议**：`trunkFrontier` 对未认领/过期 topic 给 `claim`（理由区分「未认领」与「租约已过期」）；
  `brief` 加一行「可认领：…」；`trunk` 行内显示 `@owner`。
- **交接**：`brief` 即会话内交接包（目标 + 主干 digest + 未决叶根 + 下一步），`trunk` 是主干地图。
  v0.20 增加显式 `handoff`：同一图操作内转移 `owner/leaseUntil/leaseEpoch`，并在 topic 下写
  `kind:conclusion, tags:['handoff']` 的交接包（digest + 未决叶根 + 最近关键节点）；该节点不算叶根。
- **Team 映射**：核心函数 `topicTaskPayload(topic)` 产出 `{subject, description, tags}`，
  可直接映射为 `team_task_create` 入参；`writeScopes` 由调用方补文件前缀。
  topic 的 status 不自动回写任务板，避免双写漂移（由 agent 用 `updateNode`/Team 工具显式同步）。
- **冲突**：用 `contradicts` 边表达互斥结论；两端最近 topic 相同时，`topicConflicts` 把它归到该 topic，
  `trunk` 标 `⚠冲突`、`brief` 列「冲突：…」、`trunkFrontier` 给 `resolve`、`handoff` 交接包也带上。
- **P5（v0.19）**：
  - `nodeVersion` 与 `expectedRevision`：所有写动作可做节点级 CAS；冲突返回 `STALE_REVISION`
    与当前版本/摘要/最后写者，`revision` 只记 digest 历史，不复用。
  - `assignLease`：只接受 topic；`renew/steal`、`leaseEpoch`（认领/续租/释放/抢占都 +1）；
    `assignLease` 与 `updateNode/moveNode/mergeNodes` 都在 graph 层校验 expectedRevision。
  - 工具层显式 `actor` 时按「最近已认领 topic」判写域（跨域 `OUT_OF_SCOPE`、过期 `LEASE_EXPIRED`），
    `lead/curator` 例外；不传 actor 走 0.18 兼容路径。
  - `graph.lock` 串行化跨进程写；锁内 `refreshFromDisk`（快照戳 + journal 大小）→ 重放 → 落盘，
    `journalOffset` 用真实字节数，半行告警后停在可重试点。
  - **v0.20（P5.4/P5.6）**：`handoff` 单操作转移租约并落交接包；topic 级 `conflicts` 可见；
    自动提取节点带 `actor:'extractor'`，journal 可区分系统提取与 agent 显式写。
  - **v0.20.2**：工具聚合节点轮内不重写、轮末一次定稿；`stats` 增加 `byCreator/byUpdater`
    per-actor 分布，可直接看 extractor 与显式 agent 的写入占比。
  - **v0.20.3**：长轮次候选池有界替换——重复片段只累加 `hits` 不占池位，池满淘汰未发布
    最低分候选，晚到结论不再被截断。
  - **v0.20.4**：跨轮 adopted 节点落选只解除映射不删除；工具聚合/失败/产物/交付物/轮末中断
    统一受 `maxAutoNodesPerTurn`（重复指纹不占预算，每轮一条超限告警）；`graph.lock`
    对瞬时 `EPERM/EBUSY/EACCES/ENOENT` 按竞争重试，仍以 2s 为界并在超时错误里保留最后错误码。
  - **v0.20.5**：重复/迟到 `turn.start` 不再重置或回退轮级状态（`startedTurn` 区分「重复投递」
    与「user.message 先到的新轮」）；锁等待分支加 5–25ms 退避，清理成功后立即重试一次，避免热循环
    与清理成功仍误报超时。
  - **v0.21.0**：未决卫生（过程旁白/伪问题/无信号假设过滤 + 旧主题折叠 + 推理细节折叠）；
    `planOpenCleanup` 只改 status/tags/summary，不删除节点；topic 增加 `maxOpenLeavesPerTopic`
    宽度水位线；overview/面板的未决计数改为可见项，并显示折叠分类。
  - **v0.22.0**：轮首简报改为「有 goal 即注入；首次完整，之后只推增量」，service 内存快照 +
    `renderBriefDelta`，无变化不注入，`compaction/end` 仍强制完整简报。
  - **v0.22.1**：未决卫生审查收口——step/goal 下的未决重新可见；疑问句先于计划句判定；
    `cleanTitle` 去问号后仍按疑问句保留；blocker 在分类与收敛两侧豁免；`auto-curated` 不计入
    死路与「放弃」增量；主题满仓时单条想法也可另起候选主题；顶栏与面板共用 `openUnresolved`；
    宽度隐藏只动自动完成项。
  - **v0.23.0**：面板显示/过滤开关移入 `settings.section` —— 新增「研究轨迹」设置分区，
    偏好统一存 `explore-tree.prefs.v1` 并由面板/设置页共享；工具栏只留画布操作。新增
    `.github/workflows/release.yml`：推 `v*` tag 时在 windows-latest 跑语法检查、177 项单测、
    `npm pack` 并创建 GitHub Release（附带 tarball）。
  - **v0.23.1**：v0.23.0 Release 失败修复——`snapshotFor` 先 canonical 化工作区路径，避免 Windows
    8.3/别名路径读到另一个 store；`graph.lock` 的 `stat` 瞬时 ENOENT 不再删除活锁，陈旧锁清理前
    二次核对 mtime/size，等待改为 5–15ms 随机退避并对竞争过的释放让出 0–3ms；release workflow
    增加 tag 与 package 版本一致性校验；设置页偏好监听 `storage` 跨标签页同步。
  - 未做：多 agent 对照实验（H4 协议已预注册）；自动提取仍不启用租约写域（只做归属，不阻断）。

### 6.5 归档与摘要版本（v0.17）

- **归档**：`record archive` 给节点打 `archived` 标签并置 `done`；`trunk` 渲染与面板主干视图默认隐藏，
  `trunk({archived:true})` 可显示并计入统计（`trunkStats.archivedLeaves/archivedTopics`）；
  `unarchive:true` 恢复为 `open`。归档只影响展示与建议，不删节点、不影响检索。
- **摘要版本**：graph 的 `updateNode` 在 digest 真正变化时追加 `digestHistory` 条目
  `{digest, source, at, revision}`（最多 20 条，旧→新）；`rollback` 取
  `history[length-1-version]` 写回，`digestSource` 置 `human` 防止被 LLM/模板覆盖。
- **检索**：`find` 的命中范围加入 digest；标题或 digest 命中记 2 分，先行返回。

## 7. 前缀稳定（缓存命中）契约

1. **系统提示段静态**：`src/host/prompt.js` 只含协议文本与固定工具名，不含时间、节点数、
   工作区名、节点 id；只注册一次。
2. **工具面固定**：两个工具始终注册、描述与参数 schema 不变；不按图状态动态注册/改描述。
3. **动态信息只经工具返回值**：`explore_tree` 返回当前图状态；返回值是追加内容，不改历史前缀。
4. **不写回主对话**：提取器、UI 刷新、HTTP 轮询都不产生会话消息；后台任务不挂主会话。
5. **不改变已有消息**：不编辑、不重排、不替换；节点 id 单调增长。
6. **测试**：`test/unit/prefix.test.js` 断言提示段文本不含动态内容、图增长前后工具面
   序列化结果逐字节一致、动态状态只出现在工具返回值里。
7. 唯一例外（记录在案）：插件启用/停用/升级会改变工具面，属宿主行为；运行期不切换。

## 8. 探索建议引擎（frontier）

输入图 + 当前焦点，输出**混合**建议（每类最多若干，按优先级排序），每条含 `type`、
`nodeId`、`title`、`reason`、`basis`。实现：`src/core/frontier.js`。

| 类型 | 触发 | 建议 |
|---|---|---|
| `seed` | 空图/无目标 | 先把目标与第一个待验证问题记下来 |
| `stop` | 目标已有 conclusion 且无 open 问题 | 收敛，转整理产物 |
| `verify` | 假设既无 evidence 子节点、也无指向它的 supports 边或 refines 进来的结论 | 设计验证实验，别把未验证判断当事实 |
| `resolve` | 存在 open 的 question/decision，或 contradicts 边 | 找判定性证据/做决定并记 conclusion |
| `branch` | 目标/问题 open 且无子节点；或假设独生子；或存在未被探索的兄弟路径 | 提出替代假设/换来源，明确「不同机制」而非重复 |
| `deepen` | 证据丰富但无结论 | 归纳结论并登记 |
| `revive` | 死路/失败属暂时性（超时/网络/限流/权限）或已有新证据 | 换通道重试；reopen 需写新证据 |
| `consolidate` | 指纹 `hits>1` 或重复节点 | 合并/复用既有结论，停止重复劳动 |

**防瞎探索**：同时返回 `avoid`（死路 + 原因），并保证建议中「验证/收敛」类至少一条（若存在），
避免只追求新分支；`verify`/`stop` 类带 `overconfident` 标记（高置信度无证据）。

**边参与判定（v0.8）**：`supports`/`refines` 边视为「该假设已有依据」，不再进 `verify`；
`contradicts` 边（证据/死路 → 假设）既用于把互斥假设算作「已发散」，也用于 `revive` 的理由
（「通过 contradicts 边否定了假设」）；`notes` 里给出 supports 边数量与存在冲突证据的假设数。

## 9. 可视化（DSH Web 内：会话上栏页签）

- `lib/client.js`：手写 `__ModuleLoader__.load` bundle，只依赖平台 seed 的 `react`。
- 唯一槽位：`conversation.view` `{ id: 'explore-tree', order: 45, label: () => '研究轨迹' }`，
  即会话上栏页签行里「轨迹」与「上下文」之间的「研究轨迹」。不再注册侧栏图标、`main`、
  顶栏常驻按钮或 `shell.overlay` 弹层（用户反馈：顶栏按钮冗余且不解决图空白）。
- 面板（v0.10）：
  - 轮首简报注入（v0.22 增量）：`agent/pre-step` 追加一条 `source.kind=explore-tree-context` 的 user 消息
    （≤400 字：目标/主干 digest/其他主干/未决叶根/主干建议），同一轮最多一次，`compaction/end` 后强制补一次；
    `injectBrief=false` 可关。会话已有 goal 即启用（不再要求先有 topic）。service 在首次注入时保存
    `snapshotBriefState`（节点 id/kind/title/status/parentId/updatedAt），之后只渲染 `renderBriefDelta`：
    新增关键节点（conclusion/decision/dead_end/topic/artifact 优先，最多 3 条）、完成/放弃、标题或父节点变化、
    合并/移除；step/action 等结构节点的状态变化不计入。树没有值得说的变化时返回空串并跳过注入，
    但该轮已标记检查；只有真正注入才更新快照，变化不会丢，下一次照样进增量。
    `briefScope` 默认 `workspace`：额外列「其他主干：…」（同工作区其他 goal 的 topic + digest/owner），
    让多 agent 看到共享主干；`goal` 保留旧的单 goal 视图。
  - 「主干 / 研究」切换：主干视图只保留 goal/topic 与直接挂在 topic 下的叶根，时间桶 step 隐藏；
    研究视图保留全部节点。topic 卡片显示 digest、主题进度（叶 done/total）与 owner；
    详情栏显示「摘要 · 父节点是子节点摘要的摘要」。
  - 工具栏：①标题、工作区、节点/想法/未决/关系/层深统计 + `折叠` `展开` `适应宽度` `最新`、
    缩放组（20%–160%）与 `刷新`，并提示「显示选项在 设置 → 研究轨迹」；②搜索（标题/摘要/标签，`下一个` 自动展开祖先）+
    轮次 chips（`第 N 轮 · 子节点数`）与按 kind 的图例计数。
  - 设置页「研究轨迹」分区（`settings.section`，id `explore-tree`，order 518）：显示组 `autoRefresh`
    `compact` `showOutline` `showInspector`，过滤组 `hideActions` `hideArtifacts` `hideNotes`
    `onlyOpen` `onlySession`；偏好存 `localStorage` 的 `explore-tree.prefs.v1`，面板与设置页通过订阅实时同步，
    其他标签页改动由 `storage` 事件跟进；「恢复默认」只重置偏好、不碰图数据。
- 详情栏长摘要默认折叠为「摘要 + 展开全文 · N 字」；LLM 节点卡片带 `AI` 标记。
- 左：**大纲**（目标 + 每轮标题与子树计数，点击定位，可在设置页关闭）。中：自上而下的**卡片树**（父卡在上、
    子卡在下，贝塞尔连线，选中路径高亮；卡片含 kind 徽标、标题、摘要、状态、**子树统计**与折叠按钮）。
    布局按「打包行」放置：同一父节点的子卡超出一行宽度（约 920px）即换行堆叠，父卡居中于子块，
    多个根纵向堆叠，避免宽树被拉成几屏宽；`transform:scale` 实现缩放 + 外层横纵滚动；未手动缩放时
    按画布宽度自动适应；缩放锚点按操作来源取：工具栏围绕视口中心、`fitWidth` 取左上角、
    `Ctrl/⌘+滚轮` 取指针位置，缩放后按比例回填 `scrollLeft/scrollTop`，内容不跳。
    指针拖动平移用 pointer events + `scrollLeft/scrollTop`（4px 阈值后才算拖动，拖动后抑制一次 click，
    避免误选中卡片；中键拖动同样可用）；选中卡用自算 `scrollLeft/scrollTop` 定位，不再调用
    `scrollIntoView`，避免把整页一起滚动；子节点超过 8 个默认折叠。
    跨轮/跨分支关系（supports/refines/contradicts/continues 等）画成按 kind 着色的虚线，选中端点时高亮。
  - 右（可收起，收起后可在设置页重新打开）：选中时节点详情（kind/status/confidence/summary/tags/refs/关系列表/可点根路径/子节点列表）；
    无选中时图概况（统计、类型分布、未决、根节点）。未决只计 `collectOpenItems().visibleCount`，
    并显示「已折叠 X：旁白 / 旧主题 / 推理细节」，不再把全部 open/active 节点平铺。
    底部 frontier 建议（`<details>` 折叠）与 `avoid` 死路。
  - 轮询 3s 保留缩放/选中/折叠状态；`fitWidth` 按画布宽度计算缩放（0.2–1.6），手动缩放后不再自动改；
    滚轮默认滚动，`Shift+滚轮` 横向滚动，`Ctrl/⌘+滚轮` 以指针为锚点缩放；画布 `overscroll-behavior:contain`，滚到边界不穿透页面。
- 默认隐藏 `action` 节点（旧图里有几百个）；旧图 `note`（P0/P1 前的 process 旁白）也默认折叠，
  可在设置页取消「隐藏笔记」。可见子节点就近挂到未隐藏祖先，不破坏树形。
- 首帧在数据到达前显示「正在读取研究图…」；画布对空数据防御，不因瞬时无快照而崩溃。
  布局契约沿用客户端 API 调研 §5.3（页签不自建纵向滚动容器）。
- 数据：`GET /explore-tree/workspaces` + `GET /explore-tree/snapshot?workspace=…`，
  打开时 3s 轮询；当前工作区优先会话 cwd（`props.sessionId` + `useSessions`），
  其次 `localStorage['explore-tree.workspace.<sessionId>']`，最后第一个已知工作区。
- 全局工作区索引：`$DSH_HOME/explore-tree/workspaces.json`，供服务端 `allowsRoot` 与未来
  扩展使用；无会话时没有页签入口（`conversation.view` 作用域如此）。
- 信任边界：端点只服务本机请求（`127.0.0.1`/`::1`），仅 GET；只允许
  `workspaceRegistry`/`GraphRegistry`/全局索引/已存在 `.explore-tree/graph.json` 的工作区，
  未知路径 404。


## 10. 工具契约

### `explore_tree`（只读）

```
action: overview|frontier|stats|find|node|path|tree|subtree   （省略=overview）
query?（find 关键词）  id?（node/path/subtree 节点 id）  focus?（焦点节点 id）  limit?（1..20）
depth?（tree/subtree 层数 1..8，默认 3）  —— 返回缩略树，不返回整棵树
```

返回 JSON（`{ok, action, text}`，`additionalProperties:true`），`output.render` 渲染成等宽文本。
默认 `overview`：目标 + 焦点 + 两层大纲 + 活跃节点 + 前 3 条 frontier 建议 + 可用 action 提示，
控制在 ~1500 token 内；**指定会话时只汇总该会话的节点**（树跨会话共享，避免把别的会话历史重贴一遍），
目标标题截到 60 字。`find` 搜标题/摘要/标签/引用，标题命中优先，摘要命中附 80 字片段。
`explore_tree` 自身调用不记图（再避免反馈环）。

### `explore_tree_record`（显式记录）

```
action: add|update|move|link|close|reopen|merge|promote|assign|handoff|digest|archive|rollback
id?  parentId?（add 省略=当前焦点，''=根）  kind?  title?  summary?  status?  confidence?
tags?  refs?  from?  to?  edgeKind?  note?  dropId?  reason?  owner?  leaseUntil?  toActor?  digest?
children?（add 时一次建一层子节点，≤20）
```

- `add`：模型显式登记目标/假设/结论/死路/决策（语义判断优先于自动提取）；`children` 让「建父 + 挂子」
  一次往返完成，返回 `{id, children:[{id,kind,title}]}` 便于继续挂更深的层级。
- `update`：只改传入字段；`move`：改父节点（禁成环）。
- `close`：done/abandoned（死路必须写原因）；`reopen`：重新打开（死路需新理由）。
- `link`：建旁支关系；`merge`：把 `dropId` 合并进 `id`（保留被合并指针）。
- `handoff`：把 topic 租约转给 `toActor` 并写交接包；旧 owner 之后的写返回 `OUT_OF_SCOPE`。
- `assign`：认领/续租/释放；`digest`：人工摘要；`archive`/`rollback`：归档与摘要版本恢复。
- 写操作立即改内存 → 异步 flush；UI 3s 轮询可见。

## 11. 配置

```yaml
- id: explore-tree
  config:
    enabled: true
    autoCapture: true
    extract:
      captureReasoning: true
      captureReasoningNodes: true
      captureToolCalls: true
      captureAnswerSections: true
      minAnswerChars: 400
      minSectionChars: 16
      maxAnswerSections: 10
      repairOrphanSteps: true
      expandLegacyAnswers: true
      backfillHistory: true
      captureArtifacts: true
      detectConclusions: true
      ignoreTools: [todo_write, get_goal, schedule_list]
      maxAutoNodesPerTurn: 80
      selectionStrategy: ranked   # ranked | chronological
      maxThoughtNodesPerTurn: 10
      maxThoughtUnitsPerBlock: 8
      thoughtQuotas: { dead_end: 3, conclusion: 1, decision: 3, hypothesis: 3, evidence: 3, question: 2, note: 0 }
      dedupeSimThreshold: 0.85
      mmrLambda: 0.7
      reserveConclusionSlots: 1
      claimMinConfidence: 1.2
      claimMargin: 0.35
      threadLinkThreshold: 0.55
      intraTurnLinkThreshold: 0.15
      noteNodeMode: fold          # fold | node
      minThoughtScore: 1          # 仅 chronological
      minThoughtChars: 12
      maxThoughtChars: 400
      maxThoughtSourceChars: 60000
      maxReasoningChars: 2400
      maxSummaryChars: 1200
      maxTitleChars: 120
    dirName: .explore-tree
    maxNodes: 5000
    promptSection: true
    http: true
    llm:
      enabled: false     # v1 预留
```

所有字段都有安全默认值；未知字段透传；坏配置回退默认，不阻断插件加载。

## 12. 测试与验收

- 单元（`npm test`，`node --test`）：100 项 / 9 个 suite
  - `model.test.js`：枚举归一化、截断、tags/refs。
  - `graph.test.js`：增删改、移动禁环、合并、校验、序列化往返。
  - `store.test.js`：落盘恢复、journal 重放 id 一致、损坏隔离、registry 共享、原子写。
  - `frontier.test.js`：建议混合、avoid、去重、过度自信标记。
  - `extract.test.js`：goal→step→action→artifact→conclusion、去重 hits、失败 dead_end、
    忽略自身工具、中断、中途接入容器、推理切分/分类/评分/标题（含英文/数学推理与公式续行）、
    想法节点预算与去重、关键想法层级（证据挂假设下）、低信息量旁白不建节点、
    工具调用聚合与 nodes 模式、重复轮次开始只建一个 step；P0：注入消息不建 goal、
    turn/start 忽略注入文本、deliverable.presented 落 artifact 并去重；P1：ranked 轮次
    候选池的分层配额/note 折叠/父子层级、chronological 回退。
  - `select.test.js`：多特征分类矩阵（整句语义优先于单关键词）、过程旁白折叠、
    标题取触发句（含句中标签）、Jaccard 近似去重、配额与结论预留槽、MMR 顺序、noteNodeMode。
  - `host.test.js`：translate 全轮序列（sourceKind/step/工具名回填/产物白名单）、
    service 摄取/HTTP/非本机 403、全局工作区索引、历史会话回放补建（reasoning → 想法节点，幂等）、
    工具读写、插件装配；P0：注入消息不建 goal 且真实消息回填轮次标题、midway step 被 turn/start
    复用、同轮重复 step 快照期迁移合并、present 交付物落 artifact。
  - `client.test.js`：bundle id/inject、双槽位注册（conversation.view + settings.section）、
    首帧加载态。
  - `prefix.test.js`：提示段静态、图变化前后工具面逐字节稳定、动态状态只走返回值。
- E2E（`scripts/`，scratch profile 不碰主 profile）：
  `install.mjs --create` → `smoke.mjs --boot --path /explore-tree/health` 9/9 PASS
  （boot graph 含插件行、client bundle 200、SSE 含行、自定义路由 200、stderr clean）。
- 真机：安装进 `web` profile 后 `GET /explore-tree/health` 200、`snapshot` 返回节点、
  `.explore-tree/` 落盘、两个会话共享同一棵树。

## 13. 里程碑（已完成）

1. 核心库（model/tree/store/fingerprint/frontier/compact）+ 单测 ✔
2. 宿主插件（事件观察 + 提取 + 工具 + 提示段 + 端点）+ 集成测试 ✔
3. 浏览器面板（手写 bundle，无构建）+ 契约测试 ✔
4. 安装进 scratch profile → e2e；再进 web profile → 真机验收 ✔
5. 文档、配置示例、脚本、清理 ✔

## 14. 风险与对策

- **会话事件字段不稳定**：`translate.js` 是唯一适配层；字段变化只改这里，核心图模型不变。
- **宿主事件不到达/顺序乱**：提取器幂等（fingerprint + event key）；工具结果先到时「补录」
  动作节点；轮末兜底扫文本。
- **前缀被破坏**：静态提示段 + 固定工具面 + 只读工具返回动态状态；`prefix.test.js` 兜底。
- **图膨胀**：指纹去重（hits）、每轮预算、`maxNodes` 归档、overview 两层。
- **未决膨胀**：v0.21 的四分类 + 折叠计数 + `planOpenCleanup` 标签化收敛；提取侧要求 question
  真的像疑问句、hypothesis 有推测信号，并给 topic 加 `maxOpenLeavesPerTopic` 宽度水位线。
  v0.22.1 收口了无 topic 图的误折叠、疑问句门控、blocker 保护与自动收敛项的死路语义。
- **Windows 路径/编码**：canonical path（realpath + 小写 key）；UTF-8 读写；原子写用
  「临时文件 + rename」。
- **服务缺失**：webServer/workspaceRegistry/workingDirectory 按 optional 处理；缺失降级，
  不阻断插件加载。
