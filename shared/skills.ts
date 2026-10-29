import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const langSchema = z.enum(["en", "zh"]);
const workspaceDirSchema = z.string().min(1);
const clientSchema = z.enum(["claude", "codex"]);
const stateSchema = z.enum(["none", "current", "differs"]);

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

export const skillsInstallRpc = defineRpc({
  name: "deck.skills.install",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    lang: langSchema,
    ids: z.array(z.string()).optional(),
    /** 覆盖内容不同的文件；缺省 false（冲突只报告）。 */
    overwrite: z.boolean().optional(),
  }),
  output: z.object({
    written: z.array(z.string()),
    skipped: z.array(z.string()),
    conflicts: z.array(z.string()),
    targets: z.array(z.string()),
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
