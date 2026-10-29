import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { BoardIssue } from "../../../shared/issues.ts";
import type { PromptActionKind } from "../../../shared/session.ts";
import { DECK_PANEL_ID } from "../ids.ts";
import { SessionSheet } from "../session/SessionSheet.tsx";
import { PixelBanner, PixelButton, PixelCard, PixelChip, PixelHead, usePixel } from "../pixel.tsx";
import { readBoard, ticketContext } from "./deckData.ts";
import type { BoardResult } from "./deckData.ts";
import { useDeckAgent, useDeckHost, useDeckWorkspace } from "./host.tsx";
import { AGENT_STATUS_KEY, useSurfaceText } from "./text.ts";
import { readWorkRoute } from "./workRoute.ts";
import type { WorkRouteRead } from "./workRoute.ts";
import { WorkRouteRows } from "./WorkRouteRows.tsx";

/**
 * composer pill 的弹层：agent 维度的工作路线、最近可接票与动作。
 *
 * 当前票只从台账和板子上真读到的数据里来，不拿会话标题冒充票号。
 * 台账按会话或工作区读（作用域标在标题旁）；点票 → SessionSheet（takeover）；
 * 点动作 → 同一张票的对应提示词。
 */
export function DeckPillContent(props: PluginButtonContentProps) {
  const { workspaceId, theme } = props;
  // popover 的上下文是判别式联合：只有 agent 变体才有 agentId。
  const agentId = props.context === "agent" ? props.agentId : undefined;
  const { client } = useDeckHost();
  const { t } = useSurfaceText();
  const skin = usePixel(theme);
  const agentState = useDeckAgent(agentId);
  const workspaceState = useDeckWorkspace(workspaceId);
  const [board, setBoard] = useState<BoardResult | null>(null);
  const [ledger, setLedger] = useState<WorkRouteRead>({ state: "loading" });
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<BoardIssue | null>(null);
  const [sheet, setSheet] = useState<{ open: boolean; action: PromptActionKind }>({ open: false, action: "takeover" });

  useEffect(() => {
    const directory = workspaceState.directory;
    if (!directory) return;
    let alive = true;
    setBoard(null);
    void readBoard(client, directory, { view: "ready", limit: 20 }).then((result) => {
      if (!alive) return;
      setBoard(result);
      if (result.ok) {
        const first = result.issues.find((issue) => issue.readiness === "ready") ?? null;
        setSelected((current) =>
          current && result.issues.some((issue) => issue.repoKey === current.repoKey && issue.number === current.number)
            ? current
            : first,
        );
      }
    });
    return () => {
      alive = false;
    };
  }, [client, workspaceState.directory, reload]);

  useEffect(() => {
    const directory = workspaceState.directory;
    let alive = true;
    if (!directory) {
      setLedger({ state: "unreadable", reason: "workspace directory unknown" });
      return () => {
        alive = false;
      };
    }
    setLedger({ state: "loading" });
    void readWorkRoute(client, { cwd: directory, agentId: agentId ?? null }).then((result) => {
      if (alive) setLedger(result);
    });
    return () => {
      alive = false;
    };
  }, [client, workspaceState.directory, agentId, reload]);

  const agent = agentState.agent;
  const ready = board?.ok ? board.issues.filter((issue) => issue.readiness === "ready").slice(0, 3) : [];
  const provider = agent ? `${agent.provider}${agent.model ? `/${agent.model}` : ""}` : null;

  const openSheet = (action: PromptActionKind): void => setSheet({ open: true, action });

  return (
    <View style={{ gap: 10, padding: 12, minWidth: 260 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <PixelHead skin={skin}>{t("pill.title")}</PixelHead>
        <PixelChip skin={skin}>{agent ? t(AGENT_STATUS_KEY[agent.status]) : t("common.loading")}</PixelChip>
      </View>

      <PixelCard skin={skin} style={{ padding: 8, gap: 3 }}>
        {agent ? (
          <>
            <Text style={skin.value} numberOfLines={1}>{agent.title ?? agent.id}</Text>
            <Text style={skin.hint}>{provider}</Text>
            <Text style={skin.hint} numberOfLines={1}>{agent.cwd ?? ""}</Text>
          </>
        ) : agentState.error ? (
          <Text style={skin.error}>{agentState.error}</Text>
        ) : (
          <Text style={skin.hint}>{t("common.loading")}</Text>
        )}
        <Text style={skin.hint} numberOfLines={1}>
          {workspaceState.directory || (workspaceState.error ? workspaceState.error : t("common.workspaceUnknown"))}
        </Text>
      </PixelCard>

      <ScrollView style={{ maxHeight: 190 }} contentContainerStyle={{ gap: 5 }}>
        <WorkRouteRows skin={skin} read={ledger} limit={5} />
      </ScrollView>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={skin.label}>{t("agentPanel.next")}</Text>
        <PixelButton skin={skin} variant="ghost" label={t("common.refresh")} onPress={() => setReload((value) => value + 1)} />
      </View>

      <ScrollView style={{ maxHeight: 180 }} contentContainerStyle={{ gap: 6 }}>
        {board === null ? <Text style={skin.hint}>{t("common.loading")}</Text> : null}
        {board && !board.ok ? (
          <PixelBanner skin={skin}>
            <Text style={skin.bannerText}>{t("common.loadFailed", { error: board.error })}</Text>
          </PixelBanner>
        ) : null}
        {board?.ok && ready.length === 0 ? <Text style={skin.hint}>{t("agentPanel.noNext")}</Text> : null}
        {ready.map((issue) => (
          <Pressable
            key={`${issue.repoKey}#${issue.number}`}
            accessibilityRole="button"
            accessibilityLabel={`#${issue.number} ${issue.title}`}
            onPress={() => setSelected(issue)}
            style={[
              skin.card,
              { padding: 6, gap: 2 },
              selected !== null && selected.repoKey === issue.repoKey && selected.number === issue.number
                ? { borderColor: skin.colors.acc }
                : null,
            ]}
          >
            <Text style={skin.value} numberOfLines={2}>{`#${issue.number} ${issue.title}`}</Text>
            <Text style={skin.hint} numberOfLines={1}>{issue.repoKey}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {selected ? <Text style={skin.hint} numberOfLines={1}>{`#${selected.number} ${selected.title}`}</Text> : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <PixelButton skin={skin} label={t("agentPanel.diagnose")} disabled={!selected} onPress={() => openSheet("diagnose")} />
        <PixelButton skin={skin} label={t("agentPanel.fix")} disabled={!selected} onPress={() => openSheet("fix")} />
        <PixelButton skin={skin} label={t("agentPanel.research")} disabled={!selected} onPress={() => openSheet("research")} />
        <PixelButton skin={skin} label={t("agentPanel.takeover")} disabled={!selected} onPress={() => openSheet("takeover")} />
        <PixelButton skin={skin} label={t("agentPanel.handoff")} onPress={() => openSheet("handoff")} />
        <PixelButton skin={skin} label={t("agentPanel.newSession")} onPress={() => openSheet("new-requirement")} />
      </View>

      <PixelButton
        skin={skin}
        variant="ghost"
        label={t("common.openBoard")}
        onPress={() => client.openPanel(DECK_PANEL_ID, { workspaceId, agentId })}
      />

      <SessionSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((current) => ({ ...current, open }))}
        theme={theme}
        workspaceId={workspaceId}
        workspaceDir={workspaceState.directory}
        agentId={agentId}
        agentStatus={agent?.status ?? null}
        provider={provider}
        action={sheet.action}
        defaultTarget={sheet.action === "new-requirement" ? "new" : undefined}
        context={selected ? ticketContext(selected) : {}}
      />
    </View>
  );
}
