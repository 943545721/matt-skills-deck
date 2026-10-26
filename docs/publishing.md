# 发布到 Paseo 注册表

本文只写**已经在本机 Paseo 0.13 CLI / `@getpaseo/protocol` 源码里核对过**的条款，以及本仓库现在离发布还差什么。
没有核对到的部分（人工审核流程、提交入口表单）如实标成未知，不猜。

## 客户端怎么找到插件

`paseo plugin install <source>` 收三种来源（`@getpaseo/cli` 的 `plugin install` 帮助原文）：

| 来源 | 写法 | 说明 |
|---|---|---|
| 注册表 | `<owner>/<slug>` 或 `<host>/<owner>/<slug>` | 默认注册表是 `https://plugins.paseo.sh`；带 host 时走自建注册表 |
| 本地目录 | 绝对路径 | 开发时用这个 |
| Git | `git:owner/repo`、仓库 URL、`--ref <分支/tag/commit>` | 发行版推荐钉 tag |
| npm | `npm:<包名>` | 走 npm 包，不依赖 Git 可达 |

注册表 ID 的形状是硬约束：`^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$`。
本插件 id 是 `matt-skills-deck`，所以发布时形如 `<你的账号>/matt-skills-deck`。

## 仓库必须带的文件

`paseo plugin init` 生成的模板里写明：**`OVERVIEW.md` 是进注册表的必需文件**，必须与 `paseo-plugin.json`
一起出现在被钉住的那个 commit 里，也应随 npm 包一起发。非英语读者看 `OVERVIEW.<语言>.md`
（这里已有 `OVERVIEW.zh-CN.md`）。

`OVERVIEW.md` 的写法约束（来自同一份模板注释）：先说清插件是什么、做什么；只在不容易理解时解释怎么实现；
需要时说明设置前提（账号、token、所需 daemon 版本与系统要求）；不写安装命令、徽章、变更日志、许可证段落与营销话术。

本仓库现状：`paseo-plugin.json`、`OVERVIEW.md`、`OVERVIEW.zh-CN.md`、`LICENSE`、`NOTICE.md`、`README.md` 齐备，
且 `package.json` 的 `files` 把 `paseo-plugin.json`、`index.*`、`client/`、`server/`、`shared/`、`templates/`、
`OVERVIEW*.md`、`LICENSE`、`NOTICE.md` 都带上了（新增的 `docs/` 也在里面）。

## 注册表条目要求的字段

`PluginRegistryIndexSchema`（`@getpaseo/protocol`）里每条插件的产物只有两种，二选一：

- `npm`：`package`、`version`（严格 `x.y.z`，可带预发布后缀）、`resolved`（URL）、`integrity`（`sha512-…`）；
- `git`：`remote`、`commit`（**40–64 位**完整 sha）、可选 `pluginPath`（仓库里插件所在的子目录）。

其余必填：`id`、`name`、`description`、`categories`、`author.github`、`repository.url`、`media`（URL 数组）、
三个时间戳。可选：`translations`（按语言给 `name` / `description`）、`license`、`icon`、`installs`。

## 本仓库的发布状态

已经就绪：

- 清单 `paseo-plugin.json`（id、`requirements.paseo: >=0.13.0 <0.14.0`）；
- 双语 overview、README、LICENSE / NOTICE；
- 可用的 `npm run typecheck` 与 `npm test`（提交前门槛）。

还差的，需要人到场处理：

1. **仓库要有公开远端**：现在这个目录没有配置 git remote，注册表的 git 产物需要 `remote` + 完整 commit sha。
2. **`media` 是空的**：注册表条目要求一串图片/视频 URL，本环境起不了 Paseo 桌面端窗口，截不了图。
   等能截图时，录一段「任务板 → 地图 → 下一步」的 gif 或 mp4 最省事。
3. **提交入口未核对**：CLI 里没有 `publish` 子命令，注册表条目的审核与提交是平台侧流程，
   本机没能核实具体入口（默认注册表 `https://plugins.paseo.sh` 在受限网络下打不开）。发布前应到该站点确认当前提交方式。
4. **版本号**：`package.json` 仍是 `0.1.0`、`paseo-plugin.json` 没有版本字段（版本随包走），
   首次对外发布前定版本并打 tag，`--ref vX.Y.Z` 才有意义。
