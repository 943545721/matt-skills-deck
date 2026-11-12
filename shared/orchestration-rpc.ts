import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { FIXED_ROLE_NAMES, MAX_ROLE_PROMPT_CHARS, ROLE_LANGS } from "./role-prompts.ts";
import {
  MAX_MIN_CONCURRENT_STAFF,
  MAX_MODEL_THINKING,
  MAX_STAFF_CARDS,
  MAX_STAFF_SESSION_QUOTA,
  MAX_STAFF_CONCURRENCY,
  MAX_STAFF_DUTY_CHARS,
  MAX_STAFF_ID_CHARS,
  MAX_STAFF_NAME_CHARS,
  MAX_STAFF_PATHS,
  MAX_STAFF_PATH_CHARS,
  isValidStaffId,
} from "./orchestration.ts";

/**
 * 编排的 RPC 契约。
 *
 * 线上只传「哪个工作区、哪个会话、什么难度、什么提示词」，不传 `homeDir`、不传密钥明文：
 * daemon 的 `agents.providers.*.env` 由服务端读出来掩码后再给界面看，
 * 客户端提交的 env 只允许「改/删某个键」，不允许整块替换。
 */

export const difficultySchema = z.enum(["trivial", "normal", "hard", "critical"]);

export const clientTargetSchema = z.object({
  provider: z.string().min(1).max(120),
  model: z.string().max(200).optional(),
  modeId: z.string().max(200).optional(),
  thinkingOptionId: z.string().max(200).optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
});

export const routingRuleSchema = z.object({
  difficulty: difficultySchema,
  profileId: z.string().max(200).optional(),
  target: clientTargetSchema.optional(),
});

/** 名册上的一张卡。`id` 建卡时生成、之后不改（会话标签创建后不可变）。 */
export const staffCardSchema = z.object({
  // 只留一份判定：与 `isValidStaffId` 同源，别再抄一遍正则与长度。
  id: z.string().refine(isValidStaffId, `id 只能用小写字母、数字和 -，长度 1..${MAX_STAFF_ID_CHARS}`),
  name: z.string().min(1).max(MAX_STAFF_NAME_CHARS),
  kind: z.enum(["manager", "worker"]).optional(),
  duty: z.string().max(MAX_STAFF_DUTY_CHARS).optional(),
  profileId: z.string().max(200).optional(),
  paths: z.array(z.string().max(MAX_STAFF_PATH_CHARS)).max(MAX_STAFF_PATHS).optional(),
  maxConcurrent: z.number().int().min(1).max(MAX_STAFF_CONCURRENCY).optional(),
});

/** 客户端卡片上按「客户端 + 模型」配的一条默认档；id 不写死。 */
export const modelThinkingDefaultSchema = z.object({
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(200),
  thinkingOptionId: z.string().min(1).max(200),
});

export const orchestrationSettingsSchema = z.object({
  roles: z.array(
    z.object({
      workspaceId: z.string().min(1).max(300),
      mainAgentId: z.string().max(300).optional(),
      requirementAgentId: z.string().max(300).optional(),
      dispatcherAgentId: z.string().max(300).optional(),
      progressAgentId: z.string().max(300).optional(),
      /** 用户改过的身份提示词；没改的那一段回落默认值。 */
      prompts: z
        .object({
          main: z.string().max(MAX_ROLE_PROMPT_CHARS).optional(),
          requirement: z.string().max(MAX_ROLE_PROMPT_CHARS).optional(),
          dispatcher: z.string().max(MAX_ROLE_PROMPT_CHARS).optional(),
          progress: z.string().max(MAX_ROLE_PROMPT_CHARS).optional(),
        })
        .optional(),
      /** 岗位名册；没有这一段 = 空名册，派单行为与接这个功能之前一致。 */
      staff: z.array(staffCardSchema).max(MAX_STAFF_CARDS).optional(),
    }),
  ),
  routing: z.array(routingRuleSchema),
  /**
   * 卡片上按「客户端 + 模型」配的默认档位。
   * 旧设置文件没有这一段，归一化后是空数组——线上始终有这一项。
   */
  modelThinking: z.array(modelThinkingDefaultSchema).max(MAX_MODEL_THINKING),
  maxDepth: z.number().int().min(1).max(6),
  maxChildrenPerDispatch: z.number().int().min(1).max(24),
  /**
   * 地图级并发预算；空数组 = 不限制。
   * 存进 `.deck/orchestration.json`，派单时服务端按它数「已经开着几个」。
   */
  mapBudgets: z.array(
    z.object({
      /** 地图引用：`owner/repo#2` 或 `#2`。 */
      map: z.string().min(3).max(300),
      concurrency: z.number().int().min(1).max(24),
    }),
  ),
  reportOnFinish: z.boolean(),
  /** 一批活至少铺在几张员工卡上；1 = 不强制铺开。 */
  minConcurrentStaff: z.number().int().min(1).max(MAX_MIN_CONCURRENT_STAFF),
  /** 需求定稿后、铺票前是否先列清单给人确认。 */
  confirmRequirementSplit: z.boolean(),
  /** 每 6 小时最多新开几个 deck 子会话；0 = 关掉这道闸。 */
  staffSessionQuota: z.number().int().min(0).max(MAX_STAFF_SESSION_QUOTA),
});

export const clientProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().optional(),
});

export const routeResolutionSchema = z.union([
  /** `via`：这条路由是从哪来的——档案 / 直接目标。 */
  z.object({ ok: z.literal(true), target: clientTargetSchema, via: z.enum(["profile", "target"]) }),
  z.object({
    ok: z.literal(false),
    /** `no-model`：只选了客户端没选模型，宿主只认 `provider/model`，这一档发不出去。 */
    reason: z.enum(["profile-missing", "no-target", "no-model"]),
    detail: z.string(),
  }),
]);

export const agentRowSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  status: z.string().nullable(),
  parentAgentId: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
});

/**
 * 一个 deck MCP 进程没拿到会话身份（`PASEO_AGENT_ID` 为空）。
 *
 * 宿主快照里没有环境变量，所以这只能由 MCP 进程自己留痕、编排状态读取时回收。
 * `pid` 用来判断那个窗口还在不在；`lastTool` 是最近一次因此被拒的工具（还没被拒过就是 null）。
 */
export const identityGapSchema = z.object({
  pid: z.number().int().positive(),
  since: z.string(),
  lastTool: z.string().nullable(),
  lastAt: z.string().nullable(),
});

/** 树节点的线上形状；递归结构在 zod 里要显式标注类型。 */
export interface TreeNodeWire {
  agentId: string;
  title: string | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  difficulty: z.infer<typeof difficultySchema> | null;
  ticketKey: string | null;
  updatedAt: string | null;
  /** 父会话不在本区快照里：跨区派出去的子会话，界面标「跨区 ↹」。 */
  crossWorkspace: boolean;
  children: TreeNodeWire[];
}

export const treeNodeSchema = z.lazy(() =>
  z.object({
    agentId: z.string(),
    title: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    status: z.string().nullable(),
    difficulty: difficultySchema.nullable(),
    ticketKey: z.string().nullable(),
    updatedAt: z.string().nullable(),
    crossWorkspace: z.boolean(),
    children: z.array(treeNodeSchema),
  }),
) as unknown as z.ZodType<TreeNodeWire>;

/**
 * 宿主报出的一个推理档位。
 *
 * 选项一律来自宿主快照，插件不写死档位列表；`label` 缺失时服务端已退回 id，
 * 所以这里要求非空。`description` 只是给人看的补充，认不出就不带。
 */
export const thinkingOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
});

/** 某个模型报出的档位；没有档位的模型不会出现在 `providerRowSchema.modelThinking` 里。 */
export const modelThinkingSchema = z.object({
  id: z.string(),
  thinkingOptions: z.array(thinkingOptionSchema),
  defaultThinkingOptionId: z.string().optional(),
});

export const providerRowSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  enabled: z.boolean(),
  status: z.string(),
  /** 宿主**认得**的全部模型（内置 + 配置里声明的），这是唯一可信的模型来源。 */
  models: z.array(z.string()),
  /**
   * 宿主为各模型报出的推理档位，按模型 id 索引。
   *
   * 可选：老宿主不报这个字段时界面只有手填。它和 `models` 是两回事，
   * 模型清单的读写与镜像逻辑不受影响。
   */
  modelThinking: z.array(modelThinkingSchema).optional(),
  modelCapabilities: z.array(z.object({
    id: z.string(),
    contextWindowMaxTokens: z.number().positive().optional(),
    thinkingOptions: z.array(thinkingOptionSchema).optional(),
  })).optional(),
  /** 配置里自己声明的模型 id（`models` 或 `additionalModels` 里的）。 */
  configModels: z.array(z.string()),
  /** 声明放在哪把键上：`models` = 替换内置列表，`additionalModels` = 追加。 */
  modelsKey: z.enum(["models", "additionalModels"]),
  /** 派生客户端的基座（宿主用 `extends` 建出来的独立条目）；不是派生条目为 null。 */
  extends: z.string().nullable(),
  /** 接入地址原值（不是机密，界面直接显示）。 */
  baseUrl: z.string().nullable(),
  /** 装凭据的键名，值永远掩码。 */
  credentialKeys: z.array(z.string()),
  /**
   * `display` 是要印出来的字，`masked` 说它是不是掩码。
   * 模型类的键（`ANTHROPIC_*_MODEL`）且值就是模型 id 时明文直出——模型名本来
   * 就印在宿主模型列表里；其余仍然只有掩码，明文要靠逐键「显示」单独取。
   */
  env: z.array(z.object({ key: z.string(), display: z.string(), masked: z.boolean(), hasValue: z.boolean() })),
});

/** 客户端下的一条站点（凭证只到掩码这一层）。 */
export const siteRowSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  baseUrl: z.string(),
  credentialMasked: z.string(),
  hasCredential: z.boolean(),
  updatedAt: z.string().nullable(),
});

/** 状态页里的客户端行：比配置里那一份多带站点表与「现在生效的是哪条」。 */
export const providerStateRowSchema = providerRowSchema.extend({
  sites: z.array(siteRowSchema),
  enabledSiteId: z.string().nullable(),
});

export const scopeSchema = z.object({
  workspaceId: z.string().min(1).max(300),
  workspaceDir: z.string().min(1).max(4096),
});

/**
 * 阀门四：全停。
 *
 * 停手没有「暂停 / 挂起」这种可恢复态——只能撤掉正在等的权限、打断正在跑的一轮，
 * 可选归档。界面文案不要写成「暂停」。
 */
export const orchestrationStaffStopRpc = defineRpc({
  name: "deck.orchestration.staff-stop",
  input: scopeSchema.extend({
    /** 停手之后顺手归档。默认不归档：还能接着看它做到哪了。 */
    archive: z.boolean().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      stopped: z.number().int(),
      denied: z.number().int(),
      interrupted: z.number().int(),
      archived: z.number().int(),
      /** 逐条失败原因：一个会话失败不影响其它会话停手。 */
      failures: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid-workspace", "agents-failed"]),
      detail: z.string(),
    }),
  ]),
});

export const orchestrationStateRpc = defineRpc({
  name: "deck.orchestration.state",
  input: scopeSchema,
  output: z.union([
    z.object({
      ok: z.literal(true),
      workspaceId: z.string(),
      workspaceDir: z.string(),
      settings: orchestrationSettingsSchema,
      profiles: z.array(clientProfileSchema),
      routing: z.array(
        z.object({
          difficulty: difficultySchema,
          profileId: z.string().nullable(),
          target: clientTargetSchema.nullable(),
          resolved: routeResolutionSchema,
          /** 这一档没配路由时借用的是哪一档；一档都没配是 `default`（内置默认目标）。 */
          routeFrom: z.union([difficultySchema, z.literal("default")]).optional(),
        }),
      ),
      /**
       * 每个客户端带上它的站点表与「现在生效的是哪条」：
       * 启用 = 这个地址与凭证已经写进客户端自己的 env，不是插件另存的开关。
       */
      providers: z.array(providerStateRowSchema),
      agents: z.array(agentRowSchema),
      tree: z.array(treeNodeSchema),
      /** 缺会话身份的窗口（窗口关了自动消失）。 */
      identityGaps: z.array(identityGapSchema),
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid-workspace", "config-failed", "agents-failed"]),
      detail: z.string(),
    }),
  ]),
});

export const orchestrationSaveRpc = defineRpc({
  name: "deck.orchestration.save",
  input: z.object({
    workspaceDir: z.string().min(1).max(4096),
    /**
     * 这份设置属于哪个工作区。
     *
     * 由界面显式给：服务端不能从 `settings.roles` 反推——用户清空本工作区的角色后，
     * 剩下的另一个工作区 id 会被当成归属，这个工作区就再也派不出单。
     * 省略时服务端才退回「角色里唯一那个工作区」。
     */
    workspaceId: z.string().min(1).max(300).optional(),
    settings: z.unknown(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      settings: orchestrationSettingsSchema,
      path: z.string(),
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid", "write-failed"]),
      detail: z.string(),
    }),
  ]),
});

export const orchestrationProviderRpc = defineRpc({
  name: "deck.orchestration.provider",
  input: z.object({
    provider: z.string().min(1).max(120),
    /** 工作区目录：保存模型时从它的 `.deck/` 读接口窗口缓存。 */
    workspaceDir: z.string().min(1).max(4096).optional(),
    /**
     * 只支持「新增/修改某个键」。
     * 宿主的配置补丁是深合并：`undefined` 跳过、`null` 会被写成 null，
     * 两者都不能真正删掉一个 env 键，所以这里不接受删除，删键要改配置文件。
     */
    env: z.record(z.string().max(200), z.string().max(20_000)).optional(),
    enabled: z.boolean().optional(),
    /** 显示名（宿主 `label`）。 */
    label: z.string().max(120).optional(),
    /**
     * 这个客户端声明的**完整**模型清单（替换语义，不是追加）：
     * 传进来的集合就是写完之后的样子，没列在里面的会被删掉。
     * 落在宿主的 `models`（替换内置）或 `additionalModels`（追加内置）上，由服务端按现存配置决定。
     */
    models: z.array(z.string().max(200)).max(200).optional(),
    modelDefinitions: z.array(z.object({
      id: z.string().max(200),
      label: z.string().max(200),
      description: z.string().max(2000).optional(),
      contextWindowMaxTokens: z.number().positive().optional(),
      defaultThinkingOptionId: z.string().max(120).optional(),
      thinkingOptions: z.array(z.object({
        id: z.string().max(120), label: z.string().max(200),
        description: z.string().max(1000).optional(), isDefault: z.boolean().optional(),
      })).max(100).optional(),
    })).max(200).optional(),
  }),
  output: z.union([
    z.object({ ok: z.literal(true), provider: z.string(), applied: z.array(z.string()), warnings: z.array(z.string()) }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid", "config-failed", "not-supported"]),
      detail: z.string(),
    }),
  ]),
});

/**
 * 客户端档案（宿主 `daemon.agentProfiles`）的增改删。
 *
 * 只改数组本身：读全量 → 替换目标条目 → 整表写回。`notes` 是给编排 agent 读的说明，
 * 写清楚「什么时候用这个客户端」，比名字更重要。
 */
export const orchestrationProfileRpc = defineRpc({
  name: "deck.orchestration.profile",
  input: z.object({
    profile: z
      .object({
        id: z.string().min(1).max(200).optional(),
        name: z.string().min(1).max(120),
        provider: z.string().min(1).max(120),
        model: z.string().max(200).optional(),
        modeId: z.string().max(200).optional(),
        thinkingOptionId: z.string().max(200).optional(),
        notes: z.string().max(2000).optional(),
      })
      .optional(),
    /** 按 id 删一条；与 `profile` 二选一。 */
    removeId: z.string().min(1).max(200).optional(),
  }),
  output: z.union([
    z.object({ ok: z.literal(true), profiles: z.array(clientProfileSchema), warnings: z.array(z.string()) }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid", "config-failed", "not-found"]),
      detail: z.string(),
    }),
  ]),
});

/**
 * 装客户端：`npm install -g <pkg>`。
 *
 * 只有 `shared/provider-install.ts#INSTALL_RECIPES` 里那几家能装；其余一律 `no-recipe`。
 * 这是**真的会改这台机器**的动作，所以界面上必须点两次（确认后）才发出来。
 */
export const orchestrationProviderInstallRpc = defineRpc({
  name: "deck.orchestration.provider.install",
  input: z.object({ provider: z.string().min(1).max(120) }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      provider: z.string(),
      packageName: z.string(),
      command: z.string(),
      durationMs: z.number(),
      /** 输出尾部（已去色），可能为空。 */
      output: z.string(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid", "no-recipe", "busy", "failed"]),
      detail: z.string(),
      output: z.string().optional(),
    }),
  ]),
});

/**
 * 看某一个注入键的**原值**。
 *
 * 默认只有掩码，这是用户显式点「显示」才发出的一次请求：一次只回一个键，
 * 值不进日志、不进状态快照。
 */
export const orchestrationProviderRevealRpc = defineRpc({
  name: "deck.orchestration.provider.reveal",
  input: z.object({
    provider: z.string().min(1).max(120),
    key: z.string().min(1).max(200),
  }),
  output: z.union([
    z.object({ ok: z.literal(true), provider: z.string(), key: z.string(), value: z.string() }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid", "not-found", "config-failed"]),
      detail: z.string(),
    }),
  ]),
});

/**
 * 宿主的 provider 诊断原文（解析到的路径、版本、PATH、which 结果）。
 *
 * 「装了没有」由 provider 快照的 `status` 回答，这里回答的是「为什么」。
 * 文本来自宿主，只做长度截断，不改写。
 */
export const orchestrationProviderDiagnosticRpc = defineRpc({
  name: "deck.orchestration.provider.diagnostic",
  input: z.object({ provider: z.string().min(1).max(120) }),
  output: z.union([
    z.object({ ok: z.literal(true), provider: z.string(), diagnostic: z.string() }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid", "empty", "failed"]),
      detail: z.string(),
    }),
  ]),
});

/**
 * 客户端下的站点：加 / 改 / 删 / 启用。
 *
 * 「启用」真的会写宿主配置（`agents.providers.<client>.env`）：这个客户端的**新会话**
 * 都会走这条地址与凭证，已开的会话不追溯。所以界面上必须有明确的启用动作，
 * 而不是配完就自动生效。
 */
export const orchestrationSiteRpc = defineRpc({
  name: "deck.orchestration.site",
  input: z.object({
    provider: z.string().min(1).max(120),
    /** 工作区目录：启用站点重建 Codex 目录时读这里的接口窗口缓存。 */
    workspaceDir: z.string().min(1).max(4096).optional(),
    /** 加或改一条；`credential` 省略/留空 = 沿用这条站点已存的那份。 */
    site: z
      .object({
        id: z.string().min(1).max(64),
        label: z.string().max(120).optional(),
        baseUrl: z.string().min(1).max(2000),
        credential: z.string().max(20_000).optional(),
      })
      .optional(),
    /** 按 id 删一条。删站不改宿主配置。 */
    removeId: z.string().min(1).max(64).optional(),
    /** 启用这条：把它的地址与凭证写进客户端自己的 env。 */
    enableId: z.string().min(1).max(64).optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      provider: z.string(),
      sites: z.array(siteRowSchema),
      enabledSiteId: z.string().nullable(),
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid", "not-found", "config-failed", "write-failed"]),
      detail: z.string(),
    }),
  ]),
});

const dispatchTaskSchema = z.object({
  key: z.string().min(1).max(300),
  title: z.string().max(500).optional(),
  prompt: z.string().min(1).max(100_000),
  difficulty: difficultySchema.optional(),
  /** 这条任务替哪张地图干活；不传就看批次上的 `map`。 */
  map: z.string().max(300).optional(),
  /** 派给名册里的哪张卡；名册非空时必填（没写就拒，不猜一个人）。 */
  staff: z.string().max(MAX_STAFF_ID_CHARS).optional(),
  /** 这条任务落在哪个仓库；多仓库工作区必填，单仓库不填。 */
  repoKey: z.string().max(200).optional(),
  /**
   * 这条任务替哪张需求干活；执行层据此过链条 / 验收票闸。
   * 不给的话，直接走 RPC 派单就绕过了 `deck_dispatch_plan` 已经在做的检查。
   */
  requirementKey: z.number().int().min(1).optional(),
  /** 需求所在的仓库；多仓库工作区里读需求正文、验收票都要用它。 */
  requirementRepoKey: z.string().max(200).optional(),
  /** 这条活落在哪片：仓库 + 路径前缀。`staff` 没给时按它算归属。 */
  region: z
    .object({
      repoKey: z.string().min(1).max(200).optional(),
      pathPrefix: z.string().max(MAX_STAFF_PATH_CHARS).optional(),
    })
    .optional(),
});

/** 这条任务落成的那张票。会话是进程，票才是这件事留下的凭证。 */
const dispatchTicketRefSchema = z.object({
  number: z.number(),
  url: z.string(),
  repoKey: z.string(),
});

const dispatchOutcomeSchema = z.union([
  z.object({
    key: z.string(),
    ok: z.literal(true),
    agentId: z.string(),
    title: z.string().nullable(),
    providerSpec: z.string(),
    difficulty: difficultySchema,
    partial: z.boolean(),
    failureDetail: z.string().nullable(),
    ticket: dispatchTicketRefSchema.nullable(),
    /** 票建好了但附带写入没成（标签 / 父票）：票是真的，这些要人补。 */
    ticketNotes: z.array(z.string()),
  }),
  z.object({
    key: z.string(),
    ok: z.literal(false),
    /**
     * `ticket-failed`：票没建成，这条活不派（没票就等于没记录）；
     * `create-failed`：票建好了，会话没建起来——`ticket` 里带着票号，别整批重派。
     */
    reason: z.enum([
      "unknown-workspace",
      "no-dispatcher",
      "depth-exceeded",
      "too-many-children",
      "empty-prompt",
      "duplicate-key",
      "route-unavailable",
      "map-budget-exhausted",
      "unknown-staff",
      "min-concurrent-staff",
      "repo-required",
      "invalid-region",
      "region-required",
      "region-unowned",
      "create-failed",
      "ticket-failed",
      /** E 票门：无票 / 读不出 / 没定稿，逐条拒，不进计划也不占并发。 */
      "no-requirement",
      "requirement-unreadable",
      "requirement-not-finalized",
    ]),
    detail: z.string(),
    ticket: dispatchTicketRefSchema.nullable().optional(),
  }),
]);

export const orchestrationDispatchRpc = defineRpc({
  name: "deck.orchestration.dispatch",
  input: z.object({
    workspaceId: z.string().min(1).max(300),
    workspaceDir: z.string().min(1).max(4096),
    tasks: z.array(dispatchTaskSchema).min(1).max(24),
    /** 这一批默认替哪张地图干活；逐条任务可以用 `map` 覆盖。有预算的地图靠它数人。 */
    map: z.string().max(300).optional(),
    /**
     * **这次派出的子会话**所在的层数；主窗口直接派 = 1。
     *
     * 与 MCP 工具 `deck_dispatch_plan` 的参数不是一回事：那边收的是**调用者自己**的层数（主窗口 = 0）。
     * 两处都换算成「子会话在第几层」再判定上限。
     */
    depth: z.number().int().min(1).max(6).optional(),
    dispatchId: z.string().max(200).optional(),
    /** 真正在派单的那个会话；给了就用它写标签与抬头，缺省用绑定的派单窗口。 */
    callerAgentId: z.string().max(300).optional(),
    /** 抬头文案用哪种语言；缺省中文。 */
    lang: z.enum(["zh", "en"]).optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      dispatchId: z.string(),
      dispatcherAgentId: z.string(),
      results: z.array(dispatchOutcomeSchema),
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      /**
       * `depth-exceeded`：调用方报的层数已经超过 `maxDepth`，不夹到上限硬派。
       * `unknown-workspace`：这个工作区一条角色绑定都没有；`no-dispatcher`：绑了但没选派单窗口；
       * `settings-unreadable`：编排文件读不出来（权限 / IO），不是「没配过」；
       * `settings-corrupt`：文件能读但解析失败，回落默认值等于「没有任何角色」，不能拿它派单。
       */
      reason: z.enum([
        "unknown-workspace",
        "no-dispatcher",
        "depth-exceeded",
        "invalid-workspace",
        "settings-unreadable",
        "settings-corrupt",
        // 入口门：带身份的派单只认绑定的派单窗口；主窗口 / 需求窗口 / 进度窗口 / 其他会话各有原因。
        "caller-unknown",
        "no-workspace",
        "main-cannot-dispatch",
        "requirement-cannot-dispatch",
        "progress-cannot-dispatch",
        "caller-not-dispatcher",
      ]),
      detail: z.string(),
    }),
  ]),
});

/** 需求拆票清单的一行：哪个区、派给谁、用什么客户端、开几个会话。 */
const requirementDispatchSummaryRowSchema = z.object({
  kind: z.enum(["work", "research"]),
  workspaceId: z.string(),
  area: z.string(),
  repoKey: z.string().nullable(),
  pathPrefix: z.string().nullable(),
  staffId: z.string().nullable(),
  staffName: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  providerSpec: z.string().nullable(),
  sessions: z.number().int(),
});

/**
 * 需求 → 每区一张票 + 每区一批派单。
 *
 * `confirm !== true` 且工作区设置要求先确认时只回清单（`created:false`），不写任何东西；
 * `confirm === true` 覆盖设置直接铺，设置里 `confirmRequirementSplit=false` 时也一样。
 */
export const orchestrationRequirementDispatchRpc = defineRpc({
  name: "deck.orchestration.requirement-dispatch",
  input: z.object({
    workspaceId: z.string().min(1).max(300),
    workspaceDir: z.string().min(1).max(4096),
    requirementNumber: z.number().int().min(0),
    requirementRepoKey: z.string().max(200).optional(),
    confirm: z.boolean().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      created: z.boolean(),
      requiresConfirmation: z.boolean(),
      summary: z.array(requirementDispatchSummaryRowSchema),
      /** 完整计划：票面 / 任务 / 拒绝原因。界面按需展开，不在这里再抄一份形状。 */
      plan: z.unknown(),
      batches: z.array(z.unknown()),
      research: z.array(z.unknown()),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum([
        "no-requirement",
        "bad-impact",
        "missing-impact",
        "unknown-workspace",
        "not-finalized",
        "empty-impact",
        "no-workspace",
        "settings-unreadable",
        "settings-corrupt",
        "no-dispatcher",
        /** 名册里有卡没写领地：整批拒绝，detail 点名张数与卡名。 */
        "staff-territory-missing",
      ]),
      detail: z.string(),
    }),
  ]),
});

export type OrchestrationSettingsWire = z.infer<typeof orchestrationSettingsSchema>;
export type DispatchOutcomeWire = z.infer<typeof dispatchOutcomeSchema>;
export type ProviderRowWire = z.infer<typeof providerRowSchema>;

/**
 * 问接口要模型清单（`GET {base}/v1/models`）。
 *
 * 用配置里已注入的 base url 与凭据去问，凭据只进请求头：既不出现在入参里，
 * 也不回给客户端，日志只记 provider / 路径 / 条数。
 */
export const orchestrationProviderModelsRpc = defineRpc({
  name: "deck.orchestration.provider.models",
  input: z.object({
    provider: z.string().min(1).max(120),
    /** 工作区目录：拉到的窗口缓存在它的 `.deck/` 下，保存模型与重载后再取。 */
    workspaceDir: z.string().min(1).max(4096).optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      provider: z.string(),
      /** 真正成功的那个地址，出问题时能说清是哪个端点答的。 */
      endpoint: z.string(),
      /** 接口窗口没缓存成功时的告警；清单本身可用。 */
      cacheWarning: z.string().optional(),
      models: z.array(z.object({
        id: z.string().max(200), label: z.string().max(200),
        description: z.string().max(2000).optional(),
        contextWindowMaxTokens: z.number().positive().optional(),
        defaultThinkingOptionId: z.string().max(120).optional(),
        thinkingOptions: z.array(z.object({
          id: z.string().max(120), label: z.string().max(200),
          description: z.string().max(1000).optional(), isDefault: z.boolean().optional(),
        })).max(100).optional(),
      })).max(500),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum([
        "invalid",
        "config-failed",
        "no-endpoint",
        "no-credential",
        "unauthorized",
        "http",
        "network",
        "bad-payload",
      ]),
      detail: z.string(),
    }),
  ]),
});

/**
 * 刷新结果的上限。
 *
 * 输出要过 `output.parseAsync`：宿主报一条超长模型 id，整包校验就会失败，
 * 一次已经成功的刷新会被报成错误。所以上限由这里定义，服务端按同一组数
 * 截断后再返回，而不是让契约去拒收。
 */
export const PROVIDER_MODEL_ID_MAX = 200;
export const PROVIDER_MODELS_MAX = 2000;

export const providerModelListSchema = z.object({
  id: z.string(),
  models: z.array(z.string().max(PROVIDER_MODEL_ID_MAX)).max(PROVIDER_MODELS_MAX),
  modelCapabilities: z.array(z.object({
    id: z.string().max(PROVIDER_MODEL_ID_MAX),
    contextWindowMaxTokens: z.number().positive().optional(),
    thinkingOptions: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  })).max(PROVIDER_MODELS_MAX).optional(),
});

/** 刷新后一个客户端与它的模型 id。 */
export type ProviderModelList = z.infer<typeof providerModelListSchema>;

/**
 * 让宿主重读 provider 快照。
 *
 * 模型清单是宿主按工作区缓存的：改完注入地址或模型列表后，宿主的模型选择器
 * 还停在旧快照上。这里发一次 `providers.refresh` 再回读快照，界面与宿主
 * 拿到的都是刷新后的清单。只动缓存：不重启 App，也不碰已经在跑的会话。
 */
export const orchestrationProviderRefreshRpc = defineRpc({
  name: "deck.orchestration.provider.refresh",
  input: z.object({
    workspaceDir: z.string().min(1).max(4096),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      workspaceDir: z.string(),
      /** 刷新后宿主报出的客户端与它的模型 id（停用的客户端不在内）。 */
      providers: z.array(providerModelListSchema),
      /** 刷新成功但要说清的事，例如某个客户端的目录读取失败。 */
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid", "refresh-failed", "snapshot-failed"]),
      detail: z.string(),
    }),
  ]),
});

/**
 * 已归档会话的一行。
 *
 * 归档是宿主的软删除：记录与 provider 侧的会话都还在，只是不再出现在默认会话列表里。
 * 宿主**没有**「取消归档」的接口（协议里只有 `archive_agent_request`），所以恢复只能
 * 把那条 provider 会话重新 import 回来——这一行因此必须同时带上会话 id 和一条
 * 能直接粘进终端的命令，光有一个内部 agent id 用户什么也做不了。
 */
export const archivedAgentRowSchema = agentRowSchema.omit({ parentAgentId: true }).extend({
  cwd: z.string().nullable(),
  archivedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** provider 那侧的会话 id：`paseo import` 要的就是它。 */
  sessionId: z.string().nullable(),
  /** 能直接粘进终端的恢复命令；缺会话 id / 客户端 / 目录时为 null。 */
  restoreCommand: z.string().nullable(),
  /** 为什么给不出恢复命令；能给出命令时为 null。 */
  restoreBlocked: z.string().nullable(),
  /** 宿主的客户端目录里已经找不到这个 provider（卸载了 / 停用了）。 */
  providerUnavailable: z.boolean(),
});

export type ArchivedAgentRow = z.infer<typeof archivedAgentRowSchema>;

/**
 * 已归档会话清单。
 *
 * 单独一个 RPC 而不是塞进 `state`：这份清单要翻宿主的存档（`includeArchived`），
 * 比状态重，且只在用户打开「已归档」页签时才需要。
 *
 * 一次调用最多翻几页（见 `server/archived-agents.ts` 的 `MAX_PAGES`），翻不完就给回
 * `nextCursor`：宿主的归档是跨全部工作区的，本工作区的记录可能排得很后面，
 * 光有一句「没读完」而没有继续往前的路，用户要查的那个 id 就永远查不到。
 */
export const orchestrationArchivedRpc = defineRpc({
  name: "deck.orchestration.archived",
  input: scopeSchema.extend({
    /** 从哪一批之后继续往前读；省略表示从最新的一条开始。 */
    cursor: z.string().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      workspaceId: z.string(),
      workspaceDir: z.string(),
      rows: z.array(archivedAgentRowSchema),
      /** 宿主那边还有更多没读完：界面要说清楚别让人以为全在这儿。 */
      truncated: z.boolean(),
      /** 继续往前读的游标；没有更早的记录（或宿主给不出游标）时为 null。 */
      nextCursor: z.string().nullable(),
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid-workspace", "agents-failed"]),
      detail: z.string(),
    }),
  ]),
});

/* ---------------------------------------------------------------- 协调收件箱 */

/**
 * 协调收件箱：`.deck/coordination.jsonl` 的线上形状。
 *
 * 客户端没有文件系统访问，收件箱必须由 RPC 吐出来；`index` 是它在文件里的行下标，
 * 后续「批准 / 转派 / 不派」都拿这个下标指记录（写请求不能由客户端直接落盘）。
 */
export const coordinationKindSchema = z.enum(["territory", "staffing", "contract", "lineage"]);

export const coordinationStateSchema = z.enum([
  "pending",
  "approved-once",
  "consumed",
  "reassigned",
  "denied",
  "staffed",
  "declined",
  "contract-changed",
  "impl-changed",
  "superseded",
  "cancelled",
  "recorded",
]);

/**
 * 收件箱上的动作。允许的组合由服务端按 kind 校验：
 * territory 只认前三个，staffing 只认 staff / decline，contract 只认后两个。
 */
export const coordinationActionSchema = z.enum([
  "approve-once",
  "reassign",
  "deny",
  "staff",
  "decline",
  "contract-changed",
  "impl-changed",
]);

export type CoordinationActionWire = z.infer<typeof coordinationActionSchema>;

export const coordinationRecordWireSchema = z.object({
  at: z.string(),
  kind: coordinationKindSchema,
  state: coordinationStateSchema,
  fromStaff: z.string(),
  toStaff: z.string().nullable(),
  paths: z.array(z.string()),
  sessionAgentId: z.string(),
  taskSummary: z.string(),
  /** 仅 staffing：要什么人、为什么。 */
  need: z.string().optional(),
  /** 仅 contract：哪一条字段 / 路由对不上。 */
  field: z.string().optional(),
});

export const coordinationInboxRowSchema = coordinationRecordWireSchema.extend({
  /** 记录在文件里的下标；动作 RPC 用它定位。 */
  index: z.number().int().min(0),
  /** 这次读取时因超过 24 小时被自动取消的那条（不是历史上所有 cancelled）。 */
  expired: z.boolean().optional(),
});

export type CoordinationInboxRowWire = z.infer<typeof coordinationInboxRowSchema>;

export const orchestrationInboxRpc = defineRpc({
  name: "deck.orchestration.inbox",
  input: scopeSchema,
  output: z.union([
    z.object({
      ok: z.literal(true),
      records: z.array(coordinationInboxRowSchema),
      /** 坏行数、自动取消条数这类「读到了但要说清」的事。 */
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["invalid-workspace", "read-failed", "sweep-failed"]),
      detail: z.string(),
    }),
  ]),
});

export const orchestrationInboxActRpc = defineRpc({
  name: "deck.orchestration.inbox.act",
  input: scopeSchema.extend({
    /** 收件箱里那条记录的下标（见 `deck.orchestration.inbox` 的 `index`）。 */
    index: z.number().int().min(0),
    action: coordinationActionSchema,
    /** 仅 territory 的 reassign：转给名册里的哪张卡；不传就沿用记录上的目标。 */
    toStaff: z.string().max(MAX_STAFF_ID_CHARS).optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      record: coordinationRecordWireSchema,
      warnings: z.array(z.string()),
    }),
    z.object({
      ok: z.literal(false),
      /**
       * `invalid-action`：kind 与动作不匹配（例如 staffing 点「批准一次」）；
       * `invalid-state`：状态机不允许（例如已处置过的记录再点一次）；
       * `action-failed` / `write-failed`：状态机拒绝或写盘失败，`detail` 是原话。
       */
      reason: z.enum([
        "invalid-workspace",
        "invalid-action",
        "invalid-state",
        "not-found",
        "read-failed",
        "sweep-failed",
        "write-failed",
        "action-failed",
      ]),
      detail: z.string(),
    }),
  ]),
});

/**
 * 建窗口的失败原因。
 *
 * 服务端从这里派生自己的联合类型，免得两边各写一份枚举、加一项时漏改一边。
 */
export const WINDOW_FAILURE_REASONS = [
  "invalid-workspace",
  "settings-unreadable",
  "settings-corrupt",
  "route-unavailable",
  "create-failed",
  "write-failed",
] as const;

export type WindowFailureReason = (typeof WINDOW_FAILURE_REASONS)[number];

/**
 * 按角色的身份提示词建一个固定窗口。
 *
 * 客户端/模型跟 **normal 档路由**走，不新增配置项；会话建出来停在 idle，
 * **不附带首条提示词**——窗口是给人开口的地方，不是一建就自己干活。
 *
 * 宿主目前没有「这个客户端不支持 systemPrompt」这类回执（协议的创建快照里没有该字段），
 * 所以建窗口不会假装提醒过；能不能生效只能靠会话里的实际表现判断。
 */
export const orchestrationWindowRpc = defineRpc({
  name: "deck.orchestration.window",
  input: z.object({
    workspaceDir: z.string().min(1).max(4096),
    workspaceId: z.string().min(1).max(300),
    /** 四个固定窗口之一；不认识的 role 在 schema 这一层就拒掉。 */
    role: z.enum(FIXED_ROLE_NAMES),
    /** true：建好新窗口之后再归档旧的（建失败则旧窗口原样留着）。缺省 false，只建不归档。 */
    recreate: z.boolean().optional(),
    /** 身份提示词用哪种语言；缺省中文。窗口标题固定中文，不随它变。 */
    lang: z.enum(ROLE_LANGS).optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      agentId: z.string(),
      title: z.string(),
      /** 这个槽位原来绑的会话；没有旧会话时为 null。 */
      previousAgentId: z.string().nullable(),
    }),
    z.object({
      ok: z.literal(false),
      /**
       * `settings-unreadable` / `settings-corrupt`：编排文件读不出来或坏了，
       * 不是「没配过」，不能拿默认值去建窗口；
       * `route-unavailable`：normal 这一档没有可用客户端；
       * `create-failed`：宿主要么拒绝建、要么拒绝无提示词的创建；
       * `write-failed`：会话建好了但槽位没写回去，`detail` 里带着新 id。
       */
      reason: z.enum(WINDOW_FAILURE_REASONS),
      detail: z.string(),
    }),
  ]),
});
