/**
 * 派单建票：把一条派单任务落成一张能看的票。
 *
 * 为什么票要在建会话之前：会话是进程，关掉就没了；票留得下「谁派的、第几层、
 * 什么难度、交给哪个客户端」。没有这张票，同一件事在板子上没有任何痕迹，
 * 换个窗口接手时只能靠人复述。
 *
 * 三条口径：
 * 1. 票面由 `shared/orchestration.ts` 的 `buildDispatchTicket` 生成，这里只负责写，
 *    所以 MCP 计划里给的票与这里真建出来的票是同一张。
 * 2. 写不进去就整条任务不派（调用方拿 `ok:false` 去拒绝这条任务），不做「会话建好了票算了」——
 *    那正是这次要修的病。
 * 3. 票建好之后附带写入（标签、父票）失败**不回滚、也不说成整票失败**：票是真的，
 *    这些缺口逐条放进 `notes`，由调用方报出去。
 */

import { buildDispatchTicket, type Difficulty, type DispatchTicketSpecInput } from "../../shared/orchestration.ts";
import { resolveWritableBackend } from "./backend.ts";
import { createGithubOperations } from "./github/operations.ts";
import { createGitLabIssue } from "./gitlab.ts";
import { createLocalIssue, resolveLocalStore } from "./local.ts";
import { syncLabels } from "./labels.ts";
import { record } from "../logs.ts";

export interface DispatchTicketInput extends DispatchTicketSpecInput {
  /**
   * 幂等锚：同一次派单重试不建第二张票。
   *
   * 只有远端后端认这个锚（`gh` / `glab` 都会先在正文里找 anchor 再建）；
   * 本地 `.deck/` 的票号是递增序号，没有锚存储，传了会被后端直接拒绝。
   */
  idempotencyKey?: string;
}

export interface DispatchTicketCreated {
  ok: true;
  number: number;
  url: string;
  repoKey: string;
  labels: string[];
  /** 票建好了但附带写入没成（标签 / 父票）：票是真的，这些要人补。 */
  notes: string[];
}

export interface DispatchTicketFailure {
  ok: false;
  detail: string;
}

/** 两个标签家族各自一种颜色：一眼能分出「这段是难度」还是「这段是客户端」。 */
function labelColorOf(name: string): string {
  if (name.startsWith("difficulty:")) return "c9a227";
  if (name.startsWith("client:")) return "57606a";
  return "8b949e";
}

/**
 * 本地后端是 `.deck` 还是 `.scratch`。
 *
 * 两种布局的能力不一样：`.scratch` 有票面字段（父票、幂等锚），`.deck` 没有。
 * 问不出来就返回 null，按「没有这些能力」处理——宁可少写一个字段并说出来，
 * 也不要传过去让后端把整笔建票拒掉。
 */
async function localLayoutOf(workspaceDir: string): Promise<"deck" | "scratch" | null> {
  try {
    const store = await resolveLocalStore(workspaceDir);
    return store.primary.kind === "scratch" ? "scratch" : "deck";
  } catch (error) {
    record("warn", "orchestration.ticket", `本地票目录读不出来，按 .deck 处理：${String(error)}`);
    return null;
  }
}

/**
 * 地图引用 → 父票号。
 *
 * 只有「没写仓库」或「写的就是这个仓库」才敢挂：GitHub 的父子边跨不了仓库，
 * 硬挂会把票塞到别的仓库的同号票下面，比不挂更难查。
 */
function parentNumberOf(map: string | undefined, repoKey: string): string | null {
  const raw = (map ?? "").trim().toLowerCase();
  const match = /^(?:([a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+))?#(\d{1,10})$/.exec(raw);
  if (!match) return null;
  const prefix = (match[1] ?? "").trim();
  if (prefix && prefix !== repoKey.trim().toLowerCase()) return null;
  return match[2] ?? null;
}

/**
 * 建这一张派单票。
 *
 * 后端按工作区的解析结果走（GitHub / GitLab / 本地），三条路的票面完全一样；
 * 差异只在能力上：本地 `.deck/` 没有父票与幂等锚，远端两者都有。
 */
export async function createDispatchTicket(
  workspaceDir: string,
  input: DispatchTicketInput,
): Promise<DispatchTicketCreated | DispatchTicketFailure> {
  const backend = await resolveWritableBackend(workspaceDir, "派单建票", input.repoKey);
  if (!backend.ok) return { ok: false, detail: backend.detail };

  const spec = buildDispatchTicket(input);
  // 需求父边优先于地图父边：一张派出去的票只该挂一个父。
  // 跨仓库不挂：GitHub / GitLab 的父子边跨不了仓库，硬挂会指到对方仓库的同号票。
  const requirementParent =
    input.requirement && (!input.requirement.repoKey || input.requirement.repoKey === backend.key)
      ? String(input.requirement.number)
      : null;
  const parent = requirementParent ?? parentNumberOf(input.map, backend.key);
  const notes: string[] = [];
  if (input.requirement && !requirementParent) {
    notes.push(
      `需求 #${input.requirement.number} 在另一个仓库（${input.requirement.repoKey ?? "未知"}）：父子边不能跨仓库，票面只留「需求：#${input.requirement.number}」`,
    );
  }
  // 本地 `.deck` 布局建票时拒收父票与幂等锚（后端会拒绝整笔），所以先问清是哪一种布局。
  const localLayout =
    backend.kind === "local" ? await localLayoutOf(backend.workspaceDir) : null;
  const supportsExtras = backend.kind !== "local" || localLayout === "scratch";
  const anchor = supportsExtras ? input.idempotencyKey : undefined;

  if (backend.kind === "github") {
    const ensured = await syncLabels(
      backend.ref.owner,
      backend.ref.name,
      spec.labels.map((name) => ({ name, color: labelColorOf(name), description: "deck 派单自动建的标签" })),
    );
    if (!ensured.ok) notes.push(`标签没建起来（票照建）：${ensured.detail}`);
    else if (ensured.failed.length) {
      notes.push(`标签没建起来（票照建）：${ensured.failed.map((item) => item.name).join("、")}`);
    }
    const created = await createGithubOperations().issueCreate(
      { owner: backend.ref.owner, name: backend.ref.name },
      {
        title: spec.title,
        body: spec.body,
        labels: spec.labels,
        ...(parent ? { parentKey: parent } : {}),
        ...(anchor ? { idempotencyKey: anchor } : {}),
      },
    );
    if (!created.ok) return { ok: false, detail: created.message };
    if (created.data.labelError) notes.push(created.data.labelError);
    if (created.data.parentError) notes.push(created.data.parentError);
    return {
      ok: true,
      number: created.data.issue.number,
      url: created.data.issue.url,
      repoKey: backend.key,
      labels: created.data.issue.labels.map((label) => label.name),
      notes,
    };
  }

  if (backend.kind === "gitlab") {
    // GitLab 建票时自动创建用到的标签，不用先建一遍。
    const created = await createGitLabIssue(backend.ref.owner, backend.ref.name, {
      title: spec.title,
      body: spec.body,
      labels: spec.labels,
      ...(parent ? { parentKey: Number(parent) } : {}),
      ...(anchor ? { idempotencyKey: anchor } : {}),
    });
    if (!created.ok) return { ok: false, detail: created.detail };
    if (created.labelsFailed) notes.push("标签没挂上（票已建好）");
    return { ok: true, number: created.number, url: created.url, repoKey: backend.key, labels: created.labels, notes };
  }

  const created = await createLocalIssue(backend.workspaceDir, {
    title: spec.title,
    body: spec.body,
    labels: spec.labels,
    ...(supportsExtras && parent ? { parentKey: parent } : {}),
    ...(anchor ? { idempotencyKey: anchor } : {}),
  });
  if (!created.ok) return { ok: false, detail: created.detail };
  if (created.labelsFailed) notes.push("标签没挂上（票已建好）");
  if (parent && !supportsExtras) {
    notes.push("本地 .deck 布局没有父子字段：这张票没挂到父票下面，需要有 .scratch 布局或远端后端才有这一跳");
  }
  if (input.idempotencyKey && !supportsExtras) {
    notes.push("本地 .deck 布局没有幂等锚：同一次派单重试会再建一张票");
  }
  return { ok: true, number: created.number, url: created.url, repoKey: backend.key, labels: created.labels, notes };
}

/** 一条派单建票的日志行：票号、难度、客户端都在里面，出事时不用翻会话。 */
export function recordDispatchTicket(created: DispatchTicketCreated, input: { difficulty: Difficulty; key: string }): void {
  record(
    "info",
    "orchestration.ticket",
    `派单建票 #${created.number}（任务 ${input.key}，难度 ${input.difficulty}，${created.labels.join("、") || "无标签"}）`,
  );
}
