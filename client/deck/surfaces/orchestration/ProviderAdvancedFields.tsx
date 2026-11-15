import { Pressable, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { isModelEnvKey } from "../../../../shared/provider-models.ts";
import type { PanelTextFn } from "../../panel/panelText.tsx";
import { PixelButton, type PixelSkin } from "../../pixel.tsx";
import { EnvEditor } from "./EnvEditor.tsx";
import type { ProviderRow } from "./types.ts";

type FieldEditor = {
  field: string | null;
  value: string;
  start(field: string, value: string): void;
  change(value: string): void;
  save(field: string): void;
  cancel(): void;
};
type EnvReveal = {
  current: { key: string; value: string | null; bad: string | null } | null;
  busy: boolean;
  show(key: string): void;
  hide(): void;
};
type EnvAddition = {
  key: string;
  value: string;
  changeKey(key: string): void;
  changeValue(value: string): void;
};
type AdvancedProps = {
  skin: PixelSkin;
  t: PanelTextFn;
  provider: ProviderRow;
  baseUrlKey: string;
  open: boolean;
  busy: boolean;
  editor: FieldEditor;
  reveal: EnvReveal;
  addition: EnvAddition;
  onToggle(): void;
  onSaveEnv(env: Record<string, string>): void;
};

function stylesOf(skin: PixelSkin) {
  return {
    toggle: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: skin.colors.line },
    head: { color: skin.colors.ink2, fontSize: 12, fontFamily: skin.mono.fontFamily },
    body: { gap: 6, paddingBottom: 8 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8,
      paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: skin.colors.line },
    name: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily, maxWidth: "55%" as const },
    value: { color: skin.colors.ink, fontSize: 11, fontFamily: skin.mono.fontFamily },
    dim: { color: skin.colors.ink2, fontSize: 12, lineHeight: 18 },
    tier: { color: skin.colors.ink2, fontSize: 9, fontFamily: skin.mono.fontFamily, opacity: 0.75 },
    revealed: { color: skin.colors.ink, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily, flexShrink: 1 },
    bad: { color: skin.colors.bad, fontSize: 11, lineHeight: 16 },
    form: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
    input: { ...skin.input, flexGrow: 1, minWidth: 160 },
  };
}
type Styles = ReturnType<typeof stylesOf>;
type FieldProps = Pick<AdvancedProps, "skin" | "t" | "busy" | "editor">;

function AdvancedEditor({ skin, t, busy, editor, field, label, secure }: FieldProps & {
  field: string; label: string; secure?: boolean;
}) {
  return <EnvEditor skin={skin} t={t} busy={busy} value={editor.value} secure={secure}
    label={field === "name" ? undefined : label}
    placeholder={field === "name" ? label : undefined}
    accessibilityLabel={field === "name" ? t("orch.field.name") : label}
    onChange={editor.change} onSave={() => editor.save(field)} onCancel={editor.cancel} />;
}

function ProviderIdentity({ skin, t, busy, editor, provider, styles }: FieldProps & {
  provider: ProviderRow; styles: Styles;
}) {
  return <>
    <View style={styles.row}>
      <Text style={styles.name}>{t("orch.field.id")}</Text>
      <Text style={styles.value} selectable numberOfLines={1}>{provider.id}</Text>
      {provider.extends ? <Text style={styles.dim} numberOfLines={1}>
        {t("orch.extendsOf", { provider: provider.extends })}
      </Text> : null}
      <View style={{ flex: 1 }} />
      {editor.field !== "name" ? <PixelButton skin={skin} mini variant="ghost" label={t("orch.rename")}
        disabled={busy} onPress={() => editor.start("name", provider.label ?? "")} /> : null}
    </View>
    {editor.field === "name" ? <AdvancedEditor skin={skin} t={t} busy={busy} editor={editor}
      field="name" label={provider.id} /> : null}
  </>;
}

function EnvValue({ item, reveal, styles }: {
  item: ProviderRow["env"][number]; reveal: EnvReveal; styles: Styles;
}) {
  const current = reveal.current?.key === item.key ? reveal.current : null;
  if (!current) return <Text style={item.masked ? styles.dim : styles.value}>{item.display}</Text>;
  return current.value !== null
    ? <Text style={styles.revealed} selectable numberOfLines={3}>{current.value}</Text>
    : <Text style={styles.bad} numberOfLines={2}>{current.bad}</Text>;
}

function AdvancedEnvRow({ skin, t, busy, editor, reveal, item, styles }: FieldProps & {
  reveal: EnvReveal; item: ProviderRow["env"][number]; styles: Styles;
}) {
  const field = `env:${item.key}`;
  if (editor.field === field) return <AdvancedEditor skin={skin} t={t} busy={busy} editor={editor}
    field={field} label={item.key} secure={item.masked} />;
  const showing = reveal.current?.key === item.key;
  return <View style={styles.row}>
    <Text style={styles.name} numberOfLines={1}>{item.key}</Text>
    {isModelEnvKey(item.key) ? <Text style={styles.tier}>{t("orch.envModelTag")}</Text> : null}
    <EnvValue item={item} reveal={reveal} styles={styles} />
    <View style={{ flex: 1 }} />
    {item.masked || showing ? <PixelButton skin={skin} mini variant="ghost"
      label={showing ? t("orch.envHide") : reveal.busy ? t("orch.envRevealing") : t("orch.envReveal")}
      disabled={reveal.busy} onPress={() => showing ? reveal.hide() : reveal.show(item.key)} /> : null}
    <PixelButton skin={skin} mini variant="ghost" label={t("orch.envEdit")} disabled={busy}
      onPress={() => editor.start(field, "")} />
  </View>;
}

function AdditionalEnvForm({ skin, t, busy, addition, onSaveEnv, styles }: Pick<AdvancedProps,
  "skin" | "t" | "busy" | "addition" | "onSaveEnv"
> & { styles: Styles }) {
  const save = () => {
    const key = addition.key.trim();
    if (!key || !addition.value) return;
    onSaveEnv({ [key]: addition.value });
    addition.changeKey("");
    addition.changeValue("");
  };
  return <View style={styles.form}>
    <TextInput accessibilityLabel={t("orch.envKeyField")} style={styles.input}
      value={addition.key} onChangeText={addition.changeKey} placeholder="ANTHROPIC_BASE_URL"
      placeholderTextColor={skin.colors.ink2} autoCapitalize="none" />
    <TextInput accessibilityLabel={t("orch.envValueField")} style={styles.input}
      value={addition.value} onChangeText={addition.changeValue} placeholder={t("orch.envValueField")}
      placeholderTextColor={skin.colors.ink2} autoCapitalize="none" secureTextEntry />
    <PixelButton skin={skin} mini label={t("orch.saveEnv")} disabled={busy || !addition.key.trim() || !addition.value}
      onPress={save} />
  </View>;
}

/** 高级字段沿用卡片的编辑/显示状态，折叠时由卡片取消当前编辑。 */
export function ProviderAdvancedFields(props: AdvancedProps) {
  const { skin, t, provider, baseUrlKey, open, busy, editor, reveal, addition, onToggle, onSaveEnv } = props;
  const styles = stylesOf(skin);
  const otherKeys = provider.env.filter((item) => item.key !== baseUrlKey && !provider.credentialKeys.includes(item.key));
  return <>
    <Pressable style={styles.toggle} accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onToggle}>
      <Text style={styles.head}>{open ? "⌄" : "›"} {t("orch.field.advanced")}</Text>
    </Pressable>
    {open ? <View style={styles.body}>
      <ProviderIdentity skin={skin} t={t} busy={busy} editor={editor} provider={provider} styles={styles} />
      <View style={{ gap: 0 }}>
        {otherKeys.length === 0 ? <Text style={styles.dim}>{t("orch.noEnv")}</Text> : null}
        {otherKeys.map((item) => <AdvancedEnvRow key={item.key} skin={skin} t={t} busy={busy}
          editor={editor} reveal={reveal} item={item} styles={styles} />)}
      </View>
      <Text style={skin.hint}>{t("orch.envModelNote")}</Text>
      <AdditionalEnvForm skin={skin} t={t} busy={busy} addition={addition} onSaveEnv={onSaveEnv} styles={styles} />
      <Text style={skin.hint}>{t("orch.envMergeOnly")}</Text>
    </View> : null}
  </>;
}
