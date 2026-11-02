# Changelog

## 0.22.1 — 2026-11-02

### 修复（对 0.21.0 未决卫生的审查收口）

- **无 topic 的旧图不再把真实未决全部折叠**：`isActionableOpenNode` 把直接父节点为 `step`/`goal`
  的未决视为当前行动项，只有嵌套在想法节点下才归 `detail`；旧图与新工作区前几轮的问题重新进入首屏。
- **疑问句先于计划句判定**：`isReasoningNoiseText` 遇到 `isQuestionText` 直接放行；
  `isQuestionText` 同步覆盖 But/Also/Interesting 开头、is there、did/does/do + 双词主语、
  should + 名词主语与中文中置疑问词，真问题不再被当过程旁白丢弃。
- **问号被 `cleanTitle` 剥掉后仍按疑问句保留**：`isSubstantiveOpenNode` 对 `question` 且
  `isQuestionText` 为真的节点直接视为实质未决，不再因标题末尾标点丢失而被 done topic 判 stale。
- **blocker 在分类与收敛两侧都豁免**：新增 `hasBlockerTag`，`isReasoningNoiseNode`/
  `isSubstantiveOpenNode` 放行，`planOpenCleanup` 跳过 blocker 节点。
- **自动收敛项不再伪装死路**：`frontier` 的 `deadEnds`、`overview` 的死路统计与轮首增量里的
  「放弃」都排除 `auto-curated`，避免自动收敛的伪死路进入 `revive`/`avoid`。
- **主题满仓后单条想法也能另起候选主题**：`#maybeSeedTopic` 先看容量，只有「一个 topic 都没有」
  才要求 `topicSeedMinClaims`；已有主题全部满仓/关闭时不再把新问题永久留在 step 下。
- **顶栏未决计数与面板一致**：改用 `stats.openUnresolved`，悬停显示 `openHidden` 折叠数。
- **宽度隐藏只动自动完成项**：人工 done 叶根不再因主题超宽被 `archived`；自动隐藏项补
  `auto-curated` 标签，可按标签审计。

### 验证

- 新增/扩展回归：无 topic 时 step 下的未决仍可见、closed topic 下英文问句仍 current、blocker 豁免、
  人工 done 不被宽度隐藏、已有主题满仓时单条想法另起主题、`auto-curated` 不进入 avoid。
- npm test：171 项 / 13 suites 全过；`npm run check`（新增 select/compact/frontier 语法门禁）、
  `git diff --check` 通过。
- 现场图只读核对（879 节点）：open 95，可见 86，折叠 9（旁白 3 / 旧主题 0 / 推理细节 6）；
  收敛干跑 open 95→92。

## 0.22.0 — 2026-11-02

### 新增（轮首增量简报）

- **有 goal 即注入**：轮首简报不再要求先有 topic；会话图上只要有 goal，就注入「目标/主干/未决/建议」。
- **首次完整、后续增量**：service 在首次注入时保存 `snapshotBriefState`（id/kind/title/status/parentId/updatedAt），
  之后只渲染 `renderBriefDelta`：新增关键节点（conclusion/decision/dead_end/topic/artifact 优先，最多 3 条）、
  完成/放弃、标题或父节点变化、合并/移除；总长仍 ≤400 字。
- **无变化跳过、不重复**：树没有值得说的变化时返回空串，同一轮不再补推；只有真正注入才更新快照，
  变化会留到下一轮增量。`compaction/end` 后仍强制补一次完整简报。
- **结构节点不打扰**：step/action 等结构节点的状态变化不计入增量，避免每轮都推送「完成：第 N 轮」。

### 验证

- 新增 `test/unit/trunk.test.js` 增量用例：无变化空串、step 完成被忽略、首次无快照退回完整简报；
  `test/unit/host.test.js` 覆盖「没有 goal 不注入 / 有 goal 无 topic 注入完整简报 / 下一轮只注入增量 /
  无变化跳过 / 同轮不重复 / compaction 补完整」。
- npm test：165 项 / 13 suites 全过；`npm run check`（新增 `trunk.js`、`host/service.js` 语法门禁）、
  `git diff --check` 通过。

## 0.21.0 — 2026-11-02

### 新增（未决卫生与主题平衡）

- **未决分类与折叠**：新增 `src/core/hygiene.js`，把 `question/hypothesis/decision` 的 open/active 节点
  分成「当前未决、推理旁白、旧主题陈旧项、嵌套推理细节」四类。`overview` 与宿主快照只优先展示
  人工写入、blocker、或直接挂在 topic 下的当前未决；自动过程句与已关闭主题下的旧项折叠计数，
  不再占满首屏。
- **自动提取收紧**：被分类成 `question` 但不像疑问句的陈述句只计轮次旁白；过程计划句同样不落
  未决节点。`topic` 增加 `maxOpenLeavesPerTopic`（默认 9）水位线：优先把新想法挂到未决叶根最少的
  主题，满仓时另起候选主题，避免单主题长成几十个子节点的巨仓。
- **可审计收敛**：`planOpenCleanup` 产出逐条变更计划，只改 `status/tags/summary`，不删除节点；
  自动收敛项带 `auto-curated` 与 `reasoning-noise`/`stale-topic`/`archived` 标签，summary 写明原因，
  可人工回滚。主题叶根超宽时只隐藏最旧的已完成/已放弃叶根，不动真正未决。
- **面板**：未决计数改用「可见未决」而不是全部 open/active；折叠提示显示旁白/旧主题/推理细节数量。

### 验证与现场清理

- 新增 `test/unit/hygiene.test.js` 10 条，覆盖过程句/片段、when 从句、假设信号、人工假设豁免、
  三分类、折叠计数、主题宽度平衡；select/extract/frontier/host 同步补回归。
- npm test：162 项 / 13 suites 全过；`npm run check`、`git diff --check` 通过。
- 现场图（850 节点）分三次收敛：open 217 → 82（可见 46 + 推理细节 36），140 条自动旁白/陈旧项
  标 abandoned，12 条已完成/已放弃叶根隐藏；节点数不变，清理完成时另有 3 条新旁白由进行中的
  会话继续产生。清理前快照备份在 `.explore-tree/graph.backup-2026-11-02T12-35-41-334Z.json`、
  `.explore-tree/graph.backup-2026-11-02T12-41-59-256Z.json` 与
  `.explore-tree/graph.backup-2026-11-02T12-49-39-302Z.json`。

## 0.20.5 — 2026-11-02

### 修复（轮次状态与锁等待的边界）

- **重复/迟到的 `turn.start` 不再重置轮级状态**：新增 `runtime.startedTurn`，只有该轮尚未初始化时
  才清空 `autoCount/warned/claims/claimCreatedNodes` 等轮级字段；重复投递同一轮的 `turn.start`
  只复用 step。`user.message` 先把 `runtime.turn` 抬到新轮、`turn.start` 后到的宿主顺序仍会正常
  重置；迟到的旧轮 `turn.start` 只返回已有 step，不回退 `runtime.turn`。轮首同时清空
  `activeActionId`，避免迟到的 `tool.end` 更新上一轮的 action 节点。
- **锁等待不再热循环**：`#acquireLock` 的超时判定移到循环顶部；拿不到锁文件且非 `EEXIST`、以及
  陈旧锁清理失败的分支在重试前退避 5ms；陈旧锁清理成功后立即重试一次，不因刚好跨过 2s 截止时间
  而误报超时。
- **语法门禁覆盖核心文件**：`npm run check` 追加 `node --check src/core/extract.js` 与
  `src/core/store.js`。

### 验证

- 新增/强化 2 条回归：重复 `turn.start` 不重置预算/告警、`user.message` 先到的新轮仍重置、迟到
  旧轮不回退；持续 EPERM 的取锁次数有界（断言 <1000）。
- 修复前定向复现失败：旧实现重复轮把 `autoCount` 清零（`0 !== 1`），持续 EPERM 在 2s 内热循环
  4,983 次 `open`；修复后 extract+store 57/57。
- npm test：147 项 / 12 suites 全过（连跑两次）；npm run check、git diff --check 通过。

## 0.20.4 — 2026-11-02

### 修复（自动提取与跨进程锁）

- **跨轮 adopted 节点不再被误删**：`#flushClaims` 的增量替换只删除「本轮新建」的 claim 节点；
  指纹命中上一轮的历史节点落选时仅解除本轮 `claimNodes` 映射，保留在图中。新增
  `runtime.claimCreatedNodes` 记录本轮新建节点（轮首重置），`autoCount` 只在真删除时回退。
- **工具路径共享 `maxAutoNodesPerTurn`**：工具聚合 `action`、失败 `dead_end`、artifact、
  deliverable 与轮末中断统一走新的 `#addBudgetedNode`；指纹命中只累加 `hits`，不重复占预算；
  预算耗尽每轮最多一条告警（`runtime.warned` 轮首清空）。删除旧 `#consumeBudget`
  （先自增再判断，会误吃预算）与 `sawLimitWarning`。`step`/`goal` 结构节点仍不占预算。
- **`graph.lock` 瞬时错误重试**：`open('wx')` 遇到 `EPERM/EACCES/EBUSY/ENOENT` 时按竞争重试
  （`EEXIST` 语义不变，陈旧清理仍保留）；所有分支仍受 2s 等待上界，超时错误追加
  「最后一次错误码」并带 `cause`，便于定位 Windows 删除挂起/共享冲突。

### 验证

- 新增 8 条回归：跨轮 adopted 不被删、本轮新建仍增量替换、工具聚合/失败/轮末中断共享预算、
  artifact/deliverable 去重与预算、每轮告警重置、锁等待/陈旧清理/瞬时 EPERM/持续 EPERM 超时。
- 修复前定向测试复现失败（跨轮节点被删；预算断言 7 !== 1、4 !== 2；旧锁实现 2 条失败）。
- npm test：146 项 / 12 suites 全过（extract 43、store 13）；npm run check、git diff --check 通过。

## 0.20.3 — 2026-11-02

### 修复（长轮次候选池）

- ranked 提取不再在累计出现 60 次后停止接收推理：重复候选只累加 hits，不消耗新候选序号。
- 默认最多驻留 60 条候选；池满后淘汰未发布候选中最低分（同分最早）的一条，
  继续接纳晚到的新方向与结论。已发布节点不会因池淘汰被移除，仍由原有配额/MMR 决定是否入选。
- 大配额配置的池上限为 max(60, clamp(maxThoughtNodesPerTurn, 0, 500) + 1)，
  为探索留一个额外槽；不新增配置，不改变 chronological 路径，不迁移已有图。
- 被淘汰的 note 仍计入轮末「过程观察」摘要，计数按轮重置。
- 这是有界在线近似：被淘汰的未入选候选不保留全文，不等价于全历史离线 top-K；
  再次出现的已淘汰片段作为新候选处理。

### 验证

- 两项新增回归先在旧实现复现失败，修复后通过：65 次重复后接收结论；
  超过 60 个不同候选后仍接收新假设/结论，并验证池大小、早期节点保留和折叠计数。
- 独立代码复核无阻断问题；按复核建议强化新假设文本断言，并新增大配额探索槽/同分最早淘汰测试。
- npm test：138 项 / 12 suites 全过；npm run check、git diff --check 通过。

## 0.20.2 — 2026-11-02

### 修复（自动提取 churn）

- **工具聚合节点不再逐调用重写**：ResearchExtractor.#recordToolAggregate 在轮内只创建一次
  action 节点，标题固定为「工具调用（本轮）」，每次 tool start/end 不再调用 updateNode；
  轮末 #onTurnEnd 用一次更新定稿为「工具调用 ×N（read、grep…）」并写各工具次数。
  聚合节点自身的 update 从 O(工具调用数) 降到 1（另有首次 add）；历史 n943 的 306 次 update 不再产生。
- 失败路径仍单独写 dead_end；产物仍直接挂 step；toolCallMode=nodes/off 行为不变。
- 兼容性：轮内读取者看到稳定标题「工具调用（本轮）」，轮末才看到 ×N；已有图无需迁移。
- **stats 增加 per-actor 分布**：graphStats 新增 byCreator / byUpdater，explore_tree({action:'stats'})
  多两行「创建者」「最近更新」，便于区分 extractor 与显式 agent 的写入。
- **brief 未决排序优先显式节点**：leafRootImportance 给非 auto 节点 +4，减少自动提取的旧疑问
  占满「未决」行；auto 节点仍作为兜底保留。

### 测试

- npm test 135 项 / 12 suites 全过（新增聚合节点 churn 回归、per-actor 统计、叶根排序用例）。

## 0.20.1 — 2026-11-02

### 新增（brief 跨 goal 可见性）

- **`briefScope` 配置**（默认 `workspace`）：研究简报除了当前会话 goal 的主干，还列一行
  「其他主干：…」，带同工作区其他 goal 的 topic、digest 与 `@owner`（最多 2 条）。
  `briefScope: 'goal'` 退回旧的单 goal 视图。
- `renderBrief({ scope })` 新增 `workspace|goal`；`explore_tree({action:'brief', scope:'goal'})`
  可按次覆盖；自动注入读服务配置。过滤已归档 topic 与当前 goal 的子树，避免把子主题误列成其他主干。
- 这对应多 agent 实验 H4 的已知瓶颈：teammate 只看到自己 goal 下的自动种子，跨 goal 的共享主干不可见。

### 测试

- `npm test` 132 项 / 12 suites 全过（新增 `renderBrief` workspace/goal 范围用例）。

## 0.20.0 — 2026-11-02

### 新增（P5.4 交接与冲突可见性 / P5.6 自动提取归属）

- **handoff（P5.4）**：`explore_tree_record({action:'handoff', id, actor, toActor, leaseUntil?})`
  在同一个 `handoff` 图操作里完成「租约转移 + 交接包落节点」，避免半状态。
  - topic 的 `owner/leaseUntil/leaseEpoch/nodeVersion` 一起更新；旧 owner 之后写入返回 `OUT_OF_SCOPE`。
  - 在 topic 下写一条 `kind:conclusion, tags:['handoff','from:<actor>','to:<toActor>']` 的节点，
    摘要含当前 digest、未决叶根和最近关键节点；该节点被排除在叶根/进度之外，不污染主干。
  - 交接记录作为单条 journal 操作重放；`store.apply` 返回 `{topic,node}`，工具回 `handoffId`。
- **topic 级冲突（P5.4）**：`contradicts` 边只要两端最近 topic 相同，就计入该 topic 的 `conflicts`。
  `trunk` 行显示 `⚠冲突`，`brief` 增加「冲突：…」，`trunkFrontier` 给 `resolve` 建议，
  `renderHandoff` 把冲突带进交接包；冲突只标记，不自动改状态。
- **自动提取归属（P5.6）**：`ResearchExtractor` 写节点时带 `actor:'extractor'`，自动生成的 goal/step/想法
  现在都有 `createdBy/updatedBy`，journal 写事件可区分「系统提取」与「agent 显式写」。
  自动提取仍直接走 store 的兼容路径，不启用租约写域；归属用于审计与后续统计。

### 兼容性

- `store.apply` 对普通操作仍返回 op；只有 `handoff` 返回 `{topic,node}`，其他调用方不受影响。
- 旧图没有 handoff 节点/冲突字段时按 0 处理，无需迁移。

### 测试

- `npm test` 131 项 / 12 suites 全过（新增 extractor actor、handoff 工具、handoff journal 重放、topic 冲突可见性用例）。

## 0.19.1 — 2026-11-02

### 修复

- 租约拒绝错误（`OUT_OF_SCOPE`/`LEASE_EXPIRED`/`LEASE_HELD`）回给工具调用方时，
  `id` 取 `LeaseError.id` 但该类没有 `id` 字段，返回对象里的 `undefined` 触发宿主的
  “not lossless JSON” 错误，agent 拿不到结构化 code。现在 `id` 回退到 `topicId`
  （再回退 `null`），`topicId/owner/leaseUntil` 也统一归一化为可序列化值；
  `test/unit/host.test.js` 增加越界写返回 `id/topicId` 的断言。
- 该问题由多 agent 实验的 T4b 独立验证发现；实验数据基于 0.19.0，不受影响。

### 测试

- `npm test` 127 项 / 12 suites 全过。

## 0.19.0 — 2026-11-02

### 新增（P5：多 agent 同树写安全）

- **actor（P5.0）**：`explore_tree_record` 新增 `actor`；节点记录 `createdBy/updatedBy`，
  `node` 详情与 HTTP 快照都显示最后写者；journal 重放保留 actor。
- **节点 CAS（P5.1）**：节点新增 `nodeVersion`（与 digest 的 `revision` 分开），所有写动作支持
  `expectedRevision`；不匹配返回 `STALE_REVISION`，带 `currentVersion/currentDigest/updatedBy`，
  调用方读 `node` 后带新版本重试。`move/merge/assign` 同样走版本校验。
- **租约写校验 + fencing（P5.2）**：`assign` 只接受 topic；新增 `renew`（续租）、`steal`（lead/curator 抢占）、
  `expectedRevision`；认领/续租/释放都推进 `leaseEpoch`。显式传入 `actor` 时，写自己租约之外的子树返回
  `OUT_OF_SCOPE`，租约过期返回 `LEASE_EXPIRED`；抢占/换人返回 `LEASE_HELD/NOT_OWNER` 等可判别 code。
- **写域（P5.3，显式 actor 路径）**：由最近的已认领 topic 推导；`add` 校验父节点，`move` 校验新旧父节点，
  `merge` 校验双端；`lead/curator` 例外。自动提取仍走无 actor 的 legacy 路径，归属约束留待 P5.6。
- **跨进程一致性（P5.5）**：`graph.lock`（O_CREAT|O_EXCL + token，15s stale，2s 等待）串行化写；
  锁内先重读快照/journal 再应用；`journalOffset` 改为真实文件字节数；半行/坏行告警并停在可重试点；
  快照与 journal 在同一锁窗口落盘。双进程各写 20 个节点，重载 40/40 全保留。
- 快照 `serializeNode` 增加 `nodeVersion/leaseEpoch/createdBy/updatedBy`，面板与 HTTP 客户端可读到 CAS 版本。

### 兼容性

- 不传 `actor` 时保持 0.18 的旧行为（不启用写域/租约校验），只有显式 actor 才进入严格模式。
- `assign {id}` 仍然释放；认领自己用 `owner` 或 `renew:true`。
- 旧快照缺 `nodeVersion/leaseEpoch/createdBy/updatedBy` 时默认 `1/0/null`，可直接打开。

### 测试

- `npm test` 127 项 / 12 suites 全过（新增 graph CAS/lease、store 真实 offset/半行/recordEvent 刷新/双进程 40/40、host 写域与 CAS 用例）。
- `npm run check` 通过。

## 0.18.0 — 2026-11-01

### 面板滚动与拖动

- 指针拖动平移：按住卡片或空白拖动即可平移画布（左键/中键），4px 阈值内视为点击，拖动后抑制一次 click，避免误选中。
- 滚轮：默认纵向滚动，`Shift+滚轮` 横向滚动，`Ctrl/⌘+滚轮` 以指针位置为锚点缩放；画布 `overscroll-behavior:contain`，滚到边界不穿透页面。
- 缩放锚点：工具栏缩放围绕视口中心、`适应宽度` 回到左上角、滚轮缩放围绕指针；缩放后按比例回填滚动位置，不跳动。
- 选中定位改为手算 `scrollLeft/scrollTop`，不再用 `scrollIntoView` 带动整页滚动；双击空白处适应宽度。
- 测试 121 项 / 9 suites。

## 0.17.1 — 2026-11-01

### 修复

- 人工摘要（digestSource=human）没有 basis 时不再误报「摘要过期」；digest 动作会同时写入 digestBasis，子节点变化后仍能正确提示刷新。
- 测试 121 项 / 9 suites。

## 0.17.0 — 2026-11-01

### 新增（P4：归档 / 摘要版本 / 检索）

- 归档：`explore_tree_record archive` 给完成叶根打 `archived` + `done`，`trunk` 与面板主干视图默认隐藏，
  `trunk({archived:true})` 可查看；`unarchive:true` 恢复。
- 摘要版本：digest 变化自动写入 `digestHistory`（≤20 版，含 revision/source/时间）；
  `rollback {id, version}` 回滚到历史版本（0=最新历史），并标记为人工摘要。
- 检索：`find` 的命中范围加入 digest，标题/digest 命中优先。
- 面板：详情栏 topic 显示最近 3 个摘要版本；主干视图隐藏已归档节点。

### 测试

- `npm test` 120 项 / 9 suites 全过（新增归档隐藏/archived 查询、digest 历史与回滚、find 按 digest 命中 3 组断言）。

## 0.16.0 — 2026-11-01

### 新增（P3：LLM 摘要 + 多 agent 租约/Team 映射）

- LLM digest（可选，默认关闭）：`llm.digest=true` 时轮末把 topic 子节点标题/摘要交给宿主 `ctx.llm`
  重写 digest（≤120 字）；失败回退模板摘要，`human` 摘要不覆盖。
- 租约：`assign` 默认 30 分钟租约；`leaseStatus` / `claimableTopics` 判定未认领/有效/过期；
  到期后重新可认领；`frontier` 对过期租约给 `claim` 建议，`trunk` / `brief` 输出「可认领：…」。
- Team 映射：`topicTaskPayload(topic)` 产出 `{subject, description, tags}`，可直接作为
  `team_task_create` 入参；`writeScopes` 由调用方补文件前缀，状态不双写。

### 测试

- `npm test` 119 项 / 9 suites 全过（新增 digest 写手与截断、租约/Team payload、摘要 human 保护 3 项）。

## 0.15.0 — 2026-11-01

### P2：旧图迁移、自动种子与提升建议

- 新增 `scripts/migrate-trunk.mjs`：把仍直接挂在 step 下的语义节点迁到 topic/叶根
  （按文本相似度选主题，approach 成为叶根，dependent 跟随同 step 叶根；补 stepId、打 trunk-migrated、
  重算摘要）。默认 dry-run，`--apply` 先探测宿主并备份 graph.json。
- 新增 `src/core/migrate.js`（plan/apply 纯函数，可测试）。
- 自动种子：goal 下没有 topic、单轮想法 ≥ `extract.topicSeedMinClaims`（默认 5）时，
  自动建候选主题并把本轮想法迁到 topic/叶根；配置 `extract.autoSeedTopic`（默认 true）。
- `trunkFrontier` 新增 `promote` 建议：叶根细节 ≥6 且跨 ≥2 轮时建议提升为子主题。
- npm script：`npm run migrate-trunk`。

### 测试

- `npm test` 116 项 / 9 suites 全过（新增 migrate 4 项、自动种子 1 项、promote 1 项）。

### 升级说明

- 宿主重启后自动种子/自动挂载生效；旧图迁移需停 dsh web 后跑 `migrate-trunk --apply`。

## 0.14.0 — 2026-11-01

### P1：自动挂载、轮首简报与两级 frontier

- 自动挂载：goal 下有 topic 时，自动提取的 approach 直接挂到 `activeTopic`（成为叶根），
  dependent 挂同轮最近的 approach / topic 下最近的叶根；`stepId` 保留时间线，语义节点不再堆在 step 下。
- 轮首简报：`agent/pre-step` 追加一条 `source.kind=explore-tree-context` 的 user 消息
  （目标 / 主干 digest / 未决叶根 / 主干建议，≤400 字）；同一轮只注入一次，`compaction/end` 后强制补一次；
  没有 topic 时不注入。配置 `injectBrief`（默认 true）。
- 两级 frontier：有 topic 时，`frontier` 先给「主干建议」（推进/认领/刷新摘要），再给叶子级验证/收敛建议；
  `brief` 同时带主干与叶子建议。
- 工具返回 `stepId`、`owner` 等新字段；面板「主干 / 研究」视图沿用。

### 测试

- `npm test` 110 项 / 9 suites 全过（新增自动挂载、brief 注入、compaction 补注入、主干 frontier 用例）。

### 升级说明

- 宿主侧重启 DSH 后新提取逻辑与简报注入生效；已有旧图不会自动补迁移（叶根仍在 step 下，audit 会 WARN）。

## 0.13.0 — 2026-11-01

### 新增：摘要主干与叶节点（P0，v0.13）

- 新 kind `topic`（摘要主干）：父节点是子节点摘要的摘要；新增字段 `digest` / `digestSource` /
  `digestBasis` / `owner` / `leaseUntil` / `priority` / `stepId` / `revision`（时间轴不再当父节点）。
- 工具：`explore_tree({action:"trunk"|"brief"})`；`explore_tree_record` 新增 `promote`（叶根→topic）、
  `assign`（认领 owner/租约）、`digest`（人工修订摘要）；`add` 支持 topic 字段与自动挂到 goal。
- 摘要：模板 digest（只读子节点标题/摘要/状态，≤120 字），子节点变化后自动向上重算；人工摘要不被覆盖。
- 面板：新增「主干 / 研究」切换；主干视图只画 goal/topic/叶根，卡片显示 digest、主题进度与 owner；
  详情栏显示摘要；左侧大纲在主干模式切为主干树。
- 审计：`audit-graph` 增加 topic 父/子/缺摘要（FAIL）与叶根错位、主干宽度/深度/摘要长度（WARN）。

### 测试

- `npm test` 106 项 / 9 suites 全过（新增 `test/unit/trunk.test.js` 5 项与 host 主干用例 1 项）。

### 升级说明

- 宿主侧新增工具 action 与节点字段，需重启 DSH 生效；面板刷新即可看到主干/研究切换。

## 0.12.0 — 2026-11-01

### 改进（界面收尾 + LLM 辅助）

- 面板：卡片底部重排（状态 + 子树聚合 + 折叠按钮，meta 只留 id/命中）；摘要收为 1 行、卡片 262×128
  （紧凑 196×88）；详情栏长摘要默认折叠为「摘要 + 展开全文 · N 字」，旧 step 的原始 reasoning 不再撑满侧栏；
  LLM 节点带 `AI` 标记。
- LLM 辅助提取（`config.llm`）：默认关闭；显式 `provider` + `model` 后，轮末异步调用宿主 `ctx.llm`，
  把推理摘录转成结构化 claim（kind/title/summary/parentId），走指纹去重落库，失败只记日志、不阻塞主链路。
- 配置新增：`llm.provider` / `llm.model` / `llm.maxClaims`(6) / `llm.maxInputChars`(12000) /
  `llm.timeoutMs`(20000) / `llm.maxOutputTokens`(1200)。

### 测试

- `npm test` 100 项 / 9 suites 全过（新增 `test/unit/llm.test.js` 5 项、`test/unit/llm-extract.test.js` 2 项）。

### 升级说明

- 宿主侧新增 llm 注入与轮末任务，需重启 DSH 生效；面板刷新即可。

## 0.11.0 — 2026-11-01

### 改进（P4：工具与面板的可用性）

- `explore_tree_record` 的 `add` 支持 `children`：一次建一层子节点（≤20），返回
  `{id, children:[{id,kind,title}]}`，AI 搭 3 层树不再需要 5+ 次顺序往返。
- `explore_tree` 的 `overview` 只汇总**当前会话**的节点（树跨会话共享，别的会话历史不再重贴）；
  目标标题截到 60 字。`find` 标题命中优先于摘要/标签/引用，摘要命中时附 80 字片段。
- 面板第二行新增 `本会话` 过滤（纯前端按 `sessionId`，轮次 chips、大纲、搜索、未决都跟随过滤）。
- 案例报告 `docs/case-study.md` §5 更新为已落地项。

### 测试

- `npm test` 93 项 / 9 suites 全过（新增：children 批量建树、overview 按会话过滤、find 摘要片段）。

### 升级说明

- 工具面 schema 有新增字段，需重启 DSH 进程后生效；面板刷新页面即可看到「本会话」。

## 0.10.0 — 2026-11-01

### 改进（可观察性 + 逻辑深度）

- 面板：左侧新增**大纲**（目标 + 每轮标题与子树计数，点击定位）；工具栏加 `最新` `大纲`；
  未手动缩放时按画布宽度**自动适应**（20%–160%）；画布改为固定高度、横纵滚动。
- 布局从「同层一行铺开」改为**打包行**：单个父节点的子卡超过一行（约 920px）时换行堆叠，
  多根纵向堆叠；卡片高度扩到 258×142（紧凑 192×100），摘要 2 行截断。
- 卡片显示**子树聚合**（`子树 12 · 假设 3 证据 2`），一眼看出哪棵子树值得展开。
- 提取器新增 `extract.intraTurnLinkThreshold`（默认 `0.15`）：同轮依赖型 claim（证据/结论/决策/后续假设）
  会挂到同轮更早的相关想法下，形成「假设 → 子假设 → 证据」的多层链，而不是全部平铺在 step 下；
  `decision → decision` 不嵌套（并列行动，避免假层级）。

### 新增（案例）

- `docs/case-study.md` + `docs/assets/case-study.png`：独立 AI 会话只用本插件的两个工具修复
  LRU 淘汰顺序 bug，记录了 5 层节点（4 条边）的研究树，并附 5 条真实可用性反馈。

### 测试

- `npm test` 90 项 / 9 suites 全过（新增「同轮相关 claim 形成子假设/证据链（逻辑深度 ≥4）」用例）。

### 升级说明

- 面板刷新页面生效；提取器新逻辑需重启 DSH 进程后才对后续事件生效（旧图不回溯补层级）。

## 0.9.0 — 2026-11-01

### 新增（P3：旧图体检与修复）

- `scripts/audit-graph.mjs`：只读体检 + 可机读断言。FAIL：根不是 goal、假 goal、被注入消息污染的 step 标题、
  同 session+turn 重复 step、父节点悬空；WARN：edges=0、note 占想法节点 >30%、最大深度 <3。
  支持 `--json` 与 `--no-fail`，可直接接 CI。
- `scripts/rebuild.mjs`：旧图离线重建。默认 dry-run 打印改动；`--apply` 前探测 3080 端口宿主是否在跑
  （宿主会用自己的内存状态覆盖文件），写回前备份 `graph.rebuild-backup-*.json`。修复项：假 goal 用会话
  首条真实用户消息回填、污染/占位 step 标题回填「第 N 轮：意图」、artifact 根挂回会话 goal、
  重复 step 合并子树与边、旧 note 打 `legacy-note` 标签。
- 面板新增「隐藏笔记」（默认开启）：旧图的 note 多为过程旁白，不再占视野，需要时可在工具栏取消。

### 本工作区清理结果

- 3 个假 goal（Time sampled / background job / approval policy）已回填为真实用户意图；
- 6 个 artifact 根（graph.json / design.md / package.json×2 / report.md / chart.png）挂回所属 goal；
- 11 个 step 标题回填为「第 N 轮：意图」；根节点 9 → 3，重复 step 0；
- `node scripts/audit-graph.mjs`：PASS（仅 edges=0、note 占比 50.5% 两条 WARN，旧图不回溯补边）。

### 测试

- `npm test` 89 项 / 9 suites 全过（两个脚本为只读/dry-run，不纳入单测）。

### 升级说明

- `rebuild.mjs --apply` 必须先停掉 dsh web，否则宿主会覆盖写回结果。

## 0.8.0 — 2026-11-01

### 新增（P2 结构语义）

- 跨轮关系边：同会话新 `step` 与上一轮 `step` 自动建 `continues`；新想法与往轮节点按相似度
  （`extract.threadLinkThreshold`，默认 `0.55`）建 `supports` / `refines` / `replaces` / `contradicts` 边。
- 同轮「子方法/子假设」嵌套：approach 与同轮更早的 approach 足够相似时挂成其子节点，而不是全部平铺在 step 下。
- `frontier` 改为用边判断：指向假设的 `supports`/`refines` 边被视为已有依据（不再提示 verify）；
  `contradicts` 边参与互斥假设判断与 revive 理由；notes 输出 supports 边与冲突证据统计。
- 轮末收束摘要：ranked 模式在 `step.summary` 追加「关键：」「结果：」两行（不覆盖人工摘要）。
- 面板：跨轮关系画成按 kind 着色的虚线（选中端点高亮）；详情栏新增可点击的「关系」列表。

### 配置

- 新增 `extract.threadLinkThreshold`（默认 `0.55`；越大越保守，关系少而稳）。

### 测试

- `npm test` 89 项 / 9 suites 全过；新增跨轮 `continues`/`supports` 边、轮摘要、frontier 看边用例。

### 升级说明

- 旧图不会自动补边；只对之后产生的事件生成关系。宿主侧代码需重启 DSH 进程后生效。

## 0.7.0 — 2026-11-01

### 改进（面板可观察性）

- 重写 `lib/client.js` 的会话上栏面板：三行工具栏（统计 + 折叠/展开/适应宽度/缩放/紧凑/详情/刷新/自动刷新；
  搜索与「下一个」+ 隐藏动作/隐藏产物/只看未决 + 轮次 chips；按 kind 的图例过滤）。
- 画布支持 20%–160% 缩放、横向滚动、选中路径高亮、选中卡自动居中；合并卡片扩为「标题 2 行 + 摘要 1 行」。
- 右侧详情栏可收起；无选中时显示图概况（节点/关系/层深/未验证假设、类型分布、未决、根节点）。
- `frontier` 建议与 `avoid` 死路移到详情栏底部折叠显示，不再固定占用 340px 全高。
- 3s 轮询保留缩放、选中、搜索、折叠与过滤状态；子节点超过 8 个默认折叠。

### 修复

- `GET /explore-tree/snapshot` 在 frontier 计算时抛 `TypeError: object is not iterable`（影响所有工作区）：
  `duplicateGroups` 返回 `{fingerprint, nodes}` 对象，`computeFrontier` 误写成 `const [first] = duplicates[0]`，
  改为 `const first = duplicates[0]`，并新增 `consolidate` 建议回归用例。
- 面板 CSS 拼写（`overview` → `overflow`）、紧凑模式子节点摘要溢出、`折叠全部` 的 O(n²) 遍历等细节。

### 测试

- 测试增至 87 项 / 9 suite（新增 frontier 重复指纹回归）。
- 静态预览：用真实 253 节点快照 + esm.sh React 在 headless Chrome 里渲染新旧 bundle 对比截图。

### 升级说明

- 面板 bundle 刷新页面即生效；**宿主侧 frontier 修复需要重启 DSH 进程**后 `/explore-tree/snapshot` 才能恢复。
- 旧图（v0.5 之前）的假 goal / 污染标题不会自动清理；新事件已按来源过滤。

## 0.6.0 — 2026-10-31

### 改进（P1 取舍，对应 docs/extractor-optimization.md §4–§6）

- **多特征分类**：`classifyClaim` 用 question/failure/hypothesis/evidence/decision/conclusion
  六组特征 + 具体性/命题性加权矩阵取代「首个正则命中」；top1 分数或 top1-top2 差值不足时折叠为 note，
  标题改成「触发该 kind 的那一句」。
- **句级切分**：idea 单元再按句末切分（`#claimSegments`，一句一 claim，短句并回上句，一段最多 4 条），
  避免 400 字段落里「前面旁白、后面结论」把分类和标题带偏；英文按「句号+空白」切，不切开 `v0.4.0`。
- **过程旁白过滤**：Let me / 我先 / 接下来 等过程句不建节点，计入 step 摘要的「过程观察 ×N」。
- **候选池取舍**：`src/core/select.js` 新增轮内近似去重（Jaccard）、MMR 去冗余、
  分层配额（`thoughtQuotas`）与结论预留槽；单轮想法上限从 24 降到 10，一条 reasoning 最多 8 个候选。
- **note 折叠**：默认 `noteNodeMode:'fold'`，note 不再单独占节点；`node` 可回退旧行为。
- **旧行为回退**：`extract.selectionStrategy='chronological'` 保留按事件顺序 + `minThoughtScore` 的模式。

### 新增配置

`extract.selectionStrategy`、`thoughtQuotas`、`dedupeSimThreshold`、`mmrLambda`、
`reserveConclusionSlots`、`claimMinConfidence`、`claimMargin`、`noteNodeMode`。

### 测试与验证

- 测试增至 86 项 / 9 suite（新增 `select.test.js`；extract 增加 ranked 配额/层级与 chronological 回退）。
- 真机回放（同一 1200 事件窗口，ranked vs 旧 24/12/node 行为）：
  主会话想法 49→16、本会话 52→23；note 节点 20/15→0；每轮想法收敛到 ≤10。

### 升级说明

- 宿主侧新代码需要重启 DSH 进程后才生效。
- 旧图不迁移：新规则只影响后续事件；需要重训历史的会话可删 `graph.json` 后依赖回放重建。

## 0.5.0 — 2026-10-31

### 修复（P0 正确性，对应 docs/extractor-optimization.md）

- **假 goal**：现在只有 `source.kind === 'user'`（或旧事件缺省 source）才算真人消息；
  时间采样、审批策略、工具通知等注入消息只更新运行时上下文，不建 goal、不参与轮次标题。
- **轮次标题污染**：`turn/start` 不再借用上一轮用户文本；step 标题先占位，真实用户消息到达后
  回填「第 N 轮：意图」（用户消息先到时暂存 pending 意图，建 step 时再落）。
- **重复 step**：中途接入补建的 midway step 被后续 `turn/start` 复用并升级为正常轮次指纹；
  新增 `extract.mergeDuplicateSteps` 迁移，旧图同会话同轮的重复 step 首次读取时合并。
- **artifact 误判**：产物只认 `deliverables/presented` 事件，以及写类工具
  （write / edit / str_replace_editor）参数里真实存在、扩展名白名单内的文件；
  读文件、列表、回显文本里的路径不再算产物。
- **事件透传**：translate 现在带 `sourceKind/sourceForm`、`turn/step/seq`，并记录
  callId→工具名/参数，tool/result 不再依赖宿主缺失的 `name` 字段。

### 新增

- `deliverable.presented` 内部事件，落 `artifact`（`tags: ['deliverable']`）。
- 配置 `extract.mergeDuplicateSteps`（默认 `true`）。
- 测试增至 75 项 / 9 suite（来源过滤、轮次锚点回填、midway 复用、重复 step 迁移、交付物）。

### 升级说明

- 宿主侧新代码需要重启 DSH 进程后才生效；live GUI 不重启时仍按 0.4.0 行为运行。
- client bundle 无改动，无需重新构建。

## 0.4.0 — 2026-10-31

### 修复

- **reasoning 块没有被提取成节点**（用户反馈：temp2 的轮次其实有 reasoning，树却只有 3 个节点）。
  根因有三层：
  1. 旧逻辑只读 reasoning 的前 4,800 字符，正好停在任务复述与公式碎片上；
  2. `splitThoughts` 把公式与续行拆成孤立的 `is invertible…` 之类碎片，`scoreThought`
     又只认中文线索，英文数学推理得分全为 0 或负，被 `minThoughtScore=2` 全量过滤；
  3. `normalizeConfig/extractConfigOf` 漏了 `minThoughtScore`/`maxThoughtSourceChars`，
     宿主配置改不动提取器阈值。
- 现在：
  - `thoughtSource`：超长 reasoning 取「头 + 尾」（默认 60,000 字符），末尾结论不再丢失；
  - `splitThoughts` 重写：bullet 独立、段落合并、续行/公式碎片并回上一段、显示公式整块保留；
  - `scoreThought` 重写：中英文规则对称，数学/分支/机制/连接词加分，基础分 1，只过滤过程旁白；
  - `#connectStep` 增加「同 session+turn 最近 step」回退；`turn/start` 重复投递用 `#addOrHit`
    防重复 step；
  - 配置键贯通 `minThoughtScore/maxThoughtSourceChars`，默认 `maxThoughtNodesPerTurn=24`、
    `maxThoughtUnitsPerBlock=12`、`maxThoughtChars=400`。

### 新增

- **旧会话补建**：进入一个本工作区还没有图的会话时，`session/created` →
  `backfillSession` 回放 `session.snapshotEvents()`（最近 1,200 条），从 reasoning 重建整棵树；
  已有 step 的会话跳过；宿主未发 `session/created` 时首个事件也会触发同一回放。
  配置 `extract.backfillHistory`（默认 `true`）。
- 用真实 temp2 会话回放验证：goal → step → 12 个想法节点（evidence/question/hypothesis/
  decision/note，假设下挂证据形成多层）→ conclusion。
- 测试增至 64 项 / 7 suite（英文/数学推理评分、公式续行合并、thoughtSource、重复轮次、
  历史回放补建幂等）。

## 0.3.2 — 2026-10-31

### 修复

- **单轮文本会话没有树**（用户反馈）：根因是宿主真实事件顺序为 `turn/start` 先于 `user/message`，
  旧提取器先建 step 成根、后建 goal，两个根并列；且没有 reasoning/工具事件时只产出一个
  `conclusion`。现在：
  - `#adoptRootSteps`：goal 落库后把同会话的孤立 root step 归到目标下（新会话立即修复）；
  - 旧图迁移 `adopt-orphan-steps`：首次读取时把错挂成根的 step 归位；
  - **长回答兜底拆段**：无推理链时按 Markdown 标题/加粗小标题拆成推导节点，标题并列挂 step、
    加粗小标题作为当前阶段的子论点；结论标题落 `conclusion`；旧图用 `expand-conclusion-sections`
    迁移展开已有长结论；
  - 新增配置 `captureAnswerSections/minAnswerChars/minSectionChars/maxAnswerSections/
    repairOrphanSteps/expandLegacyAnswers`。
- 测试增至 58 项 / 6 suite（事件顺序归位、长回答拆段、旧图迁移）。

## 0.3.1 — 2026-10-31

### 变更

- **简化可视化入口**（用户反馈）：删除顶栏常驻「研究轨迹」按钮与全帧弹层，只保留会话上栏
  `conversation.view` 页签（`order=45`，排在记忆与预览之间）。
- **精简面板顶行**：去掉工作区下拉与工作目录路径输入；页签自动跟随当前会话工作区
  （`session.cwd`），顶部只留标题、工作区名、节点统计、更新时间、刷新、隐藏动作、自动刷新。
- **修复首帧空白**：数据到达前显示「正在读取研究图…」，画布对空快照防御，不再整块空白。
- 测试与文档同步（52 项 / 6 suites）；新增 `docs/tree-review.md` 记录当前树结构审计。

## 0.3.0 — 2026-10-31

### 新增

- **上栏全局入口 + 弹层**：`conversation.header.leading` 常驻「研究轨迹」按钮（无会话、重启后也能点），
  `shell.overlay` 全帧弹层（Escape/遮罩/× 关闭）。解决「必须先开对话才能看到研究轨迹」。
- **可以打开任意已有图**：顶部新增工作目录路径输入；宿主维护全局索引
  `$DSH_HOME/explore-tree/workspaces.json`，打开过的图重启后仍在下拉里。
- **只取关键想法**：新增 `scoreThought` 信息量评分与 `minThoughtScore: 2` 默认门槛，
  「Let me run npm test / Remaining tasks…」这类过程旁白不再建节点；决定/证据/失败/结论/引用加分。
- **多层想法树**：假设/问题/决策作为「思路节点」挂 step，后续证据/观察/结论优先挂到思路上。
- **读树返回缩略树**：`explore_tree` 新增 `subtree` 与 `depth`（tree/subtree 默认 3 层、受节点数上限约束），
  工具描述明确「返回缩略视图而不是整棵树」。
- **卡片树自动折叠**：子节点超过 8 个默认折叠，先给关键节点总览；用户展开后按会话记住。
- 单测增至 52 项 / 6 suite；新增评分、层级、无会话全局索引用例。

### 变更

- 想法预算默认收紧：`maxThoughtNodesPerTurn: 10`、`maxThoughtUnitsPerBlock: 5`。
- 面板弹层模式下画布/详情各自滚动，页签模式仍交给宿主滚动。

### 已知限制

- 后台 LLM 辅助提取（`config.llm.enabled`）为预留开关，未实现。
- 多宿主进程同写一个工作区按最后写入者赢，不做分布式锁。
- 宿主侧代码（提取规则/索引）需重启 DSH 后生效；client bundle 由 HMR 即时生效。

## 0.2.0 — 2026-10-31

### 变更

- **可视化位置改为会话上栏页签**：从 `sidebar.panellist` + `main`（左栏）改为
  `conversation.view`（对话/轨迹/上下文 那一行，order=45）。页签默认绑定当前会话工作区，
  并按会话记住选择。
- **修复「看不到图」**：首帧快照未到时不再渲染画布，改为「正在读取研究图…」加载态；
  画布对空数据防御，避免瞬时无数据导致整块面板崩溃空白。
- **布局契约对齐宿主**：根节点不再自建纵向滚动层（交由宿主 scrollBody），画布只横向滚动。
- **建树以推理链为主**：`extract.js` 新增 `splitThoughts` / `classifyThought` / `thoughtTitle`，
  把 reasoning 切成有信息量的想法并按句式线索分成 question / hypothesis / evidence /
  decision / dead_end / conclusion / note 节点，挂在 step 下；对错都留痕，节点不做好坏判定。
  工具调用降级为动作/产物旁证。
- **推理节点预算与去重**：`maxThoughtNodesPerTurn`、`maxThoughtUnitsPerBlock`、
  `minThoughtChars` / `maxThoughtChars`；同指纹想法只累计 `hits`。
- **配置新增**：`extract.captureReasoningNodes` 与 6 个想法切分键（README/设计文档已同步）。
- **减少数据量**：工具调用默认按轮汇总为一个 `action` 节点（`toolCallMode: aggregate|nodes|off`），
  失败/产物直接挂 step；旧图首次读取时自动压缩历史逐调用动作节点（`compactLegacyActions`）。
- **卡片树可视化**：自上而下的卡片 + 虚线连接（父卡居中于子卡行），支持折叠子树与
  「隐藏动作」开关；不再用横向缩进列表。
- 单测增至 48 项；`client.test.js` 改为断言 conversation.view 注册与首帧加载态。

### 已知限制

- 后台 LLM 辅助提取（`config.llm.enabled`）为预留开关，未实现。
- 多宿主进程同写一个工作区按最后写入者赢，不做分布式锁。
- 面板只读，无缩放/拖拽/折叠。
- 宿主侧代码（提取规则）需重启 DSH 后生效；client bundle 由 HMR 即时生效。
## 0.1.0 — 2026-10-31

首个可用版本。

### 新增

- **树模型**：`Node`（11 种 kind、4 种 status、refs/tags/confidence/fingerprint/hits/order）、
  旁支 `Edge`（8 种关系）、会话游标；单父禁环、`validateGraph` 校验。
- **持久化**：每工作区 `.explore-tree/`：原子快照 `graph.json` + 追加式 `journal.jsonl`
  + 归档 `archive.jsonl`；journal 重放恢复、损坏隔离、写入串行、250ms debounce flush。
- **自动提取**：旁路订阅 `session/event`，确定性规则生成 goal/step/action/dead_end/artifact/
  conclusion；指纹去重（hits）、每轮预算、忽略插件自身工具、中途接入容器 step。
- **工具**：`explore_tree`（overview/frontier/stats/find/node/path/tree）与
  `explore_tree_record`（add/update/move/link/close/reopen/merge）。
- **探索建议**：`frontier` 混合建议（seed/stop/verify/resolve/branch/deepen/consolidate/revive）
  + `avoid` 死路 + 过度自信标记，保证含验证/收敛类。
- **前缀稳定**：静态系统提示段（order 4900）、固定工具面、动态状态只走工具返回值；
  `test/unit/prefix.test.js` 回归。
- **Web 可视化**：手写 `__ModuleLoader__` bundle，侧栏「研究轨迹」图标 + 主面板
  （SVG 树、节点详情、frontier/avoid、3s 轮询、工作区下拉）。
- **HTTP 端点**（仅本机 GET）：`/explore-tree/health|workspaces|snapshot`。
- **工程化**：`scripts/install|status|smoke|uninstall`（scratch profile e2e、备份、回滚、
  `--help`、`--port 0`、`--base` 线上只读体检、`--restore-lockfile`）、
  42 项单测、README、设计文档、标题/摘要/建议的截断策略。

### 已知限制

- 后台 LLM 辅助提取（`config.llm.enabled`）为预留开关，未实现。
- 多宿主进程同写一个工作区按最后写入者赢，不做分布式锁。
- 面板只读，无缩放/拖拽/折叠。
