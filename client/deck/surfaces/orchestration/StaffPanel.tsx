import { useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import {
  MAX_STAFF_CARDS,
  MAX_STAFF_CONCURRENCY,
  MAX_STAFF_DUTY_CHARS,
  MAX_STAFF_NAME_CHARS,
  type StaffCard,
} from "../../../../shared/staff.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";
import { adoptScanCandidates } from "./scan-model.ts";
import {
  canSaveStaffDraft,
  isTerritoryMissing,
  staffCardFromDraft,
  staffDraftFromCard,
  staffDraftForNew,
  territoryBannerText,
  territoryText,
  type StaffDraft,
} from "./staff-draft.ts";
import { StaffScan } from "./StaffScan.tsx";
import type { DeckLang } from "../../../../shared/requirement.ts";
import type { StaffScanCandidate } from "../../../../shared/staff-scan.ts";
import type { ClientProfile, StaffMutation } from "./types.ts";
import { OrchSection, OrchStepper, rowDivider } from "./parts.tsx";

/**
 * 岗位名册：谁在这个工作区、是经理还是员工、管哪片、用哪份档案。
 *
 * 卡上的 id 建好后只读：会话标签（`deck.staff`）与岗位履历都拿它当键，
 * 改 id 等于把履历拦腰截断。所以界面上根本不提供编辑入口，只在新建时生成一次。
 *
 * 与这一页其它设置一样，没有单独的「保存名册」按钮：每次增/改/删都整份写回，
 * 服务端再归一一次。表单里只做能提前说清的检查（名字非空、领地非空），
 * 目录是否真实存在只能由服务端判，归一化的边界也以服务端为准。
 *
 * 领地的两种写法只在保存时确定：开关打开写 `["."]`（整片），关掉必须至少一条路径。
 * 空 `paths` 是「没配」，不会再被显示成整片。
 */


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
      /** 领地独占一行：整页只有它是绿的，扫一眼就知道谁管哪片。 */
      territory: {
        color: skin.colors.ok,
        fontSize: 11,
        lineHeight: 16,
        fontFamily: skin.mono.fontFamily,
      },
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
      /** 缺领地横幅：沿用编排页提醒的 1px 竖线，不用 PixelBanner 的整块底色。 */
      territoryNotice: {
        borderLeftWidth: 1,
        borderLeftColor: skin.colors.warn,
        paddingLeft: 8,
        paddingVertical: 2,
      },
      territoryNoticeText: {
        color: skin.colors.ink,
        fontSize: 11,
        lineHeight: 16,
        fontFamily: skin.mono.fontFamily,
      },
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
  draft: StaffDraft;
  profiles: ClientProfile[];
  creating: boolean;
  busy: boolean;
  onChange(patch: Partial<StaffDraft>): void;
  onSave(): void;
  onCancel(): void;
}) {
  const profileMissing =
    Boolean(draft.profileId) && !profiles.some((profile) => profile.id === draft.profileId);
  // 领地缺了就得一直说，不能等名字补完才提示。
  const territoryMissing = isTerritoryMissing(draft);
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
        <View style={styles.chips}>
          <PixelButton
            skin={skin}
            mini
            variant="tab"
            active={draft.wholeTerritory}
            label={t("orch.staffWholeTerritoryToggle")}
            accessibilityLabel={t("orch.staffWholeTerritoryToggle")}
            disabled={busy}
            onPress={() => onChange({ wholeTerritory: !draft.wholeTerritory })}
          />
        </View>
        <TextInput
          accessibilityLabel={t("orch.staffPaths")}
          style={[skin.input, styles.pathsInput]}
          // 打开整片时输入框显示空白与「整片」，不把旧路径和当前状态摆在一起；
          // 关掉开关再恢复草稿里留着的内容，用户不用重填。
          value={draft.wholeTerritory ? "" : draft.pathsText}
          onChangeText={(pathsText) => onChange({ pathsText })}
          placeholder={
            draft.wholeTerritory ? t("orch.staffWholeTerritory") : t("orch.staffPathsPlaceholder")
          }
          placeholderTextColor={skin.colors.ink2}
          editable={!busy && !draft.wholeTerritory}
          multiline
        />
        <Text style={!draft.wholeTerritory && territoryMissing ? styles.warn : styles.hint}>
          {draft.wholeTerritory
            ? t("orch.staffWholeTerritoryHint")
            : territoryMissing
              ? t("orch.staffPathsRequired")
              : t("orch.staffPathsHint")}
        </Text>
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
          disabled={busy || !canSaveStaffDraft(draft)}
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
  workspaceId,
  workspaceDir,
  lang,
  cards,
  profiles,
  busy,
  onSave,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  /** 扫岗要在这个工作区里起会话、读它的名册。 */
  workspaceId: string;
  workspaceDir: string;
  /** 扫岗简报用哪种语言写。 */
  lang: DeckLang;
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
  const [draft, setDraft] = useState<StaffDraft | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  /** 上一次采纳的结果（加了几张、跳过几条）：扫岗面板里就地写一行，不再弹 toast。 */
  const [adoptNote, setAdoptNote] = useState<string | null>(null);
  const settingsBusy = Boolean(busy);
  const full = cards.length >= MAX_STAFF_CARDS;
  /** 名册缺领地就拦派单：横幅列清是哪几张，没有缺项时整块不出现。 */
  const territoryBanner = territoryBannerText(cards, t);

  const beginCreate = () => {
    setEditingExisting(false);
    setDraft(staffDraftForNew(cards.map((card) => card.id)));
  };

  const beginEdit = (card: StaffCard) => {
    setEditingExisting(true);
    setDraft(staffDraftFromCard(card));
  };

  const changeDraft = (patch: Partial<StaffDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const save = async () => {
    if (!draft || settingsBusy || !canSaveStaffDraft(draft)) return;
    const card = staffCardFromDraft(draft);
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

  /**
   * 采纳扫岗候选。
   *
   * 合并发生在 `onSave` 的回调里，因为那里拿到的才是落盘前最后读到的名册——
   * 用界面上这份 `cards` 去算，会把这一小段时间里别人（另一个窗口）改的卡覆盖掉。
   * 回调按保存流程只跑一次，所以在这里记一句结果给界面是安全的。
   */
  const adopt = async (picked: readonly StaffScanCandidate[]): Promise<boolean> => {
    if (settingsBusy || !picked.length) return false;
    let said: string | null = null;
    try {
      const saved = await onSave((current) => {
        const result = adoptScanCandidates(current, picked);
        const parts = [
          result.added ? t("orch.scanAdded", { n: result.added }) : "",
          result.skipped ? t("orch.scanSkipped", { n: result.skipped }) : "",
          result.overLimit ? t("orch.scanOverLimit", { n: result.overLimit, max: MAX_STAFF_CARDS }) : "",
        ].filter(Boolean);
        said = parts.join(" ") || null;
        return result.cards;
      });
      setAdoptNote(saved ? said : null);
      return saved;
    } catch {
      // 失败原因已由 `applySettings` 弹过 toast；这里只保证候选不会被标成「已采纳」。
      return false;
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 16 }}>
      {territoryBanner ? (
        <View style={styles.territoryNotice}>
          <Text style={styles.territoryNoticeText}>{territoryBanner}</Text>
        </View>
      ) : null}
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
          // 空领地显示成「没配」，不再冒充整片：这两种状态在派单时不是一回事。
          const territory =
            territoryText(card.paths, t("orch.staffWholeTerritory")) || t("orch.staffNoTerritory");
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
                {t("orch.staffConcurrencyTag", { n: card.maxConcurrent ?? 1 })}
              </Text>
              <Text style={styles.territory} numberOfLines={1}>
                {t("orch.staffTerritoryValue", { paths: territory })}
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

      {/* 扫岗放在名册下面：先看到现有的人，再看「扫出来的人」，顺序与心里的顺序一致。 */}
      <StaffScan
        skin={skin}
        t={t}
        workspaceId={workspaceId}
        workspaceDir={workspaceDir}
        lang={lang}
        disabled={settingsBusy}
        note={adoptNote}
        onAdopt={adopt}
      />
    </ScrollView>
  );
}
