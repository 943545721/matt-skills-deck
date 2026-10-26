# 移植进度账本

源仓库：`/www/wwwroot/game.kxhyapp.com/mattpocock-skills`（DSH 版，分支 `dev`）
计划：`mattpocock-skills/.claude/plans/20261026-paseo-port.md`
目标 daemon：本机，Paseo 0.13.0

| 阶段 | 内容 | 状态 | 验收证据 |
|---|---|---|---|
| P0 | 骨架：manifest、双 tsconfig、工作区面板 + 整页界面 + 侧栏行、`deck.status` RPC | **完成** | `paseo plugin ls` = running；`paseo plugin logs` 无错误；两端 typecheck 通过 |
| P1 | 技能包：27×2 技能入库、技能页、按工作区安装按钮 | 进行中 | — |
| P2 | 只读任务板：`tracker` 领域逻辑迁移、GitHub 后端、列表 + 详情 | 未开始 | — |
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

## 已知硬约束

- Paseo 无常驻右侧栏、无全局状态栏 → 面板落工作区标签页，计数落 composer pill。
- 客户端无任意网络、无 DOM → 图片走服务端 data URL，样式只用 RN + theme token。
- 插件 API 处于实验期 → `requirements.paseo` 钉 `>=0.13.0 <0.14.0`。
- 服务端无沙箱 → 命令白名单只放 `gh` / `glab` / `git`，路径必须落在工作区内。
