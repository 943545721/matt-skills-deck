# MattSkillsDeck for Paseo

把 [dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) 移植成 Paseo 插件：
27 个 Matt Pocock 工程技能，加上 GitHub 工作票面、地图与一组给 Agent 用的 `deck_*` 工具。

当前状态：**功能对齐 DSH 版**（P0–P5 完成，文档收口在 P6），逐阶段证据见 `PROGRESS.md`。

## 能做什么

- **任务板**：列出工作区所指仓库的 issue，按「地图票优先、开着优先」排序；看正文与评论，发评论、新建票、整体替换标签；把某张票绑成「当前票」，随时从面板回到它。
- **地图**：`wayfinder:map` 票会多一个「打开地图」入口，一屏给出目标、已定决策、雾（还没定的事）、路线上的票，以及三条可复制的下一步建议。
- **技能**：27 个技能中英双语随包分发，按工作区一键安装到 `.claude/skills` 与 `.agents/skills`；按安装前先列出要写的文件，不自动写入。
- **Agent 工具**：远端在 github.com 的工作区，新建会话时自动挂 7 个 `deck_*` MCP 工具。读工具（列票、读票、读地图、读下一步）预授权，写工具（评论、建票、改标签）每次都要人确认。
- **其他页**：标签配色可读性换算、版本管理（暂存/预演/提交/拉取/推送/差异）、诊断（环境读数 + 操作日志）。
- **双语**：界面跟随 App 语言（中/英），标题与按钮在同一套词表里。

## 安装

```bash
# 本地目录（开发用）
paseo plugin install /绝对路径/paseo-matt-skills-deck

# 注册表 / Git / npm（发布后）
paseo plugin install <owner>/<slug>
paseo plugin install git:owner/repo --ref v0.1.0
paseo plugin install npm:matt-skills-deck

paseo plugin reload matt-skills-deck     # 改完代码热更新
paseo plugin ls                          # 应显示 running
paseo plugin logs matt-skills-deck       # 出问题时看这里
```

前提：Paseo `>=0.13.0 <0.14.0`；GitHub 后端需要 `gh` 已安装并 `gh auth login`。
没有 `gh` 时面板不装死，会直接说明缺什么。

## 开发

```bash
npm install
npm run typecheck    # 客户端与服务端各一份 tsconfig，边界靠类型检查兜住
npm test             # node --test，直接跑 TypeScript（Node 自带类型剥离）
```

改完代码后 `paseo plugin reload matt-skills-deck` 即可；两端 typecheck 与 54 条测试是提交前的门槛。

## 结构

```
paseo-plugin.json    清单：id、要求、媒体
index.client.tsx     注册面：工作区面板、整页界面、侧栏行
index.server.ts      注册 RPC 与生命周期钩子
shared/              两端共用的 RPC 契约（Zod）
client/deck/         插件界面：任务板、地图、技能、标签、版本、诊断、像素皮肤
server/tracker/      票面领域逻辑：远端解析、gh 读写、地图正文、路线与建议
server/rpc/          RPC 处理器（一条 RPC 一个文件）
server/mcp/          给 Agent 的 MCP 服务端（协议层 + 工具表）
server/hooks.ts      before agent.create：按工作区注入 deck 工具
templates/skills/    随包的 27 个技能（中英双语）
```

分层硬规则：`client/` 不 import `node:*`，`server/` 不 import `client/`，跨边界数据一律过 `shared/` 的 Zod 契约。
两套 tsconfig 就是为了让这三条在编译期就报错。

## 与 DSH 版的差异

完整的逐项对照见 [`docs/port-diff.md`](docs/port-diff.md)。最影响使用体感的几条：

- 面板落在**工作区标签页**，不是常驻右栏——Paseo 没有常驻右栏这一面。
- 「一键填入输入框」改为**复制到剪贴板 + 提示**——插件改不了 Agent 的输入框。
- Agent 工具走**独立 MCP 子进程**，只注入 GitHub 工作区；写工具默认要确认。
- 会话自动命名**放弃**：`agent.create` 钩子看不到首条提示词，也没有改名 API，宁可不命名也不猜。
- 后端目前**只接 GitHub**（读写都是）；GitLab 与本地 Markdown 在源仓库有，这里留了闸门但没实现。
- 视觉用 RN 原语重画成像素风牌面：直角、2px 描边、右下硬投影、等宽数字。

## 已知限制

- 本机验证只到「编译 / 单测 / reload / 失败分支」；真实 GitHub 读写与 MCP 注入需要在有 `gh` 登录态的环境里跑一遍。
- 像素风外观没有截图验证：这个环境起不了 Paseo 桌面端窗口。
- 插件 API 处于实验期，`requirements.paseo` 钉在 0.13.x。

## 许可

MIT，见 `LICENSE`；第三方来源见 `NOTICE.md`。
