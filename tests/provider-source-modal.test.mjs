import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { isProtectedEnvKey } from "../shared/provider-env.ts";

// Node cannot import TSX or the native host UI. Transpile the actual component with
// the installed compiler and supply only the React/host/RPC boundary below.
const modalUrl = new URL("../client/deck/surfaces/orchestration/ProviderSourceModal.tsx", import.meta.url);
const cleanupRpc = {};
const element = (type, props, key) => ({ type, props: props ?? {}, key });
const skin = { colors: {}, mono: { fontFamily: "fixture-mono" } };
const translate = (key, vars) => vars ? `${key} ${JSON.stringify(vars)}` : key;

function loadModal(react, cleanup) {
  const module = { exports: {} };
  const Modal = Object.assign((props) => element("Modal", props), { Content: "Modal.Content" });
  const boundaries = {
    react,
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: "Fragment" },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "@getpaseo/plugin/client": { useRpc: () => cleanup },
    "@getpaseo/plugin/client/ui": { Modal, ScrollView: "ScrollView" },
    "../../../../shared/orchestration-rpc.ts": { orchestrationProviderCleanupRpc: cleanupRpc },
    "../../../../shared/provider-env.ts": { isProtectedEnvKey },
    "../../pixel": { PixelButton: "PixelButton", PixelModalBody: "PixelModalBody" },
  };
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(modalUrl, "utf8"), {
    fileName: modalUrl.pathname,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(diagnostics.length, 0, "the component must transpile before testing its behavior");
  const requireBoundary = (name) => {
    if (Object.hasOwn(boundaries, name)) return boundaries[name];
    throw new Error(`Unexpected component import: ${name}`);
  };
  new Function("require", "module", "exports", outputText)(requireBoundary, module, module.exports);
  return module.exports.ProviderSourceModal;
}

function hookRuntime() {
  let active;
  let writesAfterUnmount = 0;
  const instances = new Map();
  const slot = (initialize) => {
    const index = active.cursor++;
    if (!active.hooks[index]) active.hooks[index] = initialize(active);
    return active.hooks[index];
  };
  const effect = (phase) => (setup, deps) => {
    const hook = slot(() => ({}));
    const changed = !deps || !hook.deps || deps.some((value, index) => !Object.is(value, hook.deps[index]));
    if (changed) Object.assign(hook, { phase, setup, deps, pending: true });
  };
  const react = {
    useState: (initial) => {
      const hook = slot((owner) => {
        const state = { value: typeof initial === "function" ? initial() : initial };
        state.set = (update) => {
          if (!owner.mounted) { writesAfterUnmount += 1; return; }
          state.value = typeof update === "function" ? update(state.value) : update;
          owner.dirty = true;
        };
        return state;
      });
      return [hook.value, hook.set];
    },
    useRef: (initial) => slot(() => ({ current: initial })),
    useCallback: (callback, deps) => {
      const hook = slot(() => ({}));
      const changed = !hook.deps || deps.some((value, index) => !Object.is(value, hook.deps[index]));
      if (changed) Object.assign(hook, { callback, deps });
      return hook.callback;
    },
    useEffect: effect("passive"),
    useLayoutEffect: effect("layout"),
  };
  return { react, instances, get active() { return active; }, set active(value) { active = value; },
    get writesAfterUnmount() { return writesAfterUnmount; } };
}

function expand(node, path, runtime, seen) {
  if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.key ?? index}`, runtime, seen));
  if (node === null || typeof node !== "object") return node;
  if (typeof node.type === "function") {
    let instance = runtime.instances.get(path);
    if (!instance) {
      instance = { hooks: [], mounted: true, cursor: 0, dirty: false };
      runtime.instances.set(path, instance);
    }
    seen.add(path);
    instance.cursor = 0;
    instance.dirty = false;
    const previous = runtime.active;
    runtime.active = instance;
    const child = node.type(node.props);
    runtime.active = previous;
    return expand(child, `${path}/render`, runtime, seen);
  }
  return { ...node, props: { ...node.props, children: expand(node.props.children, `${path}/children`, runtime, seen) } };
}

function dispose(instance) {
  for (const hook of instance.hooks) hook.cleanup?.();
  instance.mounted = false;
}

function commitEffects(runtime, seen) {
  for (const [path, instance] of runtime.instances) {
    if (seen.has(path)) continue;
    dispose(instance);
    runtime.instances.delete(path);
  }
  for (const phase of ["layout", "passive"]) {
    for (const instance of runtime.instances.values()) {
      for (const hook of instance.hooks) {
        if (!hook.pending || hook.phase !== phase) continue;
        hook.cleanup?.();
        hook.pending = false;
        hook.cleanup = hook.setup();
      }
    }
  }
}

function nodesOf(node) {
  if (Array.isArray(node)) return node.flatMap(nodesOf);
  if (node === null || typeof node !== "object") return [];
  return [node, ...nodesOf(node.props.children)];
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return textOf(node.props.children);
}

function source(provider) {
  return {
    ok: true, provider, path: `/fixtures/${provider}/config.json`,
    entries: [{
      id: `deck-${provider}`, effective: true, extends: provider, enabled: true, removable: false,
      fields: ["extends", "env", "models"], models: ["fixture-model"],
      env: [{ key: "EXTRA_FLAG", display: "keep", masked: false }],
    }],
  };
}

function mountModal(provider = "codex") {
  const runtime = hookRuntime();
  const requests = [];
  const callbacks = [];
  let mounted = true;
  let tree;
  const cleanup = (input) => new Promise((resolve, reject) => requests.push({ input, resolve, reject }));
  const Component = loadModal(runtime.react, cleanup);
  let props = { skin, t: translate, open: true, provider, loading: false, error: null, result: source(provider),
    onClose: () => view.update({ open: false }),
    onRefresh: () => callbacks.push(`refresh:${provider}`), onChanged: () => callbacks.push(`changed:${provider}`) };
  const render = () => {
    if (!mounted) return;
    let rounds = 0;
    do {
      assert.ok(rounds++ < 20, "effects must settle without a render loop");
      const seen = new Set();
      tree = expand(element(Component, props), "modal", runtime, seen);
      commitEffects(runtime, seen);
    } while ([...runtime.instances.values()].some((instance) => instance.dirty));
  };
  const view = {
    requests, callbacks, runtime,
    update: (next) => { props = { ...props, ...next }; render(); },
    open: (nextProvider) => view.update({ open: true, provider: nextProvider, result: source(nextProvider),
      onRefresh: () => callbacks.push(`refresh:${nextProvider}`), onChanged: () => callbacks.push(`changed:${nextProvider}`) }),
    close: () => view.update({ open: false }),
    nodes: () => nodesOf(tree),
    texts: () => nodesOf(tree).filter((node) => node.type === "Text").map(textOf),
    button: (label) => nodesOf(tree).find((node) => node.type === "PixelButton" && node.props.label === label),
    press: (node) => { assert.ok(node, "control must exist"); assert.ok(!node.props.disabled, "control must be enabled");
      node.props.onPress(); render(); },
    flush: async () => { await new Promise(setImmediate); render(); },
    unmount: () => { for (const instance of runtime.instances.values()) dispose(instance); mounted = false; },
  };
  render();
  return view;
}

function envCheckbox(view, key = "EXTRA_FLAG") {
  const row = view.nodes().find((node) => node.type === "View" && Array.isArray(node.props.children) &&
    node.props.children.some((child) => child?.type === "Text" && textOf(child).startsWith(`${key} = `)));
  assert.ok(row, `the source must show ${key}`);
  return row.props.children.find((node) => node?.type === "Pressable");
}

function startCleanup(view) {
  view.press(envCheckbox(view));
  view.press(view.button("orch.source.cleanup"));
  view.press(view.button("orch.source.cleanupRun"));
  return view.requests.at(-1);
}

function success(provider) {
  return { ok: true, provider, removed: [{ entryId: `deck-${provider}`, keys: ["EXTRA_FLAG"], entryRemoved: false }] };
}

function pendingSnapshot(view) {
  return {
    selected: envCheckbox(view).props.accessibilityState.checked,
    busy: view.button("orch.source.cleanupBusy")?.props.disabled ?? false,
    confirming: view.texts().filter((text) => text.startsWith("orch.source.cleanupConfirm")),
    notices: view.texts().filter((text) => /^orch.source.cleanup(Done|Failed)/.test(text)),
    callbacks: [...view.callbacks],
  };
}

test("Codex 关闭后打开 Claude 并发清理：旧成功不能清空选择、显示旧成功、刷新或释放 Claude busy", async () => {
  const view = mountModal();
  const codex = startCleanup(view);
  view.press(view.button("orch.source.close"));
  view.open("claude");
  const claude = startCleanup(view);
  const expected = { selected: true, busy: true,
    confirming: ['orch.source.cleanupConfirm {"n":1}'], notices: [], callbacks: [] };
  assert.deepEqual(pendingSnapshot(view), expected, "Claude request must still be pending before Codex returns");

  codex.resolve(success("codex"));
  await view.flush();
  assert.deepEqual(pendingSnapshot(view), expected, "the obsolete Codex success must leave the entire Claude interaction intact");

  claude.resolve(success("claude"));
  await view.flush();
  assert.equal(envCheckbox(view).props.accessibilityState.checked, false);
  assert.equal(view.button("orch.source.cleanupBusy"), undefined);
  assert.deepEqual(view.callbacks, ["refresh:claude", "changed:claude"]);
  assert.ok(view.texts().some((text) => text.includes("deck-claude.EXTRA_FLAG") && text.startsWith("orch.source.cleanupDone")));
});

test("关闭后重开同一客户端：旧请求成功不能覆盖新一轮清理", async () => {
  const view = mountModal();
  const previous = startCleanup(view);
  view.close();
  view.open("codex");
  const current = startCleanup(view);
  const expected = { selected: true, busy: true,
    confirming: ['orch.source.cleanupConfirm {"n":1}'], notices: [], callbacks: [] };

  previous.resolve(success("codex"));
  await view.flush();
  assert.deepEqual(pendingSnapshot(view), expected);

  current.resolve(success("codex"));
  await view.flush();
  assert.equal(envCheckbox(view).props.accessibilityState.checked, false);
  assert.deepEqual(view.callbacks, ["refresh:codex", "changed:codex"]);
});

test("过期 cleanup 被拒绝：不能在新弹窗显示旧错误或清除 busy", async () => {
  const view = mountModal();
  const previous = startCleanup(view);
  view.close();
  view.open("claude");
  startCleanup(view);
  const expected = { selected: true, busy: true,
    confirming: ['orch.source.cleanupConfirm {"n":1}'], notices: [], callbacks: [] };

  previous.reject(new Error("Codex cleanup failed"));
  await view.flush();
  assert.deepEqual(pendingSnapshot(view), expected);
});
test("请求所属弹窗卸载后：迟到的成功不触发 UI state 更新或父回调", async () => {
  const view = mountModal();
  const request = startCleanup(view);
  view.unmount();
  request.resolve(success("codex"));
  await new Promise(setImmediate);
  assert.equal(view.runtime.writesAfterUnmount, 0);
  assert.deepEqual(view.callbacks, []);
});

function entryCheckbox(view) {
  const heading = view.nodes().find((node) => node.type === "View" && Array.isArray(node.props.children) &&
    node.props.children.some((child) => child?.type === "Text" && textOf(child).startsWith("deck-")));
  assert.ok(heading, "the source must show its provider entry");
  return heading.props.children.find((node) => node?.type === "Pressable");
}

test("保持打开时直接切换 provider：旧业务失败不能污染新弹窗或释放 busy", async () => {
  const view = mountModal();
  const previous = startCleanup(view);
  view.open("claude");
  const current = startCleanup(view);
  const expected = { selected: true, busy: true,
    confirming: ['orch.source.cleanupConfirm {"n":1}'], notices: [], callbacks: [] };

  previous.resolve({ ok: false, reason: "config-failed", detail: "old Codex failure" });
  await view.flush();
  assert.deepEqual(pendingSnapshot(view), expected);

  current.resolve({ ok: false, reason: "verify-failed", detail: "current Claude failure" });
  await view.flush();
  assert.equal(view.button("orch.source.cleanupBusy"), undefined);
  assert.equal(envCheckbox(view).props.accessibilityState.checked, true);
  assert.ok(view.texts().some((text) => text.includes("current Claude failure")));
  assert.deepEqual(view.callbacks, []);
});

test("请求未返回时关闭：旧成功不能写入关闭窗口；同 provider 重开保持干净", async () => {
  const view = mountModal();
  const request = startCleanup(view);
  view.close();
  const expected = pendingSnapshot(view);

  request.resolve(success("codex"));
  await view.flush();
  assert.deepEqual(pendingSnapshot(view), expected);

  view.open("codex");
  assert.equal(envCheckbox(view).props.accessibilityState.checked, false);
  assert.equal(view.button("orch.source.cleanup").props.disabled, true);
  assert.deepEqual(view.callbacks, []);
});

test("保护键和非空整条删除仍保留二次确认、字段和独立 RPC 授权", async () => {
  const view = mountModal();
  const fixture = source("codex");
  fixture.entries[0].env.push(
    { key: "OPENAI_API_KEY", display: "••••1234", masked: true },
    { key: "EMPTY_FLAG", display: "", masked: false },
  );
  view.update({ result: fixture });
  assert.ok(view.texts().some((text) => text.includes("extends, env, models")));
  assert.ok(view.texts().some((text) => text.includes("fixture-model")));
  assert.ok(view.texts().some((text) => text.includes("OPENAI_API_KEY = ••••1234")));
  assert.ok(view.texts().some((text) => text.includes("EMPTY_FLAG = orch.source.emptyValue")));

  view.press(envCheckbox(view, "OPENAI_API_KEY"));
  view.press(view.button("orch.source.cleanup"));
  assert.ok(view.texts().includes("orch.source.cleanupProtected"));
  assert.equal(view.requests.length, 0, "confirmation alone must never call cleanup");
  view.press(view.button("orch.source.cleanupCancel"));
  assert.equal(envCheckbox(view, "OPENAI_API_KEY").props.accessibilityState.checked, true);
  view.press(view.button("orch.source.cleanup"));
  view.press(view.button("orch.source.cleanupRun"));
  assert.deepEqual(view.requests[0].input, { provider: "codex",
    cleanups: [{ entryId: "deck-codex", keys: ["OPENAI_API_KEY"] }], allowProtected: true });
  view.requests[0].resolve({ ok: true, provider: "codex",
    removed: [{ entryId: "deck-codex", keys: ["OPENAI_API_KEY"], entryRemoved: false }], warnings: ["fixture warning"] });
  await view.flush();
  assert.ok(view.texts().some((text) => text.includes("deck-codex.OPENAI_API_KEY") && text.includes("fixture warning")));

  view.press(envCheckbox(view));
  view.press(entryCheckbox(view));
  assert.equal(envCheckbox(view).props.disabled, true);
  assert.equal(envCheckbox(view).props.accessibilityState.checked, false);
  view.press(view.button("orch.source.cleanup"));
  assert.ok(view.texts().some((text) => text.startsWith("orch.source.cleanupNonEmpty") && text.includes("deck-codex")));
  assert.equal(view.requests.length, 1);
  view.press(view.button("orch.source.cleanupRun"));
  assert.deepEqual(view.requests[1].input, { provider: "codex",
    cleanups: [{ entryId: "deck-codex", keys: [], removeEntry: true }], allowNonEmpty: true });
  view.requests[1].resolve({ ok: true, provider: "codex",
    removed: [{ entryId: "deck-codex", keys: [], entryRemoved: true }] });
  await view.flush();
  assert.ok(view.texts().includes('orch.source.cleanupDone {"items":"deck-codex"}'));
});

const dialogUrl = new URL("../client/deck/surfaces/orchestration/ProviderSourceDialog.tsx", import.meta.url);
const sourceRpc = {};

function loadDialog(react, readSource) {
  const module = { exports: {} };
  const modalBoundary = { ProviderSourceModal: "ProviderSourceModal" };
  const boundaries = {
    react,
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: "Fragment" },
    "@getpaseo/plugin/client": { useRpc: (rpc) => {
      assert.equal(rpc, sourceRpc, "the dialog must read through the provider source RPC");
      return readSource;
    } },
    "../../../../shared/orchestration-rpc.ts": { orchestrationProviderSourceRpc: sourceRpc },
    "./ProviderSourceModal": modalBoundary,
    "./ProviderSourceModal.tsx": modalBoundary,
  };
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(dialogUrl, "utf8"), {
    fileName: dialogUrl.pathname,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(diagnostics.length, 0, "the dialog must transpile before testing its behavior");
  const requireBoundary = (name) => {
    if (Object.hasOwn(boundaries, name)) return boundaries[name];
    throw new Error(`Unexpected dialog import: ${name}`);
  };
  new Function("require", "module", "exports", outputText)(requireBoundary, module, module.exports);
  assert.equal(typeof module.exports.ProviderSourceDialog, "function", "the dialog must export its component");
  return module.exports.ProviderSourceDialog;
}

function mountDialog(provider = null) {
  const runtime = hookRuntime();
  const requests = [];
  const callbacks = [];
  const onClose = () => callbacks.push("close");
  const onChanged = () => callbacks.push("changed");
  let mounted = true;
  let tree;
  const readSource = (input) => new Promise((resolve, reject) => requests.push({ input, resolve, reject }));
  const Component = loadDialog(runtime.react, readSource);
  let props = { skin, t: translate, provider, onClose, onChanged };
  const render = () => {
    if (!mounted) return;
    let rounds = 0;
    do {
      assert.ok(rounds++ < 20, "dialog effects must settle without a render loop");
      const seen = new Set();
      tree = expand(element(Component, props), "dialog", runtime, seen);
      commitEffects(runtime, seen);
    } while ([...runtime.instances.values()].some((instance) => instance.dirty));
  };
  const view = {
    requests, callbacks, runtime, onClose, onChanged,
    update: (next) => { props = { ...props, ...next }; render(); },
    open: (nextProvider) => view.update({ provider: nextProvider }),
    close: () => view.update({ provider: null }),
    modal: () => nodesOf(tree).find((node) => node.type === "ProviderSourceModal")?.props,
    refresh: () => {
      const modal = view.modal();
      assert.ok(modal?.open, "refresh must originate from an open source modal");
      modal.onRefresh();
      render();
      return requests.at(-1);
    },
    flush: async () => { await new Promise(setImmediate); render(); },
    unmount: () => { for (const instance of runtime.instances.values()) dispose(instance); mounted = false; },
  };
  render();
  return view;
}

function dialogSnapshot(view) {
  const modal = view.modal();
  assert.ok(modal, "an open dialog must render the provider source modal");
  return { open: modal.open, provider: modal.provider, loading: modal.loading, error: modal.error, result: modal.result };
}

test("配置源 Dialog：关闭时不读取，初开先显示 loading，随后展示源结果", async () => {
  const view = mountDialog();
  assert.equal(view.requests.length, 0, "a null provider must not read host configuration");
  assert.equal(view.modal()?.open ?? false, false);

  view.open("codex");
  assert.equal(view.requests.length, 1);
  assert.deepEqual(view.requests[0].input, { provider: "codex" });
  assert.deepEqual(dialogSnapshot(view), { open: true, provider: "codex", loading: true, error: null, result: null });

  const result = source("codex");
  view.requests[0].resolve(result);
  await view.flush();
  assert.deepEqual(dialogSnapshot(view), { open: true, provider: "codex", loading: false, error: null, result });
  assert.equal(view.modal().skin, skin);
  assert.equal(view.modal().t, translate);
  assert.equal(view.requests.length, 1, "settling the read must not start another request");
});

test("配置源 Dialog：同 provider 关闭重开，旧成功或旧拒绝不覆盖新 loading 或新结果", async (t) => {
  for (const outcome of ["resolve", "reject"]) {
    for (const timing of ["while-loading", "after-result"]) {
      await t.test(`${outcome} ${timing}`, async () => {
        const view = mountDialog("codex");
        const previous = view.requests[0];
        view.close();
        assert.equal(view.requests.length, 1, "closing must not start a source read");
        view.open("codex");
        assert.equal(view.requests.length, 2, "reopening the same provider must start a fresh read");
        const current = view.requests[1];
        const currentResult = { ...source("codex"), path: "/fixtures/current/config.json" };
        assert.deepEqual(current.input, { provider: "codex" });
        assert.equal(view.modal().loading, true);
        assert.equal(view.modal().error, null);
        if (timing === "after-result") {
          current.resolve(currentResult);
          await view.flush();
          assert.deepEqual(dialogSnapshot(view), {
            open: true, provider: "codex", loading: false, error: null, result: currentResult,
          });
        }
        const expected = dialogSnapshot(view);

        if (outcome === "resolve") previous.resolve({ ...source("codex"), path: "/fixtures/obsolete/config.json" });
        else previous.reject(new Error("obsolete Codex read failed"));
        await view.flush();
        assert.deepEqual(dialogSnapshot(view), expected, "a previous open session must not change the current modal");

        if (timing === "while-loading") {
          current.resolve(currentResult);
          await view.flush();
          assert.deepEqual(dialogSnapshot(view), {
            open: true, provider: "codex", loading: false, error: null, result: currentResult,
          });
        }
        assert.deepEqual(view.callbacks, []);
      });
    }
  }
});

test("配置源 Dialog：切换 provider 后旧成功或旧拒绝不污染新请求", async (t) => {
  for (const outcome of ["resolve", "reject"]) {
    await t.test(outcome, async () => {
      const view = mountDialog("codex");
      const previous = view.requests[0];
      view.open("claude");
      assert.equal(view.requests.length, 2);
      const current = view.requests[1];
      assert.deepEqual(current.input, { provider: "claude" });
      const pending = { open: true, provider: "claude", loading: true, error: null, result: null };
      assert.deepEqual(dialogSnapshot(view), pending);

      if (outcome === "resolve") previous.resolve(source("codex"));
      else previous.reject(new Error("obsolete Codex read failed"));
      await view.flush();
      assert.deepEqual(dialogSnapshot(view), pending, "the current provider must keep ownership of loading and result");

      const result = source("claude");
      current.resolve(result);
      await view.flush();
      assert.deepEqual(dialogSnapshot(view), { open: true, provider: "claude", loading: false, error: null, result });
    });
  }
});

test("配置源 Dialog：卸载后迟到成功或拒绝不写 state 或触发父回调", async (t) => {
  for (const outcome of ["resolve", "reject"]) {
    await t.test(outcome, async () => {
      const view = mountDialog("codex");
      const request = view.requests[0];
      assert.equal(view.modal().loading, true);
      view.unmount();

      if (outcome === "resolve") request.resolve(source("codex"));
      else request.reject(new Error("unmounted source read failed"));
      await view.flush();
      assert.equal(view.runtime.writesAfterUnmount, 0, "settling a disposed request must not call state setters");
      assert.deepEqual(view.callbacks, []);
    });
  }
});

test("配置源 Dialog：刷新保留先前结果，且同一打开状态最新请求胜出", async () => {
  const view = mountDialog("codex");
  const initial = source("codex");
  view.requests[0].resolve(initial);
  await view.flush();

  const olderRefreshResult = { ...source("codex"), path: "/fixtures/refresh-old/config.json" };
  const olderRefresh = view.refresh();
  assert.equal(view.modal().loading, true);
  assert.deepEqual(view.modal().result, initial, "refresh loading must keep the visible result");
  const newerRefreshResult = { ...source("codex"), path: "/fixtures/refresh-new/config.json" };
  const newerRefresh = view.refresh();
  assert.equal(view.requests.length, 3);
  assert.deepEqual(view.modal().result, initial, "overlapping refreshes must keep the last settled result");

  newerRefresh.resolve(newerRefreshResult);
  await view.flush();
  const expected = { open: true, provider: "codex", loading: false, error: null, result: newerRefreshResult };
  assert.deepEqual(dialogSnapshot(view), expected);

  olderRefresh.resolve(olderRefreshResult);
  await view.flush();
  assert.deepEqual(dialogSnapshot(view), expected, "an earlier refresh must not replace the latest result");
});

test("配置源 Dialog：关闭、重开后的旧清理刷新 A 不能覆盖重开读取 B", async (t) => {
  for (const outcome of ["resolve", "reject"]) {
    await t.test(`旧刷新 ${outcome}`, async () => {
      const view = mountDialog("codex");
      const initial = source("codex");
      view.requests[0].resolve(initial);
      await view.flush();

      const oldRefreshResult = { ...source("codex"), path: "/fixtures/cleanup-refresh-A/config.json" };
      const refreshA = view.refresh();
      view.close();
      view.open("codex");
      assert.equal(view.requests.length, 3);
      const readB = view.requests[2];
      assert.deepEqual(readB.input, { provider: "codex" });
      assert.deepEqual(dialogSnapshot(view), { open: true, provider: "codex", loading: true, error: null, result: null });

      const resultB = { ...source("codex"), path: "/fixtures/reopened-read-B/config.json" };
      readB.resolve(resultB);
      await view.flush();
      const expected = { open: true, provider: "codex", loading: false, error: null, result: resultB };
      assert.deepEqual(dialogSnapshot(view), expected);

      if (outcome === "resolve") refreshA.resolve(oldRefreshResult);
      else refreshA.reject(new Error("old cleanup refresh failed"));
      await view.flush();
      assert.deepEqual(dialogSnapshot(view), expected,
        "a refresh started by the previous modal session must not replace its reopened read");
    });
  }
});

test("配置源 Dialog：读取失败可显示错误，后续刷新成功清除错误且保留结果期间的刷新状态", async () => {
  const view = mountDialog("codex");
  view.requests[0].reject(new Error("source unavailable"));
  await view.flush();
  const failed = dialogSnapshot(view);
  assert.equal(failed.loading, false);
  assert.ok(failed.error, "a failed read must be represented for the modal");

  const retryResult = source("codex");
  const retry = view.refresh();
  assert.equal(view.modal().loading, true);
  assert.equal(view.modal().error, null, "a retry must clear the previous failure while it is in flight");
  assert.equal(view.modal().result, null);
  retry.resolve(retryResult);
  await view.flush();
  assert.deepEqual(dialogSnapshot(view), { open: true, provider: "codex", loading: false, error: null, result: retryResult });
});

test("配置源 Dialog：把 onClose 和 onChanged 原样转交给 Modal", () => {
  const view = mountDialog("codex");
  const modal = view.modal();
  assert.equal(typeof modal.onClose, "function");
  assert.equal(typeof modal.onChanged, "function");
  assert.equal(modal.onClose, view.onClose);
  assert.equal(modal.onChanged, view.onChanged);
  modal.onClose();
  modal.onChanged();
  assert.deepEqual(view.callbacks, ["close", "changed"]);
});
