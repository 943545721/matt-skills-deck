import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { ProviderModelList } from "../../../../shared/orchestration-rpc.ts";
import { installCommandOf, installRecipeFor, installStateOf } from "../../../../shared/provider-install.ts";
import { isModelEnvKey } from "../../../../shared/provider-models.ts";
import { envKeysFor } from "../../../../shared/provider-env.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton, PixelCard } from "../../pixel.tsx";
import { HostCatalogBar } from "./HostCatalogBar.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import type { ProviderRow, SiteRow } from "./types.ts";

/**
 * 客户端注入配置。
 *
 * 布局照设置面板的走法：**一行一个字段**，左边固定的字段名、右边是值，
 * 值本身就是可改的（名称 / 地址 / 密钥），模型是一排可点的型号。
 * 原始那串环境变量（`ANTHROPIC_*`）收进「高级」——它们是实现细节，
 * 摊在默认视图里只会让人以为「这台机器跑着一堆东西」。
 *
 * 一条硬约定：密钥默认只显示掩码（`••••1234`）。想看原值必须逐键点「显示」，
 * 那一次只取回**一个**键，并且只活在这张卡片里（不落状态快照、不进日志）。
 *
 * 写入是深合并：只能「新增/覆盖某个键」，删键要改 `~/.paseo/config.json`。
 */

type StatusKey = Extract<PanelKey, `orch.state.${string}`>;

const STATE_KEY: Record<ReturnType<typeof installStateOf>, StatusKey> = {
  ready: "orch.state.ready",
  loading: "orch.state.loading",
  missing: "orch.state.missing",
  broken: "orch.state.broken",
  unknown: "orch.state.unknown",
};

export function ClientsPanel({
  skin,
  t,
  providers,
  onSaveEnv,
  onSaveModel,
  onSaveLabel,
  onDiagnose,
  onInstall,
  onReveal,
  onFetchModels,
  onRefreshCatalog,
  onSaveSite,
  busy,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  providers: ProviderRow[];
  onSaveEnv(input: { provider: string; env: Record<string, string> }): void;
  /** 传这个客户端声明的**完整**模型清单（替换语义）。 */
  onSaveModel(input: { provider: string; models: string[] }): void;
  /** 只改显示名。 */
  onSaveLabel(input: { provider: string; label: string }): void;
  /** 取宿主诊断原文；失败时返回可直接展示的原因。 */
  onDiagnose(provider: string): Promise<{ ok: true; diagnostic: string } | { ok: false; detail: string }>;
  /** 取某一个键的原值；用户显式点「显示」才会调用。 */
  onReveal(provider: string, key: string): Promise<{ ok: true; value: string } | { ok: false; detail: string }>;
  /** 真的执行 `npm install -g`；二次确认由本组件负责。 */
  onInstall(provider: string): Promise<{ ok: true; output: string } | { ok: false; detail: string; output?: string }>;
  /** 用配置里已有的 base url + 凭据去问接口要模型清单。 */
  onFetchModels(provider: string): Promise<
    { ok: true; endpoint: string; models: string[] } | { ok: false; detail: string }
  >;
  /**
   * 让宿主重读模型清单（`providers.refresh` + 回读快照）。
   * 改完地址或模型后调用：宿主的选择器立刻换成新清单，会话不受影响。
   */
  onRefreshCatalog(): Promise<
    | { ok: true; providers: ProviderModelList[]; warnings: string[] }
    | { ok: false; detail: string }
  >;
  /** 客户端下的站点：加 / 改 / 删 / 启用。启用会写宿主配置，凭证省略 = 沿用已存的那份。 */
  onSaveSite(input: {
    provider: string;
    site?: { id: string; label?: string; baseUrl: string; credential?: string };
    removeId?: string;
    enableId?: string;
  }): Promise<{ ok: true } | { ok: false; detail: string }>;
  busy: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  /** 在改哪个字段：`name` 是显示名，`env:<键>` 是某个环境变量。 */
  const [editing, setEditing] = useState<{ provider: string; field: string } | null>(null);
  const [draft, setDraft] = useState("");
  /** 「高级」逐客户端展开：看过一家的原始键，不代表另一家也要摊开。 */
  const [advancedId, setAdvancedId] = useState<string | null>(null);
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [diagnosingId, setDiagnosingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ provider: string; bad: boolean; text: string } | null>(null);
  /** 当前展开着原值的那一个键；切到别的键或收起卡片就没了。 */
  const [revealed, setRevealed] = useState<{ provider: string; key: string; value: string | null; bad: string | null } | null>(null);
  const [revealing, setRevealing] = useState(false);
  /** 站点表单：一次只开一个客户端的表单，`id` 为空表示新增。 */
  const [siteForm, setSiteForm] = useState<{ provider: string; id: string } | null>(null);
  const [siteDraft, setSiteDraft] = useState({ id: "", label: "", baseUrl: "", credential: "" });
  const [siteBusy, setSiteBusy] = useState(false);
  /** 站点操作的错误只显示在它所属的那张客户端卡片上。 */
  const [siteBad, setSiteBad] = useState<{ provider: string; text: string } | null>(null);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      row: { padding: 0, marginBottom: 6 },
      head: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        paddingVertical: 12,
        paddingHorizontal: 14,
      },
      headBody: { flex: 1, gap: 3 },
      name: { color: skin.colors.ink, fontSize: 13, fontFamily: skin.mono.fontFamily, fontWeight: "700" as const },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      stateWrap: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
      stateGood: { color: skin.colors.ok, fontSize: 11, fontFamily: skin.mono.fontFamily },
      stateBad: { color: skin.colors.bad, fontSize: 11, fontFamily: skin.mono.fontFamily },
      stateIdle: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      caret: { color: skin.colors.ink2, fontSize: 12, fontFamily: skin.mono.fontFamily },

      /** 每一行：左边固定的字段名，右边是值。 */
      field: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
        paddingVertical: 9,
        borderTopWidth: 1,
        borderTopColor: skin.colors.line,
      },
      fieldStacked: { alignItems: "flex-start" as const },
      fieldLabel: { width: 78, color: skin.colors.ink2, fontSize: 12, lineHeight: 20 },
      fieldValue: { flex: 1, flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      fieldValueStacked: { flexDirection: "column" as const, alignItems: "stretch" as const, gap: 6 },
      value: { color: skin.colors.ink, fontSize: 13, lineHeight: 20, fontFamily: skin.mono.fontFamily },
      mono: { color: skin.colors.ink, fontSize: 12, lineHeight: 18, fontFamily: skin.mono.fontFamily },
      dim: { color: skin.colors.ink2, fontSize: 12, lineHeight: 18 },
      note: skin.hint,
      input: { ...skin.input, flexGrow: 1, minWidth: 160 },
      /** 站点：一条一行，1px 细线分隔，右边的按钮只在这一行管用。 */
      siteRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        flexWrap: "wrap" as const,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: skin.colors.line,
      },
      siteBody: { flex: 1, minWidth: 140, gap: 1 },
      siteForm: { gap: 6, paddingTop: 6 },
      siteEnabled: { color: skin.colors.acc, fontSize: 10, fontFamily: skin.mono.fontFamily },
      /** 密钥那一小块：掩码/原值 + 显示 + 改。 */
      secret: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      revealed: { color: skin.colors.ink, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily, flexShrink: 1 },
      bad: { color: skin.colors.bad, fontSize: 11, lineHeight: 16 },
      /** 高级：默认只有一个可以点的标题。 */
      advancedToggle: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: skin.colors.line },
      advancedHead: { color: skin.colors.ink2, fontSize: 12, fontFamily: skin.mono.fontFamily },
      advancedBody: { gap: 6, paddingBottom: 8 },
      keys: { gap: 0 },
      keyRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 5,
        borderBottomWidth: 1,
        borderBottomColor: skin.colors.line,
      },
      keyName: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily, maxWidth: "55%" as const },
      tierTag: { color: skin.colors.ink2, fontSize: 9, fontFamily: skin.mono.fontFamily, opacity: 0.75 },
      keyValue: { color: skin.colors.ink, fontSize: 11, fontFamily: skin.mono.fontFamily },
      form: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      tools: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const, paddingTop: 8 },
      output: { borderLeftWidth: 1, borderLeftColor: skin.colors.line, paddingLeft: 8, gap: 1 },
      outputText: { color: skin.colors.ink2, fontSize: 11, lineHeight: 15, fontFamily: skin.mono.fontFamily },
    }),
    [skin],
  );

  const startEdit = (provider: string, field: string, initial: string) => {
    setEditing({ provider, field });
    setDraft(initial);
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraft("");
  };

  const saveEdit = (provider: string, field: string) => {
    if (!draft.trim()) return;
    if (field === "name") onSaveLabel({ provider, label: draft.trim() });
    else if (field.startsWith("env:")) onSaveEnv({ provider, env: { [field.slice(4)]: draft } });
    cancelEdit();
  };

  const reveal = async (provider: string, key: string) => {
    setRevealing(true);
    try {
      const result = await onReveal(provider, key);
      setRevealed(
        result.ok
          ? { provider, key, value: result.value, bad: null }
          : { provider, key, value: null, bad: result.detail },
      );
    } finally {
      setRevealing(false);
    }
  };

  const diagnose = async (provider: string) => {
    setDiagnosingId(provider);
    setNotice(null);
    try {
      const result = await onDiagnose(provider);
      setNotice({ provider, bad: !result.ok, text: result.ok ? result.diagnostic : result.detail });
    } finally {
      setDiagnosingId(null);
    }
  };

  const install = async (provider: string) => {
    setConfirmId(null);
    setInstallingId(provider);
    setNotice(null);
    try {
      const result = await onInstall(provider);
      setNotice({
        provider,
        bad: !result.ok,
        text: result.ok
          ? [t("orch.installOk", { provider }), result.output].filter(Boolean).join("\n\n")
          : [result.detail, result.output ?? ""].filter(Boolean).join("\n\n"),
      });
    } finally {
      setInstallingId(null);
    }
  };

  const openSiteForm = (provider: string, site: SiteRow | null) => {
    setSiteBad(null);
    setSiteForm({ provider, id: site?.id ?? "" });
    setSiteDraft({
      id: site?.id ?? "",
      label: site?.label ?? "",
      baseUrl: site?.baseUrl ?? "",
      credential: "",
    });
  };

  const closeSiteForm = () => {
    setSiteForm(null);
    setSiteDraft({ id: "", label: "", baseUrl: "", credential: "" });
    setSiteBad(null);
  };

  /**
   * 存站点。
   *
   * 改地址时不必把凭证再贴一遍：留空就是沿用这条站点已存的那份（服务端也是这么理解的）。
   * 校验统一交给服务端——它给出的原因和落盘时的判定是同一套，界面不另写一份。
   */
  const saveSite = async () => {
    if (!siteForm) return;
    const editingSite = Boolean(siteForm.id);
    const id = editingSite ? siteForm.id : siteDraft.id.trim().toLowerCase();
    if (!id || !siteDraft.baseUrl.trim()) return;
    setSiteBusy(true);
    setSiteBad(null);
    try {
      const result = await onSaveSite({
        provider: siteForm.provider,
        site: {
          id,
          ...(siteDraft.label.trim() ? { label: siteDraft.label.trim() } : {}),
          baseUrl: siteDraft.baseUrl.trim(),
          ...(siteDraft.credential ? { credential: siteDraft.credential } : {}),
        },
      });
      if (!result.ok) {
        setSiteBad({ provider: siteForm.provider, text: result.detail });
        return;
      }
      closeSiteForm();
    } finally {
      setSiteBusy(false);
    }
  };

  /** 启用：把这条的地址与凭证写进客户端自己的配置，这个客户端的新会话都走它。 */
  const enableSite = async (provider: string, id: string) => {
    setSiteBusy(true);
    setSiteBad(null);
    try {
      const result = await onSaveSite({ provider, enableId: id });
      if (!result.ok) setSiteBad({ provider, text: result.detail });
    } finally {
      setSiteBusy(false);
    }
  };

  const removeSite = async (provider: string, id: string) => {
    setSiteBusy(true);
    setSiteBad(null);
    try {
      const result = await onSaveSite({ provider, removeId: id });
      if (!result.ok) setSiteBad({ provider, text: result.detail });
    } finally {
      setSiteBusy(false);
    }
  };

  /** 一行「字段名 + 值」。 */
  const field = (label: string, value: ReactNode, stacked?: boolean) => (
    <View style={[styles.field, stacked ? styles.fieldStacked : null]} key={label}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.fieldValue, stacked ? styles.fieldValueStacked : null]}>{value}</View>
    </View>
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 16 }}>
      <HostCatalogBar skin={skin} t={t} disabled={busy || siteBusy} onRefresh={onRefreshCatalog} />

      {/* 只列两家是刻意收窄的：其余客户端插件注不进去，列出来只会配出一份没人读的配置。 */}
      <Text style={styles.dim}>{t("orch.clientsScope")}</Text>

      {providers.length === 0 ? <Text style={styles.note}>{t("orch.noProviders")}</Text> : null}

      {providers.map((provider) => {
        const open = openId === provider.id;
        const state = installStateOf(provider.status);
        const recipe = installRecipeFor(provider.id);
        const installable = Boolean(recipe) && (state === "missing" || state === "broken");
        const lineNotice = notice?.provider === provider.id ? notice : null;
        const stateStyle = state === "ready" ? styles.stateGood : state === "missing" || state === "broken" ? styles.stateBad : styles.stateIdle;
        const advanced = advancedId === provider.id;
        const siteError = siteBad?.provider === provider.id ? siteBad.text : null;
        // 地址与密钥写在哪两个键上：照这个客户端已有的键名推。
        const keys = envKeysFor(provider.extends ?? provider.id, provider.env.map((item) => item.key));
        const editingField = editing?.provider === provider.id ? editing.field : null;
        const envOf = (key: string) => provider.env.find((item) => item.key === key) ?? null;
        const otherKeys = provider.env.filter(
          (item) => item.key !== keys.baseUrlKey && !provider.credentialKeys.includes(item.key),
        );

        /** 一个密钥键：掩码（或原值）+ 显示 + 改。 */
        const secretRow = (key: string) => {
          const item = envOf(key);
          const showing = revealed?.provider === provider.id && revealed.key === key;
          if (editingField === `env:${key}`) {
            return (
              <View style={styles.secret} key={`edit-${key}`}>
                <TextInput
                  accessibilityLabel={key}
                  style={styles.input}
                  value={draft}
                  onChangeText={setDraft}
                  placeholder={t("orch.envValueNew")}
                  placeholderTextColor={skin.colors.ink2}
                  autoCapitalize="none"
                  secureTextEntry
                />
                <PixelButton skin={skin} mini label={t("orch.saveEnv")} disabled={busy || !draft} onPress={() => saveEdit(provider.id, `env:${key}`)} />
                <PixelButton skin={skin} mini variant="ghost" label={t("orch.cancel")} onPress={cancelEdit} />
              </View>
            );
          }
          return (
            <View style={styles.secret} key={key}>
              <Text style={styles.keyName}>{key}</Text>
              {showing ? (
                revealed && revealed.value !== null ? (
                  <Text style={styles.revealed} selectable numberOfLines={3}>
                    {revealed.value}
                  </Text>
                ) : (
                  <Text style={styles.bad} numberOfLines={2}>
                    {revealed?.bad}
                  </Text>
                )
              ) : (
                <Text style={styles.mono}>{item?.display ?? t("orch.notSet")}</Text>
              )}
              <PixelButton
                skin={skin}
                mini
                variant="ghost"
                label={showing ? t("orch.envHide") : revealing ? t("orch.envRevealing") : t("orch.envReveal")}
                disabled={revealing || !item?.hasValue}
                onPress={() => {
                  if (showing) setRevealed(null);
                  else void reveal(provider.id, key);
                }}
              />
              <PixelButton
                skin={skin}
                mini
                variant="ghost"
                label={t("orch.envEdit")}
                disabled={busy}
                onPress={() => startEdit(provider.id, `env:${key}`, "")}
              />
            </View>
          );
        };

        return (
          <PixelCard key={provider.id} skin={skin} style={styles.row}>
            <Pressable
              style={styles.head}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              accessibilityLabel={`${provider.label ?? provider.id}，${t(STATE_KEY[state])}`}
              onPress={() => {
                // 收起时把明文一起丢掉：下次展开要重新点「显示」，不留在内存里。
                setRevealed(null);
                cancelEdit();
                setConfirmId(null);
                setOpenId(open ? null : provider.id);
              }}
            >
              <View style={styles.headBody}>
                <Text style={styles.name} numberOfLines={1}>
                  {provider.label ?? provider.id}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {provider.id} · {t("orch.modelCount", { n: provider.configModels.length })} · {t("orch.keyCount", { n: provider.env.length })}
                  {provider.enabled ? "" : ` · ${t("orch.disabled")}`}
                </Text>
              </View>
              <View style={styles.stateWrap}>
                <Text style={stateStyle}>●</Text>
                <Text style={stateStyle}>{t(STATE_KEY[state])}</Text>
              </View>
              <Text style={styles.caret}>{open ? "⌄" : "›"}</Text>
            </Pressable>

            {open ? (
              <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
                {field(
                  t("orch.field.name"),
                  editingField === "name" ? (
                    <>
                      <TextInput
                        accessibilityLabel={t("orch.field.name")}
                        style={styles.input}
                        value={draft}
                        onChangeText={setDraft}
                        placeholder={provider.id}
                        placeholderTextColor={skin.colors.ink2}
                        autoCapitalize="none"
                      />
                      <PixelButton skin={skin} mini label={t("orch.saveEnv")} disabled={busy || !draft.trim()} onPress={() => saveEdit(provider.id, "name")} />
                      <PixelButton skin={skin} mini variant="ghost" label={t("orch.cancel")} onPress={cancelEdit} />
                    </>
                  ) : (
                    <>
                      <Text style={styles.value} numberOfLines={1}>
                        {provider.label ?? provider.id}
                      </Text>
                      <PixelButton
                        skin={skin}
                        mini
                        variant="ghost"
                        label={t("orch.envEdit")}
                        disabled={busy}
                        onPress={() => startEdit(provider.id, "name", provider.label ?? "")}
                      />
                    </>
                  ),
                )}

                {field(
                  t("orch.field.id"),
                  <>
                    <Text style={styles.mono} selectable>
                      {provider.id}
                    </Text>
                    {provider.extends ? <Text style={styles.dim}>{t("orch.extendsOf", { provider: provider.extends })}</Text> : null}
                  </>,
                )}

                {field(
                  t("orch.field.baseUrl"),
                  editingField === `env:${keys.baseUrlKey}` ? (
                    <>
                      <TextInput
                        accessibilityLabel={keys.baseUrlKey}
                        style={styles.input}
                        value={draft}
                        onChangeText={setDraft}
                        placeholder="https://api.example.com"
                        placeholderTextColor={skin.colors.ink2}
                        autoCapitalize="none"
                      />
                      <PixelButton
                        skin={skin}
                        mini
                        label={t("orch.saveEnv")}
                        disabled={busy || !draft.trim()}
                        onPress={() => saveEdit(provider.id, `env:${keys.baseUrlKey}`)}
                      />
                      <PixelButton skin={skin} mini variant="ghost" label={t("orch.cancel")} onPress={cancelEdit} />
                    </>
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
                        onPress={() => startEdit(provider.id, `env:${keys.baseUrlKey}`, provider.baseUrl ?? "")}
                      />
                    </>
                  ),
                )}

                {field(
                  t("orch.field.credential"),
                  provider.credentialKeys.length === 0 ? (
                    <>
                      <Text style={styles.dim}>{t("orch.notSet")}</Text>
                      <PixelButton
                        skin={skin}
                        mini
                        variant="ghost"
                        label={t("orch.envEdit")}
                        disabled={busy}
                        onPress={() => startEdit(provider.id, `env:${keys.credentialKey}`, "")}
                      />
                    </>
                  ) : (
                    <View style={{ gap: 6, flex: 1 }}>{provider.credentialKeys.map((key) => secretRow(key))}</View>
                  ),
                )}

                {field(
                  t("orch.field.models"),
                  <ModelPicker
                    skin={skin}
                    t={t}
                    models={provider.configModels}
                    listKey={provider.modelsKey}
                    busy={busy}
                    onSave={(ids) => onSaveModel({ provider: provider.id, models: ids })}
                    onFetch={() => onFetchModels(provider.id)}
                  />,
                  true,
                )}

                {/*
                  站点挂在这个客户端下面：加一条不用重建客户端、也不用重声明模型。
                  「启用」= 把这一条的地址与凭证写进客户端自己的配置（宿主一个客户端只有一份 env），
                  所以同一时刻只有一条在用，界面上用「当前启用」标出来。
                */}
                {field(
                  t("orch.field.sites"),
                  <View style={{ gap: 6, flex: 1 }}>
                    {provider.sites.length === 0 ? <Text style={styles.dim}>{t("orch.siteNone")}</Text> : null}
                    {provider.sites.map((site) => {
                      const inUse = provider.enabledSiteId === site.id;
                      return (
                        <View key={site.id} style={styles.siteRow}>
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
                              disabled={busy || siteBusy}
                              onPress={() => void enableSite(provider.id, site.id)}
                            />
                          )}
                          <PixelButton
                            skin={skin}
                            mini
                            variant="ghost"
                            label={t("orch.envEdit")}
                            disabled={busy || siteBusy}
                            onPress={() => openSiteForm(provider.id, site)}
                          />
                          <PixelButton
                            skin={skin}
                            mini
                            variant="ghost"
                            label={t("orch.siteRemove")}
                            disabled={busy || siteBusy}
                            onPress={() => void removeSite(provider.id, site.id)}
                          />
                        </View>
                      );
                    })}

                    {siteForm?.provider === provider.id ? (
                      <View style={styles.siteForm}>
                        <View style={styles.form}>
                          {siteForm.id ? (
                            <Text style={styles.mono}>{siteForm.id}</Text>
                          ) : (
                            <TextInput
                              accessibilityLabel={t("orch.siteId")}
                              style={styles.input}
                              value={siteDraft.id}
                              onChangeText={(text) => setSiteDraft((current) => ({ ...current, id: text }))}
                              placeholder={t("orch.siteId")}
                              placeholderTextColor={skin.colors.ink2}
                              autoCapitalize="none"
                            />
                          )}
                          <TextInput
                            accessibilityLabel={t("orch.siteLabel")}
                            style={styles.input}
                            value={siteDraft.label}
                            onChangeText={(text) => setSiteDraft((current) => ({ ...current, label: text }))}
                            placeholder={t("orch.siteLabel")}
                            placeholderTextColor={skin.colors.ink2}
                            autoCapitalize="none"
                          />
                        </View>
                        <View style={styles.form}>
                          <TextInput
                            accessibilityLabel={t("orch.siteUrl")}
                            style={styles.input}
                            value={siteDraft.baseUrl}
                            onChangeText={(text) => setSiteDraft((current) => ({ ...current, baseUrl: text }))}
                            placeholder="https://api.example.com"
                            placeholderTextColor={skin.colors.ink2}
                            autoCapitalize="none"
                          />
                          <TextInput
                            accessibilityLabel={t("orch.siteKey")}
                            style={styles.input}
                            value={siteDraft.credential}
                            onChangeText={(text) => setSiteDraft((current) => ({ ...current, credential: text }))}
                            placeholder={t("orch.siteKeyKeep")}
                            placeholderTextColor={skin.colors.ink2}
                            autoCapitalize="none"
                            secureTextEntry
                          />
                          <PixelButton
                            skin={skin}
                            mini
                            label={siteBusy ? t("orch.siteSaving") : t("orch.siteSave")}
                            disabled={busy || siteBusy || !siteDraft.baseUrl.trim() || (!siteForm.id && !siteDraft.id.trim())}
                            onPress={() => void saveSite()}
                          />
                          <PixelButton
                            skin={skin}
                            mini
                            variant="ghost"
                            label={t("orch.cancel")}
                            disabled={siteBusy}
                            onPress={closeSiteForm}
                          />
                        </View>
                        <Text style={styles.note}>{t("orch.siteNote")}</Text>
                      </View>
                    ) : (
                      <PixelButton
                        skin={skin}
                        mini
                        variant="ghost"
                        label={t("orch.siteAdd")}
                        disabled={busy || siteBusy}
                        onPress={() => openSiteForm(provider.id, null)}
                      />
                    )}
                    {siteError ? <Text style={styles.bad}>{siteError}</Text> : null}
                  </View>,
                  true,
                )}

                <Pressable
                  style={styles.advancedToggle}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: advanced }}
                  onPress={() => setAdvancedId(advanced ? null : provider.id)}
                >
                  <Text style={styles.advancedHead}>
                    {advanced ? "⌄" : "›"} {t("orch.field.advanced")}
                  </Text>
                </Pressable>

                {advanced ? (
                  <View style={styles.advancedBody}>
                    <View style={styles.keys}>
                      {otherKeys.length === 0 ? <Text style={styles.dim}>{t("orch.noEnv")}</Text> : null}
                      {otherKeys.map((item) => {
                        const showing = revealed?.provider === provider.id && revealed.key === item.key;
                        return (
                          <View key={item.key} style={styles.keyRow}>
                            <Text style={styles.keyName} numberOfLines={1}>
                              {item.key}
                            </Text>
                            {isModelEnvKey(item.key) ? <Text style={styles.tierTag}>{t("orch.envModelTag")}</Text> : null}
                            {showing ? (
                              revealed && revealed.value !== null ? (
                                <Text style={styles.revealed} selectable numberOfLines={3}>
                                  {revealed.value}
                                </Text>
                              ) : (
                                <Text style={styles.bad} numberOfLines={2}>
                                  {revealed?.bad}
                                </Text>
                              )
                            ) : (
                              <Text style={item.masked ? styles.dim : styles.keyValue}>{item.display}</Text>
                            )}
                            <View style={{ flex: 1 }} />
                            {item.masked || showing ? (
                              <PixelButton
                                skin={skin}
                                mini
                                variant="ghost"
                                label={showing ? t("orch.envHide") : revealing ? t("orch.envRevealing") : t("orch.envReveal")}
                                disabled={revealing}
                                onPress={() => {
                                  if (showing) setRevealed(null);
                                  else void reveal(provider.id, item.key);
                                }}
                              />
                            ) : null}
                            <PixelButton
                              skin={skin}
                              mini
                              variant="ghost"
                              label={t("orch.envEdit")}
                              disabled={busy}
                              onPress={() => startEdit(provider.id, `env:${item.key}`, "")}
                            />
                          </View>
                        );
                      })}
                    </View>

                    <Text style={styles.note}>{t("orch.envModelNote")}</Text>

                    <View style={styles.form}>
                      <TextInput
                        accessibilityLabel={t("orch.envKeyField")}
                        style={styles.input}
                        value={envKey}
                        onChangeText={setEnvKey}
                        placeholder="ANTHROPIC_BASE_URL"
                        placeholderTextColor={skin.colors.ink2}
                        autoCapitalize="none"
                      />
                      <TextInput
                        accessibilityLabel={t("orch.envValueField")}
                        style={styles.input}
                        value={envValue}
                        onChangeText={setEnvValue}
                        placeholder={t("orch.envValueField")}
                        placeholderTextColor={skin.colors.ink2}
                        autoCapitalize="none"
                        secureTextEntry
                      />
                      <PixelButton
                        skin={skin}
                        mini
                        label={t("orch.saveEnv")}
                        disabled={busy || !envKey.trim() || !envValue}
                        onPress={() => {
                          const key = envKey.trim();
                          const value = envValue;
                          if (!key || !value) return;
                          onSaveEnv({ provider: provider.id, env: { [key]: value } });
                          setEnvKey("");
                          setEnvValue("");
                        }}
                      />
                    </View>
                    <Text style={styles.note}>{t("orch.envMergeOnly")}</Text>
                  </View>
                ) : null}

                <View style={styles.tools}>
                  <PixelButton
                    skin={skin}
                    mini
                    variant="ghost"
                    label={diagnosingId === provider.id ? t("orch.diagnosing") : t("orch.diagnose")}
                    disabled={diagnosingId === provider.id || installingId !== null}
                    onPress={() => void diagnose(provider.id)}
                  />
                  {installable && recipe ? (
                    confirmId === provider.id ? (
                      <>
                        <Text style={styles.dim}>{installCommandOf(recipe)}</Text>
                        <PixelButton
                          skin={skin}
                          mini
                          label={t("orch.install")}
                          disabled={installingId !== null}
                          onPress={() => void install(provider.id)}
                        />
                        <PixelButton skin={skin} mini variant="ghost" label={t("orch.cancel")} onPress={() => setConfirmId(null)} />
                      </>
                    ) : (
                      <PixelButton skin={skin} mini variant="ghost" label={t("orch.install")} onPress={() => setConfirmId(provider.id)} />
                    )
                  ) : null}
                </View>

                {lineNotice ? (
                  <View style={styles.output}>
                    {lineNotice.text.split("\n").map((text, index) => (
                      <Text
                        key={`${index}-${text.slice(0, 8)}`}
                        style={lineNotice.bad ? styles.bad : styles.outputText}
                        selectable
                      >
                        {text}
                      </Text>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
          </PixelCard>
        );
      })}
    </ScrollView>
  );
}
