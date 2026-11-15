import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

/**
 * 地址 / 凭据 / 高级 env / 显示名共用的内联编辑器。
 *
 * 不渲染 React：组件本身无 Hook，直接调用函数检查返回的元素树，
 * 钉住「空白不能保存、保存/取消回调、凭据遮蔽、无障碍标签」这几条。
 */

const editorUrl = new URL("../client/deck/surfaces/orchestration/EnvEditor.tsx", import.meta.url);
const element = (type, props, key) => ({ type, props: props ?? {}, key });
const skin = { colors: { ink2: "ink2" }, mono: { fontFamily: "fixture-mono" }, input: { borderWidth: 1 } };
const t = (key) => key;

function loadEditor() {
  const module = { exports: {} };
  const boundaries = {
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: "Fragment" },
    "react-native": { Text: "Text", View: "View" },
    "@getpaseo/plugin/client/ui": { TextInput: "TextInput" },
    "../../pixel": { PixelButton: "PixelButton" },
  };
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(editorUrl, "utf8"), {
    fileName: editorUrl.pathname,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(diagnostics.length, 0, "the editor must transpile before testing its behavior");
  const requireBoundary = (name) => {
    if (Object.hasOwn(boundaries, name)) return boundaries[name];
    throw new Error(`Unexpected editor import: ${name}`);
  };
  new Function("require", "module", "exports", outputText)(requireBoundary, module, module.exports);
  assert.equal(typeof module.exports.EnvEditor, "function");
  return module.exports.EnvEditor;
}

function nodesOf(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) nodesOf(child, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;
  found.push(node);
  nodesOf(node.props.children, found);
  return found;
}

const EnvEditor = loadEditor();

test("空值禁用保存；输入、保存与取消都走传入的回调", () => {
    const calls = [];
    const empty = EnvEditor({
      skin,
      t,
      value: "",
      busy: false,
      onChange: (value) => calls.push(`change:${value}`),
      onSave: () => calls.push("save"),
      onCancel: () => calls.push("cancel"),
    });
    const emptyNodes = nodesOf(empty);
    const input = emptyNodes.find((node) => node.type === "TextInput");
    const save = emptyNodes.find((node) => node.type === "PixelButton" && node.props.label === "orch.saveEnv");
    const cancel = emptyNodes.find((node) => node.type === "PixelButton" && node.props.label === "orch.cancel");
    assert.equal(input.props.value, "");
    assert.equal(save.props.disabled, true, "blank values must not be saveable");
    assert.equal(cancel.props.disabled, undefined);
    input.props.onChangeText("sk-new");
    cancel.props.onPress();
    assert.deepEqual(calls, ["change:sk-new", "cancel"]);

    const filled = EnvEditor({
      skin,
      t,
      value: "sk-new",
      busy: false,
      onChange: () => {},
      onSave: () => calls.push("save"),
      onCancel: () => {},
    });
    const saveFilled = nodesOf(filled).find(
      (node) => node.type === "PixelButton" && node.props.label === "orch.saveEnv",
    );
    assert.equal(saveFilled.props.disabled, false);
    saveFilled.props.onPress();
    assert.deepEqual(calls, ["change:sk-new", "cancel", "save"]);
  });

test("busy 阻断保存；secure 与无障碍标签原样传给输入框", () => {
  const tree = EnvEditor({
    skin,
    t,
    value: "sk-secret",
    busy: true,
    secure: true,
    label: "OPENAI_API_KEY",
    placeholder: "placeholder-key",
    accessibilityLabel: "OPENAI_API_KEY",
    onChange: () => {},
    onSave: () => {},
    onCancel: () => {},
  });
  const nodes = nodesOf(tree);
  const input = nodes.find((node) => node.type === "TextInput");
  const save = nodes.find((node) => node.type === "PixelButton" && node.props.label === "orch.saveEnv");
  assert.equal(save.props.disabled, true);
  assert.equal(input.props.secureTextEntry, true);
  assert.equal(input.props.accessibilityLabel, "OPENAI_API_KEY");
  assert.equal(input.props.placeholder, "placeholder-key");
  assert.ok(nodes.some((node) => node.type === "Text" && node.props.children === "OPENAI_API_KEY"));
});
