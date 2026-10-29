import { useMemo } from "react";
import { Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useDeckText } from "../i18n";
import type { PixelSkin } from "../pixel";
import { PixelButton } from "../pixel";
import { usePanelText } from "../panel/panelText";

/**
 * 任务板的筛选条：搜索 × 标签 × 模块（area）× 角色（role），四维叠加。
 *
 * 从 BoardView 抽出来只为一件事：项目条与筛选条加进去之后，主文件会顶到行数上限，
 * 而这两块都是「只读入参、只回调用」的纯展示，抽走不影响任何判定逻辑。
 *
 * 四维之间是「与」：选 area 只会在当前视图与搜索命中的票里再筛一层。
 * 每一维都是可清空的一行按钮，不做下拉——面板是窄的，下拉在窄屏上比按钮更难用。
 */
export function BoardFilters({
  skin,
  search,
  onSearch,
  label,
  labelDraft,
  onLabelDraftChange,
  onApplyLabel,
  onClearLabel,
  areas,
  area,
  onArea,
  roles,
  role,
  onRole,
}: {
  skin: PixelSkin;
  search: string;
  onSearch(value: string): void;
  label: string;
  labelDraft: string;
  onLabelDraftChange(value: string): void;
  onApplyLabel(): void;
  onClearLabel(): void;
  areas: readonly string[];
  area: string;
  onArea(area: string): void;
  roles: readonly string[];
  role: string;
  onRole(role: string): void;
}) {
  const { t } = useDeckText();
  const { t: pt } = usePanelText();
  const styles = useMemo(
    () => ({
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      facetRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, flexWrap: "wrap" as const },
      sectionLabel: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily, marginRight: 2 },
      labelInput: { ...skin.input, width: 130, paddingVertical: 3, paddingHorizontal: 6, fontSize: 11 },
      searchInput: { ...skin.input, flexGrow: 1, minWidth: 160, paddingVertical: 3, paddingHorizontal: 6, fontSize: 11 },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
    }),
    [skin],
  );

  const facetRow = (title: string, values: readonly string[], active: string, pick: (value: string) => void, open: () => void) => (
    <View style={styles.facetRow}>
      <Text style={styles.sectionLabel}>{title}</Text>
      <PixelButton skin={skin} mini variant="tab" label={t("board.filterAll")} active={active === ""} onPress={open} />
      {values.map((value) => (
        <PixelButton
          key={value}
          skin={skin}
          mini
          variant="tab"
          label={value}
          active={active === value}
          onPress={() => pick(active === value ? "" : value)}
        />
      ))}
    </View>
  );

  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.meta}>{t("board.filterHint")}</Text>
      <View style={styles.toolbar}>
        <TextInput
          accessibilityLabel={pt("board.searchPlaceholder")}
          style={styles.searchInput}
          value={search}
          onChangeText={onSearch}
          placeholder={pt("board.searchPlaceholder")}
          placeholderTextColor={skin.colors.ink2}
          autoCapitalize="none"
        />
        {search ? (
          <PixelButton skin={skin} mini variant="ghost" label={pt("board.searchClear")} onPress={() => onSearch("")} />
        ) : null}
        <TextInput
          accessibilityLabel={t("board.labelFilter")}
          style={styles.labelInput}
          value={labelDraft}
          onChangeText={onLabelDraftChange}
          onSubmitEditing={onApplyLabel}
          placeholder={t("board.labelFilterPlaceholder")}
          placeholderTextColor={skin.colors.ink2}
          autoCapitalize="none"
        />
        <PixelButton skin={skin} label={t("board.apply")} onPress={onApplyLabel} />
        {label ? (
          <PixelButton skin={skin} variant="ghost" label={t("board.clear", { label })} onPress={onClearLabel} />
        ) : null}
      </View>
      {areas.length ? facetRow(t("board.filterArea"), areas, area, onArea, () => onArea("")) : null}
      {roles.length ? facetRow(t("board.filterRole"), roles, role, onRole, () => onRole("")) : null}
    </View>
  );
}
