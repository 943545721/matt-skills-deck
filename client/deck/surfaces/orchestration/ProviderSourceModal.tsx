import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Pressable, Text, View } from "react-native";
import { orchestrationProviderCleanupRpc, orchestrationProviderSourceRpc } from "../../../../shared/orchestration-rpc.ts";
import { isProtectedEnvKey } from "../../../../shared/provider-env.ts";
import { PixelButton, PixelModalBody, type PixelSkin } from "../../pixel";
import type { PanelTextFn } from "../../panel/panelText";

/**
 * 注入源文件只读视图 + 指定清理。
 *
 * 用户看到卡片上的「N 个密钥」时，需要能对上源文件里到底是哪几条：
 * 地址、凭据、以及其它 env 键。这里只展示键名与掩码值，原始密钥不落到界面；
 * 想看某一个键的原值仍走卡片上的「显示」。
 *
 * 清理不是直接改 env（宿主深合并删不掉键）：勾选后交给 `provider.cleanup`，
 * 服务端把条目整个摘掉再写回清理后的形状，写后读回核对。地址/凭据键默认保护，
 * 需要第二次确认才会带 `allowProtected` 发出。
 */
type SourceResult = RpcOutput<typeof orchestrationProviderSourceRpc>;
type SourceEntryRow = Extract<SourceResult, { ok: true }>["entries"][number];
type CleanupInput = RpcInput<typeof orchestrationProviderCleanupRpc>;
type CleanupResult = RpcOutput<typeof orchestrationProviderCleanupRpc>;
type CleanupState = {
  selectedKeys: Record<string, string[]>;
  selectedEntries: string[];
  confirming: boolean;
  busy: boolean;
  cleanupError: string | null;
  cleanupDone: string | null;
};
type SetCleanupState = Dispatch<SetStateAction<CleanupState>>;
type CleanupOwner = { isCurrent(): boolean; release(): void };
type ProviderSourceModalProps = {
  skin: PixelSkin;
  t: PanelTextFn;
  open: boolean;
  provider: string;
  loading: boolean;
  error: string | null;
  result: SourceResult | null;
  onClose(): void;
  /** 清理成功后重新读源文件；父组件负责更新 result。 */
  onRefresh(): void;
  /** 清理成功后让父组件重取 provider 状态（卡片计数）。 */
  onChanged(): void;
};

function stylesOf(skin: PixelSkin) {
  return {
    body: { gap: 10 },
    scroll: { maxHeight: 480 },
    label: { color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
    path: { color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily },
    note: { color: skin.colors.ink2, fontSize: 12, lineHeight: 18 },
    dim: { color: skin.colors.ink2, fontSize: 12, lineHeight: 18 },
    bad: { color: skin.colors.bad, fontSize: 12, lineHeight: 18 },
    good: { color: skin.colors.ok, fontSize: 12, lineHeight: 18 },
    entry: { gap: 4, borderTopWidth: 1, borderTopColor: skin.colors.line, paddingTop: 8, marginTop: 4 },
    entryHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
    entryTitle: { color: skin.colors.acc, fontSize: 13, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
    envLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    envRow: { color: skin.colors.ink, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
    maskedValue: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
    check: { color: skin.colors.ink, fontSize: 14, fontFamily: skin.mono.fontFamily },
    checkDisabled: { color: skin.colors.ink2, opacity: 0.5 },
    cleanupBox: { gap: 6, borderTopWidth: 1, borderTopColor: skin.colors.line, paddingTop: 8 },
    actions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: 8, flexWrap: "wrap" as const },
  };
}

type Styles = ReturnType<typeof stylesOf>;

function initialCleanupState(): CleanupState {
  return { selectedKeys: {}, selectedEntries: [], confirming: false, busy: false, cleanupError: null, cleanupDone: null };
}

function cleanupSelection(result: SourceResult | null, state: CleanupState) {
  const { selectedKeys, selectedEntries } = state;
  const cleanups: CleanupInput["cleanups"] = [
    ...Object.entries(selectedKeys).flatMap(([entryId, keys]) => keys.length > 0 ? [{ entryId, keys }] : []),
    ...selectedEntries.map((entryId) => ({ entryId, keys: [], removeEntry: true })),
  ];
  const selectionCount =
    Object.values(selectedKeys).reduce((sum, keys) => sum + keys.length, 0) + selectedEntries.length;
  const protectedSelected = result?.ok === true && result.entries.some((entry) =>
    (selectedKeys[entry.id] ?? []).some((key) => isProtectedEnvKey(key)),
  );
  const nonEmptyEntrySelected = result?.ok === true && result.entries.some((entry) =>
    selectedEntries.includes(entry.id) && !entry.removable,
  );
  return { cleanups, selectionCount, protectedSelected, nonEmptyEntrySelected };
}

function toggleSourceKey(state: CleanupState, entry: SourceEntryRow, key: string): CleanupState {
  if (state.selectedEntries.includes(entry.id)) return state;
  const keys = state.selectedKeys[entry.id] ?? [];
  const next = keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key];
  const selectedKeys = { ...state.selectedKeys };
  if (next.length > 0) selectedKeys[entry.id] = next;
  else delete selectedKeys[entry.id];
  return { ...state, selectedKeys, confirming: false, cleanupDone: null, cleanupError: null };
}

function toggleSourceEntry(state: CleanupState, entryId: string): CleanupState {
  const selectedEntries = state.selectedEntries.includes(entryId)
    ? state.selectedEntries.filter((id) => id !== entryId) : [...state.selectedEntries, entryId];
  const selectedKeys = { ...state.selectedKeys };
  delete selectedKeys[entryId];
  return { ...state, selectedEntries, selectedKeys, confirming: false, cleanupDone: null, cleanupError: null };
}

function useCleanupOwner(open: boolean, provider: string, setState: SetCleanupState) {
  const generation = useRef<{ request: object | null } | null>(null);
  // 每次 open/provider 提交都换世代；layout 清理在关闭、换客户端、卸载时同步失效，
  // 不留下等待 passive effect 执行期间旧响应还能写入的窗口。
  useLayoutEffect(() => {
    generation.current = open ? { request: null } : null;
    setState(initialCleanupState());
    return () => { generation.current = null; };
  }, [open, provider, setState]);

  return (): CleanupOwner | null => {
    const owner = generation.current;
    if (!owner || owner.request) return null;
    const request = {};
    owner.request = request;
    const isCurrent = () => generation.current === owner && owner.request === request;
    return { isCurrent, release: () => { if (isCurrent()) owner.request = null; } };
  };
}

function cleanupMessage(response: Extract<CleanupResult, { ok: true }>, t: PanelTextFn) {
  const items = response.removed.flatMap((item) =>
    item.entryRemoved ? [item.entryId] : item.keys.map((key) => `${item.entryId}.${key}`),
  ).join(", ");
  const warnings = response.warnings ?? [];
  const done = t("orch.source.cleanupDone", { items });
  return warnings.length > 0 ? `${done}；${warnings.join("；")}` : done;
}

type CleanupRequest = {
  cleanup(input: CleanupInput): Promise<CleanupResult>;
  input: CleanupInput;
  owner: CleanupOwner;
  setState: SetCleanupState;
  t: PanelTextFn;
  onRefresh(): void;
  onChanged(): void;
};

async function submitCleanup({ cleanup, input, owner, setState, t, onRefresh, onChanged }: CleanupRequest) {
  setState((state) => ({ ...state, busy: true, cleanupError: null, cleanupDone: null }));
  try {
    const response = await cleanup(input);
    if (!owner.isCurrent()) return;
    if (!response.ok) {
      setState((state) => ({ ...state, cleanupError: response.detail }));
      return;
    }
    const cleanupDone = cleanupMessage(response, t);
    setState((state) => ({ ...state, selectedKeys: {}, selectedEntries: [], confirming: false, cleanupDone }));
    onRefresh();
    if (owner.isCurrent()) onChanged();
  } catch (failure) {
    if (!owner.isCurrent()) return;
    const cleanupError = failure instanceof Error ? failure.message : String(failure);
    setState((state) => ({ ...state, cleanupError }));
  } finally {
    if (owner.isCurrent()) {
      owner.release();
      setState((state) => ({ ...state, busy: false }));
    }
  }
}

function useProviderCleanup({ open, provider, result, t, onRefresh, onChanged }: ProviderSourceModalProps) {
  const cleanup = useRpc(orchestrationProviderCleanupRpc);
  const [state, setState] = useState(initialCleanupState);
  const beginRequest = useCleanupOwner(open, provider, setState);
  const selection = cleanupSelection(result, state);
  const runCleanup = () => {
    if (selection.cleanups.length === 0) return;
    const owner = beginRequest();
    if (!owner) return;
    void submitCleanup({ cleanup, owner, setState, t, onRefresh, onChanged, input: {
      provider,
      cleanups: selection.cleanups,
      ...(selection.protectedSelected ? { allowProtected: true } : {}),
      ...(selection.nonEmptyEntrySelected ? { allowNonEmpty: true } : {}),
    } });
  };
  return {
    ...state, ...selection, runCleanup,
    toggleKey: (entry: SourceEntryRow, key: string) => setState((current) => toggleSourceKey(current, entry, key)),
    toggleEntry: (entryId: string) => setState((current) => toggleSourceEntry(current, entryId)),
    setConfirming: (confirming: boolean) => setState((current) => ({ ...current, confirming })),
  };
}

type CleanupController = ReturnType<typeof useProviderCleanup>;
type SourceEntryProps = {
  entry: SourceEntryRow;
  styles: Styles;
  t: PanelTextFn;
  selectedKeys: readonly string[];
  entrySelected: boolean;
  onToggleKey(entry: SourceEntryRow, key: string): void;
  onToggleEntry(entryId: string): void;
};
type SourceEnvRowProps = Pick<SourceEntryProps, "entry" | "styles" | "t" | "entrySelected" | "onToggleKey"> & {
  row: SourceEntryRow["env"][number];
  checked: boolean;
};

function SourceEnvRow({ entry, row, styles, t, checked, entrySelected, onToggleKey }: SourceEnvRowProps) {
  return (
    <View style={styles.envLine}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: entrySelected }}
        disabled={entrySelected}
        onPress={() => onToggleKey(entry, row.key)}
      >
        <Text style={[styles.check, entrySelected ? styles.checkDisabled : null]}>{checked ? "☑" : "☐"}</Text>
      </Pressable>
      <Text
        style={[row.masked ? styles.maskedValue : styles.envRow, entrySelected ? styles.checkDisabled : null]}
        selectable
      >
        {row.key} = {row.display || t("orch.source.emptyValue")}
      </Text>
    </View>
  );
}

function SourceEntry({ entry, styles, t, selectedKeys, entrySelected, onToggleKey, onToggleEntry }: SourceEntryProps) {
  return (
    <View style={styles.entry}>
      <View style={styles.entryHead}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: entrySelected }}
          onPress={() => onToggleEntry(entry.id)}
        >
          <Text style={styles.check}>{entrySelected ? "☑" : "☐"}</Text>
        </Pressable>
        <Text style={styles.entryTitle}>
          {entry.id}
          {entry.effective ? ` · ${t("orch.source.effective")}` : ""}
          {entry.extends ? ` · ${t("orch.source.extends", { provider: entry.extends })}` : ""}
          {entry.enabled ? "" : ` · ${t("orch.disabled")}`}
        </Text>
        <Text style={styles.dim}>
          {entry.removable ? t("orch.source.cleanupEntry") : t("orch.source.cleanupEntryFull")}
        </Text>
      </View>
      <Text style={styles.dim}>
        {t("orch.source.fields")}: {entry.fields.join(", ") || t("orch.source.none")}
      </Text>
      <Text style={styles.dim}>
        {t("orch.source.models")}: {entry.models.join(", ") || t("orch.source.none")}
      </Text>
      <Text style={styles.label}>{t("orch.source.env")}</Text>
      {entry.env.length === 0 ? <Text style={styles.dim}>{t("orch.source.none")}</Text> : null}
      {entry.env.map((row) => (
        <SourceEnvRow
          key={row.key} entry={entry} row={row} styles={styles} t={t}
          checked={!entrySelected && selectedKeys.includes(row.key)}
          entrySelected={entrySelected} onToggleKey={onToggleKey}
        />
      ))}
    </View>
  );
}

type SourceEntriesProps = {
  result: Extract<SourceResult, { ok: true }>;
  styles: Styles;
  t: PanelTextFn;
  controller: CleanupController;
};

function SourceEntries({ result, styles, t, controller }: SourceEntriesProps) {
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={{ gap: 8 }}>
      <Text style={styles.label}>{t("orch.source.path")}</Text>
      <Text style={styles.path} selectable>{result.path}</Text>
      <Text style={styles.note}>{t("orch.source.note")}</Text>
      <Text style={styles.dim}>{t("orch.source.cleanupHint")}</Text>
      {result.entries.map((entry) => (
        <SourceEntry
          key={entry.id} entry={entry} styles={styles} t={t}
          selectedKeys={controller.selectedKeys[entry.id] ?? []}
          entrySelected={controller.selectedEntries.includes(entry.id)}
          onToggleKey={controller.toggleKey} onToggleEntry={controller.toggleEntry}
        />
      ))}
    </ScrollView>
  );
}

type CleanupViewProps = {
  styles: Styles;
  t: PanelTextFn;
  controller: CleanupController;
};

function CleanupFeedback({ styles, t, controller }: CleanupViewProps) {
  const { cleanupDone, cleanupError, confirming, selectionCount, protectedSelected, nonEmptyEntrySelected, selectedEntries } = controller;
  return (
    <View style={styles.cleanupBox}>
      {cleanupDone ? <Text style={styles.good}>{cleanupDone}</Text> : null}
      {cleanupError ? <Text style={styles.bad}>{t("orch.source.cleanupFailed", { detail: cleanupError })}</Text> : null}
      {confirming ? (
        <>
          <Text style={styles.note}>{t("orch.source.cleanupConfirm", { n: selectionCount })}</Text>
          {protectedSelected ? <Text style={styles.bad}>{t("orch.source.cleanupProtected")}</Text> : null}
          {nonEmptyEntrySelected ? (
            <Text style={styles.bad}>
              {t("orch.source.cleanupNonEmpty", { entries: selectedEntries.join(", ") })}
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function CleanupActions({ skin, styles, t, controller, onClose }: CleanupViewProps & {
  skin: PixelSkin; onClose(): void;
}) {
  const { confirming, busy, selectionCount, runCleanup, setConfirming } = controller;
  return (
    <View style={styles.actions}>
      {confirming ? (
        <>
          <PixelButton
            skin={skin} variant="solid"
            label={busy ? t("orch.source.cleanupBusy") : t("orch.source.cleanupRun")}
            disabled={busy} onPress={runCleanup}
          />
          <PixelButton
            skin={skin} variant="ghost" label={t("orch.source.cleanupCancel")}
            disabled={busy} onPress={() => setConfirming(false)}
          />
        </>
      ) : (
        <PixelButton
          skin={skin} variant="outline"
          label={busy ? t("orch.source.cleanupBusy") : t("orch.source.cleanup")}
          disabled={busy || selectionCount === 0} onPress={() => setConfirming(true)}
        />
      )}
      <PixelButton skin={skin} variant="outline" label={t("orch.source.close")} onPress={onClose} />
    </View>
  );
}

export function ProviderSourceModal(props: ProviderSourceModalProps) {
  const { skin, t, open, provider, loading, error, result, onClose } = props;
  const styles = stylesOf(skin);
  const controller = useProviderCleanup(props);
  return (
    <Modal
      title={t("orch.source.title", { provider: provider || "—" })}
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
    >
      <Modal.Content>
        <PixelModalBody skin={skin} style={styles.body}>
          {loading ? <Text style={styles.dim}>{t("orch.source.loading")}</Text> : null}
          {error ? <Text style={styles.bad}>{t("orch.source.failed", { detail: error })}</Text> : null}
          {result && !result.ok ? <Text style={styles.bad}>{result.detail}</Text> : null}
          {result?.ok ? <SourceEntries result={result} styles={styles} t={t} controller={controller} /> : null}
          <CleanupFeedback styles={styles} t={t} controller={controller} />
          <CleanupActions skin={skin} styles={styles} t={t} controller={controller} onClose={onClose} />
        </PixelModalBody>
      </Modal.Content>
    </Modal>
  );
}
