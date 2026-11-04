import { useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import {
  MAX_STAFF_CARDS,
  MAX_STAFF_CONCURRENCY,
  MAX_STAFF_DUTY_CHARS,
  MAX_STAFF_NAME_CHARS,
  MAX_STAFF_PATHS,
  newStaffId,
  normalizeStaffPath,
  type StaffCard,
  type StaffKind,
} from "../../../../shared/staff.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";
import type { ClientProfile, StaffMutation } from "./types.ts";
import { OrchSection, OrchStepper, rowDivider } from "./parts.tsx";

/**
 * 岗位名册：谁在这个工作区、是经理还是员工、管哪片、用哪份档案。
 *
 * 卡上的 id 建好后只读：会话标签（`deck.staff`）与岗位履历都拿它当键，
 * 改 id 等于把履历拦腰截断。所以界面上根本不提供编辑入口，只在新建时生成一次。
 *
 * 与这一页其它设置一样，没有单独的「保存名册」按钮：每次增/改/删都整份写回，
 * 服务端再归一一次。表单里只做能提前说清的检查（名字非空、id 不重复），
 * 归一化的边界仍以服务端为准。
 */

type Draft = {
  id: string;
  name: string;
  kind: StaffKind;
  duty: string;
  /** 空串 = 不选档案，按难度路由。 */
  profileId: string;
  /** 一行一个路径，保存时再拆。 */
  pathsText: string;
  maxConcurrent: number;
};

function draftFromCard(card: StaffCard): Draft {
  return {
    id: card.id,
    name: card.name,
    kind: card.kind === "manager" ? "manager" : "worker",
    duty: card.duty ?? "",
    profileId: card.profileId ?? "",
    pathsText: (card.paths ?? []).join("\n"),
    maxConcurrent: card.maxConcurrent ?? 1,
  };
}

function draftForNew(taken: readonly string[]): Draft {
  return {
    id: newStaffId(taken),
    name: "",
    kind: "worker",
    duty: "",
    profileId: "",
    pathsText: "",
    maxConcurrent: 1,
  };
}

/** 一行一个路径：去 `./` 与前导 `/`、折叠结尾 `/`、去重、封顶。 */
function pathsOf(value: string): string[] {
  const out: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const path = normalizeStaffPath(line);
    if (path && !out.includes(path)) out.push(path);
    if (out.length >= MAX_STAFF_PATHS) break;
  }
  return out;
}

function cardFrom(draft: Draft): StaffCard {
  const duty = draft.duty.trim();
  const profileId = draft.profileId.trim();
  const paths = pathsOf(draft.pathsText);
  return {
    id: draft.id,
    name: draft.name.trim().slice(0, MAX_STAFF_NAME_CHARS),
    kind: draft.kind,
    ...(duty ? { duty: duty.slice(0, MAX_STAFF_DUTY_CHARS) } : {}),
    ...(profileId ? { profileId } : {}),
    ...(paths.length ? { paths } : {}),
    maxConcurrent: Math.min(MAX_STAFF_CONCURRENCY, Math.max(1, Math.round(draft.maxConcurrent))),
  };
}

type StaffStyles = ReturnType<typeof useStaffStyles>;

function useStaffStyles(skin: PixelSkin) {
  return useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      hint: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      row: { paddingVertical: 7, gap: 3 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      name: {
        flexShrink: 1,
        color: skin.colors.ink,
        fontSize: 12,
        fontWeight: "700" as const,
        fontFamily: skin.mono.fontFamily,
      },
      id: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      managerTag: { color: skin.colors.acc, fontSize: 10, fontFamily: skin.mono.fontFamily },
      workerTag: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      duty: { color: skin.colors.ink, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      meta: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
      spacer: { flex: 1 },
      addRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingTop: 6,
        borderTopWidth: 1,
        borderTopColor: skin.colors.line,
      },
      addRowFirst: { borderTopWidth: 0, paddingTop: 0 },
      editor: {
        marginLeft: 10,
        marginTop: 4,
        marginBottom: 4,
        borderLeftWidth: 1,
        borderLeftColor: skin.colors.line,
        paddingLeft: 8,
        gap: 6,
      },
      field: { gap: 2 },
      fieldLabel: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
      input: skin.input,
      multiline: { minHeight: 64, textAlignVertical: "top" as const },
      pathsInput: { minHeight: 54, textAlignVertical: "top" as const },
      saveRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      warn: skin.error,
    }),
    [skin],
  );
}

function Field({
  styles,
  label,
  children,
}: {
  styles: StaffStyles;
  label: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function StaffEditor({
  skin,
  t,
  styles,
  draft,
  profiles,
  creating,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  styles: StaffStyles;
  draft: Draft;
  profiles: ClientProfile[];
  creating: boolean;
  busy: boolean;
  onChange(patch: Partial<Draft>): void;
  onSave(): void;
  onCancel(): void;
}) {
  const profileMissing =
    Boolean(draft.profileId) && !profiles.some((profile) => profile.id === draft.profileId);
  return (
    <View style={styles.editor}>
      <Text style={styles.meta}>
        {draft.id} · {t("orch.staffIdHint")}
      </Text>

      <Field styles={styles} label={t("orch.staffName")}>
        <TextInput
          accessibilityLabel={t("orch.staffName")}
          style={styles.input}
          value={draft.name}
          onChangeText={(name) => onChange({ name })}
          placeholder={t("orch.staffNamePlaceholder")}
          placeholderTextColor={skin.colors.ink2}
          editable={!busy}
          maxLength={MAX_STAFF_NAME_CHARS}
        />
      </Field>

      <Field styles={styles} label={t("orch.staffKind")}>
        <View style={styles.chips}>
          <PixelButton
            skin={skin}
            mini
            variant="tab"
            active={draft.kind === "worker"}
            label={t("orch.staffWorker")}
            disabled={busy}
            onPress={() => onChange({ kind: "worker" })}
          />
          <PixelButton
            skin={skin}
            mini
            variant="tab"
            active={draft.kind === "manager"}
            label={t("orch.staffManager")}
            disabled={busy}
            onPress={() => onChange({ kind: "manager" })}
          />
        </View>
        <Text style={styles.hint}>{t("orch.staffKindHint")}</Text>
      </Field>

      <Field styles={styles} label={t("orch.staffDuty")}>
        <TextInput
          accessibilityLabel={t("orch.staffDuty")}
          style={[skin.input, styles.multiline]}
          value={draft.duty}
          onChangeText={(duty) => onChange({ duty })}
          placeholder={t("orch.staffDutyHint")}
          placeholderTextColor={skin.colors.ink2}
          editable={!busy}
          multiline
          maxLength={MAX_STAFF_DUTY_CHARS}
        />
      </Field>

      <Field styles={styles} label={t("orch.staffProfile")}>
        <View style={styles.chips}>
          <PixelButton
            skin={skin}
            mini
            variant="tab"
            active={!draft.profileId}
            label={t("orch.staffProfileNone")}
            disabled={busy}
            onPress={() => onChange({ profileId: "" })}
          />
          {profiles.map((profile) => (
            <PixelButton
              key={profile.id}
              skin={skin}
              mini
              variant="tab"
              active={draft.profileId === profile.id}
              label={profile.name || profile.id}
              disabled={busy}
              onPress={() => onChange({ profileId: profile.id })}
            />
          ))}
        </View>
        {profiles.length === 0 ? <Text style={styles.hint}>{t("orch.staffProfileEmpty")}</Text> : null}
        {profileMissing ? (
          <Text style={styles.warn}>{t("orch.staffProfileMissing", { id: draft.profileId })}</Text>
        ) : null}
      </Field>

      <Field styles={styles} label={t("orch.staffPaths")}>
        <TextInput
          accessibilityLabel={t("orch.staffPaths")}
          style={[skin.input, styles.pathsInput]}
          value={draft.pathsText}
          onChangeText={(pathsText) => onChange({ pathsText })}
          placeholder={t("orch.staffPathsPlaceholder")}
          placeholderTextColor={skin.colors.ink2}
          editable={!busy}
          multiline
        />
        <Text style={styles.hint}>{t("orch.staffPathsHint")}</Text>
      </Field>

      <View style={styles.field}>
        <OrchStepper
          skin={skin}
          label={t("orch.staffConcurrency")}
          range={`1–${MAX_STAFF_CONCURRENCY}`}
          value={draft.maxConcurrent}
          min={1}
          max={MAX_STAFF_CONCURRENCY}
          disabled={busy}
          onChange={(maxConcurrent) => onChange({ maxConcurrent })}
        />
        <Text style={styles.hint}>{t("orch.staffConcurrencyHint")}</Text>
      </View>

      <View style={styles.saveRow}>
        <PixelButton
          skin={skin}
          mini
          label={creating ? t("orch.staffCreate") : t("orch.staffSave")}
          disabled={busy || !draft.name.trim()}
          onPress={onSave}
        />
        <PixelButton
          skin={skin}
          mini
          variant="ghost"
          label={t("orch.staffCancel")}
          disabled={busy}
          onPress={onCancel}
        />
      </View>
    </View>
  );
}

export function StaffPanel({
  skin,
  t,
  cards,
  profiles,
  busy,
  onSave,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  cards: StaffCard[];
  profiles: ClientProfile[];
  busy?: boolean;
  /**
   * 把一次增/改/删交给调用方，由它作用在落盘前刚读到的最新名册上。
   * 返回 true 才表示已经保存并刷新成功；失败时保留草稿，别让用户重填。
   */
  onSave(mutate: StaffMutation): Promise<boolean>;
}) {
  const styles = useStaffStyles(skin);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const settingsBusy = Boolean(busy);
  const full = cards.length >= MAX_STAFF_CARDS;

  const beginCreate = () => {
    setEditingExisting(false);
    setDraft(draftForNew(cards.map((card) => card.id)));
  };

  const beginEdit = (card: StaffCard) => {
    setEditingExisting(true);
    setDraft(draftFromCard(card));
  };

  const changeDraft = (patch: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const save = async () => {
    if (!draft || settingsBusy || !draft.name.trim()) return;
    const card = cardFrom(draft);
    const mutate: StaffMutation = editingExisting
      ? (current) => current.map((item) => (item.id === card.id ? card : item))
      : (current) => [...current, card];
    // 保存失败时不收草稿：校验器说不行、写盘失败，用户已填的内容都还在。
    try {
      if (await onSave(mutate)) setDraft(null);
    } catch {
      // 失败原因已由 `applySettings` 弹过 toast；这里只保证草稿不被收掉。
    }
  };

  const remove = async (id: string) => {
    if (settingsBusy) return;
    // 正在编辑的就是它：删成功之后连草稿一起收掉；失败时卡还在，草稿也该在。
    const editingIt = Boolean(draft && editingExisting && draft.id === id);
    try {
      if (await onSave((current) => current.filter((card) => card.id !== id))) {
        if (editingIt) setDraft(null);
      }
    } catch {
      // 失败原因已由 `applySettings` 弹过 toast。
    }
  };

  const profileOf = (card: StaffCard): string => {
    if (!card.profileId) return t("orch.staffProfileNone");
    return profiles.find((profile) => profile.id === card.profileId)?.name ?? card.profileId;
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 16 }}>
      <OrchSection
        skin={skin}
        title={t("orch.staff")}
        aside={t("orch.staffCount", { n: cards.length })}
      >
        <Text style={styles.hint}>{t("orch.staffHint")}</Text>
        {cards.length === 0 ? <Text style={styles.hint}>{t("orch.staffEmpty")}</Text> : null}

        {cards.map((card, index) => {
          const active = Boolean(draft && editingExisting && draft.id === card.id);
          const duty = card.duty?.trim();
          return (
            <View key={card.id} style={[styles.row, rowDivider(skin, index === 0)]}>
              <View style={styles.head}>
                <Text style={styles.name} numberOfLines={1}>
                  {card.name}
                </Text>
                <Text style={card.kind === "manager" ? styles.managerTag : styles.workerTag}>
                  {card.kind === "manager" ? t("orch.staffManager") : t("orch.staffWorker")}
                </Text>
                <Text style={styles.id}>{card.id}</Text>
                <View style={styles.spacer} />
                <View style={styles.actions}>
                  <PixelButton
                    skin={skin}
                    mini
                    variant="ghost"
                    label={t("orch.staffEdit")}
                    disabled={settingsBusy}
                    onPress={() => (active ? setDraft(null) : beginEdit(card))}
                  />
                  <PixelButton
                    skin={skin}
                    mini
                    variant="ghost"
                    label={t("orch.staffRemove")}
                    disabled={settingsBusy}
                    onPress={() => void remove(card.id)}
                  />
                </View>
              </View>
              <Text style={styles.duty} numberOfLines={2}>
                {duty || t("orch.staffNoDuty")}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {t("orch.staffProfileValue", { profile: profileOf(card) })} ·{" "}
                {t("orch.staffTerritoryValue", {
                  paths: card.paths?.length ? card.paths.join(" · ") : t("orch.staffWholeTerritory"),
                })}{" "}
                · {t("orch.staffConcurrencyTag", { n: card.maxConcurrent ?? 1 })}
              </Text>
              {active && draft ? (
                <StaffEditor
                  skin={skin}
                  t={t}
                  styles={styles}
                  draft={draft}
                  profiles={profiles}
                  creating={false}
                  busy={settingsBusy}
                  onChange={changeDraft}
                  onSave={() => void save()}
                  onCancel={() => setDraft(null)}
                />
              ) : null}
            </View>
          );
        })}

        <View style={[styles.addRow, cards.length === 0 ? styles.addRowFirst : null]}>
          {full ? (
            <Text style={styles.hint}>{t("orch.staffFull", { max: MAX_STAFF_CARDS })}</Text>
          ) : draft && !editingExisting ? null : (
            <PixelButton
              skin={skin}
              mini
              label={t("orch.staffAdd")}
              disabled={settingsBusy}
              onPress={beginCreate}
            />
          )}
        </View>

        {draft && !editingExisting ? (
          <StaffEditor
            skin={skin}
            t={t}
            styles={styles}
            draft={draft}
            profiles={profiles}
            creating
            busy={settingsBusy}
            onChange={changeDraft}
            onSave={() => void save()}
            onCancel={() => setDraft(null)}
          />
        ) : null}
      </OrchSection>
    </ScrollView>
  );
}
