/**
 * 岗位名册的数据形状与归一化。
 *
 * 从 `orchestration.ts` 拆出来的原因很实际：名册是独立的一块领域（谁在这个工作区、
 * 管哪片、用什么模型），与路由表、地图预算互不相关，堆在同一个文件里只会让那个文件
 * 每加一个功能就变长一次。
 *
 * 两条口径：
 * 1. 归一化（读文件）只做「收拾」，不拒收；收拾完什么都不剩才算无效。
 * 2. 建卡（人在界面上填）走严格判定，非法 id 当场拒绝，不让它悄悄变成一个空串。
 */

import { MAX_ROLE_PROMPT_CHARS } from "./role-prompts.ts";
import { asRecord, clampInt, optionalText, text } from "./coerce.ts";
import type { WorkspaceRoles } from "./orchestration.ts";

export const MAX_STAFF_DUTY_CHARS = MAX_ROLE_PROMPT_CHARS;
export const MAX_STAFF_ID_CHARS = 64;
export const MAX_STAFF_NAME_CHARS = 32;
export const MAX_STAFF_PATH_CHARS = 300;
export const MAX_STAFF_PATHS = 20;
export const MAX_STAFF_CONCURRENCY = 8;
export const MAX_STAFF_CARDS = 24;

/** 会话标签：认出「这个会话是哪张卡开的」。建完之后改不了，所以它就是履历的键。 */
export const DECK_STAFF_LABEL = "deck.staff";

/** 名册里的一类卡：经理能在自己那片里再往下派，员工只干活。 */
export type StaffKind = "manager" | "worker";

/**
 * 名册上的一张卡。
 *
 * 卡上**不写工作区**：名册属于**目录**（`.deck/orchestration.json` 就存在那个目录里），
 * 一份名册里的所有卡都在这个目录里干活。同一个目录在宿主里可能有多个 workspaceId
 * （每次重开就生成一个），卡不与其中任何一个绑定，见 `rosterOf`。
 */
export interface StaffCard {
  /**
   * 稳定键；派单任务与群里的 @ 都用它。
   *
   * **建卡时生成一个与名字无关的随机键**，人可改成小写字母 / 数字 / `-`。
   * 不按名字归一化：名字允许中文、emoji、重名，归一化会得到空串或撞成同一个 id。
   * 生成之后不再改（会话标签创建后不可变，改 id 只会让履历断成两段）。
   */
  id: string;
  /** 显示名，完全由人定：中英文、emoji 都行，重名也允许。 */
  name: string;
  /** 缺省 `"worker"`：旧文件没这个字段，名册里全是员工，行为与今天一致。 */
  kind?: StaffKind;
  /** 职责提示词 → 子会话的 systemPrompt。空 = 不写系统提示。 */
  duty?: string;
  /** 用哪份档案；不给就按这条任务的 difficulty 走路由。 */
  profileId?: string;
  /** 他在这个工作区内部管的路径前缀，一行一个；空 = 整片。 */
  paths?: string[];
  /** 同一张卡同时最多几个在跑；默认 1。 */
  maxConcurrent?: number;
}

/**
 * 岗位 id 归一：小写、只留 `[a-z0-9-]`、截断。
 *
 * 归一化路径只做「收拾」，不做「拒收」——与 `promptsOf` 同口径。收拾完什么都不剩
 * 才算无效（这张卡会被丢掉，因为 id 是它的唯一键）。要「建卡时就拒绝非法 id」，
 * 用 `isValidStaffId` 在创建路径上判，别让归一化顺手把人写的东西变成空串。
 */
export function normalizeStaffId(value: unknown): string {
  const raw = text(value).toLowerCase();
  const kept = raw.replace(/[^a-z0-9-]/g, "");
  return kept.slice(0, MAX_STAFF_ID_CHARS);
}

const STAFF_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 建卡时生成 id：`staff-` + 6 位小写字母数字。
 *
 * 与名字无关：中文名、emoji 名归一化之后都是空串，拿名字当 id 这张卡就存不住。
 * 撞上已有 id 就重摇（36^6 ≈ 22 亿，正常一次就成）。
 */
export function newStaffId(taken: readonly string[] = []): string {
  const used = new Set(taken);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let suffix = "";
    for (let index = 0; index < 6; index += 1) {
      suffix += STAFF_ID_ALPHABET[Math.floor(Math.random() * STAFF_ID_ALPHABET.length)];
    }
    const id = `staff-${suffix}`;
    if (!used.has(id)) return id;
  }
  throw new Error("岗位 id 连续 64 次都撞上了已有的 id：名册太满或随机源坏了");
}

/** 建卡时用的严格判定：原样就是合法的 `[a-z0-9-]`，长度 1..64。 */
export function isValidStaffId(value: unknown): boolean {
  const raw = text(value);
  return raw.length > 0 && raw.length <= MAX_STAFF_ID_CHARS && /^[a-z0-9-]+$/.test(raw);
}

/** 领地里的一条路径：相对工作区根、去 `./` 与前导 `/`、折叠结尾 `/`。 */
export function normalizeStaffPath(value: unknown): string {
  return text(value)
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .slice(0, MAX_STAFF_PATH_CHARS);
}

function staffPathsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const one = normalizeStaffPath(item);
    if (one && !out.includes(one)) out.push(one);
    if (out.length >= MAX_STAFF_PATHS) break;
  }
  return out.length ? out : undefined;
}

/**
 * 名册归一：丢空 id、id 收敛、同名 id 后者覆盖前者、路径与提示词截断、张数封顶。
 *
 * 不拒收：一份手改坏的文件不该让整份设置失效。真要紧的是**别让坏的变成空串再互相覆盖**，
 * 所以 id 收敛完为空就整张丢掉，而不是留一张「没有 id 的卡」。
 */
export function normalizeStaffCards(value: unknown): StaffCard[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const byId = new Map<string, StaffCard>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const id = normalizeStaffId(record.id);
    if (!id) continue;
    const name = (text(record.name) || id).slice(0, MAX_STAFF_NAME_CHARS);
    const duty = text(record.duty).slice(0, MAX_STAFF_DUTY_CHARS);
    const profileId = optionalText(record.profileId);
    const paths = staffPathsOf(record.paths);
    const concurrency = clampInt(record.maxConcurrent, 1, MAX_STAFF_CONCURRENCY, 1);
    // 同名 id：后来的覆盖前面的（与 `normalizeMapBudgets` 相反：那里保留第一条，
    // 因为预算是「配错就失效」，而名册是同一个人改出来的新版本，新版本才该生效）。
    byId.set(id, {
      id,
      name,
      kind: record.kind === "manager" ? "manager" : "worker",
      ...(duty ? { duty } : {}),
      ...(profileId ? { profileId } : {}),
      ...(paths ? { paths } : {}),
      maxConcurrent: concurrency,
    });
    if (byId.size >= MAX_STAFF_CARDS) break;
  }
  const out = [...byId.values()];
  return out.length ? out : undefined;
}

/** 按 id 取卡；大小写归一后比较，取不到回 `null`。 */
export function staffCardOf(
  roles: WorkspaceRoles | null | undefined,
  id: string | null | undefined,
): StaffCard | null {
  const wanted = normalizeStaffId(id);
  if (!wanted) return null;
  return roles?.staff?.find((card) => card.id === wanted) ?? null;
}

/** 整组替换名册，其它字段原样带走。空数组 = 清空名册（不留一个空壳字段）。 */
export function withStaffCards(roles: WorkspaceRoles, cards: readonly StaffCard[]): WorkspaceRoles {
  const next: WorkspaceRoles = { ...roles };
  const normalized = normalizeStaffCards(cards);
  if (normalized) next.staff = normalized;
  else delete next.staff;
  return next;
}

/** 一份设置里与名册有关的那点形状：读名册不必知道路由、预算之类的字段。 */
export interface RosterFile {
  roles?: readonly WorkspaceRoles[];
}

/**
 * 这个目录的名册：文件里**所有** role 条目的卡合起来。
 *
 * 文件按目录存，`roles` 却按 workspaceId 分桶——这是两块不同的东西：
 * 会话槽位（主窗口 / 派单窗口）必须是 id，会话本来就属于具体工作区；
 * 名册反过来只属于目录。同一个目录在宿主里会攒出好几个 id（每次重开一个），
 * 卡若跟着 id 分桶，后果是「换个工作区打开，人全没了」，或者群里把同一批人列好几遍。
 *
 * 合并口径与 `normalizeStaffCards` 一致：同 id 的卡以后来的为准（新版本才生效），
 * 顺序按第一次出现的位置；仍然封顶 `MAX_STAFF_CARDS`。
 */
export function rosterOf(file: RosterFile | null | undefined): StaffCard[] {
  const roles = file?.roles;
  if (!roles?.length) return [];
  const byId = new Map<string, StaffCard>();
  for (const role of roles) {
    for (const card of role.staff ?? []) {
      if (!card?.id) continue;
      byId.set(card.id, card);
      if (byId.size >= MAX_STAFF_CARDS) break;
    }
    if (byId.size >= MAX_STAFF_CARDS) break;
  }
  return [...byId.values()];
}

/**
 * 一条 role 还有没有值得留下的东西。
 *
 * 两者共用一把尺子：`withWorkspaceRoles` 保存角色绑定时靠它决定留不留这条，
 * `withDirectoryRoster` 清卡之后靠它决定这条是不是只剩空壳。各写一份迟早分叉。
 */
export function roleCarriesFields(role: WorkspaceRoles): boolean {
  return Boolean(
    role.mainAgentId?.trim() ||
      role.dispatcherAgentId?.trim() ||
      role.progressAgentId?.trim() ||
      role.prompts ||
      role.staff?.length,
  );
}

/**
 * 把整份名册写到这个 workspaceId 那条上，并把**其它条目里的卡清掉**。
 *
 * 只写不清不行：删掉一张卡之后，旧 workspaceId 那条里还留着它，
 * 下次 `rosterOf` 一合并就把它复活了。旧条目只清卡，会话槽位与提示词原样保留。
 * 空数组 = 真的清空名册（与 `normalizeStaffCards` 一致：空数组不留空壳字段）。
 */
export function withDirectoryRoster<T extends RosterFile & { roles: WorkspaceRoles[] }>(
  settings: T,
  workspaceId: string,
  cards: readonly StaffCard[],
): T {
  const id = workspaceId.trim();
  if (!id) return settings;
  const roster = normalizeStaffCards(cards) ?? [];
  const roles: WorkspaceRoles[] = [];
  let wrote = false;
  for (const role of settings.roles) {
    const sameId = role.workspaceId === id;
    if (sameId) wrote = true;
    const next: WorkspaceRoles = { ...role };
    if (sameId && roster.length) next.staff = roster;
    else delete next.staff;
    if (roleCarriesFields(next)) roles.push(next);
  }
  if (!wrote && roster.length) roles.push({ workspaceId: id, staff: roster });
  return { ...settings, roles };
}
