# graph.json Schema

本文只描述 `.explore-tree/graph.json` 的磁盘格式与版本兼容。设计背景见
[`docs/design.md`](./design.md)；状态派生（phase / 六主桶）见 `src/core/status.js`。

## 1. 顶层

```jsonc
{
  "version": 2,                    // schema 版本：1 | 2
  "workspaceRoot": "D:/ws",
  "createdAt": "2026-11-03T...",
  "updatedAt": "2026-11-04T...",
  "seq": 1167,                     // 下一个节点编号
  "edgeSeq": 46,
  "nodes": { "n1": { /* Node */ } },
  "edges": [ { "id": "e1", "from": "n1", "to": "n2", "kind": "supports", "note": "", "createdAt": "..." } ],
  "roots": ["n1"],
  "sessions": { "session-...": { "sessionId": "...", "activeNodeId": "n9", "goalId": "n1", "turn": 3, "lastSeenAt": "...", "createdAt": "..." } },
  "meta": { "journalOffset": 12345 }
}
```

- `version` 是 **schema 版本**，不是插件版本。
- `nodes` 是对象映射，便于按 id 定位；`roots` 与节点 `parentId` 必须一致。
- 文件由 `store.js` 经临时文件 + rename 原子写；迁移脚本同样使用 `atomicWriteFile`。

## 2. Node

必填：`id`、`kind`、`status`、`title`。其余字段按需出现；旧图可缺省。

```jsonc
{
  "id": "n12",
  "parentId": "n1",                  // null = 根
  "kind": "question",                // goal|topic|question|hypothesis|step|action|evidence|decision|dead_end|conclusion|artifact|note
  "title": "是否保留缓存？",
  "summary": "...",
  "status": "done",                  // open|active|done|abandoned；conclusion 默认 done
  "closeReason": "solved",           // 可选；open/active 时必须为空
  "resolutionBy": "human",           // 可选；open/active 时必须为空
  "createdAt": "...",
  "updatedAt": "..."
}
```

### 2.1 结束原因（v2 起稳定写入）

`closeReason` 取值：

| 值 | 含义 |
| --- | --- |
| `solved` | 问题/假设/目标/主题被解决 |
| `completed` | step/action 这一轮流程正常做完（不代表研究结论成立） |
| `dead_end` | 研究上确认走不通 |
| `superseded` | 被更新的一条取代（merge 时可指定） |
| `duplicate` | 与他人/旧节点重复，合并进保留节点（merge 默认） |
| `curated` | 自动卫生收敛：旁白/旧主题/低价值节点被收走 |
| `aborted` | 工具失败、轮次中断等非研究结论 |
| `recorded` | 记录类节点（evidence/note/conclusion/artifact/decision）已落账 |

`resolutionBy` 取值：`human`（人/模型显式 close）、`auto`（提取器、hygiene、merge
按规则写入）、`migrated`（P2 从旧图回填）。

约束：

- `open` / `active` 时两个字段必须为 `null` 或缺省；`reopen` 会清空。
- `done` / `abandoned` 时 P2 迁移后两个字段都必须有合法值。
- 旧图缺字段时，只读派生仍由 `inferCloseReason` 兜底；P0 六主桶计数不因缺字段改变。

### 2.2 版本兼容

| 读取 | 行为 |
| --- | --- |
| `version: 1` | 接受；节点字段原样读入，内存态仍为 1；普通写入继续写 v1，直到显式运行 P2 迁移 |
| `version: 2` | 接受 |
| 其他版本 | `fromJSON` 抛出 `unsupported graph version: N`，由 store 走损坏恢复流程 |

P2 迁移写回后，`version` 为 2，节点数、边数、`status` 计数都不变。

## 3. 旧图迁移（P2）

命令：

```bash
# 1) dry-run：只打印规则、计数、样本，不写文件
npm run migrate-close-reason -- --workspace "D:/yky/code/explore-tree"

# 2) 确认后写回：先备份，再原子写
npm run migrate-close-reason -- --workspace "D:/yky/code/explore-tree" --apply

# 3) 回滚：只清 resolutionBy=migrated，不动 human/auto
npm run migrate-close-reason -- --workspace "D:/yky/code/explore-tree" --revert --apply
```

行为：

- 已有 `closeReason` 的节点跳过，因此可重复执行。
- 按优先级推断：done 记录类/决策 → auto-curated → merged-into → 工具噪音 → `dead_end`
  → done goal/topic → done step/action → 中断 step/action → 其他 abandoned。
  auto-curated / merged-into / 工具噪音 / 中断写 `auto`，其余写 `migrated`。
- 迁移前后校验 `status` 计数完全一致；关闭节点必须有合法两字段；开放节点不得带字段。
- 备份到 `.explore-tree/graph.before-close-reason-<UTC 时间戳>.json`；回滚备份名为
  `graph.before-close-reason-revert-<时间戳>.json`。
- 默认检测 `http://127.0.0.1:3080/explore-tree/health`；宿主在跑时拒绝写回（非零退出码），必须停宿主
  或显式加 `--force`（宿主可能用内存状态覆盖文件）。
- `--json` 输出机读 summary，适合 CI/脚本。

迁移后用 `npm run audit-graph -- --workspace <dir>` 检查：v2 图若发现关闭节点缺字段、
开放节点带字段会 FAIL；v1 图只给 WARN，提示尚未回填。

## 4. 与只读派生的关系

`graph.json` 只存事实（status + closeReason + resolutionBy）。`phase`（todo/doing/
recorded/completed/closed/dead_end/curated/merged/tool_noise/aborted）和六主桶由
`src/core/status.js` 在读取时派生，**不写回图**。因此：

- P0 的 `statusDigest` 六主桶在 P2 前后不变；
- 需要新语义时优先改派生函数，不要继续往节点加临时布尔字段。
