import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { labelsColorsRpc, labelsListRpc } from "../../shared/labels.ts";
import { listLabels, setLabelColors } from "../tracker/labels.ts";
import { requireGithubRepo } from "./repo-gate.ts";

type ListInput = RpcInput<typeof labelsListRpc>;
type ColorsInput = RpcInput<typeof labelsColorsRpc>;

export async function listLabelsHandler(input: ListInput): Promise<RpcOutput<typeof labelsListRpc>> {
  const gate = await requireGithubRepo(input.workspaceDir, "标签配色");
  if (!gate.ok) return gate;

  const result = await listLabels(gate.ref.owner, gate.ref.name);
  if (!result.ok) return result;
  return { ok: true, labels: result.labels };
}

export async function setLabelColorsHandler(input: ColorsInput): Promise<RpcOutput<typeof labelsColorsRpc>> {
  const gate = await requireGithubRepo(input.workspaceDir, "标签配色");
  if (!gate.ok) return gate;

  const result = await setLabelColors(gate.ref.owner, gate.ref.name, input.changes);
  if (!result.ok) return result;
  return { ok: true, applied: result.applied, failed: result.failed };
}
