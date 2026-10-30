import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";
import type { AgentInfo } from "../registry.ts";
import { rolesOf, type OrchestrationSettings } from "./types.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import { MapBudgetPanel } from "./MapBudgetPanel.tsx";
import { OrchSection, OrchStepper, rowDivider } from "./parts.tsx";

/**
 * 角色 / 限制 / 地图预算。一屏只放三种东西：字段、列表行、数字。
 *
 * 上一版每行都套一个卡片框、每块各写一段说明：五个会话是五层边框，
 * 两层限制各带一句「1–6」又各带一句解释，地图预算没配也占掉四行字。
 * 扫一眼很满，但读不出重点，所以改成：
 * - 会话不再是卡片，改成行：标题一行、`客户端/模型 · 状态 · 短 id` 一行，
 *   行与行之间只有 1px 线；选中的那一行用左侧强调色竖线 + 强调色标题，
 *   不再额外挂一个「当前」方块；
 * - 说明一处只写一遍：范围并进标签行（`最大层数  1–6  − 3 +`）；
 * - 数字右对齐、等宽，几个参数能竖着对成一条线。
 *
 * 两个角色都能空着——空着时界面上写清后果（派单会被拒绝），
 * 不替用户随便挑一个窗口当派单对象。
 */

type RoleKey = "main" | "dispatcher";

export function RolesPanel({
  skin,
  t,
  workspaceId,
  settings,
  agents,
  onPatch,
  onLimits,
  onMapBudget,
  onOpen,
  busy,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  workspaceId: string;
  settings: OrchestrationSettings;
  agents: AgentInfo[];
  onPatch(patch: { mainAgentId?: string | null; dispatcherAgentId?: string | null }): void;
  onLimits(patch: { maxDepth?: number; maxChildrenPerDispatch?: number; reportOnFinish?: boolean }): void;
  /** 地图并发预算：`concurrency` 为 null 表示删掉这条。 */
  onMapBudget(map: string, concurrency: number | null): void;
  /** 宿主能切窗时才有：点一行 = 设为角色 + 切到那个会话。没有就只设角色。 */
  onOpen?(agent: AgentInfo): void;
  /** 有保存在飞：计数按钮先禁用，避免两下都按同一份旧值算。 */
  busy?: boolean;
}) {
  const [editing, setEditing] = useState<RoleKey>("dispatcher");
  const roles = rolesOf(settings, workspaceId);

  const styles = useMemo(
    () => ({
      hint: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      divider: { height: 1, backgroundColor: skin.colors.line, marginVertical: 4 },
      fieldRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 6,
        paddingLeft: 8,
        borderLeftWidth: 2,
        borderLeftColor: "transparent",
      },
      fieldRowActive: { borderLeftColor: skin.colors.acc },
      fieldBody: { flex: 1, gap: 2 },
      fieldTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      fieldLabel: { width: 72, color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      fieldLabelActive: { color: skin.colors.acc },
      fieldValue: {
        flex: 1,
        color: skin.colors.ink,
        fontSize: 12,
        fontWeight: "700" as const,
        fontFamily: skin.mono.fontFamily,
      },
      fieldValueEmpty: { color: skin.colors.ink2, fontWeight: "400" as const },
      row: { paddingVertical: 6, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: "transparent" },
      rowActive: { borderLeftColor: skin.colors.acc },
      rowTitleLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      name: { flex: 1, color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily, fontWeight: "700" as const },
      nameActive: { color: skin.colors.acc },
      /** 「当前」只是状态，不是按钮：用强调色小字，不占一个框。 */
      current: { color: skin.colors.acc, fontSize: 10, fontFamily: skin.mono.fontFamily },
      childTag: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      toggleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 4 },
      warn: skin.error,
    }),
    [skin],
  );

  const label = (id: string) => agents.find((agent) => agent.id === id) ?? null;
  const valueOf = (key: RoleKey) => {
    const id = key === "main" ? roles?.mainAgentId : roles?.dispatcherAgentId;
    const trimmed = id?.trim();
    if (!trimmed) return { id: null, title: null };
    return { id: trimmed, title: label(trimmed)?.title ?? null };
  };

  const field = (key: RoleKey, nameKey: PanelKey, hintKey: PanelKey) => {
    const value = valueOf(key);
    const active = editing === key;
    return (
      <View style={[styles.fieldRow, active ? styles.fieldRowActive : null]}>
        <Pressable
          style={styles.fieldBody}
          accessibilityRole="button"
          accessibilityState={{ selected: active }}
          accessibilityLabel={`${t(nameKey)}：${value.title ?? value.id ?? t("orch.none")}`}
          onPress={() => setEditing(key)}
        >
          <View style={styles.fieldTop}>
            <Text style={[styles.fieldLabel, active ? styles.fieldLabelActive : null]}>{t(nameKey)}</Text>
            <Text style={[styles.fieldValue, value.id ? null : styles.fieldValueEmpty]} numberOfLines={1}>
              {value.title ?? value.id ?? t("orch.none")}
            </Text>
          </View>
          <Text style={styles.hint} numberOfLines={1}>
            {t(hintKey)}
          </Text>
        </Pressable>
        {value.id ? (
          <PixelButton
            skin={skin}
            mini
            variant="ghost"
            label={t("orch.clear")}
            disabled={busy}
            onPress={() => onPatch(key === "main" ? { mainAgentId: null } : { dispatcherAgentId: null })}
          />
        ) : null}
      </View>
    );
  };

  const roleName = t(editing === "main" ? "orch.main" : "orch.dispatcher");
  const pick = (agent: AgentInfo) => {
    onPatch(editing === "main" ? { mainAgentId: agent.id } : { dispatcherAgentId: agent.id });
    onOpen?.(agent);
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16, gap: 10 }}>
      <View>
        {field("main", "orch.main", "orch.mainHint")}
        {field("dispatcher", "orch.dispatcher", "orch.dispatcherHint")}
      </View>

      <View style={styles.divider} />

      <OrchSection
        skin={skin}
        title={t("orch.pickSession", { role: roleName })}
        aside={`${agents.length} ${t("orch.sessions")}`}
      >
        {onOpen ? <Text style={styles.hint}>{t("orch.pickSessionHint", { role: roleName })}</Text> : null}
        {agents.length === 0 ? <Text style={styles.hint}>{t("orch.noAgents")}</Text> : null}
        {agents.map((agent, index) => {
          const active = agent.id === valueOf(editing).id;
          const parent = agent.parentAgentId ? label(agent.parentAgentId)?.title ?? agent.parentAgentId.slice(0, 8) : null;
          const meta = [
            parent ? t("orch.childOf", { name: parent }) : null,
            `${agent.provider}${agent.model ? `/${agent.model}` : ""}`,
            agent.status,
            agent.id.slice(0, 8),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <Pressable
              key={agent.id}
              accessibilityRole="button"
              accessibilityLabel={`${agent.title ?? agent.id}，${agent.provider}，${agent.status}`}
              accessibilityState={{ selected: active }}
              onPress={() => pick(agent)}
              disabled={busy}
              style={[styles.row, rowDivider(skin, index === 0), active ? styles.rowActive : null]}
            >
              <View style={styles.rowTitleLine}>
                <Text style={[styles.name, active ? styles.nameActive : null]} numberOfLines={1}>
                  {agent.title ?? t("orch.untitled")}
                </Text>
                {agent.parentAgentId ? <Text style={styles.childTag}>{t("orch.childSession")}</Text> : null}
                {active ? <Text style={styles.current}>{t("orch.selectedChip")}</Text> : null}
              </View>
              <Text style={styles.meta} numberOfLines={1}>
                {meta}
              </Text>
            </Pressable>
          );
        })}
      </OrchSection>

      <View style={styles.divider} />

      <OrchSection skin={skin} title={t("orch.limits")}>
        <OrchStepper
          skin={skin}
          label={t("orch.depth")}
          range="1–6"
          value={settings.maxDepth}
          min={1}
          max={6}
          disabled={busy}
          onChange={(maxDepth) => onLimits({ maxDepth })}
        />
        <OrchStepper
          skin={skin}
          label={t("orch.maxChildren")}
          range="1–24"
          value={settings.maxChildrenPerDispatch}
          min={1}
          max={24}
          disabled={busy}
          onChange={(maxChildrenPerDispatch) => onLimits({ maxChildrenPerDispatch })}
        />
        <View style={styles.toggleRow}>
          <PixelButton
            skin={skin}
            mini
            variant={settings.reportOnFinish ? "outline" : "ghost"}
            active={settings.reportOnFinish}
            label={`${settings.reportOnFinish ? "◉" : "○"} ${t("orch.reportOnFinish")}`}
            disabled={busy}
            onPress={() => onLimits({ reportOnFinish: !settings.reportOnFinish })}
          />
        </View>
        <Text style={styles.hint}>{t("orch.limitsHint")}</Text>
      </OrchSection>

      <View style={styles.divider} />

      <MapBudgetPanel skin={skin} t={t} settings={settings} busy={busy} onChange={onMapBudget} />
      {agents.length === 0 ? <Text style={styles.warn}>{t("orch.noAgentsWarn")}</Text> : null}
    </ScrollView>
  );
}
