import {
  MAX_STAFF_CONCURRENCY,
  MAX_STAFF_DUTY_CHARS,
  MAX_STAFF_NAME_CHARS,
  MAX_STAFF_PATHS,
  newStaffId,
  normalizeStaffPath,
  staffWithoutTerritory,
  type StaffCard,
  type StaffKind,
} from "../../../../shared/staff.ts";
import type { PanelKey } from "../../panel/panelText.tsx";

/**
 * 岗位表单的草稿 ↔ 卡映射，以及「整片」与「能不能保存」的判定。
 *
 * 抽成纯函数的原因：领地必填之后，保存按钮什么时候灰、什么时候写 `["."]`，
 * 决定了名册里会不会多出一张「没说管哪片」的卡。这些事情不该只在渲染组件里试出来。
 *
 * 三条口径：
 * 1. 空 `paths` = 没配，不是整片；整片只有一个写法：`["."]`。
 * 2. `.` 只由开关表达。人在路径框里敲一个点，不算一条路径——否则关掉开关也存成整片。
 * 3. 缺领地横幅照 shared 的 `staffWithoutTerritory` 说，判据与派单闸是同一份。
 */

/** 整片标记：领地里只有它，表示这张卡管整个工作区。 */
export const WHOLE_TERRITORY = ".";

/** 一行一个路径：去 `./` 与前导 `/`、折叠结尾 `/`、去重、封顶；`.` 不算路径。 */
export function territoryPathsOf(value: string): string[] {
  const out: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const path = normalizeStaffPath(line);
    if (!path || path === WHOLE_TERRITORY || out.includes(path)) continue;
    out.push(path);
    if (out.length >= MAX_STAFF_PATHS) break;
  }
  return out;
}

/** 卡上的 `paths` 是否表示整片：有值，且每一条都是 `.`。 */
export function isWholeTerritory(paths: readonly string[] | null | undefined): boolean {
  const normalized = (paths ?? []).map((path) => normalizeStaffPath(path)).filter(Boolean);
  return normalized.length > 0 && normalized.every((path) => path === WHOLE_TERRITORY);
}

/** 名册卡一行的领地摘要：整片，或具体目录。没配时 `paths` 为空、`whole` 为假。 */
export interface TerritorySummary {
  whole: boolean;
  paths: string[];
}

export function territorySummary(paths: readonly string[] | null | undefined): TerritorySummary {
  const whole = isWholeTerritory(paths);
  return { whole, paths: whole ? [] : territoryPathsOf((paths ?? []).join("\n")) };
}

/** 展示行：整片行不带路径；具体路径行原样给出去。 */
export interface TerritoryLine {
  whole: boolean;
  /** `whole` 为真时是空串——点号不交给渲染层。 */
  path: string;
}

/**
 * 路径列表 → 展示行：整片卡只出一行「整片」，其余按具体路径去重。
 *
 * 是不是整片只问 `isWholeTerritory`：整张卡都是 `.` 才算，混在具体路径里的
 * 点号不算一行（那是 #40 会拦住的写法），点号本身不会交给渲染层。
 */
export function territoryLines(
  paths: readonly string[] | null | undefined,
): TerritoryLine[] {
  const list = paths ?? [];
  if (isWholeTerritory(list)) return [{ whole: true, path: "" }];
  const out: TerritoryLine[] = [];
  for (const raw of list) {
    const path = normalizeStaffPath(raw);
    if (!path || isWholeTerritory([path])) continue;
    if (!out.some((line) => line.path === path)) out.push({ whole: false, path });
  }
  return out;
}

/** 路径列表 → 一行展示文案；整片用调用方给的说法，空列表返回空串。 */
export function territoryText(
  paths: readonly string[] | null | undefined,
  wholeLabel: string,
): string {
  return territoryLines(paths)
    .map((line) => (line.whole ? wholeLabel : line.path))
    .join(" · ");
}

/**
 * 名册里有卡缺领地时的那句横幅；没有缺项返回 `null`，调用方整块不渲染。
 *
 * 「谁缺领地」只问 shared 的 {@link staffWithoutTerritory}：空 `paths` 算缺、`["."]` 算整片，
 * 这条判据派单闸用的也是它，界面不另写一份。名字之间用名册里一贯的「 · 」。
 */
export function territoryBannerText(
  cards: readonly StaffCard[],
  t: (key: PanelKey, vars?: Record<string, string | number>) => string,
): string | null {
  const missing = staffWithoutTerritory(cards);
  if (missing.length === 0) return null;
  const names = missing.map((card) => card.name?.trim() || card.id).join(" · ");
  return t("orch.staffTerritoryBanner", { n: missing.length, names });
}

export interface StaffDraft {
  id: string;
  name: string;
  kind: StaffKind;
  duty: string;
  /** 空串 = 不选档案，按难度路由。 */
  profileId: string;
  /** 一行一个路径，保存时再拆。整片时这里应为空串。 */
  pathsText: string;
  /** 领地是否整片：打开时写 `["."]`，输入框禁用。 */
  wholeTerritory: boolean;
  maxConcurrent: number;
}

/** 卡 → 草稿。整片卡不带出点号，只把开关打开。 */
export function staffDraftFromCard(card: StaffCard): StaffDraft {
  const territory = territorySummary(card.paths);
  return {
    id: card.id,
    name: card.name,
    kind: card.kind === "manager" ? "manager" : "worker",
    duty: card.duty ?? "",
    profileId: card.profileId ?? "",
    pathsText: territory.paths.join("\n"),
    wholeTerritory: territory.whole,
    maxConcurrent: card.maxConcurrent ?? 1,
  };
}

/** 新卡草稿：id 现场生成，身份默认员工，领地空着等填。 */
export function staffDraftForNew(taken: readonly string[]): StaffDraft {
  return {
    id: newStaffId(taken),
    name: "",
    kind: "worker",
    duty: "",
    profileId: "",
    pathsText: "",
    wholeTerritory: false,
    maxConcurrent: 1,
  };
}

/** 草稿 → 卡。整片写 `["."]`；否则去掉空行与点号，一条都不剩就不写 `paths`。 */
export function staffCardFromDraft(draft: StaffDraft): StaffCard {
  const duty = draft.duty.trim();
  const profileId = draft.profileId.trim();
  const paths = draft.wholeTerritory ? [WHOLE_TERRITORY] : territoryPathsOf(draft.pathsText);
  return {
    id: draft.id,
    name: draft.name.trim().slice(0, MAX_STAFF_NAME_CHARS),
    kind: draft.kind,
    ...(duty ? { duty: duty.slice(0, MAX_STAFF_DUTY_CHARS) } : {}),
    ...(profileId ? { profileId } : {}),
    ...(paths.length ? { paths } : {}),
    maxConcurrent: Math.min(MAX_STAFF_CONCURRENCY, Math.max(1, Math.round(draft.maxConcurrent))),
  };
}

/** 保存前发现的第一个问题；目录是否存在只能等服务端判，这里不猜。 */
export type StaffDraftProblem = "name" | "territory";

/** 领地是不是没填：关掉整片，却没留下一条具体路径。 */
export function isTerritoryMissing(draft: StaffDraft): boolean {
  return !draft.wholeTerritory && territoryPathsOf(draft.pathsText).length === 0;
}

/** 表单缺什么：名字为空，或者关掉整片却一条路径都没填。 */
export function staffDraftProblem(draft: StaffDraft): StaffDraftProblem | null {
  if (!draft.name.trim()) return "name";
  if (isTerritoryMissing(draft)) return "territory";
  return null;
}

/** 保存按钮能不能点：没缺东西才行。服务端仍会校验目录是否真实存在。 */
export function canSaveStaffDraft(draft: StaffDraft): boolean {
  return staffDraftProblem(draft) === null;
}
