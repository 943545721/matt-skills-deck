import type { ReactNode } from "react";
import { Text, View } from "react-native";
import {
  claudeCodeContextWindowOf,
  CLAUDE_CODE_MAX_CONTEXT_TOKENS_KEY,
} from "../../../../shared/provider-models.ts";
import { PixelButton } from "../../pixel.tsx";
import { EnvEditor } from "./EnvEditor.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ModelThinkingList } from "./ModelThinkingList.tsx";
import type { ModelThinkingDefault } from "./modelThinking.ts";
import type { CardContext, CardStyles, ProviderCardActions } from "./providerCardStyles.ts";
import type { ProviderRow } from "./types.ts";

export function fieldRow(styles: CardStyles, label: string, value: ReactNode, stacked?: boolean) {
  return (
    <View style={[styles.field, stacked ? styles.fieldStacked : null]} key={label}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.fieldValue, stacked ? styles.fieldValueStacked : null]}>{value}</View>
    </View>
  );
}

function SecretValue({ ctx, secretKey }: { ctx: CardContext; secretKey: string }) {
  const { t, provider, styles, reveal } = ctx;
  const item = provider.env.find((entry) => entry.key === secretKey) ?? null;
  const current = reveal.currentFor(provider.id);
  const showing = current?.key === secretKey;
  if (!showing) return <Text style={styles.mono}>{item?.display ?? t("orch.notSet")}</Text>;
  return current && current.value !== null ? (
    <Text style={styles.revealed} selectable numberOfLines={3}>
      {current.value}
    </Text>
  ) : (
    <Text style={styles.bad} numberOfLines={2}>
      {current?.bad}
    </Text>
  );
}

/** 一个密钥键：掩码（或原值）+ 显示 + 改。 */
function SecretRow({ ctx, secretKey }: { ctx: CardContext; secretKey: string }) {
  const { skin, t, provider, busy, styles, editing, reveal } = ctx;
  const item = provider.env.find((entry) => entry.key === secretKey) ?? null;
  const field = `env:${secretKey}`;
  if (editing.fieldFor(provider.id) === field) {
    return (
      <EnvEditor
        key={`edit-${secretKey}`}
        skin={skin}
        t={t}
        value={editing.draft}
        busy={busy}
        secure
        accessibilityLabel={secretKey}
        onChange={editing.change}
        onSave={() => editing.save(provider.id, field)}
        onCancel={editing.cancel}
      />
    );
  }
  const showing = reveal.currentFor(provider.id)?.key === secretKey;
  return (
    <View style={styles.secret} key={secretKey}>
      <Text style={styles.keyName}>{secretKey}</Text>
      <SecretValue ctx={ctx} secretKey={secretKey} />
      <PixelButton
        skin={skin}
        mini
        variant="ghost"
        label={showing ? t("orch.envHide") : reveal.busy ? t("orch.envRevealing") : t("orch.envReveal")}
        disabled={reveal.busy || !item?.hasValue}
        onPress={() => {
          if (showing) reveal.hide();
          else void reveal.show(provider.id, secretKey);
        }}
      />
      <PixelButton
        skin={skin}
        mini
        variant="ghost"
        label={t("orch.envEdit")}
        disabled={busy}
        onPress={() => editing.start(provider.id, field, "")}
      />
    </View>
  );
}

export function BaseUrlField({ ctx, baseUrlKey }: { ctx: CardContext; baseUrlKey: string }) {
  const { skin, t, provider, busy, styles, editing } = ctx;
  const field = `env:${baseUrlKey}`;
  return fieldRow(
    styles,
    t("orch.field.baseUrl"),
    editing.fieldFor(provider.id) === field ? (
      <EnvEditor
        skin={skin}
        t={t}
        value={editing.draft}
        busy={busy}
        placeholder="https://api.example.com"
        accessibilityLabel={baseUrlKey}
        onChange={editing.change}
        onSave={() => editing.save(provider.id, field)}
        onCancel={editing.cancel}
      />
    ) : (
      <>
        <Text style={styles.mono} numberOfLines={1}>
          {provider.baseUrl ?? t("orch.notSet")}
        </Text>
        <PixelButton
          skin={skin}
          mini
          variant="ghost"
          label={t("orch.envEdit")}
          disabled={busy}
          onPress={() => editing.start(provider.id, field, provider.baseUrl ?? "")}
        />
      </>
    ),
  );
}

export function CredentialField({ ctx, credentialKey }: { ctx: CardContext; credentialKey: string }) {
  const { skin, t, provider, busy, styles, editing } = ctx;
  const field = `env:${credentialKey}`;
  const editingThis = editing.fieldFor(provider.id) === field;
  if (provider.credentialKeys.length > 0) {
    return fieldRow(
      styles,
      t("orch.field.credential"),
      <View style={{ gap: 6, flex: 1 }}>
        {provider.credentialKeys.map((key) => (
          <SecretRow key={key} ctx={ctx} secretKey={key} />
        ))}
      </View>,
    );
  }
  return fieldRow(
    styles,
    t("orch.field.credential"),
    editingThis ? (
      <EnvEditor
        skin={skin}
        t={t}
        value={editing.draft}
        busy={busy}
        secure
        accessibilityLabel={credentialKey}
        onChange={editing.change}
        onSave={() => editing.save(provider.id, field)}
        onCancel={editing.cancel}
      />
    ) : (
      <>
        <Text style={styles.dim}>{t("orch.notSet")}</Text>
        <PixelButton
          skin={skin}
          mini
          variant="ghost"
          label={t("orch.envEdit")}
          disabled={busy}
          onPress={() => editing.start(provider.id, field, "")}
        />
      </>
    ),
  );
}

function ContextWindowNote({ ctx }: { ctx: CardContext }) {
  const { t, provider, styles } = ctx;
  const envOf = (key: string) => provider.env.find((item) => item.key === key) ?? null;
  const contextEnv = envOf(CLAUDE_CODE_MAX_CONTEXT_TOKENS_KEY);
  const clientContextWindow =
    contextEnv && !contextEnv.masked && /^\d+$/.test(contextEnv.display) ? Number(contextEnv.display) : undefined;
  const apiContextWindow =
    provider.id === "claude"
      ? claudeCodeContextWindowOf(
          (provider.modelCapabilities ?? []).filter((model) => provider.configModels.includes(model.id)),
          envOf("ANTHROPIC_MODEL")?.display,
        )
      : undefined;
  if (provider.id !== "claude" || (apiContextWindow === undefined && clientContextWindow === undefined)) return null;
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.dim}>
        {t("orch.contextWindow", {
          api: apiContextWindow ?? t("orch.contextWindowUnknown"),
          client: clientContextWindow ?? t("orch.contextWindowDefault"),
        })}
      </Text>
      {apiContextWindow !== undefined && apiContextWindow !== clientContextWindow ? (
        <Text style={styles.dim}>{t("orch.contextWindowMismatch", { n: apiContextWindow })}</Text>
      ) : null}
      <Text style={styles.dim}>{t("orch.contextWindowRestart")}</Text>
    </View>
  );
}

export function ModelsField({
  ctx,
  providers,
  modelThinking,
  actions,
}: {
  ctx: CardContext;
  providers: ProviderRow[];
  modelThinking: readonly ModelThinkingDefault[];
  actions: ProviderCardActions;
}) {
  const { skin, t, provider, busy, styles } = ctx;
  return fieldRow(
    styles,
    t("orch.field.models"),
    <View style={{ gap: 10, flex: 1 }}>
      <ModelPicker
        skin={skin}
        t={t}
        models={provider.configModels}
        listKey={provider.modelsKey}
        baseUrl={provider.baseUrl}
        busy={busy}
        onSave={(ids, definitions) => actions.onSaveModel({ provider: provider.id, models: ids, modelDefinitions: definitions })}
        onFetch={actions.onFetchModels}
      />
      <ContextWindowNote ctx={ctx} />
      {/* 每个已选模型自己的默认档：派单用这个模型时自动带上。 */}
      <ModelThinkingList
        skin={skin}
        t={t}
        provider={provider.id}
        models={provider.configModels}
        providers={providers}
        defaults={modelThinking}
        busy={busy}
        onSet={(model, thinkingOptionId) => actions.onSaveThinking({ provider: provider.id, model, thinkingOptionId })}
      />
    </View>,
    true,
  );
}
