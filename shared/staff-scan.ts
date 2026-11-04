/**
 * 扫岗结果的形状与校验。
 *
 * 扫描会话（一个普通 agent）读一遍仓库，把它认为的岗位写进 `.deck/staff-scan.json`；
 * 服务端只读这个文件、**不执行它**。所以这里的每一行都是边界校验：一个模型写的
 * 名字、领地、身份都可能不对，坏了要在进名册之前就被挡下，而不是等人派活时才发现。
 *
 * 两条口径：
 * 1. 文件整体读不出来（没有 `candidates` 数组）算「这次扫描没结果」，报失败，不猜。
 * 2. 单条候选不合格只丢这一条并说出原因，其余照常呈现——一条坏了不该让整份结果作废。
 */

import {
  MAX_STAFF_DUTY_CHARS,
  MAX_STAFF_NAME_CHARS,
  MAX_STAFF_PATHS,
  normalizeStaffPath,
  type StaffKind,
} from "./staff.ts";

/** 扫描结果落在 `.deck/` 下的文件名。扫描会话按这个名字写，服务端按这个名字读。 */
export const STAFF_SCAN_FILE = "staff-scan.json";

/** 一次最多呈现几张候选：再多就不像「这个项目有哪几个岗」，像在把文件名念一遍。 */
export const MAX_STAFF_SCAN_CANDIDATES = 12;

/** 依据路径最多留几条：够看出「凭什么这么分」，不留一整份目录树。 */
const MAX_EVIDENCE = 6;

/** 一条依据路径的长度上限；与名册路径同一个量级。 */
const MAX_EVIDENCE_CHARS = 200;

/** 扫描会话提出的一张岗位候选。它还不是名册上的卡：采纳时才生成 id。 */
export interface StaffScanCandidate {
  name: string;
  kind: StaffKind;
  /** 职责提示词；空串表示扫描没给出，采纳时不写系统提示。 */
  duty: string;
  /** 领地路径前缀，已归一、去重、封顶；空数组 = 整片。 */
  paths: string[];
  /** 凭什么这么分：文件或目录，逐条展示给人看。 */
  evidence: string[];
}

export type StaffScanParse =
  | { ok: true; candidates: StaffScanCandidate[]; warnings: string[] }
  | { ok: false; detail: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown, cap: number, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const one = text(item).slice(0, limit);
    if (one && !out.includes(one)) out.push(one);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 把扫描文件解析成候选。
 *
 * `pathExists` 由调用方注入（服务端查盘、测试给假值）：领地是名册派活的依据，
 * 一个盘上不存在的路径等于把活派进空气里，所以整条丢掉，而不是悄悄留一张空领地卡。
 */
export function parseStaffScan(
  raw: unknown,
  pathExists: (path: string) => boolean = () => true,
): StaffScanParse {
  if (!raw || typeof raw !== "object") {
    return { ok: false, detail: "扫描结果不是一份 JSON 对象" };
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.candidates)) {
    return { ok: false, detail: "扫描结果里没有 candidates 数组——这次扫描没写出候选" };
  }

  const warnings: string[] = [];
  const candidates: StaffScanCandidate[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  record.candidates.forEach((item, index) => {
    const at = `第 ${index + 1} 条候选`;
    if (!item || typeof item !== "object") {
      dropped += 1;
      warnings.push(`${at}不是对象，已丢弃`);
      return;
    }
    const card = item as Record<string, unknown>;
    const name = text(card.name).slice(0, MAX_STAFF_NAME_CHARS);
    if (!name) {
      dropped += 1;
      warnings.push(`${at}没有名字，已丢弃（没名字的卡在群里点不到）`);
      return;
    }

    const paths: string[] = [];
    const claimed = Array.isArray(card.paths) ? card.paths : [];
    let escapes = false;
    for (const item of claimed) {
      const one = normalizeStaffPath(item);
      if (!one || paths.includes(one)) continue;
      // 领地是相对工作区的：`../` 指到工作区外面，一律不认。
      if (one.split("/").includes("..")) {
        escapes = true;
        continue;
      }
      paths.push(one);
      if (paths.length >= MAX_STAFF_PATHS) break;
    }
    if (escapes) {
      dropped += 1;
      warnings.push(`「${name}」的领地指到了工作区外面（含 ..），整条丢弃`);
      return;
    }
    const missing = paths.filter((one) => !pathExists(one));
    if (missing.length) {
      dropped += 1;
      warnings.push(
        `「${name}」声称的领地 ${missing.join("、")} 在工作区里不存在，整条丢弃（领地是派活的依据，不能是编的）`,
      );
      return;
    }

    const duty = text(card.duty).slice(0, MAX_STAFF_DUTY_CHARS);
    const evidence = stringList(card.evidence, MAX_EVIDENCE, MAX_EVIDENCE_CHARS);
    // 身份只认这两个词；不认识就按员工——与名册缺省一致，不会凭空多出一个经理。
    const kind: StaffKind = text(card.kind) === "manager" ? "manager" : "worker";

    const key = `${name}\u0000${paths.join(",")}`;
    if (seen.has(key)) {
      warnings.push(`「${name}」（${paths.join("、") || "整片"}）重复出现，已合并成一条`);
      return;
    }
    seen.add(key);

    if (candidates.length >= MAX_STAFF_SCAN_CANDIDATES) {
      dropped += 1;
      return;
    }
    candidates.push({ name, kind, duty, paths, evidence });
  });

  if (dropped) {
    warnings.push(`另有 ${dropped} 条候选没能收下，见上（扫歪的地方宁可少一张卡）`);
  }
  if (!candidates.length && !warnings.length) {
    warnings.push("扫描没有提出任何岗位：这次没读到可分的结构");
  }

  return { ok: true, candidates, warnings };
}

/** 采纳时用的去重键：同名同领地视为同一个人，免得连点两次「全部采纳」长出两张卡。 */
export function staffScanKeyOf(candidate: {
  name: string;
  paths: readonly string[];
}): string {
  return `${candidate.name.trim()}\u0000${[...candidate.paths].sort().join(",")}`;
}
