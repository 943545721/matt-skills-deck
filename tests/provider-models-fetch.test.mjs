import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  endpointAuthOf,
  modelListUrls,
  parseModelList,
  providerBaseUrlKey,
} from "../shared/provider-models.ts";
import { fetchProviderModels } from "../server/provider-models-fetch.ts";

/**
 * 「从接口获取模型」这条路。
 *
 * 边界全在错的时候：缺 base url、缺凭据、鉴权被拒、路径 404、网络不通、200 但解析不出。
 * 每一种都要说清楚是哪一种，不能统一报「获取失败」——用户下一步动作完全不同。
 * 另外凭据只进请求头：结果里、报错里都不许出现。
 */

const TOKEN = "sk-ant-very-secret-token-1234";

function fakePaseo(env, overrides = {}) {
  return {
    config: {
      get: overrides.get ?? (async () => ({ config: { providers: { claude: { env } } } })),
      patch: async () => {
        throw new Error("不该被调用");
      },
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("凭据与地址：从 env 里取，不猜别处", () => {
  const auth = endpointAuthOf({
    ANTHROPIC_BASE_URL: "https://api.example.test/",
    ANTHROPIC_AUTH_TOKEN: TOKEN,
  });
  assert.ok(auth);
  assert.equal(auth.baseUrl, "https://api.example.test", "末尾斜杠去掉");
  assert.equal(auth.credentialKey, "ANTHROPIC_AUTH_TOKEN");
  assert.deepEqual(auth.headers, { Authorization: `Bearer ${TOKEN}` });
});

test("凭据键决定认证头：ANTHROPIC_API_KEY 走 x-api-key", () => {
  const auth = endpointAuthOf({ ANTHROPIC_BASE_URL: "https://x.test", ANTHROPIC_API_KEY: "abc123" });
  assert.ok(auth);
  assert.equal(auth.headers["x-api-key"], "abc123");
  assert.equal(auth.headers.Authorization, undefined, "两种头不能一起发");
});

test("地址选取与按地址查缓存的那边一致：首选键优先，不被别的 *_BASE_URL 抢走", () => {
  // Claude 还认 ANTHROPIC_BEDROCK_BASE_URL。它排在前面时若按「第一个像地址的键」取，
  // 清单会从 Bedrock 地址去要、窗口按 Bedrock 地址记，而保存时按 ANTHROPIC_BASE_URL 查，
  // 缓存就永远对不上——两边必须用同一个判断。
  const auth = endpointAuthOf(
    {
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.test",
      ANTHROPIC_BASE_URL: "https://api.example.test",
      ANTHROPIC_AUTH_TOKEN: TOKEN,
    },
    providerBaseUrlKey("claude"),
  );
  assert.ok(auth);
  assert.equal(auth.baseUrl, "https://api.example.test");
  assert.equal(auth.baseUrlKey, "ANTHROPIC_BASE_URL");
});

test("首选键上没有地址时退回第一个像地址的键", () => {
  const auth = endpointAuthOf(
    { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.test", ANTHROPIC_AUTH_TOKEN: TOKEN },
    providerBaseUrlKey("claude"),
  );
  assert.ok(auth);
  assert.equal(auth.baseUrl, "https://bedrock.example.test");
});

test("地址键：认识的客户端有自己的首选键，不认识的交给调用方退回默认", () => {
  assert.equal(providerBaseUrlKey("claude"), "ANTHROPIC_BASE_URL");
  assert.equal(providerBaseUrlKey("CODEX"), "OPENAI_BASE_URL");
  assert.equal(providerBaseUrlKey("deck-codex-site-a"), undefined, "派生条目没有约定，别替它猜");
});

test("凑不齐就不发请求：缺地址、缺凭据都返回 null", () => {
  assert.equal(endpointAuthOf({ ANTHROPIC_AUTH_TOKEN: TOKEN }), null, "没 base url");
  assert.equal(endpointAuthOf({ ANTHROPIC_BASE_URL: "https://x.test" }), null, "没凭据");
  assert.equal(endpointAuthOf({ ANTHROPIC_BASE_URL: "ftp://x.test", ANTHROPIC_AUTH_TOKEN: TOKEN }), null, "不是 http(s)");
  assert.equal(endpointAuthOf({}), null);
});

test("候选路径：base 已带 /v1 就不再拼一遍", () => {
  assert.deepEqual(modelListUrls("https://x.test"), ["https://x.test/v1/models", "https://x.test/models"]);
  assert.deepEqual(modelListUrls("https://x.test/v1"), ["https://x.test/v1/models"]);
  assert.deepEqual(modelListUrls("https://x.test/v1/"), ["https://x.test/v1/models"]);
});

test("回包解析：OpenAI 的 data[].id、models 数组、裸数组都认", () => {
  assert.deepEqual(parseModelList({ data: [{ id: "a" }, { id: "b" }] }).map((model) => model.id), ["a", "b"]);
  assert.deepEqual(parseModelList({ models: [{ name: "a" }, "b"] }).map((model) => model.id), ["a", "b"]);
  assert.deepEqual(parseModelList([{ id: "a" }, { model: "b" }]).map((model) => model.id), ["a", "b"]);
  assert.deepEqual(parseModelList({ data: [{ id: "a" }, { id: "a" }] }).map((model) => model.id), ["a"], "去重");
  assert.deepEqual(parseModelList({ data: [{ id: "  a  " }, {}] }).map((model) => model.id), ["a"], "空白与无 id 的丢掉");
  assert.deepEqual(parseModelList(null), []);
  assert.deepEqual(parseModelList("nope"), []);
});

test("获取：第一个候选就成功时不做多余的请求", async () => {
  const calls = [];
  const result = await fetchProviderModels(
    fakePaseo({ ANTHROPIC_BASE_URL: "https://x.test", ANTHROPIC_AUTH_TOKEN: TOKEN }),
    { provider: "claude" },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: init.headers });
        return jsonResponse({ data: [{ id: "deepseek-v4.1-flash" }, { id: "glm-5.3-flash" }] });
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((model) => model.id), ["deepseek-v4.1-flash", "glm-5.3-flash"]);
  assert.equal(result.endpoint, "https://x.test/v1/models");
  assert.deepEqual(calls.map((call) => call.url), ["https://x.test/v1/models"]);
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`, "凭据只进请求头");
  assert.equal(JSON.stringify(result).includes(TOKEN), false, "凭据不能出现在回包里");
});

test("获取：第一个路径 404 时试下一个", async () => {
  const urls = [];
  const result = await fetchProviderModels(
    fakePaseo({ OPENAI_BASE_URL: "https://y.test", OPENAI_API_KEY: "k-1234567890" }),
    { provider: "claude" },
    {
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.endsWith("/v1/models")) return new Response("not found", { status: 404 });
        return jsonResponse({ models: ["m1"] });
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.endpoint, "https://y.test/models");
  assert.deepEqual(urls, ["https://y.test/v1/models", "https://y.test/models"]);
});

test("获取：鉴权被拒要说清是哪个键被拒，且不泄露值", async () => {
  const result = await fetchProviderModels(
    fakePaseo({ ANTHROPIC_BASE_URL: "https://x.test", ANTHROPIC_AUTH_TOKEN: TOKEN }),
    { provider: "claude" },
    { fetchImpl: async () => new Response("unauthorized", { status: 401 }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unauthorized");
  assert.match(result.detail, /ANTHROPIC_AUTH_TOKEN/);
  assert.equal(result.detail.includes(TOKEN), false);
});

test("获取：非 404 的 HTTP 错误带回状态码与正文片段（抹掉凭据形状）", async () => {
  const result = await fetchProviderModels(
    fakePaseo({ ANTHROPIC_BASE_URL: "https://x.test", ANTHROPIC_AUTH_TOKEN: TOKEN }),
    { provider: "claude" },
    {
      fetchImpl: async () =>
        new Response(`quota exhausted for ${TOKEN}`, { status: 429 }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "http");
  assert.match(result.detail, /429/);
  assert.match(result.detail, /quota exhausted/);
  assert.equal(result.detail.includes(TOKEN), false, "回显的凭据要抹掉");
});

test("获取：网络错误与「200 但解析不出」分开报", async () => {
  const offline = await fetchProviderModels(
    fakePaseo({ ANTHROPIC_BASE_URL: "https://x.test", ANTHROPIC_AUTH_TOKEN: TOKEN }),
    { provider: "claude" },
    {
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND x.test");
      },
    },
  );
  assert.equal(offline.ok, false);
  assert.equal(offline.reason, "network");
  assert.match(offline.detail, /ENOTFOUND/);

  const empty = await fetchProviderModels(
    fakePaseo({ ANTHROPIC_BASE_URL: "https://x.test", ANTHROPIC_AUTH_TOKEN: TOKEN }),
    { provider: "claude" },
    { fetchImpl: async () => jsonResponse({ whatever: true }) },
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "bad-payload");
});

test("获取：缺 base url / 缺凭据分别报，不试公开端点", async () => {
  let called = false;
  const noUrl = await fetchProviderModels(
    fakePaseo({ ANTHROPIC_AUTH_TOKEN: TOKEN }),
    { provider: "claude" },
    { fetchImpl: async () => {
      called = true;
      return jsonResponse({ data: [] });
    } },
  );
  assert.equal(noUrl.ok, false);
  assert.equal(noUrl.reason, "no-endpoint");
  assert.equal(called, false, "凑不齐就不该发请求");

  const noCred = await fetchProviderModels(
    fakePaseo({ ANTHROPIC_BASE_URL: "https://x.test" }),
    { provider: "claude" },
    { fetchImpl: async () => jsonResponse({ data: [] }) },
  );
  assert.equal(noCred.ok, false);
  assert.equal(noCred.reason, "no-credential");
});

test("获取：配置读不到时不猜，直接说读不到", async () => {
  const result = await fetchProviderModels(
    fakePaseo({}, {
      get: async () => {
        throw new Error("daemon 未连接");
      },
    }),
    { provider: "claude" },
    { fetchImpl: async () => jsonResponse({ data: [{ id: "x" }] }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "config-failed");
});

test("获取：没给 provider 直接拒绝", async () => {
  const result = await fetchProviderModels(fakePaseo({}), { provider: "   " });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
});

test("获取成功：按工作区与接口地址缓存窗口，且不把凭据写进缓存", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "deck-window-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await fetchProviderModels(
    fakePaseo({ ANTHROPIC_BASE_URL: "https://x.test/v1/", ANTHROPIC_AUTH_TOKEN: TOKEN }),
    { provider: "claude", workspaceDir: dir },
    {
      fetchImpl: async () => jsonResponse({
        data: [
          { id: "auto/gpt-6-astra", context_window: 128000 },
          { id: "no-window" },
        ],
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.cacheWarning, undefined, "写成功就不该告警");
  const raw = await readFile(join(dir, ".deck", "model-windows.json"), "utf8");
  assert.doesNotMatch(raw, new RegExp(TOKEN), "凭据不能进缓存文件");
  const cache = JSON.parse(raw);
  assert.deepEqual(cache, {
    version: 1,
    providers: {
      claude: {
        baseUrl: "https://x.test/v1",
        models: [{ id: "auto/gpt-6-astra", contextWindowMaxTokens: 128000 }],
      },
    },
  });
});

test("获取成功但缓存写不进去：照样返回模型清单", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "deck-window-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 用一个普通文件占住 `.deck` 的位置：落盘会失败，但这次拉取已经成功了。
  await writeFile(join(dir, ".deck"), "not a directory", "utf8");
  const result = await fetchProviderModels(
    fakePaseo({ ANTHROPIC_BASE_URL: "https://x.test", ANTHROPIC_AUTH_TOKEN: TOKEN }),
    { provider: "claude", workspaceDir: dir },
    {
      fetchImpl: async () => jsonResponse({ data: [{ id: "a", context_window: 128000 }] }),
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((model) => model.id), ["a"]);
  assert.match(result.cacheWarning ?? "", /\.deck.*model-windows\.json|model-windows\.json/);
  assert.doesNotMatch(result.cacheWarning ?? "", new RegExp(TOKEN), "缓存告警也不能带凭据");
});
