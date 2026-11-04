/**
 * 岗位归属：一条路径归哪张卡。
 *
 * 这是「同一把尺子，两个用法」里的那把尺子：
 * - 派单前用它判「这一跳该交给谁」；
 * - 运行中用它在权限请求上判「这条路径归谁」。
 * 两处必须调同一个函数，否则会出现「派单时认为归 A、写文件时认为归 B」。
 *
 * 算法**先经理层、后员工层**，不是所有卡一起取最长前缀。理由：
 * 经理管 `saas/`、员工管 `saas/src/x/` 时，一起取最长前缀会直接命中员工，
 * 局部经理被整个跳过，而且不报错——票照建、钱照花，你以为中间那层在管，其实没有。
 * 先算经理层，员工只在命中经理的领地内找，层级就不会被跳过。
 *
 * 前缀比较一律吃到 `/` 边界：`web/` 不吞 `web-admin/`，`server/` 不吞 `server-old/`。
 * 路径先归一化：反斜杠转 `/`、去前导 `/`、折叠 `.` / `..`。
 *
 * 纯函数：不读写文件、不取会话、不改入参。
 */

import { MAX_STAFF_PATH_CHARS } from "./staff.ts";
import type { StaffCard } from "./staff.ts";

/**
 * 根经理的表示。
 *
 * 根经理 = 工作区的派单窗口，名册里**没有**对应的卡（`shared/staff.ts` 的注释写着
 * 名册卡不带工作区，根经理也不需要一张卡才能派活）。所以用 `id: null` 表示它，
 * 不为了统一形状凭空造一张卡——造了就会在名册界面里多出一个删不掉的人。
 */
export interface RootManagerCard {
  readonly id: null;
  readonly name: string;
  readonly kind: "manager";
}

/** 归属结果里的「人」：名册卡，或没有卡的根经理。 */
export type OwnerStaff = StaffCard | RootManagerCard;

/** 默认根经理：调用方不传 `rootManager` 时，工作区整片都归它。 */
export const DEFAULT_ROOT_MANAGER: RootManagerCard = Object.freeze({
  id: null,
  name: "根经理",
  kind: "manager",
});

export interface ResolveOwnerInput {
  /** 相对工作区根的路径；空串 = 工作区根 / 整片。归一化在这里做，入参原样不改。 */
  readonly path: unknown;
  /**
   * 这个工作区的名册。
   * `null` / `undefined` = 这条路径不属于任何工作区（调用方已经找不到工作区）。
   * 空数组仍算「工作区存在、只是还没建卡」。
   */
  readonly roster?: readonly StaffCard[] | null;
  /** 只用于拒绝时的说明文案，不参与计算。 */
  readonly workspaceId?: string;
  /**
   * 根经理：
   * - 不传：默认有一个根经理，整片都归它（今天的行为）；
   * - 传 `null`：这个工作区没有绑根经理，没被任何卡声明的路径就是无主；
   * - 传一张卡：用调用方给的那张（例如特殊工作区）。
   */
  readonly rootManager?: OwnerStaff | null;
}

export type OwnerResolveReason = "no-workspace" | "unclaimed";

export type OwnerResolution =
  | {
      readonly ok: true;
      readonly staff: OwnerStaff;
      readonly layer: "manager" | "worker";
      /**
       * 决定这次归属的经理层卡。员工层命中时也带上，调用方由此能看出
       * 「这个员工是在哪个经理的领地里找到的」，而不是员工直接跳过了经理层。
       * 单卡名册且那张卡是员工、又没有根经理时为 `null`。
       */
      readonly manager: OwnerStaff | null;
      /** 命中的最长前缀；整片（空 `paths`）为 `""`。 */
      readonly matchedPrefix: string;
      /**
       * 决定这次归属的经理层命中前缀；没有经理层时为空串。
       *
       * 员工卡没填 `paths`（整片）时，`matchedPrefix` 也是空串，单靠它推不出
       * 容器工作区的仓库；这个字段保留「哪片经理领地里找到的」，让调用方能退回到
       * 经理的领地再推 repoKey。
       */
      readonly managerPrefix: string;
    }
  | {
      readonly ok: false;
      readonly reason: OwnerResolveReason;
      readonly detail: string;
    };

/**
 * 路径归一化：反斜杠转 `/`、去空段与前导 `/`、折叠 `.` / `..`。
 *
 * 不复用 `normalizeStaffPath`：它的 `^\.\/+` 会把以 `../` 开头的路径折掉一层，
 * 而越出工作区根的 `..` 必须保留成前导 `..`——否则 `../../saas/x` 会被当成
 * `saas/x`，越界拦截会误判成在领地内。长度上限仍用名册那条。
 */
export function normalizeOwnerPath(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const parts: string[] = [];
  for (const part of raw.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
      continue;
    }
    parts.push(part);
  }
  return parts.join("/").slice(0, MAX_STAFF_PATH_CHARS);
}

/**
 * `path` 是否落在 `prefix` 这片里，按 `/` 边界比较。
 *
 * 空 `prefix` = 整片，什么都落得进去；空 `path` 只落在整片里，
 * 不落在具体目录里——工作区根不是某个子目录的一部分。
 */
export function pathWithinPrefix(path: unknown, prefix: unknown): boolean {
  const target = normalizeOwnerPath(path);
  const area = normalizeOwnerPath(prefix);
  if (!area) return true;
  return target === area || target.startsWith(`${area}/`);
}

export interface TerritoryContext {
  readonly roster?: readonly StaffCard[] | null;
  readonly workspaceId?: string;
  readonly rootManager?: OwnerStaff | null;
}

/**
 * 这条路径是否在某张卡的领地内。
 *
 * 卡上 `paths` 为空 = 整片，什么都算在内；否则任一前缀命中即算。
 *
 * **越界拦截要带 `context.roster`**：两块领地重叠时，只看自己的前缀会和派单
 * 得出不同的答案（例如经理管 `saas/src`、员工声明了更宽的 `saas`）。
 * 带上名册就复用 `resolveOwner` 的归属结果，两处真的是同一把尺子；
 * 不带名册时只回答「这张卡自己声明了什么」，不判重叠。
 */
export function isPathInStaffTerritory(
  staff: StaffCard,
  path: unknown,
  context?: TerritoryContext,
): boolean {
  if (context?.roster) {
    const owner = resolveOwner({
      path,
      roster: context.roster,
      workspaceId: context.workspaceId,
      rootManager: context.rootManager,
    });
    return owner.ok && owner.staff.id !== null && owner.staff.id === staff.id;
  }
  const prefixes = declaredPrefixes(staff);
  if (!prefixes.length) return true;
  return prefixes.some((prefix) => pathWithinPrefix(path, prefix));
}

/** 卡上声明的目录前缀；空 `paths` 由调用方按「整片」处理，这里只回非空前缀。 */
function declaredPrefixes(staff: StaffCard): string[] {
  return (staff.paths ?? []).map(normalizeOwnerPath).filter((prefix) => prefix.length > 0);
}

interface PrefixMatch {
  readonly prefix: string;
  readonly specificity: number;
}

/**
 * 在这张卡的领地里找对 `path` 的最长前缀。
 *
 * `restrictTo` 非空时还要求卡上的前缀本身落在这个经理的领地里——
 * 「只看领地被它覆盖的员工卡」。没有 `paths` 的卡是整片，只有整片那一层
 * （根经理 / 没填 `paths` 的经理）才收它；局部经理名下不算。
 *
 * 同长度时保留名册里靠前的卡（调用方按名册顺序传，结果稳定）。
 */
function bestMatch(path: string, card: StaffCard, restrictTo: string): PrefixMatch | null {
  const prefixes = declaredPrefixes(card);
  // 空 `paths` 是「整片」（见 `shared/staff.ts`）：它覆盖局部经理的领地，
  // 所以 `restrictTo` 非空时也要收它，否则整片员工会被误判成没人。
  if (!prefixes.length) {
    return { prefix: "", specificity: 0 };
  }
  let best: PrefixMatch | null = null;
  for (const prefix of prefixes) {
    if (restrictTo && !pathWithinPrefix(prefix, restrictTo)) continue;
    if (!pathWithinPrefix(path, prefix)) continue;
    if (!best || prefix.length > best.specificity) best = { prefix, specificity: prefix.length };
  }
  return best;
}

function unclaimed(workspace: string, path: string): OwnerResolution {
  return {
    ok: false,
    reason: "unclaimed",
    detail: `${workspace}里没有卡声明 ${path || "整片"}：交给确认，不猜一个归谁。`,
  };
}

/**
 * 归属主函数。
 *
 * 顺序固定：
 * 1. 在 `kind: "manager"` 的卡里取最长前缀；都没命中 → 根经理；
 * 2. 在命中经理的领地内找员工卡，同样取最长前缀；
 * 3. 没有员工命中 → 这片归这个经理自己；
 * 4. 连经理层都没有（`rootManager: null` 且没有经理卡命中）→ 仍按员工卡自己的声明找；
 *    连员工也没命中，才算「没人声明这片」，交给确认。
 *
 * 单卡名册是退化情形：只要路径在那张卡声明的领地里（或那张卡没填 `paths`），就是它。
 */
export function resolveOwner(input: ResolveOwnerInput): OwnerResolution {
  const path = normalizeOwnerPath(input.path);
  const roster = input.roster;
  if (!roster) {
    return {
      ok: false,
      reason: "no-workspace",
      detail: `这条路径（${path || "整片"}）不属于任何工作区：没有可用的名册，交给确认。`,
    };
  }

  const workspace = input.workspaceId ? `工作区 ${input.workspaceId}` : "这个工作区";
  const rootManager = input.rootManager === undefined ? DEFAULT_ROOT_MANAGER : input.rootManager;

  if (!roster.length) {
    if (rootManager) {
      return {
        ok: true,
        staff: rootManager,
        layer: "manager",
        manager: rootManager,
        matchedPrefix: "",
        managerPrefix: "",
      };
    }
    return unclaimed(workspace, path);
  }

  // 单卡名册：路径落在它的领地里就是它。这张卡是员工时也算它自己——
  // 名册里只有一个人，再往经理层找只会凭空造出一层不存在的管理关系。
  if (roster.length === 1) {
    const only = roster[0];
    if (only) {
      const match = bestMatch(path, only, "");
      if (match) {
        const manager: OwnerStaff | null = only.kind === "manager" ? only : rootManager;
        return {
          ok: true,
          staff: only,
          layer: only.kind === "manager" ? "manager" : "worker",
          manager,
          matchedPrefix: match.prefix,
          managerPrefix: only.kind === "manager" ? match.prefix : "",
        };
      }
    }
  }

  const picked = pickManager(path, roster, rootManager);
  // 连经理层都没有时，员工卡自己声明的领地仍然算数，搜索范围放开到整片；
  // 只有连员工也没有命中，才算「没人声明这片」。
  const worker = pickWorker(path, roster, picked.manager ? (picked.prefix ?? "") : "");
  if (worker) {
    return {
      ok: true,
      staff: worker.worker,
      layer: "worker",
      manager: picked.manager,
      matchedPrefix: worker.prefix,
      managerPrefix: picked.prefix ?? "",
    };
  }
  if (!picked.manager) return unclaimed(workspace, path);
  return {
    ok: true,
    staff: picked.manager,
    layer: "manager",
    manager: picked.manager,
    matchedPrefix: picked.prefix ?? "",
    managerPrefix: picked.prefix ?? "",
  };
}

interface ManagerPick {
  readonly manager: OwnerStaff | null;
  readonly prefix: string | null;
}

/** 第一层：经理层取最长前缀；都没命中 → 根经理；根经理也没有 → `manager: null`。 */
function pickManager(
  path: string,
  roster: readonly StaffCard[],
  rootManager: OwnerStaff | null,
): ManagerPick {
  let manager: OwnerStaff | null = null;
  let prefix: string | null = null;
  for (const card of roster) {
    if (card.kind !== "manager") continue;
    const match = bestMatch(path, card, "");
    if (!match) continue;
    if (!manager || match.specificity > (prefix?.length ?? 0)) {
      manager = card;
      prefix = match.prefix;
    }
  }
  if (manager) return { manager, prefix: prefix ?? "" };
  return { manager: rootManager, prefix: rootManager ? "" : null };
}

interface WorkerPick {
  readonly worker: StaffCard;
  readonly prefix: string;
}

/** 第二层：只在 `restrictTo` 这片里找员工；同长度保留名册里靠前的卡。 */
function pickWorker(
  path: string,
  roster: readonly StaffCard[],
  restrictTo: string,
): WorkerPick | null {
  let worker: StaffCard | null = null;
  let prefix: string | null = null;
  for (const card of roster) {
    if (card.kind === "manager") continue;
    const match = bestMatch(path, card, restrictTo);
    if (!match) continue;
    if (!worker || match.specificity > (prefix?.length ?? 0)) {
      worker = card;
      prefix = match.prefix;
    }
  }
  return worker ? { worker, prefix: prefix ?? "" } : null;
}
