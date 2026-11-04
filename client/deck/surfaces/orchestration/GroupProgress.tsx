import { useRpc } from "@getpaseo/plugin/client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { groupProgressColumns, ticketsOfMap, type GroupProgressTicket } from "../../../../shared/group-progress.ts";
import { issuesDetailRpc } from "../../../../shared/issues.ts";
import { mapRpc } from "../../../../shared/map.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelBanner } from "../../pixel.tsx";
import { OrchSection } from "./parts.tsx";

/**
 * 需求的进度：地图和它两边的票按仓库并排。
 *
 * 数据用已有的票详情和地图 RPC，不另开一条群进度接口。
 * 地图读失败就写明，不把空列说成「这边没有票」。
 */

const MAP_LIMIT = 4;
const STALE_MS = 10_000;

function stateText(
  state: GroupProgressTicket["state"],
  t: (key: PanelKey, vars?: Record<string, string | number>) => string,
): string {
  if (state === "OPEN") return t("group.ticketOpen");
  if (state === "CLOSED") return t("group.ticketClosed");
  return t("group.ticketUnknown");
}

export function GroupProgress({
  skin,
  t,
  workspaceDir,
  number,
}: {
  skin: PixelSkin;
  t: (key: PanelKey, vars?: Record<string, string | number>) => string;
  workspaceDir: string;
  /** 需求票号。没填或填的不是正整数时不读。 */
  number: number | null;
}) {
  const detailRpc = useRpc(issuesDetailRpc);
  const mapCall = useRpc(mapRpc);

  const detail = useQuery({
    queryKey: ["deck", "group-progress", workspaceDir, number],
    queryFn: () => detailRpc({ workspaceDir, number: number ?? 1 }),
    enabled: number !== null && Boolean(workspaceDir),
    staleTime: STALE_MS,
    retry: false,
  });

  const maps = detail.data?.ok ? (detail.data.derivedMaps ?? []).slice(0, MAP_LIMIT) : [];
  const mapQueries = useQueries({
    queries: maps.map((map) => ({
      queryKey: ["deck", "group-progress-map", workspaceDir, map.repoKey ?? "", map.number],
      queryFn: () => mapCall({
        workspaceDir,
        number: map.number,
        ...(map.repoKey ? { repoKey: map.repoKey } : {}),
      }),
      staleTime: STALE_MS,
      retry: false,
    })),
  });

  const hint = { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily };
  const title = { color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily };
  const line = { color: skin.colors.ink, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily };

  const tickets: GroupProgressTicket[] = [];
  const mapProblems: string[] = [];
  for (const query of mapQueries) {
    const data = query.data;
    if (!data) continue;
    if (!data.ok) {
      mapProblems.push(data.detail);
      continue;
    }
    tickets.push(...ticketsOfMap({
      repoKey: data.repoKey,
      issue: { number: data.issue.number, title: data.issue.title, state: data.issue.state },
      route: data.route,
      references: data.references,
    }));
  }
  const progress = groupProgressColumns(tickets);
  const mapTotal = detail.data?.ok ? (detail.data.derivedMaps ?? []).length : 0;
  const loading = number !== null && (detail.isPending || mapQueries.some((query) => query.isPending));

  let summary = "";
  if (number !== null && progress.columns.length > 0) {
    summary = t("group.progressSummary", { open: progress.open, closed: progress.closed });
    if (progress.unknown > 0) summary = `${summary} · ${t("group.progressUnknown", { n: progress.unknown })}`;
  }

  return (
    <OrchSection skin={skin} title={t("group.progress")} aside={summary || undefined}>
      {number === null ? <Text style={hint}>{t("group.progressHint")}</Text> : null}
      {number !== null && detail.isPending && !detail.data ? <Text style={hint}>{t("group.progressLoading")}</Text> : null}
      {detail.data && !detail.data.ok ? (
        <PixelBanner skin={skin}><Text style={skin.error}>{t("group.progressFailed", { detail: detail.data.detail })}</Text></PixelBanner>
      ) : null}
      {detail.data?.ok && detail.data.derivedMapsFailed ? <Text style={hint}>{t("group.progressMapsFailed")}</Text> : null}
      {detail.data?.ok && !detail.data.derivedMapsFailed && mapTotal === 0 && !loading ? (
        <Text style={hint}>{t("group.progressNoMap")}</Text>
      ) : null}
      {mapTotal > MAP_LIMIT ? <Text style={hint}>{t("group.progressTruncated", { n: MAP_LIMIT })}</Text> : null}
      {mapProblems.map((problem) => <Text key={problem} style={hint}>{problem}</Text>)}

      {progress.columns.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {progress.columns.map((column) => (
            <View key={column.repoKey || "unknown"} style={{ flexGrow: 1, flexBasis: 160, gap: 2 }}>
              <Text style={title} numberOfLines={1}>{column.repoKey || t("group.repoUnknown")}</Text>
              <Text style={hint}>
                {t("group.progressSummary", { open: column.open, closed: column.closed })}
              </Text>
              {column.tickets.map((ticket) => (
                <Text key={`${column.repoKey}#${ticket.number}`} style={line} numberOfLines={2}>
                  {`#${ticket.number} ${ticket.title} · ${stateText(ticket.state, t)}`}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </OrchSection>
  );
}
