import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * `docs/agents/` 里的配置读取层。
 *
 * 这里只做两件事：把受限 YAML 读成结构、把结构拼回文字。
 * 不写盘、不迁移、不删文件——用户仓库里的 `docs/agents/*` 属于用户，
 * 插件最多给出一份「打算写成什么」的计划，落盘与否由主线程在用户确认后决定。
 *
 * YAML 只实现这几种文件用得到的子集：一层映射 + 纯量 + 内联 JSON 对象。
 * 不引入运行时依赖（`package.json` 不归这条线改），也不假装支持完整 YAML：
 * 遇到清单、锚点、多行文本就明确报错，而不是猜一个可能读错的值。
 */

export const WORKSPACE_YAML_REL = "docs/agents/workspace.yaml";
export const WORKSPACE_JSON_REL = "docs/agents/workspace.json";
export const ISSUE_TRACKER_REL = "docs/agents/issue-tracker.md";
export const LABEL_COLORS_YAML_REL = "docs/agents/label-colors.yaml";
export const LABEL_COLORS_JSON_REL = "docs/agents/label-colors.json";

export const WORKSPACE_KNOWN_VERSION = 2;
export const LABEL_COLORS_KNOWN_VERSION = 1;
/** 与 DSH 适配器同数：超过说明拿错了文件，直接拒绝解析。 */
export const MAX_CONFIG_FILE_CHARS = 65536;
export const MAX_CONFIG_ALIASES = 50;
/** 布局取值的唯一真源在 DSH 的 doc-layout；这里保留调用方默认传入的同一组字面量。 */
export const DOC_LAYOUT_VALUES = ["single", "multi"] as const;

export type TrackerBackend = "markdown" | "github" | "gitlab";
export type ConfigFailureReason = "bad-shape" | "unknown-keys" | "yaml-error" | "oversize" | "aliases" | "version-newer";

export interface ConfigFailure {
  ok: false;
  reason: ConfigFailureReason;
  message: string;
  keys?: string[];
}

/* ------------------------------------------------------------------ 受限 YAML */

type YamlValue = string | number | boolean | null | YamlTable;
/** 用 interface 而不是 `Record<string, YamlValue>`：直接递归的类型别名会被 TS 判成循环引用。 */
interface YamlTable {
  [key: string]: YamlValue;
}
type YamlFailureReason = "yaml-error" | "aliases" | "oversize";

type ScalarResult = { ok: true; value: YamlValue } | { ok: false; reason: "yaml-error" | "aliases"; message: string };
type KeyValue = { ok: true; key: string; rest: string } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(table: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyTable(): Record<string, YamlValue> {
  // 用无原型对象装键：`__proto__` 之类的键才不会改写原型链。
  return Object.create(null) as Record<string, YamlValue>;
}

function stripYamlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'" && line[index + 1] === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) return line.slice(0, index);
  }
  return line;
}

function countAliases(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    const hits = stripYamlComment(line).match(/(^|[\s[{,])\*[A-Za-z0-9_-]+/g);
    if (hits) count += hits.length;
  }
  return count;
}

function hasDocumentContent(text: string): boolean {
  for (const raw of text.split("\n")) {
    const line = stripYamlComment(raw).trim();
    if (!line || line === "---" || line === "...") continue;
    return true;
  }
  return false;
}

function parseSingleQuoted(raw: string): ScalarResult {
  let out = "";
  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (char !== "'") {
      out += char;
      continue;
    }
    if (raw[index + 1] === "'") {
      out += "'";
      index += 1;
      continue;
    }
    if (raw.slice(index + 1).trim() !== "") return { ok: false, reason: "yaml-error", message: "单引号结束之后还有内容" };
    return { ok: true, value: out };
  }
  return { ok: false, reason: "yaml-error", message: "单引号没有闭合" };
}

function parseDoubleQuoted(raw: string): ScalarResult {
  let out = "";
  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (char === '"') {
      if (raw.slice(index + 1).trim() !== "") return { ok: false, reason: "yaml-error", message: "双引号结束之后还有内容" };
      return { ok: true, value: out };
    }
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[index + 1] ?? "";
    const simple: Record<string, string> = { "\\": "\\", '"': '"', "/": "/", n: "\n", r: "\r", t: "\t", "0": "\0" };
    if (hasOwn(simple, next)) {
      out += simple[next] ?? "";
      index += 1;
      continue;
    }
    if (next === "u") {
      const hex = raw.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { ok: false, reason: "yaml-error", message: "\\u 转义后面必须是四位十六进制" };
      out += String.fromCharCode(parseInt(hex, 16));
      index += 5;
      continue;
    }
    return { ok: false, reason: "yaml-error", message: `不认识的转义 \\${next}` };
  }
  return { ok: false, reason: "yaml-error", message: "双引号没有闭合" };
}

function toYamlValue(value: unknown): ScalarResult {
  if (value === null || typeof value === "string" || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: "yaml-error", message: "数字不是有限值" };
    return { ok: true, value };
  }
  if (Array.isArray(value)) return { ok: false, reason: "yaml-error", message: "清单值不在受限 YAML 的范围里" };
  if (isRecord(value)) {
    const table = emptyTable();
    for (const key of Object.keys(value)) {
      const inner = toYamlValue(value[key]);
      if (!inner.ok) return inner;
      table[key] = inner.value;
    }
    return { ok: true, value: table };
  }
  return { ok: false, reason: "yaml-error", message: "值不是纯量或映射" };
}

function parseScalar(raw: string, lineNumber: number): ScalarResult {
  const text = raw.trim();
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { ok: false, reason: "yaml-error", message: `第 ${lineNumber} 行的行内对象不是合法 JSON（受限 YAML 只认 {"key": 值} 这种写法）：${errorText(error)}` };
    }
    return toYamlValue(parsed);
  }
  if (text.startsWith("[")) return { ok: false, reason: "yaml-error", message: `第 ${lineNumber} 行用了清单写法，不在受限 YAML 的范围里` };
  if (text.startsWith('"')) return parseDoubleQuoted(text);
  if (text.startsWith("'")) return parseSingleQuoted(text);
  if (/^[&*][A-Za-z0-9_-]+/.test(text)) return { ok: false, reason: "aliases", message: `第 ${lineNumber} 行用了锚点或别名，受限 YAML 不支持` };
  if (/^(true|True|TRUE)$/.test(text)) return { ok: true, value: true };
  if (/^(false|False|FALSE)$/.test(text)) return { ok: true, value: false };
  if (/^(null|Null|NULL|~)$/.test(text)) return { ok: true, value: null };
  if (/^[-+]?[0-9]+$/.test(text)) return { ok: true, value: Number(text) };
  if (/^[-+]?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[eE][-+]?[0-9]+)$/.test(text)) return { ok: true, value: Number(text) };
  if (/^[-+]?(?:[0-9]+\.[0-9]*|\.[0-9]+)$/.test(text)) return { ok: true, value: Number(text) };
  return { ok: true, value: text };
}

function splitKeyValue(line: string): KeyValue {
  const text = line.trim();
  if (!text) return { ok: false, message: "空行不能作为键值" };
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    let end = -1;
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index] ?? "";
      if (quote === '"' && char === "\\") index += 1;
      else if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") index += 1;
        else {
          end = index;
          break;
        }
      }
    }
    if (end < 0) return { ok: false, message: "键的引号没有闭合" };
    const rawKey = text.slice(0, end + 1);
    const decoded = quote === '"' ? parseDoubleQuoted(rawKey) : parseSingleQuoted(rawKey);
    if (!decoded.ok || typeof decoded.value !== "string") return { ok: false, message: "键不是一段合法文字" };
    const after = text.slice(end + 1).trimStart();
    if (!after.startsWith(":")) return { ok: false, message: "键后面缺少冒号" };
    return { ok: true, key: decoded.value, rest: after.slice(1).trim() };
  }
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ":") continue;
    const next = text[index + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    const key = text.slice(0, index).trim();
    if (!key) return { ok: false, message: "冒号前面没有键名" };
    return { ok: true, key, rest: text.slice(index + 1).trim() };
  }
  return { ok: false, message: `这一行不是「键: 值」：${text.slice(0, 80)}` };
}

function rejectPlaceholder(value: YamlValue, placeholders: Set<object>): YamlValue {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (placeholders.has(value) && Object.keys(value).length === 0) return null;
  }
  return value;
}

/**
 * 解析受限 YAML。
 *
 * 支持：顶层 `键: 值`、一层缩进映射、行内 JSON 对象、引号文字、布尔/数字/null、`#` 行注释。
 * 拒绝：清单、锚点别名、多行块、多层缩进、重复键。拒绝时给行号，不静默丢掉内容。
 */
export function parseYamlSubset(text: string): { ok: true; value: Record<string, YamlValue> } | { ok: false; reason: YamlFailureReason; message: string } {
  if (typeof text !== "string") return { ok: false, reason: "yaml-error", message: "要解析的不是一段文字" };
  const source = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (source.length > MAX_CONFIG_FILE_CHARS) {
    return { ok: false, reason: "oversize", message: `这份文件太大了（${source.length} 字，上限 ${MAX_CONFIG_FILE_CHARS} 字），拒绝解析：配置文件本该很小，超了说明拿错了文件` };
  }
  const aliases = countAliases(source);
  if (aliases > MAX_CONFIG_ALIASES) {
    return { ok: false, reason: "aliases", message: `这份文件里的别名太多了（上限 ${MAX_CONFIG_ALIASES} 个），拒绝解析：正常配置文件里一个别名都不会有` };
  }
  if (!hasDocumentContent(source)) return { ok: false, reason: "yaml-error", message: "这份文件里什么都没有（空白文件）" };

  const trimmed = source.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return { ok: false, reason: "yaml-error", message: `文件看起来是 JSON，但解析失败：${errorText(error)}` };
    }
    if (!isRecord(parsed)) return { ok: false, reason: "yaml-error", message: "顶层不是一组「名字 → 值」" };
    const converted = toYamlValue(parsed);
    if (!converted.ok) return converted;
    if (!isRecord(converted.value)) return { ok: false, reason: "yaml-error", message: "顶层不是一组「名字 → 值」" };
    return { ok: true, value: converted.value as Record<string, YamlValue> };
  }

  const table = emptyTable();
  const placeholders = new Set<object>();
  let nested: { table: Record<string, YamlValue>; key: string; indent: number } | null = null;
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index] ?? "";
    const withoutComment = stripYamlComment(raw);
    if (!withoutComment.trim()) continue;
    if (/^\s*---\s*$/.test(withoutComment) || /^\s*\.\.\.\s*$/.test(withoutComment)) continue;
    const leading = /^[ \t]*/.exec(withoutComment)?.[0] ?? "";
    if (leading.includes("\t")) return { ok: false, reason: "yaml-error", message: `第 ${lineNumber} 行用了制表符缩进：YAML 只认空格缩进` };
    const indent = leading.length;
    if (/^\s*-(\s|$)/.test(withoutComment)) return { ok: false, reason: "yaml-error", message: `第 ${lineNumber} 行用了清单写法，不在受限 YAML 的范围里` };
    const split = splitKeyValue(withoutComment);
    if (!split.ok) return { ok: false, reason: "yaml-error", message: `第 ${lineNumber} 行：${split.message}` };

    if (indent > 0) {
      if (!nested) return { ok: false, reason: "yaml-error", message: `第 ${lineNumber} 行的缩进没有归属：受限 YAML 只支持一层缩进映射` };
      if (nested.indent < 0) nested.indent = indent;
      else if (indent !== nested.indent) return { ok: false, reason: "yaml-error", message: `第 ${lineNumber} 行的缩进与同组不一致：受限 YAML 只支持一层缩进映射` };
      if (hasOwn(nested.table, split.key)) return { ok: false, reason: "yaml-error", message: `第 ${lineNumber} 行的键「${split.key}」重复了` };
      if (!split.rest) return { ok: false, reason: "yaml-error", message: `第 ${lineNumber} 行缺少值：受限 YAML 不支持第二层映射` };
      const parsed = parseScalar(split.rest, lineNumber);
      if (!parsed.ok) return parsed;
      nested.table[split.key] = parsed.value;
      continue;
    }

    if (hasOwn(table, split.key)) return { ok: false, reason: "yaml-error", message: `第 ${lineNumber} 行的键「${split.key}」重复了` };
    if (!split.rest) {
      const child = emptyTable();
      placeholders.add(child);
      table[split.key] = child;
      nested = { table: child, key: split.key, indent: -1 };
      continue;
    }
    const parsed = parseScalar(split.rest, lineNumber);
    if (!parsed.ok) return parsed;
    table[split.key] = parsed.value;
    nested = null;
  }

  if (nested && nested.indent < 0) {
    // 声明了子映射却没有任何缩进行：YAML 里这是 null，不是空映射。
    table[nested.key] = null;
  }
  for (const key of Object.keys(table)) table[key] = rejectPlaceholder(table[key] ?? null, placeholders);
  return { ok: true, value: table };
}

/* ------------------------------------------------------------------ 工作区配置 */

export interface WorkspaceConfig {
  version: number;
  backendId: string;
  pickedAt: number;
  source: "user" | "migrated" | "detected" | "auto";
  layout?: "single" | "multi";
}

export type WorkspaceParse = { ok: true; value: WorkspaceConfig; readonly: boolean; warnings: string[] } | ConfigFailure;

const WORKSPACE_KNOWN_KEYS = ["version", "backendId", "pickedAt", "source", "layout"];
const WORKSPACE_SOURCES_V2 = ["user", "migrated", "detected"];
const WORKSPACE_SOURCES_V1 = ["user", "migrated", "detected", "auto"];
const WORKSPACE_HEADER = [
  "# 本文件的注释由插件生成；你自己加的注释会在下次写入时被替换。",
  "# 这份文件随仓库走：提交之后就团队共享，改动会影响所有人。",
];
const COMMENT_BACKEND = "# 这条工作区用哪个后端";
const COMMENT_PICKED = "# 这次选择发生的时间（毫秒）";
const COMMENT_SOURCE = "# 这条选择是谁做的：user=人在面板里亲手选的；migrated=从老版本机记忆搬来的；detected=插件按声明文件或自动识别生成的";
const COMMENT_LAYOUT_1 = "# 域文档布局：single=单上下文（各部分共用一套用语，根目录一份 GLOSSARY.md）；";
const COMMENT_LAYOUT_2 = "# multi=多上下文（各有各的用语，子项目各一份 GLOSSARY.md，根目录一份 GLOSSARY-MAP.md指过去）";

function fail(reason: ConfigFailureReason, message: string, keys?: string[]): ConfigFailure {
  return keys ? { ok: false, reason, message, keys } : { ok: false, reason, message };
}

function unknownKeys(table: Record<string, unknown>, known: readonly string[], where: string): string[] {
  return Object.keys(table).filter((key) => !known.includes(key));
}

/** 校验一份已解析出来的工作区配置；版本比认识的新的，读成功但标只读。 */
export function parseWorkspace(doc: unknown, layouts: readonly string[] = DOC_LAYOUT_VALUES): WorkspaceParse {
  if (!isRecord(doc)) return fail("bad-shape", "工作区配置文件里放的不是一组「名字 → 值」，读到的是清单或一段文字");
  const strange = unknownKeys(doc, WORKSPACE_KNOWN_KEYS, "工作区配置");
  if (strange.length > 0) return fail("unknown-keys", `工作区配置文件里有多出来的名字，核不认识它们：${strange.join("、")}`, strange);
  if (!isInteger(doc["version"])) return fail("bad-shape", "工作区配置文件里的 version 必须是数字");
  const version = doc["version"];
  if (version > WORKSPACE_KNOWN_VERSION) {
    return {
      ok: true,
      value: { version, backendId: String(doc["backendId"] ?? ""), pickedAt: Number(doc["pickedAt"] ?? 0), source: doc["source"] as WorkspaceConfig["source"] },
      readonly: true,
      warnings: [`version-newer：这份文件是版本 ${version}，核只认识到版本 ${WORKSPACE_KNOWN_VERSION}，可以读来展示，不许写回去（写回去会把新字段抹掉）。请升级插件。`],
    };
  }
  if (version !== 1 && version !== 2) return fail("bad-shape", "工作区配置文件里的 version 现在只认 1（老 JSON 迁移用）与 2");
  if (typeof doc["backendId"] !== "string" || doc["backendId"].trim() === "") {
    return fail("bad-shape", "工作区配置文件里的 backendId 必须是一段非空文字（YAML 会把没加引号的 yes/no/on 读成文字、把 1.10 读成数字，类型对不上的按坏形状回）");
  }
  if (!isInteger(doc["pickedAt"]) || doc["pickedAt"] < 0) return fail("bad-shape", "工作区配置文件里的 pickedAt 必须是选择发生的时间（毫秒，非负整数）");
  const allowed = version === 2 ? WORKSPACE_SOURCES_V2 : WORKSPACE_SOURCES_V1;
  if (typeof doc["source"] !== "string" || !allowed.includes(doc["source"])) {
    return fail(
      "bad-shape",
      version === 2
        ? "工作区配置文件里的 source 必须是 user（人亲手选的）、migrated（从老版本记忆搬来的）、detected（插件按声明或自动识别生成的）三者之一"
        : "工作区配置文件里的 source 必须是 user、migrated、detected、auto 四者之一",
    );
  }
  if (doc["layout"] !== undefined && (typeof doc["layout"] !== "string" || !layouts.includes(doc["layout"]))) {
    return fail("bad-shape", `工作区配置文件里的 layout 必须是这些取值之一：${layouts.join("、")}`);
  }
  const value: WorkspaceConfig = { version, backendId: doc["backendId"].trim(), pickedAt: doc["pickedAt"], source: doc["source"] as WorkspaceConfig["source"] };
  if (doc["layout"] !== undefined) value.layout = doc["layout"] as WorkspaceConfig["layout"];
  return { ok: true, value, readonly: false, warnings: [] };
}

export function parseWorkspaceText(text: unknown, layouts: readonly string[] = DOC_LAYOUT_VALUES): WorkspaceParse {
  const parsed = parseYamlSubset(typeof text === "string" ? text : "");
  if (!parsed.ok) return fail(parsed.reason, parsed.message);
  return parseWorkspace(parsed.value, layouts);
}

/** 写 YAML 纯量：能裸写才裸写，拿不准的一律双引号（与 DSH 的 esc 逐字一致）。 */
function escapeYaml(text: string): string {
  if (text === "") return "''";
  const lower = text.toLowerCase();
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(text) && !["yes", "no", "y", "n", "on", "off", "true", "false", "null", "~"].includes(lower)) {
    return text;
  }
  return (
    '"' +
    text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) => "\\u" + ("0000" + char.charCodeAt(0).toString(16)).slice(-4)) +
    '"'
  );
}

/** 拼装工作区配置：一律出版本 2；版本比认识的新的拒绝写。 */
export function stringifyWorkspace(value: unknown, layouts: readonly string[] = DOC_LAYOUT_VALUES): { ok: true; text: string } | ConfigFailure {
  if (!isRecord(value)) return fail("bad-shape", "要写入的工作区配置不是一组「名字 → 值」");
  const strange = unknownKeys(value, WORKSPACE_KNOWN_KEYS, "工作区配置");
  if (strange.length > 0) return fail("unknown-keys", `要写入的工作区配置里有多出来的名字，核不会把它们写进去：${strange.join("、")}`, strange);
  const version = value["version"] === undefined ? WORKSPACE_KNOWN_VERSION : value["version"];
  if (!isInteger(version)) return fail("bad-shape", "要写入的工作区配置里的 version 必须是数字（缺席默认 2）");
  if (version > WORKSPACE_KNOWN_VERSION) return fail("version-newer", `拒绝写入：这份工作区配置是版本 ${version}，核只认识到版本 ${WORKSPACE_KNOWN_VERSION}。旧版本写回去会把新字段抹掉，请升级插件后再改。`);
  if (version !== 1 && version !== WORKSPACE_KNOWN_VERSION) return fail("bad-shape", "要写入的工作区配置里的 version 必须是 1（升级写出）或 2");
  // v1 的 `auto` 在 v2 里的对应词是 `detected`：写出来一律是 v2，不把老词原样带过去。
  const source = version === 1 && value["source"] === "auto" ? "detected" : value["source"];
  const checked = parseWorkspace(
    { version: WORKSPACE_KNOWN_VERSION, backendId: value["backendId"], pickedAt: value["pickedAt"], source, layout: value["layout"] },
    layouts,
  );
  if (!checked.ok) return checked;
  const lines = [...WORKSPACE_HEADER, `version: ${checked.value.version}`, COMMENT_BACKEND, `backendId: ${escapeYaml(checked.value.backendId)}`, COMMENT_PICKED, `pickedAt: ${checked.value.pickedAt}`, COMMENT_SOURCE, `source: ${escapeYaml(checked.value.source)}`];
  if (checked.value.layout !== undefined) lines.push(COMMENT_LAYOUT_1, COMMENT_LAYOUT_2, `layout: ${escapeYaml(checked.value.layout)}`);
  return { ok: true, text: lines.join("\n") + "\n" };
}

/* ------------------------------------------------------------------ 标签配色 */

export type LabelColorValue = string | { color: string; description?: string };

export interface LabelColorsConfig {
  version: number;
  colors: Record<string, LabelColorValue>;
  /** 原写法的保留：拼装时按原样写回颜色与描述。 */
  raw: Record<string, unknown>;
}

export type LabelColorsParse = { ok: true; value: LabelColorsConfig; readonly: boolean; warnings: string[] } | ConfigFailure;

const LABEL_HEADER = ["# 本文件的注释由插件生成；你自己加的注释会在下次写入时被替换。"];
const COMMENT_VERSION = "# 这一份数据的版本号（核不认识的新版本只读不写）";
const LABEL_ENTRY_KEYS = ["color", "description"];

function isDangerousKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

export function parseLabelColorsDoc(doc: unknown): LabelColorsParse {
  if (!isRecord(doc)) return fail("bad-shape", "标签配色文件里放的不是一组「标签 → 颜色」，读到的是清单或一段文字");
  let version = LABEL_COLORS_KNOWN_VERSION;
  if (doc["version"] !== undefined) {
    if (!isInteger(doc["version"])) return fail("bad-shape", "标签配色文件里的 version 必须是数字（如果 version 是你的一个标签名，请把它改个名字：version 是版本号的位置）");
    version = doc["version"];
    if (version > LABEL_COLORS_KNOWN_VERSION) {
      return { ok: true, value: { version, colors: {}, raw: doc }, readonly: true, warnings: [`version-newer：这份文件是版本 ${version}，核只认识到版本 ${LABEL_COLORS_KNOWN_VERSION}，可以读来展示，不许写回去。请升级插件。`] };
    }
    if (version < 1) return fail("bad-shape", "标签配色文件里的 version 现在只认 1（没有版本的老文件照读）");
  }
  const colors: Record<string, LabelColorValue> = {};
  const raw: Record<string, unknown> = {};
  for (const name of Object.keys(doc)) {
    if (name === "version") continue;
    if (name.trim() === "") return fail("bad-shape", "标签配色文件里有一个标签名是空的");
    if (isDangerousKey(name)) return fail("bad-shape", `标签配色文件里不能用这个标签名：${name}`);
    const entry = doc[name];
    if (typeof entry === "string") {
      colors[name] = entry;
      raw[name] = entry;
      continue;
    }
    if (isRecord(entry)) {
      const strange = unknownKeys(entry, LABEL_ENTRY_KEYS, "标签配色");
      if (strange.length > 0) return fail("unknown-keys", `标签配色文件里标签「${name}」有多出来的名字：${strange.join("、")}`, strange);
      if (typeof entry["color"] !== "string") return fail("bad-shape", `标签配色文件里标签「${name}」的 color 必须是一段文字（颜色，不带井号的六位）`);
      if (entry["description"] !== undefined && typeof entry["description"] !== "string") return fail("bad-shape", `标签配色文件里标签「${name}」的 description 必须是一段文字`);
      const value: { color: string; description?: string } = { color: entry["color"] };
      if (entry["description"] !== undefined) value.description = entry["description"];
      colors[name] = value;
      raw[name] = value;
      continue;
    }
    return fail("bad-shape", `标签「${name}」的颜色写法不对，这个位置只能写两种样子：直接写颜色，例如 "8b5cf6"；或者写成 {"color": "8b5cf6", "description": "地图票"}`);
  }
  return { ok: true, value: { version, colors, raw }, readonly: false, warnings: [] };
}

export function parseLabelColorsText(text: unknown): LabelColorsParse {
  const parsed = parseYamlSubset(typeof text === "string" ? text : "");
  if (!parsed.ok) return fail(parsed.reason, parsed.message);
  return parseLabelColorsDoc(parsed.value);
}

/** 拼装标签配色：收直给标签表或 `{version, colors}` 包裹，写出来永远是完整模板。 */
export function stringifyLabelColors(value: unknown): { ok: true; text: string } | ConfigFailure {
  if (!isRecord(value)) return fail("bad-shape", "要写入的标签配色不是一组「标签 → 颜色」");
  const looksWrapped = value["colors"] !== undefined || isInteger(value["version"]);
  let version = LABEL_COLORS_KNOWN_VERSION;
  let table: unknown = value;
  if (looksWrapped) {
    if (!isInteger(value["version"])) return fail("bad-shape", "要写入的标签配色里的 version 必须是数字 1");
    version = value["version"];
    table = value["colors"];
  } else if ("version" in value || "colors" in value) {
    return fail("bad-shape", "直给的标签表里不能有 version / colors 这两个名字（它们是格式保留字）。请用 {version, colors} 包裹，或把这两个标签改名。");
  }
  if (version > LABEL_COLORS_KNOWN_VERSION) return fail("version-newer", `拒绝写入：这份标签配色是版本 ${version}，核只认识到版本 ${LABEL_COLORS_KNOWN_VERSION}。旧版本写回去会把新字段抹掉，请升级插件后再改。`);
  if (version !== LABEL_COLORS_KNOWN_VERSION) return fail("bad-shape", "要写入的标签配色里的 version 必须是 1");
  if (!isRecord(table)) return fail("bad-shape", "要写入的标签配色里的 colors 必须是一组「标签 → 颜色」");
  const probe = Object.assign(Object.create(null) as Record<string, unknown>, { version });
  for (const key of Object.keys(table)) {
    if (isDangerousKey(key)) return fail("bad-shape", `标签名「${key}」是保留字，不能写进配色文件`);
    probe[key] = table[key];
  }
  const checked = parseLabelColorsDoc(probe);
  if (!checked.ok) return checked;
  const colors = checked.value.colors;
  const lines = [...LABEL_HEADER, COMMENT_VERSION, "version: 1"];
  for (const name of Object.keys(colors)) {
    const entry = colors[name];
    if (entry === undefined) continue;
    if (typeof entry === "string") {
      lines.push(`${escapeYaml(name)}: ${escapeYaml(entry)}`);
      continue;
    }
    const inner = '{"color": ' + escapeYaml(entry.color) + (entry.description === undefined ? "" : ', "description": ' + escapeYaml(entry.description)) + "}";
    lines.push(`${escapeYaml(name)}: ${inner}`);
  }
  return { ok: true, text: lines.join("\n") + "\n" };
}

/* ------------------------------------------------------------------ 声明文件 */

export interface TrackerDeclaration {
  backend: TrackerBackend | null;
  rawHint: string;
  confidence: "high" | "low" | "none";
  reason: string;
}

/**
 * 读 `docs/agents/issue-tracker.md` 的显式后端声明。
 *
 * 标题优先（gitlab > markdown/local > github），正文关键词只做低置信兜底；
 * markdown 不参与正文兜底——正文里出现 `.scratch` 不代表声明了本地后端。
 */
export function parseIssueTrackerDeclaration(raw: unknown): TrackerDeclaration {
  const text = String(raw ?? "").replace(/^﻿/, "").trim();
  if (!text) return { backend: null, rawHint: "", confidence: "none", reason: "empty" };
  const titleGithub = /^#\s*issue\s*tracker\s*:\s*github/im.test(text);
  const titleGitlab = /^#\s*issue\s*tracker\s*:\s*gitlab/im.test(text);
  const titleMarkdown = /^#\s*issue\s*tracker\s*:\s*(markdown|local)/im.test(text);
  if (titleGitlab) return { backend: "gitlab", rawHint: "gitlab", confidence: "high", reason: "title-gitlab" };
  if (titleMarkdown) return { backend: "markdown", rawHint: "markdown", confidence: "high", reason: "title-markdown" };
  if (titleGithub) {
    const hint = /gh\s+(issue|api|auth)|github\s*issues/i.test(text);
    return { backend: "github", rawHint: "github", confidence: "high", reason: hint ? "github-template" : "title-github" };
  }
  if (/gitlab/i.test(text)) return { backend: "gitlab", rawHint: "gitlab", confidence: "low", reason: "keyword-gitlab" };
  if (/github/i.test(text)) {
    const hint = /gh\s+(issue|api|auth)|github\s*issues/i.test(text);
    return { backend: "github", rawHint: "github", confidence: "low", reason: hint ? "github-template" : "keyword-github" };
  }
  return { backend: null, rawHint: "", confidence: "none", reason: "no-keyword" };
}

/* ------------------------------------------------------------------ 文件读取 */

export interface ConfigReadFailure {
  ok: false;
  reason: "read-failed" | "parse-failed" | "invalid";
  detail: string;
  path: string;
  code?: ConfigFailureReason;
}

export type WorkspaceConfigRead =
  | { ok: true; present: true; from: "yaml" | "json"; path: string; config: WorkspaceConfig; readonly: boolean; warnings: string[] }
  | { ok: true; present: false; from: "none"; path: string; config: null; readonly: false; warnings: [] }
  | ConfigReadFailure;

export type LabelColorsRead =
  | { ok: true; present: true; from: "yaml" | "json"; path: string; config: LabelColorsConfig; readonly: boolean; warnings: string[] }
  | { ok: true; present: false; from: "none"; path: string; config: null; readonly: false; warnings: [] }
  | ConfigReadFailure;

type OptionalText = { present: true; text: string } | { present: false } | { present: false; error: ConfigReadFailure };

async function readOptional(filePath: string): Promise<OptionalText> {
  try {
    return { present: true, text: await readFile(filePath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
    return {
      present: false,
      error: { ok: false, reason: "read-failed", detail: `读 ${filePath} 失败：${errorText(error)}`, path: filePath },
    };
  }
}

/**
 * 读工作区配置：YAML 优先；只有 YAML 确实不存在时才读老 JSON。
 * YAML 存在但内容坏了就如实报错——退回 JSON 会把「用户写坏了」伪装成「没有配置」。
 */
export async function readWorkspaceConfig(workspaceDir: string, layouts: readonly string[] = DOC_LAYOUT_VALUES): Promise<WorkspaceConfigRead> {
  const yamlPath = path.join(workspaceDir, WORKSPACE_YAML_REL);
  const yaml = await readOptional(yamlPath);
  if ("error" in yaml) return yaml.error;
  if (yaml.present) {
    const parsed = parseWorkspaceText(yaml.text, layouts);
    if (!parsed.ok) return { ok: false, reason: "parse-failed", detail: parsed.message, path: yamlPath, code: parsed.reason };
    return { ok: true, present: true, from: "yaml", path: yamlPath, config: parsed.value, readonly: parsed.readonly, warnings: parsed.warnings };
  }
  const jsonPath = path.join(workspaceDir, WORKSPACE_JSON_REL);
  const json = await readOptional(jsonPath);
  if ("error" in json) return json.error;
  if (!json.present) return { ok: true, present: false, from: "none", path: yamlPath, config: null, readonly: false, warnings: [] };
  const parsed = parseWorkspaceText(json.text, layouts);
  if (!parsed.ok) return { ok: false, reason: "parse-failed", detail: parsed.message, path: jsonPath, code: parsed.reason };
  return { ok: true, present: true, from: "json", path: jsonPath, config: parsed.value, readonly: parsed.readonly, warnings: parsed.warnings };
}

/** 读标签配色：YAML 优先，YAML 坏了不回退（回退会把坏文件当成不存在）。 */
export async function readLabelColorsConfig(workspaceDir: string): Promise<LabelColorsRead> {
  const yamlPath = path.join(workspaceDir, LABEL_COLORS_YAML_REL);
  const yaml = await readOptional(yamlPath);
  if ("error" in yaml) return yaml.error;
  if (yaml.present) {
    const parsed = parseLabelColorsText(yaml.text);
    if (!parsed.ok) return { ok: false, reason: "parse-failed", detail: parsed.message, path: yamlPath, code: parsed.reason };
    return { ok: true, present: true, from: "yaml", path: yamlPath, config: parsed.value, readonly: parsed.readonly, warnings: parsed.warnings };
  }
  const jsonPath = path.join(workspaceDir, LABEL_COLORS_JSON_REL);
  const json = await readOptional(jsonPath);
  if ("error" in json) return json.error;
  if (!json.present) return { ok: true, present: false, from: "none", path: yamlPath, config: null, readonly: false, warnings: [] };
  const parsed = parseLabelColorsText(json.text);
  if (!parsed.ok) return { ok: false, reason: "parse-failed", detail: parsed.message, path: jsonPath, code: parsed.reason };
  return { ok: true, present: true, from: "json", path: jsonPath, config: parsed.value, readonly: parsed.readonly, warnings: parsed.warnings };
}

export interface IssueTrackerRead {
  ok: true;
  present: boolean;
  path: string;
  text: string;
  declaration: TrackerDeclaration;
}

export async function readIssueTrackerDeclaration(workspaceDir: string): Promise<IssueTrackerRead | ConfigReadFailure> {
  const filePath = path.join(workspaceDir, ISSUE_TRACKER_REL);
  const read = await readOptional(filePath);
  if ("error" in read) return read.error;
  if (!read.present) return { ok: true, present: false, path: filePath, text: "", declaration: parseIssueTrackerDeclaration("") };
  return { ok: true, present: true, path: filePath, text: read.text, declaration: parseIssueTrackerDeclaration(read.text) };
}

export interface LocalTrackerState {
  initialized: boolean;
  declared: TrackerBackend | null;
  confidence: "high" | "low" | "none";
  workspaceBackendId: string | null;
  readonly: boolean;
  reasons: string[];
}

const LOCAL_BACKEND_IDS = ["markdown", "local", "deck"];

/**
 * 工作区是否明确声明了本地 Markdown 后端。
 *
 * 只认两处显式证据：`issue-tracker.md` 的标题声明，或 `workspace.yaml` 的 backendId。
 * 两者都没有时回 `initialized: false`——新建工作区默认不写 `.scratch`，
 * 是否启用由用户在设置里确认。
 */
export async function readLocalTrackerState(workspaceDir: string): Promise<{ ok: true; state: LocalTrackerState } | ConfigReadFailure> {
  const tracker = await readIssueTrackerDeclaration(workspaceDir);
  if (!tracker.ok) return tracker;
  const workspace = await readWorkspaceConfig(workspaceDir);
  if (!workspace.ok) return workspace;
  const backendId = workspace.present ? workspace.config.backendId : null;
  const normalized = backendId?.trim().toLowerCase() ?? "";
  const byWorkspace = LOCAL_BACKEND_IDS.includes(normalized);
  const byDeclaration = tracker.declaration.backend === "markdown";
  const reasons: string[] = [];
  if (byDeclaration) reasons.push(`issue-tracker.md 标题声明 markdown（${tracker.declaration.reason}）`);
  if (byWorkspace) reasons.push(`workspace.yaml 的 backendId 是 ${backendId}`);
  if (!byDeclaration && !byWorkspace) reasons.push("没有找到本地后端的显式声明");
  return {
    ok: true,
    state: {
      initialized: byDeclaration || byWorkspace,
      declared: tracker.declaration.backend,
      confidence: tracker.declaration.confidence,
      workspaceBackendId: backendId,
      readonly: workspace.present ? workspace.readonly : false,
      reasons,
    },
  };
}

/* ------------------------------------------------------------------ 迁移计划（只算不写） */

export interface ConfigPlan {
  ok: true;
  dryRun: true;
  migrate: boolean;
  reason: string;
  from: "yaml" | "json" | "none";
  path: string;
  legacyPath?: string;
  text?: string;
  deleteLegacy?: boolean;
}

export type ConfigPlanResult = ConfigPlan | ConfigReadFailure | { ok: false; reason: "readonly" | "parse-failed" | "invalid"; detail: string; path: string };

/**
 * 老 `workspace.json` → `workspace.yaml` 的迁移计划。
 *
 * 只返回「如果迁移，会写成什么」；不写 YAML、不删 JSON。执行与否由主线程在用户确认后决定。
 */
export async function planWorkspaceMigration(workspaceDir: string, layouts: readonly string[] = DOC_LAYOUT_VALUES): Promise<ConfigPlanResult> {
  const yamlPath = path.join(workspaceDir, WORKSPACE_YAML_REL);
  const jsonPath = path.join(workspaceDir, WORKSPACE_JSON_REL);
  const yaml = await readOptional(yamlPath);
  if ("error" in yaml) return yaml.error;
  if (yaml.present) return { ok: true, dryRun: true, migrate: false, reason: "yaml-present", from: "yaml", path: yamlPath };
  const json = await readOptional(jsonPath);
  if ("error" in json) return json.error;
  if (!json.present) return { ok: true, dryRun: true, migrate: false, reason: "absent", from: "none", path: yamlPath };
  const parsed = parseWorkspaceText(json.text, layouts);
  if (!parsed.ok) return { ok: false, reason: "parse-failed", detail: parsed.message, path: jsonPath };
  if (parsed.readonly) return { ok: false, reason: "readonly", detail: `老文件的版本比核认识的（${WORKSPACE_KNOWN_VERSION}）新，迁移会丢掉新字段，拒绝计划。`, path: jsonPath };
  const encoded = stringifyWorkspace(parsed.value, layouts);
  if (!encoded.ok) return { ok: false, reason: "parse-failed", detail: encoded.message, path: jsonPath };
  return { ok: true, dryRun: true, migrate: true, reason: "legacy-json", from: "json", path: yamlPath, legacyPath: jsonPath, text: encoded.text, deleteLegacy: true };
}

/** 老 `label-colors.json` → `label-colors.yaml` 的迁移计划；同样只算不写、不删。 */
export async function planLabelColorsMigration(workspaceDir: string): Promise<ConfigPlanResult> {
  const yamlPath = path.join(workspaceDir, LABEL_COLORS_YAML_REL);
  const jsonPath = path.join(workspaceDir, LABEL_COLORS_JSON_REL);
  const yaml = await readOptional(yamlPath);
  if ("error" in yaml) return yaml.error;
  if (yaml.present) {
    const parsed = parseLabelColorsText(yaml.text);
    if (!parsed.ok) return { ok: false, reason: "parse-failed", detail: parsed.message, path: yamlPath };
    return { ok: true, dryRun: true, migrate: false, reason: "yaml-present", from: "yaml", path: yamlPath };
  }
  const json = await readOptional(jsonPath);
  if ("error" in json) return json.error;
  if (!json.present) return { ok: true, dryRun: true, migrate: false, reason: "absent", from: "none", path: yamlPath };
  const parsed = parseLabelColorsText(json.text);
  if (!parsed.ok) return { ok: false, reason: "parse-failed", detail: parsed.message, path: jsonPath };
  if (parsed.readonly) return { ok: false, reason: "readonly", detail: `老文件的版本比核认识的（${LABEL_COLORS_KNOWN_VERSION}）新，迁移会丢掉新字段，拒绝计划。`, path: jsonPath };
  const encoded = stringifyLabelColors({ version: LABEL_COLORS_KNOWN_VERSION, colors: parsed.value.raw });
  if (!encoded.ok) return { ok: false, reason: "parse-failed", detail: encoded.message, path: jsonPath };
  return { ok: true, dryRun: true, migrate: true, reason: "legacy-json", from: "json", path: yamlPath, legacyPath: jsonPath, text: encoded.text, deleteLegacy: true };
}

/**
 * 标签颜色的写入计划。
 *
 * 与 DSH 的 setLabelColors 同口径：文件必须已存在、只改已有标签；这里只产出文字，
 * 不落盘。调用方拿到计划后由用户确认，再交给真正的写入方。
 */
export async function planLabelColorsWrite(workspaceDir: string, value: unknown): Promise<ConfigPlanResult> {
  const filePath = path.join(workspaceDir, LABEL_COLORS_YAML_REL);
  const read = await readOptional(filePath);
  if ("error" in read) return read.error;
  if (!read.present) return { ok: false, reason: "invalid", detail: `先创建 ${LABEL_COLORS_YAML_REL}（或从老 JSON 迁移）再改颜色；这个后端不会替用户新建配置文件。`, path: filePath };
  const parsed = parseLabelColorsText(read.text);
  if (!parsed.ok) return { ok: false, reason: "parse-failed", detail: parsed.message, path: filePath };
  if (parsed.readonly) return { ok: false, reason: "readonly", detail: "这份标签配色是更新的版本，只能读不能写。", path: filePath };
  const encoded = stringifyLabelColors(value);
  if (!encoded.ok) return { ok: false, reason: "parse-failed", detail: encoded.message, path: filePath };
  return { ok: true, dryRun: true, migrate: false, reason: "write-plan", from: "yaml", path: filePath, text: encoded.text };
}
