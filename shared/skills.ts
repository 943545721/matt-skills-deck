import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { SKILL_MODES } from "./workspace-projects.ts";

const langSchema = z.enum(["en", "zh"]);
const workspaceDirSchema = z.string().min(1);
const clientSchema = z.enum(["claude", "codex"]);
const stateSchema = z.enum(["none", "current", "differs"]);
const modeSchema = z.enum(SKILL_MODES);
/** 模式从哪儿来：项目自己的 `skillsMode`，还是跟随工作区设置。 */
const modeSourceSchema = z.enum(["project", "workspace"]);

/**
 * 一格（项目 × 客户端）的汇总状态。
 *
 * `none` 是「这个目录里一份插件技能都没有」——界面写「未安装」，不留空白；
 * `missing` 是「装了一部分，还有缺的」；`differs` 优先于 `missing`，因为它要人做决定。
 */
const cellStatusSchema = z.enum(["none", "current", "differs", "missing"]);

const matrixRowSchema = z.object({
  key: z.string(),
  /** 项目目录绝对路径（目录不在时是配置里算出来的那个路径）。 */
  dir: z.string(),
  exists: z.boolean(),
  problem: z.string().nullable(),
  mode: modeSchema,
  modeSource: modeSourceSchema,
  cells: z.array(
    z.object({
      client: clientSchema,
      /** 客户端目录绝对路径，界面直接显示，不自己拼。 */
      dir: z.string(),
      status: cellStatusSchema,
      total: z.number().int(),
      current: z.number().int(),
      differs: z.array(z.string()),
      missing: z.array(z.string()),
      /**
       * 这个技能目录会不会被 git 当成本项目的内容提交。
       *
       * `null` 表示判断不了（目录不在、不是 git 仓库、没装 git）。插件**从不**改各项目的
       * `.gitignore`：装技能会不会把一堆文件带进提交，是用户自己的仓库策略，这里只把事实摆出来。
       */
      ignored: z.boolean().nullable(),
    }),
  ),
});

const installCellSchema = z.object({
  client: clientSchema,
  dir: z.string(),
  written: z.array(z.string()),
  skipped: z.array(z.string()),
  conflicts: z.array(z.string()),
  /** 统一模式下清空的条目（技能目录名）；各自模式恒为空。 */
  cleared: z.array(z.string()),
});

const installProjectSchema = z.object({
  key: z.string(),
  dir: z.string(),
  mode: modeSchema,
  modeSource: modeSourceSchema,
  /** `skipped`：目录不在；`failed`：备份失败，整项停手、没清没写。 */
  status: z.enum(["ok", "skipped", "failed"]),
  reason: z.string().nullable(),
  /** 统一模式的备份目录；各自模式与没东西可备份时为 null。 */
  backupDir: z.string().nullable(),
  cells: z.array(installCellSchema),
});

/**
 * 技能相关契约。
 *
 * 装进**当前项目**：`<工作区>/.claude/skills` 与 `<工作区>/.agents/skills`，两个一起写——
 * 客户端各自只认自己那个名字，这是它们的硬要求，不是可选项。
 *
 * 工作区目录由客户端传入（面板本来就拿得到 workspace 快照），而不是让服务端按 sessionId 反查——
 * Paseo 的 RPC 处理器没有会话上下文，硬要反查会多一条只有 DSH 才需要的链路。
 *
 * 状态按客户端分开报：只显示、不出选择题。一个「已安装」标签说不清
 * 「Claude 读得到、Codex 读不到」，那样用户根本不知道要不要重装。
 */
export const skillsListRpc = defineRpc({
  name: "deck.skills.list",
  input: z.object({ workspaceDir: workspaceDirSchema, lang: langSchema }),
  output: z.object({
    skills: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        states: z.array(z.object({ client: clientSchema, state: stateSchema })),
      }),
    ),
    /** 项目里两个真实目录，界面直接显示，不写死字符串。 */
    roots: z.array(z.object({ client: clientSchema, dir: z.string() })),
    /**
     * 项目里自己写的技能（插件包里没有同 id 的）。
     * 单独列出来是为了能「回收」进插件包——否则这些技能只活在这一个项目里。
     */
    projectOnly: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        file: z.string(),
        /** 两个目录内容不同：回收会丢一份，界面要拦。 */
        split: z.boolean(),
      }),
    ),
    /**
     * 项目 × 客户端矩阵：一行一个项目，一格一个客户端目录。
     * 没有 v2 项目清单时只有一行（工作区根目录），与单项目时代一样。
     */
    workspaceMode: modeSchema,
    projects: z.array(matrixRowSchema),
    /** 清单读不出来、v1 回落这类「值得看一眼」的说明；不阻断。 */
    notes: z.array(z.string()),
  }),
});

/**
 * 回收：项目里的技能 → 插件包 `templates/skills/<lang>/<id>/`（主文件 + 附件整棵目录）。
 *
 * 与安装方向相反。`lang` 是正文语言：写进插件包的两个语言目录，另一侧会标成「待翻译」。
 */
export const skillsAdoptRpc = defineRpc({
  name: "deck.skills.adopt",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    lang: langSchema,
    id: z.string().min(1),
    overwrite: z.boolean().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      id: z.string(),
      written: z.array(z.string()),
      skipped: z.array(z.string()),
      conflicts: z.array(z.string()),
      pendingTranslation: z.array(langSchema),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["missing", "invalid", "split", "write-failed"]),
      detail: z.string(),
    }),
  ]),
});

/**
 * 安装 / 全部更新：一次落到工作区里的全部项目。
 *
 * 统一模式（项目自己写的 > 工作区设置 > 默认 per-project）先备份、再清空、再装；
 * 非统一模式只补缺失、不覆盖冲突、一个文件都不删。顶层 `written/skipped/conflicts/
 * targets` 是所有项目的并集（老界面与面板检查页只需这几个数），逐项目的明细在 `projects`。
 */
export const skillsInstallRpc = defineRpc({
  name: "deck.skills.install",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    lang: langSchema,
    ids: z.array(z.string()).optional(),
    /** 覆盖内容不同的文件；缺省 false（冲突只报告）。统一模式下清空已发生，等价于覆盖。 */
    overwrite: z.boolean().optional(),
  }),
  output: z.object({
    written: z.array(z.string()),
    skipped: z.array(z.string()),
    conflicts: z.array(z.string()),
    targets: z.array(z.string()),
    workspaceMode: modeSchema,
    projects: z.array(installProjectSchema),
    notes: z.array(z.string()),
  }),
});

export const skillsRemoveRpc = defineRpc({
  name: "deck.skills.remove",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    lang: langSchema,
    ids: z.array(z.string()).optional(),
  }),
  output: z.object({
    removed: z.array(z.string()),
    /** 内容与内置源不同，原样留着给人自己处理。 */
    kept: z.array(z.object({ id: z.string(), path: z.string() })),
    missing: z.array(z.string()),
    targets: z.array(z.string()),
  }),
});

export const skillsReadRpc = defineRpc({
  name: "deck.skills.read",
  input: z.object({ lang: langSchema, id: z.string() }),
  output: z.object({
    id: z.string(),
    description: z.string(),
    markdown: z.string(),
  }),
});
