# 注册表提交包

> **现状（D6）**：决定**不上架公开注册表**，本文仅作流程备查，不需要执行。
> 仓库已公开、tag 可装、artifact 校验已通过；不提交 `getpaseo/plugins`。

公开注册表是 GitHub 上的 [`getpaseo/plugins`](https://github.com/getpaseo/plugins)：作者开一个
**submission issue**，机器人把 issue 转成 review PR，维护者审核后再合并。CLI 里没有 `publish`
子命令，安装端读的是 `<base>/plugins/<owner>/<slug>.json`。

## 先决条件（已满足）

仓库已转为**公开**：匿名访问 `api.github.com/repos/943545721/matt-skills-deck`、
`raw.githubusercontent.com/.../v0.1.1/paseo-plugin.json`、图标 URL 均返回 200。

## 必须走网页表单，不能用 API 开 issue

intake 工作流的 job 级条件是 `contains(github.event.issue.labels.*.name, 'submission')`，
而 `submission` 标签由**表单模板**在提交时自动打上。用 REST API 建 issue 时：
`labels` 参数会被忽略（非协作者没有 triage 权限），再单独加标签直接 403
`Must have admin rights to Repository.`。结果就是 issue 建得出来，但 intake 永远跳过它。

实测过：issue #1253 就是这么建的，没有标签、没有 PR，已关闭。

## 提交表单怎么填

地址：<https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml>

| 字段 | 值 |
|---|---|
| Title | `matt-skills-deck` |
| Source | `https://github.com/943545721/matt-skills-deck` |
| Categories | ☑ **Workspaces**（主类目）、☑ **Utils**、☑ **Git** |

**必须在网页上提交**（见上一节：API 建的 issue 拿不到 `submission` 标签）。
只填这些就够。标签、日期、artifact 固定由机器人写；缺截图不会挡住 review。

## 预备好的记录

下面这份用注册表自带的校验器跑过两轮：离线（392 条记录全部 well-formed）与在线
（`--online --changed`：**1 record matches its pinned artifact**，即注册表能真的 clone 到
那个 commit）。若需要直接提 PR，放到 `plugins/943545721/matt-skills-deck.json`。

三处 `<sha>` 都换成 `git rev-parse 'v0.1.1^{commit}'` 的输出（40 位）。

```json
{
  "id": "943545721/matt-skills-deck",
  "artifact": {
    "kind": "git",
    "remote": "https://github.com/943545721/matt-skills-deck.git",
    "commit": "<sha>"
  },
  "repository": {
    "url": "https://github.com/943545721/matt-skills-deck",
    "commit": "<sha>"
  },
  "categories": ["workspaces", "utils", "git"],
  "submittedAt": "2026-10-27T00:00:00Z",
  "submittedBy": "943545721",
  "publishedAt": "2026-10-27T00:00:00Z",
  "reviewedAt": "2026-10-27T00:00:00Z",
  "listing": {
    "description": "Adds a workspace tab with a GitHub issue board, wayfinder maps, 27 bilingual engineering skills you can install into a workspace, and read/write MCP tools for the agent.",
    "icon": "https://raw.githubusercontent.com/943545721/matt-skills-deck/<sha>/assets/icon.png",
    "media": [],
    "translations": {
      "zh-CN": {
        "description": "工作区标签页：GitHub 任务板、wayfinder 地图、27 个中英双语工程技能（可一键装进工作区），以及给 Agent 用的读写 MCP 工具。"
      }
    }
  }
}
```

日期以提交当天为准；这三个时间戳在审核合并时会被维护者/机器人改写。

## 还差什么

1. **在网页上提交那张表单** —— 唯一还缺的一步，且必须由有 GitHub 登录态的人完成
   （原因见上：标签只能由表单打上）。
2. **`media`**：现在空数组。注册表对「有界面的插件」期望提供截图；`REVIEW.md` 说视觉相关
   的 listing 需要合适的媒体。本机起不了 Paseo 桌面端窗口，截不了图。建议录一段
   「任务板 → 地图 → 下一步」的 mp4/gif，传到仓库 `docs/` 下，再填 raw 链接。
   审核者可以补 listing 文案，但截图最好由作者提供。
3. **审核期间的更新**：Git 来源不会被自动跟踪新版本，发新 tag 后要重新提交一次，
   或请在审 PR 里改 commit。
