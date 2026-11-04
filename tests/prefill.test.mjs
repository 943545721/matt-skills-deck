import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDraftKey,
  hostLoaderErrors,
  prefillAgentDraft,
  prefillAgentDraftWithScan,
  readSurfaceServerId,
} from "../client/deck/session/prefill.ts";

/**
 * 一次测试内替换宿主全局；结束时恢复，避免污染同一进程里的其他用例。
 * 回调返回 promise 时等它结束再恢复：分片试探在 await 之后还要读到 `__r`。
 */
function withGlobals(values, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const restore = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  let outcome;
  try {
    outcome = run();
  } catch (error) {
    restore();
    throw error;
  }
  if (outcome && typeof outcome.then === "function") return outcome.finally(restore);
  restore();
  return outcome;
}

/**
 * 按 0.13.2 的真实语义模拟草稿 store：`saveDraftInput` 无条件写 active，
 * `editDraftText` 保留 active 记录的附件。`noopWrites` 用来验证读回校验。
 */
function fakeDraftStore(initialDrafts = {}, options = {}) {
  const drafts = structuredClone(initialDrafts);
  const calls = { save: [], edit: [] };
  const store = {
    getState: () => ({
      drafts,
      saveDraftInput: (input) => {
        calls.save.push(input);
        if (options.noopWrites) return;
        drafts[input.draftKey] = {
          lifecycle: "active",
          input: { text: input.draft.text, attachments: input.draft.attachments },
        };
      },
      editDraftText: (input) => {
        calls.edit.push(input);
        if (options.noopWrites) return;
        const current = drafts[input.draftKey];
        const attachments = current?.lifecycle === "active" ? current.input?.attachments ?? [] : [];
        drafts[input.draftKey] = {
          lifecycle: input.text.length > 0 || attachments.length > 0 ? "active" : "abandoned",
          input: { text: input.text, attachments },
        };
      },
    }),
  };
  return { store, calls, drafts };
}

const withStore = (store, run) =>
  withGlobals({ __r: (id) => {
    assert.equal(id, 3598);
    return { useDraftStore: store };
  } }, run);

test("agentDraftKey 与宿主 buildDraftStoreKey 同形，并去掉首尾空白", () => {
  assert.equal(agentDraftKey(" s1 ", " a1 "), "agent:s1:a1");
});

test("agentDraftKey 缺 serverId 或 agentId 时返回空串", () => {
  assert.equal(agentDraftKey("", "a1"), "");
  assert.equal(agentDraftKey("s1", ""), "");
  assert.equal(agentDraftKey("   ", "a1"), "");
});

test("readSurfaceServerId 从宿主 props 的 host.id 取 serverId", () => {
  assert.equal(readSurfaceServerId({ host: { id: " s1 " } }), "s1");
  assert.equal(readSurfaceServerId({ host: {} }), "");
  assert.equal(readSurfaceServerId({ host: { id: 42 } }), "");
  assert.equal(readSurfaceServerId({}), "");
  assert.equal(readSurfaceServerId(null), "");
});

test("没有 Metro 模块加载器时返回 no-loader", () => {
  const result = withGlobals({ __r: undefined }, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-loader");
});

test("模块存在但不导出 useDraftStore 时返回 no-store", () => {
  const result = withGlobals({ __r: () => ({}) }, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-store");
});

test("模块加载器抛异常时返回可解释的 no-store", () => {
  const result = withGlobals({ __r: () => {
    throw new Error("module missing");
  } }, () => prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-store");
  assert.match(result.diagnostics.loaderErrors.join(" "), /module missing/);
});

test("宿主报错最多引三条：横幅放不下更多", () => {
  const errors = ["#1: a", "#2: b", "#3: c", "#4: d"];
  assert.equal(
    hostLoaderErrors({ knownIds: [3598, 3601], registry: "absent", loaderErrors: errors }),
    "#1: a | #2: b | #3: c",
  );
  assert.equal(hostLoaderErrors({ knownIds: [3598, 3601], registry: "absent", loaderErrors: [] }), "");
});

test("草稿是 active 时用 editDraftText 保留附件", () => {
  const { store, calls, drafts } = fakeDraftStore({
    "agent:s1:a1": { lifecycle: "active", input: { text: "old", attachments: ["file-1"] } },
  });
  const result = withStore(store, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "new text", overwrite: true }),
  );

  assert.deepEqual(result, { ok: true, via: "draft-store" });
  assert.deepEqual(calls.edit, [{ draftKey: "agent:s1:a1", text: "new text" }]);
  assert.equal(calls.save.length, 0);
  assert.equal(drafts["agent:s1:a1"].input.text, "new text");
  assert.deepEqual(drafts["agent:s1:a1"].input.attachments, ["file-1"]);
});

test("没有活动草稿时用 saveDraftInput 建一条空附件草稿", () => {
  const { store, calls, drafts } = fakeDraftStore();
  const result = withStore(store, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }),
  );

  assert.deepEqual(result, { ok: true, via: "draft-store" });
  assert.deepEqual(calls.save, [
    { draftKey: "agent:s1:a1", draft: { text: "hello", attachments: [] } },
  ]);
  assert.equal(drafts["agent:s1:a1"].lifecycle, "active");
  assert.equal(drafts["agent:s1:a1"].input.text, "hello");
});

test("缺少 serverId 时不写草稿", () => {
  const { store, calls } = fakeDraftStore();
  const result = withStore(store, () =>
    prefillAgentDraft({ serverId: "", agentId: "a1", text: "hello" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing-target");
  assert.equal(calls.save.length + calls.edit.length, 0);
});

test("空白提示词不写草稿", () => {
  const { store, calls } = fakeDraftStore();
  const result = withStore(store, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "   " }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "empty");
  assert.equal(calls.save.length + calls.edit.length, 0);
});

test("目标已有非空草稿时先拒绝覆盖", () => {
  const { store, calls, drafts } = fakeDraftStore({
    "agent:s1:a1": { lifecycle: "active", input: { text: "half-written", attachments: [] } },
  });
  const result = withStore(store, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "new prompt" }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "draft-occupied");
  assert.equal(calls.save.length + calls.edit.length, 0);
  assert.equal(drafts["agent:s1:a1"].input.text, "half-written");
});

test("显式 overwrite 才替换已有草稿", () => {
  const { store, calls, drafts } = fakeDraftStore({
    "agent:s1:a1": { lifecycle: "active", input: { text: "half-written", attachments: [] } },
  });
  const result = withStore(store, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "new prompt", overwrite: true }),
  );

  assert.deepEqual(result, { ok: true, via: "draft-store" });
  assert.deepEqual(calls.edit, [{ draftKey: "agent:s1:a1", text: "new prompt" }]);
  assert.equal(drafts["agent:s1:a1"].input.text, "new prompt");
});

test("读回文本相同但 lifecycle 不是 active 也算失败", () => {
  const store = {
    getState: () => ({
      drafts: {
        "agent:s1:a1": { lifecycle: "submitted", input: { text: "same", attachments: [] } },
      },
      saveDraftInput: () => {},
    }),
  };
  const result = withStore(store, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "same" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "read-back-failed");
});

test("store 方法 no-op 时读回校验报失败，而不是假成功", () => {
  const { store } = fakeDraftStore(
    { "agent:s1:a1": { lifecycle: "active", input: { text: "old", attachments: [] } } },
    { noopWrites: true },
  );
  const result = withStore(store, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "new prompt", overwrite: true }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "read-back-failed");
});

test("活动草稿缺少 editDraftText 时拒绝用 save 清空附件", () => {
  let saved = 0;
  const store = {
    getState: () => ({
      drafts: {
        "agent:s1:a1": { lifecycle: "active", input: { text: "same", attachments: ["file-1"] } },
      },
      saveDraftInput: () => {
        saved += 1;
      },
    }),
  };
  const result = withStore(store, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "same" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "write-failed");
  assert.equal(saved, 0);
});

test("store 写入抛异常时返回 write-failed", () => {
  const store = {
    getState: () => ({
      drafts: {},
      saveDraftInput: () => {
        throw new Error("disk full");
      },
    }),
  };
  const result = withStore(store, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "write-failed");
  assert.match(result.detail, /disk full/);
});

/**
 * 下面几条钉的是「去哪找草稿 store」。
 *
 * 模块编号不是公开协议：之前写死 3598，宿主换一次构建就整条路断掉。查找顺序是
 * 记住的编号 → 已知编号 → 模块注册表 → （用户点了「自动查找」才）逐个试探。
 */

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    storage: {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => void data.set(key, value),
    },
  };
}

const REMEMBER_KEY = "matt-skills-deck:draftStoreModuleId";

test("注册表里已初始化的导出也能认出来（编号变了的时候）", () => {
  const { store, drafts } = fakeDraftStore();
  const registry = new Map([
    [11, { publicModule: { exports: { somethingElse: true } } }],
    [77, { publicModule: { exports: { useDraftStore: store } } }],
  ]);
  const loader = () => {
    throw new Error("module not initialised");
  };
  loader.getModules = () => registry;
  const { data, storage } = fakeStorage();

  const result = withGlobals({ __r: loader, localStorage: storage }, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.equal(result.ok, true);
  assert.equal(drafts["agent:s1:a1"].input.text, "hello");
  // 认出来的编号记下来，下次不必再翻注册表。
  assert.equal(data.get(REMEMBER_KEY), "77");
});

test("记住的编号优先：宿主换过编号也能一次命中", () => {
  const remembered = fakeDraftStore();
  const stale = fakeDraftStore();
  const { storage } = fakeStorage({ [REMEMBER_KEY]: "900" });
  const loader = (id) => {
    if (id === 900) return { useDraftStore: remembered.store };
    if (id === 3598) return { useDraftStore: stale.store };
    throw new Error(`no module ${id}`);
  };

  const result = withGlobals({ __r: loader, localStorage: storage }, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.equal(result.ok, true);
  assert.equal(remembered.drafts["agent:s1:a1"].input.text, "hello");
  assert.equal(stale.drafts["agent:s1:a1"], undefined);
});

test("0.14 的宿主：3598 是别的模块也不耽误，命中 3601", () => {
  // 实测编号：0.13.2 在 3598、0.14.0 在 3601。3598 在 0.14 里是个普通模块，
  // 不抛错也不像 store——这时必须继续试下一个候选，而不是就此报「找不到」。
  const { store, drafts } = fakeDraftStore();
  const { data, storage } = fakeStorage();
  const loader = (id) => {
    if (id === 3598) return { useAgentDirectory: () => {} };
    if (id === 3601) return { useDraftStore: store };
    throw new Error(`no module ${id}`);
  };
  const result = withGlobals({ __r: loader, localStorage: storage }, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.deepEqual(result, { ok: true, via: "draft-store" });
  assert.equal(drafts["agent:s1:a1"].input.text, "hello");
  assert.equal(data.get(REMEMBER_KEY), "3601");
});

test("记住的编号恰好是已知编号：只试一次，报错也只记一条", () => {
  const { storage } = fakeStorage({ [REMEMBER_KEY]: "3598" });
  let calls3598 = 0;
  const loader = (id) => {
    if (id === 3598) {
      calls3598 += 1;
      throw new Error("module missing");
    }
    throw new Error(`no module ${id}`);
  };
  const result = withGlobals({ __r: loader, localStorage: storage }, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.equal(result.code, "no-store");
  assert.equal(calls3598, 1);
  assert.equal(
    result.diagnostics.loaderErrors.filter((line) => line.startsWith("#3598:")).length,
    1,
  );
});

test("一个候选都不中：如实报 no-store，不记编号、不瞎写", () => {
  const { data, storage } = fakeStorage();
  const result = withGlobals({ __r: () => ({}), localStorage: storage }, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.equal(result.code, "no-store");
  // 界面不显示英文原句，而是拿诊断按当前语言拼；诊断必须带上事实。
  assert.deepEqual(result.diagnostics.knownIds, [3598, 3601]);
  assert.equal(result.diagnostics.registry, "absent");
  assert.equal(result.diagnostics.scanned, undefined);
  assert.equal(data.has(REMEMBER_KEY), false);
});

test("没找到时旧编号的异常原因仍留在诊断里", () => {
  const { storage } = fakeStorage();
  const result = withGlobals(
    {
      __r: () => {
        throw new Error("module missing");
      },
      localStorage: storage,
    },
    () => prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.equal(result.code, "no-store");
  assert.match(result.diagnostics.loaderErrors.join(" "), /module missing/);
});

test("允许试探时逐个找：命中就停，并记住这个编号", async () => {
  const { store, drafts } = fakeDraftStore();
  const { data, storage } = fakeStorage();
  let calls = 0;
  const loader = (id) => {
    calls += 1;
    if (id === 42) return { useDraftStore: store };
    throw new Error(`no module ${id}`);
  };

  const refused = withGlobals({ __r: loader, localStorage: storage }, () =>
    prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.equal(refused.code, "no-store");

  calls = 0;
  const found = await withGlobals({ __r: loader, localStorage: storage }, () =>
    prefillAgentDraftWithScan({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.equal(found.ok, true);
  assert.equal(drafts["agent:s1:a1"].input.text, "hello");
  assert.equal(data.get(REMEMBER_KEY), "42");
  // 命中即停：2 次已知编号 + 1..42 的试探，不该继续往下刷模块。
  assert.ok(calls <= 44, `tried ${calls} modules`);
});

test("试探要够得到高位编号：store 在 3598 之后（例如 4200）也能找到", async () => {
  // 试探范围要够到真实编号：0.13.2 的宿主包里 store 在 3598，
  // 上限若停在它前面，点了「自动查找」也一定报失败。
  const { store, drafts } = fakeDraftStore();
  const { storage } = fakeStorage();
  const loader = (id) => {
    if (id === 4200) return { useDraftStore: store };
    throw new Error(`no module ${id}`);
  };

  const found = await withGlobals({ __r: loader, localStorage: storage }, () =>
    prefillAgentDraftWithScan({ serverId: "s1", agentId: "a1", text: "hi" }),
  );
  assert.equal(found.ok, true, found.ok ? "" : JSON.stringify(found.diagnostics));
  assert.equal(drafts["agent:s1:a1"].input.text, "hi");
});

test("store 换了导出名也认得：按形状找，不按名字找", () => {
  const { store, drafts } = fakeDraftStore();
  const result = withGlobals(
    { __r: (id) => (id === 3598 ? { composerDraft: store } : {}) },
    () => prefillAgentDraft({ serverId: "s1", agentId: "a1", text: "renamed" }),
  );
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  assert.equal(drafts["agent:s1:a1"].input.text, "renamed");
});

test("试探有上限：整包里没有 store 也不会一直刷模块", async () => {
  const { storage } = fakeStorage();
  let calls = 0;
  const loader = () => {
    calls += 1;
    throw new Error("nothing here");
  };
  const result = await withGlobals({ __r: loader, localStorage: storage }, () =>
    prefillAgentDraftWithScan({ serverId: "s1", agentId: "a1", text: "hello" }),
  );
  assert.equal(result.code, "no-store");
  assert.ok(calls > 0 && calls <= 20_050, `tried ${calls} modules`);
  assert.equal(typeof result.diagnostics.scanned, "number");
  assert.ok(result.diagnostics.scanned > 0);
});
