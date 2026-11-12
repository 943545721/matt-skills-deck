import assert from "node:assert/strict";
import test from "node:test";
import { TICKET_GUARD_MESSAGE, ticketCommandVerdict } from "../shared/ticket-command-guard.ts";

/**
 * 票闸的 shell 侧只做一件事：认出「用 gh 改票」并拒绝。
 * 这些用例钉的是「哪些命令该拦、哪些必须放过」——多拦一条会把正常排查逼到别的绕法上。
 */

const blocked = (command) => ticketCommandVerdict(command).blocked;

test("建票、关票、改票、评论都拦", () => {
  for (const command of [
    "gh issue create --title x --body y",
    "gh issue close 12",
    "gh issue reopen 12",
    "gh issue edit 12 --add-label ready-for-agent",
    "gh issue comment 12 --body ok",
    "gh issue delete 12",
    "gh issue transfer 12 other/repo",
  ]) {
    assert.equal(blocked(command), true, command);
  }
});

test("gh api 的写方法与带字段的默认 POST 都拦", () => {
  assert.equal(blocked("gh api -X POST repos/o/r/issues -f title=x"), true);
  assert.equal(blocked("gh api --method PATCH repos/o/r/issues/1 -f title=y"), true);
  assert.equal(blocked("gh api --method=DELETE repos/o/r/issues/1"), true);
  assert.equal(blocked("gh api -XPUT repos/o/r/issues/1"), true);
  // 没写方法但带了字段：gh 默认就是 POST。
  assert.equal(blocked("gh api repos/o/r/issues -f title=x"), true);
  assert.equal(blocked("gh api repos/o/r/issues --input body.json"), true);
  // GraphQL 什么都能改，按票面处理。
  assert.equal(blocked("gh api graphql -f query=mutation"), true);
});

test("往 PR / release 上写不归票闸管，别把正常发布也拦了", () => {
  assert.equal(blocked("gh api repos/o/r/pulls/1 -X PATCH -f title=x"), false);
  assert.equal(blocked("gh api repos/o/r/releases -f tag_name=v1"), false);
  assert.equal(blocked("gh api repos/o/r/pulls/1/labels -X POST -f labels[]=x"), false);
  assert.equal(blocked("gh api repos/o/r/issues/1 -X PATCH -f title=x"), true);
});

test("显式写 GET 就是读，字段只是查询参数", () => {
  assert.equal(blocked("gh api -X GET -f q=repo:o/r repos/o/r/issues"), false);
  assert.equal(blocked("gh api --method=GET repos/o/r/issues -f state=open"), false);
});

test("GitLab 后端同样拦：glab 也是同一个口子", () => {
  assert.equal(blocked("glab issue create --title x"), true);
  assert.equal(blocked("glab issue close 12"), true);
  assert.equal(blocked("glab issue note 12 -m ok"), true);
  assert.equal(blocked("glab issue list"), false);
  assert.equal(blocked("glab label delete needs-triage"), true);
});

test("只读的 gh 命令放行", () => {
  for (const command of [
    "gh issue list",
    "gh issue view 12",
    "gh issue list --label ready-for-agent",
    "gh api repos/o/r/issues",
    "gh api -X GET repos/o/r/issues",
    "gh api --method GET repos/o/r/issues/1",
    "gh pr list",
    "gh repo view",
    "git status",
    "npm test",
    "echo gh issue create",
  ]) {
    assert.equal(blocked(command), false, command);
  }
});

test("删标签 / 改标签名要拦；建一个标签定义放行", () => {
  assert.equal(blocked("gh label delete needs-triage"), true);
  assert.equal(blocked("gh label edit ready-for-agent --new-name ready"), true);
  assert.equal(blocked("gh label clone needs-triage copy"), true);
  // 建标签不改变任何一张票，而且票级提示词本来就让用户缺标签时先建。
  assert.equal(blocked("gh label create deck:定稿 --color ff0000"), false);
  assert.equal(blocked("gh label list"), false);
});

test("前缀、env、sudo、路径都绕不过去", () => {
  assert.equal(blocked("GH_TOKEN=xxx gh issue create --title x"), true);
  assert.equal(blocked("sudo gh issue close 12"), true);
  assert.equal(blocked("timeout 30 gh issue create --title x"), true);
  assert.equal(blocked("timeout -s KILL 30 gh issue create --title x"), true);
  assert.equal(blocked("nice -n 5 gh issue create --title x"), true);
  assert.equal(blocked("env -i gh issue create --title x"), true);
  assert.equal(blocked("sudo -u root gh issue create --title x"), true);
  assert.equal(blocked("/usr/bin/gh issue create"), true);
  assert.equal(blocked("cd /repo && gh issue create --title x"), true);
  assert.equal(blocked("gh issue list; gh issue create --title x"), true);
});

test("套一层 shell、eval、命令替换、子 shell 都钻进去看", () => {
  assert.equal(blocked('bash -c "gh issue create --title x"'), true);
  assert.equal(blocked("sh -c 'gh issue close 12'"), true);
  assert.equal(blocked('zsh -c "cd /repo && gh issue create"'), true);
  assert.equal(blocked('eval "gh issue create --title x"'), true);
  assert.equal(blocked("echo $(gh issue create --title x)"), true);
  assert.equal(blocked('echo "$(gh issue create --title x)"'), true);
  assert.equal(blocked("(gh issue create --title x)"), true);
  // 单引号里不展开，照原文看：它不会被当成一条 gh 命令跑。
  assert.equal(blocked("echo '$(gh issue create --title x)'"), false);
  assert.equal(blocked('bash -c "ls"'), false);
});

test("包装词套 shell、合写短选项、全局 -R 都挡得住", () => {
  assert.equal(blocked('sudo bash -c "gh issue create --title x"'), true);
  assert.equal(blocked("timeout 30 sh -c 'gh issue close 12'"), true);
  assert.equal(blocked('env bash -c "gh issue create --title x"'), true);
  assert.equal(blocked('bash -lc "gh issue create --title x"'), true);
  assert.equal(blocked("sudo --user=root gh issue create --title x"), true);
  assert.equal(blocked("gh -R owner/repo issue create --title x"), true);
  assert.equal(blocked("gh --repo=owner/repo issue close 12"), true);
  assert.equal(blocked("glab -R owner/repo issue create --title x"), true);
});

test("同一条复合命令里，读的那段不背写的那段的锅", () => {
  assert.equal(blocked("gh issue list | head -5"), false);
  assert.equal(blocked("gh issue view 3 && git status"), false);
  assert.equal(blocked("gh issue create --title x && gh issue list"), true);
});

test("回给会话的话说清该走哪条路", () => {
  const verdict = ticketCommandVerdict("gh issue create --title x");
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.message, TICKET_GUARD_MESSAGE);
  assert.match(verdict.message, /deck_issue_create/);
  assert.match(verdict.reason, /gh issue create/);
});

test("空命令与不是 gh 的命令不受影响", () => {
  assert.deepEqual(ticketCommandVerdict(""), { blocked: false });
  assert.equal(blocked("grep -rn 'gh issue create' ."), false);
});
