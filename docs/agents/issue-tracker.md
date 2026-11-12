# 议题跟踪器：GitHub

这个仓库的议题与规格说明都以 GitHub 议题的形式存放。**读**用 `gh`；**写**（建票、改票、评论、打标签、关闭）一律走插件的 `deck_*` 工具——插件的票闸会在 shell 权限上直接拒掉 `gh` / `glab` 的写命令，绕不过去。

## 约定

- **创建议题**：`deck_issue_create`（`kind` 必填；`requirementKey`、`parentKey`、`blockedBy` 由工具校验）。多行正文直接写进 `body`。
- **读取议题**：`gh issue view <number> --comments` 照常可用；要正文、标签、评论一起拿，用 `deck_issue_get`。
- **列出议题**：`gh issue list --state open --json number,title,body,labels --jq '…'` 或 `deck_issue_list`。
- **给议题写评论**：`deck_issue_comment`。
- **加标签 / 去标签**：`deck_issue_labels`（整组替换）或 `deck_issue_patch` 的 `addLabels` / `removeLabels`。
- **关闭**：`deck_issue_patch`（`key` + `close: true`，可同时带 `comment`）。

从 `git remote -v` 推断仓库；在克隆目录里运行时，`gh` 会自动完成这件事。

## PR 作为分诊入口

**PR 作为请求入口：否。** _（如果这个仓库把外部 PR 当成功能请求，就把 `PRs as a request surface` 这个开关设成 `yes`；`/triage` 会读它。）_

当它设成 `yes` 时，PR 会像议题一样经过同一套标签和状态，用的是一一对应的 `gh pr` 命令：

- **读取 PR**：`gh pr view <number> --comments`，看 diff 用 `gh pr diff <number>`。
- **列出需要分诊的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，然后只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的条目（丢掉 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的议题和 PR 共用一套编号，所以光写一个 `#42` 可能指其中任何一个：先用 `gh pr view 42` 解析，找不到再回退到 `gh issue view 42`。

## 当技能说「发布到议题跟踪器」

创建一个 GitHub 议题。

## 当技能说「取出相关工单」

运行 `gh issue view <number> --comments`。

## 寻路操作

供 `/wayfinder` 使用。**地图**是一个议题，**子**议题就是工单。

- **地图**：一个打了 `wayfinder:map` 标签的议题，正文里放 Notes、Decisions so far 和战争迷雾这些内容。用 `deck_map_plan_create` 连地图与首批路线票一起建。
- **子工单**：用 `deck_issue_create` 的 `kind: "map-ticket"` + `parentKey: <地图号>`，标签写 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）——工具会写成原生父子关系。一旦认领，工单会指派给负责推进的开发者。
- **阻塞**：用 `deck_map_link` 写 `blockedBy`（或建票时直接带 `blockedBy`），工具会落成 GitHub 的原生依赖边。依赖功能不可用时，回退成在子工单正文最上面写一行 `Blocked by: #<n>, #<n>`。所有阻塞项都关闭时，工单才算解除阻塞。
- **前沿查询**：`deck_map_snapshot`（`frontierOnly: true`）或 `deck_next_steps`，返回的就是「打开、未认领、阻塞项已关」的票。
- **认领**：`deck_issue_patch` 写 `assignees`，这是本次会话的第一次写入。
- **解决**：`deck_issue_comment` 写答案，再用 `deck_issue_patch` 关闭；最后把一条上下文指针（要点 + 链接）追加到地图的 Decisions so far 段（`deck_issue_patch` 改地图正文）。
