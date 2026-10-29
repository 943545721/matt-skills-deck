import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  ACTION_SKILLS,
  SESSION_TITLE_MAX_CHARS,
  actionTitle,
  buildActionPrompt,
  buildSkillPrompt,
  matchesWorkspaceScope,
  normalizeSessionDir,
  planSessionSend,
  promptDialect,
  rankSessionCandidates,
  renderHandoff,
  sessionTitle,
  truncateTitle,
} from "../shared/session.ts";
import { classifySessionError, createAgent, readLedger, sendToAgent, writeHandoff } from "../server/session.ts";
import { composerFillDecision } from "../client/deck/session/composer-fill.ts";

const roots = [];

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "deck-session-"));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const ticketCtx = {
  lang: "zh",
  provider: "claude",
  repoKey: "octo/deck",
  number: 12,
  title: "登录超时",
  url: "https://example.test/issues/12",
};

// ---------------------------------------------------------------------------
// 提示词形状
// ---------------------------------------------------------------------------

test("buildActionPrompt 把技能命令放在第一行，并带上票面事实", () => {
  const prompt = buildActionPrompt("diagnose", ticketCtx);
  const lines = prompt.split("\n");
  assert.equal(lines[0], "/triage");
  assert.match(prompt, /仓库：octo\/deck/);
  assert.match(prompt, /票：#12 登录超时/);
  assert.match(prompt, /链接：https:\/\/example\.test\/issues\/12/);
  assert.match(prompt, /结束时把真实状态/);
});

test("buildActionPrompt 的英文版本使用英文标签", () => {
  const prompt = buildActionPrompt("fix", { ...ticketCtx, lang: "en" });
  assert.equal(prompt.split("\n")[0], "/implement");
  assert.match(prompt, /Repo: octo\/deck/);
  assert.match(prompt, /Ticket: #12 登录超时/);
  assert.match(prompt, /Link: https:\/\/example\.test\/issues\/12/);
  assert.match(prompt, /When you finish/);
});

test("每个动作指向约定的技能", () => {
  for (const [kind, skill] of Object.entries(ACTION_SKILLS)) {
    const prompt = buildActionPrompt(kind, { ...ticketCtx, lang: "en" });
    if (skill) {
      assert.equal(prompt.split("\n")[0], `/${skill}`, `${kind} 应指向 ${skill}`);
    } else {
      assert.equal(prompt.startsWith("/"), false, `${kind} 不应有技能命令`);
    }
  }
});

test("没有 URL 时不留下空的链接行", () => {
  const prompt = buildActionPrompt("research", { ...ticketCtx, url: "  " });
  assert.doesNotMatch(prompt, /链接：/);
});

test("custom 只发备注，并明确不是技能命令", () => {
  const prompt = buildActionPrompt("custom", { lang: "zh", provider: "claude", notes: "把安装段补全" });
  assert.equal(prompt.startsWith("/"), false);
  assert.match(prompt, /补充说明：\n把安装段补全/);
});

test("custom 没有备注时要求先问清楚", () => {
  const prompt = buildActionPrompt("custom", { lang: "en" });
  assert.match(prompt, /ask what to do before acting/);
});

test("技能详情在斜杠提供方发命令，在其它提供方发纯文本说明", () => {
  assert.equal(buildSkillPrompt("/wayfinder", { lang: "zh", provider: "claude/sonnet" }), "/wayfinder");
  const plain = buildSkillPrompt("/wayfinder", { lang: "zh", provider: "some-provider/model" });
  assert.equal(plain.startsWith("/"), false);
  assert.match(plain, /wayfinder 技能/);
  assert.equal(buildSkillPrompt("  ", { lang: "en" }), "");
});

// ---------------------------------------------------------------------------
// 注入目标选择
// ---------------------------------------------------------------------------

test("rankSessionCandidates 排除已关闭会话，并按最近活动排序", () => {
  const candidates = [
    { id: "old-update", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "recent-user", updatedAt: "2026-01-01T00:00:00.000Z", lastUserMessageAt: "2026-01-03T00:00:00.000Z" },
    { id: "recent-update", updatedAt: "2026-01-02T00:00:00.000Z" },
    { id: "closed", status: "closed", updatedAt: "2026-01-04T00:00:00.000Z" },
  ];
  const original = candidates.map((candidate) => candidate.id);
  const ranked = rankSessionCandidates(candidates);
  assert.deepEqual(ranked.map((candidate) => candidate.id), ["recent-user", "recent-update", "old-update"]);
  assert.deepEqual(candidates.map((candidate) => candidate.id), original, "不得原地排序");
});

test("rankSessionCandidates 活动时间相同则让正在工作的会话优先", () => {
  const ranked = rankSessionCandidates([
    { id: "idle", status: "idle", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "running", status: "running", updatedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(ranked.map((candidate) => candidate.id), ["running", "idle"]);
});

test("rankSessionCandidates 忽略无效时间而不是抛错", () => {
  const ranked = rankSessionCandidates([
    { id: "broken", updatedAt: "not-a-date" },
    { id: "valid", updatedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(ranked.map((candidate) => candidate.id), ["valid", "broken"]);
});

// ---------------------------------------------------------------------------
// 已有会话范围：同一目录出现多个 workspaceId 时也要能看到
// ---------------------------------------------------------------------------

test("normalizeSessionDir 去掉尾斜杠并保留根目录", () => {
  assert.equal(normalizeSessionDir("/www/wwwroot/proj/"), "/www/wwwroot/proj");
  assert.equal(normalizeSessionDir("/www/wwwroot/proj"), "/www/wwwroot/proj");
  assert.equal(normalizeSessionDir("  /www/wwwroot/proj  "), "/www/wwwroot/proj");
  assert.equal(normalizeSessionDir("/"), "/");
  assert.equal(normalizeSessionDir(""), "");
});

test("matchesWorkspaceScope：workspaceId 相同优先，不看目录", () => {
  assert.equal(
    matchesWorkspaceScope({ workspaceId: "wks-a", cwd: "/elsewhere" }, "wks-a", "/www/proj"),
    true,
  );
});

test("matchesWorkspaceScope：同目录的另一工作区会话也算本工作区", () => {
  assert.equal(
    matchesWorkspaceScope(
      { workspaceId: "wks-b", cwd: "/www/wwwroot/paseo-matt-skills-deck" },
      "wks-a",
      "/www/wwwroot/paseo-matt-skills-deck",
    ),
    true,
  );
});

test("matchesWorkspaceScope：快照里 workspaceId 缺失时按 cwd 匹配", () => {
  assert.equal(
    matchesWorkspaceScope(
      { workspaceId: null, cwd: "/www/wwwroot/paseo-matt-skills-deck" },
      "wks-a",
      "/www/wwwroot/paseo-matt-skills-deck/",
    ),
    true,
  );
});

test("matchesWorkspaceScope：不同目录的会话不算进来", () => {
  assert.equal(
    matchesWorkspaceScope(
      { workspaceId: "wks-b", cwd: "/www/wwwroot/sub2api" },
      "wks-a",
      "/www/wwwroot/paseo-matt-skills-deck",
    ),
    false,
  );
});

test("matchesWorkspaceScope：没有目录信息时只按 workspaceId 匹配", () => {
  assert.equal(matchesWorkspaceScope({ workspaceId: "wks-b", cwd: "/www/proj" }, "wks-a", ""), false);
  assert.equal(matchesWorkspaceScope({ workspaceId: "wks-a", cwd: "/www/proj" }, "wks-a", ""), true);
});

// ---------------------------------------------------------------------------
// provider 分支
// ---------------------------------------------------------------------------

test("内置提供方使用斜杠命令，未知提供方退回纯文本", () => {
  assert.equal(promptDialect("claude"), "slash");
  assert.equal(promptDialect("codex"), "slash");
  assert.equal(promptDialect("opencode"), "slash");
  assert.equal(promptDialect("claude/opus"), "slash");
  assert.equal(promptDialect("aider"), "text");
  assert.equal(promptDialect(undefined), "text");

  const plain = buildActionPrompt("diagnose", { ...ticketCtx, provider: "aider", lang: "en" });
  assert.equal(plain.startsWith("/"), false);
  assert.match(plain, /Follow the triage skill/);
  assert.match(plain, /plain text/);
});

test("planSessionSend 同时给出命令版与纯文本版", () => {
  const plan = planSessionSend({
    action: "diagnose",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
  });
  assert.equal(plan.skill, "triage");
  assert.equal(plan.prompt.split("\n")[0], "/triage");
  assert.ok(plan.plainPrompt);
  assert.equal(plan.plainPrompt.startsWith("/"), false);
});

test("custom 没有技能，因此没有 plainPrompt", () => {
  const plan = planSessionSend({
    action: "custom",
    ctx: { lang: "en", notes: "do this" },
    target: { kind: "current", agentId: "agent-1" },
  });
  assert.equal(plan.skill, undefined);
  assert.equal(plan.plainPrompt, undefined);
});

// ---------------------------------------------------------------------------
// 标题
// ---------------------------------------------------------------------------

test("actionTitle 组合动作词、票号与标题", () => {
  assert.equal(actionTitle("diagnose", ticketCtx), "诊断 #12 登录超时");
  assert.equal(actionTitle("diagnose", { ...ticketCtx, lang: "en" }), "Diagnose #12 登录超时");
  assert.equal(actionTitle("fix", { lang: "zh", number: 7 }), "修复 #7");
  assert.equal(actionTitle("custom", { lang: "en" }), "Custom");
});

test("标题里的换行与连续空白被压平", () => {
  assert.equal(actionTitle("fix", { lang: "zh", title: "  多行\n\n标题  " }), "修复 多行 标题");
});

test("新建会话标题不超过 60 个字符", () => {
  const title = sessionTitle("fix", { lang: "zh", number: 1, title: "计".repeat(200) });
  assert.ok(Array.from(title).length <= SESSION_TITLE_MAX_CHARS);
  assert.equal(Array.from(title).length, SESSION_TITLE_MAX_CHARS);
  assert.ok(title.endsWith("…"));
  assert.ok(title.startsWith("[New] "));
});

test("截断不劈开代理对", () => {
  const cut = truncateTitle("🙂".repeat(20), 5);
  assert.equal(Array.from(cut).length, 5);
  assert.equal(cut.includes("🙂"), true);
  assert.equal(truncateTitle("abcd", 4), "abcd");
});

// ---------------------------------------------------------------------------
// 发送计划
// ---------------------------------------------------------------------------

test("默认 queue，空闲会话不需要确认", () => {
  const plan = planSessionSend({
    action: "diagnose",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
  });
  assert.equal(plan.sendMode, "queue");
  assert.equal(plan.requiresConfirmation, false);
  assert.equal(plan.title, undefined);
  assert.equal(plan.idempotencyKey, undefined);
});

test("忙碌时仍默认 queue，并要求确认", () => {
  const plan = planSessionSend({
    action: "diagnose",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
    busy: true,
  });
  assert.equal(plan.sendMode, "queue");
  assert.notEqual(plan.sendMode, "interrupt");
  assert.equal(plan.requiresConfirmation, true);
});

test("只有显式选择才出现 interrupt", () => {
  const plan = planSessionSend({
    action: "fix",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
    busy: true,
    sendMode: "interrupt",
  });
  assert.equal(plan.sendMode, "interrupt");
  assert.equal(plan.requiresConfirmation, true);
});

test("copy 目标不产生标题、幂等键或确认", () => {
  const plan = planSessionSend({
    action: "handoff",
    ctx: ticketCtx,
    target: { kind: "copy" },
    busy: true,
  });
  assert.equal(plan.title, undefined);
  assert.equal(plan.idempotencyKey, undefined);
  assert.equal(plan.requiresConfirmation, false);
});

test("新建目标的标题与幂等键", () => {
  const input = {
    action: "bug",
    ctx: { ...ticketCtx, lang: "en", title: "x".repeat(200) },
    target: { kind: "new", cwd: "/repo" },
  };
  const first = planSessionSend(input);
  const second = planSessionSend(input);
  assert.ok(Array.from(first.title).length <= SESSION_TITLE_MAX_CHARS);
  assert.match(first.idempotencyKey, /^deck-bug-/);
  assert.equal(first.idempotencyKey, second.idempotencyKey);

  const other = planSessionSend({ ...input, action: "fix" });
  assert.notEqual(first.idempotencyKey, other.idempotencyKey);
});

test("调用方给的幂等键原样保留", () => {
  const plan = planSessionSend({
    action: "fix",
    ctx: ticketCtx,
    target: { kind: "new", cwd: "/repo" },
    idempotencyKey: "click-123",
  });
  assert.equal(plan.idempotencyKey, "click-123");
});

// ---------------------------------------------------------------------------
// Handoff 渲染
// ---------------------------------------------------------------------------

test("renderHandoff 生成稳定的 Markdown 快照", () => {
  const markdown = renderHandoff({
    lang: "zh",
    title: "诊断 #12 登录超时",
    createdAt: "2026-10-28T01:00:00.000Z",
    agentId: "a1",
    ticket: { repoKey: "o/r", number: 12, title: "登录超时", url: "https://example.test/issues/12" },
    summary: "定位到超时发生在 token 刷新。",
    done: ["复现", { text: "加日志", note: "仅在本地" }],
    inProgress: [{ text: "补测试" }],
    nextSteps: ["提交修复"],
    risks: ["需要真实环境验证"],
    files: ["src/auth.ts"],
    notes: ["截图在票 #12"],
  });
  const expected = [
    "# Handoff：诊断 #12 登录超时",
    "",
    "- 生成时间：2026-10-28T01:00:00.000Z",
    "- Agent：a1",
    "- 票：o/r#12 登录超时",
    "- 链接：https://example.test/issues/12",
    "",
    "## 摘要",
    "定位到超时发生在 token 刷新。",
    "",
    "## 已完成",
    "- 复现",
    "- 加日志 — 仅在本地",
    "",
    "## 进行中",
    "- 补测试",
    "",
    "## 下一步",
    "- 提交修复",
    "",
    "## 风险与注意",
    "- 需要真实环境验证",
    "",
    "## 涉及文件",
    "- `src/auth.ts`",
    "",
    "## 备注",
    "- 截图在票 #12",
    "",
  ].join("\n");
  assert.equal(markdown, expected);
});

test("空 handoff 如实说明没有内容", () => {
  assert.equal(
    renderHandoff({ lang: "en" }),
    "# Handoff\n\n(Nothing to hand off: summary, done, in progress and next steps are all empty.)\n",
  );
});

test("renderHandoff 忽略类型不对的字段，不写占位内容", () => {
  const markdown = renderHandoff({
    lang: "en",
    summary: 42,
    done: [12, { text: "" }, { text: "ok" }],
    files: [1, "a.ts"],
  });
  assert.match(markdown, /## Done\n- ok/);
  assert.match(markdown, /## Files\n- `a\.ts`/);
  assert.doesNotMatch(markdown, /## Summary/);
});

test("renderHandoff 对非对象输入抛类型错误", () => {
  for (const value of [null, undefined, 42, "text", []]) {
    assert.throws(() => renderHandoff(value), TypeError);
  }
});

// ---------------------------------------------------------------------------
// 服务端：错误分类
// ---------------------------------------------------------------------------

test("错误分类覆盖未登录、仓库、权限、超时", () => {
  assert.equal(classifySessionError(new Error("401 Unauthorized: not logged in")), "unauthenticated");
  assert.equal(classifySessionError(new Error("invalid api key")), "unauthenticated");
  assert.equal(classifySessionError(new Error("repository not found")), "repo");
  assert.equal(classifySessionError(new Error("cwd does not exist")), "repo");
  assert.equal(classifySessionError(new Error("permission denied")), "permission");
  assert.equal(classifySessionError(new Error("403 forbidden")), "permission");
  assert.equal(classifySessionError(new Error("request timed out after 30s")), "timeout");
  assert.equal(classifySessionError(new Error("agent not found")), "not-found");
  assert.equal(classifySessionError(new Error("something odd")), "unknown");
});

// ---------------------------------------------------------------------------
// 服务端：createAgent
// ---------------------------------------------------------------------------

function fakeCreate({ snapshots = [], error = null, id = "agent-new" } = {}) {
  const calls = [];
  return {
    calls,
    paseo: {
      agents: {
        create: async (options) => {
          calls.push(options);
          for (const snapshot of snapshots) options.onEvent?.(snapshot);
          if (error) throw error;
          return { id, title: options.title ?? null };
        },
      },
    },
  };
}

test("createAgent 原样传递 provider、提示词、标题与幂等键", async () => {
  const fake = fakeCreate();
  const result = await createAgent(fake.paseo, {
    cwd: "/repo",
    provider: "claude",
    prompt: "/triage",
    title: "[New] 诊断 #1",
    idempotencyKey: "key-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(result.failure, null);
  assert.equal(result.ledger.skipped, true);
  const options = fake.calls[0];
  assert.equal(options.cwd, "/repo");
  assert.equal(options.config.provider, "claude");
  assert.equal(options.prompt, "/triage");
  assert.equal(options.title, "[New] 诊断 #1");
  assert.equal(options.idempotencyKey, "key-1");
});

test("创建快照 failed 时如实报告部分成功", async () => {
  const fake = fakeCreate({
    snapshots: [
      { phase: "agent_ready", agentId: "agent-new" },
      { phase: "failed", agentId: "agent-new", error: "permission denied: cannot write repo" },
    ],
  });
  const result = await createAgent(fake.paseo, { cwd: "/repo", provider: "claude", prompt: "/triage" });
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.failure.kind, "permission");
  assert.match(result.failure.detail, /cannot write repo/);
  assert.equal(result.failure.phase, "failed");
  assert.equal(result.failure.agentId, "agent-new");
});

test("创建抛错时保留已经出现的 agentId", async () => {
  const fake = fakeCreate({
    snapshots: [{ phase: "agent_ready", agentId: "agent-half" }],
    error: new Error("not logged in to provider"),
  });
  const result = await createAgent(fake.paseo, { cwd: "/repo", provider: "claude", prompt: "/triage" });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "unauthenticated");
  assert.equal(result.failure.agentId, "agent-half");
  assert.equal(result.failure.phase, "agent_ready");
});

test("createAgent 拒绝缺少 provider 或工作区", async () => {
  const fake = fakeCreate();
  const result = await createAgent(fake.paseo, { cwd: " ", provider: " " });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "invalid-input");
  assert.equal(fake.calls.length, 0);
});

test("有票且给了数据目录时写入工作路线台账", async () => {
  const root = tempRoot();
  const fake = fakeCreate({ id: "agent-ledger" });
  const result = await createAgent(fake.paseo, {
    cwd: "/repo",
    provider: "claude",
    prompt: "/triage",
    ticket: { repoKey: "o/r", number: 3, title: "登录超时" },
    ledger: { homeDir: root },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ledger.ok, true);
  assert.equal(result.ledger.skipped, false);
  const read = await readLedger({ homeDir: root, agentId: "agent-ledger" });
  assert.equal(read.ok, true);
  assert.equal(read.ledger.entries.length, 1);
  assert.equal(read.ledger.entries[0].ticketKey, "o/r#3");
  assert.equal(read.ledger.entries[0].status, "attached");
});

test("显式 agentId: null 记进工作区台账，而不是新会话的 agent 台账", async () => {
  const root = tempRoot();
  const fake = fakeCreate({ id: "agent-new" });
  const result = await createAgent(fake.paseo, {
    cwd: "/repo",
    provider: "claude",
    prompt: "/triage",
    ticket: { repoKey: "o/r", number: 4, title: "工作区票" },
    ledger: { homeDir: root, cwd: "/repo", agentId: null },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ledger.ok, true);
  const workspace = await readLedger({ homeDir: root, cwd: "/repo", agentId: null });
  assert.equal(workspace.ok, true);
  assert.equal(workspace.scope.kind, "workspace");
  assert.equal(workspace.ledger.entries.length, 1);
  assert.equal(workspace.ledger.entries[0].agentId, "agent-new");
  const agent = await readLedger({ homeDir: root, agentId: "agent-new", cwd: "/repo" });
  assert.equal(agent.ok, true);
  assert.equal(agent.ledger.entries.length, 0);
});

// ---------------------------------------------------------------------------
// 服务端：sendToAgent
// ---------------------------------------------------------------------------

function fakeHandle({ busy = false, commandNames = ["triage"], commandsError = null, refreshResult = {} } = {}) {
  const state = { busy, sent: [], waits: 0, refreshes: 0, commandCalls: 0 };
  const handle = {
    id: "agent-1",
    get activeTurn() {
      return state.busy ? { id: "turn-1" } : null;
    },
    status: "idle",
    refresh: async () => {
      state.refreshes += 1;
      return refreshResult;
    },
    current: () => ({ id: "agent-1" }),
    commands: async () => {
      state.commandCalls += 1;
      return {
        agentId: "agent-1",
        requestId: "req",
        error: commandsError,
        commands: commandNames.map((name) => ({ name, description: "", argumentHint: "", kind: "skill" })),
      };
    },
    waitForFinish: async () => {
      state.waits += 1;
      state.busy = false;
      return {};
    },
    send: async (text, options) => {
      state.sent.push({ text, options });
    },
    subscribe: () => () => {},
  };
  return { state, handle };
}

function fakeSend(options = {}) {
  const fake = fakeHandle(options);
  return {
    ...fake,
    paseo: { agents: { ref: () => fake.handle, create: async () => fake.handle } },
  };
}

test("current 空闲时直接发送，queue 模式不传打断参数", async () => {
  const fake = fakeSend();
  const plan = planSessionSend({
    action: "diagnose",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
  });
  const result = await sendToAgent(fake.paseo, { plan });
  assert.equal(result.ok, true);
  assert.equal(result.waited, false);
  assert.equal(result.skillAvailable, true);
  assert.equal(fake.state.sent.length, 1);
  assert.equal(fake.state.sent[0].text.split("\n")[0], "/triage");
  assert.equal(fake.state.sent[0].options, undefined);
});

test("技能不在命令清单里时改发纯文本版本", async () => {
  const fake = fakeSend({ commandNames: ["implement"] });
  const plan = planSessionSend({
    action: "diagnose",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
  });
  const result = await sendToAgent(fake.paseo, { plan });
  assert.equal(result.ok, true);
  assert.equal(result.skillAvailable, false);
  assert.equal(fake.state.sent[0].text.startsWith("/"), false);
  assert.match(fake.state.sent[0].text, /请按 triage 技能/);
});

test("命令清单读不到时不阻断，仍按计划发送", async () => {
  const fake = fakeSend({ commandsError: "provider cannot list commands" });
  const plan = planSessionSend({
    action: "diagnose",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
  });
  const result = await sendToAgent(fake.paseo, { plan });
  assert.equal(result.ok, true);
  assert.equal(result.skillAvailable, null);
  assert.equal(fake.state.sent[0].text.split("\n")[0], "/triage");
});

test("忙碌时未确认就拒绝发送，也不会先等待", async () => {
  const fake = fakeSend({ busy: true });
  const plan = planSessionSend({
    action: "diagnose",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
    busy: true,
  });
  const result = await sendToAgent(fake.paseo, { plan });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "confirmation-required");
  assert.equal(fake.state.waits, 0);
  assert.equal(fake.state.sent.length, 0);
});

test("客户端快照说空闲、服务端实际忙碌时，仍要求确认", async () => {
  const fake = fakeSend({ busy: true });
  const plan = planSessionSend({
    action: "diagnose",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
    // 刻意传 false：模拟面板拿到的状态已经过期。
    busy: false,
  });
  const result = await sendToAgent(fake.paseo, { plan });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "confirmation-required");
  assert.equal(fake.state.waits, 0);
  assert.equal(fake.state.sent.length, 0);
});

test("确认后 queue 模式等待当前回合结束再发", async () => {
  const fake = fakeSend({ busy: true });
  const plan = planSessionSend({
    action: "diagnose",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
    busy: true,
  });
  const result = await sendToAgent(fake.paseo, { plan, confirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.waited, true);
  assert.equal(fake.state.waits, 1);
  assert.equal(fake.state.sent.length, 1);
  assert.equal(fake.state.sent[0].options, undefined);
});

test("等待超时仍忙时返回 busy，不发送", async () => {
  const fake = fakeSend({ busy: true });
  fake.handle.waitForFinish = async () => {
    fake.state.waits += 1;
    // 故意不结束回合
    return {};
  };
  const plan = planSessionSend({
    action: "diagnose",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
    busy: true,
  });
  const result = await sendToAgent(fake.paseo, { plan, confirmed: true, queueTimeoutMs: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "busy");
  assert.equal(fake.state.sent.length, 0);
});

test("显式 interrupt 只有确认后才带打断参数", async () => {
  const fake = fakeSend({ busy: true });
  const plan = planSessionSend({
    action: "fix",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
    busy: true,
    sendMode: "interrupt",
  });
  const refused = await sendToAgent(fake.paseo, { plan });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "confirmation-required");

  const sent = await sendToAgent(fake.paseo, { plan, confirmed: true });
  assert.equal(sent.ok, true);
  assert.equal(fake.state.waits, 0);
  assert.equal(fake.state.sent[0].options.activeTurnBehavior, "interrupt");
});

test("目标会话不存在时返回 not-found", async () => {
  const fake = fakeSend();
  fake.handle.refresh = async () => null;
  const plan = planSessionSend({
    action: "fix",
    ctx: ticketCtx,
    target: { kind: "current", agentId: "agent-1" },
  });
  const result = await sendToAgent(fake.paseo, { plan });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-found");
});

test("copy 目标不碰任何会话", async () => {
  const plan = planSessionSend({
    action: "handoff",
    ctx: ticketCtx,
    target: { kind: "copy" },
  });
  const result = await sendToAgent({}, { plan });
  assert.equal(result.ok, true);
  assert.equal(result.target, "copy");
  assert.equal(result.prompt.split("\n")[0], "/handoff");
});

test("new 目标经 createAgent 带上提示词与标题", async () => {
  const fake = fakeCreate({ id: "agent-created" });
  const plan = planSessionSend({
    action: "fix",
    ctx: { lang: "en", provider: "codex", repoKey: "o/r", number: 3, title: "崩溃" },
    target: { kind: "new", cwd: "/repo" },
  });
  const result = await sendToAgent(fake.paseo, { plan, provider: "codex", ledger: false });
  assert.equal(result.ok, true);
  assert.equal(result.target, "new");
  assert.equal(result.agentId, "agent-created");
  assert.equal(result.partial, false);
  assert.equal(result.skillAvailable, null);
  const options = fake.calls[0];
  assert.equal(options.config.provider, "codex");
  assert.equal(options.prompt, plan.prompt);
  assert.equal(options.title, plan.title);
  assert.equal(options.idempotencyKey, plan.idempotencyKey);
  assert.ok(Array.from(options.title).length <= SESSION_TITLE_MAX_CHARS);
});

test("new 目标缺少 provider 时返回 invalid-target", async () => {
  const plan = planSessionSend({
    action: "fix",
    ctx: ticketCtx,
    target: { kind: "new", cwd: "/repo" },
  });
  const result = await sendToAgent(fakeCreate().paseo, { plan, provider: "" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-target");
});

// ---------------------------------------------------------------------------
// 服务端：handoff 落盘
// ---------------------------------------------------------------------------

test("writeHandoff 渲染并保存，失败时仍可只渲染", async () => {
  const root = tempRoot();
  const saved = await writeHandoff({
    handoff: { lang: "en", title: "Diagnose #1", summary: "done" },
    ledger: { homeDir: root, agentId: "agent-1" },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.saved, true);
  assert.ok(existsSync(saved.path));
  assert.match(saved.name, /\.md$/);

  const rendered = await writeHandoff({ handoff: { lang: "en" }, ledger: false });
  assert.equal(rendered.ok, true);
  assert.equal(rendered.saved, false);
  assert.equal(rendered.path, null);

  const invalid = await writeHandoff({ handoff: null, ledger: false });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid-handoff");
});

test("可见输入框兜底：空框才写，已有正文不动，已相同视为成功", () => {
  assert.equal(composerFillDecision("", "提示词"), "fill");
  assert.equal(composerFillDecision("   ", "提示词"), "fill");
  assert.equal(composerFillDecision("用户正在写", "提示词"), "keep");
  assert.equal(composerFillDecision("提示词", "提示词"), "keep");
  assert.equal(composerFillDecision("", "   "), "keep");
});
