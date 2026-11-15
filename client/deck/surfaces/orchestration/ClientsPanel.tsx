import { useMemo } from "react";
import { Text } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import type { ProviderModelList } from "../../../../shared/orchestration-rpc.ts";
import type { ProviderModelDefinition } from "../../../../shared/provider-models.ts";
import type { PanelTextFn } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { HostCatalogBar } from "./HostCatalogBar.tsx";
import type { ModelThinkingDefault } from "./modelThinking.ts";
import { ProviderCard } from "./ProviderCard.tsx";
import { ProviderSourceDialog } from "./ProviderSourceDialog.tsx";
import type { ProviderRow } from "./types.ts";
import { useCardOpenState, type CardOpenState } from "./useCardOpenState.ts";
import { useEnvAddition, type EnvAddition } from "./useEnvAddition.ts";
import { useFieldEditing, type FieldEditing } from "./useFieldEditing.ts";
import { useProviderDiagnostics, type ProviderDiagnostics } from "./useProviderDiagnostics.ts";
import { useProviderReveal, type ProviderReveal } from "./useProviderReveal.ts";
import { useSiteEditor, type SiteEditor } from "./useSiteEditor.ts";

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
 * 写入是深合并：只能「新增/覆盖某个键」；删键走注入源弹窗的「清理选中」——
 * 服务端把条目整个摘掉再写回清理后的形状，写后读回核对。
 *
 * 状态按 provider 归属：编辑、原值显示、诊断结果与站点表单都记着自己属于哪张卡片，
 * 切换卡片不会串。真正的卡片视图在 `ProviderCard`，这里只做列表与弹窗编排。
 */
type ClientsPanelProps = {
  skin: PixelSkin;
  t: PanelTextFn;
  providers: ProviderRow[];
  onSaveEnv(input: { provider: string; env: Record<string, string> }): void;
  /** 传这个客户端声明的**完整**模型清单（替换语义）。 */
  onSaveModel(input: { provider: string; models: string[]; modelDefinitions?: ProviderModelDefinition[] }): void;
  /** 只改显示名。 */
  onSaveLabel(input: { provider: string; label: string }): void;
  /** 全量默认档表（来自设置）；界面按 provider + model 查自己那一条。 */
  modelThinking: readonly ModelThinkingDefault[];
  /** 设 / 清一个模型的默认档；`thinkingOptionId: null` 是清除。 */
  onSaveThinking(input: { provider: string; model: string; thinkingOptionId: string | null }): void;
  /** 取宿主诊断原文；失败时返回可直接展示的原因。 */
  onDiagnose(provider: string): Promise<{ ok: true; diagnostic: string } | { ok: false; detail: string }>;
  /** 取某一个键的原值；用户显式点「显示」才会调用。 */
  onReveal(provider: string, key: string): Promise<{ ok: true; value: string } | { ok: false; detail: string }>;
  /** 真的执行 `npm install -g`；二次确认由本组件负责。 */
  onInstall(provider: string): Promise<{ ok: true; output: string } | { ok: false; detail: string; output?: string }>;
  /** 用配置里已有的 base url + 凭据去问接口要模型清单。 */
  onFetchModels(provider: string): Promise<
    { ok: true; endpoint: string; models: ProviderModelDefinition[] } | { ok: false; detail: string }
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
  /** 清理源文件后让父组件重取 provider 状态（卡片计数跟着变）。 */
  onChanged(): void;
  busy: boolean;
};

type ClientListProps = {
  skin: PixelSkin;
  t: PanelTextFn;
  providers: ProviderRow[];
  busy: boolean;
  onRefreshCatalog(): Promise<
    | { ok: true; providers: ProviderModelList[]; warnings: string[] }
    | { ok: false; detail: string }
  >;
  cards: CardOpenState;
  editing: FieldEditing;
  reveal: ProviderReveal;
  diagnostics: ProviderDiagnostics;
  site: SiteEditor;
  addition: EnvAddition;
  modelThinking: readonly ModelThinkingDefault[];
  onSaveEnv(input: { provider: string; env: Record<string, string> }): void;
  onSaveModel(input: { provider: string; models: string[]; modelDefinitions?: ProviderModelDefinition[] }): void;
  onSaveThinking(input: { provider: string; model: string; thinkingOptionId: string | null }): void;
  onFetchModels(provider: string): Promise<
    { ok: true; endpoint: string; models: ProviderModelDefinition[] } | { ok: false; detail: string }
  >;
};

function ClientList({
  skin,
  t,
  providers,
  busy,
  onRefreshCatalog,
  cards,
  editing,
  reveal,
  diagnostics,
  site,
  addition,
  modelThinking,
  onSaveEnv,
  onSaveModel,
  onSaveThinking,
  onFetchModels,
}: ClientListProps) {
  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      dim: { color: skin.colors.ink2, fontSize: 12, lineHeight: 18 },
      note: skin.hint,
    }),
    [skin],
  );
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 16 }}>
      <HostCatalogBar skin={skin} t={t} disabled={busy || site.busy} onRefresh={onRefreshCatalog} />

      {/* 只列两家是刻意收窄的：其余客户端插件注不进去，列出来只会配出一份没人读的配置。 */}
      <Text style={styles.dim}>{t("orch.clientsScope")}</Text>

      {providers.length === 0 ? <Text style={styles.note}>{t("orch.noProviders")}</Text> : null}

      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          skin={skin}
          t={t}
          provider={provider}
          providers={providers}
          modelThinking={modelThinking}
          busy={busy}
          open={cards.openFor(provider.id)}
          advanced={cards.advancedFor(provider.id)}
          onToggleOpen={() => cards.toggleOpen(provider.id)}
          onToggleAdvanced={() => cards.toggleAdvanced(provider.id)}
          onOpenSource={() => cards.openSource(provider.id)}
          editing={editing}
          reveal={reveal}
          diagnostics={diagnostics}
          site={site}
          addition={addition}
          onSaveEnv={onSaveEnv}
          onSaveModel={onSaveModel}
          onSaveThinking={onSaveThinking}
          onFetchModels={() => onFetchModels(provider.id)}
        />
      ))}
    </ScrollView>
  );
}

export function ClientsPanel({
  skin,
  t,
  providers,
  onSaveEnv,
  onSaveModel,
  onSaveLabel,
  modelThinking,
  onSaveThinking,
  onDiagnose,
  onInstall,
  onReveal,
  onFetchModels,
  onRefreshCatalog,
  onSaveSite,
  onChanged,
  busy,
}: ClientsPanelProps) {
  const editing = useFieldEditing({ label: onSaveLabel, env: onSaveEnv });
  const reveal = useProviderReveal(onReveal);
  const diagnostics = useProviderDiagnostics({ t, diagnose: onDiagnose, install: onInstall });
  const site = useSiteEditor(onSaveSite);
  const addition = useEnvAddition();
  const cards = useCardOpenState({ editing, reveal, diagnostics });
  return (
    <>
      <ClientList
        skin={skin}
        t={t}
        providers={providers}
        busy={busy}
        onRefreshCatalog={onRefreshCatalog}
        cards={cards}
        editing={editing}
        reveal={reveal}
        diagnostics={diagnostics}
        site={site}
        addition={addition}
        modelThinking={modelThinking}
        onSaveEnv={onSaveEnv}
        onSaveModel={onSaveModel}
        onSaveThinking={onSaveThinking}
        onFetchModels={onFetchModels}
      />
      <ProviderSourceDialog
        skin={skin}
        t={t}
        provider={cards.sourceProvider}
        onClose={cards.closeSource}
        onChanged={onChanged}
      />
    </>
  );
}
