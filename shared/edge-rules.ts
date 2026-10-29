/**
 * 父子边 / 阻塞边的落点判定与成环预检（纯规则）。
 *
 * 对应 DSH 的 `deck/rules/edge-landing.ts` 与 `deck/rules/dependency-graph.ts`：
 * 判定只看「写后读回的结构字段里有没有、正文里有没有那一行」，不看后端是谁；
 * 判不出来就说「说不好」，绝不默认升成「原生层级」。
 *
 * 这一份被 MCP 工具与本地写入共用：三处各写一份判定，同一条边会在三个地方给出不同落点。
 */

export const EDGE_LANDING = Object.freeze({
  NATIVE_PARENT: "原生层级",
  NATIVE_BLOCK: "原生依赖边",
  PEER_LINK: "平级链接",
  BODY_LINE: "正文行",
  FILE_NOTE: "票文件注释",
  CONTRACT_PARENT_FIELD: "契约的父子列（分不出是原生层级还是平级链接，别把它当成原生层级）",
  CONTRACT_BLOCK_FIELD: "契约的依赖列（分不出是原生边还是正文行）",
  UNSUPPORTED: "做不到",
  UNKNOWN: "说不好（这次没读回来，别当它已经建好）",
  READ_BACK_MISSING: "读回来了，这条边不在票上（别当它已经建好）",
});

export interface EdgeEvidence {
  kind?: "native" | "peer-link" | "body-line" | "file-note" | "contract" | "missing" | "unsupported" | "unknown" | string;
  ok?: boolean;
  text?: string;
}

export type EdgeVerdict = "landed" | "not-landed" | "unconfirmed";

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

function keysOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "object" && item !== null && "number" in item) return String((item as { number?: unknown }).number ?? "");
      if (typeof item === "object" && item !== null && "key" in item) return String((item as { key?: unknown }).key ?? "");
      return String(item ?? "");
    })
    .filter(Boolean);
}

/** 票上读出来的三格关系：父票、被谁阻塞、反向投影。 */
export interface Relations {
  parentKey: string;
  blockedBy: string[];
  blocking: string[];
}

export function relationsOf(issue: unknown, dependencies?: unknown): Relations {
  const row = asObject(issue);
  const dep = asObject(dependencies);
  const parent = row.parentKey;
  return {
    parentKey: parent === undefined || parent === null || parent === "" ? "" : String(parent),
    blockedBy: keysOf(dep.blockedBy ?? row.blockedBy),
    blocking: keysOf(dep.blocking ?? row.blocking),
  };
}

/**
 * 从一批票里挑出挂在这张地图下的子票（DSH `childrenOf` 的同口径实现）。
 *
 * 清单接口没带任何父子信息时不能假装筛过：原样回全部行，并给一句注记让人去逐张读；
 * 只要有一行带 parentKey，就按 parentKey 精确筛。
 */
export function childrenOf<T extends { parentKey?: string | null }>(
  rows: readonly T[],
  mapKey: unknown,
): { children: T[]; filtered: boolean; note: string } {
  const list = Array.isArray(rows) ? rows : [];
  const anyInfo = list.some((row) => {
    const value = row.parentKey;
    return value !== undefined && value !== null && value !== "";
  });
  if (!anyInfo) {
    return {
      children: [...list],
      filtered: false,
      note: "这个后端的清单接口没带父子信息（它回的是一批票、不是按父票筛过的），下面的子票清单是按原文列的：要精确的子票清单，请逐张用 deck_issue_get 看 parentKey。",
    };
  }
  return {
    children: list.filter((row) => String(row.parentKey) === String(mapKey)),
    filtered: true,
    note: "",
  };
}

/**
 * 判一条边落上了没有。
 *
 * 只有写后读回的结构字段能确认：写动作自己的返回值、正文里出现过票号，都不算
 * （DSH #790 的教训：那两条会把没挂上的边报成挂上）。
 */
export function edgeVerdict(op: string, target: unknown, after: unknown): EdgeVerdict {
  if (after === null || after === undefined) return "unconfirmed";
  const want = asString(target).trim();
  if (!want) return "unconfirmed";
  const row = asObject(after);
  const readHappened =
    (row.issue !== undefined && row.issue !== null) ||
    (row.dependencies !== undefined && row.dependencies !== null) ||
    typeof row.body === "string" ||
    (row.parentKey !== undefined && row.parentKey !== null) ||
    row.blockedBy !== undefined;
  if (!readHappened) return "unconfirmed";
  const issue = row.issue !== undefined && row.issue !== null ? asObject(row.issue) : row;
  const rel = relationsOf(issue, row.dependencies);
  if (op === "block") return rel.blockedBy.includes(want) ? "landed" : "not-landed";
  return rel.parentKey === want ? "landed" : "not-landed";
}

/** 证据档次 → 给人看的落点。 */
export function landingOf(op: string, evidence: unknown): string {
  const kind = asString(asObject(evidence).kind);
  if (kind === "unsupported") return EDGE_LANDING.UNSUPPORTED;
  if (kind === "native") return op === "block" ? EDGE_LANDING.NATIVE_BLOCK : EDGE_LANDING.NATIVE_PARENT;
  if (kind === "peer-link") return EDGE_LANDING.PEER_LINK;
  if (kind === "body-line") return EDGE_LANDING.BODY_LINE;
  if (kind === "file-note") return EDGE_LANDING.FILE_NOTE;
  if (kind === "contract") return op === "block" ? EDGE_LANDING.CONTRACT_BLOCK_FIELD : EDGE_LANDING.CONTRACT_PARENT_FIELD;
  if (kind === "missing") return EDGE_LANDING.READ_BACK_MISSING;
  return EDGE_LANDING.UNKNOWN;
}

/** 正文里有没有带标记地指向这张票（`#12`、`issues/12`）；不认正文里随便一个数字。 */
export function bodyRefersTo(body: unknown, key: unknown): boolean {
  const text = asString(body);
  const want = asString(key).trim();
  if (!text || !want) return false;
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(?:#|issues/|/issues/|票\\s*|第\\s*)" + escaped + "(?![0-9])").test(text);
}

/** 原文布局的 `Blocked by: NN` 行有没有这一条（编号可能带前导零，按数值比）。 */
export function blockedByLineRefersTo(body: unknown, key: unknown): boolean {
  const text = asString(body);
  const raw = asString(key).trim().replace(/^#/, "");
  if (!text || !/^\d+$/.test(raw)) return false;
  const want = String(Number(raw));
  const re = /^[ \t]*(?:\*\*)?Blocked[ \t]+by[ \t]*[:：][ \t]*(?:\*\*)?[ \t]*([^\r\n]*)$/gim;
  let match = re.exec(text);
  while (match !== null) {
    for (const part of String(match[1] ?? "").split(/[,，、]+/)) {
      const number = /^[ \t]*#?(\d+)[ \t]*$/.exec(part);
      if (number && String(Number(number[1])) === want) return true;
    }
    match = re.exec(text);
  }
  return false;
}

/**
 * 写后读回判落点。
 *
 * 阻塞边能细分：结构字段里有、正文里没有该行 → 原生依赖边；正文里也有 → 正文行。
 * 父子边在契约返回里分不出原生层级与平级链接，所以最多报到「契约的父子列」。
 */
export function classifyEdgeLanding(op: string, target: unknown, after: unknown, from?: unknown): EdgeEvidence {
  const row = asObject(after);
  const want = asString(target);
  const owner = from === undefined || from === null ? "" : asString(from);
  const issue = row.issue !== undefined && row.issue !== null ? asObject(row.issue) : row;
  const rel = relationsOf(issue, row.dependencies);
  const readHappened =
    (row.issue !== undefined && row.issue !== null) ||
    (row.dependencies !== undefined && row.dependencies !== null) ||
    typeof row.body === "string";
  if (!readHappened) return { kind: "unknown", ok: true, text: "写后没读回来，判不了这条边的落点" };
  const body = typeof issue.body === "string" ? issue.body : typeof row.body === "string" ? row.body : "";
  const bodyHas = op === "block" ? bodyRefersTo(body, want) || blockedByLineRefersTo(body, want) : bodyRefersTo(body, want);
  const ownerText = owner ? "票 #" + owner : "票";
  if (op === "block") {
    const inField = rel.blockedBy.includes(want);
    if (inField && !bodyHas) {
      return { kind: "native", ok: true, text: `写后读回：${ownerText} 的 blockedBy 里有 #${want}，正文里没有那一行（后端把它放在自己的原生边上）` };
    }
    if (inField && bodyHas) {
      return { kind: "body-line", ok: true, text: `写后读回：${ownerText} 的 blockedBy 里有 #${want}，正文里也写着这一行（关系写在正文里）` };
    }
    return { kind: "missing", ok: false, text: `写后读回：${ownerText} 的 blockedBy 里没有 #${want}（读回来的是 ${rel.blockedBy.join("、") || "空"}）` };
  }
  if (rel.parentKey === want) {
    return { kind: "contract", ok: true, text: `写后读回：${ownerText} 的父票是 #${want}（契约把父子放在 parentKey 这一列，分不出原生层级还是平级链接）` };
  }
  return { kind: "missing", ok: false, text: `写后读回：${ownerText} 的父票读到的是 ${rel.parentKey || "空"}，要的是 #${want}` };
}

/** 依赖图里有没有环：邻接表是「票号 → 它的阻塞方集合」。自环也算环。 */
export function hasCycleInAdj(adj: ReadonlyMap<string, ReadonlySet<string> | readonly string[]>): boolean {
  const state = new Map<string, number>();
  const walk = (node: string): boolean => {
    const mark = state.get(node) ?? 0;
    if (mark === 1) return true;
    if (mark === 2) return false;
    state.set(node, 1);
    const next = adj.get(node);
    if (next) for (const child of next) if (walk(child)) return true;
    state.set(node, 2);
    return false;
  };
  for (const node of adj.keys()) if (walk(node)) return true;
  return false;
}

export interface BlockBatchInput {
  graph: ReadonlyMap<string, readonly string[]>;
  keyOrder: readonly string[];
  blockedBy: ReadonlyMap<string, readonly string[]>;
}

/**
 * 整批成环预检：按写出顺序逐条试放，只把会成环的那一组退回去，继续试后面的。
 *
 * 不能只看单条边：缺的那一段可能就在同批的另一条边里，只有「本批全部意图 + 完整现状」
 * 放在一张图上才算得出来。
 */
export function refuseCyclicBlockBatch(input: BlockBatchInput): Map<string, string> {
  const adj = new Map<string, ReadonlySet<string> | readonly string[]>();
  for (const [key, blockers] of input.graph) adj.set(String(key), blockers);
  const refused = new Map<string, string>();
  for (const key of input.keyOrder) {
    const want = (input.blockedBy.get(key) ?? []).filter((value) => value && String(value) !== String(key));
    if (want.length === 0) continue;
    const before = adj.get(key);
    adj.set(key, want);
    if (hasCycleInAdj(adj)) {
      if (before === undefined) adj.delete(key);
      else adj.set(key, before);
      refused.set(key, `写前整批预检：这一组阻塞边和同一批里其它边合起来会让依赖图成环（要 ${want.join("、")}），所以这条边没写。`);
    }
  }
  return refused;
}

/** 一批明细的总结论：全成 ok、全败 unsupported、部分成 partial。 */
export function statusOfItems(items: readonly { status?: string }[]): "ok" | "partial" | "unsupported" {
  if (items.length === 0) return "ok";
  const failed = items.filter((item) => item.status !== "ok").length;
  if (failed === 0) return "ok";
  return failed === items.length ? "unsupported" : "partial";
}
