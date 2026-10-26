import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 真起子进程测入口，而不是只测纯函数。
 *
 * 这一层最容易坏、也最容易坏得无声：入口判定写错 → 进程 exit 0、stdout/stderr 全空，
 * 客户端看到的是「MCP 服务器握手时消失」，日志里却一个字都没有。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "server", "mcp", "main.ts");
const sandboxes = [];

function sandbox(prefix = "deck-mcp-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

/** 把插件复制进一个「带空格与中文」的目录，顺带软链 node_modules（server 侧要 zod）。 */
function copyPluginTo(dir) {
  cpSync(path.join(root, "server"), path.join(dir, "server"), { recursive: true });
  cpSync(path.join(root, "shared"), path.join(dir, "shared"), { recursive: true });
  symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  return path.join(dir, "server", "mcp", "main.ts");
}

const line = (message) => `${JSON.stringify(message)}\n`;

test("入口：安装路径带空格与非 ASCII 时照样启动，回包按行完整落地", () => {
  const dir = sandbox("deck 入口 空格-");
  const spaced = copyPluginTo(dir);
  const workspace = sandbox("deck ws-");

  const result = spawnSync(process.execPath, [spaced, "--workspace", workspace], {
    input:
      line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) +
      line({ jsonrpc: "2.0", id: 2, method: "ping" }),
    encoding: "utf8",
    timeout: 60_000,
  });

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const replies = result.stdout.split("\n").filter(Boolean).map((text) => JSON.parse(text));
  assert.equal(replies.length, 2);
  assert.equal(replies[0].id, 1);
  assert.equal(replies[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(replies[1], { jsonrpc: "2.0", id: 2, result: {} });
});

test("入口：插件目录经符号链接访问时照样启动（~/.paseo 软链到别的盘）", () => {
  const realDir = sandbox("deck real-");
  copyPluginTo(realDir);
  const linkParent = sandbox("deck link-");
  const link = path.join(linkParent, "paseo");
  symlinkSync(realDir, link, "dir");
  const workspace = sandbox("deck ws-");

  const result = spawnSync(process.execPath, [path.join(link, "server", "mcp", "main.ts"), "--workspace", workspace], {
    input:
      line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) +
      line({ jsonrpc: "2.0", id: 2, method: "ping" }),
    encoding: "utf8",
    timeout: 60_000,
  });

  // 判定失败时进程会以 0 退出、stdout 全空并在 stderr 留一行——三条断言各自能抓住它。
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stderr, "");
  const replies = result.stdout.split("\n").filter(Boolean).map((text) => JSON.parse(text));
  assert.equal(replies.length, 2);
  assert.equal(replies[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(replies[1], { jsonrpc: "2.0", id: 2, result: {} });
});

test("启动参数：缺 --workspace、相对路径、目录不存在都以退出码 2 报人话", () => {
  const cases = [
    [[], /--workspace/],
    [["--workspace", "relative/dir"], /绝对路径/],
    [["--workspace", "/nonexistent-deck-workspace"], /不存在/],
  ];
  for (const [args, pattern] of cases) {
    const result = spawnSync(process.execPath, [entry, ...args], { input: "", encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 2, `args=${JSON.stringify(args)} stderr=${result.stderr}`);
    assert.match(result.stderr, pattern);
  }
});

test("大回包不被截断，且状态过滤下推到了 GraphQL 查询", { skip: !gitAvailable && "本机没有 git" }, () => {
  const workspace = sandbox("deck ws-");
  assert.equal(spawnSync("git", ["init", "-q", workspace]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", workspace, "remote", "add", "origin", "https://github.com/acme/deck.git"]).status,
    0,
  );

  // 假 gh：把收到的参数追加到日志，再把预置的 GraphQL 回包原样吐出来。
  const bin = sandbox("deck bin-");
  const capture = path.join(bin, "gh-args.log");
  const response = path.join(bin, "gh-response.json");
  writeFileSync(
    path.join(bin, "gh"),
    '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$GH_CAPTURE"\ncat "$GH_RESPONSE"\n',
    "utf8",
  );
  chmodSync(path.join(bin, "gh"), 0o755);

  const nodes = Array.from({ length: 400 }, (_, index) => ({
    number: index + 1,
    title: `ticket ${index + 1} ${"x".repeat(120)}`,
    state: "OPEN",
    url: `https://github.com/acme/deck/issues/${index + 1}`,
    updatedAt: "2026-10-01T00:00:00Z",
    labels: { nodes: [{ name: "bug", color: "ff0000" }] },
    assignees: { nodes: [] },
  }));
  writeFileSync(
    response,
    JSON.stringify({
      data: { repository: { issues: { totalCount: 400, pageInfo: { hasNextPage: true }, nodes } } },
    }),
    "utf8",
  );

  // 让下游先睡 500ms 再读：管道灌满，回包在服务端排队。
  // 服务端若「写完就退出」，超过管道容量（64KB）的尾巴会丢——这条用例就是抓那个。
  const sink = path.join(bin, "stdout.jsonl");
  const pipeline = `"${process.execPath}" "${entry}" --workspace "${workspace}" | ( sleep 0.5; cat > "${sink}" )`;
  const result = spawnSync("sh", ["-c", pipeline], {
    input: line({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "deck_issues_list", arguments: {} } }),
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_CAPTURE: capture, GH_RESPONSE: response },
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const stdout = String(spawnSync("cat", [sink], { encoding: "utf8" }).stdout);
  assert.ok(stdout.length > 64 * 1024, `回包只有 ${stdout.length} 字节，没到管道容量`);
  const replies = stdout.split("\n").filter(Boolean);
  assert.equal(replies.length, 1, "一条请求只该有一行回包（半截 JSON 会在这里现形）");

  const reply = JSON.parse(replies[0]);
  const payload = JSON.parse(reply.result.content[0].text);
  assert.equal(payload.issues.length, 400);
  assert.equal(payload.totalCount, 400);
  assert.equal(payload.returned, 400);
  assert.equal(payload.hasMore, true);

  const captured = String(spawnSync("cat", [capture], { encoding: "utf8" }).stdout);
  // 状态下推：默认 open 必须体现在查询里，而不是取回 100 条混合状态再本地筛。
  assert.match(captured, /states: \[OPEN\]/);
  // 字符串变量走 -f（原样），数字走 -F：-F 会做类型推断并把 @ 当读文件。
  assert.match(captured, /(^|\n)-f\nowner=acme\n/);
  assert.match(captured, /(^|\n)-f\nname=deck\n/);
  assert.match(captured, /(^|\n)-F\nfirst=100\n/);
});
