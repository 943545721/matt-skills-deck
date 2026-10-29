/**
 * 本地 Markdown 布局：`.scratch` 原文布局与旧 `.deck` 布局的纯函数部分。
 *
 * 这一层不碰文件系统：路径怎么拼、目录名怎么生成、编号怎么取、票面怎么读怎么写，
 * 全部只吃字符串、只吐字符串或结构。真正的读写与串行化在 `server/tracker/local.ts`。
 *
 * 为什么要与 DSH 的目录形状对齐（`src/tracker/rooms/markdown/`）：
 * 用户已经用技能集在 `.scratch/` 里写了票，插件不能只认自己的 `.deck/`；
 * 反过来，已有 `.deck/` 的工作区也不能因为移植被搬走。两边都读，写回各自原来的地方。
 *
 * 约定（与 DSH 一致）：
 *   - `.scratch/<feature>/spec.md`：规格容器，一个目录一份；
 *   - `.scratch/<effort>/map.md`：探索地图容器，一个目录一份；
 *   - `.scratch/<effort>/issues/NN-<slug>.md`：票，目录内从 01 编号；
 *   - 一个目录只能放一种容器（spec.md 与 map.md 不能同目录）；
 *   - 旧版工作区根 `issues/` 与 `.scratch/issues/` 只读，不迁移、不删除。
 */

export type LocalLayoutKind = "scratch" | "deck";

/** `root` 是容器目录本身（scratch 是 `.scratch/<feature>`，deck 是工作区的 `.deck`）。 */
export interface LocalLayout {
  root: string;
  kind: LocalLayoutKind;
}

export type LocalIssueKind = "map" | "spec" | "issue" | "map-ticket" | "spec-ticket";
export type LocalRecordKind = "spec" | "map" | "ticket";

export const SCRATCH_DIR = ".scratch";
export const DECK_DIR = ".deck";
export const ISSUES_DIR = "issues";
export const SPEC_FILE = "spec.md";
export const MAP_FILE = "map.md";

/** 与 DSH 的 slugify 同口径：小写、空格变连字符、只留字母数字与连字符、最多 40 字。 */
export const SLUG_MAX_CHARS = 40;
/** 目录名冲突时最多试到 `-50`，与 DSH 的 generatedFeatureDir 一致。 */
export const SLUG_CONFLICT_LIMIT = 50;

const WAYFINDER_TYPE_RE = /^wayfinder:(research|prototype|grilling|task)$/;
const CLOSED_STATUS = new Set(["resolved", "completed", "closed", "done"]);
const FIELD_LIMIT_LINE = /^##[ \t]+\S/;

/* ------------------------------------------------------------------ 路径 */

/** 按根路径已有的分隔符拼接，避免在 Windows 上把 `\` 与 `/` 混着写。 */
export function joinLayoutPath(root: string, ...parts: string[]): string {
  const separator = /\\/.test(root) && !/\//.test(root) ? "\\" : "/";
  let out = String(root).replace(/[\\/]+$/, "");
  for (const part of parts) {
    const clean = String(part).replace(/^[\\/]+|[\\/]+$/g, "");
    if (clean) out = out ? out + separator + clean : clean;
  }
  return out;
}

export function baseNameOf(filePath: string): string {
  const parts = String(filePath).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] ?? "" : "";
}

export function dirNameOf(filePath: string): string {
  const text = String(filePath).replace(/[\\/]+$/, "");
  const at = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return at > 0 ? text.slice(0, at) : "";
}

export function workspaceRootOf(workspaceDir: string, kind: LocalLayoutKind): string {
  return joinLayoutPath(workspaceDir, kind === "scratch" ? SCRATCH_DIR : DECK_DIR);
}

/** 工作区里那份 `.scratch` 或 `.deck` 的布局描述。 */
export function layoutOf(workspaceDir: string, kind: LocalLayoutKind): LocalLayout {
  return { root: workspaceRootOf(workspaceDir, kind), kind };
}

/* ------------------------------------------------------------------ slug */

export function slugify(title: string): string {
  const base = String(title ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_CHARS)
    .replace(/^-+|-+$/g, "");
  return base || "untitled";
}

/* ------------------------------------------------------------------ 编号 */

/** 目录内编号；文件名没有编号时是 0；slug 是编号之后那段（无编号时是去掉 .md 的文件名）。 */
export interface TicketFileEntry { fileName: string; number: number; slug: string }

function isNonTicketFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === MAP_FILE || lower === SPEC_FILE || lower === "notes.md";
}

/** 票目录里的 `.md` 文件（排除 map/spec/notes 与隐藏文件）。 */
export function ticketFileNamesOf(names: readonly string[]): string[] {
  return names.filter((name) => {
    if (!name || name.startsWith(".")) return false;
    if (!name.toLowerCase().endsWith(".md")) return false;
    return !isNonTicketFile(name);
  });
}

/** 从文件名取编号：`01-买咖啡.md` → 1，`7.md`（旧 .deck）→ 7，无编号 → 0。 */
export function numberOfFile(fileName: string): number {
  const match = /^(\d+)(?:-|\.md$)/i.exec(fileName);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function ticketEntriesOf(names: readonly string[]): TicketFileEntry[] {
  return ticketFileNamesOf(names)
    .map((fileName) => {
      const number = numberOfFile(fileName);
      const stem = fileName.replace(/\.md$/i, "");
      const slug = number > 0 ? stem.replace(/^\d+-?/, "") || "untitled" : stem;
      return { fileName, number, slug };
    })
    .sort((a, b) => (a.number || Number.MAX_SAFE_INTEGER) - (b.number || Number.MAX_SAFE_INTEGER) || a.fileName.localeCompare(b.fileName));
}

/** 下一个编号：目录内已占用编号的最大值 + 1。 */
export function nextTicketNumber(names: readonly string[]): number {
  let max = 0;
  for (const name of names) max = Math.max(max, numberOfFile(name));
  return max + 1;
}

export function formatTicketNumber(number: number): string {
  return String(Math.max(1, Math.trunc(number))).padStart(2, "0");
}

/* ------------------------------------------------------------------ 路径计划 */

export interface PlanIssuePathInput {
  layout: LocalLayout; kind: LocalIssueKind; title: string; number?: number; existing: string[];
}

/**
 * 一张票该落在哪里。容器的编号固定是 0（DSH 的 `00`），票从 1 起。
 *
 * `existing` 是同一个容器里的已有条目：容器类传目录里的文件名，票类传 `issues/` 里的文件名。
 * 路径与编号都不读盘，调用方负责在写锁里重新列目录再取号（见 local.ts）。
 */
export function planIssuePath(input: PlanIssuePathInput): { path: string; number: number } {
  const { layout, kind, title, existing } = input;
  if (kind === "spec") return { path: joinLayoutPath(layout.root, SPEC_FILE), number: 0 };
  if (kind === "map") return { path: joinLayoutPath(layout.root, MAP_FILE), number: 0 };
  const number = input.number ?? nextTicketNumber(existing);
  if (layout.kind === "deck") {
    return { path: joinLayoutPath(layout.root, ISSUES_DIR, `${number}.md`), number };
  }
  const fileName = `${formatTicketNumber(number)}-${slugify(title)}.md`;
  return { path: joinLayoutPath(layout.root, ISSUES_DIR, fileName), number };
}

/* ------------------------------------------------------------------ 容器目录 */

export interface ContainerDirState {
  /** `.scratch` 下的目录名（根级扁平布局用空串）与目录里已有的条目名（只看一层）。 */
  name: string; entries: readonly string[];
}

export type ContainerPlan =
  | { ok: true; name: string; path: string }
  | { ok: false; reason: "conflict"; detail: string; suggestedName?: string };

function counterpartOf(kind: "spec" | "map" | "issue"): string | null {
  if (kind === "spec") return MAP_FILE;
  if (kind === "map") return SPEC_FILE;
  return null;
}

function occupiedBy(entries: readonly string[]): boolean {
  return entries.includes(SPEC_FILE) || entries.includes(MAP_FILE) || entries.includes(ISSUES_DIR);
}

/**
 * 选一个容器目录。
 *
 * 点名了 `preferredName` 就只用它：里面有对方的容器（spec.md / map.md）时如实拒绝，
 * 并给出一个能直接用的建议名（`<name>-2`），不擅自换地方。
 * 没点名时才按标题生成，占用就试 `-2`…`-50`；票目录可以和容器同住，所以 `kind: "issue"` 不看对方容器。
 */
export function planContainerDir(input: { scratchRoot: string; kind: "spec" | "map" | "issue"; title: string; existing: readonly ContainerDirState[]; preferredName?: string }): ContainerPlan {
  const preferred = String(input.preferredName ?? "").trim();
  if (preferred) {
    const state = input.existing.find((item) => item.name === preferred);
    const other = counterpartOf(input.kind);
    if (state && other && state.entries.includes(other)) {
      return {
        ok: false,
        reason: "conflict",
        detail: `目录「${preferred}」里已经有一份 ${other}：一个目录只能放一种容器，换一个名字（例如「${preferred}-2」）。`,
        suggestedName: `${preferred}-2`,
      };
    }
    return { ok: true, name: preferred, path: joinLayoutPath(input.scratchRoot, preferred) };
  }
  const base = slugify(input.title);
  const other = counterpartOf(input.kind);
  for (let n = 1; n <= SLUG_CONFLICT_LIMIT; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    const state = input.existing.find((item) => item.name === name);
    if (!state) return { ok: true, name, path: joinLayoutPath(input.scratchRoot, name) };
    if (other && state.entries.includes(other)) continue;
    if (!occupiedBy(state.entries)) return { ok: true, name, path: joinLayoutPath(input.scratchRoot, name) };
  }
  return {
    ok: false,
    reason: "conflict",
    detail: `标题「${input.title}」生成的前 ${SLUG_CONFLICT_LIMIT} 个目录名都已经被别的票占用，这次没建：请指定一个目录名。`,
  };
}

/** 目录里出现对方容器时的冲突说明；没有冲突回 null。 */
export function containerConflictOf(kind: "spec" | "map", entries: readonly string[]): string | null {
  const other = counterpartOf(kind);
  if (!other || !entries.includes(other)) return null;
  return `目录里已经有一份 ${other}：一个目录只能放一种容器。`;
}

/* ------------------------------------------------------------------ 幂等锚 */

const IDEMPOTENCY_MARKER = "<!-- DSH-IDEMPOTENCY-KEY:";

/** 从一份票文件里读回幂等锚；只认独占一行、以注释收尾的那一行（与 DSH 同口径）。 */
export function idempotencyKeyOf(text: string): string {
  const body = String(text ?? "");
  if (!body || !body.includes(IDEMPOTENCY_MARKER)) return "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(IDEMPOTENCY_MARKER) || !line.endsWith("-->")) continue;
    const key = line.slice(IDEMPOTENCY_MARKER.length, line.length - 3).trim();
    if (key) return key;
  }
  return "";
}

export interface IdempotentCandidate { path: string; text: string }

/** 在候选文件里按幂等键回查；命中返回盘上那一份（不新建第二张）。 */
export function findIdempotentHit(input: { kind: LocalIssueKind; files: readonly IdempotentCandidate[]; idempotencyKey: string }): { path: string; number: number } | null {
  const key = String(input.idempotencyKey ?? "").trim();
  if (!key) return null;
  const wantsContainer = input.kind === "spec" || input.kind === "map";
  for (const file of input.files) {
    const base = baseNameOf(file.path).toLowerCase();
    const isSpec = base === SPEC_FILE;
    const isMap = base === MAP_FILE;
    if (wantsContainer && input.kind === "spec" && !isSpec) continue;
    if (wantsContainer && input.kind === "map" && !isMap) continue;
    if (!wantsContainer && (isSpec || isMap)) continue;
    if (idempotencyKeyOf(file.text) !== key) continue;
    return { path: file.path, number: isSpec || isMap ? 0 : numberOfFile(baseNameOf(file.path)) };
  }
  return null;
}

/* ------------------------------------------------------------------ 票面读取 */

export interface ScratchRecord {
  number: number; title: string; state: "OPEN" | "CLOSED";
  labels: string[]; assignees: string[]; blockedBy: number[];
  createdAt: string; updatedAt: string; body: string; kind: LocalRecordKind;
  /** 可见状态行的原值（没有可见行时是空串）。 */
  statusText: string; parentKey: string; idempotencyKey: string;
}

const HIDDEN_LINE_RE = /^[ \t]*<!--[ \t]*(DSH-[A-Z0-9-]+)[ \t]*:[ \t]*(.*?)[ \t]*-->[ \t]*$/i;
const FENCE_RE = /^[ \t]*(?:`{3,}|~{3,})/;

function stripFencedCode(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of String(text ?? "").split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}

function firstHeadingLine(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#[ \t]+\S/.test(line) || /^##[ \t]+\S/.test(line)) return index;
  }
  return lines.length;
}

function hiddenFields(text: string): Map<string, string> {
  const lines = String(text ?? "").split("\n");
  const end = firstHeadingLine(lines);
  const fields = new Map<string, string>();
  for (let index = 0; index < end; index += 1) {
    const match = HIDDEN_LINE_RE.exec(lines[index] ?? "");
    if (match && match[1]) fields.set(match[1].toUpperCase(), (match[2] ?? "").trim());
  }
  return fields;
}

function stripDecoration(name: string): string {
  let text = String(name ?? "").trim();
  for (;;) {
    if (text.length < 2) break;
    const head = text[0];
    if (head !== text[text.length - 1]) break;
    if (head !== "`" && head !== "'" && head !== '"') break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

function splitList(raw: string): string[] {
  return String(raw ?? "")
    .split(/[,，]+/)
    .map((item) => stripDecoration(item))
    .filter(Boolean);
}

function splitNumbers(raw: string): number[] {
  const out: number[] = [];
  for (const part of String(raw ?? "").split(/[,，\s]+/)) {
    const match = /#?(\d+)/.exec(part);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0 && !out.includes(value)) out.push(value);
  }
  return out;
}

/** 字段区：第一个二级标题之前。字段行只在这里找，正文里的同名文字是内容。 */
function fieldArea(text: string): string {
  const field = stripFencedCode(text);
  const match = /^##[ \t]+\S/m.exec(field);
  return match ? field.slice(0, match.index) : field;
}

function visibleField(field: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bold = new RegExp("^[ \\t]*\\*\\*" + escaped + ":\\*\\*[ \\t]*(.*)$", "im").exec(field);
  if (bold) return String(bold[1] ?? "").trim();
  const plain = new RegExp("^[ \\t]*" + escaped + "[ \\t]*[:：][ \\t]*(.*)$", "im").exec(field);
  return plain ? String(plain[1] ?? "").trim() : "";
}

function visibleStatus(field: string): string {
  const match = /^[ \t]*(?:\*\*)?Status(?:\*\*)?[ \t]*[:：][ \t]*(?:\*\*)?[ \t]*([^\n]+)/im.exec(field);
  return match ? String(match[1] ?? "").trim().replace(/\*\*[ \t]*$/, "").trim() : "";
}

function titleFromText(text: string): string {
  const match = /^#[ \t]+(.+)$/m.exec(String(text ?? ""));
  return match ? String(match[1] ?? "").trim().replace(/^\d{1,3}:[ \t]*/, "") : "";
}

function bodyWithoutHeader(text: string): string {
  const lines = String(text ?? "").split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start] ?? "";
    if (line.trim() === "" || HIDDEN_LINE_RE.test(line)) {
      start += 1;
      continue;
    }
    break;
  }
  return lines.slice(start).join("\n").replace(/\s+$/, "");
}

/**
 * 读一份 `.scratch` 票面。
 *
 * 读取顺序与 DSH 的 parseMd 一致：可见行优先、文件头隐藏注释兜底；没有的字段按空处理，
 * 不因为缺一行就判整份文件坏掉（原文允许手写、允许字段缺失）。
 */
export function parseScratchRecord(input: {
  text: string;
  number: number;
  kind: LocalRecordKind;
  fileName?: string;
  fallbackUpdatedAt?: string;
}): ScratchRecord {
  const text = String(input.text ?? "");
  const field = fieldArea(text);
  const hidden = hiddenFields(text);
  const title = titleFromText(text) || hidden.get("DSH-TITLE") || (input.fileName ?? "").replace(/\.md$/i, "").replace(/^\d+-/, "") || "untitled";
  const statusText = visibleStatus(field) || hidden.get("DSH-STATUS") || "";
  const statusNorm = statusText.toLowerCase().replace(/\s+/g, "-");
  const state = CLOSED_STATUS.has(statusNorm) ? "CLOSED" : "OPEN";
  const visibleLabels = /^[ \t]*(?:\*\*)?Labels?(?:\*\*)?[ \t]*[:：][ \t]*(?:\*\*)?[ \t]*([^\n]*)/im.exec(field);
  const labels = visibleLabels ? splitList(visibleLabels[1] ?? "") : splitList(hidden.get("DSH-LABELS") ?? "");
  const visibleAssignees = /^[ \t]*Assignees[ \t]*[:：][ \t]*(.*)$/im.exec(field);
  const assignees = visibleAssignees ? splitList(visibleAssignees[1] ?? "") : splitList(hidden.get("DSH-ASSIGNEES") ?? "");
  const visibleBlocked = /^[ \t]*(?:\*\*)?Blocked\s+by(?:\*\*)?[ \t]*[:：][ \t]*(?:\*\*)?[ \t]*(.+)$/im.exec(field);
  const blockedBy = visibleBlocked ? splitNumbers(visibleBlocked[1] ?? "") : splitNumbers(hidden.get("DSH-BLOCKED-BY") ?? "");
  const createdAt = hidden.get("DSH-CREATED") ?? "";
  const updatedAt = input.fallbackUpdatedAt ?? createdAt ?? "";
  return {
    number: input.number,
    title,
    state,
    labels,
    assignees,
    blockedBy,
    createdAt,
    updatedAt,
    body: bodyWithoutHeader(text),
    kind: input.kind,
    statusText,
    parentKey: hidden.get("DSH-PARENT") ?? "",
    idempotencyKey: idempotencyKeyOf(text),
  };
}

/* ------------------------------------------------------------------ 票面写入 */

function sanitizeHidden(value: string): string {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/-->/g, "-- >").trim();
}

export interface ScratchRenderInput {
  kind: LocalRecordKind;
  number: number;
  title: string;
  body: string;
  status?: string;
  labels?: readonly string[];
  assignees?: readonly string[];
  blockedBy?: readonly number[];
  parentKey?: string;
  idempotencyKey?: string;
  createdAt: string;
  /** 地图子票用 `# NN: 问题` + `Type:/Status:/Blocked by:` 的原文形状。 */
  mapTicket?: boolean;
}

function renderHeader(input: ScratchRenderInput): string {
  const lines = ["<!-- DSH-FORMAT: md-v1 -->"];
  if (input.idempotencyKey) lines.push(`<!-- DSH-IDEMPOTENCY-KEY: ${sanitizeHidden(input.idempotencyKey)} -->`);
  lines.push(`<!-- DSH-CREATED: ${sanitizeHidden(input.createdAt)} -->`);
  if (input.kind === "spec" || input.kind === "map") {
    lines.push(`<!-- DSH-TITLE: ${sanitizeHidden(input.title)} -->`);
    lines.push(`<!-- DSH-STATUS: ${sanitizeHidden(input.status || "ready-for-agent")} -->`);
  } else {
    if (input.parentKey) lines.push(`<!-- DSH-PARENT: ${sanitizeHidden(input.parentKey)} -->`);
    const blocked = (input.blockedBy ?? []).map((value) => formatTicketNumber(value));
    if (blocked.length) lines.push(`<!-- DSH-BLOCKED-BY: ${blocked.join(", ")} -->`);
  }
  if (input.assignees && input.assignees.length) lines.push(`<!-- DSH-ASSIGNEES: ${sanitizeHidden(input.assignees.join(", "))} -->`);
  if (input.labels && input.labels.length) lines.push(`<!-- DSH-LABELS: ${sanitizeHidden(input.labels.join(", "))} -->`);
  return lines.join("\n") + "\n";
}

function ensureSection(body: string, heading: string): string {
  const text = String(body ?? "").trim();
  if (/^##[ \t]+\S/m.test(text)) return text;
  return "## " + heading + (text ? "\n\n" + text : "") + "\n";
}

function cleanTitle(title: string): string {
  return String(title ?? "").trim().replace(/^\d{1,3}:\s*/, "");
}

function firstParagraph(body: string): string {
  const text = String(body ?? "").trim();
  const at = /^##[ \t]+\S/m.exec(text);
  return (at ? text.slice(0, at.index) : text).trim();
}

function wayfinderTypeOf(labels: readonly string[]): string {
  for (const label of labels) {
    const match = WAYFINDER_TYPE_RE.exec(label.trim());
    if (match && match[1]) return match[1];
  }
  return "";
}

/** 把一份新票渲染成 `.scratch` 原文形状（容器没有可见一级标题，票有 `# NN: 标题`）。 */
export function renderScratchRecord(input: ScratchRenderInput): string {
  const header = renderHeader(input);
  const title = cleanTitle(input.title) || "untitled";
  if (input.kind === "spec") return header + "\n" + ensureSection(input.body, "Problem Statement") + "\n";
  if (input.kind === "map") return header + "\n" + ensureSection(input.body, "Destination") + "\n";

  const number = formatTicketNumber(input.number);
  const labels = input.labels ?? [];
  const status = input.status || "ready-for-agent";
  if (input.mapTicket) {
    const type = wayfinderTypeOf(labels);
    const lines = [`# ${number}: ${title}`];
    if (type) lines.push("", `Type: ${type}`);
    lines.push("", `Status: ${status === "ready-for-agent" ? "claimed" : status}`);
    const blocked = (input.blockedBy ?? []).map((value) => formatTicketNumber(value));
    lines.push("", `Blocked by: ${blocked.length ? blocked.join(", ") : "None"}`);
    const text = String(input.body ?? "").trim();
    lines.push("", "## Question", "", text || "（待补充问题）");
    return header + lines.join("\n") + "\n";
  }

  const rawBody = String(input.body ?? "").trim();
  const explicitWhat = visibleField(rawBody, "What to build");
  const what = explicitWhat || firstParagraph(rawBody);
  const at = /^##[ \t]+\S/m.exec(rawBody);
  const rest = explicitWhat ? rawBody : at ? rawBody.slice(at.index).trim() : "";
  const blocked = (input.blockedBy ?? []).map((value) => formatTicketNumber(value));
  const lines = [`# ${number}: ${title}`, "", `**What to build:** ${what}`, "", `**Blocked by:** ${blocked.length ? blocked.join(", ") : "None (can start immediately)"}`, "", `**Status:** ${status}`];
  if (rest) lines.push("", rest);
  return header + lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------ 段修改 */

function firstH2Index(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    if (FIELD_LIMIT_LINE.test(lines[index] ?? "")) return index;
  }
  return lines.length;
}

function headerEndIndex(lines: readonly string[]): number {
  return firstHeadingLine(lines);
}

function upsertHidden(text: string, name: string, value: string | null): string {
  const lines = String(text ?? "").split("\n");
  const pattern = new RegExp("^[ \\t]*<!--[ \\t]*" + name + "[ \\t]*:.*?-->[ \\t]*$", "i");
  const at = lines.findIndex((line) => pattern.test(line));
  const line = value === null ? "" : `<!-- ${name}: ${sanitizeHidden(value)} -->`;
  if (at >= 0) {
    if (line) lines[at] = line;
    else lines.splice(at, 1);
    return lines.join("\n");
  }
  if (!line) return text;
  const end = headerEndIndex(lines);
  lines.splice(end, 0, line);
  return lines.join("\n");
}

/** 父子边：原文布局写文件头 `DSH-PARENT`；`null` 表示解除。 */
export function setScratchParent(text: string, parentKey: string | null): string {
  return upsertHidden(text, "DSH-PARENT", parentKey === null || parentKey === "" ? null : String(parentKey));
}

/**
 * 阻塞边：隐藏注释 `DSH-BLOCKED-BY` 与可见行成对更新。
 *
 * 解析以可见行为准，所以只改隐藏注释会让读回停在旧值；两处必须一起改。
 */
export function setScratchBlockedBy(text: string, blockers: readonly number[]): string {
  const values = blockers.map((value) => formatTicketNumber(value));
  const hidden = upsertHidden(text, "DSH-BLOCKED-BY", values.length ? values.join(", ") : null);
  const lines = String(hidden ?? "").split("\n");
  const limit = firstH2Index(lines);
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] ?? "";
    const bold = /^([ \t]*)\*\*Blocked by:\*\*[ \t]*(.*)$/i.exec(line);
    if (bold) {
      lines[index] = `${bold[1] ?? ""}**Blocked by:** ${values.length ? values.map((value) => "#" + value).join(", ") : "None (can start immediately)"}`;
      return lines.join("\n");
    }
    const bare = /^([ \t]*)Blocked by:[ \t]*(.*)$/i.exec(line);
    if (bare) {
      lines[index] = `${bare[1] ?? ""}Blocked by: ${values.length ? values.join(", ") : "None"}`;
      return lines.join("\n");
    }
  }
  return lines.join("\n");
}

/** 关闭 / 打开：改可见 `Status:` 行；容器或手写文件没有这行时改 `DSH-STATUS`。 */
export function setScratchStatus(text: string, closed: boolean): string {
  const value = closed ? "resolved" : "ready-for-agent";
  const lines = String(text ?? "").split("\n");
  const limit = firstH2Index(lines);
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([ \t]*)(?:\*\*)?Status(?:\*\*)?([ \t]*[:：][ \t]*)(?:\*\*)?[ \t]*([^\n]*)$/i.exec(line);
    if (!match) continue;
    const bold = /^\s*\*\*/.test(line);
    lines[index] = (match[1] ?? "") + (bold ? "**Status:** " : "Status: ") + value;
    return lines.join("\n");
  }
  return upsertHidden(text, "DSH-STATUS", value);
}

/** 整体替换标签：可见 `Labels:` 行优先，否则写 `DSH-LABELS` 隐藏注释（空名单也落一行，表示明确为空）。 */
export function setScratchLabels(text: string, labels: readonly string[]): string {
  const value = labels.join(", ");
  const lines = String(text ?? "").split("\n");
  const limit = firstH2Index(lines);
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([ \t]*)(?:\*\*)?Labels?(?:\*\*)?([ \t]*[:：][ \t]*)(?:\*\*)?[ \t]*(.*)$/i.exec(line);
    if (!match) continue;
    const bold = /^\s*\*\*/.test(line);
    lines[index] = (match[1] ?? "") + (bold ? "**Labels:** " : "Labels: ") + value;
    return lines.join("\n");
  }
  return upsertHidden(text, "DSH-LABELS", value);
}

export function setScratchTitle(text: string, title: string): string {
  const clean = cleanTitle(title);
  const lines = String(text ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#[ \t]+)(\d{1,3}:[ \t]*)?(.*)$/.exec(lines[index] ?? "");
    if (!match) continue;
    lines[index] = (match[1] ?? "# ") + (match[2] ?? "") + clean;
    return lines.join("\n");
  }
  return upsertHidden(text, "DSH-TITLE", clean);
}

function commentsSectionOf(text: string): string {
  const match = /^##[ \t]+Comments[ \t]*$/m.exec(String(text ?? ""));
  if (!match) return "";
  const rest = text.slice(match.index + match[0].length);
  const next = /^##[ \t]+\S/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).replace(/\s+$/, "");
}

const METADATA_FIELD_RE = /^[ \t]*(?:\*\*)?(Status|Blocked by|Labels|Assignees)(?:\*\*)?[ \t]*[:：]/i;

function preservedMetadataLines(visible: string, nextBody: string): string[] {
  const lines = visible.split("\n");
  const fieldLines = lines.slice(0, firstH2Index(lines)).filter((line) => METADATA_FIELD_RE.test(line));
  return fieldLines.filter((line) => {
    const label = METADATA_FIELD_RE.exec(line)?.[1] ?? "";
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp("^[ \\t]*(?:\\*\\*)?" + escaped + "(?:\\*\\*)?[ \\t]*[:：]", "im").test(nextBody);
  });
}

/**
 * 整份替换可见正文，保留文件头隐藏注释、一级标题、状态类字段与 `## Comments`。
 *
 * 这是 DSH patch-body 的保守子集：丢掉隐藏字段、别人的评论或票的状态都是不可接受的。
 * 新正文里没有写状态/阻塞/标签/指派时，旧字段原样接回去；旧评论也接回去。
 */
export function replaceScratchBody(text: string, body: string, kind: LocalRecordKind): string {
  const old = String(text ?? "");
  const lines = old.split("\n");
  const end = headerEndIndex(lines);
  const header = lines.slice(0, end).join("\n");
  const visible = lines.slice(end).join("\n");
  const comments = commentsSectionOf(old);
  const nextBody = String(body ?? "").trim();
  const withComments = comments && !/^##[ \t]+Comments[ \t]*$/m.test(nextBody) ? `${nextBody}\n\n## Comments${comments}\n` : nextBody;
  if (kind === "spec" || kind === "map") {
    const heading = kind === "spec" ? "Problem Statement" : "Destination";
    return header + "\n\n" + ensureSection(withComments, heading) + "\n";
  }
  const titleLine = /^#[ \t]+.*$/m.exec(visible)?.[0] ?? "# 01: untitled";
  const metadata = preservedMetadataLines(visible, withComments);
  const fields = metadata.length ? metadata.join("\n") + "\n\n" : "";
  return header + "\n" + titleLine + "\n\n" + fields + withComments + "\n";
}

/* ------------------------------------------------------------------ 评论 */

export interface ScratchComment {
  author: string;
  createdAt: string;
  body: string;
}

/** 读 `## Comments` 段里的评论（DSH 的 `### 作者 — ISO` 块）。 */
export function parseScratchComments(text: string): ScratchComment[] {
  const section = commentsSectionOf(text);
  if (!section) return [];
  const out: ScratchComment[] = [];
  for (const block of section.split(/^###[ \t]+/m).map((item) => item.trim()).filter(Boolean)) {
    const lines = block.split("\n");
    const header = (lines[0] ?? "").trim();
    const separator = header.includes("—") ? header.indexOf("—") : header.indexOf("-");
    const author = separator >= 0 ? header.slice(0, separator).trim() || "local" : (header.split(/\s+/)[0] || "local");
    const stamp = /\d{4}-\d{2}-\d{2}T[^ \n]+/.exec(header)?.[0] ?? "";
    const body = lines.slice(1).join("\n").trim();
    if (!body && !header) continue;
    out.push({ author, createdAt: stamp, body });
  }
  return out;
}

export function appendScratchComment(text: string, comment: ScratchComment): string {
  const block = `### ${comment.author} — ${comment.createdAt}\n${comment.body.trim()}\n`;
  const source = String(text ?? "").replace(/\s+$/, "");
  const match = /^##[ \t]+Comments[ \t]*$/m.exec(source);
  if (!match) return source + "\n\n## Comments\n\n" + block;
  const start = match.index + match[0].length;
  const rest = source.slice(start);
  const next = /^##[ \t]+\S/m.exec(rest);
  if (!next) return source + "\n\n" + block;
  const at = start + next.index;
  return source.slice(0, at).replace(/\s+$/, "") + "\n\n" + block + "\n" + source.slice(at);
}

/* ------------------------------------------------------------------ .deck 票面 */

/** `.deck/issues/<n>.md` 的 frontmatter 记录；与 `.scratch` 记录共用上层结构。 */
export interface DeckRecord {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  assignees: string[];
  blockedBy: number[];
  /** 父子边：`null` 表示明确没有父票；缺省表示这份记录没写过这个字段。 */
  parentKey?: string | null;
  createdAt: string;
  updatedAt: string;
  body: string;
  isMap?: boolean;
}

export function dedupeLabelNames(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const name = String(raw ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function parseDeckList(raw: string | undefined): string[] {
  if (!raw) return [];
  const text = raw.trim();
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseDeckNumbers(raw: string | undefined): number[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => Number(item)).filter((value) => Number.isInteger(value) && value > 0);
    } catch {
      return [];
    }
  }
  return text.split(",").map((item) => Number(item.trim())).filter((value) => Number.isInteger(value) && value > 0);
}

/** 解析一张 `.deck` 票；缺 frontmatter 就当不是票（严格，避免把笔记读成票）。 */
export function parseDeckIssue(text: string, fallbackNumber: number): DeckRecord | null {
  const normalized = String(text ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return null;
  const body = normalized.slice(end + 4).replace(/^\n/, "");
  const fields = new Map<string, string>();
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (match) fields.set(match[1] ?? "", match[2] ?? "");
  }
  const number = Number(fields.get("number"));
  const finalNumber = Number.isInteger(number) && number > 0 ? number : fallbackNumber;
  if (!Number.isInteger(finalNumber) || finalNumber <= 0) return null;
  const zero = new Date(0).toISOString();
  return {
    number: finalNumber,
    title: fields.get("title") || `#${finalNumber}`,
    state: fields.get("state") === "CLOSED" ? "CLOSED" : "OPEN",
    labels: dedupeLabelNames(parseDeckList(fields.get("labels"))),
    assignees: parseDeckList(fields.get("assignees")),
    blockedBy: parseDeckNumbers(fields.get("blockedBy")),
    ...(fields.has("parentKey")
      ? { parentKey: fields.get("parentKey") === "" || fields.get("parentKey") === "null" ? null : fields.get("parentKey") }
      : {}),
    createdAt: fields.get("createdAt") || zero,
    updatedAt: fields.get("updatedAt") || zero,
    body,
  };
}

export function renderDeckIssue(record: DeckRecord): string {
  const front = [
    `number: ${record.number}`,
    `title: ${record.title.replace(/\n/g, " ")}`,
    `state: ${record.state}`,
    `labels: ${JSON.stringify(record.labels)}`,
    `assignees: ${JSON.stringify(record.assignees)}`,
    `blockedBy: ${JSON.stringify(record.blockedBy)}`,
    ...(record.parentKey !== undefined ? [`parentKey: ${record.parentKey ?? "null"}`] : []),
    `createdAt: ${record.createdAt}`,
    `updatedAt: ${record.updatedAt}`,
  ].join("\n");
  return `---\n${front}\n---\n${record.body}`;
}

/** 解析 `.deck/issues/<n>.comments.json`；坏文件按空评论处理，不影响票本身。 */
export function parseDeckComments(raw: string): ScratchComment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const record = item as { author?: unknown; createdAt?: unknown; body?: unknown } | null;
    const body = typeof record?.body === "string" ? record.body : "";
    if (!body) return [];
    return [{ author: typeof record?.author === "string" ? record.author : "local", createdAt: typeof record?.createdAt === "string" ? record.createdAt : "", body }];
  });
}
