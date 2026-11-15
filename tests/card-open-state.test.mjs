import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

/**
 * 卡片展开状态：收起与切换都必须丢掉明文、编辑态与安装确认。
 *
 * 不渲染 React：用一个只实现 `useState` 的最小调度器重跑 Hook，
 * 钉住「收起当前卡片同样执行清理」这条曾经漏掉的路径。
 */

const hookUrl = new URL("../client/deck/surfaces/orchestration/useCardOpenState.ts", import.meta.url);

function loadHook(useState) {
  const module = { exports: {} };
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(hookUrl, "utf8"), {
    fileName: hookUrl.pathname,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(diagnostics.length, 0, "the hook must transpile before testing its behavior");
  const requireBoundary = (name) => {
    if (name === "react") return { useState };
    throw new Error(`Unexpected hook import: ${name}`);
  };
  new Function("require", "module", "exports", outputText)(requireBoundary, module, module.exports);
  assert.equal(typeof module.exports.useCardOpenState, "function");
  return module.exports.useCardOpenState;
}

/** 最小 Hook 运行时：按调用顺序保存 state，setState 后同步重跑。 */
function mount(deps) {
  const states = [];
  let index = 0;
  let api;
  let hook;
  const render = () => {
    index = 0;
    api = hook(deps);
  };
  const useState = (initial) => {
    const slot = index++;
    if (slot >= states.length) states.push(typeof initial === "function" ? initial() : initial);
    return [
      states[slot],
      (value) => {
        states[slot] = typeof value === "function" ? value(states[slot]) : value;
        render();
      },
    ];
  };
  hook = loadHook(useState);
  render();
  return () => api;
}

function callsRecorder() {
  const calls = [];
  return {
    calls,
    deps: {
      editing: { cancel: () => calls.push("cancel") },
      reveal: { hide: () => calls.push("hide") },
      diagnostics: { setConfirmId: (id) => calls.push(`confirm:${id}`) },
    },
  };
}

test("收起当前卡片同样清掉明文、编辑态与安装确认", () => {
  const { calls, deps } = callsRecorder();
  const api = mount(deps);
  api().toggleOpen("alpha");
  assert.equal(api().openFor("alpha"), true);

  calls.length = 0;
  api().toggleOpen("alpha");
  assert.equal(api().openFor("alpha"), false);
  assert.deepEqual(calls, ["hide", "cancel", "confirm:null"]);
});

test("切换到另一张卡片先清理旧状态，再展开新卡片", () => {
  const { calls, deps } = callsRecorder();
  const api = mount(deps);
  api().toggleOpen("alpha");

  calls.length = 0;
  api().toggleOpen("beta");
  assert.equal(api().openFor("alpha"), false);
  assert.equal(api().openFor("beta"), true);
  assert.deepEqual(calls, ["hide", "cancel", "confirm:null"]);
});

test("高级区展开与收起都取消编辑态", () => {
  const { calls, deps } = callsRecorder();
  const api = mount(deps);
  api().toggleAdvanced("alpha");
  assert.equal(api().advancedFor("alpha"), true);
  assert.deepEqual(calls, ["cancel"]);

  calls.length = 0;
  api().toggleAdvanced("alpha");
  assert.equal(api().advancedFor("alpha"), false);
  assert.deepEqual(calls, ["cancel"]);
});

test("配置源弹窗按 provider 打开与关闭", () => {
  const { deps } = callsRecorder();
  const api = mount(deps);
  api().openSource("alpha");
  assert.equal(api().sourceProvider, "alpha");
  api().closeSource();
  assert.equal(api().sourceProvider, null);
});
