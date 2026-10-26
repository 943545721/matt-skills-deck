# 移植进度账本

源仓库：`/www/wwwroot/game.kxhyapp.com/mattpocock-skills`（DSH 版，分支 `dev`）
计划：`mattpocock-skills/.claude/plans/20261026-paseo-port.md`
目标 daemon：本机，Paseo 0.13.0

| 阶段 | 内容 | 状态 | 验收证据 |
|---|---|---|---|
| P0 | 骨架：manifest、双 tsconfig、工作区面板 + 整页界面 + 侧栏行、`deck.status` RPC | **完成** | `paseo plugin ls` = running；`paseo plugin logs` 无错误；两端 typecheck 通过 |
| P1 | 技能包：27×2 技能入库、技能页、按工作区安装按钮 | **完成** | 27/27 中英齐；安装写入 `.claude/skills` 与 `.agents/skills`；重复安装跳过、内容不同判冲突不覆盖；8 条测试全绿 |
| P2 | 只读任务板：`tracker` 领域逻辑迁移、GitHub 后端、列表 + 详情 | **完成（只读部分）** | 远端解析 6 种写法、映射容错、排序不变性共 6 条测试全绿；插件 reload 后 running；`gh` 缺失路径实测给出可执行提示；本机无 gh 与 GitHub 凭据，联网读取未实测（见下） |
| P3 | 写入与动作：评论、标签配色、绑定与切换、复制提示词 | **完成** | 21 条测试全绿（含 3 条配色归一/拒绝用例）；插件 reload 后 running；写命令未联网实测（本机无 gh） |
| P4 | 周边页：版本管理、环境检查、诊断日志、设置、双语 | **完成**：版本管理 10 条 RPC + 页面、诊断页（环境读数 + 操作日志）、日志缓冲、zh/en 双语全量切换（走 SDK `defineTranslations` + `useTranslation`，语言跟随 App；键/占位符一致性由 3 条测试兜底） | 31 条测试全绿；两端 typecheck 通过；插件 reload 后 running 且日志无错；版本管理在临时仓库实测：暂存→预检→提交成功、同票重放被拒、提交后工作区干净；无暂存/无远端/非法路径三条拦截均给出人话；`en` 表被标成 `Record<MessageKey, string>`，少一条键编译不过 |
| P5 | 地图详情、工作路线、deck 工具 MCP 注入、像素风 | **完成**：地图页（五区块 + 工作路线 + 下一步建议，`deck.map` 一条 RPC 一次读完）；7 个 `deck_*` MCP 工具 + 协议层 + `before agent.create` 自动挂载；像素风牌面（直角 + 2px 描边 + 右下 3px 硬投影 + 等宽数字）铺满任务板 / 地图 / 票详情 / 标签栏，其余表单页用同款直角与描边的扁平变体 | 54 条测试全绿（新增 9 条地图、8 条 MCP 协议/注入用例）；地图正文解析照抄源仓库口径，含「标题粘行」「加粗决策」「字面 \\n 还原」；stdio 冒烟实测：`initialize` 回显 2025-06-18、`tools/list` 出 7 个工具、`tools/call` 走通失败分支、缺 `--workspace`/目录不存在均以退出码 2 报人话；两端 typecheck 通过，reload 后 running、日志无错 |
| P6 | 移动端适配、注册表发布、文档收口 | 未开始 | — |

## 已定决策

| 编号 | 决策 |
|---|---|
| D1 | 「填入输入框」改为复制到剪贴板 + 提示 |
| D2 | 先常规卡片，P5 再重画像素风 |
| D3 | 技能随包 + 一键安装按钮，不自动写入 |
| D4 | ~~会话命名降级为规则截取~~ → **0.13 上不可实现，放弃**：`agent.create` 钩子只看得到 `config` 与 `env`（看不到首条提示词），`PaseoAgentHandle` 也没有改名 API。宁可不命名，也不注入一个猜出来的假标题 |
| D5 | 不单独做「设置页」：界面语言跟随 App 语言（SDK `useTranslation`），不做插件自带的语言开关；技能包语言是独立开关，默认跟随 App |

## 验证缺口

- 本机没有 `gh`，也没有 GitHub 凭据 → GitHub 读路径只验到「参数与失败分支」，真实列表/详情未联网实测。
  映射、排序、远端解析全部由单元测试覆盖；联网验证需在有 gh 且有登录态的环境跑一次 `deck.issues.list`。
- MCP 侧同理：协议层与工具入参校验有测试，stdio 冒烟跑通了 `initialize` / `tools/list` / 失败分支，
  但「工具真的读到票」与「钩子真的把服务注入进会话」都还没在联网 + 有远端的环境里验过。
  本仓库工作区没有 git 远端，钩子按设计跳过注入，所以这里只验到了「不注入也不报错」。
- 像素风是纯 RN 样式改造（无图片、无 gif），编译与 reload 都过，但外观**没有截图验证**：
  这个环境里起不了 Paseo 桌面端窗口。布局按「外层 padding 露出右下投影」的固定写法实现，
  不依赖负边距，改动集中在 `client/deck/pixel.tsx` 一处，真机觉得不好看时改那一个文件即可。
- P2 没有整份搬运源仓库 `src/tracker`（147 文件 / 2.9 万行）。只迁移了与读路径相关的语义：
  远端解析、票面映射、排序口径、地图标签 `wayfinder:map`。其余（本地 Markdown 后端、绑定与切换、
  三后端抽象）在 P3/P4 按需搬运，避免先造抽象再用它。

## 已知硬约束

- Paseo 无常驻右侧栏、无全局状态栏 → 面板落工作区标签页，计数落 composer pill。
- 客户端无任意网络、无 DOM → 图片走服务端 data URL，样式只用 RN + theme token。
- 插件 API 处于实验期 → `requirements.paseo` 钉 `>=0.13.0 <0.14.0`。
- 服务端无沙箱 → 命令白名单只放 `gh` / `glab` / `git`，路径必须落在工作区内。
- RPC 方法名只能是小写：校验正则是 `^[a-z][a-z0-9._-]*$`，写成 `deck.issues.setLabels` 会让整个插件
  加载失败（报 `Invalid plugin RPC method`，且 `plugin reload` 也一起失败）。所以改成 `deck.issues.labels.replace`。
- 服务端相对导入一律写 `.ts` 扩展名：测试直接用 `node --test` 跑 TypeScript（Node 自带类型剥离），
  不带扩展名会在测试阶段报 `ERR_MODULE_NOT_FOUND`，而 tsc 不报。`allowImportingTsExtensions` 已开。
- 插件运行时的自身目录只能从 `$PASEO_HOME/config.json` 读（实测 `import.meta` 为空、cwd 为 `/`）。
- 给 Agent 挂工具只能走 `before agent.create`：钩子入参被 `.strict()` 重新校验，只能回 `config` 与 `env`，
  **改 `config.cwd` 会被拒**。`mcpServers` 服务名 `paseo` 是保留名；`toolPolicy.preapproved` 里的
  `{kind:"mcp",server,tool}` 会被映射成 Claude 的 `allowedTools: ["mcp__<server>__<tool>"]`（自动放行），
  因此名单里的工具必须真的存在，写错名字不会报错、只会静默变成每次都要确认。
- 注入的 MCP 进程用 `process.execPath` 直接跑 `server/mcp/main.ts`：Node 22.18+ 默认剥离类型，
  不必另找解释器、也不必预先编译出 `.js`。
