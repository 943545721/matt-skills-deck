import type {
  PluginAgentCommandContext,
  PluginClientContext,
  PluginWorkspaceCommandContext,
} from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/ui";
import { buildActionPrompt } from "../../../shared/session.ts";
import { DECK_SLASH_COMMANDS, parseDeckSlash } from "../../../shared/slash.ts";
import type { DeckSlashCommand } from "../../../shared/slash.ts";
import { DECK_NEW_TICKET_ID, DECK_PANEL_ID } from "../ids.ts";
import { appendDeckCommand } from "../timeline/command.ts";
import type { DeckCommandAction, DeckCommandData } from "../timeline/command.ts";
import { readBoard, readTicket, ticketContext } from "./deckData.ts";
import { surfaceMessages } from "./text.ts";

/**
 * `/deck` 的两种上下文。
 *
 * Paseo 的 slash 回调没有 toast，也不是 React 组件，所以结果落点分两种：
 * - agent 上下文：往该会话追加一行插件时间线，命令结果可见，还能复制/开 SessionSheet；
 * - workspace 上下文：打开任务板；能复制的先复制到剪贴板（这里没有可挂载的会话面板）。
 *
 * 解析完全在 `shared/slash.ts`；这里只做「命令 → 实际动作」，不重新解释参数。
 */

type AgentContext = PluginAgentCommandContext & { args: string };
type WorkspaceContext = PluginWorkspaceCommandContext & { args: string };
type AnyContext = AgentContext | WorkspaceContext;

const langOf = (client: PluginClientContext): "en" | "zh" =>
  client.i18n.locale.startsWith("zh") ? "zh" : "en";

function errorText(client: PluginClientContext, parsed: Extract<DeckSlashCommand, { kind: "error" }>): string {
  switch (parsed.code) {
    case "unknown-command":
      return client.i18n.t(surfaceMessages, "slash.unknownCommand");
    case "missing-number":
      return client.i18n.t(surfaceMessages, "slash.missingNumber");
    case "invalid-number":
      return client.i18n.t(surfaceMessages, "slash.invalidNumber");
    case "extra-args":
      return client.i18n.t(surfaceMessages, "slash.extraArgs");
    default:
      return parsed.message;
  }
}

function parse(client: PluginClientContext, args: string): DeckSlashCommand {
  const parsed = parseDeckSlash(args);
  if (parsed.kind === "error") throw new Error(errorText(client, parsed));
  return parsed;
}

/* ------------------------------------------------------------------ agent 上下文 */

async function runAgent(client: PluginClientContext, ctx: AgentContext, command: DeckSlashCommand): Promise<void> {
  const dir = ctx.workspace.directory;
  const base = {
    workspaceId: ctx.workspace.id,
    workspaceDir: dir,
    agentId: ctx.agent.id,
  };
  const append = (data: Omit<DeckCommandData, "workspaceId" | "workspaceDir" | "agentId">) =>
    appendDeckCommand(ctx.paseo, ctx.agent.id, { ...data, ...base });

  switch (command.kind) {
    case "status": {
      const board = await readBoard(ctx, dir, { view: "open", limit: 100 });
      const lines = [
        `${client.i18n.t(surfaceMessages, "agentPanel.agent")}: ${ctx.agent.title ?? ctx.agent.id}`,
        `status: ${ctx.agent.status} · provider: ${ctx.agent.provider}${ctx.agent.model ? `/${ctx.agent.model}` : ""}`,
        `cwd: ${ctx.agent.cwd}`,
      ];
      if (board.ok) {
        const ready = board.issues.filter((issue) => issue.readiness === "ready").length;
        const blocked = board.issues.filter((issue) => issue.readiness === "blocked").length;
        lines.push(`open: ${board.totalCount} · ready: ${ready} · blocked: ${blocked}${board.hasMore ? " (recent window)" : ""}`);
        if (board.failures.length) lines.push(`partial: ${board.failures.map((item) => `${item.repoKey}: ${item.reason}`).join(", ")}`);
      } else {
        lines.push(`board: ${board.error}`);
      }
      await append({ command: "status", title: client.i18n.t(surfaceMessages, "slash.statusTitle"), lines, openBoard: true });
      return;
    }
    case "attach": {
      const ticket = await readTicket(ctx, dir, command.number);
      if (!ticket.ok) {
        await append({
          command: "attach",
          title: client.i18n.t(surfaceMessages, "slash.attachTitle"),
          lines: [`#${command.number}`, ticket.error],
          openBoard: true,
        });
        return;
      }
      let copyLine: string;
      try {
        await copyText(ticket.snapshot.text);
        copyLine = client.i18n.t(surfaceMessages, "slash.attachHint");
      } catch {
        copyLine = client.i18n.t(surfaceMessages, "common.copyFailed");
      }
      const session: DeckCommandAction = {
        action: "takeover",
        context: ticketContext({ repoKey: ticket.repoKey, ...ticket.issue }),
      };
      await append({
        command: "attach",
        title: client.i18n.t(surfaceMessages, "slash.attachTitle"),
        lines: [
          ticket.snapshot.title,
          `${ticket.issue.state} · ${ticket.repoKey} · ${ticket.commentCount} comments`,
          copyLine,
        ],
        // 快照已经复制到剪贴板；时间线行只放命令结果，避免整张票的正文/评论
        // 撞上宿主 64 KiB 的插件行上限。完整票面走附件源或任务板。
        openBoard: true,
        session,
      });
      return;
    }
    case "next": {
      const board = await readBoard(ctx, dir, { view: "ready", limit: 20 });
      if (!board.ok) {
        await append({
          command: "next",
          title: client.i18n.t(surfaceMessages, "slash.nextTitle"),
          lines: [board.error],
          openBoard: true,
        });
        return;
      }
      const ready = board.issues.filter((issue) => issue.readiness === "ready").slice(0, 3);
      const [primary] = ready;
      if (!primary) {
        await append({
          command: "next",
          title: client.i18n.t(surfaceMessages, "slash.nextTitle"),
          lines: [client.i18n.t(surfaceMessages, "slash.noTicket")],
          openBoard: true,
        });
        return;
      }
      await append({
        command: "next",
        title: client.i18n.t(surfaceMessages, "slash.nextTitle"),
        lines: ready.map((issue) => `#${issue.number} ${issue.title}`),
        openBoard: true,
        session: { action: "takeover", context: ticketContext(primary) },
      });
      return;
    }
    case "handoff": {
      await append({
        command: "handoff",
        title: client.i18n.t(surfaceMessages, "slash.handoffTitle"),
        lines: [client.i18n.t(surfaceMessages, "slash.handoffHint")],
        openBoard: true,
        session: { action: "handoff", context: ctx.agent.title ? { notes: ctx.agent.title } : {} },
      });
      return;
    }
    case "fixate": {
      await append({
        command: "fixate",
        title: client.i18n.t(surfaceMessages, "slash.fixateTitle"),
        lines: [client.i18n.t(surfaceMessages, "slash.fixateHint")],
        openBoard: true,
        session: { action: "fixate", context: {} },
      });
      return;
    }
    case "new": {
      // 建票走真表单，不是把一段提示词塞给模型：先建出票，才有「无票不干活」的前提。
      ctx.openScreen({ screenId: DECK_NEW_TICKET_ID, params: { dir } });
      await append({
        command: "new",
        title: client.i18n.t(surfaceMessages, "slash.newTitle"),
        lines: [client.i18n.t(surfaceMessages, "slash.newHint")],
      });
      return;
    }
    case "discuss": {
      const wayfinder = command.mode === "wayfinder";
      await append({
        command: "discuss",
        title: client.i18n.t(surfaceMessages, wayfinder ? "slash.discussWayfinderTitle" : "slash.discussGrillTitle"),
        lines: [client.i18n.t(surfaceMessages, wayfinder ? "slash.discussWayfinderHint" : "slash.discussGrillHint")],
        openBoard: true,
        session: { action: wayfinder ? "discuss-wayfinder" : "discuss-grill", context: {} },
      });
      return;
    }
    case "help": {
      await append({
        command: "help",
        title: client.i18n.t(surfaceMessages, "slash.helpTitle"),
        lines: [client.i18n.t(surfaceMessages, "slash.help"), ...DECK_SLASH_COMMANDS.map((name) => `/deck ${name}`)],
        openBoard: true,
      });
    }
  }
}

/* ------------------------------------------------------------------ workspace 上下文 */

async function runWorkspace(client: PluginClientContext, ctx: WorkspaceContext, command: DeckSlashCommand): Promise<void> {
  const dir = ctx.workspace.directory;
  const lang = langOf(client);
  const openBoard = (): void => ctx.openPanel(DECK_PANEL_ID);
  switch (command.kind) {
    case "status":
      openBoard();
      return;
    case "attach": {
      const ticket = await readTicket(ctx, dir, command.number);
      if (!ticket.ok) throw new Error(`#${command.number}: ${ticket.error}`);
      await copyText(ticket.snapshot.text);
      openBoard();
      return;
    }
    case "next": {
      const board = await readBoard(ctx, dir, { view: "ready", limit: 20 });
      if (!board.ok) throw new Error(board.error);
      const [primary] = board.issues.filter((issue) => issue.readiness === "ready");
      if (!primary) throw new Error(client.i18n.t(surfaceMessages, "slash.noTicket"));
      await copyText(buildActionPrompt("takeover", { ...ticketContext(primary), lang }));
      openBoard();
      return;
    }
    case "handoff":
      await copyText(buildActionPrompt("handoff", { lang }));
      openBoard();
      return;
    case "new":
      // 工作区上下文没有会话，建票表单一页就能填完：打开它，不复制提示词。
      ctx.openScreen({ screenId: DECK_NEW_TICKET_ID, params: { dir } });
      return;
    case "discuss":
      await copyText(
        buildActionPrompt(command.mode === "wayfinder" ? "discuss-wayfinder" : "discuss-grill", { lang }),
      );
      openBoard();
      return;
    case "help":
      await copyText(`${client.i18n.t(surfaceMessages, "slash.help")}\n${DECK_SLASH_COMMANDS.map((name) => `/deck ${name}`).join("\n")}`);
      openBoard();
  }
}

async function onSlash(client: PluginClientContext, ctx: AnyContext): Promise<void> {
  const command = parse(client, ctx.args);
  if (ctx.context === "agent") return runAgent(client, ctx, command);
  return runWorkspace(client, ctx, command);
}

/**
 * `/deck` 注册在 agent 上下文；工作区上下文用 `/deck-workspace`。
 *
 * 宿主按命令名去重，同名注册两次在加载期直接抛 `Duplicate client slash command`，
 * 会让整个插件装载失败。所以 agent / workspace 必须用两个名字：
 * `/deck` 是主入口（能读当前 agent、写时间线、开 SessionSheet），
 * `/deck-workspace` 只做工作区级动作（打开任务板、复制提示词/快照）。
 */
export function contributeSlash(client: PluginClientContext): () => void {
  const description = surfaceMessages.message("slash.description");
  const argumentHint = surfaceMessages.message("slash.argumentHint");
  const agent = client.addSlashCommand({
    name: "deck",
    description,
    argumentHint,
    context: "agent",
    onSubmit: (ctx) => onSlash(client, ctx),
  });
  const workspace = client.addSlashCommand({
    name: "deck-workspace",
    description,
    argumentHint,
    context: "workspace",
    onSubmit: (ctx) => onSlash(client, ctx),
  });
  return () => {
    void agent();
    void workspace();
  };
}
