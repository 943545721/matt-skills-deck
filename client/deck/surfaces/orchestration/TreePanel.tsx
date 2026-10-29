import { useMemo } from "react";
import { Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import type { PixelSkin } from "../../pixel.tsx";
import type { PanelKey } from "../../panel/panelText.tsx";
import { DIFFICULTY_KEY, type TreeNode } from "./types.ts";

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
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  tree: TreeNode[];
}) {
  const styles = useMemo(
    () => ({
      screen: { flex: 1 },
      row: { paddingVertical: 3, gap: 1 },
      title: { color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      hint: { ...skin.hint, marginBottom: 8 },
    }),
    [skin],
  );

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
        </Text>
      </View>
      {node.children.map((child) => render(child, depth + 1))}
    </View>
  );

  if (tree.length === 0) {
    return <Text style={styles.hint}>{t("orch.treeEmpty")}</Text>;
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 16 }}>
      <Text style={styles.hint}>{t("orch.treeHint", { n: count(tree) })}</Text>
      {tree.map((node) => render(node, 0))}
    </ScrollView>
  );
}
