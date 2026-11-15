import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import * as providerEnv from "../shared/provider-env.ts";
import * as providerInstall from "../shared/provider-install.ts";
import * as providerModels from "../shared/provider-models.ts";

/**
 * 需求 1 的界面接线：凭据未设置时可「改」、密钥行可显示 / 改、
 * 高级 env 行可改与新增、显示名可改。
 *
 * 驱动的是整张 `ProviderCard`（含卡片体的字段组装与 `envKeysFor` 键推导），
 * 只把 React / 原生控件 / 宿主 UI 换成标记；无 Hook 的纯函数子组件直接展开。
 * fixture 用生产的 `envDisplayOf` / `credentialKeysOf` / `baseUrlOf` 派生，
 * 避免测出线上不会出现的形状。
 */

const fieldsUrl = new URL("../client/deck/surfaces/orchestration/ProviderCardFields.tsx", import.meta.url);
const advancedUrl = new URL("../client/deck/surfaces/orchestration/ProviderAdvancedFields.tsx", import.meta.url);
const stylesUrl = new URL("../client/deck/surfaces/orchestration/providerCardStyles.ts", import.meta.url);
const cardUrl = new URL("../client/deck/surfaces/orchestration/ProviderCard.tsx", import.meta.url);
const element = (type, props, key) => ({ type, props: props ?? {}, key });
const t = (key) => key;
const MODEL_IDS = ["claude-sonnet-5-5"];

const skin = {
  colors: { ink: "#1", ink2: "#2", acc: "#3", ok: "#4", bad: "#5", line: "#6" },
  mono: { fontFamily: "fixture-mono" },
  input: {},
  hint: {},
};
const jsxRuntime = { jsx: element, jsxs: element, Fragment: "Fragment" };
const reactNative = { Text: "Text", View: "View", Pressable: "Pressable" };
const pixel = { PixelCard: "PixelCard", PixelButton: "PixelButton" };
const sharedBoundaries = {
  "react/jsx-runtime": jsxRuntime,
  "react-native": reactNative,
  "../../../../shared/provider-models.ts": providerModels,
  "../../pixel.tsx": pixel,
  "./EnvEditor.tsx": { EnvEditor: "EnvEditor" },
};
const fieldsBoundaries = {
  ...sharedBoundaries,
  "./ModelPicker.tsx": { ModelPicker: "ModelPicker" },
  "./ModelThinkingList.tsx": { ModelThinkingList: "ModelThinkingList" },
};
const advancedBoundaries = {
  ...sharedBoundaries,
  "@getpaseo/plugin/client/ui": { TextInput: "TextInput" },
};

function loadModule(url, boundaries) {
  const module = { exports: {} };
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(url, "utf8"), {
    fileName: url.pathname,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(diagnostics.length, 0, `${url.pathname} must transpile before testing its behavior`);
  const requireBoundary = (name) => {
    if (Object.hasOwn(boundaries, name)) return boundaries[name];
    throw new Error(`Unexpected import: ${name}`);
  };
  new Function("require", "module", "exports", outputText)(requireBoundary, module, module.exports);
  return module.exports;
}

const fieldsModule = loadModule(fieldsUrl, fieldsBoundaries);
const advancedModule = loadModule(advancedUrl, advancedBoundaries);
const stylesModule = loadModule(stylesUrl, {});
const ProviderCard = loadModule(cardUrl, {
  "react/jsx-runtime": jsxRuntime,
  "react-native": reactNative,
  "../../../../shared/provider-env.ts": providerEnv,
  "../../../../shared/provider-install.ts": providerInstall,
  "../../pixel.tsx": pixel,
  "./ProviderCardFields.tsx": fieldsModule,
  "./ProviderSitesField.tsx": { SitesField: "SitesField" },
  "./ProviderToolsField.tsx": { ToolsField: "ToolsField" },
  "./ProviderAdvancedFields.tsx": advancedModule,
  "./providerCardStyles.ts": stylesModule,
}).ProviderCard;

function nodesOf(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) nodesOf(child, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;
  // 被测组件里的子组件都是无 Hook 的纯函数，直接调用即可展开；
  // 标记字符串（Text / View / PixelButton 等）照常作为叶子保留。
  if (typeof node.type === "function") {
    nodesOf(node.type(node.props), found);
    return found;
  }
  found.push(node);
  nodesOf(node.props.children, found);
  return found;
}

const nodesIn = (tree) => nodesOf(tree);
const button = (tree, label) =>
  nodesIn(tree).find((node) => node.type === "PixelButton" && node.props.label === label);
const buttons = (tree, label) =>
  nodesIn(tree).filter((node) => node.type === "PixelButton" && node.props.label === label);
const editorIn = (tree) => nodesIn(tree).find((node) => node.type === "EnvEditor");
const hasText = (tree, text) =>
  nodesIn(tree).some((node) => node.type === "Text" && node.props.children === text);

/** 卡片体的字段行：外层 View 的第一个 Text 是字段名。 */
function fieldRowOf(tree, label) {
  return nodesIn(tree).find(
    (node) =>
      node.type === "View" &&
      Array.isArray(node.props.children) &&
      node.props.children.some((child) => child?.type === "Text" && child.props.children === label),
  );
}

/** 高级区的一行：外层 View 的第一个 Text 是 env 键名。 */
function advancedRowOf(tree, key) {
  return nodesIn(tree).find(
    (node) =>
      node.type === "View" &&
      Array.isArray(node.props.children) &&
      node.props.children.some((child) => child?.type === "Text" && child.props.children === key),
  );
}

function envRowsOf(rawEnv) {
  return Object.entries(rawEnv).map(([key, value]) => {
    const display = providerModels.envDisplayOf(key, value, MODEL_IDS);
    return { key, display: display.display, masked: display.masked, hasValue: value.trim().length > 0 };
  });
}

function providerOf(rawEnv = {}) {
  const baseUrl = providerModels.baseUrlOf(rawEnv);
  return {
    id: "claude",
    label: "Claude Code",
    enabled: true,
    status: "ready",
    models: MODEL_IDS,
    modelThinking: [],
    modelCapabilities: [],
    configModels: [],
    modelsKey: "additionalModels",
    extends: null,
    baseUrl: baseUrl?.value ?? null,
    credentialKeys: providerModels.credentialKeysOf(rawEnv),
    env: envRowsOf(rawEnv),
    sites: [],
    enabledSiteId: null,
  };
}

function cardProps({ rawEnv = {}, open = true, advanced = true, editingAt = null, draft = "", addition = {} } = {}) {
  const provider = providerOf(rawEnv);
  const calls = [];
  const additionState = { key: addition.key ?? "", value: addition.value ?? "" };
  const props = {
    skin,
    t,
    provider,
    providers: [provider],
    modelThinking: [],
    busy: false,
    open,
    advanced,
    onToggleOpen: () => calls.push(["toggleOpen"]),
    onToggleAdvanced: () => calls.push(["toggleAdvanced"]),
    onOpenSource: () => calls.push(["openSource"]),
    editing: {
      fieldFor: (id) => (editingAt?.provider === id ? editingAt.field : null),
      draft,
      start: (id, field, value) => calls.push(["start", id, field, value]),
      change: (value) => calls.push(["change", value]),
      save: (id, field) => calls.push(["save", id, field]),
      cancel: () => calls.push(["cancel"]),
    },
    reveal: {
      currentFor: () => null,
      busy: false,
      show: (id, key) => calls.push(["show", id, key]),
      hide: () => calls.push(["hide"]),
    },
    diagnostics: {},
    site: {},
    addition: {
      get key() {
        return additionState.key;
      },
      get value() {
        return additionState.value;
      },
      changeKey: (value) => {
        additionState.key = value;
        calls.push(["key", value]);
      },
      changeValue: (value) => {
        additionState.value = value;
        calls.push(["value", value]);
      },
    },
    onSaveEnv: (input) => calls.push(["saveEnv", input]),
    onSaveModel: () => {},
    onSaveThinking: () => {},
    onFetchModels: async () => ({ ok: false, detail: "" }),
  };
  return { props, calls, provider };
}

const CONFIGURED = {
  ANTHROPIC_BASE_URL: "https://api.example.com",
  ANTHROPIC_API_KEY: "sk-live",
  ANTHROPIC_MODEL: "claude-sonnet-5-5",
  CUSTOM_HEADERS: "x-test: 1",
};

test("整卡组装：没配地址与凭据时，两个「改」分别落在卡片推导出的真实键上", () => {
  const { props, calls, provider } = cardProps();
  assert.deepEqual(provider.credentialKeys, []);
  const tree = ProviderCard(props);
  const baseRow = fieldRowOf(tree, "orch.field.baseUrl");
  const credentialRow = fieldRowOf(tree, "orch.field.credential");
  assert.ok(baseRow, "card body must include the base URL field");
  assert.ok(credentialRow, "card body must include the credential field");
  assert.ok(fieldRowOf(tree, "orch.field.models"), "card body must include the models field");
  assert.ok(hasText(baseRow, "orch.notSet"));
  assert.ok(hasText(credentialRow, "orch.notSet"));
  button(baseRow, "orch.envEdit").props.onPress();
  button(credentialRow, "orch.envEdit").props.onPress();
  assert.deepEqual(calls, [
    ["start", "claude", "env:ANTHROPIC_BASE_URL", ""],
    ["start", "claude", "env:ANTHROPIC_API_KEY", ""],
  ]);
  assert.ok(button(tree, "orch.rename"), "advanced identity row is part of the card");
});

test("整卡组装：地址 / 凭据 / 高级行都按 envKeysFor 的键接线", () => {
  const { props, calls, provider } = cardProps({ rawEnv: CONFIGURED });
  assert.deepEqual(provider.credentialKeys, ["ANTHROPIC_API_KEY"]);
  assert.equal(provider.env.find((item) => item.key === "ANTHROPIC_API_KEY")?.masked, true);
  assert.equal(provider.env.find((item) => item.key === "ANTHROPIC_MODEL")?.masked, false);

  const tree = ProviderCard(props);
  const baseRow = fieldRowOf(tree, "orch.field.baseUrl");
  const credentialRow = fieldRowOf(tree, "orch.field.credential");
  const modelRow = advancedRowOf(tree, "ANTHROPIC_MODEL");
  const headerRow = advancedRowOf(tree, "CUSTOM_HEADERS");
  assert.ok(baseRow && credentialRow && modelRow && headerRow);

  button(baseRow, "orch.envEdit").props.onPress();
  button(credentialRow, "orch.envEdit").props.onPress();
  button(modelRow, "orch.envEdit").props.onPress();
  button(headerRow, "orch.envEdit").props.onPress();
  assert.deepEqual(calls, [
    ["start", "claude", "env:ANTHROPIC_BASE_URL", "https://api.example.com"],
    ["start", "claude", "env:ANTHROPIC_API_KEY", ""],
    ["start", "claude", "env:ANTHROPIC_MODEL", ""],
    ["start", "claude", "env:CUSTOM_HEADERS", ""],
  ]);

  assert.equal(button(modelRow, "orch.envReveal"), undefined, "plain model rows do not offer reveal");
  button(credentialRow, "orch.envReveal").props.onPress();
  button(headerRow, "orch.envReveal").props.onPress();
  assert.deepEqual(calls.slice(4), [
    ["show", "claude", "ANTHROPIC_API_KEY"],
    ["show", "claude", "CUSTOM_HEADERS"],
  ]);

  nodesIn(tree).filter((node) => node.type === "Pressable").at(-1).props.onPress();
  assert.deepEqual(calls.at(-1), ["toggleAdvanced"]);
});

test("凭据编辑：onChange / onSave / onCancel 都接到卡片回调", () => {
  const { props, calls } = cardProps({
    rawEnv: CONFIGURED,
    editingAt: { provider: "claude", field: "env:ANTHROPIC_API_KEY" },
    draft: "sk-new",
  });
  const tree = ProviderCard(props);
  const editor = editorIn(fieldRowOf(tree, "orch.field.credential"));
  assert.equal(editor.props.secure, true);
  assert.equal(editor.props.value, "sk-new");
  assert.equal(editor.props.accessibilityLabel, "ANTHROPIC_API_KEY");
  editor.props.onChange("sk-newer");
  editor.props.onSave();
  editor.props.onCancel();
  assert.deepEqual(calls, [
    ["change", "sk-newer"],
    ["save", "claude", "env:ANTHROPIC_API_KEY"],
    ["cancel"],
  ]);
});

test("地址编辑：带出当前值并接住 onChange", () => {
  const { props, calls } = cardProps({
    rawEnv: CONFIGURED,
    editingAt: { provider: "claude", field: "env:ANTHROPIC_BASE_URL" },
    draft: "https://proxy.example.com",
  });
  const tree = ProviderCard(props);
  const editor = editorIn(fieldRowOf(tree, "orch.field.baseUrl"));
  assert.equal(editor.props.placeholder, "https://api.example.com");
  assert.equal(editor.props.accessibilityLabel, "ANTHROPIC_BASE_URL");
  assert.equal(editor.props.secure, undefined);
  editor.props.onChange("https://proxy2.example.com");
  assert.deepEqual(calls, [["change", "https://proxy2.example.com"]]);
});

test("高级行编辑：onChange 接住，保存归属该键；改名归属 name", () => {
  const { props, calls } = cardProps({
    rawEnv: CONFIGURED,
    editingAt: { provider: "claude", field: "env:CUSTOM_HEADERS" },
    draft: "x-new: 2",
  });
  const tree = ProviderCard(props);
  const editor = editorIn(tree);
  assert.equal(editor.props.secure, true);
  assert.equal(editor.props.accessibilityLabel, "CUSTOM_HEADERS");
  editor.props.onChange("x-new: 3");
  editor.props.onSave();
  button(tree, "orch.rename").props.onPress();
  assert.deepEqual(calls, [
    ["change", "x-new: 3"],
    ["save", "claude", "env:CUSTOM_HEADERS"],
    ["start", "claude", "name", "Claude Code"],
  ]);
});

test("显示名编辑：占位是无障碍标签，onChange 接住", () => {
  const { props, calls } = cardProps({
    rawEnv: CONFIGURED,
    editingAt: { provider: "claude", field: "name" },
    draft: "Claude",
  });
  const tree = ProviderCard(props);
  const editor = editorIn(tree);
  assert.equal(editor.props.placeholder, "claude");
  assert.equal(editor.props.accessibilityLabel, "orch.field.name");
  editor.props.onChange("Claude 2");
  assert.deepEqual(calls, [["change", "Claude 2"]]);
});

test("新增 env：键或值单独为空都不能保存，onChangeText 接住，保存包上 provider 并清空", () => {
  for (const addition of [{}, { key: "NEW_KEY" }, { value: "v" }, { key: "   ", value: "v" }]) {
    const { props } = cardProps({ rawEnv: CONFIGURED, addition });
    const tree = ProviderCard(props);
    assert.equal(button(tree, "orch.saveEnv").props.disabled, true, JSON.stringify(addition));
    assert.equal(nodesIn(tree).filter((node) => node.type === "TextInput").length, 2);
  }

  const { props, calls } = cardProps({ rawEnv: CONFIGURED, addition: { key: "NEW_KEY", value: "new-value" } });
  const tree = ProviderCard(props);
  const inputs = nodesIn(tree).filter((node) => node.type === "TextInput");
  assert.equal(inputs[0].props.accessibilityLabel, "orch.envKeyField");
  assert.equal(inputs[1].props.accessibilityLabel, "orch.envValueField");
  inputs[0].props.onChangeText("OTHER_KEY");
  inputs[1].props.onChangeText("other-value");
  const save = button(tree, "orch.saveEnv");
  assert.equal(save.props.disabled, false);
  save.props.onPress();
  assert.deepEqual(calls, [
    ["key", "OTHER_KEY"],
    ["value", "other-value"],
    ["saveEnv", { provider: "claude", env: { OTHER_KEY: "other-value" } }],
    ["key", ""],
    ["value", ""],
  ]);
});

test("折叠时不渲染卡片体，头部展开与「N 个密钥」各自回调", () => {
  const { props, calls } = cardProps({ rawEnv: CONFIGURED, open: false });
  const tree = ProviderCard(props);
  assert.equal(fieldRowOf(tree, "orch.field.baseUrl"), undefined);
  assert.equal(buttons(tree, "orch.envEdit").length, 0);
  nodesIn(tree).find((node) => node.type === "Pressable").props.onPress();
  const keyCount = nodesIn(tree).find((node) => node.type === "Text" && node.props.children === "orch.keyCount");
  assert.ok(keyCount, "header shows the key count");
  keyCount.props.onPress();
  assert.deepEqual(calls, [["toggleOpen"], ["openSource"]]);
});
