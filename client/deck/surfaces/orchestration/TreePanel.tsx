import { useMemo } from "react";
import { Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { PixelBanner, type PixelSkin } from "../../pixel.tsx";
import type { PanelKey } from "../../panel/panelText.tsx";
import { DIFFICULTY_KEY, type IdentityGap, type TreeNode } from "./types.ts";

/**
 * 会话树：谁派了谁、每一支用的哪个客户端、有没有写回传。
 *
 * 层级用缩进而不是框：这是一棵树，多画十几个方块只会遮住结构。
 * 括号里的难度与票号就是回传时父窗口需要的第一手信息。
 */
export function TreePanel({
  skin,
  t,
  tree,
  identityGaps,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  tree: TreeNode[];
  /** deck MCP 进程没拿到会话身份的窗口；服务端已按打开时间倒序、滤掉关掉的窗口。 */
  identityGaps: IdentityGap[];
}) {
  const styles = useMemo(
    () => ({
      screen: { flex: 1 },
      row: { paddingVertical: 3, gap: 1 },
      title: { color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      hint: { ...skin.hint, marginBottom: 8 },
      banner: { marginBottom: 8 },
    }),
    [skin],
  );

  // 按 lastAt 取最近一次被拒：服务端是按「窗口什么时候打开」倒序的，直接取第一条会报错人。
  // ISO 时间串在同一时区下逐字符比较与按时间比较等价。
  const latest = identityGaps.reduce<IdentityGap | null>(
    (best, gap) => (gap.lastAt && (!best?.lastAt || gap.lastAt > best.lastAt) ? gap : best),
    null,
  );
  const latestTool = latest?.lastTool ?? null;

  const count = (nodes: TreeNode[]): number =>
    nodes.reduce((total, node) => total + 1 + count(node.children), 0);

  const render = (node: TreeNode, depth: number) => (
    <View key={node.agentId} style={styles.row}>
      <View style={{ paddingLeft: depth * 14 }}>
        <Text style={styles.title} numberOfLines={1}>
          {depth === 0 ? "▸ " : "└ "}
          {node.title ?? t("orch.untitled")}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {node.provider ?? "?"}
          {node.model ? `/${node.model}` : ""}
          {node.status ? ` · ${node.status}` : ""}
          {node.difficulty ? ` · ${t(DIFFICULTY_KEY[node.difficulty] as PanelKey)}` : ""}
          {node.ticketKey ? ` · #${node.ticketKey}` : ""}
          {node.crossWorkspace ? ` · ${t("orch.crossWorkspace")}` : ""}
        </Text>
      </View>
      {node.children.map((child) => render(child, depth + 1))}
    </View>
  );

  // 缺身份的窗口在这里点名：它不会从会话列表里消失，但回传、派单、要人都会失败。
  const banner = identityGaps.length ? (
    <PixelBanner skin={skin} tone="warning" style={styles.banner}>
      <Text style={skin.bannerText}>{t("orch.identityMissing", { n: identityGaps.length })}</Text>
      {latestTool ? <Text style={styles.meta}>{t("orch.identityMissingLast", { tool: latestTool })}</Text> : null}
    </PixelBanner>
  ) : null;

  if (tree.length === 0) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 16 }}>
        {banner}
        <Text style={styles.hint}>{t("orch.treeEmpty")}</Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 16 }}>
      {banner}
      <Text style={styles.hint}>{t("orch.treeHint", { n: count(tree) })}</Text>
      {tree.map((node) => render(node, 0))}
    </ScrollView>
  );
}
