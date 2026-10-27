# MattSkillsDeck for Paseo

把 [dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) 移植成 Paseo 插件：
27 个 Matt Pocock 工程技能，加上多后端工作票面、地图与一组给 Agent 用的 `deck_*` 工具。

当前状态：**DSH 版 A1–A26 已逐项落地**（P0–P12 完成；仓库公开在 GitHub，打了 `v0.1.0` / `v0.1.1`，可用 git 源安装）。
26 项里 15 项完全对齐、7 项换面、3 项仍有宿主边界、1 项（会话自动命名）不做；逐项证据与剩余差异见
[`docs/port-diff.md`](docs/port-diff.md)，阶段记录见 `PROGRESS.md`。按 D6 决定**不提交公开注册表**。

## 能做什么

- **任务板**：列出工作区所指仓库的 issue，按「地图票优先、开着优先」排序；可接 / 阻塞 / 已关闭三个 KPI，
  六个视图（全部、Open、可接、阻塞、已关闭、已合并）与四种排序；显示最近更新时间、额度读数与 REST 回退提示，
  按设置自动刷新；拉取请求独立页签，打开 / 已关闭 / 已合并三态，只读。
- **票面**：正文 Markdown、评论、整体替换标签、接手 / 完成（真实写入）、打开远端、复制链接与五种动作提示词；
  新建票可勾「地图」；新建**需求**可选探索 / 实施两种六段模板，自动带 `requirement` 标签。
- **地图**：`wayfinder:map` 票会多一个「打开地图」入口，一屏给出目标、已定决策、雾、路线、层级与每层进度、
  子票分组（可接 / 认领 / 阻塞 / 关闭），以及可复制的下一步建议。
- **技能**：27 个技能中英双语随包分发，可看原文、可复制原文，按工作区一键安装到 `.claude/skills` 与 `.agents/skills`；
  安装前先列出要写的文件，不自动写入。
- **Agent 工具**：14 个 `deck_*` MCP 工具（读票、读地图、下一步、PR、探针、上下文，以及评论、建票、改票、改标签、报告、挂地图、建地图计划）。
  读工具预授权，写工具每次都要人确认；GitHub / GitLab（只读）/ 本地 Markdown 三种后端共用同一套工具。
- **其他页**：标签配色（读、改、读回核对、复制配色提示词）、版本管理（状态、diff、提交历史、stage / commit / pull / push、AI 交接）、
  诊断（逐项环境检查 + 可复制修复 + 六步仓库初始化引导 + 日志开关 / 复制 / 清空）、插件设置（后端、刷新间隔、调试日志、更新检查）。
- **双语**：界面跟随 App 语言（中/英），标题与按钮在同一套词表里。

## 后端

设置页的「后端」决定票读写落到哪；`auto` 是默认值：

| 后端 | 读 | 写 | 数据位置 / 依赖 |
|---|---|---|---|
| `auto` | 有 GitHub 远端走 GitHub，有 GitLab 远端走 GitLab，都没有走本地 | 跟随实际后端 | — |
| `github` | 是 | 是 | `gh` 已安装并 `gh auth login` |
| `gitlab` | 是（issue 与评论，系统备注过滤） | **否**，写操作会如实拒绝 | `glab` 已安装并 `glab auth login` |
| `local` | 是 | 是 | 工作区里的 `.deck/`，无外部依赖 |

本地后端的布局：

```
.deck/
  issues/<n>.md            # frontmatter + 正文
  issues/<n>.comments.json # 评论
  labels.json              # 标签目录与颜色
```

`.deck/` 可以直接用编辑器改、用 git 提交、用 grep 找。切换后端不会自动搬数据，诊断页会提示
「切过去会看不见哪些票」；GitLab 只读也会在这一页写明。

## 安装

```bash
# 本地目录（开发用）
paseo plugin install /绝对路径/paseo-matt-skills-deck

# Git（推荐钉 tag）
paseo plugin install git:943545721/matt-skills-deck --ref v0.1.1

paseo plugin reload matt-skills-deck     # 改完代码热更新
paseo plugin ls                          # 应显示 running
paseo plugin logs matt-skills-deck       # 出问题时看这里
```

前提：Paseo `>=0.13.0 <0.14.0`。GitHub 后端需要 `gh` 并已 `gh auth login`；GitLab 后端需要 `glab` 并已登录；
只用本地后端则不需要任何 CLI。缺什么时面板不装死，会直接说明，并在诊断页给出可复制的修复命令。

插件设置页（Paseo 设置 → 插件 → MattSkillsDeck）可以改后端、刷新间隔、调试日志，并检查远端有没有更新的 tag。
更新检查只查不装：宿主没有安装插件的调用面，这里给出一条可复制的 `paseo plugin install ...` 命令。

## 开发

```bash
npm install
npm run typecheck    # 客户端与服务端各一份 tsconfig，边界靠类型检查兜住
npm test             # node --test，直接跑 TypeScript（Node 自带类型剥离）
```

改完代码后 `paseo plugin reload matt-skills-deck` 即可；两端 typecheck 与全量 `node --test` 是提交前的门槛。
测试覆盖三种后端的读写分派、地图解析与分层、MCP 工具参数、失败分类，以及环境检查的每一条分支。

## 结构

```
paseo-plugin.json    清单：id、要求、媒体
index.client.tsx     注册面：工作区面板、整页界面、侧栏行、设置页
index.server.ts      注册 RPC 与生命周期钩子
shared/              两端共用的 RPC 契约（Zod）：issues、map、labels、env、logs、settings、requirement、update
client/deck/         插件界面：任务板、地图、技能、标签、版本、诊断、设置、初始化引导、像素皮肤
server/tracker/      票面领域逻辑：多后端分派、gh / glab / 本地 Markdown 读写、地图正文、路线与建议
server/rpc/          RPC 处理器（一条 RPC 一个文件）
server/mcp/          给 Agent 的 MCP 服务端（协议层 + 14 个工具）
server/hooks.ts      before agent.create：按工作区后端注入 deck 工具
server/env.ts        环境检查的逐项规则
server/update.ts     远端 tag 检查
templates/skills/    随包的 27 个技能（中英双语）
```

分层硬规则：`client/` 不 import `node:*`，`server/` 不 import `client/`，跨边界数据一律过 `shared/` 的 Zod 契约。
两套 tsconfig 就是为了让这三条在编译期就报错。

## 与 DSH 版的差异

完整的逐项对照见 [`docs/port-diff.md`](docs/port-diff.md)。最影响使用体感的几条：

- 面板落在**工作区标签页**，不是常驻右栏；也没有输入框胶囊栏 / 全局状态栏，KPI 与故障信息在面板内。
- 「一键填入输入框」改为**复制到剪贴板 + 提示**——插件改不了 Agent 的输入框。
- Agent 工具走**独立 MCP 子进程**；GitHub / GitLab 远端一定注入，本地后端只在工作区已有 `.deck/`
  （或在设置里明确选了 local）时注入，避免每个空目录都多出十几个工具。写工具默认要确认。
- 会话自动命名**放弃**：`agent.create` 钩子看不到首条提示词，也没有 Agent 改名 API，宁可不命名也不猜。
- GitLab 后端**只读**；本地 Markdown 后端读写都有，数据在 `.deck/`。
- 视觉用 RN 原语重画成像素风牌面：直角、2px 描边、右下硬投影、等宽数字。

## 已知限制

- 本机验证只到「编译 / 单测 / reload / 失败分支」；真实 GitHub / GitLab 读写与 MCP 注入需要在有登录态的环境里跑一遍。
- Agent 工具要求 daemon 跑在 Node 22.18+（插件直接用当前 Node 跑 `server/mcp/main.ts`）。版本不满足或入口文件缺失时，
  插件会跳过注入并在 `paseo plugin logs` 里说明，不会挂一个起不来的服务。
- MCP 服务名固定 `matt-skills-deck`（预授权名单按服务名映射），不要在工作区里自建同名服务。
- 像素风外观没有截图验证：这个环境起不了 Paseo 桌面端窗口。
- GitLab 的合并请求（MR）还没接；PR 页签只对 GitHub 后端返回数据。
- 更新检查需要本机有 `git` 且能访问 GitHub；失败时如实报错，不会猜一个「已是最新」。
- 插件 API 处于实验期，`requirements.paseo` 钉在 0.13.x。

## 许可

MIT，见 `LICENSE`；第三方来源见 `NOTICE.md`。
