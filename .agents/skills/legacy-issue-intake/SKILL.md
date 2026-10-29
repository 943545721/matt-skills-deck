---
name: legacy-issue-intake
description: "把散乱的历史需求 Markdown 收编成可审阅的票：只读盘点、去重合并、分类映射、dry-run 清单，经批准才用 deck 工具建票；可断点续跑，绝不删改原文件。"
---

# 历史需求收编

把仓库里散落、重复、格式不一的历史需求 Markdown，变成任务板上能追踪的票。要求：**可审计、可回滚、可中断**。

## 三条底线（任何一步都不能破）

1. **先只读**。没有用户明确批准之前，不建票、不改标签、不移动或删除任何文件。
2. **原文件不动**。收编是「复制语义」，不是搬运；旧目录永远原地保留。
3. **不猜**。判不出来就写「未确认 + 缺什么证据」；「没找到」不等于「不存在」。

过程文件（`inventory.json` / `plan.json` / `progress.json`）写在 `.deck/intake/`，那是过程数据，不是票；不想落盘就只在对话里出清单。`.deck/` 目前没进 `.gitignore`，要不要加由用户决定。

## 零、先确认后端与布局（不先确认，建票会整批失败）

用 `deck_context` 或检查页确认当前后端，再按能力定计划：

| 后端 / 布局 | 能建的 kind | 幂等键 | parentKey |
|---|---|---|---|
| GitHub / GitLab | 六种全支持 | 支持（≤200 字符） | 建票时传 |
| 本地 `.scratch` | 六种全支持 | 支持 | 容器父票用 `00`，普通票用票号 |
| 本地 `.deck` | **只有 `issue` / `bug`** | **不支持** | **不支持** |

`.deck` 布局下 spec/map 容器、父子关系、幂等键都不可用（`server/tracker/local.ts:529`）。遇到它先让用户二选一：

- 先初始化 `.scratch` 布局，再按完整计划走；
- 只建平票，关系写进正文；**没有幂等锚，重跑前必须人工核对**，否则会重复建票。

## 一、先量规模

```bash
find . -path ./node_modules -prune -o -name '*.md' -print | wc -l
find . -path ./node_modules -prune -o -name '*.md' -print0 | xargs -0 wc -c | tail -1
```

| 档 | 判据 | 做法 |
|---|---|---|
| **S** | ≤50 篇 | 逐篇读全 |
| **M** | ≤500 篇 | 脚本聚类，逐篇判定但不整篇回显 |
| **L** | >500 篇 | 按目录分战役，每批 ≤100 篇，各自出清单 |

档位与数字写进 `inventory.json` 和报告第一行。

## 二、盘点：脚本产出 `facts`

写 `.deck/intake/inventory.json`（不写进 `docs/`，它不是文档，是过程数据）：

```json
{
  "generatedAt": "2026-10-30T00:00:00Z",
  "root": "/abs/path",
  "tier": "M",
  "candidates": [{
    "path": "docs/old/req-login.md",
    "bytes": 1234,
    "sha256": "…",
    "format": "deck|scratch|freeform",
    "guessedTitle": "登录改造",
    "statusWords": ["已完成"],
    "cluster": "login",
    "duplicateOf": null,
    "excluded": null,
    "evidence": ["docs/old/req-login.md:1"]
  }],
  "totals": { "candidates": 0, "alreadyTickets": 0, "excluded": 0, "clusters": 0 }
}
```

规则：

- 只扫 `.md` / `.markdown`；排除 `node_modules/`、`.git/`、`vendor/`、`dist/`、`build/`、`.claude/`、`.agents/`、`templates/skills/`，以及收编自己的 `.deck/intake/`（否则重跑会把 plan 当成候选）。
- **`docs/agents/` 是收编的约定文件，不是票**；ADR、变更日志、会议记录、README 单列为 excluded 并写明原因。
- 三种格式分别认：`---` 开头且有 `number:` → 已经是票（只登记，不重复建）；含 `<!-- DSH-` 或 `Status:` / `Labels:` 行 → scratch 格式；其余 → freeform。
- 去重：完全重复看 `sha256`；近似重复看标题归一化 + 3-shingle 相似度 ≥0.8；`-v2` / `-old` / 日期后缀进同一条时间线。

## 三、逐篇判定：产出 `plan`

每篇回答七个问题，写进 `.deck/intake/plan.json`：

| 字段 | 规则 |
|---|---|
| `isRequirement` | 否 → excluded，写原因 |
| `kind` | 只能是 `map` / `map-ticket` / `spec` / `spec-ticket` / `bug` / `issue`；拿不准用 `issue` |
| `state` | 文中明确完成/关闭 → `CLOSED`；明确未完成 → `OPEN`；**没写就 `OPEN` + `needs-triage`** |
| `labels` | 只用 `STANDARD_LABELS` 那 10 个或仓库已有标签；要新标签先问 |
| `parent` | 只认文中明确的「Part of #…」「子票」；跨后端的票号不通用，迁移后重建边 |
| `blockedBy` | 只认 `Blocked by:` 一类明确表述 |
| `evidence` | 每条结论至少一个 `path:line` |

判定不了的状态、归属、优先级一律标 `unconfirmed`，连同缺失的证据写进清单，不许按常识补。

## 四、归并

- **完全重复**：留正文最全的一篇做 canonical，其余内容并入「来源」小节，记 `mergedFrom`。
- **版本链**：只给最新版建票；旧版正文写 `Superseded by <新票>`，不建票、不删文件。
- **一个需求拆成多篇**：建 `spec` + 子票，用 `deck_map_link` 连边，不要塞成一个巨型正文。
- 合并后正文 ≤ **60,000 字节**（`BODY_LIMIT_BYTES`，`shared/tool-contract.ts:484`）；超了就拆票，或摘要 + 原文路径。

## 五、dry-run 清单：唯一的批准点

`.deck/intake/plan.md` 必须包含：

- 总量表：候选 / 已是票 / 将新建 / 将合并 / 排除 / 未确认；
- 每行：动作、标题、`kind`、标签、来源（可多个）、置信度 `high|medium|low`；
- 冲突清单：两篇说同一件事但状态或优先级不同，逐条写差异；
- 敏感清单：疑似密钥 / token / 密码 / 个人信息，**只写位置，不抄值**；
- 一句明确结论：「本清单尚未写入任何票」。

然后停下来等用户批准。清单改过就重新批准，不拿旧清单执行新计划。

## 六、执行（批准之后）

- 只用 deck 工具：`deck_issue_create`（`kind` 必填）、`deck_issue_comment`、`deck_map_link`、`deck_issue_patch`（回滚关闭用）。**不要用 `gh issue create` 绕过**——会丢幂等键、丢地图边。
- 幂等键：`intake:<内容哈希前 12 位>`（≤200 字符，别拼长路径），**每张票都显式传**；重跑不会重复建票。不传的话工具会自动生成锚，那是按 5 分钟窗口算的（`shared/anchor.ts:8`），跨窗口重跑照样重复。
- 顺序：先建 `map` / `spec` 拿票号 → 再建子票，**建票时就传 `parentKey`**；`map-ticket` 还必须用 `label: wayfinder:<kind>` 指定类型标签，不能塞进 `labels` → 最后用 `deck_map_link` 补 `blockedBy`。子票不能「先建后连」：`map-ticket` / `spec-ticket` 缺 `parentKey` 会被拒绝（`shared/issue-kind.ts:203`）。
- 字段上限：`title` ≤256 字符（超出截断，全文放正文）；`body` ≤60,000 字节；`labels` / `assignees` / `blockedBy` 各 ≤50 项。
- 每批 ≤20 张；每批结束写 `.deck/intake/progress.json`（已建 / 跳过 / 失败 / `maybeCreated`）。
- 返回「可能已写入，先刷新确认」时**停手**，先用 `deck_issue_list` 核对再决定，不许盲目重试。
- 单张失败不拖垮整批：记下来继续，最后统一报告。
- 每张票正文末尾带来源行：`来源：<path>（sha256 前 12 位）`。

## 七、校验与报告

`.deck/intake/report.md`：

1. 建了多少、跳过多少、失败多少，与 `plan.md` 逐项对账；
2. 抽查 3 张：标题、正文、标签、父子与阻塞边；
3. 未确认项及缺的证据；
4. **回滚办法**：按报告里的票号用 `deck_issue_patch` 关闭并附「导入回滚」评论——先关子票再关容器，关 `map` 时必须同时给评论且子票已全关；不删票；原文件从头到尾没被移动过；
5. 可选收尾：在旧目录放一个 `ARCHIVE.md` 指向新票号（放不放由用户定）。

## 八、脏数据对照表

| 情况 | 处理 |
|---|---|
| 标题为空或文件叫 `untitled.md` | 用首行标题；仍没有 → 列待确认，不建 |
| 同一状态多种说法（完成 / 已修复 / fixed） | 归一化成 `CLOSED`；拿不准就 `OPEN` + `needs-triage` |
| 附件图片、截图 | 不上传、不转 Base64；正文写相对路径 + 「原图在仓库」 |
| BOM、CRLF、全角冒号 | 解析前归一化，原文件不改 |
| 正文超过 60,000 字节 | 拆票，或摘要 + 原文路径 |
| 疑似密钥 / PII | 正文脱敏；清单只记位置；不复制到远端票 |
| 只有外部链接、没有正文 | 保留链接并标「未核实」 |
| 文件读不出来 | 进 `quarantine` 清单，不猜内容 |

## 九、预算与限流

- 不把整篇文档贴进对话；用 `inventory.json` 的摘要字段推进。
- 远端后端每建一张票至少一次 API 调用；批次之间留间隔，遇限流停下等，不重试风暴。
- L 档按战役推进：一次只批准一个目录，做完一批再谈下一批。

## 十、反模式（出现任意一条就停）

- 没批准就建票
- 把 `docs/agents/`、ADR 或会议记录当需求收编
- 「没写状态」当成已完成
- 删除或移动旧文件「保持整洁」
- 用 `gh issue create` 绕过 deck 工具
- 重跑却没有幂等键
- 把疑似 token 原样写进票里
- L 档一次性建几百张票、中途没有检查点

## 十一、收尾报告

1. **档位与数量**：S/M/L + 候选数 / 新建数；
2. **清单与批准**：`plan.md` 路径、谁在什么时候批准；
3. **建票数量**：按 `kind` 分组；
4. **未确认项**及缺失证据；
5. **失败与 `maybeCreated`**：逐条写票号或来源；
6. **回滚办法**；
7. **原文件状态**：一句「未移动、未删除」。

不要把「没做」写成「没有」。
