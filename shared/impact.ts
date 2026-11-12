/**
 * 需求票「影响面」表与建票闸的纯函数层。
 * 为什么单独立一份：影响面是侦查结论的落点——区/仓库、依据、结论、核的人。
 * 侦查错一行，后面每道闸门都在认真保护一个错的前提（plan 十点五），
 * 所以这一节必须机器可读，派单与建工作票都读同一份判断。
 *
 * 边界：单区、没声明链条的活不填表，插件自动填一行；跨两个以上仓库或声明了链条，
 * 才要求人工填满、每行有人核；`deck:` 前缀是插件私标签，MCP 写入一律拒绝。
 *
 * 纯函数：不读环境变量、不写盘、不取会话、不读钟。
 */

import { labelNames } from "./issue-kind.ts";

/** 影响面小节的标题，正文里必须逐字出现这一行。 */
export const IMPACT_HEADING = "## 影响面";

/** 四列固定名；顺序也固定，解析靠位置对齐。 */
export const IMPACT_COLUMNS: readonly string[] = Object.freeze(["区 / 仓库", "依据", "结论", "核的人"]);

/** 第五列可选，只承载链条；没有链条就留空。 */
export const IMPACT_CHAIN_COLUMN = "链条（没有就留空）";

/** 需求票「定稿」标签：只有客户端按钮写得出来，`ready-for-agent` 不算。 */
export const DECK_FINALIZE_LABEL = "deck:定稿";

/** 需求票的身份标签，和 `shared/requirement.ts` 的 requirementLabels 保持一致。 */
export const REQUIREMENT_LABEL = "requirement";

/** 关需求票时写进正文的验收记录前缀（见 plan 十节）。 */
export const ACCEPTANCE_RECORD_PREFIX = "验收：";

/** 结论只认这三个词。 */
export const IMPACT_CONCLUSIONS: readonly string[] = Object.freeze(["要动", "不动", "待核"]);

/**
 * 会产出实际改动、必须挂在一条需求票下的票类型。
 *
 * 只认 `spec-ticket`：它是实施票，动代码的那一类，需求是它的前提。
 * 其余位置各有各的入口理由，硬套这条闸会把顺序弄反：
 * - `map-ticket` 是侦查路线票，需求还没成型时就该建得出来；
 * - `bug` 是入口收单，缺陷往往在需求之前发现；
 * - `issue` 是万能兜底票（手动建票、派单票面都走它），先有需求不是它的硬前提。
 */
export const WORK_TICKET_KINDS: readonly string[] = Object.freeze(["spec-ticket"]);

/** 单区自动填行的固定文案；人工表不写这些，避免把自动行和人工行混在一起。 */
export const SINGLE_AREA_VALUES = Object.freeze({ area: "当前工作区", basis: "需求票本身", conclusion: "要动", reviewer: "单区，免核" });

export interface ImpactRow {
  readonly area: string; readonly basis: string; readonly conclusion: string;
  readonly reviewer: string; readonly chain: string;
}

export type ImpactParseResult =
  | { readonly ok: true; readonly rows: readonly ImpactRow[] }
  | { readonly ok: false; readonly reason: string };

export type GateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/** 两个收口函数只为让「拒绝」永远带一句人话，别在调用点漏掉 reason/detail。 */
function parseFail(reason: string): ImpactParseResult { return { ok: false, reason }; }
function fail(detail: string): GateResult { return { ok: false, detail }; }

/** 只把字符串收成去空的一行；非字符串按空处理，闸不因调用方传错类型而抛异常。 */
function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}
function isTableLine(line: string): boolean {
  return line.trim().startsWith("|");
}
/** 去掉首尾的表格竖线；末尾 `\|` 是转义，不当分隔。 */
function stripTableEdges(line: string): string {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body;
}
/** 按未转义的 `|` 拆格；链条摘要里写 `\|` 不会被误拆。 */
function splitTableRow(line: string): string[] {
  const body = stripTableEdges(line);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}
function isSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim());
}
function sameHeader(actual: string, expected: string): boolean {
  return actual.replace(/\s+/g, " ").trim() === expected.replace(/\s+/g, " ").trim();
}

type TableLookup =
  | { readonly ok: true; readonly tableLines: readonly string[] }
  | { readonly ok: false; readonly reason: string };
/** 找到「## 影响面」后的连续表格行；标题、空行、表格不完整都在这里收口。 */
function findImpactTable(body: string): TableLookup {
  const lines = (typeof body === "string" ? body : "").split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => text(line) === IMPACT_HEADING);
  if (headingIndex < 0) {
    return { ok: false, reason: "没找到「" + IMPACT_HEADING + "」这一节：需求票正文先补一张影响面表，派单与建工作票都读这一节。" };
  }
  let cursor = headingIndex + 1;
  while (cursor < lines.length && !text(lines[cursor])) cursor += 1;
  if (cursor >= lines.length || !isTableLine(lines[cursor] ?? "")) {
    return { ok: false, reason: "「" + IMPACT_HEADING + "」下面没有表格：至少要有表头和分隔行，再接数据行。" };
  }
  const tableLines: string[] = [];
  while (cursor < lines.length && isTableLine(lines[cursor] ?? "")) {
    tableLines.push(lines[cursor] ?? "");
    cursor += 1;
  }
  if (tableLines.length < 2) {
    return { ok: false, reason: "影响面表不完整：至少要有表头和一行 |---|---|… 分隔行。" };
  }
  return { ok: true, tableLines };
}
/** 表头必须是四列固定名，或再加第五列链条；返回 null 表示通过。 */
function headerProblem(header: readonly string[]): string | null {
  if (header.length < IMPACT_COLUMNS.length || header.length > IMPACT_COLUMNS.length + 1) {
    return "影响面表头有 " + header.length + " 列，应该是 4 列（"
      + IMPACT_COLUMNS.join("、") + "），或 5 列再加「" + IMPACT_CHAIN_COLUMN + "」。";
  }
  for (let index = 0; index < IMPACT_COLUMNS.length; index += 1) {
    const actual = header[index] ?? "";
    const expected = IMPACT_COLUMNS[index] ?? "";
    if (!sameHeader(actual, expected)) {
      return "影响面表头第 " + (index + 1) + " 列应该是「" + expected + "」，这里是「" + actual + "」。";
    }
  }
  if (header.length === IMPACT_COLUMNS.length + 1) {
    const chainHeader = header[IMPACT_COLUMNS.length] ?? "";
    if (!sameHeader(chainHeader, IMPACT_CHAIN_COLUMN)) {
      return "影响面表头第五列应该是「" + IMPACT_CHAIN_COLUMN + "」，这里是「" + chainHeader + "」。";
    }
  }
  return null;
}
function separatorProblem(separator: readonly string[], headerLength: number): string | null {
  if (separator.length !== headerLength) {
    return "影响面表的分隔行有 " + separator.length + " 格，表头是 " + headerLength + " 列，两者要一样。";
  }
  return separator.every(isSeparatorCell)
    ? null
    : "表头下面要有一行 |---|---|… 分隔行：每格只写 --- 或 :---: 这样的形式。";
}
function tableRows(dataLines: readonly string[], headerLength: number): ImpactParseResult {
  const rows: ImpactRow[] = [];
  for (let index = 0; index < dataLines.length; index += 1) {
    const cells = splitTableRow(dataLines[index] ?? "");
    if (cells.length !== headerLength) {
      return parseFail("影响面表第 " + (index + 1) + " 行有 " + cells.length + " 格，表头是 "
        + headerLength + " 列：每一格的竖线都要对齐。");
    }
    rows.push(Object.freeze({
      area: cells[0] ?? "",
      basis: cells[1] ?? "",
      conclusion: cells[2] ?? "",
      reviewer: cells[3] ?? "",
      chain: headerLength > IMPACT_COLUMNS.length ? (cells[4] ?? "") : "",
    }));
  }
  return { ok: true, rows: Object.freeze(rows) };
}
/**
 * 从票正文解析 `## 影响面` 之后的 markdown 表格。
 *
 * 只做结构校验（标题、表头、分隔行、列数），不判断某行内容对不对；
 * 内容交给 `impactRowProblem`，这样调用方能把「表坏了」和「第几行没核」分开报。
 * 缺表、表头错、列数错都返回 `ok:false` 与一句可显示的中文原因，绝不抛异常。
 */
export function parseImpactTable(body: string): ImpactParseResult {
  const found = findImpactTable(body);
  if (!found.ok) return parseFail(found.reason);
  const header = splitTableRow(found.tableLines[0] ?? "");
  const headerIssue = headerProblem(header);
  if (headerIssue) return parseFail(headerIssue);
  const separatorIssue = separatorProblem(splitTableRow(found.tableLines[1] ?? ""), header.length);
  if (separatorIssue) return parseFail(separatorIssue);
  return tableRows(found.tableLines.slice(2), header.length);
}

/** 第五列解析后的四种形态；none = 留空。 */
export type ImpactChainKind = "none" | "contract" | "capability" | "waiting" | "detail";

/** 第五列的机器字段；缺项一律 null，不用空串冒充。 */
export interface ImpactChainParsed {
  readonly kind: ImpactChainKind;
  /** `契约：<摘要>` 的摘要。 */
  readonly summary: string | null;
  /** `权益：` 的功能键。 */
  readonly featureKey: string | null;
  /** `存量升级=是|否`。 */
  readonly upgradeExisting: boolean | null;
  /** `等 #<票号>` 或 `详见 #<票号>` 指向的票号。 */
  readonly ticket: number | null;
}

export type ImpactChainParseResult =
  | { readonly ok: true; readonly chain: ImpactChainParsed }
  | { readonly ok: false; readonly reason: string };

const EMPTY_IMPACT_CHAIN: ImpactChainParsed = Object.freeze({
  kind: "none",
  summary: null,
  featureKey: null,
  upgradeExisting: null,
  ticket: null,
});

/**
 * 解析第五列（链条）。
 *
 * 只认四种写法：
 *   契约：<一行摘要>
 *   权益：feature_key=<键>，存量升级=是|否
 *   等 #<票号>
 *   详见 #<票号>
 * 空串 = 没有链条。解析与校验共用这一份，`impactChainProblem` 只是它的 `reason` 投影；
 * contract-chain 也读它，避免「按钮放过了、派单又拒绝」。
 */
export function parseImpactChain(chain: unknown): ImpactChainParseResult {
  const value = text(chain);
  if (!value) return { ok: true, chain: EMPTY_IMPACT_CHAIN };

  if (value.startsWith("契约：")) {
    const summary = value.slice("契约：".length).trim();
    return summary
      ? { ok: true, chain: Object.freeze({ ...EMPTY_IMPACT_CHAIN, kind: "contract", summary }) }
      : { ok: false, reason: "第五列的「契约：」后面要跟一行摘要；没有链条就整格留空。" };
  }
  if (value.startsWith("权益：")) {
    const rest = value.slice("权益：".length).trim();
    const match = /^feature_key=(\S+)\s*，\s*存量升级=(是|否)$/.exec(rest);
    return match
      ? {
        ok: true,
        chain: Object.freeze({
          ...EMPTY_IMPACT_CHAIN,
          kind: "capability",
          featureKey: match[1] ?? "",
          upgradeExisting: match[2] === "是",
        }),
      }
      : { ok: false, reason: "「权益：」要写成「权益：feature_key=<键>，存量升级=是|否」（全角逗号，存量升级只填是或否）。" };
  }

  const waiting = /^等 #(\d+)$/.exec(value);
  if (waiting) {
    return { ok: true, chain: Object.freeze({ ...EMPTY_IMPACT_CHAIN, kind: "waiting", ticket: Number(waiting[1] ?? "") }) };
  }
  const detail = /^详见 #(\d+)$/.exec(value);
  if (detail) {
    return { ok: true, chain: Object.freeze({ ...EMPTY_IMPACT_CHAIN, kind: "detail", ticket: Number(detail[1] ?? "") }) };
  }

  if (value.startsWith("等")) {
    return { ok: false, reason: "「等」这一种要写成「等 #<票号>」（半角空格 + 井号 + 数字）。" };
  }
  if (value.startsWith("详见")) {
    return { ok: false, reason: "「详见」这一种要写成「详见 #<票号>」（半角空格 + 井号 + 数字）。" };
  }

  const halfWidthHint = /^(契约|权益):/.test(value)
    ? "提示：契约 / 权益后面的冒号要用全角「：」，半角「:」不认。"
    : "";
  return {
    ok: false,
    reason: "第五列只认四种写法：契约：<摘要>；权益：feature_key=<键>，存量升级=是|否；"
      + "等 #<票号>；详见 #<票号>。没有链条就留空。" + halfWidthHint,
  };
}

/**
 * 第五列格式校验：返回 null 表示合法，否则返回一句可显示的原因。
 *
 * 直接复用 `parseImpactChain`，保证「定稿按钮」与「派单闸」读的是同一份格式规则。
 */
export function impactChainProblem(chain: unknown): string | null {
  const parsed = parseImpactChain(chain);
  return parsed.ok ? null : parsed.reason;
}

/**
 * 校验影响面的一行。
 *
 * 口径（按顺序判，先命中的先说）：
 *   1. 依据为空 → 不行。写「待核」是「还没查，我知道」，依据空着是「连要查什么都没写」；
 *   2. 结论只能是 要动 / 不动 / 待核；
 *   3. 结论「要动」时核的人不能空——核的人必须是那个区已有的窗口，不是将来才建的员工；
 *      「待核」行天然还没核，所以不要求核的人，但依据仍然不能空；
 *   4. 第五列若写了，只能是四种链条写法之一。
 *
 * 返回 null 表示这一行通过。
 */
export function impactRowProblem(row: Readonly<Partial<ImpactRow>> | null | undefined): string | null {
  const value = row ?? {};
  const basis = text(value.basis);
  const conclusion = text(value.conclusion);
  const reviewer = text(value.reviewer);

  if (!basis) {
    return "「依据」为空：写上这次在那个区读到的原文（路径:行 / 路由 / 表 / 配置项 / 权限项），"
      + "没有依据就不算结论。";
  }
  if (!IMPACT_CONCLUSIONS.some((candidate) => candidate === conclusion)) {
    return "「结论」只能是 要动 / 不动 / 待核，这里是「" + conclusion + "」。";
  }
  if (conclusion === "要动" && !reviewer) {
    return "结论是「要动」，但「核的人」为空：必须由那个区已有的窗口回一句，"
      + "写明是谁、什么时候核的；单区自动行写「单区，免核」。";
  }
  return impactChainProblem(value.chain);
}

/** 单区自动填的那一行：0 额外步骤，和 plan 十点五的表格逐字一致。 */
export function singleAreaImpactRow(): ImpactRow {
  return Object.freeze({
    area: SINGLE_AREA_VALUES.area,
    basis: SINGLE_AREA_VALUES.basis,
    conclusion: SINGLE_AREA_VALUES.conclusion,
    reviewer: SINGLE_AREA_VALUES.reviewer,
    chain: "",
  });
}

/**
 * 这次是否需要人工填影响面表。
 *
 * 只动一个仓库 / 一个区，且没声明链条 → 自动填一行；
 * 跨两个以上仓库（repos 去重后至少两个），或声明了链条 → 人工填、每行有人核。
 * 判断在定稿那一刻做，默认走自动行，避免改一个错别字也走全套流程。
 */
export function needsManualImpactTable(input: {
  readonly repos?: readonly string[] | null;
  readonly hasChain?: boolean | null;
} | null | undefined): boolean {
  const repos = Array.isArray(input?.repos)
    ? input.repos.map((repo) => text(repo).toLowerCase()).filter(Boolean)
    : [];
  const uniqueRepos = repos.filter((repo, index) => repos.indexOf(repo) === index);
  return input?.hasChain === true || uniqueRepos.length >= 2;
}

/** 正文里有没有「## 影响面」这一节。定稿按钮与写票闸都从这里判，省得两处各写一份找法。 */
export function hasImpactSection(body: unknown): boolean {
  const textBody = typeof body === "string" ? body : "";
  return textBody.split(/\r?\n/).some((line) => line.trim() === IMPACT_HEADING);
}

/**
 * 正文里写了「## 影响面」就校验这张表的结构；没写就放行。
 *
 * 与 `finalizeProblem` 的分工：这里只管标题 / 表头 / 分隔行 / 列数，不看数据行，
 * 因为写票过程中表可以先空着。结构必须一开始就对——写坏的表如果等到派单才发现，
 * 报错会落在派单窗口，改票的人却在需求窗口。
 */
export function impactSectionProblem(body: unknown): string | null {
  if (!hasImpactSection(body)) return null;
  const parsed = parseImpactTable(typeof body === "string" ? body : "");
  return parsed.ok ? null : parsed.reason;
}

/**
 * 点「定稿」之前核影响面：通过返回 null，否则返回一句可显示的原因。
 *
 * 只有需要人工表（跨两个以上仓库 / 声明了链条）或正文已经写了这一节时才解析；
 * 单区、没写这一节的活交给拆票时自动填一行，不在按钮上逼人填表。
 * 客户端按钮与服务端闸共用这一个判断，避免「按钮放过了、派单又拒绝」。
 */
export function finalizeProblem(body: unknown, repos?: readonly string[] | null): string | null {
  const textBody = typeof body === "string" ? body : "";
  if (!needsManualImpactTable({ repos }) && !hasImpactSection(textBody)) return null;
  const parsed = parseImpactTable(textBody);
  if (!parsed.ok) return parsed.reason;
  if (parsed.rows.length === 0) return "影响面表没有数据行：每个要动的区至少占一行。";
  for (let index = 0; index < parsed.rows.length; index += 1) {
    const problem = impactRowProblem(parsed.rows[index]);
    if (problem) return "影响面第 " + (index + 1) + " 行：" + problem;
  }
  return null;
}

/** 这枚标签是不是插件私有的 `deck:` 标签（大小写不敏感，GitHub 标签名不区分大小写）。 */
export function isDeckLabel(name: unknown): boolean {
  return text(name).toLowerCase().startsWith("deck:");
}

/** 标签里是否已有 `deck:定稿`。只有这一枚算定稿，`ready-for-agent` 不算。 */
export function isFinalized(labels: unknown): boolean {
  return labelNames(labels).some((name) => name.toLowerCase() === DECK_FINALIZE_LABEL.toLowerCase());
}

/** 这条票是不是需求票：kind=requirement，或带着 requirement 标签。 */
export function isRequirementTicket(kind: unknown, labels: unknown): boolean {
  return text(kind).toLowerCase() === REQUIREMENT_LABEL
    || labelNames(labels).some((name) => name.toLowerCase() === REQUIREMENT_LABEL);
}

/** 这是不是会实际改东西的工作票（需求容器、地图/规格容器都不算）。 */
export function isWorkTicketKind(kind: unknown): boolean {
  const name = text(kind);
  return WORK_TICKET_KINDS.some((candidate) => candidate === name);
}

/**
 * 收 requirementKey：接受票号数字或 `"#12"` / `"12"` 字符串。
 * 0 也收——本地 `.deck` 后端的票号可以是 00；这里只判「有没有给」，不猜范围。
 */
export function normalizeRequirementKey(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/^#/, "");
    return /^\d+$/.test(cleaned) ? Number(cleaned) : null;
  }
  return null;
}

export interface TicketGateInput {
  readonly kind: string;
  /** 这次要写入的标签（建票时）或需求票自己的标签（派单且未另给 requirementLabels 时）。 */
  readonly labels?: readonly string[] | null;
  /** 正文；闸按入参判，不靠正文猜 requirementKey（正文写不写是格式问题，入参有没有是硬问题）。 */
  readonly body?: string | null;
  readonly requirementKey?: number | string | null;
  readonly staff?: string | null;
  /** create = 建票；dispatch = 派单。派单侧复用同一道闸。 */
  readonly action?: "create" | "dispatch";
  /** 父需求票（requirementKey 指向的那条）的标签；建工作票时用来判定稿。 */
  readonly requirementLabels?: readonly string[] | null;
}

/**
 * 建票闸：返回 ok，或一句可操作的拒绝理由。
 *
 * 规则（按顺序，先命中的先说）：
 *   1. 经 MCP 写任何 `deck:` 标签 → 拒绝。模型不能给自己发许可证；
 *   2. 建工作票（issue / spec-ticket / map-ticket / bug）必须带 requirementKey；
 *   3. 建工作票时，父需求票必须已经带 `deck:定稿`；
 *   4. 派单时，目标需求票必须带 `deck:定稿`；`ready-for-agent` 不进任何判定分支。
 *
 * 建需求票本身不要求先定稿——定稿是它建完以后由人点按钮打的。
 */
export function requireTicketGates(input: TicketGateInput): GateResult {
  const action = input.action === "dispatch" ? "dispatch" : "create";

  // 1. deck: 私标签只能由界面按钮写。派单时 labels 是读到的需求票标签，
  //    里面本来就可能有 deck:定稿，所以只在建票这条路上拦。
  if (action === "create") {
    const offending = labelNames(input.labels).find(isDeckLabel);
    if (offending) {
      return fail("标签「" + offending + "」不能经 MCP 写：这枚标签只能由界面上的按钮打。"
        + "deck_issue_create / deck_issue_labels 一律拒绝 deck: 前缀，模型不能给自己发许可证。");
    }
  }

  const requirement = isRequirementTicket(input.kind, input.labels);

  if (action === "dispatch") {
    const requirementLabels = input.requirementLabels ?? input.labels;
    if (!isFinalized(requirementLabels)) {
      return fail("这条需求还没定稿：先把六节谈完、影响面核完，再在票详情页点「定稿」"
        + "（标签 " + DECK_FINALIZE_LABEL + "），之后才能为它派单。ready-for-agent 不算定稿。");
    }
    return { ok: true };
  }

  if (requirement) return { ok: true };

  // 工作票必须挂在需求下；别的票型一旦显式给了 requirementKey，也按同一条口径核——
  // 给了就等于声明「我属于这条需求」，那它定没定稿就不能跳过。
  const key = normalizeRequirementKey(input.requirementKey);
  if (key === null && isWorkTicketKind(input.kind)) {
    return fail("建工作票要先有一条需求票：requirementKey 必填，填那条需求票的票号。"
      + "无票不干活——活只活在会话里，窗口一关什么都不剩。");
  }
  if (key !== null) {
    if (!Array.isArray(input.requirementLabels)) {
      return fail("建工作票要读需求票的标签：把 requirementKey 指向的那张需求票的标签一起传给闸，"
        + "才分得清它定没定稿。");
    }
    if (!isFinalized(input.requirementLabels)) {
      return fail("这条需求还没定稿：先把六节谈完、影响面核完，再在票详情页点「定稿」"
        + "（标签 " + DECK_FINALIZE_LABEL + "），之后才能为它拆工作票。ready-for-agent 不算定稿。");
    }
  }

  return { ok: true };
}
