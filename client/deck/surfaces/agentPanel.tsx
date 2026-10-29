import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { BoardIssue } from "../../../shared/issues.ts";
import type { PromptActionKind } from "../../../shared/session.ts";
import { SessionSheet } from "../session/SessionSheet.tsx";
import { PixelBanner, PixelButton, PixelCard, PixelChip, PixelHead, PixelScreen, usePixel } from "../pixel.tsx";
import { readBoard, ticketContext } from "./deckData.ts";
import type { BoardResult } from "./deckData.ts";
import { useDeckAgent, useDeckHost, useDeckWorkspace } from "./host.tsx";
import { sessionHandoffReadRpc, sessionHandoffsListRpc } from "../../../shared/session-rpc.ts";
import { AGENT_STATUS_KEY, useSurfaceText } from "./text.ts";

/**
 * agent 面板：这个会话所属工作区的可接票与动作。
 *
 * 建议气泡与工作路线卡住在时间线里；这里是「不滚动会话也能动手」的并列面。
 * 会话标题、provider、忙碌态都是宿主快照；票来自 `deck.issues.list` 的真实读取。
 */
export function DeckAgentPanel(props: PluginAgentPanelProps) {
  const { workspaceId, params, theme, navigation } = props;
  const agentId = params.agentId;
  const { client } = useDeckHost();
  const { t } = useSurfaceText();
  const skin = usePixel(theme);
  const agentState = useDeckAgent(agentId);
  const workspace = useDeckWorkspace(workspaceId);
  const [board, setBoard] = useState<BoardResult | null>(null);
  const [selected, setSelected] = useState<BoardIssue | null>(null);
  const [reload, setReload] = useState(0);
  const [sheet, setSheet] = useState<{ open: boolean; action: PromptActionKind }>({ open: false, action: "takeover" });
  const listHandoffs = useRpc(sessionHandoffsListRpc);
  const readHandoff = useRpc(sessionHandoffReadRpc);
  const toast = useToast();
  const [handoffs, setHandoffs] = useState<Array<{ name: string; modifiedAt: string }>>([]);
  const [handoffName, setHandoffName] = useState<string | null>(null);
  const [handoffText, setHandoffText] = useState<string | null>(null);

  useEffect(() => {
    const directory = workspace.directory;
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
  }, [client, workspace.directory, reload]);

  const agent = agentState.agent;
  const ready = board?.ok ? board.issues.filter((issue) => issue.readiness === "ready") : [];
  const provider = agent ? `${agent.provider}${agent.model ? `/${agent.model}` : ""}` : null;
  const openSheet = (action: PromptActionKind): void => setSheet({ open: true, action });
  const showHandoff = async (name: string): Promise<void> => {
    setHandoffName(name);
    setHandoffText(null);
    const read = await readHandoff({ cwd: workspace.directory, agentId, name });
    if (!read.ok) { toast.error(read.detail); return; }
    setHandoffText(read.markdown);
  };
  const loadHandoffs = async (): Promise<void> => {
    const result = await listHandoffs({ cwd: workspace.directory, agentId });
    if (!result.ok) { toast.error(result.detail); return; }
    setHandoffs(result.files);
    const first = result.files[0];
    if (first) await showHandoff(first.name);
  };

  if (!agentId) {
    return (
      <PixelScreen skin={skin}>
        <Text style={skin.error}>{t("agentPanel.noAgent")}</Text>
      </PixelScreen>
    );
  }

  return (
    <PixelScreen skin={skin}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <PixelHead skin={skin}>{t("agentPanel.title")}</PixelHead>
          <PixelChip skin={skin}>{agent ? t(AGENT_STATUS_KEY[agent.status]) : t("common.loading")}</PixelChip>
        </View>

        <PixelCard skin={skin} style={{ padding: 8, gap: 3 }}>
          {agent ? (
            <>
              <Text style={skin.value} numberOfLines={2}>{agent.title ?? agent.id}</Text>
              <Text style={skin.hint}>{`${t("agentPanel.provider")}: ${provider ?? "—"}`}</Text>
              <Text style={skin.hint} numberOfLines={2}>{`${t("agentPanel.directory")}: ${agent.cwd ?? workspace.directory}`}</Text>
            </>
          ) : agentState.error ? (
            <Text style={skin.error}>{agentState.error}</Text>
          ) : (
            <Text style={skin.hint}>{t("common.loading")}</Text>
          )}
        </PixelCard>

        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={skin.label}>{t("agentPanel.next")}</Text>
          <PixelButton skin={skin} variant="ghost" label={t("common.refresh")} onPress={() => setReload((value) => value + 1)} />
        </View>

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
              { padding: 6, gap: 3 },
              selected !== null && selected.repoKey === issue.repoKey && selected.number === issue.number
                ? { borderColor: skin.colors.acc }
                : null,
            ]}
          >
            <Text style={skin.value} numberOfLines={2}>{`#${issue.number} ${issue.title}`}</Text>
            <Text style={skin.hint} numberOfLines={1}>{`${issue.repoKey} · ${issue.readiness}`}</Text>
          </Pressable>
        ))}

        {selected ? (
          <Text style={skin.hint} numberOfLines={2}>{`#${selected.number} ${selected.title}`}</Text>
        ) : (
          <Text style={skin.hint}>{t("agentPanel.noTicketHint")}</Text>
        )}

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <PixelButton skin={skin} label={t("agentPanel.diagnose")} disabled={!selected} onPress={() => openSheet("diagnose")} />
          <PixelButton skin={skin} label={t("agentPanel.fix")} disabled={!selected} onPress={() => openSheet("fix")} />
          <PixelButton skin={skin} label={t("agentPanel.research")} disabled={!selected} onPress={() => openSheet("research")} />
          <PixelButton skin={skin} label={t("agentPanel.takeover")} disabled={!selected} onPress={() => openSheet("takeover")} />
          <PixelButton skin={skin} label={t("agentPanel.handoff")} onPress={() => openSheet("handoff")} />
          <PixelButton skin={skin} label={t("agentPanel.fixate")} onPress={() => openSheet("fixate")} />
          <PixelButton skin={skin} label={t("agentPanel.handoffs")} onPress={() => void loadHandoffs()} />
          <PixelButton skin={skin} label={t("agentPanel.newSession")} onPress={() => openSheet("new-requirement")} />
        </View>
        <Text style={skin.hint}>{t("agentPanel.boardHint")}</Text>
      </ScrollView>

      {handoffs.length > 0 ? (
        <Modal title={t("agentPanel.handoffs")} open onOpenChange={(open) => { if (!open) { setHandoffs([]); setHandoffName(null); setHandoffText(null); } }}>
          <Modal.Content>
            <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 8 }}>
              {handoffs.map((file) => (
                <Pressable
                  key={file.name}
                  accessibilityRole="button"
                  accessibilityState={{ selected: handoffName === file.name }}
                  onPress={() => void showHandoff(file.name)}
                  style={{ paddingVertical: 3 }}
                >
                  <Text style={[skin.hint, handoffName === file.name ? { color: skin.colors.ink, fontWeight: "700" as const } : null]}>
                    {file.name} · {file.modifiedAt}
                  </Text>
                </Pressable>
              ))}
              {handoffText ? <Text selectable style={skin.value}>{handoffText}</Text> : null}
              {handoffText ? <PixelButton skin={skin} label={t("common.copy")} onPress={() => void copyText(handoffText).then(() => toast.show(t("common.copied"), { variant: "success" }))} /> : null}
            </ScrollView>
          </Modal.Content>
        </Modal>
      ) : null}

      <SessionSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((current) => ({ ...current, open }))}
        theme={theme}
        workspaceId={workspaceId}
        workspaceDir={workspace.directory}
        agentId={agentId}
        agentStatus={agent?.status ?? null}
        provider={provider}
        action={sheet.action}
        defaultTarget={sheet.action === "new-requirement" ? "new" : undefined}
        context={
          selected
            ? sheet.action === "handoff"
              ? { ...ticketContext(selected), notes: agent?.title ?? undefined }
              : ticketContext(selected)
            : sheet.action === "handoff" && agent?.title
              ? { notes: agent.title }
              : {}
        }
        navigation={navigation}
      />
    </PixelScreen>
  );
}
