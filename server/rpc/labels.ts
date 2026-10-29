import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { labelsColorsRpc, labelsListRpc } from "../../shared/labels.ts";
import { reconcileLabelColors } from "../../shared/labels.ts";
import { listLabels, setLabelColors } from "../tracker/labels.ts";
import { listGitLabLabels, setGitLabLabelColors } from "../tracker/gitlab.ts";
import { listLocalLabels, setLocalLabelColors } from "../tracker/local.ts";
import { resolveBackend, resolveWritableBackend } from "../tracker/backend.ts";
import { record } from "../logs.ts";

type ListInput = RpcInput<typeof labelsListRpc>;
type ColorsInput = RpcInput<typeof labelsColorsRpc>;

export async function listLabelsHandler(input: ListInput): Promise<RpcOutput<typeof labelsListRpc>> {
  const backend = await resolveBackend(input.workspaceDir, "标签配色", input.repoKey);
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
  // 改色是写操作：与其它 GitLab 写路径共用权限闸门，未知权限不放行。
  const backend = await resolveWritableBackend(input.workspaceDir, "标签配色", input.repoKey);
  if (!backend.ok) return backend;

  if (backend.kind === "gitlab") {
    const written = await setGitLabLabelColors(backend.ref.owner, backend.ref.name, input.changes);
    if (!written.ok) {
      record("error", "labels.colors", `GitLab 改色失败：${written.detail.slice(0, 200)}`);
      return written;
    }
    const failed = written.failed.map((item) => ({ name: item.name, detail: item.detail }));
    // 与 GitHub 同一条口径：PUT 成功只代表请求被接受，读回一致才算改好。
    if (!written.applied.length) {
      return { ok: true, applied: [], failed, verified: [], mismatched: [], readbackFailed: false };
    }
    const reread = await listGitLabLabels(backend.ref.owner, backend.ref.name);
    if (!reread.ok) {
      record("warn", "labels.colors", `GitLab 改色 ${written.applied.length} 个请求成功，但读回失败`);
      return { ok: true, applied: written.applied, failed, verified: [], mismatched: [], readbackFailed: true };
    }
    const { verified, mismatched } = reconcileLabelColors(written.applied, reread.labels);
    record(
      failed.length || mismatched.length ? "warn" : "info",
      "labels.colors",
      `GitLab 改色 ${written.applied.length} 个成功、${failed.length} 个失败、${verified.length} 个读回一致`,
    );
    return { ok: true, applied: written.applied, failed, verified, mismatched, readbackFailed: false };
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
