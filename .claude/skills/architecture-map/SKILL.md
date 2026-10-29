---
name: architecture-map
description: "给一个项目画能自己打开的架构图纸：九个视图页签、每图带 ASCII 兜底、另附 Mermaid 源码。按规模分档——小项目单页、大项目索引页 + 域页、超算/多仓按需生成；先出 facts.json 再脚本生成，禁止手绘和全量列举。"
---

# 架构图纸

给一个项目产出**能自己打开的架构图纸**。人打开就能看懂：怎么分层、怎么跑、数据怎么流、坏了会怎样。

这套流程是为**超大项目**写的。小项目照着做只是快一点；大项目不照着做，一定会得到一页塞满方框、字体溢出、没人愿意看的 HTML。

## 一、先量规模，再决定画几页

不许凭印象判断「大不大」。先跑一遍统计（文件数、目录数、包数、语言分布）：

```bash
find . -path ./node_modules -prune -o -type f -print | wc -l
find . -path ./node_modules -prune -o -type d -print | wc -l
ls package.json */package.json 2>/dev/null | wc -l      # 多包仓库
wc -l $(git ls-files '*.go' '*.ts' '*.py' 2>/dev/null) | tail -1
```

| 档 | 判据（满足任一） | 产出 | 每图节点上限 | 页数上限 |
|---|---|---|---|---|
| **S** | ≤300 文件 且 单服务 | `docs/architecture.html` 一页 | 30 | 1 |
| **M** | ≤3,000 文件 或 ≤10 个包 | 一页，按需拆 2–3 页 | 30 | 3 |
| **L** | ≤50,000 文件 或 多服务 monorepo | 索引页 + 每个域一页 | 24 | 13 |
| **XL** | >50,000 文件 / 多仓库 / 超算集群 | 索引页 + 域页，**按需增量生成** | 16 | 按需 |

档位与判据数字写进 `facts.json` 和报告第一行。判错了就重判，不要硬套。

**XL 的硬规矩**：索引页只放三样——①域地图 ②部署/调度拓扑 ③一条主链路；其余域各一页，没生成的域在索引里写明「未生成（原因）」。**不许**把 50 个服务塞进一张图。

## 二、事实层：`facts.json` 先行

人手不写事实。先让脚本扫出来，写进 `docs/architecture/facts.json`；画图只读它。

```json
{
  "generatedAt": "2026-10-30T00:00:00Z",
  "root": "/abs/path",
  "tier": "L",
  "scale": { "files": 0, "dirs": 0, "loc": 0, "packages": 0, "languages": { "ts": 0 } },
  "domains": [{
    "id": "orders", "name": "订单域",
    "paths": ["services/orders"], "entry": ["services/orders/src/main.ts"],
    "process": "container", "data": ["orders_db"], "dependsOn": ["auth", "mq"]
  }],
  "entrypoints": [{ "path": "cmd/api/main.go", "kind": "http|cli|worker|job" }],
  "deploy": [{ "file": "docker-compose.yml", "kind": "compose" }],
  "scheduler": [{ "file": "slurm.conf", "kind": "slurm" }],
  "external": [{ "name": "Postgres", "refs": ["deploy/compose.yml:12"] }],
  "claims": [{ "id": "c1", "text": "订单写入经 MQ 异步落库", "refs": ["services/orders/src/outbox.ts:44"] }]
}
```

规则：

- **每条 claim 至少一个 `refs`**，格式 `path:line`，文件必须存在。写不出来就写 `"status":"unconfirmed","missing":"缺 migration 目录"`，不许按常识补。
- 域（domain）按**部署单元 / 进程边界 / 数据归属**切，不按目录顺序切。一个域一套数据，跨域只能通过接口或消息。
- 扫不动的东西（生成代码、`vendor/`、`third_party/`）在 `scale` 里单列并写明排除原因。

## 三、生成，而不是手绘

HTML **必须由脚本从 `facts.json` 渲染**：`docs/architecture/build.mjs`（或 `build.py`），只用标准库，离线可跑。

- 布局函数负责：不重叠、按字数折行、节点高度自适应、按档位裁剪节点数。手写 SVG 在 30 个节点以上必然重叠——不要手写。
- SVG 与 ASCII **同一份数据渲染**，不允许两处各写一遍。
- 每个图节点带 `data-ref="path"`，供自检核对。
- 只允许手写一张：S 档的总览图。其余交给脚本。

## 四、九个视图（每个都要，做不出写原因）

保留页签、写明原因，不要删——空白页签本身就是信息。

| # | 视图 | 画什么 | 大项目怎么收 |
|---|---|---|---|
| 1 | 分层技术树 | 接入/应用/领域/数据，真实组件 + 所在目录 | 只列域级组件，不列每个模块 |
| 2 | 代码目录树 | 两层骨架 + 该目录职责 | 第三层起只给文件数，不列文件 |
| 3 | 运行时进程树 | 谁跑、谁拉起谁 | 按进程角色聚合，不按实例数 |
| 4 | 端到端数据流 | 一条完整请求，标协议与超时 | 选**一条**代表链路，其余列表 |
| 5 | 事件接入与分流 | 外部事件 → 条件 → 处理方 | 只列事件类型，不列每个 handler |
| 6 | 链路时序 | 最重要的一条业务链路 | 一条；失败分支合并成 3 类 |
| 7 | 状态机 | 有真实状态流转的那个实体 | 一个实体；其余列状态表 |
| 8 | 部署拓扑 | 机器/容器/端口/域名/证书/DB | 按环境或角色分组 |
| 9 | 故障降级 | 谁挂影响谁、有无兜底 | 只列有兜底或明确无兜底的边 |

**检测到调度器时（SLURM / PBS / LSF / K8s Job / AWS Batch / MPI）加第十个视图「作业与调度」**：登录/提交节点 → 队列 → 计算节点池 → 并行文件系统 → 结果落点；标配额、时间上限、checkpoint 位置。没检测到就写「未检测到调度配置（查过：`slurm.conf`、`*.sbatch`、`#SBATCH`、`k8s/`、`Dockerfile` 中的调度特征）」。

## 五、折叠（elision）：塞不下要说出来

- 同类 ≤3 个全列；>3 个列前 3 个 + `+N 个同类`，并在 `facts.json` 里保留全量。
- 一张图节点超过档位上限时，**先合并同级**，合并完还超才裁，裁掉的写进「未展开清单」页。
- 折叠必须在两处可见：SVG/HTML 里 `+N`，ASCII 里也 `+N`。**静默丢弃就是造假。**

## 六、HTML 完整性清单（每页逐条核对）

- [ ] `<!doctype html>`、`<meta charset="utf-8">`、`<meta name="viewport">`、`<title>`
- [ ] 非索引页有「← 返回索引」链接，链接目标真实存在
- [ ] 页内目次 + 页签（纯 CSS `:target` 或 radio，**不依赖 JS**）
- [ ] 每张图下面都有「ASCII 版」折叠
- [ ] 「事实来源」表：每条 claim 一行，带 `path:line`
- [ ] 页脚：生成时间、档位与判据数字、facts 指纹、被折叠的条目数
- [ ] 单页 ≤1.5 MB；总页数 ≤档位上限，未生成的页在索引里列名并写原因
- [ ] 断网打开：无 CDN、无外部字体、无远程图片、无 `url(...)`、无 `@import`
- [ ] 深色底、单一强调色、方框与连线 1px 细线，SVG 宽度 100% 自适应（`viewBox` 按内容算，不要写死 900）

## 七、ASCII 规范

- 等宽字体，单行 ≤100 字符，单块 ≤60 行。
- 用 `│ ├ └ ↓ →` 画结构，不用中文方框拼框（中文占两列，对不齐）。
- ASCII 和图描述同一件事；图上 `+N` 的折叠，ASCII 里也要有 `+N`。

## 八、Mermaid 附录

`docs/architecture/architecture.mmd`，每段 `%% === N 视图名 ===`：

- 时序 `sequenceDiagram`，结构 `flowchart LR`，状态 `stateDiagram-v2`，部署 `flowchart TB` + subgraph，作业调度 `flowchart TB`。
- 节点 id 用英文，显示文本可以任意语言。
- 与 HTML 同一份图；改一处改两处。

## 九、自检：写脚本，不靠眼睛

`docs/architecture/check.mjs`，失败退出码非 0：

1. 所有 `href` / `data-ref` 指向的本地路径存在；
2. 全文无 `http://`、`https://`、`src=`、`@import`、`url(`；
3. 每个 `<pre>` 单行 ≤100、行数 ≤60；每图节点数 ≤档位上限；每个页签里都要有图或「未生成原因」，空页签直接判失败；
4. 每页字节 ≤1.5 MB；页数 ≤档位上限；
5. `facts.json` 每条 claim 至少一个 ref，且 ref 文件存在；
6. 输出一张表：页 / 图 / 节点数 / 字节 / 折叠数。

## 十、反模式（出现任意一条就重做）

- 把整棵目录树贴进 HTML
- 一个文件一个方框
- 一张图里塞两个问题
- 手写超过 30 个节点的 SVG
- 用「通常」「一般」这类词补事实
- 把「没查出来」写成「没有」（要写「未确认」+ 缺什么）
- 大项目只出一页，然后说「内容太多所以省略」

## 十一、收尾

报告里给：

1. **档位与判据**：tier + 实际数字；
2. **页清单**：每页一句话，未生成的列名与原因；
3. **九个视图各一句**（外加作业与调度，若检测到）；
4. **折叠了什么**：N 处，指向 `facts.json` 的哪一节；
5. **未确认项**及其缺失证据；
6. **自检脚本输出**（那张表）。

不要把「没做」写成「没有」。不要用一句话概括一个视图——那句话是给报告看的，不是给图纸看的。
