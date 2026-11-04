import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/ui";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";
import { thinkingDefaultOf, type ModelThinkingDefault } from "./modelThinking.ts";
import { thinkingChoicesOf, type ProviderRow, type ThinkingChoice } from "./types.ts";

/**
 * 模型清单里每个模型自己的默认思考档位。
 *
 * 与 `ModelPicker` 分开：那边维护「这个接口提供哪些模型」，这里只给已选模型配默认档，
 * 不动模型清单的读写与镜像语义。
 *
 * 选项一律来自宿主快照（`thinkingChoicesOf`），不写死任何档位 id；宿主没为这个模型
 * 报档位时只留手填。没配默认档时行上不印占位符——「没配」就是什么都不显示，
 * 派单时也不会带档位。
 */
export function ModelThinkingList({
  skin,
  t,
  provider,
  models,
  providers,
  defaults,
  busy,
  onSet,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  provider: string;
  /** 这个客户端已选的模型（与模型清单同一份）。 */
  models: string[];
  /** 宿主为各模型报出的档位，按 provider + model 查。 */
  providers: ProviderRow[];
  defaults: readonly ModelThinkingDefault[];
  busy: boolean;
  /** `null` = 清掉这个模型的默认档。 */
  onSet(model: string, thinkingOptionId: string | null): void;
}) {
  const styles = useMemo(() => buildStyles(skin), [skin]);

  if (models.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.hint}>{t("orch.modelThinking.hint")}</Text>
      {models.map((model) => (
        <ModelThinkingRow
          key={model}
          row={{ skin, t, styles, provider, model, providers, busy, onSet }}
          defaults={defaults}
        />
      ))}
    </View>
  );
}

/** 一行要用的上下文（列表传给行，再由行传给下面的两种编辑方式）。 */
type RowContext = {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  styles: RowStyles;
  provider: string;
  model: string;
  providers: ProviderRow[];
  busy: boolean;
  onSet(model: string, thinkingOptionId: string | null): void;
};

/** 一个模型的默认档：模型名 + 当前值 + 清除，下面是 chips 或手填。 */
function ModelThinkingRow({ row, defaults }: { row: RowContext; defaults: readonly ModelThinkingDefault[] }) {
  const current = thinkingDefaultOf(defaults, row.provider, row.model);
  const choices = thinkingChoicesOf(row.provider, row.model, row.providers);
  return (
    <View style={row.styles.row}>
      <View style={row.styles.head}>
        <Text style={row.styles.model} numberOfLines={1}>
          {row.model}
        </Text>
        {current ? (
          <>
            <Text style={row.styles.current}>{current}</Text>
            <PixelButton
              skin={row.skin}
              mini
              variant="ghost"
              label={row.t("orch.clear")}
              accessibilityLabel={row.t("orch.modelThinking.clearOne", { model: row.model })}
              disabled={row.busy}
              onPress={() => row.onSet(row.model, null)}
            />
          </>
        ) : null}
      </View>
      {/* 宿主报了才出可点的档位；没报就只剩手填，不替用户补一份写死的列表。 */}
      {choices.kind === "ok" ? (
        <ThinkingChips row={row} current={current} options={choices.options} />
      ) : (
        <ThinkingManual row={row} />
      )}
    </View>
  );
}

/** 宿主为该模型报出的档位。点已生效的那一档是无操作：清除有单独的按钮。 */
function ThinkingChips({ row, current, options }: { row: RowContext; current: string | null; options: ThinkingChoice[] }) {
  return (
    <View style={row.styles.chips}>
      {options.map((option) => (
        <PixelButton
          key={option.id}
          skin={row.skin}
          mini
          variant="tab"
          active={current === option.id}
          label={option.label}
          accessibilityLabel={option.description ? `${option.label} — ${option.description}` : option.label}
          disabled={row.busy}
          onPress={() => {
            if (current === option.id) return;
            row.onSet(row.model, option.id);
          }}
        />
      ))}
    </View>
  );
}

/** 宿主没报档位时的手填；草稿跟着这一行走，模型被移除时一起消失。 */
function ThinkingManual({ row }: { row: RowContext }) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const id = draft.trim();
    if (!id) return;
    row.onSet(row.model, id);
    setDraft("");
  };
  return (
    <View style={row.styles.form}>
      <TextInput
        accessibilityLabel={row.t("orch.modelThinking.manual", { model: row.model })}
        style={row.styles.input}
        value={draft}
        onChangeText={setDraft}
        placeholder={row.t("orch.modelThinking.manual", { model: row.model })}
        placeholderTextColor={row.skin.colors.ink2}
        autoCapitalize="none"
      />
      <PixelButton
        skin={row.skin}
        mini
        label={row.t("orch.modelThinking.set")}
        disabled={row.busy || !draft.trim()}
        onPress={submit}
      />
    </View>
  );
}

/** 列表与行共用一份样式：行里只渲染，不再各建一次样式表。 */
function buildStyles(skin: PixelSkin) {
  return {
    wrap: { gap: 6 },
    hint: skin.hint,
    row: {
      gap: 4,
      paddingTop: 6,
      borderTopWidth: 1,
      borderTopColor: skin.colors.line,
    },
    head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
    model: { color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily },
    current: { color: skin.colors.acc, fontSize: 11, fontFamily: skin.mono.fontFamily },
    chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
    form: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
    input: { ...skin.input, flexGrow: 1, minWidth: 140 },
  };
}

type RowStyles = ReturnType<typeof buildStyles>;
