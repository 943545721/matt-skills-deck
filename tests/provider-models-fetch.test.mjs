import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endpointAuthOf,
  modelListUrls,
  parseModelList,
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
  assert.deepEqual(parseModelList({ data: [{ id: "a" }, { id: "b" }] }), ["a", "b"]);
  assert.deepEqual(parseModelList({ models: [{ name: "a" }, "b"] }), ["a", "b"]);
  assert.deepEqual(parseModelList([{ id: "a" }, { model: "b" }]), ["a", "b"]);
  assert.deepEqual(parseModelList({ data: [{ id: "a" }, { id: "a" }] }), ["a"], "去重");
  assert.deepEqual(parseModelList({ data: [{ id: "  a  " }, {}] }), ["a"], "空白与无 id 的丢掉");
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
  assert.deepEqual(result.models, ["deepseek-v4.1-flash", "glm-5.3-flash"]);
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
