import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { workspaceTemplatesRpc } from "../../shared/repo.ts";
import { PROJECT_CONFIG_FILE } from "../../shared/workspace-projects.ts";
import { planWorkspaceTemplates, writeIssueTemplates } from "../workspace/templates.ts";
import { readWorkspaceConfig } from "../tracker/workspace-repo.ts";
import { record } from "../logs.ts";

/**
 * 补齐各项目仓库的 issue 模板。
 *
 * 只认 v2 清单：模板种类是按「这个项目有哪些 area、什么角色」推出来的，v1 只有一个
 * 目录、没有这些信息，拿它来写模板等于给所有仓库塞同一份。
 *
 * 预览与执行共用 `planWorkspaceTemplates`：两张数字必须对得上，否则人点「补齐」之后
 * 看到的和刚才预览的不是一回事。
 */

type TemplatesInput = RpcInput<typeof workspaceTemplatesRpc>;

export async function workspaceTemplatesHandler(
  input: TemplatesInput,
): Promise<RpcOutput<typeof workspaceTemplatesRpc>> {
  const read = await readWorkspaceConfig(input.workspaceDir);
  if (!read.ok) {
    if (read.reason === "missing") {
      return {
        ok: false,
        reason: "no-config",
        detail: `工作区里没有 ${PROJECT_CONFIG_FILE}：先写好 v2 项目清单，再按项目补模板`,
      };
    }
    return { ok: false, reason: "invalid", detail: `读 ${PROJECT_CONFIG_FILE} 失败：${read.detail}` };
  }
  if (read.config.version !== 2) {
    return {
      ok: false,
      reason: "v1",
      detail: `${PROJECT_CONFIG_FILE} 是单项目 v1（只有 repoDir）：模板要按项目清单里的 owner 与 areas 选，先把清单写成 v2`,
    };
  }
  if (read.config.projects.length === 0) {
    return { ok: false, reason: "no-projects", detail: `${PROJECT_CONFIG_FILE} 的 projects 是空的` };
  }

  const plans = planWorkspaceTemplates(input.workspaceDir, read.config.projects);
  const projects = plans.map((plan) => ({
    key: plan.projectKey,
    kinds: plan.kinds.map((kind) => String(kind)),
    write: plan.write.length,
    present: plan.present.length,
    conflicts: plan.conflicts.length,
    notes: plan.notes,
  }));
  const planNotes = [...read.config.warnings, ...plans.flatMap((plan) => plan.notes)];

  if (!input.apply) {
    return {
      ok: true,
      projects,
      written: [],
      present: plans.flatMap((plan) => plan.present.map((row) => row.path)),
      conflicts: plans.flatMap((plan) => plan.conflicts.map((row) => row.path)),
      failed: [],
      notes: planNotes,
    };
  }

  const outcome = await writeIssueTemplates(input.workspaceDir, read.config.projects);
  record(
    outcome.failed.length || outcome.conflicts.length ? "warn" : "info",
    "workspace.templates",
    `补齐 issue 模板：新建 ${outcome.written.length} 个，冲突 ${outcome.conflicts.length} 个，失败 ${outcome.failed.length} 个`,
  );
  return {
    ok: true,
    projects,
    written: outcome.written,
    present: plans.flatMap((plan) => plan.present.map((row) => row.path)),
    conflicts: outcome.conflicts,
    failed: outcome.failed,
    notes: planNotes,
  };
}
