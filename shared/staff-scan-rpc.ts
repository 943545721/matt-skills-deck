import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 扫岗的两条 RPC：起一次扫描、读这次扫描的结果。
 *
 * 分成两条，是因为它们的时间尺度完全不同：起扫描建会话要几秒，读结果可能要等几分钟。
 * 合成一条的话，界面每次轮询都会重新建一个会话——那是要花钱的。
 *
 * 扫描本身跑在一个普通 agent 会话里（规矩写在 systemPrompt 里），结果落到
 * `.deck/staff-scan.json`。服务端只读文件、按 `parseStaffScan` 校验，绝不执行里面的东西。
 */

/** 扫描会话按这张卡建完之后可以再读；候选里每一条都是还没进名册的提案。 */
const candidateSchema = z.object({
  name: z.string(),
  kind: z.enum(["manager", "worker"]),
  duty: z.string(),
  /** 相对工作区根的路径前缀；空数组 = 整片。 */
  paths: z.array(z.string()),
  /** 凭什么这么分：文件或目录。 */
  evidence: z.array(z.string()),
});

export const STAFF_SCAN_FAILURE_REASONS = [
  "invalid-workspace",
  "settings-unreadable",
  "settings-corrupt",
  "route-unavailable",
  /** 工作区目录读不出来：连清点都做不了，不能拿一份空简报去扫。 */
  "inventory-failed",
  "create-failed",
  "write-failed",
] as const;

export type StaffScanFailureReason = (typeof STAFF_SCAN_FAILURE_REASONS)[number];

/**
 * 起一次扫岗。
 *
 * 客户端/模型跟 **normal 档路由**走，与「建窗口」同一条路，不新增配置项：
 * 扫岗不是一类新任务，它就是一件普通活。
 */
export const staffScanStartRpc = defineRpc({
  name: "deck.orchestration.staff-scan",
  input: z.object({
    workspaceDir: z.string().min(1).max(4096),
    workspaceId: z.string().min(1).max(300),
    /** 扫描简报与规矩用哪种语言；缺省中文。 */
    lang: z.enum(["zh", "en"]).optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      agentId: z.string(),
      title: z.string(),
    }),
    z.object({
      ok: z.literal(false),
      /**
       * `route-unavailable`：normal 这一档没有可用客户端；
       * `create-failed`：宿主拒绝建会话（`detail` 是原话）；
       * `write-failed`：会话建好了但旧候选文件清不掉，界面要提醒「这份结果可能不是新的」。
       */
      reason: z.enum(STAFF_SCAN_FAILURE_REASONS),
      detail: z.string(),
    }),
  ]),
});

/**
 * 读这次扫描的结果。
 *
 * `status` 三态刻意分开：`missing` 是「扫描还没写完」，`invalid` 是「写坏了」。
 * 把两者混成一个「失败」，人就分不清该再等等还是该重扫。
 */
export const staffScanReadRpc = defineRpc({
  name: "deck.orchestration.staff-scan.read",
  input: z.object({
    workspaceDir: z.string().min(1).max(4096),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      status: z.enum(["missing", "invalid", "ready"]),
      /** 文件里的 `at`，扫描会话自己写的；没有就是 null，不替它编一个时间。 */
      scannedAt: z.string().nullable(),
      candidates: z.array(candidateSchema),
      warnings: z.array(z.string()),
      /** `invalid` 时用：为什么这份结果不能用。 */
      detail: z.string().nullable(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid-workspace", "read-failed"]),
      detail: z.string(),
    }),
  ]),
});
