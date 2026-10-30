import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton, PixelCard, PixelHead } from "../../pixel.tsx";
import type { AgentInfo } from "../registry.ts";
import { rolesOf, type OrchestrationSettings } from "./types.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import { MapBudgetPanel } from "./MapBudgetPanel.tsx";

/**
 * 角色：哪个窗口负责「讨论」，哪个窗口负责「派单」。
 *
 * 两个角色都能空着——空着时界面上写清后果（派单会被拒绝），
 * 不替用户随便挑一个窗口当派单对象。
 *
 * 这一页原来是「两个页签 + 一行当前值 + 一串会话」，三处都在说同一件事，
 * 扫一遍看不出「我现在在改哪个角色」。现在改成：上面两行字段（左边名字、右边当前值，
 * 正在编辑的那行有一道强调色竖线），下面一块「选一个会话」的选择器只服务那一行。
 */

type RoleKey = "main" | "dispatcher";

/** 数值用「标签左、控件右」两栏：数字两边夹着 − / +，比「最大层数：3 [−][+]」好扫。 */
function Counter({
  skin,
  label,
  hint,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  skin: PixelSkin;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  /** 上一次保存还没落盘时禁用：连点两下都按同一份旧值算，净增只有 1。 */
  disabled?: boolean;
  onChange(next: number): void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 3 }}>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily }}>{label}</Text>
        <Text style={{ color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily }}>
          {hint} {min}–{max}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <PixelButton
          skin={skin}
          mini
          label="−"
          onPress={() => onChange(Math.max(min, value - 1))}
          disabled={disabled || value <= min}
        />
        <Text
          style={[
            skin.num,
            {
              color: skin.colors.ink,
              fontSize: 13,
              minWidth: 22,
              textAlign: "center",
              ...(skin.mono.fontFamily ? { fontFamily: skin.mono.fontFamily } : {}),
            },
          ]}
        >
          {value}
        </Text>
        <PixelButton
          skin={skin}
          mini
          label="+"
          onPress={() => onChange(Math.min(max, value + 1))}
          disabled={disabled || value >= max}
        />
      </View>
    </View>
  );
}

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
      screen: { flex: 1, gap: 10 },
      field: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 7,
        paddingHorizontal: 10,
        borderLeftWidth: 2,
        borderLeftColor: "transparent",
      },
      fieldActive: { borderLeftColor: skin.colors.acc, backgroundColor: skin.colors.paper },
      fieldBody: { flex: 1, gap: 2 },
      fieldLabel: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      fieldLabelActive: { color: skin.colors.acc },
      fieldValue: {
        color: skin.colors.ink,
        fontSize: 12,
        fontWeight: "700" as const,
        fontFamily: skin.mono.fontFamily,
      },
      fieldValueEmpty: { color: skin.colors.ink2, fontWeight: "400" as const },
      fieldHint: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16 },
      divider: { height: 1, backgroundColor: skin.colors.line },
      pickerHead: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingTop: 2,
      },
      pickerCount: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 7,
        paddingHorizontal: 8,
        marginBottom: 4,
      },
      bar: { width: 2, alignSelf: "stretch" as const, backgroundColor: "transparent" },
      barOn: { backgroundColor: skin.colors.acc },
      rowBody: { flex: 1, gap: 2 },
      name: { color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily, fontWeight: "700" as const },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      /** 子会话标：中性色描边，不抢强调色——它只是「这条是别人派的」。 */
      subChip: {
        color: skin.colors.ink2,
        fontSize: 10,
        fontFamily: skin.mono.fontFamily,
        borderWidth: 1,
        borderColor: skin.colors.line,
        paddingHorizontal: 4,
        paddingVertical: 1,
      },
      chip: {
        color: skin.colors.acc,
        fontSize: 10,
        fontFamily: skin.mono.fontFamily,
        borderWidth: 1,
        borderColor: skin.colors.acc,
        paddingHorizontal: 4,
        paddingVertical: 1,
      },
      hint: skin.hint,
      toggleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 3 },
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
      <View style={[styles.field, active ? styles.fieldActive : null]}>
        <Pressable
          style={styles.fieldBody}
          accessibilityRole="button"
          accessibilityState={{ selected: active }}
          accessibilityLabel={`${t(nameKey)}：${value.title ?? value.id ?? t("orch.none")}`}
          onPress={() => setEditing(key)}
        >
          <Text style={[styles.fieldLabel, active ? styles.fieldLabelActive : null]}>{t(nameKey)}</Text>
          <Text style={[styles.fieldValue, value.id ? null : styles.fieldValueEmpty]} numberOfLines={1}>
            {value.title ?? value.id ?? t("orch.none")}
          </Text>
          <Text style={styles.fieldHint} numberOfLines={2}>
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
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 16 }}>
      {field("main", "orch.main", "orch.mainHint")}
      {field("dispatcher", "orch.dispatcher", "orch.dispatcherHint")}

      <View style={styles.divider} />

      <View style={styles.pickerHead}>
        <PixelHead skin={skin}>{t("orch.pickSession", { role: roleName })}</PixelHead>
        <View style={{ flex: 1 }} />
        <Text style={styles.pickerCount}>
          {agents.length} {t("orch.sessions")}
        </Text>
      </View>
      {onOpen ? (
        <Text style={styles.fieldHint}>{t("orch.pickSessionHint", { role: roleName })}</Text>
      ) : null}

      {agents.length === 0 ? <Text style={styles.hint}>{t("orch.noAgents")}</Text> : null}
      {agents.map((agent) => {
        const active = agent.id === valueOf(editing).id;
        return (
          <Pressable
            key={agent.id}
            accessibilityRole="button"
            accessibilityLabel={`${agent.title ?? agent.id}，${agent.provider}`}
            accessibilityState={{ selected: active }}
            onPress={() => pick(agent)}
            disabled={busy}
          >
            <PixelCard skin={skin} style={styles.row}>
              <View style={[styles.bar, active ? styles.barOn : null]} />
              <View style={styles.rowBody}>
                <View style={{ flexDirection: "row" as const, alignItems: "center" as const, gap: 6 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {agent.title ?? t("orch.untitled")}
                  </Text>
                  {agent.parentAgentId ? <Text style={styles.subChip}>{t("orch.childSession")}</Text> : null}
                </View>
                <Text style={styles.meta} numberOfLines={1}>
                  {agent.provider}
                  {agent.model ? `/${agent.model}` : ""} · {agent.status} · {agent.id.slice(0, 8)}
                </Text>
                {agent.parentAgentId ? (
                  <Text style={styles.meta} numberOfLines={1}>
                    {t("orch.childOf", {
                      name: label(agent.parentAgentId)?.title ?? agent.parentAgentId.slice(0, 8),
                    })}
                  </Text>
                ) : null}
              </View>
              {active ? <Text style={styles.chip}>{t("orch.selectedChip")}</Text> : null}
            </PixelCard>
          </Pressable>
        );
      })}

      <View style={styles.divider} />

      <PixelHead skin={skin}>{t("orch.limits")}</PixelHead>
      <Counter
        skin={skin}
        label={t("orch.depth")}
        hint={t("orch.depthHint")}
        value={settings.maxDepth}
        min={1}
        max={6}
        disabled={busy}
        onChange={(maxDepth) => onLimits({ maxDepth })}
      />
      <Counter
        skin={skin}
        label={t("orch.maxChildren")}
        hint={t("orch.maxChildrenHint")}
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

      <View style={styles.divider} />

      <MapBudgetPanel skin={skin} t={t} settings={settings} busy={busy} onChange={onMapBudget} />
      {agents.length === 0 ? <Text style={styles.warn}>{t("orch.noAgentsWarn")}</Text> : null}
    </ScrollView>
  );
}
