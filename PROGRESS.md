# 移植进度账本

源仓库：`/www/wwwroot/game.kxhyapp.com/mattpocock-skills`（DSH 版，分支 `dev`）
计划：`mattpocock-skills/.claude/plans/20261026-paseo-port.md`
目标 daemon：本机，Paseo 0.13.0

| 阶段 | 内容 | 状态 | 验收证据 |
|---|---|---|---|
| P0 | 骨架：manifest、双 tsconfig、工作区面板 + 整页界面 + 侧栏行、`deck.status` RPC | **完成** | `paseo plugin ls` = running；`paseo plugin logs` 无错误；两端 typecheck 通过 |
| P1 | 技能包：27×2 技能入库、技能页、按工作区安装按钮 | **完成** | 27/27 中英齐；安装写入 `.claude/skills` 与 `.agents/skills`；重复安装跳过、内容不同判冲突不覆盖；8 条测试全绿 |
| P2 | 只读任务板：`tracker` 领域逻辑迁移、GitHub 后端、列表 + 详情 | **完成（只读部分）** | 远端解析 6 种写法、映射容错、排序不变性共 6 条测试全绿；插件 reload 后 running；`gh` 缺失路径实测给出可执行提示；本机无 gh 与 GitHub 凭据，联网读取未实测（见下） |
| P3 | 写入与动作：评论、标签配色、绑定与切换、复制提示词 | 未开始 | — |
| P4 | 周边页：版本管理、环境检查、诊断日志、设置、双语 | 未开始 | — |
| P5 | 地图详情、工作路线、deck 工具 MCP 注入、像素风 | 未开始 | — |
| P6 | 移动端适配、注册表发布、文档收口 | 未开始 | — |

## 已定决策

| 编号 | 决策 |
|---|---|
| D1 | 「填入输入框」改为复制到剪贴板 + 提示 |
| D2 | 先常规卡片，P5 再重画像素风 |
| D3 | 技能随包 + 一键安装按钮，不自动写入 |
| D4 | 会话命名降级为规则截取，不调模型 |

## 验证缺口

- 本机没有 `gh`，也没有 GitHub 凭据 → GitHub 读路径只验到「参数与失败分支」，真实列表/详情未联网实测。
  映射、排序、远端解析全部由单元测试覆盖；联网验证需在有 gh 且有登录态的环境跑一次 `deck.issues.list`。
- P2 没有整份搬运源仓库 `src/tracker`（147 文件 / 2.9 万行）。只迁移了与读路径相关的语义：
  远端解析、票面映射、排序口径、地图标签 `wayfinder:map`。其余（本地 Markdown 后端、绑定与切换、
  三后端抽象）在 P3/P4 按需搬运，避免先造抽象再用它。

## 已知硬约束

- Paseo 无常驻右侧栏、无全局状态栏 → 面板落工作区标签页，计数落 composer pill。
- 客户端无任意网络、无 DOM → 图片走服务端 data URL，样式只用 RN + theme token。
- 插件 API 处于实验期 → `requirements.paseo` 钉 `>=0.13.0 <0.14.0`。
- 服务端无沙箱 → 命令白名单只放 `gh` / `glab` / `git`，路径必须落在工作区内。
- 服务端相对导入一律写 `.ts` 扩展名：测试直接用 `node --test` 跑 TypeScript（Node 自带类型剥离），
  不带扩展名会在测试阶段报 `ERR_MODULE_NOT_FOUND`，而 tsc 不报。`allowImportingTsExtensions` 已开。
- 插件运行时的自身目录只能从 `$PASEO_HOME/config.json` 读（实测 `import.meta` 为空、cwd 为 `/`）。
