import { getSettings } from "../settings.ts";
import { parseRemoteUrl, readRemoteUrl } from "../tracker/remote.ts";
import { resolveWorkspaceTargets } from "../tracker/targets.ts";
import type { WorkspaceBindingInput, WorkspaceBindingOutput } from "../../shared/workspace-binding.ts";

export async function workspaceBindingHandler(input: WorkspaceBindingInput): Promise<WorkspaceBindingOutput> {
  const configured = getSettings().backend;
  if (configured === "local") {
    return { ok: true, workspaceDir: input.workspaceDir, configured, backend: "markdown", source: "explicit", state: "decided", reason: "设置明确选择了本地 Markdown" };
  }
  const remote = await readRemoteUrl(input.workspaceDir);
  if (remote.ok) {
    const parsed = parseRemoteUrl(remote.url);
    const host = parsed?.host === "gitlab" || parsed?.host === "github" ? parsed.host : "none";
    if (host !== "none" && (configured === "auto" || configured === host)) {
      return { ok: true, workspaceDir: input.workspaceDir, configured, backend: host, source: configured === "auto" ? "remote" : "explicit", state: "decided", reason: configured === "auto" ? `由远端地址识别为 ${host}` : `设置明确选择了 ${host}` };
    }
    return { ok: true, workspaceDir: input.workspaceDir, configured, backend: "none", source: "none", state: "undetermined", reason: `远端地址与设置不匹配：${remote.url}` };
  }
  const resolved = await resolveWorkspaceTargets(input.workspaceDir);
  if (resolved.ok) {
    if (resolved.kind === "local") {
      return { ok: true, workspaceDir: input.workspaceDir, configured, backend: "markdown", source: "fallback", state: "decided", reason: "没有可用远端，自动回退到本地 Markdown" };
    }
    const hosts = [...new Set(resolved.targets.map((target) => target.host))];
    const backend: "github" | "gitlab" | "none" = hosts.length === 1 ? (hosts[0] ?? "none") : "none";
    return { ok: true, workspaceDir: input.workspaceDir, configured, backend, source: "remote", state: backend === "none" ? "undetermined" : "decided", reason: backend === "none" ? `发现多个不同类型的远端：${hosts.join("、")}` : `发现 ${resolved.targets.length} 个 ${backend} 仓库` };
  }
  return { ok: true, workspaceDir: input.workspaceDir, configured, backend: "none", source: "none", state: "no-backend", reason: resolved.detail };
}
