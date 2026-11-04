import { useMemo } from "react";
import { Text, View } from "react-native";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { ModelChoicesState } from "./types.ts";

/**
 * 从一个客户端**认得**的模型里点一个（`ProviderRow.models`：宿主内置 + 配置里声明的）。
 *
 * 只负责列出与回调，写回由调用方决定：路由页写 `target.model`，档案页写草稿里的模型字段。
 * 哪种情况该说什么话由 `modelChoicesOf` 判定，这里只照着念——三种空清单混成一句
 * 「没有模型」会把「客户端没了」说成「你不用挑」，用户就照着去手打一个没人认的 id。
 *
 * 与 `ModelPicker` 不是同一件事：那个是「维护我们自己接口的模型清单」（可增删、写回宿主配置），
 * 这个是「在一份既成清单里挑一个」。
 */
export function ModelChoices({
  skin,
  t,
  state,
  current,
  onPick,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  state: ModelChoicesState;
  /** 当前选中的模型 id；没有就是 null。 */
  current: string | null;
  onPick(model: string): void;
}) {
  const styles = useMemo(
    () => ({
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4, marginTop: 4 },
      hint: skin.hint,
      bad: skin.error,
    }),
    [skin],
  );

  // 没有可点的东西时，只留一句说清为什么，不再印「选一个模型」的标题。
  if (state.kind === "host-empty") return <Text style={styles.hint}>{t("orch.modelChoices.hostEmpty")}</Text>;
  if (state.kind === "no-client") return <Text style={styles.hint}>{t("orch.modelChoices.clientFirst")}</Text>;
  if (state.kind === "unknown-client") {
    return <Text style={styles.bad}>{t("orch.modelChoices.clientUnknown", { provider: state.provider })}</Text>;
  }

  return (
    <>
      <Text style={styles.meta}>{t("orch.modelChoices.pick")}</Text>
      {state.models.length === 0 ? (
        <Text style={styles.hint}>{t("orch.modelChoices.noModels")}</Text>
      ) : (
        <View style={styles.chips}>
          {state.models.map((candidate) => (
            <PixelButton
              key={candidate}
              skin={skin}
              mini
              variant="tab"
              active={current === candidate}
              label={candidate}
              onPress={() => onPick(candidate)}
            />
          ))}
        </View>
      )}
      {/* 调用方的输入框就紧跟在这一行下面（两处都是）。 */}
      <Text style={styles.meta}>{t("orch.modelChoices.manual")}</Text>
    </>
  );
}
