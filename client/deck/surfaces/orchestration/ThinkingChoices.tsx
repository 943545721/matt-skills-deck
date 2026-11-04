import { useMemo } from "react";
import { Text, View } from "react-native";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { ThinkingChoicesState } from "./types.ts";

/**
 * 从宿主为**这个模型**报出的推理档位里点一个。
 *
 * 选项一律来自快照（`ProviderRow.modelThinking`），这里不写死任何档位 id；
 * 模型没报档位时整块不渲染，调用方的手填框仍然在，用户照样能写一个 id。
 * 写回由调用方决定：档案页写草稿，路由页写 `target.thinkingOptionId`。
 */
export function ThinkingChoices({
  skin,
  t,
  state,
  current,
  onPick,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  state: ThinkingChoicesState;
  /** 当前选中的档位 id；没有就是 null（新建会话仍走模型默认）。 */
  current: string | null;
  onPick(thinkingOptionId: string): void;
}) {
  const styles = useMemo(
    () => ({
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4, marginTop: 4 },
      hint: skin.hint,
    }),
    [skin],
  );

  if (state.kind === "none") return null;
  // 用户还没选时，把「不选会走哪个档」说清楚；不替他写进配置。
  const defaultChoice = current ? undefined : state.options.find((option) => option.id === state.defaultOptionId);

  return (
    <>
      <Text style={styles.meta}>{t("orch.thinkingChoices.pick")}</Text>
      <View style={styles.chips}>
        {state.options.map((option) => (
          <PixelButton
            key={option.id}
            skin={skin}
            mini
            variant="tab"
            active={current === option.id}
            label={option.label}
            accessibilityLabel={option.description ? `${option.label} — ${option.description}` : option.label}
            onPress={() => onPick(option.id)}
          />
        ))}
      </View>
      {defaultChoice ? (
        <Text style={styles.hint}>{t("orch.thinkingChoices.default", { name: defaultChoice.label })}</Text>
      ) : null}
      {/* 调用方的输入框紧跟在这一行下面（两处都是），留给宿主没报的档位。 */}
      <Text style={styles.meta}>{t("orch.thinkingChoices.manual")}</Text>
    </>
  );
}
