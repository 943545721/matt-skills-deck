import { openExternalUrl } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import { PixelBanner, PixelChip, type PixelSkin } from "../pixel.tsx";
import { useSurfaceText } from "./text.ts";
import { WORK_ROUTE_STATUS_KEY, workRouteClock, workRouteScopeKey } from "./workRoute.ts";
import type { WorkRouteRead } from "./workRoute.ts";

/**
 * 工作路线的一段只读列表，pill 与顶栏共用。
 *
 * 只画台账里真有的东西：票号、标题、仓库、状态、动作时间、会话与备注。
 * 点有链接的行走系统浏览器；没有链接的行保持静态，不做一个点了没反应的按钮。
 */
export function WorkRouteRows({
  skin,
  read,
  limit = 20,
}: {
  skin: PixelSkin;
  read: WorkRouteRead;
  limit?: number;
}) {
  const { t } = useSurfaceText();
  const toast = useToast();
  const now = Date.now();

  const title = (
    <Text style={skin.label}>{t("ledger.title")}</Text>
  );

  if (read.state === "unreadable") {
    return (
      <View style={{ gap: 4 }}>
        {title}
        <PixelBanner skin={skin}>
          <Text style={skin.bannerText}>{t("ledger.unreadable", { error: read.reason })}</Text>
        </PixelBanner>
      </View>
    );
  }

  if (read.state === "loading") {
    return (
      <View style={{ gap: 4 }}>
        {title}
        <Text style={skin.hint}>{t("common.loading")}</Text>
      </View>
    );
  }

  const { data } = read;
  const shown = data.entries.slice(0, limit);

  return (
    <View style={{ gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        {title}
        <PixelChip skin={skin}>{t(workRouteScopeKey(data.scope))}</PixelChip>
      </View>

      {read.state === "empty" ? (
        <Text style={skin.hint}>
          {t(data.scope === "agent" ? "ledger.emptyAgent" : "ledger.emptyWorkspace")}
        </Text>
      ) : null}
      {data.recovered ? (
        <Text style={skin.hint}>
          {data.corruptPath ? `${t("ledger.recovered")} ${data.corruptPath}` : t("ledger.recovered")}
        </Text>
      ) : null}
      {data.dropped > 0 ? <Text style={skin.hint}>{t("ledger.dropped", { count: data.dropped })}</Text> : null}

      {shown.map((entry) => {
        const statusKey = WORK_ROUTE_STATUS_KEY[entry.status];
        const statusText = statusKey ? t(statusKey) : String(entry.status);
        const clock = workRouteClock(entry.updatedAt, now);
        const meta = [entry.repoKey ?? "local", statusText, clock, entry.agentId].filter(
          (part): part is string => typeof part === "string" && part !== "",
        );
        const body = (
          <View style={[skin.card, { padding: 6, gap: 2 }]}>
            <Text style={skin.value} numberOfLines={2}>{`#${entry.number} ${entry.title}`}</Text>
            <Text style={skin.hint} numberOfLines={1}>{meta.join(" · ")}</Text>
            {entry.note ? <Text style={skin.hint} numberOfLines={1}>{entry.note}</Text> : null}
          </View>
        );
        return entry.url ? (
          <Pressable
            key={entry.ticketKey}
            accessibilityRole="link"
            accessibilityLabel={`#${entry.number} ${entry.title}`}
            onPress={() => void openExternalUrl(entry.url as string).catch(() => toast.error(t("ledger.openFailed")))}
          >
            {body}
          </Pressable>
        ) : (
          <View key={entry.ticketKey}>{body}</View>
        );
      })}

      {data.entries.length > shown.length ? (
        <Text style={skin.hint}>
          {t("ledger.truncated", { total: data.entries.length, shown: shown.length })}
        </Text>
      ) : null}
    </View>
  );
}
