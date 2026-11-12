import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import {
  FIXED_ROLES,
  MAX_MIN_CONCURRENT_STAFF,
  MAX_ROLE_PROMPT_CHARS,
  MAX_STAFF_SESSION_QUOTA,
  ROLE_AGENT_FIELD,
  agentIdOf,
  rolePromptFor,
  type FixedRole,
} from "../../../../shared/orchestration.ts";
import type { DeckLang } from "../../../../shared/requirement.ts";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";
import type { AgentInfo } from "../registry.ts";
import {
  promptPatchFor,
  rolesOf,
  type LimitsPatch,
  type OrchestrationSettings,
  type RolesPatch,
} from "./types.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import { MapBudgetPanel } from "./MapBudgetPanel.tsx";
import { OrchSection, OrchStepper, rowDivider } from "./parts.tsx";
import { StopSection, type StaffStopOutcome } from "./StopSection.tsx";

/**
 * 角色 / 限制 / 地图预算。一屏只放三种东西：字段、列表行、数字。
 *
 * 四个固定窗口（主 / 需求 / 派单 / 进度）各占一行：标题一行、`客户端/模型 · 状态 · 短 id`
 * 一行，1px 线分隔，不套卡片框。窗口由插件建，身份提示词写进会话的 systemPrompt；
 * 「选已有会话」是建不出窗口时的兜底入口，不是主路径。
 *
 * 两个关键容错：
 * - 槽位指向的会话已不在快照里（被归档）时不显示死 id，直接写「已归档，需重建」；
 * - 用户改过的提示词才写进 `prompts`，与默认值相同的文本视为没改。
 */

const ROLE_META: Readonly<Record<FixedRole, { label: PanelKey; hint: PanelKey }>> = Object.freeze({
  main: { label: "orch.main", hint: "orch.mainHint" },
  requirement: { label: "orch.requirement", hint: "orch.requirementHint" },
  dispatcher: { label: "orch.dispatcher", hint: "orch.dispatcherHint" },
  progress: { label: "orch.progress", hint: "orch.progressHint" },
});

type SlotValue = {
  id: string | null;
  agent: AgentInfo | null;
  archived: boolean;
};

type SlotActions = {
  select(): void;
  build(recreate: boolean): void;
  clear(): void;
  togglePrompt(): void;
  changePrompt(text: string): void;
  savePrompt(): void;
  resetPrompt(): void;
};

/** 面板全部样式；子组件各自取一份 memo 过的同一套，避免把样式对象层层传参。 */
function useRoleStyles(skin: PixelSkin) {
  return useMemo(
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
      rowActions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
      row: { paddingVertical: 6, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: "transparent" },
      rowActive: { borderLeftColor: skin.colors.acc },
      rowTitleLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      name: { flex: 1, color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily, fontWeight: "700" as const },
      nameActive: { color: skin.colors.acc },
      /** 「当前」只是状态，不是按钮：用强调色小字，不占一个框。 */
      current: { color: skin.colors.acc, fontSize: 10, fontFamily: skin.mono.fontFamily },
      childTag: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      warn: skin.error,
      toggleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 4 },
      promptWrap: { paddingLeft: 8 },
      promptToggle: {
        color: skin.colors.ink2,
        fontSize: 11,
        fontFamily: skin.mono.fontFamily,
        paddingVertical: 2,
      },
      promptToggleActive: { color: skin.colors.acc },
      promptBox: {
        marginLeft: 10,
        borderLeftWidth: 1,
        borderLeftColor: skin.colors.line,
        paddingLeft: 8,
        paddingBottom: 6,
        gap: 6,
      },
      promptInput: { minHeight: 96, textAlignVertical: "top" as const },
      promptActions: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
      },
      spacer: { flex: 1 },
    }),
    [skin],
  );
}

function SlotButtons({
  skin,
  t,
  value,
  building,
  busy,
  onBuild,
  onClear,
}: {
  skin: PixelSkin;
  t(key: PanelKey): string;
  value: SlotValue;
  /** 这一行正在建：只有这一行的按钮显示「创建中…」。 */
  building: boolean;
  /** 任何一行在建或设置保存在飞：按钮禁用，避免连点建出两个窗口。 */
  busy: boolean;
  onBuild(recreate: boolean): void;
  onClear(): void;
}) {
  const styles = useRoleStyles(skin);
  return (
    <View style={styles.rowActions}>
      {value.id ? (
        <>
          <PixelButton
            skin={skin}
            mini
            label={building ? t("orch.buildingWindow") : t("orch.rebuildWindow")}
            disabled={busy}
            onPress={() => onBuild(true)}
          />
          <PixelButton skin={skin} mini variant="ghost" label={t("orch.clear")} disabled={busy} onPress={onClear} />
        </>
      ) : (
        <PixelButton
          skin={skin}
          mini
          label={building ? t("orch.buildingWindow") : t("orch.buildWindow")}
          disabled={busy}
          onPress={() => onBuild(false)}
        />
      )}
    </View>
  );
}

function SlotHeader({
  skin,
  t,
  role,
  value,
  active,
  promptEdited,
  building,
  busy,
  onSelect,
  onBuild,
  onClear,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  role: FixedRole;
  value: SlotValue;
  active: boolean;
  promptEdited: boolean;
  building: boolean;
  busy: boolean;
  onSelect(): void;
  onBuild(recreate: boolean): void;
  onClear(): void;
}) {
  const styles = useRoleStyles(skin);
  const title = value.archived
    ? t("orch.archived")
    : value.agent?.title ?? (value.id ? value.id.slice(0, 8) : t("orch.none"));
  const agentMeta = value.agent
    ? [
        `${value.agent.provider}${value.agent.model ? `/${value.agent.model}` : ""}`,
        value.agent.status,
        value.agent.id.slice(0, 8),
      ].join(" · ")
    : null;
  const hint = value.archived ? t("orch.archivedHint") : agentMeta ?? t(ROLE_META[role].hint);
  return (
    <View style={[styles.fieldRow, active ? styles.fieldRowActive : null]}>
      <Pressable
        style={styles.fieldBody}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`${t(ROLE_META[role].label)}：${title}`}
        onPress={onSelect}
      >
        <View style={styles.fieldTop}>
          <Text style={[styles.fieldLabel, active ? styles.fieldLabelActive : null]}>{t(ROLE_META[role].label)}</Text>
          <Text style={[styles.fieldValue, value.agent ? null : styles.fieldValueEmpty]} numberOfLines={1}>
            {title}
          </Text>
          {promptEdited ? <Text style={styles.current}>{t("orch.promptCustom")}</Text> : null}
        </View>
        <Text style={value.archived ? styles.warn : styles.hint} numberOfLines={1}>
          {hint}
        </Text>
      </Pressable>
      <SlotButtons
        skin={skin}
        t={t}
        value={value}
        building={building}
        busy={busy}
        onBuild={onBuild}
        onClear={onClear}
      />
    </View>
  );
}

function PromptActions({
  skin,
  t,
  text,
  edited,
  busy,
  onSave,
  onReset,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  text: string;
  edited: boolean;
  busy: boolean;
  onSave(): void;
  onReset(): void;
}) {
  const styles = useRoleStyles(skin);
  return (
    <View style={styles.promptActions}>
      <Text style={styles.meta}>
        {edited ? t("orch.promptCustom") : t("orch.promptDefault")} ·{" "}
        {t("orch.promptLength", { n: text.trim().length, max: MAX_ROLE_PROMPT_CHARS })}
      </Text>
      <View style={styles.spacer} />
      <PixelButton
        skin={skin}
        mini
        variant="ghost"
        label={t("orch.promptReset")}
        disabled={busy || !edited}
        onPress={onReset}
      />
      <PixelButton skin={skin} mini label={t("orch.promptSave")} disabled={busy} onPress={onSave} />
    </View>
  );
}

function PromptEditor({
  skin,
  t,
  role,
  text,
  edited,
  busy,
  onChange,
  onSave,
  onReset,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  role: FixedRole;
  text: string;
  edited: boolean;
  busy: boolean;
  onChange(text: string): void;
  onSave(): void;
  onReset(): void;
}) {
  const styles = useRoleStyles(skin);
  return (
    <View style={styles.promptBox}>
      <Text style={styles.hint}>{t("orch.promptHint")}</Text>
      <TextInput
        accessibilityLabel={t(ROLE_META[role].label)}
        style={[skin.input, styles.promptInput]}
        value={text}
        onChangeText={onChange}
        editable={!busy}
        multiline
        maxLength={MAX_ROLE_PROMPT_CHARS}
        placeholderTextColor={skin.colors.ink2}
      />
      <PromptActions skin={skin} t={t} text={text} edited={edited} busy={busy} onSave={onSave} onReset={onReset} />
    </View>
  );
}

function RoleSlot({
  skin,
  t,
  role,
  value,
  first,
  active,
  promptEdited,
  promptOpen,
  promptText,
  building,
  busy,
  actions,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  role: FixedRole;
  value: SlotValue;
  first: boolean;
  active: boolean;
  promptEdited: boolean;
  promptOpen: boolean;
  promptText: string;
  building: boolean;
  busy: boolean;
  actions: SlotActions;
}) {
  const styles = useRoleStyles(skin);
  return (
    <View style={rowDivider(skin, first)}>
      <SlotHeader
        skin={skin}
        t={t}
        role={role}
        value={value}
        active={active}
        promptEdited={promptEdited}
        building={building}
        busy={busy}
        onSelect={actions.select}
        onBuild={actions.build}
        onClear={actions.clear}
      />
      <View style={styles.promptWrap}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: promptOpen }}
          accessibilityLabel={t("orch.prompt")}
          onPress={actions.togglePrompt}
        >
          <Text style={[styles.promptToggle, promptOpen ? styles.promptToggleActive : null]}>
            {promptOpen ? "▾" : "▸"} {t("orch.prompt")}
          </Text>
        </Pressable>
        {promptOpen ? (
          <PromptEditor
            skin={skin}
            t={t}
            role={role}
            text={promptText}
            edited={promptEdited}
            busy={busy}
            onChange={actions.changePrompt}
            onSave={actions.savePrompt}
            onReset={actions.resetPrompt}
          />
        ) : null}
      </View>
    </View>
  );
}

export function RolesPanel({
  skin,
  t,
  lang,
  workspaceId,
  settings,
  agents,
  knownAgentIds,
  onPatch,
  onBuildWindow,
  onLimits,
  onMapBudget,
  onStop,
  onOpen,
  busy,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  /** 默认身份提示词用哪种语言；跟随界面语言。 */
  lang: DeckLang;
  workspaceId: string;
  settings: OrchestrationSettings;
  agents: AgentInfo[];
  /**
   * 服务端刚读过的一份会话 id（`orchestration.state` 的 `agents`）。
   *
   * 客户端目录是另一条订阅链，冷启动或刚建完窗口时可能晚一步。只凭目录为空就判
   * 「已归档」会把还活着的槽位写成重建提示；两份来源都说没有，才算真的不在了。
   */
  knownAgentIds?: readonly string[];
  onPatch(patch: RolesPatch): void;
  /** 建/重建固定窗口；成功与否由调用方弹出 toast 并刷新状态。 */
  onBuildWindow(role: FixedRole, recreate: boolean): Promise<void>;
  onLimits(patch: LimitsPatch): void;
  /** 地图并发预算：`concurrency` 为 null 表示删掉这条。 */
  onMapBudget(map: string, concurrency: number | null): void;
  /** 阀门四：全停。缺省时不显示这一区（没有宿主句柄的场合）。 */
  onStop?(input: { archive: boolean }): Promise<StaffStopOutcome>;
  /** 宿主能切窗时才有：点一行 = 设为角色 + 切到那个会话。没有就只设角色。 */
  onOpen?(agent: AgentInfo): void;
  /** 有保存在飞：计数按钮先禁用，避免两下都按同一份旧值算。 */
  busy?: boolean;
}) {
  const [editing, setEditing] = useState<FixedRole>("dispatcher");
  const [openPrompt, setOpenPrompt] = useState<FixedRole | null>(null);
  const [promptDrafts, setPromptDrafts] = useState<Partial<Record<FixedRole, string>>>({});
  const [building, setBuilding] = useState<FixedRole | null>(null);
  const roles = rolesOf(settings, workspaceId);
  const styles = useRoleStyles(skin);
  const settingsBusy = Boolean(busy);
  const buildBusy = building !== null || settingsBusy;

  const label = (id: string) => agents.find((agent) => agent.id === id) ?? null;
  const valueOf = (role: FixedRole): SlotValue => {
    const id = agentIdOf(roles, role);
    const agent = id ? label(id) : null;
    const known = id ? knownAgentIds?.includes(id) : false;
    return { id, agent, archived: Boolean(id && !agent && !known) };
  };

  const build = async (role: FixedRole, recreate: boolean) => {
    if (buildBusy) return;
    setBuilding(role);
    try {
      await onBuildWindow(role, recreate);
    } catch (error) {
      // 失败的 toast 由调用方弹（契约见 props）；这里兜住未处理的 rejection，别让界面静默卡在忙碌态。
      console.error("Deck: build role window failed", error);
    } finally {
      setBuilding(null);
    }
  };

  const promptText = (role: FixedRole) => promptDrafts[role] ?? rolePromptFor(roles, role, lang);
  const setPromptText = (role: FixedRole, text: string) =>
    setPromptDrafts((current) => ({ ...current, [role]: text }));
  const togglePrompt = (role: FixedRole) => {
    setEditing(role);
    setOpenPrompt(openPrompt === role ? null : role);
  };

  /**
   * 只写改过的提示词；判断规则在 `promptPatchFor`（只跟**当前语言**的默认值比，
   * 与默认值相同就删掉自定义段）。草稿不在这里清：保存失败时输入还在。
   */
  const savePrompt = (role: FixedRole) => {
    const patch = promptPatchFor(role, promptText(role), roles, lang);
    if (patch) onPatch(patch);
    setOpenPrompt(null);
  };

  const resetPrompt = (role: FixedRole) => {
    // 清掉草稿让编辑器回落到「当前语言的默认值」：直接预填旧语言文本，
    // 切语言后再保存就会把旧默认值当成自定义存下来。
    setPromptDrafts((current) => {
      const next = { ...current };
      delete next[role];
      return next;
    });
    if (roles?.prompts?.[role]) onPatch({ prompts: { [role]: null } });
  };

  const agentPatch = (role: FixedRole, agentId: string | null): RolesPatch => ({
    [ROLE_AGENT_FIELD[role]]: agentId,
  });

  const actionsOf = (role: FixedRole): SlotActions => ({
    select: () => setEditing(role),
    build: (recreate) => void build(role, recreate),
    clear: () => onPatch(agentPatch(role, null)),
    togglePrompt: () => togglePrompt(role),
    changePrompt: (text) => setPromptText(role, text),
    savePrompt: () => savePrompt(role),
    resetPrompt: () => resetPrompt(role),
  });

  const roleName = t(ROLE_META[editing].label);
  const pick = (agent: AgentInfo) => {
    onPatch(agentPatch(editing, agent.id));
    onOpen?.(agent);
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16, gap: 10 }}>
      <View>
        {FIXED_ROLES.map((role, index) => (
          <RoleSlot
            key={role}
            skin={skin}
            t={t}
            role={role}
            value={valueOf(role)}
            first={index === 0}
            active={editing === role}
            promptEdited={Boolean(roles?.prompts?.[role]?.trim())}
            promptOpen={openPrompt === role}
            promptText={promptText(role)}
            building={building === role}
            busy={buildBusy}
            actions={actionsOf(role)}
          />
        ))}
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
              disabled={settingsBusy}
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
        {/* 层数是这页唯一一个「数字看不出后果」的项，所以先把链条摆出来，再给按钮。 */}
        <Text style={styles.hint}>{t("orch.depthChain")}</Text>
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
        <OrchStepper
          skin={skin}
          label={t("orch.minConcurrentStaff")}
          range={`1–${MAX_MIN_CONCURRENT_STAFF}`}
          value={settings.minConcurrentStaff}
          min={1}
          max={MAX_MIN_CONCURRENT_STAFF}
          disabled={busy}
          onChange={(minConcurrentStaff) => onLimits({ minConcurrentStaff })}
        />
        <Text style={styles.hint}>{t("orch.minConcurrentStaffHint")}</Text>
        <View style={styles.toggleRow}>
          <PixelButton
            skin={skin}
            mini
            variant={settings.confirmRequirementSplit ? "outline" : "ghost"}
            active={settings.confirmRequirementSplit}
            label={`${settings.confirmRequirementSplit ? "◉" : "○"} ${t("orch.confirmRequirementSplit")}`}
            disabled={busy}
            onPress={() => onLimits({ confirmRequirementSplit: !settings.confirmRequirementSplit })}
          />
        </View>
        <Text style={styles.hint}>{t("orch.confirmRequirementSplitHint")}</Text>
        <OrchStepper
          skin={skin}
          label={t("orch.staffSessionQuota")}
          range={`0–${MAX_STAFF_SESSION_QUOTA}`}
          value={settings.staffSessionQuota}
          min={0}
          max={MAX_STAFF_SESSION_QUOTA}
          disabled={busy}
          onChange={(staffSessionQuota) => onLimits({ staffSessionQuota })}
        />
        <Text style={styles.hint}>{t("orch.staffSessionQuotaHint")}</Text>
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

      {onStop ? (
        <>
          <View style={styles.divider} />
          <StopSection skin={skin} t={t} busy={settingsBusy} onStop={onStop} />
        </>
      ) : null}

      {agents.length === 0 ? <Text style={styles.warn}>{t("orch.noAgentsWarn")}</Text> : null}
    </ScrollView>
  );
}
