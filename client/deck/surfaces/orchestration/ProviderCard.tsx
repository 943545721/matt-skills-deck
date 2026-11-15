import { Pressable, Text, View } from "react-native";
import { envKeysFor } from "../../../../shared/provider-env.ts";
import { installRecipeFor, installStateOf } from "../../../../shared/provider-install.ts";
import type { PanelKey, PanelTextFn } from "../../panel/panelText.tsx";
import { PixelCard, type PixelSkin } from "../../pixel.tsx";
import { BaseUrlField, CredentialField, ModelsField } from "./ProviderCardFields.tsx";
import { SitesField } from "./ProviderSitesField.tsx";
import { ToolsField } from "./ProviderToolsField.tsx";
import { ProviderAdvancedFields } from "./ProviderAdvancedFields.tsx";
import {
  cardStylesOf,
  type CardContext,
  type ProviderCardActions,
} from "./providerCardStyles.ts";
import type { ModelThinkingDefault } from "./modelThinking.ts";
import type { ProviderRow } from "./types.ts";
import type { FieldEditing } from "./useFieldEditing.ts";
import type { EnvAddition } from "./useEnvAddition.ts";
import type { ProviderDiagnostics } from "./useProviderDiagnostics.ts";
import type { ProviderReveal } from "./useProviderReveal.ts";
import type { SiteEditor } from "./useSiteEditor.ts";

type StatusKey = Extract<PanelKey, `orch.state.${string}`>;
const STATE_KEY: Record<ReturnType<typeof installStateOf>, StatusKey> = {
  ready: "orch.state.ready",
  loading: "orch.state.loading",
  missing: "orch.state.missing",
  broken: "orch.state.broken",
  unknown: "orch.state.unknown",
};

export type ProviderCardProps = ProviderCardActions & {
  skin: PixelSkin;
  t: PanelTextFn;
  provider: ProviderRow;
  providers: ProviderRow[];
  modelThinking: readonly ModelThinkingDefault[];
  busy: boolean;
  open: boolean;
  advanced: boolean;
  onToggleOpen(): void;
  onToggleAdvanced(): void;
  onOpenSource(): void;
  editing: FieldEditing;
  reveal: ProviderReveal;
  diagnostics: ProviderDiagnostics;
  site: SiteEditor;
  addition: EnvAddition;
  onSaveEnv(input: { provider: string; env: Record<string, string> }): void;
};

function CardHeader({
  ctx,
  open,
  state,
  onToggleOpen,
  onOpenSource,
}: {
  ctx: CardContext;
  open: boolean;
  state: ReturnType<typeof installStateOf>;
  onToggleOpen(): void;
  onOpenSource(): void;
}) {
  const { t, provider, styles } = ctx;
  const stateStyle =
    state === "ready" ? styles.stateGood : state === "missing" || state === "broken" ? styles.stateBad : styles.stateIdle;
  return (
    <Pressable
      style={styles.head}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${provider.label ?? provider.id}，${t(STATE_KEY[state])}`}
      onPress={onToggleOpen}
    >
      <View style={styles.headBody}>
        <Text style={styles.name} numberOfLines={1}>
          {provider.label ?? provider.id}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {provider.id} · {t("orch.modelCount", { n: provider.configModels.length })} ·{" "}
          <Text style={styles.link} accessibilityRole="button" onPress={onOpenSource}>
            {t("orch.keyCount", { n: provider.env.length })}
          </Text>
          {provider.enabled ? "" : ` · ${t("orch.disabled")}`}
        </Text>
      </View>
      <View style={styles.stateWrap}>
        <Text style={stateStyle}>●</Text>
        <Text style={stateStyle}>{t(STATE_KEY[state])}</Text>
      </View>
      <Text style={styles.caret}>{open ? "⌄" : "›"}</Text>
    </Pressable>
  );
}

type ProviderCardBodyProps = {
  ctx: CardContext;
  providers: ProviderRow[];
  modelThinking: readonly ModelThinkingDefault[];
  diagnostics: ProviderDiagnostics;
  installable: boolean;
  recipe: ReturnType<typeof installRecipeFor>;
  actions: ProviderCardActions;
};

function ProviderCardBody({
  ctx,
  providers,
  modelThinking,
  diagnostics,
  installable,
  recipe,
  actions,
}: ProviderCardBodyProps) {
  const { t, provider, busy, editing, reveal, addition, advanced, onToggleAdvanced, onSaveEnv } = ctx;
  const keys = envKeysFor(provider.extends ?? provider.id, provider.env.map((item) => item.key));
  return (
    <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
      <BaseUrlField ctx={ctx} baseUrlKey={keys.baseUrlKey} />
      <CredentialField ctx={ctx} credentialKey={keys.credentialKey} />
      <ModelsField ctx={ctx} providers={providers} modelThinking={modelThinking} actions={actions} />
      <SitesField ctx={ctx} />
      <ProviderAdvancedFields
        skin={ctx.skin}
        t={t}
        provider={provider}
        baseUrlKey={keys.baseUrlKey}
        open={advanced}
        busy={busy}
        editor={{
          field: editing.fieldFor(provider.id),
          value: editing.draft,
          start: (field, value) => editing.start(provider.id, field, value),
          change: editing.change,
          save: (field) => editing.save(provider.id, field),
          cancel: editing.cancel,
        }}
        reveal={{
          current: reveal.currentFor(provider.id),
          busy: reveal.busy,
          show: (key) => void reveal.show(provider.id, key),
          hide: reveal.hide,
        }}
        addition={{
          key: addition.key,
          value: addition.value,
          changeKey: addition.changeKey,
          changeValue: addition.changeValue,
        }}
        onToggle={onToggleAdvanced}
        onSaveEnv={onSaveEnv}
      />
      <ToolsField ctx={ctx} diagnostics={diagnostics} installable={installable} recipe={recipe} />
    </View>
  );
}

/**
 * 一张客户端卡片：折叠头 + 地址 / 凭据 / 模型 / 站点 / 高级 / 诊断。
 *
 * 卡片自己不做请求，也不持有全局状态：编辑、显示、诊断与站点表单都由 hooks
 * 按 provider 归属后传进来，这样切换卡片不会串状态。
 */
export function ProviderCard({
  skin,
  t,
  provider,
  providers,
  modelThinking,
  busy,
  open,
  advanced,
  onToggleOpen,
  onToggleAdvanced,
  onOpenSource,
  editing,
  reveal,
  diagnostics,
  site,
  addition,
  onSaveEnv,
  onSaveModel,
  onSaveThinking,
  onFetchModels,
}: ProviderCardProps) {
  const styles = cardStylesOf(skin);
  const ctx: CardContext = {
    skin,
    t,
    provider,
    busy,
    styles,
    editing,
    reveal,
    site,
    addition,
    advanced,
    onToggleAdvanced,
    onSaveEnv: (env) => onSaveEnv({ provider: provider.id, env }),
  };
  const actions: ProviderCardActions = { onSaveModel, onSaveThinking, onFetchModels };
  const state = installStateOf(provider.status);
  const recipe = installRecipeFor(provider.id);
  const installable = Boolean(recipe) && (state === "missing" || state === "broken");
  return (
    <PixelCard skin={skin} style={styles.row}>
      <CardHeader ctx={ctx} open={open} state={state} onToggleOpen={onToggleOpen} onOpenSource={onOpenSource} />
      {open ? (
        <ProviderCardBody
          ctx={ctx}
          providers={providers}
          modelThinking={modelThinking}
          diagnostics={diagnostics}
          installable={installable}
          recipe={recipe}
          actions={actions}
        />
      ) : null}
    </PixelCard>
  );
}
