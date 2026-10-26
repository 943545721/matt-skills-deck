# MattSkillsDeck for Paseo

把 [dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) 移植成 Paseo 插件：
27 个 Matt Pocock 工程技能，加上 GitHub / GitLab / 本地 Markdown 三种后端的工作票面与地图。

当前状态：**P0 骨架**。宿主装配、工作区快照、RPC 通道、标签页状态四条链路已打通并在 daemon 上验证；
票面、技能包与地图分阶段接入，进度见 `PROGRESS.md`。

## 开发

```bash
npm install
npm run typecheck          # 客户端与服务端各自一份 tsconfig，边界靠类型检查兜住
paseo plugin install /绝对路径/paseo-matt-skills-deck
paseo plugin logs matt-skills-deck
```

改完代码后重新 `paseo plugin install` 同一目录即可热更新；`paseo plugin ls` 应显示 `running`。

## 结构

```
index.client.tsx     注册面：工作区面板、整页界面、侧栏行
index.server.ts      注册 RPC 与生命周期钩子
shared/              两端共用的 RPC 契约（Zod）
client/              只在 Paseo 应用内运行，RN 原语 + theme token
server/              只在 daemon 子进程运行，可用 node:child_process 与文件系统
templates/skills/    随包的 27 个技能（中英双语）
```

分层硬规则：`client/` 不 import `node:*`，`server/` 不 import `client/`，跨边界数据一律过 `shared/` 的 Zod 契约。
两套 tsconfig 就是为了让这三条在编译期就报错。

## 与 DSH 版的差异

Paseo 插件没有常驻右侧栏、全局状态栏，也不允许任意 CSS/DOM。因此：

- 面板落在工作区标签页（可与 Agent、终端并排），不做常驻右栏；
- 「一键填入输入框」改为复制到剪贴板 + 提示；
- 视觉用 RN 原语重画，像素风卡片在 P5 阶段补；
- 技能随包分发，由用户在工作区里点「安装」才写入 `.claude/skills` 与 `.agents/skills`。

## 许可

MIT，见 `LICENSE`；第三方来源见 `NOTICE.md`。
