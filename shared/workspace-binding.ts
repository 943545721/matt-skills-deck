import { defineRpc, type RpcInput, type RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

export const workspaceBindingRpc = defineRpc({
  name: "deck.workspace.binding",
  input: z.object({ workspaceDir: z.string().min(1) }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      workspaceDir: z.string(),
      configured: z.enum(["auto", "github", "gitlab", "local"]),
      backend: z.enum(["github", "gitlab", "markdown", "none"]),
      source: z.enum(["explicit", "remote", "fallback", "none"]),
      state: z.enum(["decided", "undetermined", "no-backend"]),
      reason: z.string(),
    }),
    z.object({ ok: z.literal(false), detail: z.string() }),
  ]),
});

export type WorkspaceBinding = {
  workspaceDir: string;
  configured: "auto" | "github" | "gitlab" | "local";
  backend: "github" | "gitlab" | "markdown" | "none";
  source: "explicit" | "remote" | "fallback" | "none";
  state: "decided" | "undetermined" | "no-backend";
  reason: string;
};

export type WorkspaceBindingInput = RpcInput<typeof workspaceBindingRpc>;
export type WorkspaceBindingOutput = RpcOutput<typeof workspaceBindingRpc>;
