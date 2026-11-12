import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { addModelId, filterModelIds, removeModelId, type ModelListKey } from "../../../../shared/provider-models.ts";
import type { ProviderModelDefinition } from "../../../../shared/provider-models.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";

/**
 * 模型清单：只列**我们这条接口提供的模型**。
 *
 * 不列客户端自带的型号（`claude-opus-*` / `sonnet` / `haiku`…）：那些是客户端厂商的
 * 目录，跟我们接的这条链路无关。
 *
 * 交互照设置面板的走法：先是一排型号（点一下取消，带 ✓），
 * 上面是「筛选 / 全选 / 全不选 / 从接口获取」，接口回来但还没加进来的用虚线 `＋` 排在后面。
 *
 * 清单存在宿主配置里（`additionalModels` 或 `models`，按客户端原本用的那把），
 * 写回是替换语义：加一个就多一个，点掉一个就真删。
 */
export function ModelPicker({
  skin,
  t,
  models,
  listKey,
  baseUrl,
  busy,
  onSave,
  onFetch,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  /** 我们这个接口提供的模型 id（配置里声明的那些）。 */
  models: string[];
  /** 声明落在哪把键上，只用来提示「追加」还是「替换」。 */
  listKey: ModelListKey;
  /** 当前生效的接口地址；换了地址，上一次拉到的清单（连同窗口）就不能再拿去保存。 */
  baseUrl?: string | null;
  busy: boolean;
  onSave(models: string[], definitions?: ProviderModelDefinition[]): void;
  /** 用配置里已有的 base url + 凭据去问接口要清单。 */
  onFetch(): Promise<{ ok: true; endpoint: string; models: ProviderModelDefinition[] } | { ok: false; detail: string }>;
}) {
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");
  /** 接口回来的清单；`null` 表示这次还没问过。 */
  const [fetched, setFetched] = useState<{ endpoint: string; models: ProviderModelDefinition[] } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // 地址一换，旧接口的模型清单与窗口就作废：留着它，「保存模型」会把旧窗口写进新地址。
  useEffect(() => {
    setFetched(null);
    setFetchError(null);
  }, [baseUrl]);

  const visible = useMemo(() => filterModelIds(models, query), [models, query]);

  const styles = useMemo(
    () => ({
      wrap: { gap: 8 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      count: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, flexGrow: 1, minWidth: 120 },
      filter: { ...skin.input, flexGrow: 1, minWidth: 160 },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      chip: {
        borderWidth: 1,
        borderColor: skin.colors.acc,
        paddingVertical: 4,
        paddingHorizontal: 9,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
      },
      chipOff: { borderColor: skin.colors.line },
      chipText: { color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily },
      /** 勾选标记就是那个「已选」的记号，不再额外占一枚按钮。 */
      chipMark: { color: skin.colors.acc, fontSize: 12, fontFamily: skin.mono.fontFamily },
      chipCross: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      hint: skin.hint,
      empty: { color: skin.colors.ink2, fontSize: 12, lineHeight: 18 },
      fetchedChip: {
        borderWidth: 1,
        borderColor: skin.colors.line,
        borderStyle: "dashed" as const,
        paddingVertical: 4,
        paddingHorizontal: 9,
      },
      error: { color: skin.colors.bad, fontSize: 11, lineHeight: 16 },
    }),
    [skin],
  );

  const runFetch = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const result = await onFetch();
      if (!result.ok) {
        setFetched(null);
        setFetchError(result.detail);
        return;
      }
      setFetched({ endpoint: result.endpoint, models: result.models });
    } finally {
      setFetching(false);
    }
  };

  /** 接口回来的、我们清单里还没有的那些。 */
  const missing = fetched ? fetched.models.filter((model) => !models.includes(model.id)).map((model) => model.id) : [];

  const remove = (id: string) => {
    if (busy) return;
    onSave(removeModelId(models, id));
  };

  const add = (id: string) => {
    if (busy) return;
    const next = addModelId(models, id);
    if (next.length !== models.length) onSave(next, fetched?.models.filter((model) => next.includes(model.id)));
  };

  const selectAll = () => {
    if (busy || !fetched) return;
    const next = fetched.models.reduce((acc, model) => addModelId(acc, model.id), [...models]);
    if (next.length !== models.length) onSave(next, fetched.models.filter((model) => next.includes(model.id)));
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.count}>
          {t("orch.modelPicked", { n: models.length })}
          {" · "}
          {listKey === "models" ? t("orch.modelModeReplace") : t("orch.modelModeAppend")}
        </Text>
        <PixelButton
          skin={skin}
          mini
          variant="ghost"
          label={fetching ? t("orch.modelFetching") : t("orch.modelFetch")}
          disabled={fetching || busy}
          onPress={() => void runFetch()}
        />
        <PixelButton skin={skin} mini variant="ghost" label={t("orch.modelSelectAll")} disabled={busy || !fetched || missing.length === 0} onPress={selectAll} />
        <PixelButton skin={skin} mini variant="ghost" label={t("orch.modelSelectNone")} disabled={busy || models.length === 0} onPress={() => onSave([])} />
        <PixelButton
          skin={skin}
          mini
          variant="ghost"
          label={t("orch.modelSave")}
          disabled={busy || !fetched || models.length === 0}
          onPress={() => onSave(models, fetched?.models.filter((model) => models.includes(model.id)))}
        />      </View>

      {fetchError ? <Text style={styles.error}>{fetchError}</Text> : null}
      {fetched ? (
        <Text style={styles.count}>
          {t("orch.modelFetchOk", { n: fetched.models.length })}
          {missing.length ? ` · ${t("orch.modelFetchMissing", { n: missing.length })}` : ` · ${t("orch.modelFetchAll")}`}
        </Text>
      ) : null}

      <TextInput
        accessibilityLabel={t("orch.modelFilter")}
        style={styles.filter}
        value={query}
        onChangeText={setQuery}
        placeholder={t("orch.modelFilterCount", { n: models.length })}
        placeholderTextColor={skin.colors.ink2}
        autoCapitalize="none"
      />

      <View style={styles.chips}>
        {models.length === 0 ? <Text style={styles.empty}>{t("orch.modelNone")}</Text> : null}
        {models.length > 0 && visible.length === 0 ? <Text style={styles.empty}>{t("orch.modelNoMatch")}</Text> : null}
        {visible.map((id) => (
          <Pressable
            key={id}
            style={styles.chip}
            accessibilityRole="button"
            accessibilityState={{ selected: true }}
            accessibilityLabel={`${id}，${t("orch.modelRemove")}`}
            accessibilityHint={t("orch.modelRemove")}
            disabled={busy}
            onPress={() => remove(id)}
          >
            <Text style={styles.chipMark}>✓</Text>
            <Text style={styles.chipText}>{id}</Text>
            <Text style={styles.chipCross}>×</Text>
          </Pressable>
        ))}
        {missing
          .filter((id) => !query.trim() || id.toLowerCase().includes(query.trim().toLowerCase()))
          .map((id) => (
            <Pressable
              key={`fetched-${id}`}
              style={[styles.fetchedChip, styles.chipOff]}
              accessibilityRole="button"
              accessibilityLabel={`${id}，${t("orch.modelAdd")}`}
              disabled={busy}
              onPress={() => {
                const next = addModelId(models, id);
                onSave(next, fetched?.models.filter((model) => next.includes(model.id)));
              }}
            >
              <Text style={styles.chipText}>＋ {id}</Text>
            </Pressable>
          ))}
      </View>

      <View style={styles.head}>
        <TextInput
          accessibilityLabel={t("orch.modelCustom")}
          style={styles.filter}
          value={custom}
          onChangeText={setCustom}
          placeholder={t("orch.modelCustom")}
          placeholderTextColor={skin.colors.ink2}
          autoCapitalize="none"
        />
        <PixelButton
          skin={skin}
          mini
          label={t("orch.modelAdd")}
          disabled={busy || !custom.trim()}
          onPress={() => {
            const id = custom.trim();
            setCustom("");
            if (id) add(id);
          }}
        />
      </View>
      <Text style={styles.hint}>{t("orch.modelHint")}</Text>
    </View>
  );
}
