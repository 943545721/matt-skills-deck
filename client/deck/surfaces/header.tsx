import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { DECK_PANEL_ID, DECK_SETTINGS_ID } from "../ids.ts";
import { SessionSheet } from "../session/SessionSheet.tsx";
import type { PromptActionKind } from "../../../shared/session.ts";
import { PixelBanner, PixelButton, PixelCard, PixelChip, PixelHead, usePixel } from "../pixel.tsx";
import { readBoard } from "./deckData.ts";
import type { BoardResult } from "./deckData.ts";
import { useDeckHost, useDeckWorkspace, useDeckWorkspaceProvider } from "./host.tsx";
import { useSurfaceText } from "./text.ts";
import { readWorkRoute } from "./workRoute.ts";
import type { WorkRouteRead } from "./workRoute.ts";
import { WorkRouteRows } from "./WorkRouteRows.tsx";

/**
 * 顶栏按钮：工作区级状态与快捷入口。
 *
 * 计数只报「最近窗口」：RPC 默认最多 100 条，卡片上明确写出来，
 * 不把局部数字说成全仓统计。这里不读会话，因此不能显示“当前票”。
 */
export function DeckHeaderContent({ workspaceId, theme }: PluginButtonContentProps) {
  const { client } = useDeckHost();
  const { t } = useSurfaceText();
  const skin = usePixel(theme);
  const workspace = useDeckWorkspace(workspaceId);
  const provider = useDeckWorkspaceProvider(workspaceId);
  const [board, setBoard] = useState<BoardResult | null>(null);
  const [ledger, setLedger] = useState<WorkRouteRead>({ state: "loading" });
  const [reload, setReload] = useState(0);
  const [sheet, setSheet] = useState<{ open: boolean; action: PromptActionKind }>({ open: false, action: "new-requirement" });

  useEffect(() => {
    if (!workspace.directory) return;
    let alive = true;
    setBoard(null);
    void readBoard(client, workspace.directory, { view: "open", limit: 100 }).then((result) => {
      if (alive) setBoard(result);
    });
    return () => {
      alive = false;
    };
  }, [client, workspace.directory, reload]);

  // 顶栏没有 agent 上下文：显式传 null，读工作区作用域的台账，不猜服务端环境里的会话 id。
  useEffect(() => {
    const directory = workspace.directory;
    let alive = true;
    if (!directory) {
      setLedger({ state: "unreadable", reason: "workspace directory unknown" });
      return () => {
        alive = false;
      };
    }
    setLedger({ state: "loading" });
    void readWorkRoute(client, { cwd: directory, agentId: null }).then((result) => {
      if (alive) setLedger(result);
    });
    return () => {
      alive = false;
    };
  }, [client, workspace.directory, reload]);

  const ready = board?.ok ? board.issues.filter((issue) => issue.readiness === "ready").length : 0;
  const blocked = board?.ok ? board.issues.filter((issue) => issue.readiness === "blocked").length : 0;

  return (
    <View style={{ gap: 10, padding: 12, minWidth: 250 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <PixelHead skin={skin}>{t("header.title")}</PixelHead>
        <PixelChip skin={skin}>{workspace.workspace?.name ?? t("common.workspaceUnknown")}</PixelChip>
      </View>

      {workspace.directory ? (
        <Text style={skin.hint} numberOfLines={2}>{workspace.directory}</Text>
      ) : (
        <Text style={skin.error}>{workspace.error ?? t("common.workspaceUnknown")}</Text>
      )}

      <PixelCard skin={skin} style={{ padding: 8, gap: 4 }}>
        {board === null ? <Text style={skin.hint}>{t("common.loading")}</Text> : null}
        {board && !board.ok ? (
          <PixelBanner skin={skin}>
            <Text style={skin.bannerText}>{t("common.loadFailed", { error: board.error })}</Text>
          </PixelBanner>
        ) : null}
        {board?.ok ? (
          <>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={skin.label}>{t("header.openIssues")}</Text>
                <Text style={skin.head}>{board.totalCount}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={skin.label}>{t("header.ready")}</Text>
                <Text style={skin.head}>{ready}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={skin.label}>{t("header.blocked")}</Text>
                <Text style={skin.head}>{blocked}</Text>
              </View>
            </View>
            <Text style={skin.hint}>{t("header.countsHint")}</Text>
            {board.failures.length ? (
              <Text style={skin.error}>
                {board.failures.map((failure) => `${failure.repoKey}: ${failure.reason}`).join(", ")}
              </Text>
            ) : null}
          </>
        ) : null}
      </PixelCard>

      <ScrollView style={{ maxHeight: 180 }} contentContainerStyle={{ gap: 5 }}>
        <WorkRouteRows skin={skin} read={ledger} limit={5} />
      </ScrollView>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <PixelButton
          skin={skin}
          variant="solid"
          label={t("common.openBoard")}
          onPress={() => client.openPanel(DECK_PANEL_ID, { workspaceId })}
        />
        <PixelButton skin={skin} label={t("common.refresh")} onPress={() => setReload((value) => value + 1)} />
        <PixelButton skin={skin} label={t("common.openSettings")} onPress={() => client.openSettings(DECK_SETTINGS_ID)} />
        <PixelButton
          skin={skin}
          label={t("agentPanel.newSession")}
          onPress={() => setSheet({ open: true, action: "new-requirement" })}
        />
      </View>

      <SessionSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((current) => ({ ...current, open }))}
        theme={theme}
        workspaceId={workspaceId}
        workspaceDir={workspace.directory}
        provider={provider}
        action={sheet.action}
        context={{}}
        defaultTarget="new"
      />
    </View>
  );
}
