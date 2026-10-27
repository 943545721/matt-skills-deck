import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { labelsColorsRpc, labelsListRpc } from "../../shared/labels.ts";
import { listLabels, setLabelColors } from "../tracker/labels.ts";
import { listGitLabLabels } from "../tracker/gitlab.ts";
import { listLocalLabels, setLocalLabelColors } from "../tracker/local.ts";
import { resolveBackend } from "../tracker/backend.ts";
import { record } from "../logs.ts";

type ListInput = RpcInput<typeof labelsListRpc>;
type ColorsInput = RpcInput<typeof labelsColorsRpc>;

export async function listLabelsHandler(input: ListInput): Promise<RpcOutput<typeof labelsListRpc>> {
  const backend = await resolveBackend(input.workspaceDir, "标签配色");
  if (!backend.ok) return backend;

  if (backend.kind === "local") {
    const result = await listLocalLabels(backend.workspaceDir);
    if (!result.ok) return result;
    return { ok: true, labels: result.labels };
  }
  if (backend.kind === "gitlab") {
    const result = await listGitLabLabels(backend.ref.owner, backend.ref.name);
    if (!result.ok) return result;
    return { ok: true, labels: result.labels };
  }
  const result = await listLabels(backend.ref.owner, backend.ref.name);
  if (!result.ok) return result;
  return { ok: true, labels: result.labels };
}

export async function setLabelColorsHandler(input: ColorsInput): Promise<RpcOutput<typeof labelsColorsRpc>> {
  const backend = await resolveBackend(input.workspaceDir, "标签配色");
  if (!backend.ok) return backend;
  if (backend.kind === "gitlab") {
    return {
      ok: false,
      reason: "unsupported-host",
      detail: "GitLab 后端目前只读，改标签颜色还没有接；需要写入请切到 GitHub 或本地 Markdown",
    };
  }

  const result =
    backend.kind === "local"
      ? await setLocalLabelColors(backend.workspaceDir, input.changes)
      : await setLabelColors(backend.ref.owner, backend.ref.name, input.changes);
  if (!result.ok) {
    record("error", "labels.colors", `改色失败：${result.detail.slice(0, 200)}`);
    return result;
  }
  record(
    result.failed.length || result.mismatched.length || result.readbackFailed ? "warn" : "info",
    "labels.colors",
    `改色 ${result.applied.length} 个成功、${result.failed.length} 个失败、${result.verified.length} 个读回一致${
      result.readbackFailed ? "（读回失败，未确认）" : ""
    }`,
  );
  return {
    ok: true,
    applied: result.applied,
    failed: result.failed,
    verified: result.verified,
    mismatched: result.mismatched,
    readbackFailed: result.readbackFailed,
  };
}
