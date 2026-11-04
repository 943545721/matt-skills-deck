import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { ArchivedAgentRow } from "../../../../shared/orchestration-rpc.ts";
import { clockText } from "../../format.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";
import { filterArchivedRows } from "./archivedFilter.ts";
import { OrchSection, rowDivider } from "./parts.tsx";

/**
 * 已归档会话。
 *
 * 一屏回答三个问题：**它是什么**（标题 / 角色 / 哪张票）、**它的 id 是多少**
 * （provider 会话 id 与内部 agent id 两个都摊开，各自可复制）、**怎么把它弄回来**
 * （一条能直接粘进终端的命令）。
 *
 * 不做「一键恢复」：宿主没有取消归档的接口，恢复只能重新 import 那条 provider 会话，
 * 而 import 只有 CLI/底层客户端能做，插件这一层调不到。所以这里的动作是「复制」——
 * 与其做一个按下就什么都不发生的按钮，不如把命令摆出来。
 *
 * 没有「取消」也没有「删除」：归档记录是宿主的东西，这一页只读。
 */
export function ArchivedPanel({
  skin,
  t,
  rows,
  truncated,
  warnings,
  loading,
  error,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onReload,
  onCopy,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  rows: readonly ArchivedAgentRow[];
  /** 宿主的归档还没读完：这时候「没有记录」不能当成「真的没有」。 */
  truncated: boolean;
  warnings: readonly string[];
  loading: boolean;
  error: string | null;
  /** 还能往更早读：宿主的归档跨全部工作区，本工作区的记录可能排得很后面。 */
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder(): void;
  onReload(): void;
  onCopy(text: string): void;
}) {
  const [query, setQuery] = useState("");

  const styles = useMemo(
    () => ({
      hint: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      warn: skin.error,
      filter: { fontSize: 12, color: skin.colors.ink, fontFamily: skin.mono.fontFamily },
      row: { paddingVertical: 6, gap: 2 },
      titleLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      name: { flex: 1, color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily, fontWeight: "700" as const },
      tag: { color: skin.colors.acc, fontSize: 10, fontFamily: skin.mono.fontFamily },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      idLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      idText: { flex: 1, color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      commandLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      command: { flex: 1, color: skin.colors.ink, fontSize: 11, fontFamily: skin.mono.fontFamily },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    }),
    [skin],
  );

  const shown = filterArchivedRows(rows, query);
  const aside = loading ? t("orch.archived.loading") : t("orch.archived.count", { n: rows.length });

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16, gap: 10 }}>
      <OrchSection skin={skin} title={t("orch.archived.title")} aside={aside}>
        <Text style={styles.hint}>{t("orch.archived.blurb")}</Text>

        {/* 截断与「没有会话 id」都在服务端的 warnings 里说一次，这里不再抄一遍。 */}
        {warnings.map((warning) => (
          <Text key={warning} style={styles.hint}>
            {warning}
          </Text>
        ))}
        {error ? <Text style={styles.warn}>{error}</Text> : null}

        <View style={styles.toolbar}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("orch.archived.search")}
            accessibilityLabel={t("orch.archived.search")}
            placeholderTextColor={skin.colors.ink2}
            style={[skin.input, styles.filter, { flex: 1 }]}
          />
          <PixelButton
            skin={skin}
            mini
            variant="ghost"
            label={loading ? t("common.refreshing") : t("common.refresh")}
            onPress={onReload}
          />
        </View>

        {!loading && !error && rows.length === 0 ? (
          <Text style={styles.hint}>{truncated ? t("orch.archived.emptyTruncated") : t("orch.archived.empty")}</Text>
        ) : null}
        {query.trim() && rows.length > 0 && shown.length === 0 ? (
          // 没读到更早的记录时，「没有匹配」不等于「不存在」：措辞必须带上这一层。
          <Text style={styles.hint}>{truncated ? t("orch.archived.noneTruncated") : t("orch.archived.none")}</Text>
        ) : null}
        {hasOlder ? (
          <View style={styles.toolbar}>
            <PixelButton
              skin={skin}
              mini
              variant="ghost"
              label={loadingOlder ? t("orch.archived.loadingOlder") : t("orch.archived.loadOlder")}
              onPress={onLoadOlder}
            />
          </View>
        ) : null}

        {shown.map((row, index) => {
          const role = row.labels["deck.role"];
          // 提成局部常量：按钮的回调闭包里再读 `row.sessionId` 会丢掉类型窄化。
          const sessionId = row.sessionId;
          const command = row.restoreCommand;
          const meta = [
            row.provider ? `${row.provider}${row.model ? `/${row.model}` : ""}` : t("orch.notSet"),
            row.status,
            row.archivedAt ? clockText(row.archivedAt) : "",
            row.providerUnavailable ? t("orch.archived.providerUnavailable") : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <View key={row.agentId} style={[styles.row, rowDivider(skin, index === 0)]}>
              <View style={styles.titleLine}>
                <Text style={styles.name} numberOfLines={1}>
                  {row.title ?? t("orch.untitled")}
                </Text>
                {role ? <Text style={styles.tag}>{t("orch.archived.roleTag", { role })}</Text> : null}
              </View>
              <Text style={styles.meta} numberOfLines={1}>
                {meta}
              </Text>

              {/*
                两个 id 各占一行、各自复制：`paseo import` 要的是会话 id，
                而宿主/别的页面认的是 agent id——混在一行里用户分不清该抄哪个。
                没有会话 id 的记录只列 agent id，原因写在下面一行。
              */}
              {sessionId ? (
                <View style={styles.idLine}>
                  <Text style={styles.idText} numberOfLines={1}>
                    {t("orch.archived.sessionId", { id: sessionId })}
                  </Text>
                  <PixelButton
                    skin={skin}
                    mini
                    variant="ghost"
                    label={t("orch.archived.copySession")}
                    onPress={() => onCopy(sessionId)}
                  />
                </View>
              ) : null}
              <View style={styles.idLine}>
                <Text style={styles.idText} numberOfLines={1}>
                  {t("orch.archived.agentId", { id: row.agentId })}
                </Text>
                <PixelButton
                  skin={skin}
                  mini
                  variant="ghost"
                  label={t("orch.archived.copyAgent")}
                  onPress={() => onCopy(row.agentId)}
                />
              </View>

              {command ? (
                <View style={styles.commandLine}>
                  <Text style={styles.command} numberOfLines={2}>
                    {command}
                  </Text>
                  <PixelButton
                    skin={skin}
                    mini
                    label={t("orch.archived.copyCommand")}
                    onPress={() => onCopy(command)}
                  />
                </View>
              ) : (
                // 「没有会话 id」是常态信息，不是错误：用说明色，不刷红。
                <Text style={styles.hint}>{row.restoreBlocked}</Text>
              )}
            </View>
          );
        })}
      </OrchSection>
    </ScrollView>
  );
}
