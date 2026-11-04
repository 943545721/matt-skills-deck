/**
 * 建票闸的唯一入口。
 *
 * 三处必须共用它，任何一处漏调都等于没有闸：
 *   1. `deck_issue_create`（逐张建）；
 *   2. `deck_map_plan_create`（一次建「地图 + N 张子票」，每张子票都要过一遍）；
 *   3. 插件自己铺票（需求 → 各区、`@全部`）。
 *
 * 为什么必须只有一个入口：plan 第二节 ② 核过，`deck_map_plan_create` 内部直接调
 * `ops.issueCreate`，完全绕过 `deck_issue_create`；如果校验写在某个工具里，
 * 换一个入口就漏一次。这里把「入参硬问题」和「需求票正文/标签」合成一个判断，
 * 上层工具只负责读数与转述 detail，不再各写一份规则。
 *
 * 纯函数：不读环境变量、不写盘、不取会话、不读钟。
 */

import {
  IMPACT_HEADING,
  impactRowProblem,
  needsManualImpactTable,
  parseImpactTable,
  requireTicketGates,
  type GateResult,
  type TicketGateInput,
} from "./impact.ts";

/** 定稿标签只在这里导出一次；impact.ts 是定义处，这边只做 re-export。 */
export { DECK_FINALIZE_LABEL } from "./impact.ts";
export type { GateResult } from "./impact.ts";

export interface SplitGuardInput extends TicketGateInput {
  /** 父需求票正文；单区、没写过影响面节时可以不给。 */
  readonly requirementBody?: string | null;
  /** 这次会动到的仓库，用来判断是否跨区（去重后两个及以上要人工填表）。 */
  readonly repos?: readonly string[] | null;
  /** 需求是否声明了链条；声明了就要人工填表。 */
  readonly hasChain?: boolean | null;
}

/** 正文里已经写了影响面标题，就一定要按表校验——单区也不能把写坏的表悄悄放过。 */
function hasImpactSection(body: string): boolean {
  return body.split(/\r?\n/).some((line) => line.trim() === IMPACT_HEADING);
}

/**
 * 建票 / 派单前的唯一校验。
 *
 * 先过 `requireTicketGates`（deck: 标签、requirementKey、需求是否定稿），
 * 再按场景决定要不要读影响面表：
 *   - 单区、没声明链条：0 额外步骤，正文里没有影响面节就直接放行；
 *   - 跨两个以上仓库 / 声明了链条 / 正文里已经写了影响面节：必须解析表格，
 *     逐行校验依据、结论、核的人、第五列链条格式。
 *
 * 返回 `{ ok: true }` 或 `{ ok: false, detail }`；detail 是给模型和用户看的中文原因，
 * 调用方原样转述即可，不要自己改写。
 */
export function guardCreateTicket(input: SplitGuardInput): GateResult {
  const gate = requireTicketGates(input);
  if (!gate.ok) return gate;

  const body = typeof input.requirementBody === "string" ? input.requirementBody : "";
  const manualByInput = needsManualImpactTable({ repos: input.repos, hasChain: input.hasChain });
  const sectionWritten = hasImpactSection(body);

  // 单区、无链条、正文也没写这一节：自动填一行就够了，不逼人填表。
  if (!manualByInput && !sectionWritten) return { ok: true };

  if (!body.trim()) {
    return {
      ok: false,
      detail: "这次跨区或声明了链条，但读不到需求票正文：先读需求票（requirementKey 指向的那张），"
        + "补一张「## 影响面」表，每行写清 区 / 仓库、依据、结论、核的人。",
    };
  }

  const parsed = parseImpactTable(body);
  if (!parsed.ok) return { ok: false, detail: parsed.reason };

  if (parsed.rows.length === 0) {
    return {
      ok: false,
      detail: "影响面表没有数据行：每个要动的区至少占一行；单区且没链条时就不要写这一节，让插件自动填。",
    };
  }

  // 「声明了链条」也可能是某一行的第五列自己写出来的；无论哪条入口进来，
  // 只要写了表就逐行校验格式，避免单区场景下写坏的自动行混过去。
  for (let index = 0; index < parsed.rows.length; index += 1) {
    const row = parsed.rows[index];
    if (!row) continue;
    const problem = impactRowProblem(row);
    if (problem) {
      const where = row.area ? "（" + row.area + "）" : "";
      return { ok: false, detail: "影响面第 " + (index + 1) + " 行" + where + "：" + problem };
    }
  }

  return { ok: true };
}
