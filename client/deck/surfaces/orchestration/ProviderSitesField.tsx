import { Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { PixelButton } from "../../pixel.tsx";
import { fieldRow } from "./ProviderCardFields.tsx";
import type { CardContext } from "./providerCardStyles.ts";
import type { ProviderRow } from "./types.ts";

type SiteRow = ProviderRow["sites"][number];

function SiteRowView({ ctx, site }: { ctx: CardContext; site: SiteRow }) {
  const { skin, t, provider, busy, styles } = ctx;
  const inUse = provider.enabledSiteId === site.id;
  return (
    <View style={styles.siteRow}>
      <View style={styles.siteBody}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={styles.mono} numberOfLines={1}>
            {site.label ? `${site.label} · ${site.id}` : site.id}
          </Text>
          {inUse ? <Text style={styles.siteEnabled}>{t("orch.siteEnabled")}</Text> : null}
        </View>
        <Text style={styles.dim} numberOfLines={1}>
          {site.baseUrl}
        </Text>
        <Text style={styles.dim} numberOfLines={1}>
          {site.hasCredential ? site.credentialMasked : t("orch.siteKeyInherit")}
        </Text>
      </View>
      {inUse ? null : (
        <PixelButton
          skin={skin}
          mini
          variant="tab"
          label={t("orch.siteEnable")}
          disabled={busy || ctx.site.busy}
          onPress={() => void ctx.site.enable(provider.id, site.id)}
        />
      )}
      <PixelButton
        skin={skin}
        mini
        variant="ghost"
        label={t("orch.envEdit")}
        disabled={busy || ctx.site.busy}
        onPress={() => ctx.site.open(provider.id, site)}
      />
      <PixelButton
        skin={skin}
        mini
        variant="ghost"
        label={t("orch.siteRemove")}
        disabled={busy || ctx.site.busy}
        onPress={() => void ctx.site.remove(provider.id, site.id)}
      />
    </View>
  );
}

function SiteIdentityFields({ ctx, form }: { ctx: CardContext; form: { id: string } }) {
  const { skin, t, styles, site } = ctx;
  return (
    <View style={styles.form}>
      {form.id ? (
        <Text style={styles.mono}>{form.id}</Text>
      ) : (
        <TextInput
          accessibilityLabel={t("orch.siteId")}
          style={styles.input}
          value={site.draft.id}
          onChangeText={(text) => site.change((current) => ({ ...current, id: text }))}
          placeholder={t("orch.siteId")}
          placeholderTextColor={skin.colors.ink2}
          autoCapitalize="none"
        />
      )}
      <TextInput
        accessibilityLabel={t("orch.siteLabel")}
        style={styles.input}
        value={site.draft.label}
        onChangeText={(text) => site.change((current) => ({ ...current, label: text }))}
        placeholder={t("orch.siteLabel")}
        placeholderTextColor={skin.colors.ink2}
        autoCapitalize="none"
      />
    </View>
  );
}

function SiteCredentialFields({ ctx, form }: { ctx: CardContext; form: { id: string } }) {
  const { skin, t, busy, styles, site } = ctx;
  return (
    <View style={styles.form}>
      <TextInput
        accessibilityLabel={t("orch.siteUrl")}
        style={styles.input}
        value={site.draft.baseUrl}
        onChangeText={(text) => site.change((current) => ({ ...current, baseUrl: text }))}
        placeholder="https://api.example.com"
        placeholderTextColor={skin.colors.ink2}
        autoCapitalize="none"
      />
      <TextInput
        accessibilityLabel={t("orch.siteKey")}
        style={styles.input}
        value={site.draft.credential}
        onChangeText={(text) => site.change((current) => ({ ...current, credential: text }))}
        placeholder={t("orch.siteKeyKeep")}
        placeholderTextColor={skin.colors.ink2}
        autoCapitalize="none"
        secureTextEntry
      />
      <PixelButton
        skin={skin}
        mini
        label={site.busy ? t("orch.siteSaving") : t("orch.siteSave")}
        disabled={busy || site.busy || !site.draft.baseUrl.trim() || (!form.id && !site.draft.id.trim())}
        onPress={() => void site.save()}
      />
      <PixelButton
        skin={skin}
        mini
        variant="ghost"
        label={t("orch.cancel")}
        disabled={site.busy}
        onPress={site.close}
      />
    </View>
  );
}

function SiteFormView({ ctx, form }: { ctx: CardContext; form: { id: string } }) {
  const { t, styles } = ctx;
  return (
    <View style={styles.siteForm}>
      <SiteIdentityFields ctx={ctx} form={form} />
      <SiteCredentialFields ctx={ctx} form={form} />
      <Text style={styles.note}>{t("orch.siteNote")}</Text>
    </View>
  );
}

export function SitesField({ ctx }: { ctx: CardContext }) {
  const { skin, t, provider, busy, styles, site } = ctx;
  const form = site.formFor(provider.id);
  const error = site.errorFor(provider.id);
  return fieldRow(
    styles,
    t("orch.field.sites"),
    <View style={{ gap: 6, flex: 1 }}>
      {provider.sites.length === 0 ? <Text style={styles.dim}>{t("orch.siteNone")}</Text> : null}
      {provider.sites.map((item) => (
        <SiteRowView key={item.id} ctx={ctx} site={item} />
      ))}
      {form ? (
        <SiteFormView ctx={ctx} form={form} />
      ) : (
        <PixelButton
          skin={skin}
          mini
          variant="ghost"
          label={t("orch.siteAdd")}
          disabled={busy || site.busy}
          onPress={() => site.open(provider.id, null)}
        />
      )}
      {error ? <Text style={styles.bad}>{error}</Text> : null}
    </View>,
    true,
  );
}
