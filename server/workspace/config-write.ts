import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_CONFIG_FILE, WORKSPACE_SHAPES, type WorkspaceShape } from "../../shared/workspace-projects.ts";
import { readWorkspaceConfig } from "../tracker/workspace-repo.ts";

/**
 * 把「这些项目就是这么放的」写进配置。
 *
 * 只做一件事：在 v2 清单里记下 `coordination.shape`。用户点「不再提示」之后，插件就该闭嘴——
 * 但也只记这一件事，不顺手改别的字段、不补项目、不动 v1 文件（v1 没有清单可依附）。
 *
 * 写之前先按读路径解析一遍：解析不了的配置不写，免得把一份坏文件覆盖成另一份坏文件。
 */

export type AcknowledgeResult =
  | { ok: true; shape: WorkspaceShape }
  | { ok: false; reason: "invalid" | "no-config" | "v1" | "write-failed"; detail: string };

export async function acknowledgeShape(workspaceDir: string, shape: WorkspaceShape): Promise<AcknowledgeResult> {
  if (!(WORKSPACE_SHAPES as readonly string[]).includes(shape)) {
    return { ok: false, reason: "invalid", detail: `只认 ${WORKSPACE_SHAPES.join(" / ")}，收到：${String(shape)}` };
  }

  const read = await readWorkspaceConfig(workspaceDir);
  if (!read.ok) {
    if (read.reason === "missing") {
      return {
        ok: false,
        reason: "no-config",
        detail: `还没有 ${PROJECT_CONFIG_FILE}：先写好项目清单，再记「这几个项目算一套」`,
      };
    }
    return { ok: false, reason: "invalid", detail: read.detail };
  }
  if (read.config.version !== 2) {
    return {
      ok: false,
      reason: "v1",
      detail: `${PROJECT_CONFIG_FILE} 还是 v1（只有一个 repoDir）：写成 v2 的项目清单之后，才能记下这层关系`,
    };
  }

  const file = path.join(workspaceDir, PROJECT_CONFIG_FILE);
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "invalid", detail: `${PROJECT_CONFIG_FILE} 不是一个对象` };
    }
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: "invalid", detail: `读 ${PROJECT_CONFIG_FILE} 失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const coordination = raw.coordination && typeof raw.coordination === "object" && !Array.isArray(raw.coordination)
    ? { ...(raw.coordination as Record<string, unknown>) }
    : {};
  const next = { ...raw, coordination: { ...coordination, shape } };

  try {
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: "write-failed",
      detail: `写 ${PROJECT_CONFIG_FILE} 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, shape };
}
