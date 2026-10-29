import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { saveClientSite } from "../server/orchestration.ts";
import { readSiteBook, sitesFile, updateSiteBook } from "../server/sites-store.ts";
import {
  enabledSiteOf,
  normalizeBaseUrl,
  normalizeSiteId,
  siteIdProblem,
  siteUrlProblem,
  withSite,
  withoutSite,
  EMPTY_SITE_BOOK,
} from "../shared/sites.ts";

/**
 * 客户端下的站点：一个客户端准备几条地址 + 凭证，**同一时刻只有一条生效**。
 *
 * 这里钉的是四件事：
 * 1. 「启用」真的写宿主配置（这个客户端的新会话都走它），而且只写地址与凭证两个键；
 * 2. 「现在生效的是哪条」从宿主配置反推，不另存开关——宿主里手改地址后界面不会说谎；
 * 3. 凭证明文只落在 `sites.json`（0600），回给界面的一律是掩码；
 * 4. 删站不动宿主配置，坏文件不静默当空表。
 */

async function tempHome() {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-sites-"));
  process.env.PASEO_HOME = dir;
  return dir;
}

/** 内存里存一份线上形状的配置；`patch` 按宿主的行为深合并。 */
function fakePaseo(initial) {
  let current = structuredClone(initial);
  const patches = [];
  return {
    patches,
    get config() {
      return {
        get: async () => ({ config: structuredClone(current) }),
        patch: async (patch) => {
          patches.push(structuredClone(patch));
          current = merge(current, patch);
          return { config: structuredClone(current) };
        },
      };
    },
    disk: () => structuredClone(current),
  };
}

function merge(target, patch) {
  if (!patch || typeof patch !== "object") return patch;
  const out = Array.isArray(target) ? [...target] : { ...(target ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) out[key] = merge(out[key], value);
    else out[key] = value;
  }
  return out;
}

const baseConfig = () => ({
  providers: {
    claude: {
      env: {
        ANTHROPIC_BASE_URL: "http://192.168.88.12:8083",
        ANTHROPIC_AUTH_TOKEN: "tok-main-1234",
        ANTHROPIC_MODEL: "deepseek-v4.1-flash",
      },
    },
  },
});

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("站点 id：归一成小写连字符，形状不对要给得出话", () => {
  assert.equal(normalizeSiteId("  Backup Line  "), "backup-line");
  assert.equal(normalizeSiteId("a/b"), "a-b");
  assert.match(siteIdProblem("", []), /不能为空/);
  assert.match(siteIdProblem("Site1", []), /小写字母开头/);
  assert.match(siteIdProblem("main", ["main"]), /已经有站点 main/);
  assert.equal(siteIdProblem("backup", ["main"]), null);
});

test("接入地址：去掉尾部斜杠，只认 http/https", () => {
  assert.equal(normalizeBaseUrl("  https://a.test/  "), "https://a.test");
  assert.equal(normalizeBaseUrl("https://a.test///"), "https://a.test");
  assert.equal(siteUrlProblem("https://a.test"), null);
  assert.equal(siteUrlProblem("http://a.test:8083"), null);
  assert.match(siteUrlProblem(""), /不能为空/);
  assert.match(siteUrlProblem("ftp://a.test"), /只支持 http\/https/);
  assert.match(siteUrlProblem("a.test"), /只支持 http\/https/);
});

test("加站 / 删站：不可变，删到最后一条不留空壳", () => {
  const one = withSite(EMPTY_SITE_BOOK, "claude", { id: "main", baseUrl: "https://a.test", credential: "" });
  const two = withSite(one, "claude", { id: "backup", baseUrl: "https://b.test", credential: "k" });
  assert.deepEqual(EMPTY_SITE_BOOK.providers, {}, "入参没被改");
  assert.deepEqual(one.providers.claude.map((site) => site.id), ["main"]);
  assert.deepEqual(two.providers.claude.map((site) => site.id), ["main", "backup"]);

  // 同 id 覆盖而不是追加，位置不变。
  const edited = withSite(two, "claude", { id: "main", baseUrl: "https://a2.test", credential: "" });
  assert.deepEqual(edited.providers.claude.map((site) => site.id), ["main", "backup"]);
  assert.equal(edited.providers.claude[0].baseUrl, "https://a2.test");

  const afterOne = withoutSite(edited, "claude", "main");
  assert.deepEqual(afterOne.providers.claude.map((site) => site.id), ["backup"]);
  const empty = withoutSite(afterOne, "claude", "backup");
  assert.deepEqual(empty.providers, {}, "最后一条删掉，客户端整条拿掉");
});

test("哪条在生效：地址一致 + 凭证一致（或站点没存凭证）才算", () => {
  const sites = [
    { id: "main", baseUrl: "https://a.test", credential: "tok-a" },
    { id: "backup", baseUrl: "https://b.test", credential: "tok-b" },
    { id: "inherit", baseUrl: "https://c.test", credential: "" },
  ];
  assert.equal(enabledSiteOf(sites, { baseUrl: "https://a.test", credential: "tok-a" })?.id, "main");
  assert.equal(enabledSiteOf(sites, { baseUrl: "https://a.test/", credential: "tok-a" })?.id, "main", "尾部斜杠不算另一种地址");
  assert.equal(
    enabledSiteOf(sites, { baseUrl: "https://a.test", credential: "tok-other" }),
    null,
    "地址一样、凭证不一样：会话用的是另一把钥匙，不能说「就是这条」",
  );
  assert.equal(enabledSiteOf(sites, { baseUrl: "https://c.test", credential: "whatever" })?.id, "inherit");
  assert.equal(enabledSiteOf(sites, { baseUrl: "https://d.test", credential: "tok-a" }), null);
  assert.equal(enabledSiteOf(sites, { baseUrl: null, credential: null }), null);
});

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

test("没有文件 = 空表，不是错误", async () => {
  await tempHome();
  const read = await readSiteBook();
  assert.equal(read.ok, true);
  assert.deepEqual(read.book.providers, {});
});

test("坏文件报错，不静默当空表", async () => {
  const home = await tempHome();
  const file = sitesFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{ 不是 json", "utf8");
  const read = await readSiteBook(home);
  assert.equal(read.ok, false);
  assert.match(read.detail, /解析失败/);
});

test("写盘是原子的且 0600：并发两次点击都留在文件里", async () => {
  const home = await tempHome();
  const first = await updateSiteBook((book) => withSite(book, "claude", { id: "main", baseUrl: "https://a.test", credential: "tok-a" }), home);
  assert.equal(first.ok, true);
  // 两次写并发发出：写路线串行，谁也不会把对方刚写的条目冲掉。
  await Promise.all([
    updateSiteBook((book) => withSite(book, "claude", { id: "backup", baseUrl: "https://b.test", credential: "tok-b" }), home),
    updateSiteBook((book) => withSite(book, "codex", { id: "main", baseUrl: "https://c.test", credential: "k" }), home),
  ]);
  const read = await readSiteBook(home);
  assert.deepEqual(read.book.providers.claude.map((site) => site.id), ["main", "backup"]);
  assert.deepEqual(read.book.providers.codex.map((site) => site.id), ["main"]);

  const file = sitesFile(home);
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, "里面是凭证明文，只能自己读");
  assert.match(await readFile(file, "utf8"), /tok-a/);
});

// ---------------------------------------------------------------------------
// 加 / 启用 / 删
// ---------------------------------------------------------------------------

test("加站点：只落盘，不动宿主配置", async () => {
  await tempHome();
  const paseo = fakePaseo(baseConfig());
  const result = await saveClientSite(paseo, {
    provider: "claude",
    site: { id: "backup", label: "备线", baseUrl: "https://b.test/", credential: "tok-b" },
  });
  assert.equal(result.ok, true);
  assert.equal(paseo.patches.length, 0, "存站不是启用：宿主配置一个字都不该动");
  assert.equal(result.sites.length, 1);
  assert.equal(result.sites[0].baseUrl, "https://b.test");
  assert.equal(result.sites[0].credentialMasked.includes("tok-b"), false, "回给界面的只有掩码");
  assert.equal(result.sites[0].hasCredential, true);
  assert.equal(result.enabledSiteId, null, "宿主里还是老地址，一条都没启用");
});

test("启用：把地址与凭证写进客户端自己的 env，其它键原样留着", async () => {
  await tempHome();
  const paseo = fakePaseo(baseConfig());
  await saveClientSite(paseo, { provider: "claude", site: { id: "backup", baseUrl: "https://b.test", credential: "tok-b" } });
  const enabled = await saveClientSite(paseo, { provider: "claude", enableId: "backup" });
  assert.equal(enabled.ok, true);
  assert.equal(paseo.patches.length, 1);
  assert.deepEqual(paseo.patches[0].providers.claude.env, {
    // 宿主落盘时 env 是整块替换：只交新键会把别的键冲掉，所以原值必须一起带上。
    ANTHROPIC_BASE_URL: "https://b.test",
    ANTHROPIC_AUTH_TOKEN: "tok-b",
    ANTHROPIC_MODEL: "deepseek-v4.1-flash",
  });
  assert.equal(enabled.enabledSiteId, "backup");
});

test("换一条启用：宿主里永远只有一份地址", async () => {
  await tempHome();
  const paseo = fakePaseo(baseConfig());
  await saveClientSite(paseo, { provider: "claude", site: { id: "backup", baseUrl: "https://b.test", credential: "tok-b" } });
  await saveClientSite(paseo, { provider: "claude", enableId: "backup" });
  // `main` 还没存成站点时不能启用它：站点表里没有这一条，猜不得。
  const tooEarly = await saveClientSite(paseo, { provider: "claude", enableId: "main" });
  assert.deepEqual([tooEarly.ok, tooEarly.reason], [false, "not-found"]);
  // 先把当前地址存成一条站点，再切回来：这才是界面上真实会发生的路径。
  const main = await saveClientSite(paseo, {
    provider: "claude",
    site: { id: "main", baseUrl: "http://192.168.88.12:8083", credential: "tok-main-1234" },
  });
  assert.equal(main.ok, true);
  assert.equal(main.enabledSiteId, "backup", "只是存了一条记录：宿主还在 backup 上，界面不能谎报");
  const toMain = await saveClientSite(paseo, { provider: "claude", enableId: "main" });
  assert.equal(toMain.enabledSiteId, "main");
  assert.equal(paseo.disk().providers.claude.env.ANTHROPIC_BASE_URL, "http://192.168.88.12:8083");
  assert.equal(paseo.disk().providers.claude.env.ANTHROPIC_AUTH_TOKEN, "tok-main-1234");
  assert.equal(paseo.disk().providers.claude.env.ANTHROPIC_MODEL, "deepseek-v4.1-flash", "换站不碰模型键");
});

test("站点没填凭证：只换地址，客户端的凭证原样保留", async () => {
  await tempHome();
  const paseo = fakePaseo(baseConfig());
  await saveClientSite(paseo, { provider: "claude", site: { id: "inherit", baseUrl: "https://c.test" } });
  const enabled = await saveClientSite(paseo, { provider: "claude", enableId: "inherit" });
  assert.equal(enabled.ok, true);
  assert.equal(paseo.disk().providers.claude.env.ANTHROPIC_BASE_URL, "https://c.test");
  assert.equal(paseo.disk().providers.claude.env.ANTHROPIC_AUTH_TOKEN, "tok-main-1234", "凭证没被清空");
  assert.equal(enabled.enabledSiteId, "inherit");
  assert.deepEqual(enabled.warnings, [], "凭证在，不该有「会起不来」的警告");
});

test("删站点：只删记录，宿主配置不动", async () => {
  await tempHome();
  const paseo = fakePaseo(baseConfig());
  await saveClientSite(paseo, { provider: "claude", site: { id: "backup", baseUrl: "https://b.test", credential: "tok-b" } });
  await saveClientSite(paseo, { provider: "claude", enableId: "backup" });
  const before = paseo.patches.length;
  const removed = await saveClientSite(paseo, { provider: "claude", removeId: "backup" });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.sites, []);
  assert.equal(paseo.patches.length, before, "删站不该再写一次宿主配置");
  assert.equal(paseo.disk().providers.claude.env.ANTHROPIC_BASE_URL, "https://b.test", "宿主仍然指着那条地址");
  assert.match(removed.warnings.join("\n"), /宿主里 .* 的地址与凭证没动/);
});

test("拒绝：重复 id、坏地址、启用不存在的站点", async () => {
  await tempHome();
  const paseo = fakePaseo(baseConfig());
  await saveClientSite(paseo, { provider: "claude", site: { id: "main", baseUrl: "https://a.test" } });
  const dup = await saveClientSite(paseo, { provider: "claude", site: { id: "main", baseUrl: "https://b.test" } });
  assert.equal(dup.ok, true, "同 id 是覆盖，不算重复");
  const bad = await saveClientSite(paseo, { provider: "claude", site: { id: "x", baseUrl: "nope" } });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "invalid");
  const missing = await saveClientSite(paseo, { provider: "claude", enableId: "ghost" });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "not-found");
  const ghostRemove = await saveClientSite(paseo, { provider: "claude", removeId: "ghost" });
  assert.equal(ghostRemove.ok, false);
  assert.equal(ghostRemove.reason, "not-found");
  assert.equal(paseo.patches.length, 0, "被拒的请求一次都没写宿主");
});

test("客户端在配置里还没有条目：第一次启用就该把它建出来", async () => {
  await tempHome();
  const paseo = fakePaseo({ providers: {} });
  await saveClientSite(paseo, { provider: "claude", site: { id: "main", baseUrl: "https://a.test", credential: "tok-a" } });
  const enabled = await saveClientSite(paseo, { provider: "claude", enableId: "main" });
  assert.equal(enabled.ok, true);
  // 客户端一个键都没有时，凭据写在哪把键上按前缀给默认（`ANTHROPIC_API_KEY`）——
  // 与面板里「改凭证」用的是同一条规则（`envKeysFor`），不在这里另立一套。
  assert.deepEqual(paseo.disk().providers.claude.env, {
    ANTHROPIC_BASE_URL: "https://a.test",
    ANTHROPIC_API_KEY: "tok-a",
  });
  assert.equal(enabled.enabledSiteId, "main");
});
