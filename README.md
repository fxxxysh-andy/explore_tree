# 研究轨迹（dsh-explore-tree）

> 给 DSH（DeepSeek Harness）的**研究工作区共享研究树**插件：模型在推理和产出时，轨迹自动旁路
> 落成一棵可观测的树（**以推理链提取为主、只取关键想法**）；模型用两个固定工具读它、写它；
> 人在会话上栏的「研究轨迹」页签里看它（自动跟随当前会话的工作区，无需选择）。

- 树为核心：目标 → 步骤 → 想法（问题/假设/证据/决策/死路/结论）/动作/产物。
- 自动产生：旁路订阅会话事件，从**推理思维链**切出有信息量的想法、从工具调用补动作与产物；
  **不写入主对话、不触发主对话**。对错都留痕，节点只标信息类型与状态，不做好坏判定。
- 前缀稳定：系统提示段纯静态、工具面固定、动态图状态只进工具返回值——缓存命中不被破坏。
- 工作区共享：同一 workspace 下所有会话/子代理共用一棵树，落盘 `.explore-tree/`。
- 零构建：宿主侧纯 ESM JS，浏览器侧手写 `__ModuleLoader__` bundle。

设计契约见 [`docs/design.md`](docs/design.md)。

---

## 1. 能力与需求对照

| 需求 | 实现 |
|---|---|
| 完整记录研究图 | 自动提取 + `journal.jsonl` 操作流水 + 显式记录工具 |
| 观察接口 | `explore_tree`：overview / frontier / stats / find / node / path / tree / subtree（缩略返回，支持 depth） |
| 树为核心 | `parentId` 单树 + `edges` 旁支关系（8 种） |
| DSH 内可视化 | 会话上栏页签（`conversation.view`）：卡片树 + 详情 + frontier，自动绑定当前会话工作区 |
| 自动产生、不干扰 | `session/event` 旁路订阅 → 归一化 → 确定性规则；不写会话 |
| 前缀不变 | 静态提示段 + 固定工具面 + 动态状态只走工具返回 |
| 引导探索又不瞎探索 | `frontier` 混合建议（验证/收敛 + 换轨）+ `avoid` 死路 |
| 工作区共享 | `GraphRegistry` 按 canonical workspace root 复用同一 store |

## 2. 安装

前置：DSH 已安装（本包在 DSH `0.2.1-rc.5` 上验证），Node.js ≥ 20，pnpm 可用。

### 方式 A：脚本安装（推荐，带备份与验证）

```powershell
# 1) 先装到一个 scratch profile 验证（不碰正在用的 GUI）
node scripts/install.mjs --profile explore-scratch --create
node scripts/smoke.mjs --profile explore-scratch --boot --port 0 --path /explore-tree/health

# 2) 验证通过后装到当前 web profile（live 拾取，无需重启 GUI）
node scripts/install.mjs --profile web
node scripts/status.mjs --profile web
```

安装脚本会：写 bundle patch 行 → 备份 `package.json` / `pnpm-lock.yaml` → 执行
`dsh plugin --profile <p> add link:<repo>` → 校验依赖、node_modules 链接、`--dump-config` 行可组合。

卸载：

```powershell
node scripts/uninstall.mjs --profile web     # 会先备份再移除
```

### 方式 B：手工安装

```powershell
dsh plugin --profile web add link:C:/path/to/explore-tree
```

并在该 profile 的 `cordis.patch.yml` 中加入本包的 [`cordis.patch.yml`](cordis.patch.yml)
（`insert` 一行 `id: explore-tree, name: dsh-explore-tree, config: {}`）。

> 说明：`dsh plugin add` 会更新 profile 的 `package.json` 并触发一次 pnpm 安装；
> 宿主进程会 live 重组合插件行。**改宿主源码（src/**）需要下一次宿主启动才会加载新代码**；
> 改 `lib/client.js` 由 HMR 自动拾取（刷新页面即可）。

## 3. 使用

### 3.1 模型侧工具

**读**（只读，任何时候都安全）：

```jsonc
explore_tree({ "action": "overview" })
// → { ok, action: "overview", text: "……目标/焦点/最近/未决/死路/建议……" }
```

| action | 作用 |
|---|---|
| `overview` | 目标、焦点、最近节点、未决问题（自动旁白/旧主题/推理细节只折叠计数）、死路、产物、结论（默认；只汇总**当前会话**的节点） |
| `trunk` | 摘要主干：goal → topic → 叶根，带 digest、进度、owner（交流/交接用） |
| `brief` | ≤400 字研究简报：目标 / 主干 digest / 其他主干 / 未决叶根 / 下一步（轮首或压缩后读；宿主注入时首次完整、后续只推增量） |
| `frontier` | 下一步建议（含「验证/收敛」与「换轨」两类）+ `avoid` |
| `stats` | 节点/边/状态/重复劳动统计；含 per-actor 的创建者/最近更新者分布 |
| `find` | 按关键词搜标题/摘要/digest/标签/引用（标题与 digest 命中优先；摘要命中会附片段） |
| `node` | 单节点详情（摘要、引用、子节点、旁支） |
| `path` | 到根的路径 |
| `tree` | 缩略子树（受 `depth` 限制，默认 3 层） |
| `subtree` | 以某节点为根的子树（需 `id`，返回详情 + 子树） |

**写**（显式记录，语义判断优先于自动提取）：

```jsonc
explore_tree_record({
  "action": "add",
  "kind": "hypothesis",
  "title": "缓存未命中是因为工具面顺序变化",
  "summary": "依据：上一轮工具列表顺序不同；验证：比对两次请求前缀。",
  "parentId": "n4",           // 省略=当前焦点；""=新建根
  "children": [               // 可选：一次建一层子节点（≤20），省去「先建父、再逐个挂子」的往返
    { "kind": "evidence", "title": "两次请求前缀长度不同", "summary": "diff 显示 system 段多了 214 字节" },
    { "kind": "decision", "title": "先固定工具面顺序再复测" }
  ]
})

explore_tree_record({
  "action": "link", "from": "n4", "to": "n7",
  "edgeKind": "contradicts", "note": "两者对同一现象给出相反解释"
})
```

支持的 kind：`goal topic question hypothesis step action evidence decision dead_end conclusion artifact note`；
状态：`open active done abandoned`；旁支关系：`supports contradicts refines depends replaces duplicates continues related`。

### 3.1.1 摘要主干与叶节点（v0.13）

复杂研究先建 **topic（摘要主干）**，再把叶根（question/hypothesis/decision/conclusion/dead_end）挂上去；
父节点表达问题分解，时间轴用 `stepId` 记录：

```jsonc
explore_tree_record({ "action": "add", "kind": "topic", "title": "建树算法" })
explore_tree_record({ "action": "add", "parentId": "n12", "kind": "question", "title": "配额为何先到先得？" })
```

- `explore_tree({ "action": "trunk" })`：只看主干（goal → topic → 叶根，带 digest 与进度）；
- `explore_tree({ "action": "brief" })`：≤400 字简报（目标/主干/其他主干/未决/下一步），轮首或压缩后读；`scope=goal` 可退回只看当前 goal；宿主注入时首次完整，之后只推增量，无变化跳过；
- `record promote`：把叶根提升为 topic；`assign`：认领 owner/租约（多 agent）；`handoff`：转移租约并写交接包；`digest`：人工修订摘要；
- topic 的 `digest` 由子节点标题/摘要/状态**模板合成**（≤120 字，不读原文，不调模型）；
- **归档**：`record archive {id}` 把完成叶根标 `archived` + `done`，主干视图与 `trunk` 默认隐藏；
  `archive {id, unarchive:true}` 恢复；`trunk` 传 `archived:true` 可查看（含已归档叶根计数）。
- **摘要版本**：digest 每次变化都记入 `digestHistory`（≤20 版，含 revision/source/时间）；
  `record rollback {id, version}` 回滚（`0`=最新历史版本、`1`=上一版），回滚后标记为人工摘要；
  面板详情栏会列最近 3 个版本。
- 建了 topic 后，自动提取的想法会挂到 `activeTopic` 的叶根下（approach 直接成为叶根，dependent 挂同轮叶根），
  `stepId` 记录时间线；轮首有 goal 时宿主自动注入 brief：首次完整，之后只推新增/完成/放弃/更新，无变化不打扰（`compaction/end` 后补一次完整简报）；
- 还没有任何 topic 时，单轮想法达到 `topicSeedMinClaims`（默认 5）会自动建一个 `candidate` 主题，后续轮次自动挂上去；
  已有 topic 但全部满仓/关闭时，单条想法也会另起候选主题，避免新问题永久留在 step 下。
  候选主题可在面板改名/合并，或由 `promote` 转正。
- 面板顶部新增「主干 / 研究」切换：主干只画 goal/topic/叶根，研究画全部节点。


### 3.2 使用约定（系统提示里也是这段的静态版）

1. **先看再动**：开新方向前 `explore_tree overview`；接续长期研究先 `trunk`/`brief`，确认已有目标/主干/未决叶根。
2. **走错路也有价值**：失败记 `dead_end` 并写原因；`frontier` 会避开，有新证据才建议 `reopen`。
3. **多路径 ≠ 瞎换**：`frontier` 同时给验证/收敛与换轨建议；优先做能证伪当前假设的最小实验。
4. **落节点要短**：标题一句话，摘要写理由、证据与引用。
5. **不要为了同步图改前缀**：不要请求动态改系统提示/工具面；图状态只从工具返回值读。

### 3.3 可视化：会话上栏页签

安装并刷新页面后，会话上栏的页签行里会出现「研究轨迹」（`conversation.view`，`order=45`，排在记忆(40)与预览(50)之间）。**不需要选择工作区**：

- 页签自动使用当前会话的工作区（读 `session.cwd`）；同一 workspace 的所有会话/子代理共享同一张图。
- 顶部三行工具栏：
  - 第一行：标题、当前工作区名、节点/想法/未决/关系/层深统计，以及 `折叠` `展开` `适应宽度` `最新` `大纲`、缩放组（`−` 百分比 `+`，20%–160%）、`紧凑` `详情` `刷新` `自动刷新`。
  - 第二行：搜索框（标题/摘要/标签，回车跳到下一个匹配）、`隐藏动作` `隐藏产物` `隐藏笔记` `只看未决` `本会话`，以及按轮次定位的 chips（`第 N 轮 · 子节点数`）。
  - 第三行：按 kind 的图例计数，点击只看某一类，再点取消。
- 画布左侧是**大纲**（目标 + 每轮标题与子树计数，点击直接定位），可收起。
- 画布是自上而下的**卡片树**（父卡在上、子卡在下，贝塞尔连线，选中路径高亮；卡片含类型徽标、标题、摘要、状态、子树统计与折叠按钮）。布局按「打包行」放置：同一父节点的子卡超过一行宽度时自动换行堆叠，父卡居中于子块，多个根纵向堆叠，避免宽树被拉成几屏宽；首次加载或点 `适应宽度` 时按画布宽自动缩放，手动缩放后不再自动改。
- 卡片 meta 只留 id 与命中次数，底部一行是状态、**子树聚合**（`子树 12 · 假设 3 证据 2`）与折叠按钮；摘要收为 1 行、卡片 262×128，`紧凑` 模式用更小卡片换一屏信息量。
- 画布顶部有「主干 / 研究」切换；主干模式下左栏大纲同步变为主干树（goal → topic → 叶根）。
- 详情栏的长摘要默认折叠成「摘要 + `展开全文 · N 字`」，旧 step 的原始 reasoning 不再撑满侧栏；LLM 辅助产生的节点带 `AI` 标记。
- 画布固定高度：滚轮纵向滚动、按住卡片/空白拖动平移、`Ctrl/⌘ + 滚轮` 以指针为中心缩放、`Shift + 滚轮` 横向滚动、双击空白适应宽度；工具栏缩放围绕视口中心、`适应宽度` 回到左上角，缩放与选中定位都不会带动整页滚动。
- 右侧详情栏可收起：选中时显示摘要（长摘要折叠 + 展开）、标签、引用、**关系**（可点击跳转到对端）、可点击的根路径与子节点；无选中时显示图概况（统计、类型分布、未决、根节点）。`frontier` 建议与 `avoid` 死路在右栏底部折叠显示。
- 首次渲染先显示「正在读取研究图…」，数据就绪后绘图；3s 轮询保留缩放、选中与折叠状态。

页签默认绑定当前会话的工作区（读 `session.cwd`），并按会话记住上次选择的工作区。
宿主在 `$DSH_HOME/explore-tree/workspaces.json` 维护全局工作区索引，供未来扩展使用。

无会话时（刚重启还没有对话）没有页签入口，这是 `conversation.view` 的固有作用域；
需要查看某个工作区的图时，在该工作区开会话即可。




面板数据来自本机端点：

```
GET /explore-tree/health
GET /explore-tree/workspaces
GET /explore-tree/snapshot?workspace=<绝对路径>&focus=<可选节点 id>&limit=<可选>
```

端点仅接受本机 GET 请求；允许的工作区为 `workspaceRegistry` 已登记、图注册表已打开、
全局索引里出现过、或 `cwd/.explore-tree/graph.json` 已存在的路径，其它路径 404。

> 当前会话的工具面在**轮次开始时**固定：插件是运行中安装的，本会话要到下一轮（或新会话）
> 才会看到 `explore_tree` / `explore_tree_record` 工具；面板与自动记录从安装那一刻就开始工作。

## 4. 自动记录规则

| 会话信号 | 落成 |
|---|---|
| 真实用户消息（`source.kind === 'user'`，旧事件缺省兼容） | `goal`（首句为标题）；同轮后续真实消息只回填轮次意图与上下文 |
| 注入消息（时间采样/审批策略/工具通知等） | 不建节点、不参与标题，只更新运行时上下文 |
| 轮次开始 | 本轮 `step`（标题先占位；真实用户消息到达后回填「第 N 轮：意图」；中途接入的 midway step 会被复用并升级指纹） |
| 模型 reasoning（思维链） | **主要来源**：先切想法单元、再切句，按多特征矩阵分类成 `question/hypothesis/evidence/decision/dead_end/conclusion`；`ranked` 模式再做近似去重 + 分层配额 + MMR，只留本轮 ≤10 条关键想法（过程旁白折叠进 `step.summary` 的「过程观察 ×N」）；对错都留痕，不做好坏判定 |
| reasoning 原文摘要 | 追加到 `step.summary`（有上限），方便快速回看 |
| 工具调用开始/结束 | **每轮一个汇总节点** `action`：轮内标题固定为「工具调用（本轮）」，轮末一次性定稿为「工具调用 ×N（read、grep…）」并写各工具次数；不再每次调用建节点或重写 |
| 工具失败 | step 下直接建 `dead_end`（原因摘要），不套动作节点 |
| 交付物 | `deliverables/presented` 事件（path/description）建 `artifact`；写类工具（write/edit/…）参数里真实存在且在扩展名白名单内的文件也算；读文件/回显文本里的路径不再算产物 |
| 轮末/助手结论句 | `conclusion` |
| 无推理链的长回答 | **兜底**：按 Markdown 标题/加粗小标题拆成推导节点（标题是主要阶段挂 step，加粗小标题是当前阶段的子论点）；没有分段时才落单个 `conclusion` |
| 进入旧会话（本工作区还没有图） | 回放 `session.snapshotEvents()`，按同样的推理规则补建整棵树（`backfillHistory`）；宿主未发 `session/created` 时首个事件也会触发 |
| 重复的工具调用/重复想法（同指纹） | 不重复建节点，`hits++` |
| 轮次中断/报错 | step/action 标 `abandoned` |
| 插件中途接入 | 补「接入前」容器 step，后续 `turn/start` 到达时复用并升级为正常轮次 step |
| 旧图同轮重复 step | 首次读取时按 `mergeDuplicateSteps` 迁移合并（保留正常指纹节点，其余子树并过去） |

工具调用只作为**旁证**（动作与产物）；树的骨架来自推理与轮次。自动提取会忽略插件自身的
两个工具（防止反馈环），并受 `maxAutoNodesPerTurn` 与 `maxThoughtNodesPerTurn` 双预算限制。
工具聚合动作、失败 `dead_end`、产物/交付物与轮末中断同样计入 `maxAutoNodesPerTurn`；
同一指纹重复出现只累加 `hits`，不再重复占预算。

**未决卫生（v0.21，v0.22.1 收口）**：`overview` 与面板不再把全部 open/active 的 `question/hypothesis/decision`
平铺出来，而是分为「当前未决 / 推理旁白 / 旧主题陈旧项 / 嵌套推理细节」。自动过程句、
已关闭主题下的旧项和嵌套细节只折叠计数；人工写入、blocker、直接挂在 topic/step/goal 下的未决保留在首屏
（step/goal 是结构与时间节点，不是想法节点，旧图没有 topic 时也能看到真实未决）。
需要批量收敛时用 `src/core/hygiene.js` 的 `planOpenCleanup`：它只改 `status/tags/summary`、不删除节点，
并写入 `auto-curated` 与 `reasoning-noise`/`stale-topic`/`archived` 标签，可按标签审计或回滚。
分类与收敛都会跳过 blocker；主题叶根超宽时只隐藏自动的 done/abandoned 叶根，不动人工完成项与 open 叶根；
`auto-curated` 不再计入 `frontier` 的死路/`avoid` 或轮首增量的「放弃」。

## 5. 数据与共享

```
<workspace>/.explore-tree/
  graph.json        # 当前快照（原子写）
  journal.jsonl     # 操作流水；快照 meta.journalOffset 之后的行用于恢复
  archive.jsonl     # 超过 maxNodes 后下沉的旧节点
```

- **工作区共享**：同一 workspace root 下所有会话/子代理共用一棵树；节点保留
  `sessionId/turn` 作为 provenance。
- **持久化**：改内存 → 追加 journal → 250ms debounce 原子写快照；重启后读快照 + 重放 journal。
- **损坏恢复**：快照解析失败会隔离为 `graph.json.corrupt-<ts>`，再从空图 + journal 恢复。
- **隐私**：数据只写在本地工作区目录，不上传任何地方；节点摘要是截断后的内容，不是完整原文。

## 6. 配置

在 profile 的 `cordis.patch.yml`（或设置页用户层）里写：

```yaml
- insert:
    - id: explore-tree
      name: dsh-explore-tree
      config:
        autoCapture: true
        extract:
          captureReasoning: true
          captureReasoningNodes: true
          captureToolCalls: true
          toolCallMode: aggregate   # aggregate | nodes | off
          compactLegacyActions: true
          repairOrphanSteps: true
          expandLegacyAnswers: true
          captureAnswerSections: true
          injectBrief: true          # 轮首/压缩后注入研究简报（需已有 goal；首次完整，后续增量）
          briefScope: workspace      # workspace | goal（简报是否含其他 goal 的主干）
          minAnswerChars: 400
          minSectionChars: 16
          maxAnswerSections: 10
          backfillHistory: true
          captureArtifacts: true
          detectConclusions: true
          ignoreTools: [todo_write, get_goal, schedule_list]
          maxAutoNodesPerTurn: 80
          maxOpenLeavesPerTopic: 9   # 单个 topic 最多承接的 open 叶根；满仓后另起候选主题
          selectionStrategy: ranked   # ranked | chronological
          maxThoughtNodesPerTurn: 10
          maxThoughtUnitsPerBlock: 8
          thoughtQuotas: { dead_end: 3, conclusion: 1, decision: 3, hypothesis: 3, evidence: 3, question: 2, note: 0 }
          dedupeSimThreshold: 0.85
          mmrLambda: 0.7
          reserveConclusionSlots: 1
          claimMinConfidence: 1.2
          claimMargin: 0.35
          threadLinkThreshold: 0.55  # 跨轮 supports/refines 边与同轮子方法嵌套
          intraTurnLinkThreshold: 0.15  # 同轮逻辑深度：依赖型 claim 挂到更早的相关节点
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
          enabled: false
          # provider + model 成对配置才会真正调用（用宿主已注册的 llm 路由）
          provider: deepseek
          model: deepseek-chat
          maxClaims: 6
          maxInputChars: 12000
          timeoutMs: 20000
          maxOutputTokens: 1200
          digest: false  # 轮末用 LLM 重写 topic 摘要（可选）
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时不注册任何工具/提示段/监听/路由 |
| `autoCapture` | `true` | 关掉后仍可手动 `explore_tree_record` |
| `extract.captureReasoning` | `true` | 是否把 reasoning 摘要写进 step |
| `extract.captureReasoningNodes` | `true` | 是否把推理链切成想法节点（树的主要来源） |
| `extract.captureToolCalls` | `true` | 是否记录工具动作 |
| `extract.toolCallMode` | `aggregate` | 工具记录方式：每轮汇总 / 逐调用节点 / 关闭 |
| `extract.compactLegacyActions` | `true` | 旧图首次读取时压缩历史逐调用动作节点 |
| `extract.repairOrphanSteps` | `true` | 旧图首次读取时把错挂成根的孤立 step 归到目标下 |
| `extract.mergeDuplicateSteps` | `true` | 旧图首次读取时把同会话同轮的重复 step 合并（保留正常指纹节点，子树/命中并过去） |
| `extract.expandLegacyAnswers` | `true` | 旧图首次读取时把「只有一个长结论」的旧轮次展开成推导链 |
| `extract.backfillHistory` | `true` | 进入已有历史但本工作区无图的会话时，回放 `snapshotEvents()` 从 reasoning 补建（确定性、不调模型；`session/created` 或首个事件触发） |
| `extract.captureAnswerSections` | `true` | 没有推理链时，把长回答按小标题拆段（兜底成树） |
| `extract.minAnswerChars` / `minSectionChars` | `400` / `16` | 触发拆段的最短回答长度、单段最短长度 |
| `extract.maxAnswerSections` | `10` | 单轮最多拆几段 |
| `extract.captureArtifacts` | `true` | 是否记录交付物（`present` 事件 + 写类工具参数里的真实文件；不再扫结果文本） |
| `extract.detectConclusions` | `true` | 是否识别结论句 |
| `extract.autoSeedTopic` | `true` | goal 下没有 topic 时，单轮想法达到阈值后自动建候选主题（`candidate`） |
| `extract.topicSeedMinClaims` | `5` | goal 下完全没有 topic 时的单轮想法数阈值；已有 topic 全部满仓/关闭时单条想法也可另起候选主题 |
| `extract.maxOpenLeavesPerTopic` | `9` | 单个 topic 下最多承接的 open 叶根；超出后新想法优先挂到未决更少的主题，全部满仓才自动建候选主题 |
| `injectBrief` | `true` | 有 goal 时轮首注入「研究轨迹简报」：首次完整，之后只推新增/完成/放弃/更新，无变化跳过；`compaction/end` 后强制补完整简报；同一轮最多一次，没有 goal 不打扰 |
| `briefScope` | `workspace` | 简报范围：`workspace` 额外列「其他主干：…」（同工作区其他 goal 的 topic + digest/owner），多 agent 默认；`goal` 只看当前会话 goal |
| `extract.ignoreTools` | 插件自身两个工具 | 自动提取忽略的工具名 |
| `extract.maxAutoNodesPerTurn` | `80` | 单轮自动节点总上限 |
| `extract.selectionStrategy` | `ranked` | 想法取舍：多特征分类 + 分层配额 + MMR + 近似去重；`chronological` 回退旧的「先到先得」 |
| `extract.maxThoughtNodesPerTurn` | `10` | 单轮想法节点总上限（一屏可读） |
| `extract.maxThoughtUnitsPerBlock` | `8` | 单条 reasoning 最多切几个想法 |
| `extract.thoughtQuotas` | 见上 | 分层配额：question≤2 / hypothesis≤3 / decision≤3 / evidence≤3 / conclusion≤1 / dead_end≤3 / note 默认 0 |
| `extract.dedupeSimThreshold` | `0.85` | 轮内近似去重阈值（英文词 + 中文 bigram 的 Jaccard） |
| `extract.mmrLambda` | `0.7` | MMR 去冗余强度（score − λ·maxSim） |
| `extract.reserveConclusionSlots` | `1` | 给结论预留的槽位（结论常在轮末出现） |
| `extract.claimMinConfidence` / `claimMargin` | `1.2` / `0.35` | 分类置信门槛：top1 分数或 top1-top2 差值不足时折叠成 note |
| `extract.threadLinkThreshold` | `0.55` | 跨轮关系边与同轮「子方法嵌套」的相似度门槛；越高越保守（关系少而稳） |
| `extract.intraTurnLinkThreshold` | `0.15` | 同轮逻辑深度：依赖型 claim（证据/结论/决策/后续假设）挂到同轮更早的相关想法下面，而不是全平铺在 step 下；越低越容易形成多层 |
| `extract.noteNodeMode` | `fold` | `fold`：note 折叠进 step 摘要（过程观察 ×N）；`node`：note 也落节点（旧行为） |
| `extract.minThoughtScore` | `1` | 旧 `chronological` 模式的信息量门槛（`scoreThought`） |
| `extract.minThoughtChars` / `maxThoughtChars` | `12` / `400` | 想法片段的最短/最长字符数 |
| `extract.maxThoughtSourceChars` | `60000` | 单条 reasoning 参与切分的字符预算（超长取头+尾） |
| `extract.maxReasoningChars` | `2400` | step 摘要里保留的 reasoning 字符预算 |
| `extract.maxSummaryChars` / `maxTitleChars` | `1200` / `120` | 截断长度 |
| `dirName` | `.explore-tree` | 图目录名（相对工作区根） |
| `maxNodes` | `5000` | 超过后归档最旧 done 叶子 |
| `promptSection` | `true` | 是否注册静态提示段 |
| `http` | `true` | 是否注册 Web 面板数据路由 |
| `llm.enabled` | `false` | 轮末 LLM 辅助提取；默认关闭，不产生额外模型调用 |
| `llm.provider` / `llm.model` | — | 宿主已注册的 llm 路由；两者缺一不调用 |
| `llm.maxClaims` | `6` | 每轮最多补的节点数（1–20） |
| `llm.maxInputChars` | `12000` | 送给模型的推理摘录上限（头 70% + 尾 30%） |
| `llm.timeoutMs` / `llm.maxOutputTokens` | `20000` / `1200` | 单次调用超时与输出上限 |
| `llm.digest` | `false` | 轮末用 LLM 重写 topic digest（失败回退模板；human 摘要不覆盖） |

所有字段都有安全默认值；坏配置回退默认，不阻断插件加载。

## 7. 前缀稳定（为什么不会破坏缓存）

1. 系统提示段是**纯静态字符串**，不含时间/节点数/工作区名/节点 id，只注册一次。
2. 工具面固定：两个工具、描述与参数 schema 不变；不按图状态动态注册。
3. 动态图状态只出现在 `explore_tree` 的**返回值**里（追加内容，不改历史前缀）。
4. 提取器、面板轮询、HTTP 请求都不产生会话消息，不写回主对话。
5. 回归测试：`test/unit/prefix.test.js` 断言提示段静态、图增长前后工具面逐字节一致、
   动态状态只走返回值。

插件启用/停用/升级会改变工具面，这是宿主行为，不在运行期切换。

## 8. 工程结构

```
src/
  index.js            插件入口（工具/提示段/事件监听/路由注册）
  core/               纯函数与存储，零 DSH 依赖
    model.js          枚举、归一化、截断
    fingerprint.js    指纹去重
    graph.js          图操作（增删改移合并、校验、序列化）
    store.js          工作区级快照 + journal + 原子写 + 归档
    extract.js        会话事件 → 树（推理切分/分类/信息量评分 + 工具聚合）
    frontier.js       探索建议引擎
    compact.js        工具返回的紧凑文本
  host/               DSH 适配层
    translate.js      SessionEvent → 内部事件（唯一字段适配点）
    service.js        生命周期、游标、全局工作区索引、HTTP 快照/工作区
    tools.js          两个工具定义与执行
    prompt.js         静态提示段
    config.js         配置归一化
lib/client.js         浏览器 bundle（手写，无构建；conversation.view 页签）
docs/design.md        设计契约
scripts/              install / status / smoke / uninstall（e2e）+ audit-graph / rebuild / migrate-trunk（旧图体检、修复、主干迁移）
test/unit/            node:test 单测（171 项，13 suites）
```

## 9. 开发与测试

```powershell
npm test                 # node --test "test/unit/*.test.js"，171 项
node --check lib/client.js
node --check src/index.js

# 真机 e2e（会创建/使用 scratch profile，不动 web profile；全部脚本支持 --help）
node scripts/install.mjs --profile explore-scratch --create
node scripts/smoke.mjs --profile explore-scratch --boot --port 0 --path /explore-tree/health
node scripts/uninstall.mjs --profile explore-scratch

# 线上 GUI 只读体检（不重启、不刷新页面）
node scripts/status.mjs --profile web
node scripts/smoke.mjs --profile web --base http://127.0.0.1:3080 --path /explore-tree/health
```

### 旧图体检、修复与主干迁移（P3/P2）

```powershell
node scripts/audit-graph.mjs --workspace .      # 只读体检
node scripts/rebuild.mjs --workspace .          # dry-run：旧图污染修复
node scripts/migrate-trunk.mjs --workspace .    # dry-run：step 下的语义节点 → topic/叶根
# 先停掉 dsh web，再加 --apply 写回（都会先备份 graph.json）：
node scripts/migrate-trunk.mjs --workspace . --apply
```

迁移规则：先给 goal 建 topic（或等自动种子）；脚本按「节点文本 ↔ topic 标题+摘要」相似度选主题
（`--threshold`，默认 0.05），approach 直接成为叶根，dependent 跟随同 step 已迁移的叶根；
补 `stepId`、打 `trunk-migrated` 标签并重算摘要。没有 topic 时只提示，不动图。

```powershell
node scripts/audit-graph.mjs --workspace .   # 只读体检：假 goal / artifact 根 / 重复 step / 污染标题 / note/边/深度
node scripts/rebuild.mjs --workspace .       # dry-run：只打印将修复的项
# 先停掉 dsh web（宿主会用自己的内存态覆盖文件），再加 --apply 写回：
node scripts/rebuild.mjs --workspace . --apply
```

规则：假 goal 用会话首条真实用户消息回填；受污染/占位 step 标题用该轮真实消息回填「第 N 轮：意图」；
artifact 根挂回会话 goal；重复 step 合并子树与边；旧 note 打 `legacy-note` 标签（面板默认折叠）。

### 多 agent 协作：写域、CAS、租约与 Team 任务（P3/P5）

- **认领与租约**：`explore_tree_record({action:'assign', id:'n77', owner:'agent-b'})` 默认 30 分钟租约；
  `owner:null` 释放；`leaseUntil` 到期后自动回到「可认领」。`renew:true` 续租；`steal:true`
  由 lead/curator 抢占；认领/续租/释放都会推进 `leaseEpoch`。
- **CAS（v0.19）**：`explore_tree node` 显示 `nodeVersion`；写动作可带
  `expectedRevision`，不匹配返回 `STALE_REVISION`（含 `currentVersion/currentDigest/updatedBy`），
  重读后带新版本重试。`move/merge/assign` 同样校验。
- **租约写校验与写域（v0.19）**：显式传 `actor` 时，只能写自己有效租约覆盖的子树；
  跨域返回 `OUT_OF_SCOPE`，租约过期返回 `LEASE_EXPIRED`；`lead/curator` 例外。
  不传 `actor` 时保持 0.18 的兼容路径（不启用写域校验）。
- **跨进程（v0.19）**：同一工作区的写用 `.explore-tree/graph.lock` 串行化；锁内先重读快照与
  journal 再应用，`journalOffset` 记录真实字节数，半行/坏行告警后停在可重试点。
- **可认领提示**：`trunk` / `brief` 会列「可认领：…」；`frontier` 对过期租约给 `claim` 建议；
  `assign` 后 `owner` 显示在 topic 卡片与 trunk 行里。
- **交接**：`brief`（≤400 字：目标 / 主干 digest / 其他主干 / 未决叶根 / 下一步）就是交接包；默认 `briefScope=workspace`，接手者能看到同工作区其他 goal 的共享主干，不再只看见自己 goal 的碎片；
  `trunk` 是主干地图；两者都只读子摘要，不展开细节。
- **交接（v0.20）**：`explore_tree_record({action:'handoff', id:'n77', actor:'agent-a', toActor:'agent-b'})`
  在一个图操作里把租约转给 `toActor`，并在 topic 下写一条 `tags:['handoff']` 的交接包
  （digest + 未决叶根 + 最近关键节点）；交接包不算叶根，不会污染主干进度。
- **自动提取归属（v0.20）**：自动生成的节点带 `createdBy/updatedBy: extractor`，
  可在 `node` 详情与 journal 中区分系统提取和 agent 显式写；写域仍只对显式 `actor` 生效。
- **Team 映射**：`topicTaskPayload(topic)`（`src/core/trunk.js`）给出 `{subject, description, tags}`，
  可直接作为 `team_task_create` 的入参；`writeScopes` 由调用方按「该 topic 涉及的 src/ 前缀」填写，
  与 Team 任务的写域语义一致。topic 完成后再标 `done`，两边不双写状态。
- **冲突**：agent 间结论不一致时用 `contradicts` 边（`explore_tree_record link`）表达；
  两端最近 topic 相同时，该 topic 在 `trunk` 标 `⚠冲突`、`brief` 列「冲突：…」、
  `frontier` 给 `resolve` 建议，`handoff` 交接包也会带上。冲突只标记，不自动裁决。

### 扩展点（可迭代 / 可扩展）

- **新事件/新字段**：只改 `src/host/translate.js`（归一化）+ 必要时 `src/core/extract.js` 的规则；
  核心图模型与工具面不动。
- **新提取规则**：在 `extract.js` 加一个 `#onXxx`，用 `#addOrHit` 走指纹去重；补 `extract.test.js`。
- **新工具**：在 `src/host/tools.js` 加定义并在 `src/index.js` 注册。注意：**新增工具会改变
  工具面前缀**（一次性），这是受控变更，不是运行期动态注册。
- **新 UI 视图**：改 `lib/client.js` 的槽位注册（当前只占 `conversation.view` 会话页签）；
  list 槽用 `id`，keyed 槽用 `key`。约束：bundle 是经典 script 的 `__ModuleLoader__.load`，
  `id` 必须等于包名；只能 `require` 平台 seed 模块（`react` 等 11 个）；新增 id 的 `order` 建议 ≥ 60。
- **后台 LLM 辅助**：`config.llm` 已接入宿主 `ctx.llm`（v0.12）——轮末异步、串行、默认关闭、失败只记日志、不写会话；产出统一走 `#addOrHit` 去重；`llm.digest` 另开一条 topic 摘要写手（失败回退模板）。

### 已知限制

- LLM 辅助需要显式配置 `llm.provider` + `llm.model`（宿主已注册的路由）；会增加 token 消耗，默认关闭。
- 跨进程写入靠 `.explore-tree/graph.lock` 串行化（O_EXCL，15s stale，2s 等待）；
  抢锁遇到瞬时 `EPERM/EBUSY/EACCES/ENOENT` 会按竞争重试（5–25ms 退避，清理成功后立即重试一次），
  超时错误保留最后一次错误码。
  进程崩溃后最多 15s 可被接管；它假设本地/共享文件系统语义，不做分布式共识或跨机锁。
- 写域校验只在显式 `actor` 时启用；自动提取节点带 `actor:'extractor'` 归属，但只做归属、
  不阻断写入（仍可能落到共享 topic 下）。
- 面板是只读浏览：支持缩放、拖动平移、折叠、搜索定位与类型过滤，不支持编辑与节点拖拽排序。
- 旧图（v0.5 之前）由注入消息产生的假 goal、被注入文本污染的轮次标题可用 `scripts/rebuild.mjs` 离线修复；
  面板默认隐藏旧 note（工具栏可取消「隐藏笔记」）。
- 插件安装后**宿主侧新代码**需要下一次宿主启动才生效；client bundle 走 HMR。

## 10. License

MIT。
