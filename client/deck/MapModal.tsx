import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { mapRpc } from "../../shared/map";
import { FAILURE_KEYS, staticText, useDeckText } from "./i18n";
import type { DeckKey } from "./i18n";
import { PixelButton, PixelCard, PixelHead, usePixel } from "./pixel";

type Suggestion = { code: string; number?: number; count?: number };
type RouteKind = "research" | "prototype" | "grilling" | "task";

type SuggestionResult = { reason: string; prompt: string };

const KIND_KEY: Record<RouteKind, DeckKey> = {
  research: "map.kind.research",
  prototype: "map.kind.prototype",
  grilling: "map.kind.grilling",
  task: "map.kind.task",
};

/** 列表行里的 `- ` 只是 Markdown 记号，渲染成一行一条时剥掉更清爽（解析层保持原样）。 */
const stripBullet = (line: string) => line.replace(/^[-*]\s+/, "");

/**
 * 地图详情。
 *
 * 一屏回答三个问题：这张地图要去哪（目标 / 已定决策 / 雾），路上还有哪些票（工作路线），
 * 以及现在最该做哪一件（下一步）。建议只给三条，且每条都能一键复制成提示词——
 * 「看一眼就知道下一步点哪张」是这一页唯一的存在理由。
 */
export function MapModal({
  theme,
  workspaceDir,
  number,
  open,
  onClose,
}: {
  theme: PluginTheme;
  workspaceDir: string;
  number: number;
  open: boolean;
  onClose(): void;
}) {
  const { t } = useDeckText();
  const toast = useToast();
  const skin = usePixel(theme);
  const readMap = useRpc(mapRpc);

  const query = useQuery({
    queryKey: ["deck", "map", workspaceDir, number],
    queryFn: () => readMap({ workspaceDir, number }),
    enabled: open,
  });

  const styles = useMemo(
    () => ({
      body: { gap: 10 },
      cardBody: { padding: 10, gap: 6 },
      head: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: skin.mono.fontFamily },
      text: { color: theme.colors.foreground, fontSize: 12, lineHeight: 18 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      item: { gap: 2 },
      badge: {
        fontSize: 10,
        paddingHorizontal: 6,
        paddingVertical: 1,
        overflow: "hidden" as const,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
      },
      grow: { flexShrink: 1 },
    }),
    [theme, skin],
  );

  const copyPrompt = (text: string) => {
    void copyText(text)
      .then(() => toast.show(t("map.promptCopied"), { variant: "success" }))
      .catch(() => toast.error(t("common.copyFailed")));
  };

  /**
   * 建议码 → 理由 + 提示词。
   *
   * 写成 switch 而不是「查表 + 自己替换占位符」：每个分支里 `t` 都是静态键，
   * 漏传参数编译期就报错；查表加手写替换等于把 SDK 的插值重做一遍，还少一层类型检查。
   */
  const suggestionText = (item: Suggestion): SuggestionResult | null => {
    const count = item.count ?? 0;
    const target = item.number ?? number;
    switch (item.code) {
      case "no-destination":
        return {
          reason: t("map.sug.noDestination"),
          prompt: t("map.sug.noDestinationPrompt", { number }),
        };
      case "fog-open":
        return {
          reason: t("map.sug.fogOpen", { count }),
          prompt: t("map.sug.fogOpenPrompt", { number, count }),
        };
      case "research-open":
        return {
          reason: t("map.sug.researchOpen", { number: target }),
          prompt: t("map.sug.researchOpenPrompt", { number: target }),
        };
      case "grilling-open":
        return {
          reason: t("map.sug.grillingOpen", { number: target }),
          prompt: t("map.sug.grillingOpenPrompt", { number: target }),
        };
      case "prototype-open":
        return {
          reason: t("map.sug.prototypeOpen", { number: target }),
          prompt: t("map.sug.prototypeOpenPrompt", { number: target }),
        };
      case "task-open":
        return {
          reason: t("map.sug.taskOpen", { number: target, count }),
          prompt: t("map.sug.taskOpenPrompt", { number: target }),
        };
      case "no-route":
        return {
          reason: t("map.sug.noRoute"),
          prompt: t("map.sug.noRoutePrompt", { number }),
        };
      case "all-closed":
        return {
          reason: t("map.sug.allClosed"),
          prompt: t("map.sug.allClosedPrompt", { number }),
        };
      default:
        return null;
    }
  };

  const data = query.data?.ok ? query.data : null;
  const failure = query.data && !query.data.ok ? query.data : null;

  return (
    <Modal title={t("map.title", { number })} open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Content>
        <View style={styles.body}>
          {failure ? (
            <PixelCard skin={skin} style={styles.cardBody}>
              <Text style={styles.error}>{staticText(t, FAILURE_KEYS[failure.reason] ?? "failure.read")}</Text>
              <Text style={styles.hint}>{failure.detail}</Text>
            </PixelCard>
          ) : null}
          {query.isPending ? <Text style={styles.hint}>{t("common.loading")}</Text> : null}

          {data ? (
            <>
              <View style={styles.row}>
                <Text style={[styles.head, styles.grow]} numberOfLines={2}>
                  #{data.issue.number} {data.issue.title}
                </Text>
                <Text style={styles.badge}>
                  {data.issue.state === "OPEN" ? t("issue.open") : t("issue.closed")}
                </Text>
              </View>

              <PixelCard skin={skin} style={styles.cardBody}>
                <PixelHead skin={skin} style={styles.head}>
                  {t("map.destination")}
                </PixelHead>
                <Text style={styles.text}>{data.map.destination || t("map.destinationEmpty")}</Text>
              </PixelCard>

              <PixelCard skin={skin} style={styles.cardBody}>
                <PixelHead skin={skin} style={styles.head}>
                  {t("map.nextSteps")}
                </PixelHead>
                {data.suggestions.length === 0 ? (
                  <Text style={styles.hint}>{t("map.nextStepsEmpty")}</Text>
                ) : (
                  data.suggestions.map((item) => {
                    const view = suggestionText(item);
                    if (!view) return null;
                    return (
                      <View key={item.code} style={styles.row}>
                        <Text style={[styles.text, styles.grow]}>{view.reason}</Text>
                        <PixelButton
                          skin={skin}
                          label={t("map.copyPrompt")}
                          onPress={() => copyPrompt(view.prompt)}
                        />
                      </View>
                    );
                  })
                )}
              </PixelCard>

              <PixelCard skin={skin} style={styles.cardBody}>
                <PixelHead skin={skin} style={styles.head}>
                  {t("map.route")}
                </PixelHead>
                {data.route.length === 0 ? (
                  <Text style={styles.hint}>{t("map.routeEmpty")}</Text>
                ) : (
                  data.route.map((item) => (
                    <View key={item.number} style={styles.row}>
                      <Text style={styles.badge}>{staticText(t, KIND_KEY[item.kind])}</Text>
                      <Text style={[styles.text, styles.grow]} numberOfLines={1}>
                        #{item.number} {item.title}
                      </Text>
                      <Text style={styles.meta}>
                        {item.state === "OPEN" ? t("issue.open") : t("issue.closed")}
                      </Text>
                    </View>
                  ))
                )}
              </PixelCard>

              <PixelCard skin={skin} style={styles.cardBody}>
                <PixelHead skin={skin} style={styles.head}>
                  {t("map.decisions")}
                </PixelHead>
                {data.map.decisions.length === 0 ? (
                  <Text style={styles.hint}>{t("map.decisionsEmpty")}</Text>
                ) : (
                  data.map.decisions.map((item, index) => (
                    <View key={`${item.title}-${index}`} style={styles.item}>
                      <Text style={styles.text}>{item.title}</Text>
                      {item.gist ? <Text style={styles.hint}>{item.gist}</Text> : null}
                      {item.url ? <Text style={styles.meta}>{item.url}</Text> : null}
                    </View>
                  ))
                )}
              </PixelCard>

              <PixelCard skin={skin} style={styles.cardBody}>
                <PixelHead skin={skin} style={styles.head}>
                  {t("map.fog")}
                </PixelHead>
                {data.map.fog.length === 0 ? (
                  <Text style={styles.hint}>{t("map.fogEmpty")}</Text>
                ) : (
                  data.map.fog.map((line, index) => (
                    <Text key={`fog-${index}`} style={styles.text}>
                      · {stripBullet(line)}
                    </Text>
                  ))
                )}
              </PixelCard>

              <PixelCard skin={skin} style={styles.cardBody}>
                <PixelHead skin={skin} style={styles.head}>
                  {t("map.outOfScope")}
                </PixelHead>
                {data.map.outOfScope.length === 0 ? (
                  <Text style={styles.hint}>{t("map.outOfScopeEmpty")}</Text>
                ) : (
                  data.map.outOfScope.map((line, index) => (
                    <Text key={`out-${index}`} style={styles.text}>
                      · {stripBullet(line)}
                    </Text>
                  ))
                )}
              </PixelCard>

              {data.map.notes ? (
                <PixelCard skin={skin} style={styles.cardBody}>
                  <PixelHead skin={skin} style={styles.head}>
                    {t("map.notes")}
                  </PixelHead>
                  <Text style={styles.text}>{data.map.notes}</Text>
                </PixelCard>
              ) : null}
            </>
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}
