import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDraftKey,
  prefillAgentDraft,
  readSurfaceServerId,
} from "../client/deck/session/prefill.ts";

/** 一次测试内替换宿主全局；结束时恢复，避免污染同一进程里的其他用例。 */
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
  try {
    return run();
  } finally {
    restore();
  }
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
  assert.match(result.detail, /module missing/);
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
