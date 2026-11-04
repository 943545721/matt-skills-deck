import { MAX_STAFF_CARDS, MAX_STAFF_NAME_CHARS, newStaffId, type StaffCard } from "../../../../shared/staff.ts";
import { staffScanKeyOf, type StaffScanCandidate } from "../../../../shared/staff-scan.ts";

/**
 * 把扫描候选并进名册的那一步。
 *
 * 纯函数，好测：这里错一次不会报错，只会让人在群页看到两张同名同领地的卡，
 * 派活时随到其中一张，履历从此分成两段。
 *
 * 三条口径：
 * 1. 已有卡不动：采纳只追加，绝不覆盖人自己改过的名字与职责。
 * 2. 同名同领地视为同一张卡，跳过并计入 `skipped`——连点两次「全部采纳」不会翻倍。
 * 3. 名册上限照旧：超出的部分不加，用 `full` 说出来，而不是悄悄丢掉。
 */

export interface AdoptScanResult {
  /** 采纳之后的名册。 */
  cards: StaffCard[];
  /** 真正加进去几张。 */
  added: number;
  /** 因为「已经在名册上」而跳过的条数。 */
  skipped: number;
  /** 因为名册满了而没加进去的条数。 */
  overLimit: number;
}

export function adoptScanCandidates(
  current: readonly StaffCard[],
  picked: readonly StaffScanCandidate[],
): AdoptScanResult {
  const seen = new Set(current.map((card) => staffScanKeyOf({ name: card.name, paths: card.paths ?? [] })));
  const cards: StaffCard[] = [...current];
  let added = 0;
  let skipped = 0;
  let overLimit = 0;

  for (const candidate of picked) {
    const key = staffScanKeyOf(candidate);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    if (cards.length >= MAX_STAFF_CARDS) {
      overLimit += 1;
      continue;
    }
    seen.add(key);
    cards.push({
      // id 现场生成、与名字无关：扫描给的名字可能撞上已有卡，也可能含中文。
      id: newStaffId(cards.map((card) => card.id)),
      name: candidate.name.slice(0, MAX_STAFF_NAME_CHARS),
      kind: candidate.kind,
      ...(candidate.duty ? { duty: candidate.duty } : {}),
      ...(candidate.paths.length ? { paths: [...candidate.paths] } : {}),
      maxConcurrent: 1,
    });
    added += 1;
  }

  return { cards, added, skipped, overLimit };
}
