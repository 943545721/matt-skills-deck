/**
 * 建票的两层词表（照抄 DSH `src/deck/rules/object-kind.ts`，#1403 定版）。
 *
 * 第一层是位置：map（探索地图，顶层容器）/ map-ticket（地图下的工单）/ spec（规格，顶层容器）/
 * spec-ticket（规格下的实施票）/ bug（普通缺陷票）/ issue（普通票，万能兜底）；
 * 第二层只有地图工单有：label 一枚，四选一 research / prototype / grilling / task。
 * 契约层只有三种类型（issue / map / spec），其余身份靠类型标签与正文文件头的对象标记表达。
 *
 * 纯函数：只做字符串与数组计算，不取会话、不读写文件、不读钟。
 */

export type PositionKind = "map" | "map-ticket" | "spec" | "spec-ticket" | "bug" | "issue";

/** 六个位置值，按「先容器、后票、最后兜底」排。 */
export const POSITION_KINDS: readonly PositionKind[] = Object.freeze([
  "map", "map-ticket", "spec", "spec-ticket", "bug", "issue",
]);

/** 地图工单的 label 只认这四枚。 */
export const MAP_TICKET_LABELS: readonly string[] = Object.freeze([
  "wayfinder:research", "wayfinder:prototype", "wayfinder:grilling", "wayfinder:task",
]);

/** 六枚类型标签：身份由它们表达，调用方不许把它们再塞进 labels（kind=issue 的兜底除外）。 */
export const TYPE_LABELS: readonly string[] = Object.freeze([
  "wayfinder:map", "wayfinder:research", "wayfinder:prototype", "wayfinder:grilling", "wayfinder:task", "bug",
]);

/** 契约层的三种类型。 */
export type ContractType = "issue" | "map" | "spec";

/** 父票规则：none=顶层容器不收父票；map=父必须是探索地图；spec=父必须是规格；optional=可给可不给。 */
export type ParentRule = "none" | "map" | "spec" | "optional";

export interface ObjectKindRule {
  readonly kind: PositionKind;
  readonly contractType: ContractType;
  /** 固定要补的类型标签。 */
  readonly typeLabels: readonly string[];
  /** 固定要补的 triage 标签。 */
  readonly triageLabels: readonly string[];
  /** 正文文件头要写的对象标记值；空串表示这一类不写标记。 */
  readonly marker: "" | "spec" | "ticket";
  readonly parent: ParentRule;
  readonly labelRequired: boolean;
  /** 正文骨架是不是地图五节（只有 map 是 true）。 */
  readonly mapBlocks: boolean;
}

/** 唯一的位置表：六个位置值在这里各占一行，别处不许再写第二份。 */
export const OBJECT_KIND_RULES: Readonly<Record<PositionKind, ObjectKindRule>> = Object.freeze({
  map: Object.freeze({
    kind: "map", contractType: "map", typeLabels: Object.freeze(["wayfinder:map"]), triageLabels: Object.freeze([]),
    marker: "", parent: "none", labelRequired: false, mapBlocks: true,
  }),
  "map-ticket": Object.freeze({
    kind: "map-ticket", contractType: "issue", typeLabels: Object.freeze([]), triageLabels: Object.freeze([]),
    marker: "", parent: "map", labelRequired: true, mapBlocks: false,
  }),
  spec: Object.freeze({
    kind: "spec", contractType: "spec", typeLabels: Object.freeze([]), triageLabels: Object.freeze(["ready-for-agent"]),
    marker: "spec", parent: "none", labelRequired: false, mapBlocks: false,
  }),
  "spec-ticket": Object.freeze({
    kind: "spec-ticket", contractType: "issue", typeLabels: Object.freeze([]), triageLabels: Object.freeze(["ready-for-agent"]),
    marker: "ticket", parent: "spec", labelRequired: false, mapBlocks: false,
  }),
  bug: Object.freeze({
    kind: "bug", contractType: "issue", typeLabels: Object.freeze(["bug"]), triageLabels: Object.freeze(["needs-triage"]),
    marker: "", parent: "optional", labelRequired: false, mapBlocks: false,
  }),
  issue: Object.freeze({
    kind: "issue", contractType: "issue", typeLabels: Object.freeze([]), triageLabels: Object.freeze([]),
    marker: "", parent: "optional", labelRequired: false, mapBlocks: false,
  }),
});

/** 按位置值取那一行；认不出的名字回 null。 */
export function ruleFor(kind: unknown): ObjectKindRule | null {
  const name = String(kind === undefined || kind === null ? "" : kind).trim();
  const rule = OBJECT_KIND_RULES[name as PositionKind];
  return rule || null;
}

/** 这枚标签是不是类型标签（大小写不敏感）。 */
export function isTypeLabel(name: unknown): boolean {
  const normalized = String(name === undefined || name === null ? "" : name).trim().toLowerCase();
  if (!normalized) return false;
  return TYPE_LABELS.some((label) => label.toLowerCase() === normalized);
}

/** 找 labels 里第一枚类型标签（原样返回，找不到回空串）。 */
export function typeLabelIn(labels: unknown): string {
  const list = Array.isArray(labels) ? labels : [];
  for (const entry of list) {
    const name = typeof entry === "string" ? entry : (entry as { name?: unknown } | null)?.name;
    if (isTypeLabel(name)) return String(name).trim();
  }
  return "";
}

/** 把各种形态的标签清单归一成去空后的名字数组（顺序保留，不去重）。 */
export function labelNames(list: unknown): string[] {
  if (Array.isArray(list)) {
    return list
      .map((entry) => (typeof entry === "string" ? entry : (entry as { name?: unknown } | null)?.name ?? ""))
      .map((name) => String(name).trim())
      .filter(Boolean);
  }
  return typeof list === "string" && list.trim() ? [list.trim()] : [];
}

/** 这一类建票时要补的标签（按顺序）。 */
export function labelsToEnsure(kind: unknown, label?: unknown): string[] {
  const rule = ruleFor(kind);
  if (!rule) return [];
  if (rule.kind === "map-ticket") {
    const one = String(label === undefined || label === null ? "" : label).trim();
    return one ? [one] : [];
  }
  return rule.typeLabels.concat(rule.triageLabels);
}

export interface CreateKindResolution {
  ok: boolean;
  kind?: PositionKind;
  contractType?: ContractType;
  marker?: "" | "spec" | "ticket";
  label?: string;
  /** labels 收口后的名字数组（原顺序，未补必备标签）。 */
  labels?: string[];
  parent?: ParentRule;
  problem?: string;
}

const KIND_MENU = "map / map-ticket / spec / spec-ticket / bug / issue";
const LABEL_MENU = MAP_TICKET_LABELS.join(" / ");

/**
 * 建票前的纯校验：把 kind / label / labels / parentKey 收成一份答案，收不成就给一句人话。
 *
 * 拒绝口径（#1403 定版，按这个顺序判，先命中的先说）：
 *   1. 缺 kind 直接拒，不再回落 task；旧值 task / ticket 拒，并写清该改成哪个新值；
 *   2. label 只有地图工单收，且必填四选一；别的 kind 带了 label 一律拒；
 *   3. 除 issue 外，labels 里出现任何类型标签都拒 —— 类型标签由 kind/label 决定；
 *   4. map 与 spec 是顶层容器，不收 parentKey；地图工单与实施票必须给 parentKey；bug / issue 父可选。
 */
export function resolveCreateKind(request: unknown): CreateKindResolution {
  const req = request && typeof request === "object" ? request as Record<string, unknown> : {};
  const rawKind = req.kind === undefined || req.kind === null ? "" : String(req.kind).trim();

  if (!rawKind) {
    return {
      ok: false,
      problem: "建票要说明这是哪一层：kind 必填，六个值 " + KIND_MENU + "。"
        + "迁移：旧的 task 改成 map-ticket 并同时给 label（按意图四选一，例如 wayfinder:task），旧的 ticket 改成 spec-ticket。",
    };
  }
  if (rawKind === "task") {
    return {
      ok: false,
      problem: "旧的 kind=task 不再接受：改 map-ticket 并同时给 label（按意图四选一：" + LABEL_MENU + "），"
        + "或者改 issue —— 它只是普通票、不在地图上时用 issue。",
    };
  }
  if (rawKind === "ticket") {
    return { ok: false, problem: "旧的 kind=ticket 不再接受：改 spec-ticket（规格拆出来的实施票就是它）。" };
  }
  const rule = ruleFor(rawKind);
  if (!rule) {
    return { ok: false, problem: "没有这个位置值「" + rawKind.slice(0, 40) + "」：kind 只认 " + KIND_MENU + "。" };
  }

  const label = req.label === undefined || req.label === null ? "" : String(req.label).trim();
  if (rule.kind !== "map-ticket" && label) {
    return { ok: false, problem: "只有地图工单（kind=map-ticket）才收 label：" + rule.kind + " 的身份已经由 kind 自己说清了，别把类型标签同时塞在 label 里。" };
  }
  if (rule.kind === "map-ticket") {
    if (!label) {
      return { ok: false, problem: "地图工单要说明是哪一种：kind=map-ticket 时必须给 label，四选一：" + LABEL_MENU + "。" };
    }
    if (!MAP_TICKET_LABELS.includes(label)) {
      return { ok: false, problem: "没有这个类型标签「" + label.slice(0, 40) + "」：地图工单的 label 只认 " + LABEL_MENU + "。" };
    }
  }

  const labels = labelNames(req.labels);
  if (rule.kind !== "issue") {
    const offending = typeLabelIn(labels);
    if (offending) {
      return {
        ok: false,
        problem: "labels 里别再放类型标签（其中有「" + offending.slice(0, 40) + "」）：类型标签由 kind/label 决定，"
          + "这里只放 triage 标签（例如 ready-for-agent、needs-triage）。",
      };
    }
  }

  const parentKey = req.parentKey === undefined || req.parentKey === null ? "" : String(req.parentKey).trim();
  if ((rule.kind === "map" || rule.kind === "spec") && parentKey) {
    return { ok: false, problem: rule.kind === "map" ? "探索地图是顶层容器，不收 parentKey。" : "规格是顶层容器，不收 parentKey。" };
  }
  if (rule.kind === "map-ticket" && !parentKey) {
    return { ok: false, problem: "地图工单要挂在探索地图下：kind=map-ticket 时要带 parentKey，填探索地图的票号（本地后端是 00）。" };
  }
  if (rule.kind === "spec-ticket" && !parentKey) {
    return { ok: false, problem: "实施票要挂在规格票下：kind=spec-ticket 时要带 parentKey，填规格票号。" };
  }

  return {
    ok: true,
    kind: rule.kind,
    contractType: rule.contractType,
    marker: rule.marker,
    label,
    labels,
    parent: rule.parent,
  };
}

/**
 * 补必备标签：按位置表缺就补，大小写不敏感地比（GitHub 标签名不分大小写）。
 * 回原顺序的完整清单与这次补上的名字。
 */
export function ensureLabels(labels: unknown, kind: unknown, label?: unknown): { labels: string[]; added: string[] } {
  const have = labelNames(labels);
  const want = labelsToEnsure(kind, label);
  const added: string[] = [];
  const lowered = have.map((name) => name.toLowerCase());
  for (const name of want) {
    if (lowered.indexOf(name.toLowerCase()) < 0) {
      have.push(name);
      lowered.push(name.toLowerCase());
      added.push(name);
    }
  }
  return { labels: have, added };
}
