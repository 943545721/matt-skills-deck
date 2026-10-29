import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { ScrollView, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { InvalidMapReference, MapReference } from "../../../shared/map";
import { mapRpc } from "../../../shared/map";
import { FAILURE_KEYS, staticText, useDeckText } from "../i18n";
import { PixelBanner, PixelButton, PixelCard, PixelHead, usePixel } from "../pixel";
import { usePanelText, type PanelKey } from "./panelText";

/**
 * 地图详情（全屏，不是弹窗）。
 *
 * 导航栈里 board → map → issue 的中间层：地图页自己也能点开路线票，
 * 因此它必须是一个真正的页面，而不是盖在列表上的弹窗。
 *
 * 数据来自 `deck.map`，一次取回目标、五区块、路线、层级与下一步建议；
 * 界面不再自己算「哪张该先做」——服务端给的建议码在这里只做翻译。
 */

type MapRouteKind = "research" | "prototype" | "grilling" | "task";
type Readiness = "ready" | "claimed" | "blocked" | "closed";

const KIND_KEY: Record<MapRouteKind, PanelKey> = {
  research: "map.kind.research",
  prototype: "map.kind.prototype",
  grilling: "map.kind.grilling",
  task: "map.kind.task",
};

const GROUP_KEY: Record<Readiness, PanelKey> = {
  ready: "map.group.ready",
  claimed: "map.group.claimed",
  blocked: "map.group.blocked",
  closed: "map.group.closed",
};

const SUGGEST_KEY: Record<string, PanelKey> = {
  "no-destination": "map.suggest.no-destination",
  "fog-open": "map.suggest.fog-open",
  "research-open": "map.suggest.research-open",
  "grilling-open": "map.suggest.grilling-open",
  "prototype-open": "map.suggest.prototype-open",
  "task-open": "map.suggest.task-open",
  "no-route": "map.suggest.no-route",
  "all-closed": "map.suggest.all-closed",
};

/** `- ` 只是 Markdown 列表记号；界面逐条渲染时剥掉。 */
const stripBullet = (line: string) => line.replace(/^[-*]\s+/, "");

interface RouteItem {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  kind: MapRouteKind;
  readiness: Readiness;
}

export function MapDetailView({
  theme,
  workspaceDir,
  repoKey,
  number,
  containerKind = "map",
  onOpenIssue,
  onAction,
}: {
  theme: PluginTheme;
  workspaceDir: string;
  repoKey: string;
  number: number;
  containerKind?: "map" | "spec";
  onOpenIssue(number: number, containerKind?: "map" | "spec"): void;
  onAction(input: { kind: "inspect" | "execute" | "complete"; repoKey: string; number: number; title: string; containerKind: "map" | "spec"; url: string; total: number; closed: number }): void;
}) {
  const { t } = usePanelText();
  const text = useDeckText();
  const skin = usePixel(theme);
  const toast = useToast();
  const readMap = useRpc(mapRpc);

  const query = useQuery({
    queryKey: ["deck", "map", workspaceDir, repoKey, number],
    queryFn: () => readMap({ workspaceDir, repoKey, number }),
  });

  const data = query.data?.ok ? query.data : null;
  const route = data?.route ?? [];
  const total = data?.levels.reduce((sum, level) => sum + level.total, 0) ?? route.length;
  const closed = data?.levels.reduce((sum, level) => sum + level.closed, 0) ?? route.filter((item) => item.state === "CLOSED").length;
  const actionKind = total === 0 ? "inspect" : closed === total ? "complete" : "execute";
  const byNumber = new Map(route.map((item) => [item.number, item]));

  const styles = useMemo(
    () => ({
      screen: { flex: 1 },
      body: { gap: 10, paddingBottom: 20 },
      bar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      spacer: { marginLeft: "auto" as const },
      card: { padding: 10, gap: 6 },
      text: { color: skin.colors.ink, fontSize: 12, lineHeight: 18 },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily, lineHeight: 16 },
      error: skin.error,
      hint: skin.hint,
      onScreen: skin.hintOnChecker,
      title: { color: skin.colors.ink, fontSize: 15, fontWeight: "700" as const, lineHeight: 21 },
      section: { gap: 4 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      item: { gap: 1 },
      link: {
        color: skin.colors.link,
        fontSize: 12,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
        lineHeight: 18,
      },
      chip: {
        fontSize: 10,
        lineHeight: 16,
        paddingHorizontal: 6,
        borderWidth: 1,
        borderColor: skin.colors.line,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
      },
      routeRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
    }),
    [skin],
  );

  const toneOf = (readiness: Readiness) =>
    readiness === "ready"
      ? { backgroundColor: skin.colors.okBg, color: skin.colors.ok }
      : readiness === "claimed"
        ? { backgroundColor: skin.colors.warnBg, color: skin.colors.warnInk }
        : readiness === "blocked"
          ? { backgroundColor: skin.colors.badBg, color: skin.colors.bad }
          : { backgroundColor: skin.colors.stripe, color: skin.colors.ink2 };

  const copy = (value: string) => {
    void copyText(value)
      .then(() => toast.show(t("map.promptCopied"), { variant: "success" }))
      .catch(() => toast.error(t("common.copyFailed")));
  };

  const mapPrompt = (): string => {
    if (!data) return "";
    return [
      `Map #${data.issue.number}: ${data.issue.title}`,
      `${t("map.destination")}: ${data.map.destination || "—"}`,
      data.map.notes ? `${t("map.notes")}: ${data.map.notes}` : "",
      data.map.fog.length ? `${t("map.fog")}:\n${data.map.fog.map(stripBullet).join("\n")}` : "",
      data.map.decisions.length
        ? `${t("map.decisions")}:\n${data.map.decisions.map((item) => `- ${item.title}: ${item.gist}`).join("\n")}`
        : "",
      data.route.length
        ? `${t("map.route")}:\n${data.route
            .map((item) => `- #${item.number} [${t(KIND_KEY[item.kind])}/${t(GROUP_KEY[item.readiness])}] ${item.title}`)
            .join("\n")}`
        : "",
      data.issue.url,
      t("issue.promptAsk"),
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  if (query.isPending) {
    return <Text style={styles.onScreen}>{t("common.loading")}</Text>;
  }
  if (query.error) {
    return (
      <PixelBanner skin={skin}>
        <Text style={styles.error}>{query.error.message}</Text>
        <PixelButton skin={skin} label={t("common.retry")} onPress={() => void query.refetch()} />
      </PixelBanner>
    );
  }
  if (!data) {
    const failure = query.data && !query.data.ok ? query.data : null;
    return (
      <PixelBanner skin={skin}>
        <Text style={styles.error}>
          {failure ? staticText(text.t, FAILURE_KEYS[failure.reason] ?? "failure.read") : t("common.empty")}
        </Text>
        {failure ? <Text style={styles.hint}>{failure.detail}</Text> : null}
      </PixelBanner>
    );
  }

  const empty =
    !data.map.destination &&
    !data.map.notes &&
    data.map.decisions.length === 0 &&
    data.map.fog.length === 0 &&
    data.map.outOfScope.length === 0 &&
    data.route.length === 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <View style={styles.bar}>
        <Text style={styles.title} numberOfLines={2}>
          #{data.issue.number} {data.issue.title}
        </Text>
        <View style={styles.spacer} />
        <PixelButton
          skin={skin}
          label={containerKind === "spec"
            ? t(actionKind === "inspect" ? "map.action.split" : actionKind === "complete" ? "map.action.completeSpec" : "map.action.executeSpec")
            : t(actionKind === "inspect" ? "map.action.inspect" : actionKind === "complete" ? "map.action.complete" : "map.action.execute")}
          onPress={() => onAction({ kind: actionKind, repoKey, number, title: data.issue.title, containerKind, url: data.issue.url, total, closed })}
        />
        <PixelButton
          skin={skin}
          label={t("map.openWeb")}
          onPress={() => {
            void openExternalUrl(data.issue.url).catch((error: unknown) =>
              toast.error(error instanceof Error ? error.message : String(error)),
            );
          }}
        />
        <PixelButton skin={skin} label={t("map.copyPrompt")} onPress={() => copy(mapPrompt())} />
      </View>

      <PixelStatusLineText skin={skin} text={`${t("map.route")} · ${data.route.length}`} />

      {empty ? <Text style={styles.onScreen}>{t("map.empty")}</Text> : null}

      {data.containerKind === "spec" && data.spec ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <PixelHead skin={skin}>{t("map.specSections")}</PixelHead>
            {([
              ["map.specProblem", data.spec.problem],
              ["map.specSolution", data.spec.solution],
              ["map.specUserStories", data.spec.userStories],
              ["map.specImplDecisions", data.spec.implDecisions],
              ["map.specTestDecisions", data.spec.testDecisions],
              ["map.specOutOfScope", data.spec.outOfScope],
              ["map.specFurtherNotes", data.spec.furtherNotes],
            ] as const).map(([key, value]) => (
              <View key={key} style={styles.section}>
                <PixelHead skin={skin}>{t(key)}</PixelHead>
                {Array.isArray(value) ? value.map((line, index) => <Text key={`${key}-${index}`} style={styles.text}>· {stripBullet(line)}</Text>) : <Text style={styles.text}>{value || "—"}</Text>}
              </View>
            ))}
          </View>
        </PixelCard>
      ) : null}

      {data.containerKind !== "spec" && data.suggestions.length ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <PixelHead skin={skin}>{t("map.suggestions")}</PixelHead>
            {data.suggestions.map((suggestion) => (
              <View key={`${suggestion.code}-${suggestion.number ?? ""}-${suggestion.count ?? ""}`} style={styles.item}>
                <Text style={styles.text}>{t(SUGGEST_KEY[suggestion.code] ?? "map.suggest.no-route")}</Text>
                {suggestion.number ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("map.openIssue", { number: suggestion.number })}
                    onPress={() => onOpenIssue(suggestion.number as number)}
                  >
                    <Text style={styles.link}>#{suggestion.number}</Text>
                  </Pressable>
                ) : null}
                {suggestion.count ? (
                  <Text style={styles.meta}>{t("map.suggest.count", { count: suggestion.count })}</Text>
                ) : null}
              </View>
            ))}
          </View>
        </PixelCard>
      ) : null}

      <MapReferences skin={skin} references={data.references} invalidRefs={data.invalidRefs} />

      {data.containerKind !== "spec" && data.map.destination ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <PixelHead skin={skin}>{t("map.destination")}</PixelHead>
            <Text style={styles.text}>{data.map.destination}</Text>
            {data.map.notes ? <Text style={styles.meta}>{data.map.notes}</Text> : null}
          </View>
        </PixelCard>
      ) : null}

      {data.containerKind !== "spec" && data.map.decisions.length ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <PixelHead skin={skin}>{t("map.decisions")}</PixelHead>
            {data.map.decisions.map((decision, index) => (
              <View key={`${decision.title}-${index}`} style={styles.item}>
                <Pressable
                  accessibilityRole={decision.url ? "link" : "button"}
                  accessibilityLabel={decision.title}
                  disabled={!decision.url}
                  onPress={() => {
                    if (!decision.url) return;
                    void openExternalUrl(decision.url).catch((error: unknown) =>
                      toast.error(error instanceof Error ? error.message : String(error)),
                    );
                  }}
                >
                  <Text style={styles.link}>{decision.title}</Text>
                </Pressable>
                {decision.gist ? <Text style={styles.meta}>{decision.gist}</Text> : null}
              </View>
            ))}
          </View>
        </PixelCard>
      ) : null}

      {data.containerKind !== "spec" && (data.map.fog.length || data.map.outOfScope.length) ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            {data.map.fog.length ? (
              <View style={styles.section}>
                <PixelHead skin={skin}>{t("map.fog")}</PixelHead>
                {data.map.fog.map((line, index) => (
                  <Text key={`fog-${index}`} style={styles.text}>
                    · {stripBullet(line)}
                  </Text>
                ))}
              </View>
            ) : null}
            {data.map.outOfScope.length ? (
              <View style={styles.section}>
                <PixelHead skin={skin}>{t("map.outOfScope")}</PixelHead>
                {data.map.outOfScope.map((line, index) => (
                  <Text key={`oos-${index}`} style={styles.meta}>
                    · {stripBullet(line)}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        </PixelCard>
      ) : null}

      <PixelCard skin={skin}>
        <View style={styles.card}>
          <PixelHead skin={skin}>{t("map.route")}</PixelHead>
          {route.length === 0 ? <Text style={styles.meta}>{t("map.noRoute")}</Text> : null}
          {data.groups
            .filter((group) => group.numbers.length > 0)
            .map((group) => (
              <View key={group.readiness} style={styles.section}>
                <Text style={[styles.chip, toneOf(group.readiness)]}>{t(GROUP_KEY[group.readiness])}</Text>
                {group.numbers.map((ticketNumber) => {
                  const item: RouteItem | undefined = byNumber.get(ticketNumber);
                  if (!item) return null;
                  return (
                    <Pressable
                      key={ticketNumber}
                      accessibilityRole="button"
                      accessibilityLabel={`#${ticketNumber} ${item.title}`}
                      onPress={() => onOpenIssue(ticketNumber)}
                    >
                      <View style={styles.routeRow}>
                        <Text style={styles.link}>#{ticketNumber}</Text>
                        <Text style={[styles.chip, toneOf(item.readiness)]}>{t(KIND_KEY[item.kind])}</Text>
                        <Text style={styles.text}>{item.title}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ))}
        </View>
      </PixelCard>

      {data.levels.length ? (
        <PixelCard skin={skin}>
          <View style={styles.card}>
            <PixelHead skin={skin}>{t("map.levels")}</PixelHead>
            {data.levels.map((level) => (
              <Text key={level.level} style={styles.meta}>
                L{level.level} · {level.closed}/{level.total} · #{level.numbers.join(", #")}
              </Text>
            ))}
          </View>
        </PixelCard>
      ) : null}
    </ScrollView>
  );
}

/**
 * 跨项目引用列表。
 *
 * 只负责显示与跳转：状态是服务端读完对方那张票给的（读不到就如实显示「读不到」）。
 * 跨仓库的票用外链打开——本板没有对方仓库的票，假装能在这里打开只会点出一页空白。
 * 引用失效的条目单独占一行说清楚，不混进正常列表里，也不静默消失。
 */
/** 引用链接的字样：与路线票号同一套（强调色、等宽、粗体）。 */
const mapRefLinkStyle = (skin: ReturnType<typeof usePixel>) => ({
  color: skin.colors.link,
  fontSize: 12,
  fontFamily: skin.mono.fontFamily,
  fontWeight: "700" as const,
  lineHeight: 18,
});

/** 对方状态的小徽标：开着绿、已关灰、读不到红（读不到不能显示成「已解除」）。 */
const mapRefTone = (skin: ReturnType<typeof usePixel>, state: MapReference["state"], stale: boolean) =>
  state === "OPEN" && !stale
    ? { backgroundColor: skin.colors.okBg, color: skin.colors.ok }
    : state === "CLOSED" && !stale
      ? { backgroundColor: skin.colors.stripe, color: skin.colors.ink2 }
      : { backgroundColor: skin.colors.badBg, color: skin.colors.bad };

type MapRefT = ReturnType<typeof usePanelText>["t"];

function mapRefStateText(t: MapRefT, state: MapReference["state"]): string {
  if (state === "OPEN") return t("mapRef.stateOpen");
  if (state === "CLOSED") return t("mapRef.stateClosed");
  return t("mapRef.stateUnknown");
}

function MapReferences({
  skin,
  references,
  invalidRefs,
}: {
  skin: ReturnType<typeof usePixel>;
  references: readonly MapReference[];
  invalidRefs: readonly InvalidMapReference[];
}) {
  const { t } = usePanelText();
  if (references.length === 0 && invalidRefs.length === 0) return null;
  return (
    <PixelCard skin={skin}>
      <View style={{ padding: 10, gap: 6 }}>
        <PixelHead skin={skin}>{t("mapRef.title")}</PixelHead>
        {references.map((reference) => (
          <MapReferenceRow key={`${reference.repo}#${reference.number}`} skin={skin} reference={reference} />
        ))}
        {invalidRefs.map((item) => (
          <Text key={item.text} style={skin.error}>
            {t("mapRef.invalid", { ref: item.text, detail: item.detail })}
          </Text>
        ))}
      </View>
    </PixelCard>
  );
}

/** 一条跨项目引用：能点开的点开（外链），读不到的单列一行「引用失效」。 */
function MapReferenceRow({
  skin,
  reference,
}: {
  skin: ReturnType<typeof usePixel>;
  reference: MapReference;
}) {
  const { t } = usePanelText();
  const toast = useToast();
  const label = `${reference.repo}#${reference.number}`;
  const openable = reference.url !== null && !reference.stale;
  return (
    <View style={{ gap: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {openable ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t("mapRef.open", { ref: label })}
            onPress={() => {
              const url = reference.url;
              if (!url) return;
              void openExternalUrl(url).catch((error: unknown) =>
                toast.error(error instanceof Error ? error.message : String(error)),
              );
            }}
          >
            <Text style={mapRefLinkStyle(skin)}>{label}</Text>
          </Pressable>
        ) : (
          <Text style={skin.statuslineText}>{label}</Text>
        )}
        <Text style={{ color: skin.colors.ink, fontSize: 12, lineHeight: 18 }}>{reference.title}</Text>
        <Text
          style={[
            skin.chip,
            skin.chipText,
            { fontSize: 10, lineHeight: 16, paddingHorizontal: 6, borderWidth: 1, borderColor: skin.colors.line },
            mapRefTone(skin, reference.state, reference.stale),
          ]}
        >
          {mapRefStateText(t, reference.state)}
        </Text>
      </View>
      {reference.stale ? <Text style={skin.error}>{t("mapRef.stale", { ref: label })}</Text> : null}
    </View>
  );
}

/** 一行小状态字；单独抽出来避免在 JSX 里重复样式拼装。 */
function PixelStatusLineText({
  skin,
  text,
}: {
  skin: ReturnType<typeof usePixel>;
  text: string;
}) {
  return <Text style={skin.statuslineText}>{text}</Text>;
}
