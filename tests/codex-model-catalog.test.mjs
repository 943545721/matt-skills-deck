import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexCatalog,
  bundledCodexModels,
  catalogModelInputsOf,
  hasReportedWindows,
} from "../shared/codex-model-catalog.ts";
import {
  CODEX_CATALOG_FILE,
  catalogPathOfCommand,
  codexCatalogPath,
  codexCommandWithCatalog,
  readBundledCodexCatalog,
  resetCodexCatalogCache,
  writeCodexModelCatalog,
} from "../server/codex-model-catalog.ts";

/**
 * Codex 模型目录（`model_catalog_json`）。
 *
 * 钉的是那条实测出来的因果链：代理模型名不在 Codex 目录里 → 窗口退回内置默认
 * （272000 × 95% = 258400）→ 自动压缩阈值跟着放大 → 先撞接口的上限，报「ran out of room」。
 * 所以这里每条断言都在问同一个问题：**接口报的窗口有没有真的落进那份目录**。
 */

/** 内置目录的最小可辨认形状：Codex 认的就是这份清单里的 `slug` 与窗口。 */
const bundled = () => ({
  models: [
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      description: "Frontier intelligence",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low", description: "Fast" }],
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 2,
      model_messages: { persistent_instructions: "只有这条模型才该看到的提示" },
      comp_hash: "abc123",
      context_window: 272000,
      max_context_window: 872000,
      effective_context_window_percent: 95,
      base_instructions: "你是编码 agent",
    },
    { slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 272000, max_context_window: 272000, comp_hash: "d" },
  ],
});

const entriesOf = (catalog) => catalog.models;

test("目录：接口报过窗口的模型名落进目录，窗口与最大窗口都按接口走", () => {
  const catalog = buildCodexCatalog(bundled(), [
    { id: "group/site8083", label: "codex-gpt模型", contextWindowMaxTokens: 128000 },
  ]);
  assert.ok(catalog, "有窗口就该合出一份目录");
  const entry = entriesOf(catalog).find((item) => item.slug === "group/site8083");
  assert.ok(entry, "代理模型名必须出现在目录里，否则 Codex 还是按默认窗口算");
  assert.equal(entry.context_window, 128000);
  assert.equal(entry.max_context_window, 128000, "最大窗口不跟着缩，会话就能被放到 872k");
  assert.equal(entry.display_name, "codex-gpt模型");
});

test("目录：没报窗口的模型照样出现在目录里，但窗口不动（不编一个出来）", () => {
  const catalog = buildCodexCatalog(bundled(), [{ id: "auto/gpt-6-astra", label: "GPT-6 Astra" }]);
  assert.equal(catalog, null, "一个窗口都没有就不该写目录文件");
  assert.equal(hasReportedWindows([{ id: "x" }]), false);
});

test("目录：内置模型一个都不能丢——原生模型名还得按它自己的窗口跑", () => {
  const catalog = buildCodexCatalog(bundled(), [
    { id: "group/site8083", contextWindowMaxTokens: 128000 },
  ]);
  const slugs = entriesOf(catalog).map((item) => item.slug);
  assert.deepEqual(slugs.slice(0, 2), ["gpt-6-astra", "gpt-5.5"]);
  assert.equal(entriesOf(catalog).find((item) => item.slug === "gpt-6-astra").context_window, 272000);
});

test("目录：同名模型（接口也报了 gpt-6-astra）按接口窗口改写，不额外多出一条", () => {
  const catalog = buildCodexCatalog(bundled(), [
    { id: "gpt-6-astra", contextWindowMaxTokens: 128000 },
  ]);
  const matches = entriesOf(catalog).filter((item) => item.slug === "gpt-6-astra");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].context_window, 128000);
});

test("目录：照模板造的条目不带模板自己的模型专属提示与校验值", () => {
  const catalog = buildCodexCatalog(bundled(), [
    { id: "pool/gpt-6-astra", label: "智元", contextWindowMaxTokens: 128000 },
  ]);
  const entry = entriesOf(catalog).find((item) => item.slug === "pool/gpt-6-astra");
  assert.equal(entry.model_messages, undefined, "模板的持久模式提示不能安到别的模型头上");
  assert.equal(entry.comp_hash, undefined);
  assert.equal(entry.base_instructions, "你是编码 agent", "基础指令要留着：Codex 要求二者其一");
  assert.equal(entry.shell_type, "unified_exec", "模板框架要留着，Codex 按它建会话");
});

test("目录：接口报了思考档位就按接口写，默认档跟着走", () => {
  const catalog = buildCodexCatalog(bundled(), [
    {
      id: "auto/gpt-6-astra",
      contextWindowMaxTokens: 128000,
      defaultThinkingOptionId: "high",
      thinkingOptions: [{ id: "low" }, { id: "high" }, { id: "max" }],
    },
  ]);
  const entry = entriesOf(catalog).find((item) => item.slug === "auto/gpt-6-astra");
  assert.deepEqual(
    entry.supported_reasoning_levels.map((level) => level.effort),
    ["low", "high", "max"],
  );
  assert.equal(entry.default_reasoning_level, "high");
});

test("目录：内置回包形状不对时按空目录处理，不至于抛异常", () => {
  assert.deepEqual(bundledCodexModels(null), []);
  assert.deepEqual(bundledCodexModels({ models: [{ nope: 1 }, "x", 3] }), []);
  assert.equal(buildCodexCatalog({ models: [] }, [{ id: "a", contextWindowMaxTokens: 1000 }]), null);
});

test("落盘：目录文件写在 Codex home 里，回给调用方的就是那个路径", async () => {
  const written = [];
  const result = await writeCodexModelCatalog(
    [{ id: "group/site8083", contextWindowMaxTokens: 128000 }],
    {
      readBundled: async () => bundled(),
      writeFile: async (target, content) => {
        written.push({ target, content });
      },
      catalogPath: () => "/tmp/codex-home/deck-model-catalog.json",
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.path, "/tmp/codex-home/deck-model-catalog.json");
  assert.equal(written.length, 1);
  const parsed = JSON.parse(written[0].content);
  assert.equal(parsed.models.find((item) => item.slug === "group/site8083").context_window, 128000);
});

test("落盘：接口没报窗口就不写文件（写了也只是把默认值抄一遍）", async () => {
  let called = false;
  const result = await writeCodexModelCatalog([{ id: "x" }], {
    readBundled: async () => bundled(),
    writeFile: async () => {
      called = true;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-window");
  assert.equal(called, false);
});

test("落盘：读不到内置目录 / 写不进文件都如实报失败，不让调用方以为目录已生效", async () => {
  const noBundled = await writeCodexModelCatalog([{ id: "a", contextWindowMaxTokens: 128000 }], {
    readBundled: async () => {
      throw new Error("spawn codex ENOENT");
    },
  });
  assert.equal(noBundled.ok, false);
  assert.equal(noBundled.reason, "no-catalog");

  const writeFailed = await writeCodexModelCatalog([{ id: "a", contextWindowMaxTokens: 128000 }], {
    readBundled: async () => bundled(),
    writeFile: async () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(writeFailed.ok, false);
  assert.equal(writeFailed.reason, "write-failed");
});

test("落盘：内置目录缓存过期前不重复跑 codex，重置后重新读", async () => {
  resetCodexCatalogCache();
  let runs = 0;
  const deps = {
    runCodex: async () => {
      runs += 1;
      return JSON.stringify(bundled());
    },
  };
  await readBundledCodexCatalog(deps);
  await readBundledCodexCatalog(deps);
  assert.equal(runs, 1, "一次进程里读一次就够");
  resetCodexCatalogCache();
  await readBundledCodexCatalog(deps);
  assert.equal(runs, 2);
});

test("路径：目录文件跟着 CODEX_HOME 走（宿主起 app-server 用的也是这一份）", () => {
  assert.equal(CODEX_CATALOG_FILE, "deck-model-catalog.json");
  assert.equal(codexCatalogPath({ CODEX_HOME: "/home/x/.codex" }), "/home/x/.codex/deck-model-catalog.json");
});

test("命令：目录接在启动命令末尾，重存一次不会叠第二个 `-c`", () => {
  const first = codexCommandWithCatalog(undefined, "/tmp/x/deck-model-catalog.json");
  assert.deepEqual(first, ["codex", "-c", 'model_catalog_json="/tmp/x/deck-model-catalog.json"']);
  const again = codexCommandWithCatalog(first, "/tmp/y/deck-model-catalog.json");
  assert.deepEqual(again, ["codex", "-c", 'model_catalog_json="/tmp/y/deck-model-catalog.json"'], "旧的目录参数要被替换掉");
});

test("命令：用户自己的可执行文件与参数原样保留", () => {
  const command = codexCommandWithCatalog(["/opt/codex/bin/codex", "--profile", "site"], "/tmp/c.json");
  assert.deepEqual(command, ["/opt/codex/bin/codex", "--profile", "site", "-c", 'model_catalog_json="/tmp/c.json"']);
});

test("命令：读回时能从里面取出目录路径（读回校验用）", () => {
  const command = codexCommandWithCatalog(["codex"], "/root/.codex/deck-model-catalog.json");
  assert.equal(catalogPathOfCommand(command), "/root/.codex/deck-model-catalog.json");
  assert.equal(catalogPathOfCommand(["codex", "app-server"]), undefined);
  assert.equal(catalogPathOfCommand("codex"), undefined);
});

test("配置条目：手改坏的值一律丢掉，认得的窗口取整后带出来", () => {
  const models = catalogModelInputsOf([
    { id: "group/site8083", label: "组", contextWindowMaxTokens: 128000.7 },
    { id: "auto/gpt-6-astra", label: "A", contextWindowMaxTokens: "128000" },
    { id: "" },
    "裸字符串",
    null,
    { id: "with-thinking", thinkingOptions: [{ id: "low" }, { id: "high", isDefault: true }] },
  ]);
  assert.deepEqual(models.map((model) => model.id), ["group/site8083", "auto/gpt-6-astra", "with-thinking"]);
  assert.equal(models[0].contextWindowMaxTokens, 128000, "窗口要取整，别把小数写进目录");
  assert.equal(models[1].contextWindowMaxTokens, undefined, "字符串窗口不认");
  assert.deepEqual(models[2].thinkingOptions?.map((option) => option.id), ["low", "high"]);
});
