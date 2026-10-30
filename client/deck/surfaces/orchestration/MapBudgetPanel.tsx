import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { MAX_MAP_CONCURRENCY, normalizeMapRef } from "../../../../shared/orchestration.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton, PixelHead } from "../../pixel.tsx";
import type { OrchestrationSettings } from "./types.ts";

/**
 * 地图并发预算：一张地图同一时刻最多几个子会话在干活。
 *
 * 为什么单列一块而不是塞进「限制」的两个计数器里：那两个是全局数字，这个是**按图**的，
 * 一张图一行。没有条目的图不受限——「没配」和「配成 0」不是一回事，界面不替人补默认值。
 *
 * 没有「保存」按钮：和这一页其它字段一样，改一下就走整份保存（服务端再归一一次）。
 */
export function MapBudgetPanel({
  skin,
  t,
  settings,
  busy,
  onChange,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  settings: OrchestrationSettings;
  busy?: boolean;
  /** `concurrency` 为 null 表示删掉这条。 */
  onChange(map: string, concurrency: number | null): void;
}) {
  const [draft, setDraft] = useState("");
  // 输入框里的写法先归一一次：写错了当场说，别等保存后变成一条不生效的预算。
  const draftRef = normalizeMapRef(draft);
  const styles = useMemo(
    () => ({
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 4 },
      name: { color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily, flex: 1 },
      hint: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      divider: { borderTopWidth: 1, borderTopColor: skin.colors.line, marginVertical: 6 },
    }),
    [skin],
  );

  return (
    <View style={{ gap: 4 }}>
      <PixelHead skin={skin}>{t("orch.mapBudget")}</PixelHead>
      <Text style={styles.hint}>{t("orch.mapBudgetHint")}</Text>

      {settings.mapBudgets.length === 0 ? (
        <Text style={styles.hint}>{t("orch.mapBudgetEmpty")}</Text>
      ) : (
        settings.mapBudgets.map((budget) => (
          <View key={budget.map} style={styles.row}>
            <Text style={styles.name}>{budget.map}</Text>
            <PixelButton
              skin={skin}
              mini
              label="−"
              disabled={busy || budget.concurrency <= 1}
              onPress={() => onChange(budget.map, Math.max(1, budget.concurrency - 1))}
            />
            <Text style={[skin.num, { color: skin.colors.ink, fontSize: 13, minWidth: 22, textAlign: "center" }]}>
              {budget.concurrency}
            </Text>
            <PixelButton
              skin={skin}
              mini
              label="+"
              disabled={busy || budget.concurrency >= MAX_MAP_CONCURRENCY}
              onPress={() => onChange(budget.map, Math.min(MAX_MAP_CONCURRENCY, budget.concurrency + 1))}
            />
            <PixelButton
              skin={skin}
              mini
              variant="ghost"
              label={t("orch.mapBudgetRemove")}
              disabled={busy}
              onPress={() => onChange(budget.map, null)}
            />
          </View>
        ))
      )}

      <View style={styles.divider} />
      <View style={styles.row}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t("orch.mapBudgetInvalid")}
          accessibilityLabel={t("orch.mapBudgetMap")}
          editable={!busy}
          style={{ flex: 1, fontSize: 12, color: skin.colors.ink, fontFamily: skin.mono.fontFamily }}
        />
        <PixelButton
          skin={skin}
          mini
          label={t("orch.mapBudgetAdd")}
          disabled={busy || !draftRef}
          onPress={() => {
            if (!draftRef) return;
            // 新条目给 3：比「先给 1 再改」少一步，也不会一上来就把一张图灌满。
            onChange(draftRef, 3);
            setDraft("");
          }}
        />
      </View>
      {draft && !draftRef ? <Text style={styles.hint}>{t("orch.mapBudgetInvalid")}</Text> : null}
    </View>
  );
}
