---
name: project-survey
description: 扫一遍工作区里每个项目的真实结构，产出模块（area）与角色（role）候选，每条都带依据路径；重跑只报差异，不自动改配置或建标签。
---

一个工作区里可能有好几个项目，每个项目的结构都不一样，而且一直在变。所以「这个项目有哪些模块」不能靠一张固定清单，只能当场读出来。这个技能做的就是读一遍、给出候选与依据，**由人确认之后**才进 `.paseo-deck.json`。

## 不做什么

- 不写 `.paseo-deck.json`，不建标签，不改任何配置文件；
- 不删已有的 area，也不改已有标签；发现旧项不在了，只标「可能已废弃」；
- 不猜：读不出来就写「未确认」并说明缺什么文件。一条编出来的模块键，比少一个模块有害得多。

## 第一步：找出哪些是项目

按顺序看，看到一个就停：

1. `.paseo-deck.json` 的 `projects[]`——已经配过就按它列，缺的补进候选；
2. 直接子目录里带 `.git` 的目录——容器工作区的常见形态；
3. `pnpm-workspace.yaml` / `package.json` 的 `workspaces` / `composer.json` 的 `path` 字段——单仓库里的多包结构；
4. 以上都没有，就是单项目，根目录本身即项目。

## 第二步：逐个项目读结构

每个项目都读这些（存在才读，不存在就跳过并记下来）：

| 看什么 | 文件 | 想得到什么 |
|---|---|---|
| 依赖与脚本 | `package.json`（含 `dependencies`、`scripts`、`workspaces`） | 前端还是服务端、有哪些可跑的入口、包之间的引用关系 |
| 后端工程 | `pom.xml`、`build.gradle*`、`go.mod`、`composer.json`、`pyproject.toml`、`Cargo.toml` | 语言与服务边界、模块目录的根在哪 |
| 单仓多包 | `pnpm-workspace.yaml`、`turbo.json`、`nx.json`、`lerna.json` | 有哪些包、各自的目录 |
| 目录树 | 两层 `ls`（不看 `node_modules`、`dist`、`build`） | 顶层目录的职责 |
| 部署与运维 | `Dockerfile`、`docker-compose*.yml`、`nginx*.conf`、`deploy/`、`k8s/`、`pm2*.json` | 有哪些可部署单元 |
| CI | `.github/workflows/*.yml`、`.gitlab-ci.yml` | 实际被跑起来的包与命令（比 README 可信） |
| 小程序 | `app.json`、`project.config.json`、`pages/` | 微信小程序端 |

## 第三步：产出候选

**模块（area）**：一个能被独立指认的功能或包。典型来源是 workspace 里被引用的包目录、后端的分层目录、前端的主路由目录。键用小写字母数字连字符，短、稳定、不会因为改代码就变。一个项目通常三到八个，超过十个多半是把文件名当成了模块。

**角色（role）**：项目整体属于哪一层，只能取这五个之一，拿不准就留空并在报告里写「未确认」：

| 角色 | 判据 |
|---|---|
| `backend` | 有服务端框架依赖、有 `src/main` 或路由注册、跑起来监听端口 |
| `frontend` | 有构建工具与页面入口（`index.html` / 路由表 / 组件树），产物是静态资源 |
| `miniapp` | 有 `app.json` / `project.config.json`，或依赖微信小程序 SDK |
| `license` | 授权、计费、卡密、订单对账这类独立服务或模块 |
| `ops` | 部署脚本、镜像、CI 模板、运维工具，不被业务代码引用 |

## 报告格式（直接给人看）

```
项目 <key>（<目录>）
  角色：<role>（依据：<路径>）
  模块候选：
  - api           后端接口层     依据：src/api/index.ts:12、src/controller/
  - admin-web     管理端页面     依据：apps/admin-web/vite.config.ts:1
  - 未确认项      —              缺：pnpm-workspace.yaml 未找到
```

每条候选后面必须能指到具体文件（`路径:行号` 优先，目录也行）。指不到的候选不要写进清单，写进「未确认」。

## 第四步：与上次比对

上一次的结果存在 `.deck/survey/<项目>.json`（不存在就是第一次跑）。重跑时按项目键比对：

- 新出现的候选 → 标「新增」；
- 上次有、这次读不到了 → 标「可能已废弃」，**不删**；
- 键变了但依据路径相近 → 标「改名嫌疑」，两个都列出来让人选；
- 其余不重复列。

比对完把这次的结果覆盖写进 `.deck/survey/<项目>.json`，报告里给出这个路径。

## 第五步：交出确认清单

最后不要自己动手，把这件事说清楚交给用户：

> 上面这些确认之后，我把 `areas` 和 `owner` 写进 `.paseo-deck.json` 的对应项目；要改的话告诉我改哪几个。

用户确认后才写配置；用户说「先这样」，就只保留报告。
