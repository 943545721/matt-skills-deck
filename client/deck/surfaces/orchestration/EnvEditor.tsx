import { TextInput } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { PixelButton, type PixelSkin } from "../../pixel";
import type { PanelTextFn } from "../../panel/panelText";

/**
 * 一个 env 键的内联编辑器：输入框 + 保存 / 取消。
 *
 * 抽出来是因为「地址、凭据、高级变量、显示名」原本各抄了一份；四份的间距、
 * 空白校验和按钮文案必须一致，否则又会出现「地址能保存、凭据按钮点了没反应」
 * 这类只在某一条路径上的差异。空白串直接在按钮上禁用，和 `saveEdit` 的判据同源。
 */
export function EnvEditor({
  skin,
  t,
  value,
  busy,
  secure = false,
  label,
  placeholder,
  accessibilityLabel,
  onChange,
  onSave,
  onCancel,
}: {
  skin: PixelSkin;
  t: PanelTextFn;
  value: string;
  busy: boolean;
  /** 凭据类字段遮蔽输入；地址、模型名、显示名不遮蔽。 */
  secure?: boolean;
  /** 编辑行替换原行时补一个键名，避免多键环境下看错正在改哪一条。 */
  label?: string;
  placeholder?: string;
  accessibilityLabel?: string;
  onChange(value: string): void;
  onSave(): void;
  onCancel(): void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      {label ? (
        <Text style={{ color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily }}>{label}</Text>
      ) : null}
      <TextInput
        accessibilityLabel={accessibilityLabel}
        style={{ ...skin.input, flexGrow: 1, minWidth: 160 }}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder ?? t("orch.envValueNew")}
        placeholderTextColor={skin.colors.ink2}
        autoCapitalize="none"
        secureTextEntry={secure}
      />
      <PixelButton skin={skin} mini label={t("orch.saveEnv")} disabled={busy || !value.trim()} onPress={onSave} />
      <PixelButton skin={skin} mini variant="ghost" label={t("orch.cancel")} onPress={onCancel} />
    </View>
  );
}
