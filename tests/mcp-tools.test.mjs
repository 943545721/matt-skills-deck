import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fakeGh } from "./helpers/fake-gh.mjs";
import { findTool } from "../server/mcp/tools.ts";

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
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const all = args.join(" ");
appendFileSync(process.env.DECK_ARGS_FILE, JSON.stringify(args) + "\\n");
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

test("缺陷报告：正文按「发生了什么 / 期望 / 复现步骤」固定成节，步骤带序号", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const argsFile = path.join(sandbox("deck-tool-args-"), "args.log");
  writeFileSync(argsFile, "", "utf8");
  const gh = toolGh(CREATE_HANDLER);
  try {
    await withEnv({ DECK_ARGS_FILE: argsFile }, async () => {
      const result = json(
        await run(
          "deck_issue_report",
          {
            title: "面板计数不对",
            whatHappened: "关掉一张票后 ready 仍是 3",
            expected: "ready 变成 2",
            steps: ["打开面板", "关掉一张 ready 票"],
            labels: ["bug"],
          },
          ws,
        ),
      );
      assert.equal(result.number, 42);
      assert.deepEqual(result.labels, ["bug"]);
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

/* ---------------------------------------------------------------- 挂地图 */

const mapDetail = (labels, totalCount) => `
if (all.includes("number=1")) {
  console.log(JSON.stringify({ data: { repository: { issue: ${JSON.stringify(
    node(1, { labels: { totalCount: 1, nodes: [{ name: "wayfinder:map", color: "6e7781" }] } }),
  )} } } }));
  process.exit(0);
}
if (all.includes("number=2")) {
  console.log(JSON.stringify({ data: { repository: { issue: ${JSON.stringify(
    node(2, { labels: { totalCount, nodes: labels } }),
  )} } } }));
  process.exit(0);
}`;

const MAP_LINK_HANDLER = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const all = args.join(" ");
appendFileSync(process.env.DECK_ARGS_FILE, JSON.stringify(args) + "\\n");
if (all.includes("graphql")) {${mapDetail([{ name: "bug", color: "ff0000" }], 1)}
}
if (args[1] && args[1].endsWith("/labels") && all.includes("PUT")) {
  const names = args.filter((arg) => arg.startsWith("labels[]=")).map((arg) => arg.slice("labels[]=".length));
  console.log(JSON.stringify(names.map((name) => ({ name, color: "cccccc" }))));
  process.exit(0);
}
if (args[1] && args[1].endsWith("/comments") && all.includes("POST")) {
  console.log(JSON.stringify({ body: "linked", user: { login: "me" }, created_at: "2026-10-01T00:00:00Z" }));
  process.exit(0);
}
console.error("unexpected gh call: " + all);
process.exit(1);
`;

test("挂地图：保留原有标签再加 wayfinder:<kind>，并在给出的地图下留一条评论", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const argsFile = path.join(sandbox("deck-tool-args-"), "args.log");
  writeFileSync(argsFile, "", "utf8");
  const gh = toolGh(MAP_LINK_HANDLER);
  try {
    await withEnv({ DECK_ARGS_FILE: argsFile }, async () => {
      const result = json(
        await run("deck_map_link", { mapNumber: 1, number: 2, kind: "research", comment: "先查清楚" }, ws),
      );
      assert.equal(result.ok, true);
      assert.deepEqual(result.labels, ["bug", "wayfinder:research"]);
      assert.equal(result.commented, true);
    });
    const sent = readFileSync(argsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const put = sent.find((args) => args.includes("--method") && args.includes("PUT"));
    assert.ok(put, "应当有一次 PUT 标签的调用");
    assert.ok(put.includes("labels[]=bug"), "原有标签不能被覆盖掉");
    assert.ok(put.includes("labels[]=wayfinder:research"));
  } finally {
    gh.restore();
  }
});

const TRUNCATED_HANDLER = `
const args = process.argv.slice(2);
const all = args.join(" ");
if (all.includes("graphql")) {${mapDetail([{ name: "bug", color: "ff0000" }], 30)}
}
console.error("unexpected gh call: " + all);
process.exit(1);
`;

test("挂地图：标签读不全时拒绝写入，不拿「读到的 20 个」覆盖掉剩下的", { skip: !gitAvailable && "本机没有 git" }, async () => {
  const ws = workspace();
  const gh = toolGh(TRUNCATED_HANDLER);
  try {
    const result = await run("deck_map_link", { mapNumber: 1, number: 2, kind: "task" }, ws);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.text).reason, "labels-truncated");
    assert.deepEqual(gh.calls(), ["api", "api"]);
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
    assert.deepEqual(gh.calls(), []);
  } finally {
    gh.restore();
  }
});
