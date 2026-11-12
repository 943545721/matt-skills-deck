import assert from "node:assert/strict";
import test from "node:test";
import {
  cachedModelWindowsOf,
  emptyModelWindowCache,
  modelWindowMap,
  normalizeModelWindowBaseUrl,
  parseModelWindowCache,
  parseModelWindowCacheChecked,
  rememberFetchedModelWindows,
  withCachedWindows,
} from "../shared/model-window-cache.ts";

/**
 * 接口窗口缓存：宿主保存模型时会裁掉 `contextWindowMaxTokens`，
 * 所以最近一次接口报的窗口要按「provider + 接口地址」单独留一份。
 *
 * 这里钉三件事：
 * - 只留正数窗口，坏条目丢掉，不编窗口；
 * - 地址换了就不套旧窗口（不能让新接口按旧接口的上限压缩）；
 * - 合并时不改入参，缓存里没有的模型原样保留。
 */

test("地址归一：去空白与尾部斜杠", () => {
  assert.equal(normalizeModelWindowBaseUrl("  https://api.example.test/v1/  "), "https://api.example.test/v1");
  assert.equal(normalizeModelWindowBaseUrl("https://api.example.test///"), "https://api.example.test");
});

test("地址归一：不把内嵌凭据、查询串与锚点留在缓存里", () => {
  // 地址本身不是机密，但用户可能把 token 塞进 userinfo 或 query：缓存文件是明文落盘的。
  assert.equal(
    normalizeModelWindowBaseUrl("https://user:pass@api.example.test/v1?key=sk-secret#frag"),
    "https://api.example.test/v1",
  );
  assert.equal(normalizeModelWindowBaseUrl(""), "");
  assert.equal(normalizeModelWindowBaseUrl("not a url/"), "not a url");
});

test("解析缓存：形状不对退回空缓存，坏条目逐条丢掉", () => {
  assert.deepEqual(parseModelWindowCache(null), emptyModelWindowCache());
  assert.deepEqual(parseModelWindowCache({ version: 2, providers: {} }), emptyModelWindowCache());
  const parsed = parseModelWindowCache({
    version: 1,
    providers: {
      claude: {
        baseUrl: " https://api.example.test/v1/ ",
        models: [
          { id: " a ", contextWindowMaxTokens: 128000 },
          { id: "zero", contextWindowMaxTokens: 0 },
          { id: "nan", contextWindowMaxTokens: Number.NaN },
          { id: "text", contextWindowMaxTokens: "128000" },
          { id: "dup", contextWindowMaxTokens: 64000 },
          { id: "dup", contextWindowMaxTokens: 32000 },
          { label: "没有 id" },
          null,
        ],
      },
      empty: { baseUrl: "", models: [] },
      "  ": { baseUrl: "https://x.test", models: [] },
    },
  });
  assert.deepEqual(parsed.providers.claude, {
    baseUrl: "https://api.example.test/v1",
    models: [
      { id: "a", contextWindowMaxTokens: 128000 },
      { id: "dup", contextWindowMaxTokens: 64000 },
    ],
  });
  assert.equal(parsed.providers.empty, undefined, "没有地址的条目没法匹配，丢掉");
  assert.equal(parsed.providers[""], undefined);
});

test("缓存文件里的危险 provider 名：解析、记取、查询都不认，防止原型污染", () => {
  // JSON.parse 会建出真正的自有 `__proto__` 键（对象字面量不会），正好模拟坏文件。
  const parsed = parseModelWindowCache(
    JSON.parse(
      '{"version":1,"providers":{"__proto__":{"baseUrl":"https://x.test","models":[{"id":"a","contextWindowMaxTokens":128000}]},"constructor":{"baseUrl":"https://y.test","models":[{"id":"b","contextWindowMaxTokens":64000}]}}}',
    ),
  );
  assert.deepEqual(parsed.providers, {});
  assert.equal({}.contextWindowMaxTokens, undefined, "原型没被改");

  const remembered = rememberFetchedModelWindows(emptyModelWindowCache(), {
    provider: "__proto__",
    baseUrl: "https://x.test",
    models: [{ id: "a", contextWindowMaxTokens: 128000 }],
  });
  assert.deepEqual(remembered.providers, {});
  assert.deepEqual(cachedModelWindowsOf(remembered, "__proto__", "https://x.test"), []);
  assert.deepEqual(cachedModelWindowsOf(remembered, "constructor", "https://x.test"), []);
});

test("记一次拉取：同一个 provider 整条替换，旧窗口不残留", () => {
  const first = rememberFetchedModelWindows(emptyModelWindowCache(), {
    provider: "claude",
    baseUrl: "https://api.example.test/v1/",
    models: [
      { id: "a", contextWindowMaxTokens: 128000 },
      { id: "no-window" },
    ],
  });
  assert.deepEqual(first.providers.claude.models, [{ id: "a", contextWindowMaxTokens: 128000 }]);

  const second = rememberFetchedModelWindows(first, {
    provider: "claude",
    baseUrl: "https://api.example.test/v1",
    models: [{ id: "b", contextWindowMaxTokens: 96000 }],
  });
  assert.deepEqual(second.providers.claude.models, [{ id: "b", contextWindowMaxTokens: 96000 }]);
  assert.deepEqual(first.providers.claude.models, [{ id: "a", contextWindowMaxTokens: 128000 }], "不改入参");
});

test("记一次拉取：只替换这个 provider，别的 provider 的窗口留着", () => {
  const claude = rememberFetchedModelWindows(emptyModelWindowCache(), {
    provider: "claude",
    baseUrl: "https://a.test",
    models: [{ id: "a", contextWindowMaxTokens: 128000 }],
  });
  const both = rememberFetchedModelWindows(claude, {
    provider: "codex",
    baseUrl: "https://b.test",
    models: [{ id: "b", contextWindowMaxTokens: 64000 }],
  });
  assert.deepEqual(cachedModelWindowsOf(both, "claude", "https://a.test"), [{ id: "a", contextWindowMaxTokens: 128000 }]);
  assert.deepEqual(cachedModelWindowsOf(both, "codex", "https://b.test"), [{ id: "b", contextWindowMaxTokens: 64000 }]);
});

test("同一个 provider 换了接口：旧地址的窗口不再命中", () => {
  const first = rememberFetchedModelWindows(emptyModelWindowCache(), {
    provider: "claude",
    baseUrl: "https://old.test",
    models: [{ id: "a", contextWindowMaxTokens: 128000 }],
  });
  const second = rememberFetchedModelWindows(first, {
    provider: "claude",
    baseUrl: "https://new.test",
    models: [{ id: "a", contextWindowMaxTokens: 96000 }],
  });
  assert.deepEqual(cachedModelWindowsOf(second, "claude", "https://old.test"), []);
  assert.deepEqual(cachedModelWindowsOf(second, "claude", "https://new.test"), [
    { id: "a", contextWindowMaxTokens: 96000 },
  ]);
});

test("接口这次没报窗口：写一条空清单，表示「现在没有」，而不是沿用上次", () => {
  const cache = rememberFetchedModelWindows(emptyModelWindowCache(), {
    provider: "claude",
    baseUrl: "https://api.example.test/v1",
    models: [{ id: "a", contextWindowMaxTokens: 128000 }],
  });
  const next = rememberFetchedModelWindows(cache, {
    provider: "claude",
    baseUrl: "https://api.example.test/v1",
    models: [{ id: "a" }],
  });
  assert.deepEqual(next.providers.claude.models, []);
});

test("取窗口：provider 与地址都要对上；任一不对就当没有缓存", () => {
  const cache = rememberFetchedModelWindows(emptyModelWindowCache(), {
    provider: "claude",
    baseUrl: "https://api.example.test/v1",
    models: [{ id: "a", contextWindowMaxTokens: 128000 }],
  });
  assert.deepEqual(
    cachedModelWindowsOf(cache, "claude", "https://api.example.test/v1/"),
    [{ id: "a", contextWindowMaxTokens: 128000 }],
  );
  assert.deepEqual(cachedModelWindowsOf(cache, "codex", "https://api.example.test/v1"), [], "provider 不同");
  assert.deepEqual(cachedModelWindowsOf(cache, "claude", "https://other.example.test/v1"), [], "换了接口");
  assert.deepEqual(cachedModelWindowsOf(cache, "claude", ""), []);
});

test("合并窗口：缓存优先，缓存里没有的原样保留，不改入参", () => {
  const models = [
    { id: "a", label: "A", contextWindowMaxTokens: 32000 },
    { id: "b", label: "B" },
  ];
  const cached = [{ id: "a", contextWindowMaxTokens: 128000 }];
  assert.deepEqual(withCachedWindows(models, cached), [
    { id: "a", label: "A", contextWindowMaxTokens: 128000 },
    { id: "b", label: "B" },
  ]);
  assert.deepEqual(models, [
    { id: "a", label: "A", contextWindowMaxTokens: 32000 },
    { id: "b", label: "B" },
  ]);
  assert.deepEqual(withCachedWindows(models, []), models);
  assert.notEqual(withCachedWindows(models, []), models, "没有缓存也返回新数组");
});

test("形状不认识要能分辨出来：版本不符、providers 不是对象都算看不懂", () => {
  // 读盘那侧要分清「文件里本来没有」和「文件不认识」：后者要告警，否则文件坏了也一声不吭。
  assert.equal(parseModelWindowCacheChecked({ version: 1, providers: {} }).malformed, false);
  assert.equal(parseModelWindowCacheChecked({ version: 2, providers: {} }).malformed, true);
  assert.equal(parseModelWindowCacheChecked({ version: 1, providers: [] }).malformed, true);
  assert.equal(parseModelWindowCacheChecked([]).malformed, true);
  assert.equal(parseModelWindowCacheChecked(null).malformed, true);
  assert.deepEqual(parseModelWindowCacheChecked({ version: 2 }).cache, emptyModelWindowCache(), "看不懂就当没有缓存");
});

test("窗口取整后不足 1 的丢掉，不往配置里写 0", () => {
  const next = rememberFetchedModelWindows(emptyModelWindowCache(), {
    provider: "claude",
    baseUrl: "https://api.example.test",
    models: [
      { id: "tiny", contextWindowMaxTokens: 0.4 },
      { id: "ok", contextWindowMaxTokens: 128000 },
    ],
  });
  assert.deepEqual(next.providers.claude.models, [{ id: "ok", contextWindowMaxTokens: 128000 }]);
});

test("超长地址先归一再截断：截断不会留下半截 userinfo", () => {
  // 反过来（先截断再归一）时，`@` 可能正好被截掉，凭据的一半就留在缓存里了。
  const hugeUser = "u".repeat(5000);
  const parsed = parseModelWindowCache({
    version: 1,
    providers: { claude: { baseUrl: `https://user:${hugeUser}@api.example.test/v1`, models: [] } },
  });
  assert.equal(parsed.providers.claude.baseUrl, "https://api.example.test/v1");
});

test("窗口索引：同一个 id 只留一条，数值可直接用于能力字段", () => {
  assert.deepEqual(
    [...modelWindowMap([
      { id: "a", contextWindowMaxTokens: 128000 },
      { id: "b", contextWindowMaxTokens: 64000 },
    ])],
    [["a", 128000], ["b", 64000]],
  );
});
