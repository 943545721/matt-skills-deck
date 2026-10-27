import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 诊断日志契约。
 *
 * 只读、只在内存、条数有限：它是给「刚才那一下为什么没成」用的，
 * 不是审计日志——审计需要落盘与脱敏策略，那是另一件事。
 */
export const logsRpc = defineRpc({
  name: "deck.logs",
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({
    entries: z.array(
      z.object({
        at: z.string(),
        level: z.enum(["info", "warn", "error"]),
        scope: z.string(),
        message: z.string(),
      }),
    ),
  }),
});

/**
 * 清空日志。
 *
 * 清空是不可撤销的，但影响面只有这份内存缓冲：误点之后下一次操作会重新积累记录，
 * 所以不做二次确认弹窗——那只会让「刚清完想再看一眼」多一步。
 */
export const logsClearRpc = defineRpc({
  name: "deck.logs.clear",
  input: z.object({}),
  output: z.object({ cleared: z.number().int() }),
});
