import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

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

export const orchestrationSettingsSchema = z.object({
  roles: z.array(
    z.object({
      workspaceId: z.string().min(1).max(300),
      mainAgentId: z.string().max(300).optional(),
      dispatcherAgentId: z.string().max(300).optional(),
    }),
  ),
  routing: z.array(routingRuleSchema),
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
  z.object({ ok: z.literal(false), reason: z.enum(["profile-missing", "no-target"]), detail: z.string() }),
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
    children: z.array(treeNodeSchema),
  }),
) as unknown as z.ZodType<TreeNodeWire>;

export const providerRowSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  enabled: z.boolean(),
  status: z.string(),
  /** 宿主**认得**的全部模型（内置 + 配置里声明的），这是唯一可信的模型来源。 */
  models: z.array(z.string()),
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
  }),
  z.object({
    key: z.string(),
    ok: z.literal(false),
    reason: z.enum([
      "unknown-workspace",
      "no-dispatcher",
      "depth-exceeded",
      "too-many-children",
      "empty-prompt",
      "duplicate-key",
      "route-unavailable",
      "map-budget-exhausted",
      "create-failed",
    ]),
    detail: z.string(),
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
  input: z.object({ provider: z.string().min(1).max(120) }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      provider: z.string(),
      /** 真正成功的那个地址，出问题时能说清是哪个端点答的。 */
      endpoint: z.string(),
      models: z.array(z.string().max(200)).max(500),
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
