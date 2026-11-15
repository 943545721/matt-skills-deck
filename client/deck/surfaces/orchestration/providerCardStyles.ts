import type { ProviderModelDefinition } from "../../../../shared/provider-models.ts";
import type { PanelTextFn } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import type { ProviderRow } from "./types.ts";
import type { EnvAddition } from "./useEnvAddition.ts";
import type { FieldEditing } from "./useFieldEditing.ts";
import type { ProviderDiagnostics } from "./useProviderDiagnostics.ts";
import type { ProviderReveal } from "./useProviderReveal.ts";
import type { SiteEditor } from "./useSiteEditor.ts";

/** 卡片内各区块共用的样式；只依赖 skin，不随卡片状态变化。 */
export function cardStylesOf(skin: PixelSkin) {
  return {
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
    link: { color: skin.colors.acc, textDecorationLine: "underline" as const },
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
    keyName: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily, maxWidth: "55%" as const },
    form: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
    tools: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const, paddingTop: 8 },
    output: { borderLeftWidth: 1, borderLeftColor: skin.colors.line, paddingLeft: 8, gap: 1 },
    outputText: { color: skin.colors.ink2, fontSize: 11, lineHeight: 15, fontFamily: skin.mono.fontFamily },
  };
}

export type CardStyles = ReturnType<typeof cardStylesOf>;

/** 卡片内各区块共用的上下文；字段按 provider 归属后由 hooks 提供。 */
export type CardContext = {
  skin: PixelSkin;
  t: PanelTextFn;
  provider: ProviderRow;
  busy: boolean;
  styles: CardStyles;
  editing: FieldEditing;
  reveal: ProviderReveal;
  site: SiteEditor;
  addition: EnvAddition;
  advanced: boolean;
  onToggleAdvanced(): void;
  onSaveEnv(env: Record<string, string>): void;
};

export type ProviderCardActions = {
  onSaveModel(input: { provider: string; models: string[]; modelDefinitions?: ProviderModelDefinition[] }): void;
  onSaveThinking(input: { provider: string; model: string; thinkingOptionId: string | null }): void;
  onFetchModels(): Promise<
    { ok: true; endpoint: string; models: ProviderModelDefinition[] } | { ok: false; detail: string }
  >;
};
