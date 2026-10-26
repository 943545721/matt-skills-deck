import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { issuesListRpc } from "../../shared/issues";
import { readableText } from "./format";
import { FAILURE_KEYS, staticText, useDeckText } from "./i18n";
import { IssueModal } from "./IssueModal";
import { MapModal } from "./MapModal";
import { NewIssueModal } from "./NewIssueModal";
import { PixelButton, PixelCard, usePixel } from "./pixel";

/**
 * 任务板列表。
 *
 * 只负责「看到哪些票、点开哪一张」，详情与写操作都在各自的弹窗里：
 * 一个文件管一屏，改评论框时不用在列表逻辑里翻。
 */
export function BoardView({
  theme,
  layout,
  workspaceDir,
  current,
  onBind,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceDir: string;
  /** 当前票：绑在面板状态里，换工作区就换一张。 */
  current?: number;
  onBind(number: number | undefined): void;
}) {
  const { t } = useDeckText();
  const skin = usePixel(theme);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [openNumber, setOpenNumber] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  /** 地图弹窗：地图票的入口，与票面详情并列，而不是替代它。 */
  const [mapNumber, setMapNumber] = useState<number | null>(null);

  const listIssues = useRpc(issuesListRpc);
  const list = useQuery({
    queryKey: ["deck", "issues", workspaceDir, includeClosed],
    queryFn: () => listIssues({ workspaceDir, includeClosed }),
    staleTime: 15_000,
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      chip: {
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderWidth: 2,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      chipText: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: skin.mono.fontFamily },
      spacer: { marginLeft: "auto" as const },
      // 一行 = 主卡片 + 可选的地图按钮；间距放在这一层，卡片自己的投影才不会把行距吃掉。
      item: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8, marginBottom: 8 },
      // 主卡片吃掉整行宽度，地图按钮贴右；标题再长也只在卡片里折行。
      itemMain: { flex: 1 },
      rowBody: { padding: 10, gap: 5 },
      rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      number: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: skin.mono.fontFamily },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, flexShrink: 1 },
      labels: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
      label: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 1, overflow: "hidden" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      failureBody: { padding: 10, gap: 4 },
    }),
    [theme, skin],
  );

  const header = list.data?.ok ? `${list.data.repo.owner}/${list.data.repo.name}` : null;
  const failure = list.data && !list.data.ok ? list.data : null;
  const issues = list.data?.ok ? list.data.issues : [];

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.chip}>
          <Text style={styles.chipText} numberOfLines={1}>
            {header ?? t("board.unbound")}
          </Text>
        </View>
        <Text style={styles.chipText}>
          {list.data?.ok
            ? t("board.count", { shown: list.data.issues.length, total: list.data.totalCount })
            : ""}
        </Text>
        <View style={styles.spacer} />
        <PixelButton skin={skin} label={t("board.new")} onPress={() => setCreating(true)} />
        <PixelButton
          skin={skin}
          label={includeClosed ? t("board.withClosed") : t("board.onlyOpen")}
          accessibilityLabel={includeClosed ? t("board.onlyOpenHint") : t("board.withClosedHint")}
          active={includeClosed}
          onPress={() => setIncludeClosed((value) => !value)}
        />
        <PixelButton
          skin={skin}
          label={list.isFetching ? t("common.refreshing") : t("common.refresh")}
          accessibilityLabel={t("board.refreshHint")}
          onPress={() => void list.refetch()}
        />
      </View>

      {failure ? (
        <PixelCard skin={skin} style={styles.failureBody}>
          <Text style={styles.error}>{staticText(t, FAILURE_KEYS[failure.reason] ?? "failure.read")}</Text>
          <Text style={styles.hint}>{failure.detail}</Text>
        </PixelCard>
      ) : null}
      {list.error ? <Text style={styles.error}>{list.error.message}</Text> : null}

      <FlatList
        data={issues}
        keyExtractor={(item) => String(item.number)}
        contentContainerStyle={{ paddingBottom: layout.compact ? 12 : 20 }}
        ListEmptyComponent={
          <Text style={styles.hint}>
            {list.isPending
              ? t("common.loading")
              : failure
                ? t("board.emptyAfterFailure")
                : t("board.empty")}
          </Text>
        }
        renderItem={({ item }) => (
          <View style={styles.item}>
            <View style={styles.itemMain}>
              <PixelCard skin={skin}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`#${item.number} ${item.title}`}
                  style={styles.rowBody}
                  onPress={() => setOpenNumber(item.number)}
                >
                  <View style={styles.rowHead}>
                    <Text style={styles.number}>#{item.number}</Text>
                    {current === item.number ? (
                      <Text style={[styles.label, { backgroundColor: theme.colors.accent, color: "#000000" }]}>
                        {t("board.current")}
                      </Text>
                    ) : null}
                    {item.state === "CLOSED" ? (
                      <Text style={[styles.label, { backgroundColor: theme.colors.statusSuccess, color: "#000000" }]}>
                        {t("board.closed")}
                      </Text>
                    ) : null}
                    <Text style={styles.title} numberOfLines={2}>
                      {item.title}
                    </Text>
                  </View>
                  {item.labels.length ? (
                    <View style={styles.labels}>
                      {item.labels.map((label) => (
                        <Text
                          key={label.name}
                          style={[styles.label, { backgroundColor: `#${label.color}`, color: readableText(label.color) }]}
                        >
                          {label.name}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                  {item.assignees.length ? (
                    <Text style={styles.meta}>{t("board.assignees", { names: item.assignees.join(", ") })}</Text>
                  ) : null}
                </Pressable>
              </PixelCard>
            </View>
            {item.isMap ? (
              <PixelButton skin={skin} label={t("map.open")} onPress={() => setMapNumber(item.number)} />
            ) : null}
          </View>
        )}
      />

      {openNumber !== null ? (
        <IssueModal
          theme={theme}
          workspaceDir={workspaceDir}
          number={openNumber}
          isCurrent={current === openNumber}
          onBind={() => onBind(current === openNumber ? undefined : openNumber)}
          onClose={() => setOpenNumber(null)}
        />
      ) : null}

      {mapNumber !== null ? (
        <MapModal
          theme={theme}
          workspaceDir={workspaceDir}
          number={mapNumber}
          open
          onClose={() => setMapNumber(null)}
        />
      ) : null}

      <NewIssueModal
        theme={theme}
        workspaceDir={workspaceDir}
        open={creating}
        onClose={() => setCreating(false)}
      />
    </View>
  );
}
