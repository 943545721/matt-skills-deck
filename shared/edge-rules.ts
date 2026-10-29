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

/* ------------------------------------------------------------------ 跨仓库依赖 */

/**
 * 跨仓库依赖在正文里的隐藏区段。
 *
 * 为什么是这个形状：票面已有的隐藏标记（`DSH-ISSUE-KIND`、`DSH-IDEMPOTENCY-KEY`）都是
 * HTML 注释，所以这里沿用同一套，只换名字，不另造语法。整段是注释，渲染出来看不见；
 * 里面的 `Blocked by:` 行保持人写得出来的固定写法，抄进别的工具也能认。
 *
 *   <!-- DSH-CROSS-REPO-BLOCKED-BY
 *   Blocked by: owner/repo#12, key#34
 *   -->
 *
 * 多个引用**一行**写完（逗号分隔）：一行才有一行可幂等替换，多行就要处理「删哪几行」。
 */
export const CROSS_REPO_BLOCKED_BY = "DSH-CROSS-REPO-BLOCKED-BY";

const CROSS_REPO_BLOCK_RE = new RegExp(
  "^[ \\t]*<!--[ \\t]*" + CROSS_REPO_BLOCKED_BY + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*-->[ \\t]*$",
  "m",
);

const BLOCKED_BY_TEXT_RE = /^[ \t]*(?:\*\*)?Blocked[ \t]+by[ \t]*[:：][ \t]*(?:\*\*)?[ \t]*(.*)$/m;

/** 一条引用在正文里的写法：`owner/repo#12`。渲染与解析共用这一个函数。 */
export const crossRepoRefText = (repo: string, number: number): string => `${repo}#${number}`;

function uniqueValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** 把一行 `Blocked by:` 的内容拆成条目；中文逗号与顿号也认（人写的行不挑标点）。 */
function splitRefs(text: string): string[] {
  return uniqueValues(String(text ?? "").split(/[,，、]+/));
}

/** 固定行本身；没有引用时回空串（表示这一行不该存在）。 */
export function crossRepoBlockedByLine(refs: readonly string[]): string {
  const unique = uniqueValues(refs);
  return unique.length ? `Blocked by: ${unique.join(", ")}` : "";
}

/** 整段隐藏区段；没有引用时回空串。 */
export function renderCrossRepoBlock(refs: readonly string[]): string {
  const line = crossRepoBlockedByLine(refs);
  return line ? `<!-- ${CROSS_REPO_BLOCKED_BY}\n${line}\n-->` : "";
}

/** 读隐藏区段里的条目（原样，不归一仓库）。区段不存在或没有固定行时回空数组。 */
export function parseCrossRepoBlockRefs(body: unknown): string[] {
  const text = typeof body === "string" ? body : "";
  const block = CROSS_REPO_BLOCK_RE.exec(text);
  if (!block) return [];
  const line = BLOCKED_BY_TEXT_RE.exec(block[1] ?? "");
  if (!line) return [];
  return splitRefs(line[1] ?? "");
}

/**
 * 把正文拆成「给人看的部分」与「隐藏区段」。
 *
 * 写路径要用它保住区段：重写可见的 `Blocked by:` 行时如果把整份正文换掉，
 * 隐藏区段会连同跨仓库引用一起被抹掉。
 */
export function splitCrossRepoBlock(body: unknown): { visible: string; block: string } {
  const text = typeof body === "string" ? body : "";
  const match = CROSS_REPO_BLOCK_RE.exec(text);
  if (!match) return { visible: text, block: "" };
  const visible = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.replace(/\s+$/, "");
  return { visible, block: match[0].trim() };
}

/**
 * 把隐藏区段从正文里摘掉。
 *
 * GitLab 的原生阻塞边回退就是读正文里第一条 `Blocked by:` 行；不摘掉我们的区段，
 * 它会把自己那行跨仓库引用当成原生边，而且永远读成 OPEN——关掉对方也解除不了。
 */
export function stripCrossRepoBlock(body: unknown): string {
  return splitCrossRepoBlock(body).visible;
}

/**
 * 幂等写入隐藏区段：已有整段替换（不叠加第二行），引用清空时整段删掉。
 *
 * 放在正文末尾而不是文件头：正文头部已经是幂等锚、票面类型标记的地盘，
 * 再挤进去会让「第一行是什么」这条判据变得难读；末尾对渲染没有影响。
 */
export function upsertCrossRepoBlockedBy(body: unknown, refs: readonly string[]): { body: string; changed: boolean } {
  const text = typeof body === "string" ? body : "";
  const block = renderCrossRepoBlock(refs);
  const existing = CROSS_REPO_BLOCK_RE.exec(text);
  if (existing) {
    if (!block) {
      const next = (text.slice(0, existing.index) + text.slice(existing.index + existing[0].length))
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "")
        .replace(/\s+$/, "");
      return { body: next, changed: next !== text };
    }
    const next = text.slice(0, existing.index) + block + text.slice(existing.index + existing[0].length);
    return { body: next, changed: next !== text };
  }
  if (!block) return { body: text, changed: false };
  const trimmed = text.replace(/\s+$/, "");
  return { body: trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`, changed: true };
}

/**
 * 一条引用能指向哪个仓库。
 *
 * `projects` 是 `.paseo-deck.json` 的项目清单（写路径只认它）；`repos` 是读路径额外知道的
 * 工作区仓库清单——写的时候不允许引用的仓库，读的时候可能已经在正文里了，那要如实读出来。
 */
export interface DependencyScope {
  projects: readonly { key: string; repo: string | null }[];
  /** 当前票所在仓库；本地 Markdown 后端为 null。 */
  currentRepo: string | null;
  /** 读路径专用：工作区里能连上的仓库键。写路径不传，避免拿它绕过配置校验。 */
  repos?: readonly string[];
}

export type DependencyRef =
  | { ok: true; local: true; number: number }
  | { ok: true; local: false; repo: string; number: number; ref: string }
  | { ok: false; detail: string };

function knownRepoKeys(scope: DependencyScope): string[] {
  const out: string[] = [];
  const add = (value: string | null) => {
    if (value && !out.includes(value)) out.push(value);
  };
  add(scope.currentRepo);
  for (const project of scope.projects) add(project.repo);
  for (const repo of scope.repos ?? []) add(repo);
  return out;
}

/**
 * 把一条 `blockedBy` 入参归一成「本仓库票号」或「跨仓库引用」。
 *
 * 认三种写法：`#12` / `12`（本仓库，走原生依赖边）、`owner/repo#12`、`项目键#12`。
 * 认不出来就拒绝并说清能写什么——不猜仓库，猜错会在别的仓库关掉同号票。
 */
export function dependencyRefOf(raw: unknown, scope: DependencyScope): DependencyRef {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, detail: "blockedBy 里有空项" };

  const bare = /^#?(\d{1,10})$/.exec(text);
  if (bare) {
    const number = Number(bare[1]);
    if (!Number.isInteger(number) || number <= 0) return { ok: false, detail: `blockedBy 里的「${text}」不是合法票号` };
    return { ok: true, local: true, number };
  }

  const cross = /^([^#\s]+)#(\d{1,10})$/.exec(text);
  if (!cross) {
    return {
      ok: false,
      detail: `blockedBy 里的「${text}」认不出来：写成 #12 / 12（本仓库）、owner/repo#12，或项目键#12`,
    };
  }
  const number = Number(cross[2]);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, detail: `blockedBy 里的「${text}」票号不合法` };

  const part = (cross[1] ?? "").trim();
  if (!part.includes("/")) {
    const project = scope.projects.find((item) => item.key === part);
    if (!project) {
      const keys = scope.projects.map((item) => item.key);
      return {
        ok: false,
        detail: `项目键「${part}」不在 .paseo-deck.json 里${keys.length ? `；能用的键：${keys.join("、")}` : "（这个工作区没有 v2 项目清单）"}`,
      };
    }
    if (!project.repo) {
      return { ok: false, detail: `项目「${part}」没有写 repo，解析不出是哪个仓库，不能当阻塞引用` };
    }
    return { ok: true, local: false, repo: project.repo, number, ref: crossRepoRefText(project.repo, number) };
  }

  if (!knownRepoKeys(scope).includes(part)) {
    const known = knownRepoKeys(scope);
    return {
      ok: false,
      detail: `仓库「${part}」不在配置里${known.length ? `；能引用的仓库：${known.join("、")}` : "：这个工作区没有 v2 项目清单，只能用当前仓库自己的 owner/repo#n"}`,
    };
  }
  return { ok: true, local: false, repo: part, number, ref: crossRepoRefText(part, number) };
}

/** 正文里的一个条目（读路径）：解析不出仓库就回 null，调用方按「引用失效」处理。 */
export function bodyDependencyRef(raw: string, scope: DependencyScope): { repo: string; number: number } | null {
  const parsed = dependencyRefOf(raw, scope);
  if (!parsed.ok) return null;
  if (parsed.local) return { repo: scope.currentRepo ?? "local", number: parsed.number };
  return { repo: parsed.repo, number: parsed.number };
}

export type ResolvedDependencies = { ok: true; local: number[]; cross: string[] } | { ok: false; detail: string };

/**
 * 整组 `blockedBy` 归一。
 *
 * 任何一项写错就整组拒绝，并说明是哪一项：只接受一半的阻塞集合，比拒绝更危险——
 * 用户以为「后端改完前端才能动」写信了，其实没写。
 */
export function resolveDependencyRefs(raw: readonly unknown[], scope: DependencyScope): ResolvedDependencies {
  const local: number[] = [];
  const cross: string[] = [];
  for (const entry of raw) {
    const parsed = dependencyRefOf(entry, scope);
    if (!parsed.ok) return { ok: false, detail: parsed.detail };
    if (parsed.local) {
      if (!local.includes(parsed.number)) local.push(parsed.number);
    } else if (!cross.includes(parsed.ref)) {
      cross.push(parsed.ref);
    }
  }
  return { ok: true, local, cross };
}
