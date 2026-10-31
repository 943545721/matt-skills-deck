import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { ProviderModelList } from "../../../../shared/orchestration-rpc.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";

/**
 * 客户端页顶部的「刷新宿主模型」。
 *
 * 宿主按工作区缓存模型清单：改完接入地址或模型后，宿主的模型选择器还停在
 * 旧快照上。这里只负责发起刷新并就地报结果——重读发生在服务端
 * （`deck.orchestration.provider.refresh`），不重启 App，也不动会话。
 */
export function HostCatalogBar({
  skin,
  t,
  disabled,
  onRefresh,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  disabled: boolean;
  onRefresh(): Promise<
    | { ok: true; providers: ProviderModelList[]; warnings: string[] }
    | { ok: false; detail: string }
  >;
}) {
  const [running, setRunning] = useState(false);
  /** `warn` 用于「刷新成功但有客户端没读出模型」：不是失败，也不该画成一切正常。 */
  const [notice, setNotice] = useState<{
    tone: "ok" | "warn" | "bad";
    text: string;
    warnings: string[];
  } | null>(null);

  const styles = useMemo(
    () => ({
      bar: { gap: 4, paddingBottom: 2 },
      hint: skin.hint,
      ok: { color: skin.colors.ok, fontSize: 11, lineHeight: 16 },
      warn: { color: skin.colors.warn, fontSize: 11, lineHeight: 16 },
      bad: { color: skin.colors.bad, fontSize: 11, lineHeight: 16 },
    }),
    [skin],
  );

  const run = async () => {
    setRunning(true);
    setNotice(null);
    try {
      const result = await onRefresh();
      if (!result.ok) {
        setNotice({ tone: "bad", text: result.detail, warnings: [] });
        return;
      }
      const summary = result.providers
        .map((row) => `${row.id} ${t("orch.modelCount", { n: row.models.length })}`)
        .join(" · ");
      const empty = result.providers.length === 0;
      setNotice({
        tone: empty || result.warnings.length > 0 ? "warn" : "ok",
        text: empty ? t("orch.hostRefreshEmpty") : t("orch.hostRefreshOk", { summary }),
        warnings: result.warnings,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <View style={styles.bar}>
      <PixelButton
        skin={skin}
        mini
        variant="ghost"
        label={running ? t("orch.hostRefreshing") : t("orch.hostRefresh")}
        disabled={running || disabled}
        onPress={() => void run()}
      />
      <Text style={styles.hint}>{t("orch.hostRefreshHint")}</Text>
      {notice ? (
        <View style={{ gap: 1 }}>
          <Text
            style={notice.tone === "bad" ? styles.bad : notice.tone === "warn" ? styles.warn : styles.ok}
            selectable
          >
            {notice.text}
          </Text>
          {notice.warnings.map((warning, index) => (
            // 警告文本可能重复（两家报同一个错），不能拿它当 key。
            <Text key={`${index}:${warning}`} style={styles.warn} selectable>
              {warning}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
