import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const langSchema = z.enum(["en", "zh"]);
const workspaceDirSchema = z.string().min(1);

/**
 * 技能相关契约。
 *
 * 工作区目录由客户端传入（面板本来就拿得到 workspace 快照），而不是让服务端按 sessionId 反查——
 * Paseo 的 RPC 处理器没有会话上下文，硬要反查会多一条只有 DSH 才需要的链路。
 */
export const skillsListRpc = defineRpc({
  name: "deck.skills.list",
  input: z.object({ workspaceDir: workspaceDirSchema, lang: langSchema }),
  output: z.object({
    skills: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        state: z.enum(["none", "current", "differs"]),
      }),
    ),
  }),
});

export const skillsInstallRpc = defineRpc({
  name: "deck.skills.install",
  input: z.object({
    workspaceDir: workspaceDirSchema,
    lang: langSchema,
    ids: z.array(z.string()).optional(),
  }),
  output: z.object({
    written: z.array(z.string()),
    skipped: z.array(z.string()),
    conflicts: z.array(z.string()),
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
