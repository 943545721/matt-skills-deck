import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
import { findTool } from "../server/mcp/tools.ts";
import { initializeLocalScratch, replaceLocalLabels } from "../server/tracker/local.ts";
import { EDGE_LANDING } from "../shared/edge-rules.ts";

/**
 * 这些用例真起 `gh` 子进程（假命令），走的是工具入口 → 领域代码 → 命令参数这一整条路。
 * 只测纯函数抓不到「工具忘了传某个字段」「参数顺序变了」这类错误，而那正是 Agent 会踩的坑。
 */

const sandboxes = [];
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

function sandbox(prefix = "deck-tool-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function workspace(withRemote = true) {
  const dir = sandbox("deck-tool-ws-");
  assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
  if (withRemote) {
    assert.equal(
      spawnSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/deck.git"]).status,
      0,
    );
  }
  return dir;
}

/** 假 gh：把参数交给一段 Node 脚本，脚本决定这次回什么。 */
function toolGh(handlerSource) {
  const dir = sandbox("deck-tool-bin-");
  const script = path.join(dir, "handler.mjs");
  writeFileSync(script, handlerSource, "utf8");
  const gh = fakeGh(`exec "${process.execPath}" "${script}" "$@"`);
  return {
    calls: gh.calls,
    restore: () => {
      gh.restore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const run = (name, args, workspaceDir) => findTool(name).run(args, { workspaceDir });

const json = (result) => {
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
};

function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

const node = (number, extra = {}) => ({
  number,
  title: `ticket ${number}`,
  state: "OPEN",
  url: `https://github.com/acme/deck/issues/${number}`,
  updatedAt: "2026-10-01T00:00:00Z",
  createdAt: "2026-09-01T00:00:00Z",
  labels: { totalCount: 0, nodes: [] },
  assignees: { nodes: [] },
  blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
  ...extra,
});

const pull = (number, state, merged) => ({
  ...node(number, { state }),
  mergedAt: merged ? "2026-10-02T00:00:00Z" : null,
  isDraft: false,
});

/* ------------------------------------------------------------------ 列表 */

const LIST_HANDLER = `
const args = process.argv.slice(2);
const all = args.join(" ");
if (args[0] === "--version") { console.log("gh version 2.60.0"); process.exit(0); }
if (all.includes("graphql")) {
  const issues = ${JSON.stringify([node(1)])};
  const pullRequests = ${JSON.stringify([pull(10, "OPEN", false), pull(11, "CLOSED", true), pull(12, "CLOSED", false)])};
  console.log(JSON.stringify({ data: { repository: {
    issues: { totalCount: issues.length, pageInfo: { hasNextPage: false }, nodes: issues },
    pullRequests: { totalCount: pullRequests.length, pageInfo: { hasNextPage: false }, nodes: pullRequests },
    rateLimit: { limit: 5000, remaining: 4999, resetAt: "2026-10-01T00:00:00Z" },
  } } }));
  process.exit(0);
}
console.error("unexpected gh call: " + all);
process.exit(1);
`;

test("拉取请求列表：按 open / merged / closed / all 各自筛选，不把 issue 混进来", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const gh = toolGh(LIST_HANDLER);
  try {
    const open = json(await run("deck_pull_requests_list", {}, ws));
    assert.deepEqual(open.pullRequests.map((item) => item.number), [10]);

    const merged = json(await run("deck_pull_requests_list", { state: "merged" }, ws));
    assert.deepEqual(merged.pullRequests.map((item) => item.number), [11]);
    assert.equal(merged.pullRequests[0].merged, true);

    const closed = json(await run("deck_pull_requests_list", { state: "closed" }, ws));
    assert.deepEqual(closed.pullRequests.map((item) => item.number), [12]);

    const all = json(await run("deck_pull_requests_list", { state: "all" }, ws));
    assert.deepEqual(all.pullRequests.map((item) => item.number).sort((a, b) => a - b), [10, 11, 12]);
    assert.equal(all.repo, "acme/deck");
  } finally {
    gh.restore();
  }
});

/* ------------------------------------------------------------------ 改票 */

const PATCH_HANDLER = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const all = args.join(" ");
appendFileSync(process.env.DECK_ARGS_FILE, JSON.stringify(args) + "\\n");
if (all.includes("--method PATCH")) {
  console.log(JSON.stringify({ title: "新的标题", body: "旧正文", state: "open" }));
  process.exit(0);
}
console.error("unexpected gh call: " + all);
process.exit(1);
`;

test("改票：只发用户给出的字段，并回读服务端结果", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const argsFile = path.join(sandbox("deck-tool-args-"), "args.log");
  writeFileSync(argsFile, "", "utf8");
  const gh = toolGh(PATCH_HANDLER);
  try {
    await withEnv({ DECK_ARGS_FILE: argsFile }, async () => {
      const result = json(await run("deck_issue_patch", { number: 7, title: "新的标题" }, ws));
      assert.equal(result.ok, true);
      assert.equal(result.title, "新的标题");
      assert.equal(result.state, "OPEN");
    });
    const sent = readFileSync(argsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const last = sent.at(-1);
    assert.ok(last.includes("title=新的标题"));
    // 没给的字段一个都不能出现在命令里：出现就等于把读到的旧值写回去。
    assert.ok(!last.some((arg) => arg.startsWith("body=")), `不该发送 body，实际参数：${last.join(" ")}`);
    assert.ok(!last.some((arg) => arg.startsWith("state=")), `不该发送 state，实际参数：${last.join(" ")}`);
  } finally {
    gh.restore();
  }
});

test("改票：一个字段都不给就在本地拒绝，不发命令", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const gh = toolGh(PATCH_HANDLER);
  try {
    const result = await run("deck_issue_patch", { number: 7 }, ws);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.text).reason, "invalid");
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});

/* ---------------------------------------------------------------- 报缺陷 */

const CREATE_HANDLER = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const all = args.join(" ");
appendFileSync(process.env.DECK_ARGS_FILE, JSON.stringify(args) + "\\n");
// 建票前先按幂等锚查重（DSH 行为）：假 gh 必须如实回答「没有命中」，否则工具会把查不到当成写失败。
if (args[0] === "search" && args[1] === "issues") {
  console.log("[]");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}
// 标签写路径是「读现状 → 发差集 → 读回核对」：假 gh 要记住这轮改过什么。
const stateFile = process.env.DECK_ARGS_FILE + ".labels";
const labelsNow = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : [];
if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 42,
    title: "面板计数不对",
    body: "",
    state: "OPEN",
    url: "https://github.com/acme/deck/issues/42",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    labels: labelsNow().map((name) => ({ name, color: "cccccc" })),
    assignees: [],
  }));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "edit") {
  let labels = labelsNow();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--add-label" && args[i + 1]) labels.push(args[i + 1]);
    if (args[i] === "--remove-label" && args[i + 1]) labels = labels.filter((name) => name !== args[i + 1]);
  }
  writeFileSync(stateFile, JSON.stringify([...new Set(labels)]));
  console.log("{}");
  process.exit(0);
}
if (args[1] === "repos/acme/deck/issues") {
  console.log(JSON.stringify({ number: 42, html_url: "https://github.com/acme/deck/issues/42" }));
  process.exit(0);
}
if (args[1] && args[1].endsWith("/labels")) {
  const names = args.filter((arg) => arg.startsWith("labels[]=")).map((arg) => arg.slice("labels[]=".length));
  console.log(JSON.stringify(names.map((name) => ({ name, color: "cccccc" }))));
  process.exit(0);
}
console.error("unexpected gh call: " + all);
process.exit(1);
`;

test("建缺陷票：kind=bug 自动带 bug 标签，正文原样提交", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const argsFile = path.join(sandbox("deck-tool-args-"), "args.log");
  writeFileSync(argsFile, "", "utf8");
  const gh = toolGh(CREATE_HANDLER);
  try {
    await withEnv({ DECK_ARGS_FILE: argsFile }, async () => {
      const result = json(
        await run(
          "deck_issue_create",
          {
            title: "面板计数不对",
            body: "## What happened\n\n关掉一张票后 ready 仍是 3\n\n## Expected\n\nready 变成 2\n\n## Steps to reproduce\n\n1. 打开面板\n2. 关掉一张 ready 票",
            kind: "bug",
          },
          ws,
        ),
      );
      assert.equal(result.number, 42);
      assert.equal(result.kind, "bug");
      // DSH 位置表：缺陷票固定补 bug + needs-triage 两枚。
      assert.deepEqual(result.labels, ["bug", "needs-triage"]);
    });
    const sent = readFileSync(argsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const body = sent.flat().find((arg) => arg.startsWith("body=")) ?? "";
    assert.match(body, /## What happened/);
    assert.match(body, /## Expected/);
    assert.match(body, /## Steps to reproduce/);
    assert.match(body, /1\. 打开面板/);
    assert.match(body, /2\. 关掉一张 ready 票/);
  } finally {
    gh.restore();
  }
});

/* -------------------------------------------------------- 补边（父子 / 阻塞） */

const NO_GH = 'process.stdout.write("{}\\n")';

const readDeck = (ws, number) => readFileSync(path.join(ws, ".deck", "issues", `${number}.md`), "utf8");

const scratchFile = (ws, unit, number) => {
  const dir = path.join(ws, ".scratch", unit, "issues");
  const name = readdirSync(dir).find((entry) => entry.startsWith(`${String(number).padStart(2, "0")}-`));
  assert.ok(name, `应当在 ${dir} 里找到第 ${number} 张票`);
  return readFileSync(path.join(dir, name), "utf8");
};

test("补边（本地 .deck）：父子写 parentKey、阻塞写 blockedBy，写后读回并标出落点", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh(NO_GH);
  try {
    for (const title of ["父票", "子票", "被阻塞票"]) json(await run("deck_issue_create", { title }, ws));

    const parent = json(await run("deck_map_link", { key: 2, parentKey: 1 }, ws));
    assert.equal(parent.status, "ok");
    assert.equal(parent.items.length, 1);
    assert.equal(parent.items[0].op, "parent");
    assert.equal(parent.items[0].landing, EDGE_LANDING.FILE_NOTE);
    assert.match(parent.items[0].evidence, /parentKey/);
    assert.match(readDeck(ws, 2), /parentKey: 1/);

    const blocked = json(await run("deck_map_link", { key: 3, blockedBy: [2] }, ws));
    assert.equal(blocked.status, "ok");
    assert.equal(blocked.items[0].op, "block");
    assert.equal(blocked.items[0].landing, EDGE_LANDING.FILE_NOTE);
    assert.match(blocked.items[0].evidence, /blockedBy/);
    assert.match(readDeck(ws, 3), /blockedBy: \[2\]/);
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});

test("补边：同一张票的阻塞边先合并成完整集合再写一次；blockedBy 是整组替换", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh(NO_GH);
  try {
    for (const title of ["甲", "乙", "丙", "丁"]) json(await run("deck_issue_create", { title }, ws));

    const merged = json(
      await run("deck_map_link", { edges: [{ key: 4, blockedBy: [2] }, { key: 4, blockedBy: [3] }] }, ws),
    );
    assert.equal(merged.status, "ok");
    assert.deepEqual(merged.items.map((item) => item.target), ["2", "3"]);
    assert.match(readDeck(ws, 4), /blockedBy: \[2,3\]/);

    const replaced = json(await run("deck_map_link", { key: 4, blockedBy: [2] }, ws));
    assert.equal(replaced.status, "ok");
    assert.match(readDeck(ws, 4), /blockedBy: \[2\]/);
  } finally {
    gh.restore();
  }
});

test("补边：自阻塞与同批成环都在写前被拒，父子边不受影响", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh(NO_GH);
  try {
    for (const title of ["根", "甲", "乙"]) json(await run("deck_issue_create", { title }, ws));

    const self = await run("deck_map_link", { key: 3, blockedBy: [3] }, ws);
    assert.equal(self.isError, true);
    const selfPayload = JSON.parse(self.text);
    assert.equal(selfPayload.status, "unsupported");
    assert.equal(selfPayload.items[0].landing, EDGE_LANDING.READ_BACK_MISSING);
    assert.match(selfPayload.items[0].evidence, /不能阻塞自己/);
    assert.match(readDeck(ws, 3), /blockedBy: \[\]/);

    json(await run("deck_map_link", { key: 3, blockedBy: [2] }, ws));
    const cycle = await run("deck_map_link", { edges: [{ key: 2, parentKey: 1, blockedBy: [3] }] }, ws);
    const cyclePayload = JSON.parse(cycle.text);
    assert.equal(cyclePayload.status, "partial");
    const parentItem = cyclePayload.items.find((item) => item.op === "parent");
    const blockItem = cyclePayload.items.find((item) => item.op === "block");
    assert.equal(parentItem.ok, true, "阻塞边被拒不应拖累同一条作业里的父子边");
    assert.equal(blockItem.ok, false);
    assert.match(blockItem.evidence, /成环/);
    assert.match(readDeck(ws, 2), /parentKey: 1/);
    assert.match(readDeck(ws, 2), /blockedBy: \[\]/);
  } finally {
    gh.restore();
  }
});

test("补边（本地 .scratch）：父票写 DSH-PARENT，阻塞写 Blocked by 行", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh(NO_GH);
  try {
    const init = await initializeLocalScratch(ws, { name: "backlog" });
    assert.equal(init.ok, true, init.detail);
    json(await run("deck_issue_create", { title: "父票" }, ws));
    json(await run("deck_issue_create", { title: "子票" }, ws));

    const parent = json(await run("deck_map_link", { key: 2, parentKey: 1 }, ws));
    assert.equal(parent.items[0].landing, EDGE_LANDING.FILE_NOTE);
    assert.match(parent.items[0].evidence, /DSH-PARENT/);
    assert.match(scratchFile(ws, "backlog", 2), /<!-- DSH-PARENT: 1 -->/);

    const blocked = json(await run("deck_map_link", { key: 2, blockedBy: [1] }, ws));
    assert.equal(blocked.items[0].landing, EDGE_LANDING.BODY_LINE);
    assert.match(blocked.items[0].evidence, /Blocked by/);
    assert.match(scratchFile(ws, "backlog", 2), /\*\*Blocked by:\*\* #01/);
  } finally {
    gh.restore();
  }
});

test("补边：blockedBy 里混进非票号时整组不写，已有的阻塞边不会被清空", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh(NO_GH);
  try {
    for (const title of ["甲", "乙", "丙"]) json(await run("deck_issue_create", { title }, ws));
    json(await run("deck_map_link", { key: 3, blockedBy: [2] }, ws));

    const invalid = await run("deck_map_link", { key: 3, blockedBy: [2, "abc"] }, ws);
    assert.equal(invalid.isError, true);
    const payload = JSON.parse(invalid.text);
    assert.equal(payload.items[0].ok, false);
    assert.match(payload.items[0].evidence, /不是票号/);
    assert.match(readDeck(ws, 3), /blockedBy: \[2\]/, "不能把过滤后的空表当成 blockedBy:[] 写进去");
  } finally {
    gh.restore();
  }
});

test("地图快照：子票按父子边取，已关闭的也计入进度，frontierOnly 只留可接的", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh(NO_GH);
  try {
    const map = json(await run("deck_issue_create", { title: "地图", labels: ["wayfinder:map"] }, ws));
    assert.equal(map.number, 1);
    for (const title of ["子票甲", "子票乙", "游离票"]) json(await run("deck_issue_create", { title }, ws));
    json(await run("deck_map_link", { key: 2, parentKey: 1 }, ws));
    json(await run("deck_map_link", { key: 3, parentKey: 1 }, ws));
    json(await run("deck_issue_patch", { number: 3, state: "closed" }, ws));

    const snapshot = json(await run("deck_map_snapshot", { key: 1 }, ws));
    assert.deepEqual(snapshot.children.map((item) => item.number).sort((a, b) => a - b), [2, 3]);
    assert.equal(snapshot.childrenSource, "parent");
    assert.deepEqual(snapshot.progress, { total: 2, closed: 1, open: 1 });
    assert.deepEqual(snapshot.notes, []);

    const frontier = json(await run("deck_map_snapshot", { key: 1, frontierOnly: true }, ws));
    assert.deepEqual(frontier.children.map((item) => item.number), [2]);
    assert.match(frontier.notes.join("\n"), /frontierOnly/);
  } finally {
    gh.restore();
  }
});

/* -------------------------------------------------------------- 新建地图 */

const PLAN_HANDLER = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const all = args.join(" ");
appendFileSync(process.env.DECK_ARGS_FILE, JSON.stringify(args) + "\\n");
// 与建票同一条 DSH 幂等路径：先按锚查重，查不到才建。
if (args[0] === "search" && args[1] === "issues") {
  console.log("[]");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}
if (args[1] === "repos/acme/deck/issues") {
  const title = args.find((arg) => arg.startsWith("title=")) ?? "";
  if (title.includes("坏票")) {
    console.error("error connecting to api.github.com");
    process.exit(1);
  }
  const current = Number(readFileSync(process.env.DECK_NEXT_FILE, "utf8").trim() || "0");
  const next = current + 1;
  writeFileSync(process.env.DECK_NEXT_FILE, String(next));
  console.log(JSON.stringify({ number: next, html_url: "https://github.com/acme/deck/issues/" + next }));
  process.exit(0);
}
if (args[1] && args[1].endsWith("/labels")) {
  const names = args.filter((arg) => arg.startsWith("labels[]=")).map((arg) => arg.slice("labels[]=".length));
  console.log(JSON.stringify(names.map((name) => ({ name, color: "cccccc" }))));
  process.exit(0);
}
console.error("unexpected gh call: " + all);
process.exit(1);
`;

test("新建地图：先建地图再逐张建票，单张票失败如实回报且不回滚已建的部分", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const argsFile = path.join(sandbox("deck-tool-args-"), "args.log");
  const nextFile = path.join(sandbox("deck-tool-next-"), "next");
  writeFileSync(argsFile, "", "utf8");
  writeFileSync(nextFile, "0", "utf8");
  const gh = toolGh(PLAN_HANDLER);
  try {
    await withEnv({ DECK_ARGS_FILE: argsFile, DECK_NEXT_FILE: nextFile }, async () => {
      const result = json(
        await run(
          "deck_map_plan_create",
          {
            title: "把面板做稳",
            destination: "面板在真实仓库上不长草",
            fog: ["弱网下的刷新频率"],
            tickets: [
              { title: "查限流回退", kind: "research" },
              { title: "坏票：模拟建票失败", kind: "task" },
              { title: "补读回验证", kind: "task" },
            ],
          },
          ws,
        ),
      );
      assert.equal(result.map.number, 1);
      assert.equal(result.tickets.length, 3);
      assert.equal(result.tickets[0].number, 2);
      assert.ok(result.tickets[1].error, "第二张票应当带失败原因");
      assert.equal(result.tickets[1].number, undefined);
      // 单张失败不阻断后面的票：第三张照样建出来。
      assert.equal(result.tickets[2].number, 3);
      assert.equal(result.failed, 1);
    });
    const sent = readFileSync(argsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const bodies = sent.flat().filter((arg) => arg.startsWith("body="));
    assert.ok(bodies.some((body) => body.includes("## Destination")), "地图正文必须带 Destination 区块");
    assert.ok(bodies.some((body) => body.includes("Part of map #1")), "票正文要指回地图");
  } finally {
    gh.restore();
  }
});

/* ---------------------------------------------------------------- 环境 */

const PROBE_HANDLER = `
const args = process.argv.slice(2);
const all = args.join(" ");
if (args[0] === "--version") { console.log("gh version 2.60.0"); process.exit(0); }
if (all.includes("graphql")) {
  const issues = ${JSON.stringify([
    node(1, { labels: { totalCount: 1, nodes: [{ name: "wayfinder:map", color: "6e7781" }] } }),
    node(2),
    node(3, { blockedBy: { pageInfo: { hasNextPage: false }, nodes: [{ number: 2, title: "ticket 2", state: "OPEN" }] } }),
    node(4, { assignees: { nodes: [{ login: "me" }] } }),
  ])};
  console.log(JSON.stringify({ data: { repository: {
    issues: { totalCount: issues.length, pageInfo: { hasNextPage: false }, nodes: issues },
    pullRequests: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
    rateLimit: { limit: 5000, remaining: 4999, resetAt: "2026-10-01T00:00:00Z" },
  } } }));
  process.exit(0);
}
console.error("unexpected gh call: " + all);
process.exit(1);
`;

test("环境探针：没有远端时落到本地后端，照样给得出结论", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh(PROBE_HANDLER);
  try {
    const result = json(await run("deck_probe", {}, ws));
    assert.equal(result.repo.host, "local");
    assert.equal(result.repoProblem, null);
    // 空工作区 = 空本地板，不是「读失败」。
    assert.equal(result.counts.total, 0);
    assert.equal(result.backend, "local");
    assert.match(result.gh.version, /gh version/);
    assert.deepEqual(gh.calls(), ["--version"]);
  } finally {
    gh.restore();
  }
});

test("环境探针：有 GitHub 远端时给出计数与地图列表", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const gh = toolGh(PROBE_HANDLER);
  try {
    const result = json(await run("deck_probe", {}, ws));
    assert.deepEqual(result.repo, { host: "github", owner: "acme", name: "deck" });
    assert.equal(result.backend, "github");
    assert.equal(result.counts.total, 4);
    assert.deepEqual(result.maps.map((map) => map.number), [1]);
  } finally {
    gh.restore();
  }
});

/* ---------------------------------------------------------------- 上下文 */

test("会话上下文：给出计数、地图、可直接开工与受阻的票", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const gh = toolGh(PROBE_HANDLER);
  try {
    const result = json(await run("deck_context", { limit: 2 }, ws));
    assert.equal(result.repo, "acme/deck");
    assert.equal(result.counts.open, 4);
    assert.deepEqual(result.maps.map((item) => item.number), [1]);
    assert.deepEqual(result.ready.map((item) => item.number), [1, 2]);
    assert.deepEqual(result.blocked.map((item) => item.number), [3]);
    assert.deepEqual(result.blocked[0].blockedBy, [2]);
    // 被指派的票不是 ready，别把「已有人在做」说成「可以开工」。
    assert.ok(!result.ready.some((item) => item.number === 4));
  } finally {
    gh.restore();
  }
});

/* ---------------------------------------------------------------- 本地后端 */

test("本地后端：建票 / 评论 / 改票 / 改标签都写进 .deck/，一条 gh 都不调", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    const created = json(await run("deck_issue_create", { title: "本地票", labels: ["bug"] }, ws));
    assert.equal(created.number, 1);
    assert.deepEqual(created.labels, ["bug"]);

    const comment = json(await run("deck_issue_comment", { number: 1, body: "做完了" }, ws));
    assert.equal(comment.comment.body, "做完了");

    const patched = json(await run("deck_issue_patch", { number: 1, title: "改过的标题", state: "closed" }, ws));
    assert.equal(patched.title, "改过的标题");
    assert.equal(patched.state, "CLOSED");

    const relabeled = json(await run("deck_issue_labels", { number: 1, labels: ["needs-info"] }, ws));
    assert.deepEqual(relabeled.labels, ["needs-info"]);

    const stored = readFileSync(path.join(ws, ".deck", "issues", "1.md"), "utf8");
    assert.match(stored, /title: 改过的标题/);
    assert.match(stored, /state: CLOSED/);
    assert.match(stored, /needs-info/);
    const comments = JSON.parse(readFileSync(path.join(ws, ".deck", "issues", "1.comments.json"), "utf8"));
    assert.deepEqual(comments.map((item) => item.body), ["做完了"]);
    assert.deepEqual(gh.calls(), []);

    // PR 是 GitHub 的概念：本地后端如实说不支持，而不是回一个空列表让人以为「没有 PR」。
    const prs = await run("deck_pull_requests_list", {}, ws);
    assert.equal(prs.isError, true);
    assert.equal(JSON.parse(prs.text).reason, "unsupported-host");
  } finally {
    gh.restore();
  }
});

test("本地 .scratch 幂等复用：不把没重写的父票 / 指派 / 阻塞边说成本次已写入", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    assert.equal((await initializeLocalScratch(ws, { name: "unit" })).ok, true);
    const map = json(await run("deck_issue_create", { title: "容器", kind: "map", feature: "unit" }, ws));
    assert.equal(map.number, 0);
    const blocker = json(await run("deck_issue_create", { title: "阻塞者", kind: "issue", feature: "unit" }, ws));
    assert.equal(blocker.number, 1);

    const args = {
      title: "重试票",
      kind: "issue",
      feature: "unit",
      parentKey: "00",
      assignees: ["alice"],
      blockedBy: ["1"],
      idempotencyKey: "reuse-1",
    };
    const first = json(await run("deck_issue_create", args, ws));
    assert.equal(first.reused, false);
    assert.equal(first.parent.linked, true);
    assert.equal(first.parent.applied, true);
    assert.equal(first.assignees.applied, true);
    assert.equal(first.blockedBy.applied, true);

    const second = json(await run("deck_issue_create", args, ws));
    assert.equal(second.reused, true);
    assert.equal(second.parent.linked, false);
    assert.equal(second.parent.applied, false);
    assert.match(second.parent.note, /复用了已有票/);
    assert.equal(second.assignees.applied, false);
    assert.match(second.assignees.note, /没有重新指派/);
    assert.equal(second.blockedBy.applied, false);
    assert.match(second.blockedBy.note, /没有重写阻塞边/);
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});

test("本地后端：地图计划先建地图再逐张建票，票落在同一个 .deck/ 里", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    const result = json(
      await run(
        "deck_map_plan_create",
        {
          title: "本地地图",
          destination: "把本地票跑通",
          tickets: [
            { title: "先调研", kind: "research" },
            { title: "再动手", kind: "task", body: "注意顺序" },
          ],
        },
        ws,
      ),
    );
    assert.equal(result.failed, 0);
    assert.deepEqual(result.tickets.map((ticket) => ticket.number), [2, 3]);
    const map = readFileSync(path.join(ws, ".deck", "issues", "1.md"), "utf8");
    assert.match(map, /wayfinder:map/);
    assert.match(map, /## Destination/);
    const task = readFileSync(path.join(ws, ".deck", "issues", "3.md"), "utf8");
    assert.match(task, /wayfinder:task/);
    assert.match(task, /Part of map #1\./);
    // 正文指针只是给人看的；机器读子票清单靠文件头这条边。
    assert.match(task, /^parentKey: 1$/m);
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});

test("本地 .deck：deck_issue_create 建地图工单时父边落盘（不再要求 .scratch）", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    const plan = json(
      await run("deck_map_plan_create", { title: "地图", destination: "跑通地图", tickets: [{ title: "第一张", kind: "task" }] }, ws),
    );
    const mapNumber = plan.map.number;
    const created = json(
      await run("deck_issue_create", { title: "后补工单", kind: "map-ticket", label: "wayfinder:task", parentKey: String(mapNumber) }, ws),
    );
    assert.equal(created.parent.linked, true);

    const detail = json(await run("deck_issue_get", { number: mapNumber }, ws));
    assert.deepEqual(
      detail.relations.children.map((child) => child.number).sort((a, b) => a - b),
      [plan.tickets[0].number, created.number].sort((a, b) => a - b),
    );
  } finally {
    gh.restore();
  }
});

test("deck_issue_get：本地有坏票文件时，子票清单标成截断而不是「0 张完整」", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    const plan = json(
      await run("deck_map_plan_create", { title: "地图", destination: "跑通地图", tickets: [{ title: "工单甲", kind: "task" }] }, ws),
    );
    writeFileSync(path.join(ws, ".deck", "issues", "99.md"), "这不是一张票", "utf8");

    const detail = json(await run("deck_issue_get", { number: plan.map.number }, ws));
    assert.equal(detail.relations.childrenTruncated, true);
    assert.equal(detail.relations.childrenTotal, 1);
    assert.deepEqual(detail.relations.children.map((child) => child.number), [plan.tickets[0].number]);
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});

/* ------------------------------------------------------------ 关容器的闸门 */

test("关地图：子票没全关 / 没带核对评论都拒绝，全关后带评论才放行", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    const plan = json(
      await run("deck_map_plan_create", { title: "地图", destination: "跑通地图", tickets: [{ title: "工单甲", kind: "task" }] }, ws),
    );
    const mapNumber = plan.map.number;
    const childNumber = plan.tickets[0].number;
    // 不手动补父边：建票时 parentKey 就该落盘，闸门按详情里的子票列数子票。

    const openChild = await run("deck_issue_patch", { number: mapNumber, close: true, comment: "先核对" }, ws);
    assert.equal(openChild.isError, true);
    const blocked = JSON.parse(openChild.text);
    assert.equal(blocked.reason, "container-close-children-open");
    assert.match(blocked.detail, new RegExp(`#${childNumber}（工单甲，当前 OPEN）`));

    json(await run("deck_issue_patch", { number: childNumber, close: true }, ws));

    const noComment = await run("deck_issue_patch", { number: mapNumber, close: true }, ws);
    assert.equal(noComment.isError, true);
    assert.equal(JSON.parse(noComment.text).reason, "container-close-no-comment");

    // 先把评论单独写上、再用 closeReason 关票：两者都不能顶替「同一次调用里的 comment」。
    json(await run("deck_issue_comment", { number: mapNumber, body: "先留一条追溯评论" }, ws));
    const reasonOnly = await run("deck_issue_patch", { number: mapNumber, close: true, closeReason: "核对过了" }, ws);
    assert.equal(reasonOnly.isError, true);
    assert.equal(JSON.parse(reasonOnly.text).reason, "container-close-no-comment");

    const closed = json(await run("deck_issue_patch", { number: mapNumber, close: true, comment: `逐张核对：#${childNumber} 已关` }, ws));
    assert.equal(closed.state, "CLOSED");
  } finally {
    gh.restore();
  }
});

test("关普通票不受容器闸门影响：不需要评论，也不去读子票清单", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    json(await run("deck_issue_create", { title: "普通票" }, ws));
    const closed = json(await run("deck_issue_patch", { number: 1, close: true }, ws));
    assert.equal(closed.state, "CLOSED");
  } finally {
    gh.restore();
  }
});

/* -------------------------------------------------------------- 建票闸（需求 / 定稿 / 私标签） */

test("建票闸：spec-ticket 必须挂一条已定稿的需求，没有就一个字不写", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  assert.equal((await initializeLocalScratch(ws, { name: "unit" })).ok, true);
  const gh = toolGh('process.stdout.write("{}\n")');
  try {
    const requirement = json(await run("deck_issue_create", { title: "需求：商品卡改版", labels: ["requirement"], feature: "unit" }, ws));
    const spec = json(await run("deck_issue_create", { title: "规格：商品卡", kind: "spec", feature: "unit" }, ws));

    const blocked = await run(
      "deck_issue_create",
      { title: "实施：改卡片", kind: "spec-ticket", parentKey: "00", feature: "unit", requirementKey: requirement.number },
      ws,
    );
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /定稿/);
    assert.match(blocked.text, /ready-for-agent 不算定稿/);
    // 拒绝发生在写盘之前：任务板上没有那张实施票。
    const before = json(await run("deck_issue_list", {}, ws));
    assert.equal(before.issues.some((issue) => issue.title === "实施：改卡片"), false);

    // 定稿标签只能由界面按钮写：测试里直接改本地文件模拟那一下点击。
    await replaceLocalLabels(ws, requirement.number, ["requirement", "deck:定稿"]);
    const created = json(await run(
      "deck_issue_create",
      { title: "实施：改卡片", kind: "spec-ticket", parentKey: "00", feature: "unit", requirementKey: requirement.number, staff: "w-server" },
      ws,
    ));
    assert.ok(created.number > 0);
    assert.ok(created.labels.includes("deck.staff=w-server"), "岗位写进 deck.staff 标签");
    // 规格容器号不参与比较：只确认实施票真的落进了同一个工作区。
    assert.equal(spec.number, 0);
  } finally {
    gh.restore();
  }
});

test("建票闸：需求影响面「依据」为空 → 拒绝，不建这一票", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  assert.equal((await initializeLocalScratch(ws, { name: "unit" })).ok, true);
  const gh = toolGh('process.stdout.write("{}\n")');
  try {
    const impactBody = [
      "## 影响面",
      "| 区 / 仓库 | 依据 | 结论 | 核的人 | 链条（没有就留空） |",
      "|---|---|---|---|---|",
      "| 当前工作区 |  | 要动 | 单区，免核 | |",
    ].join("\n");
    const requirement = json(await run(
      "deck_issue_create",
      { title: "需求：补影响面", body: impactBody, labels: ["requirement"], feature: "unit" },
      ws,
    ));
    await replaceLocalLabels(ws, requirement.number, ["requirement", "deck:定稿"]);

    const blocked = await run(
      "deck_issue_create",
      { title: "实施：不该建出来", kind: "spec-ticket", parentKey: "00", feature: "unit", requirementKey: requirement.number },
      ws,
    );
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /依据/);
    const after = json(await run("deck_issue_list", {}, ws));
    assert.equal(after.issues.some((issue) => issue.title === "实施：不该建出来"), false, "拒绝发生在写盘之前");
  } finally {
    gh.restore();
  }
});

test("建票时正文的影响面表结构写坏 → 拒绝，不建这一票", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  assert.equal((await initializeLocalScratch(ws, { name: "unit" })).ok, true);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    // 需求窗口凭印象写表：常见偏差是多插一列「仓库」、把「核的人」写成「核验人」。
    const brokenBody = [
      "## 影响面",
      "| 区 / 仓库 | 仓库 | 依据 | 结论 | 核验人 |",
      "|---|---|---|---|---|",
      "| kxhyapp.com | acme/deck | 需求票本身 | 要动 | 单区，免核 |",
    ].join("\n");
    const refused = await run(
      "deck_issue_create",
      { title: "需求：影响面写坏", body: brokenBody, labels: ["requirement"], feature: "unit" },
      ws,
    );
    assert.equal(refused.isError, true);
    assert.match(refused.text, /第 2 列应该是「依据」/);
    const board = json(await run("deck_issue_list", {}, ws));
    assert.equal(board.issues.some((issue) => issue.title === "需求：影响面写坏"), false, "拒绝发生在写盘之前");

    // 表可以空着数据行：写票过程中先立骨架不算错。
    const skeletonOnly = json(await run(
      "deck_issue_create",
      { title: "需求：先立骨架", body: "## 影响面\n| 区 / 仓库 | 依据 | 结论 | 核的人 |\n|---|---|---|---|", labels: ["requirement"], feature: "unit" },
      ws,
    ));
    assert.ok(skeletonOnly.number >= 0);
  } finally {
    gh.restore();
  }
});

test("改票：已定稿需求被改成不合规的影响面表 → 拒绝，正文一个字节都不动", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  assert.equal((await initializeLocalScratch(ws, { name: "unit" })).ok, true);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    const good = [
      "## 影响面",
      "| 区 / 仓库 | 依据 | 结论 | 核的人 |",
      "|---|---|---|---|",
      "| 当前工作区 | 需求票本身 | 要动 | 单区，免核 |",
    ].join("\n");
    const requirement = json(await run(
      "deck_issue_create",
      { title: "需求：定稿后别改坏", body: good, labels: ["requirement"], feature: "unit" },
      ws,
    ));
    await replaceLocalLabels(ws, requirement.number, ["requirement", "deck:定稿"]);

    // 定稿之后把表改成派单会拒的样子：两条路都要在写盘前拒。
    const brokenHeader = good.replace(
      "| 区 / 仓库 | 依据 | 结论 | 核的人 |",
      "| 区 / 仓库 | 仓库 | 依据 | 结论 | 核验人 |",
    ).replace("|---|---|---|---|", "|---|---|---|---|---|")
      .replace("| 当前工作区 | 需求票本身 | 要动 | 单区，免核 |", "| 当前工作区 | acme/deck | 需求票本身 | 要动 | 单区，免核 |");
    const structural = await run("deck_issue_patch", { number: requirement.number, body: brokenHeader }, ws);
    assert.equal(structural.isError, true);
    assert.match(structural.text, /影响面表头/);

    // 结构对、数据行不合规（结论不在三个词里）：定稿的票也要拦住。
    const badRow = good.replace("| 要动 |", "| 动一下 |");
    const semantic = await run("deck_issue_patch", { number: requirement.number, body: badRow }, ws);
    assert.equal(semantic.isError, true);
    assert.match(semantic.text, /已定稿/);
    assert.match(semantic.text, /结论/);

    // 本地后端会把正文按字段重排一遍，所以按内容核：还是原来那张表，没被改坏。
    const detail = json(await run("deck_issue_get", { number: requirement.number }, ws));
    assert.match(detail.issue.body, /\| 区 \/ 仓库 \| 依据 \| 结论 \| 核的人 \|/);
    assert.doesNotMatch(detail.issue.body, /核验人|动一下/, "两次被拒之后正文还是原来那份");

    // 只追加进度（不换正文）照旧能写：坏票上的进度不该被影响面闸挡住。
    const progress = json(await run("deck_issue_patch", { number: requirement.number, progress: { percent: 20, note: "起步" } }, ws));
    assert.equal(progress.ok, true);
  } finally {
    gh.restore();
  }
});

test("deck_issue_labels 拒绝任何 deck: 前缀标签，整组不写", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    json(await run("deck_issue_create", { title: "需求：先谈清楚" }, ws));
    const refused = await run("deck_issue_labels", { number: 1, labels: ["requirement", "deck:定稿"] }, ws);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /deck: 前缀只能由界面上的按钮打/);

    const detail = json(await run("deck_issue_get", { number: 1 }, ws));
    assert.deepEqual(detail.issue.labels, [], "被拒的整组标签一枚都不能写进去");
  } finally {
    gh.restore();
  }
});

test("改票的 addLabels 同样挡 deck: 前缀：否则「先写坏表、再补定稿」就绕开了按钮那次核", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    json(await run("deck_issue_create", { title: "需求：先谈清楚", labels: ["requirement"] }, ws));
    const refused = await run("deck_issue_patch", { number: 1, addLabels: ["deck:定稿"] }, ws);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /deck: 前缀只能由界面上的按钮打/);

    const detail = json(await run("deck_issue_get", { number: 1 }, ws));
    assert.deepEqual(detail.issue.labels, ["requirement"], "一枚 deck: 标签都不该被补上去");

    // 撤也一样：能悄悄摘掉定稿，就能先摘、再写成派单必拒的样子。
    const stillFinalized = await run("deck_issue_patch", { number: 1, removeLabels: ["deck:定稿"] }, ws);
    assert.equal(stillFinalized.isError, true);
    assert.match(stillFinalized.text, /不能经 MCP 撤/);
  } finally {
    gh.restore();
  }
});

test("建地图：路线票正文里的影响面表写坏 → 这一张不建，别的照建", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace(false);
  const gh = toolGh('process.stdout.write("{}\\n")');
  try {
    const plan = json(
      await run(
        "deck_map_plan_create",
        {
          title: "地图",
          destination: "跑通地图",
          tickets: [
            { title: "写坏表的票", kind: "task", body: "## 影响面\n| 区 | 依据 | 结论 | 核的人 |\n|---|---|---|---|" },
            { title: "正常票", kind: "task" },
          ],
        },
        ws,
      ),
    );
    // 坏的逐条拒绝，不给它一个票号；好的照旧建出来。
    assert.equal(plan.failed, 1);
    assert.match(plan.tickets[0].error, /区 \/ 仓库/);
    assert.equal(plan.tickets[0].number, undefined);
    assert.equal(plan.tickets[1].number > 0, true);
  } finally {
    gh.restore();
  }
});
