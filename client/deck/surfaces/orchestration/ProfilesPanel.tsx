import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { TextInput } from "@getpaseo/plugin/client/ui";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton, PixelCard, PixelHead } from "../../pixel.tsx";
import type { PanelKey } from "../../panel/panelText.tsx";
import { specOf, type ClientProfile, type ProviderRow } from "./types.ts";

/**
 * 客户端档案：一个「provider + 模型 + 模式 + 思考档位」的命名组合。
 *
 * 为什么要有档案而不是让路由直接写 provider/model：宿主把 `agentProfiles` 当作
 * 会话模板，用户在别处也会用同一份档案开会话。这里读写它，两边就是同一套名字。
 */
export function ProfilesPanel({
  skin,
  t,
  profiles,
  providers,
  onSave,
  onRemove,
  busy,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  profiles: ClientProfile[];
  providers: ProviderRow[];
  onSave(profile: ClientProfile): void;
  onRemove(id: string): void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState({
    id: "",
    name: "",
    provider: providers[0]?.id ?? "",
    model: "",
    modeId: "",
    thinkingOptionId: "",
  });
  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      row: { paddingVertical: 6, paddingHorizontal: 10, marginBottom: 6, gap: 2 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      name: { color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily, fontWeight: "700" as const },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      hint: skin.hint,
      input: skin.input,
      form: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const, marginTop: 4 },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4, marginTop: 4 },
    }),
    [skin],
  );

  const providerIds = providers.map((provider) => provider.id);
  const set = (patch: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = () => {
    const id = draft.id.trim();
    const provider = draft.provider.trim();
    if (!id || !provider) return;
    onSave({
      id,
      name: draft.name.trim() || id,
      provider,
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
      ...(draft.modeId.trim() ? { modeId: draft.modeId.trim() } : {}),
      ...(draft.thinkingOptionId.trim() ? { thinkingOptionId: draft.thinkingOptionId.trim() } : {}),
    });
    setDraft({ id: "", name: "", provider, model: "", modeId: "", thinkingOptionId: "" });
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 16 }}>
      <Text style={styles.hint}>{t("orch.profileHint")}</Text>
      {profiles.length === 0 ? <Text style={styles.hint}>{t("orch.profileEmpty")}</Text> : null}

      {profiles.map((profile) => (
        <PixelCard key={profile.id} skin={skin} style={styles.row}>
          <View style={styles.head}>
            <Text style={styles.name}>{profile.name}</Text>
            <View style={{ flex: 1 }} />
            <PixelButton
              skin={skin}
              mini
              variant="ghost"
              label={t("orch.remove")}
              disabled={busy}
              onPress={() => onRemove(profile.id)}
            />
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            {profile.id} · {specOf(profile)}
            {profile.modeId ? ` · ${profile.modeId}` : ""}
            {profile.thinkingOptionId ? ` · ${profile.thinkingOptionId}` : ""}
          </Text>
          {profile.notes ? <Text style={styles.meta}>{profile.notes}</Text> : null}
        </PixelCard>
      ))}

      <PixelHead skin={skin}>{t("orch.profileAdd")}</PixelHead>
      <View style={styles.form}>
        <TextInput
          accessibilityLabel={t("orch.profileId")}
          style={styles.input}
          value={draft.id}
          onChangeText={(id) => set({ id })}
          placeholder={t("orch.profileId")}
          placeholderTextColor={skin.colors.ink2}
          autoCapitalize="none"
        />
        <TextInput
          accessibilityLabel={t("orch.profileName")}
          style={styles.input}
          value={draft.name}
          onChangeText={(name) => set({ name })}
          placeholder={t("orch.profileName")}
          placeholderTextColor={skin.colors.ink2}
        />
      </View>
      <View style={styles.chips}>
        {providerIds.length === 0 ? <Text style={styles.hint}>{t("orch.noProviders")}</Text> : null}
        {providerIds.map((id) => (
          <PixelButton
            key={id}
            skin={skin}
            mini
            variant="tab"
            active={draft.provider === id}
            label={id}
            onPress={() => set({ provider: id })}
          />
        ))}
      </View>
      <View style={styles.form}>
        <TextInput
          accessibilityLabel={t("orch.profileModel")}
          style={styles.input}
          value={draft.model}
          onChangeText={(model) => set({ model })}
          placeholder={t("orch.profileModel")}
          placeholderTextColor={skin.colors.ink2}
          autoCapitalize="none"
        />
        <TextInput
          accessibilityLabel={t("orch.profileMode")}
          style={styles.input}
          value={draft.modeId}
          onChangeText={(modeId) => set({ modeId })}
          placeholder={t("orch.profileMode")}
          placeholderTextColor={skin.colors.ink2}
          autoCapitalize="none"
        />
        <TextInput
          accessibilityLabel={t("orch.profileThinking")}
          style={styles.input}
          value={draft.thinkingOptionId}
          onChangeText={(thinkingOptionId) => set({ thinkingOptionId })}
          placeholder={t("orch.profileThinking")}
          placeholderTextColor={skin.colors.ink2}
          autoCapitalize="none"
        />
      </View>
      <View style={styles.form}>
        <PixelButton
          skin={skin}
          mini
          label={t("orch.profileSave")}
          disabled={busy || !draft.id.trim() || !draft.provider.trim()}
          onPress={submit}
        />
        <Text style={styles.hint}>{t("orch.profileOverwriteHint")}</Text>
      </View>
    </ScrollView>
  );
}
