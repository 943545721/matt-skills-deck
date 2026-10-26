# 注册表提交包

公开注册表是 GitHub 上的 [`getpaseo/plugins`](https://github.com/getpaseo/plugins)：作者开一个
**submission issue**，机器人把 issue 转成 review PR，维护者审核后再合并。CLI 里没有 `publish`
子命令，安装端读的是 `<base>/plugins/<owner>/<slug>.json`。

## 先决条件（当前未满足）

**仓库必须公开。** 现在匿名访问 `https://api.github.com/repos/943545721/matt-skills-deck`
返回 404、`raw.githubusercontent.com` 上的 `v0.1.0` 也是 404 —— 也就是说这是私有仓库。
私有时注册表无法 clone 到 artifact，`paseo plugin install git:…` 对外也不可用（只有持有
SSH 密钥的账号能拉）。

处理：仓库 **Settings → General → Danger Zone → Change visibility → Public**。

## 提交表单怎么填

地址：<https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml>

| 字段 | 值 |
|---|---|
| Title | `matt-skills-deck` |
| Source | `https://github.com/943545721/matt-skills-deck` |
| Categories | ☑ **Workspaces**（主类目）、☑ **Utils**、☑ **Git** |

只填这些就够。标签、日期、artifact 固定由机器人写；缺截图不会挡住 review。

## 预备好的记录

下面这份已用注册表自带的校验器跑过离线检查（`node scripts/validate.ts`：390 条记录全部
well-formed）。若需要直接提 PR，放到 `plugins/943545721/matt-skills-deck.json`。

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

1. **仓库转公开**（见上）—— 不做这一步，后面全部无效。
2. **`media`**：现在空数组。注册表对「有界面的插件」期望提供截图；`REVIEW.md` 说视觉相关
   的 listing 需要合适的媒体。本机起不了 Paseo 桌面端窗口，截不了图。建议录一段
   「任务板 → 地图 → 下一步」的 mp4/gif，传到仓库 `docs/` 下，再填 raw 链接。
3. **审核期间的更新**：Git 来源不会被自动跟踪新版本，发新 tag 后要重新提交一次，
   或请在审 PR 里改 commit。
