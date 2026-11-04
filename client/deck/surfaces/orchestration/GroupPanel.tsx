import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  groupReadRpc,
  groupSendRpc,
  groupTextIsBroadcast,
  type GroupDelivery,
  type GroupMember,
  type GroupRoster,
  type GroupTargetPlan,
} from "../../../../shared/group-rpc.ts";
import type { DeckLang } from "../../../../shared/requirement.ts";
import { clockText } from "../../format.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelBanner, PixelButton } from "../../pixel.tsx";
import { GroupProgress } from "./GroupProgress.tsx";
import { OrchSection, rowDivider } from "./parts.tsx";

/**
 * 群：派活的入口，不是聊天窗口。
 *
 * 一屏四件事：按工作区分组的名册、这张需求的进度、说过什么、下一句发给谁。
 * 发送的判定全在 `shared/group-rpc.ts` 的路由里。点名册是选人，不是另写一套
 * 文本格式；正文里的 `@` 仍然可用。`@全部` 不确认就绝不发送。
 *
 * 消息不在这里另存一份：发送成功后让 read 查询失效，界面重读服务端的记录。
 * 客户端再攒一份「我发过的消息」，迟早会和群记录对不上。
 */

/** 群记录按这个条数读：够翻一屏，也免得每次进页签都把整份历史拉回来。 */
const READ_LIMIT = 200;
/** 群成员的读新鲜期：派活会改状态，但没必要每条都重读。 */
const READ_STALE_MS = 10_000;

type Scope = { workspaceId: string; workspaceDir: string };

type SendInput = { text: string; requirementNumber: number | null };

/** 点名册选中的人。发送时带他的 `staffId` 和他所属的工作区，不改他的名字。 */
type Picked = {
  staffId: string;
  name: string;
  workspaceId: string;
  workspaceDir: string;
  workspaceName: string;
};

type Preview = {
  targets: GroupTargetPlan[];
  warnings: string[];
  /** 产生这份清单的原输入：确认时原样再发一次，不受输入框后续编辑影响。 */
  input: SendInput;
  /** 清单属于哪个工作区：确认只能发回同一个工作区。 */
  scope: Scope;
};

/** read 与发送后的失效共用一份 key，改一处不会漏掉另一处。 */
function groupQueryKey(scope: Scope): readonly ["deck", "group", string, string] {
  return ["deck", "group", scope.workspaceId, scope.workspaceDir] as const;
}

type Problem = {
  detail: string;
  candidates?: {
    staffId: string;
    name: string;
    workspaceId?: string;
    workspaceDir?: string;
    workspaceName?: string;
  }[];
};

/**
 * 同一个 `staffId` 可能出现在多个会话里：优先保留未归档的那条。
 * `staffId` 为空的是没挂岗位标签的会话，不能互相合并——那是几个不同的人。
 */
function dedupeMembers(members: readonly GroupMember[]): GroupMember[] {
  const byId = new Map<string, number>();
  const out: GroupMember[] = [];
  for (const member of members) {
    if (!member.staffId) {
      out.push(member);
      continue;
    }
    const at = byId.get(member.staffId);
    if (at === undefined) {
      byId.set(member.staffId, out.length);
      out.push(member);
    } else if (out[at]!.archived && !member.archived) {
      out[at] = member;
    }
  }
  return out;
}

/** 需求票号可选；填了就必须是正整数。 */
function parseRequirement(value: string): { ok: true; number: number | null } | { ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, number: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const number = Number(trimmed);
  if (!Number.isSafeInteger(number) || number <= 0) return { ok: false };
  return { ok: true, number };
}

export function GroupPanel({
  skin,
  t,
  lang,
  workspaceId,
  workspaceDir,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  lang: DeckLang;
  workspaceId: string;
  workspaceDir: string;
}) {
  const readRpc = useRpc(groupReadRpc);
  const sendRpc = useRpc(groupSendRpc);
  const toast = useToast();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState("");
  const [requirement, setRequirement] = useState("");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  /** 上一次发送里失败的目标：逐条把 `detail` 摆出来，成功的那些不占地方。 */
  const [failed, setFailed] = useState<GroupDelivery[]>([]);

  const scope: Scope = { workspaceId, workspaceDir };
  const key = groupQueryKey(scope);

  // 换工作区时把上一份确认卡、失败条与草稿全部丢掉：确认卡里的目标属于旧工作区。
  useEffect(() => {
    setPreview(null);
    setProblem(null);
    setFailed([]);
    setDraft("");
    setRequirement("");
    setPicked(null);
  }, [workspaceId, workspaceDir]);

  const read = useQuery({
    queryKey: key,
    queryFn: () => readRpc({ workspaceId, workspaceDir, limit: READ_LIMIT }),
    enabled: Boolean(workspaceId && workspaceDir),
    staleTime: READ_STALE_MS,
    retry: false,
  });

  const send = useMutation({
    mutationFn: (vars: { input: SendInput; confirmAll: boolean; scope: Scope; staffId?: string }) =>
      sendRpc({
        workspaceId: vars.scope.workspaceId,
        workspaceDir: vars.scope.workspaceDir,
        text: vars.input.text,
        requirementNumber: vars.input.requirementNumber,
        ...(vars.confirmAll ? { confirmAll: true } : {}),
        ...(vars.staffId ? { staffId: vars.staffId } : {}),
        lang,
      }),
    onSuccess: (result, vars) => {
      if (!result.ok) {
        // 失败原因由服务端写成人话；机器码不再印一遍。
        setPreview(null);
        setProblem({ detail: result.detail, ...(result.candidates ? { candidates: result.candidates } : {}) });
        return;
      }
      if (result.status === "preview") {
        // 只出清单，不发送：确认按钮才会带 `confirmAll` 再调一次。
        setProblem(null);
        setPreview({ targets: result.targets, warnings: result.warnings, input: vars.input, scope: vars.scope });
        return;
      }

      setPreview(null);
      setProblem(null);
      const failures = result.deliveries.filter((delivery) => delivery.detail);
      setFailed(failures);
      toast.show(t("group.sentSummary", { ok: result.deliveries.length - failures.length, failed: failures.length }), {
        variant: failures.length ? "warning" : "success",
      });
      for (const warning of result.warnings) toast.show(warning, { variant: "warning" });
      // 全部成功才清输入：部分失败时留着原话，方便改完重发。
      if (failures.length === 0) setDraft((current) => (current === vars.input.text ? "" : current));
      void queryClient
        .invalidateQueries({ queryKey: groupQueryKey(vars.scope) })
        .catch(() => toast.show(t("group.refreshFailed"), { variant: "warning" }));
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const members = useMemo(() => dedupeMembers(read.data?.ok ? read.data.members : []), [read.data]);
  const rosters: GroupRoster[] = read.data?.ok ? read.data.rosters : [];
  const rosterCount = rosters.reduce((sum, roster) => sum + roster.staff.length, 0);
  const records = read.data?.ok ? read.data.records : [];
  const warnings = read.data?.ok ? read.data.warnings : [];
  const requirementParsed = parseRequirement(requirement);
  const requirementNumber = requirementParsed.ok ? requirementParsed.number : null;
  /** 当前工作区里还在跑的会话：名册行上补一句状态。别的工作区这次没列会话。 */
  const liveStatus = useMemo(() => {
    const status = new Map<string, string>();
    for (const member of members) {
      if (!member.staffId || member.archived || status.has(member.staffId)) continue;
      status.set(member.staffId, member.status);
    }
    return status;
  }, [members]);

  let readError: string | null = null;
  if (read.data && !read.data.ok) readError = read.data.detail;
  else if (!read.data && read.error) readError = t("group.readFailed");

  const submit = () => {
    const text = draft.trim();
    if (!text) {
      setPreview(null);
      setProblem({ detail: t("group.emptyDraft") });
      return;
    }
    const parsed = parseRequirement(requirement);
    if (!parsed.ok) {
      setPreview(null);
      setProblem({ detail: t("group.requirementInvalid") });
      return;
    }
    setPreview(null);
    setProblem(null);
    setFailed([]);
    // `@全部` 让路：广播打开群的这个工作区，不跟着上次点的人跑到别的区。
    const broadcast = groupTextIsBroadcast(text);
    const target = picked && !broadcast ? picked : null;
    send.mutate({
      input: { text, requirementNumber: parsed.number },
      confirmAll: false,
      scope: target ?? scope,
      ...(target ? { staffId: target.staffId } : {}),
    });
  };

  const confirm = () => {
    if (!preview || send.isPending) return;
    // 用产生清单的那份输入与工作区：确认卡上的 N 个目标与这次发送必须是同一句。
    send.mutate({ input: preview.input, confirmAll: true, scope: preview.scope });
  };

  const styles = useMemo(
    () => ({
      hint: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      row: { paddingVertical: 5, gap: 2 },
      nameLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      name: { flexShrink: 1, color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
      archivedName: { color: skin.colors.ink2 },
      archivedTag: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      status: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      recordHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      from: { color: skin.colors.ink, fontSize: 11, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
      time: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      body: { color: skin.colors.ink, fontSize: 12, lineHeight: 17, fontFamily: skin.mono.fontFamily },
      system: { color: skin.colors.ink2 },
      composer: { gap: 6 },
      input: { ...skin.input, minHeight: 54, textAlignVertical: "top" as const },
      requirementRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      requirementLabel: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      requirementInput: { ...skin.input, width: 92 },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      preview: { borderLeftWidth: 1, borderLeftColor: skin.colors.acc, paddingLeft: 8, paddingVertical: 2, gap: 5 },
      previewTitle: { color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
      target: { color: skin.colors.ink, fontSize: 11, fontFamily: skin.mono.fontFamily, paddingVertical: 3, paddingLeft: 6 },
      candidate: { color: skin.colors.ink, fontSize: 11, fontFamily: skin.mono.fontFamily },
      workspace: { color: skin.colors.ink, fontSize: 11, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily, marginTop: 6 },
      currentTag: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      selected: { borderLeftWidth: 2, borderLeftColor: skin.colors.acc, paddingLeft: 6 },
      kind: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
    }),
    [skin],
  );

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16, gap: 12 }}>
      {/* 群读的是自己的 RPC：顶栏那颗刷编排状态，刷不到这里，所以自带一颗。 */}
      <View style={styles.toolbar}>
        <View style={{ flex: 1 }} />
        <PixelButton
          skin={skin}
          mini
          variant="ghost"
          label={read.isFetching ? t("common.refreshing") : t("common.refresh")}
          onPress={() => void read.refetch()}
        />
      </View>

      <OrchSection skin={skin} title={t("group.members")} aside={t("group.memberCount", { n: rosterCount })}>
        {read.isPending && !read.data ? <Text style={styles.hint}>{t("common.loading")}</Text> : null}
        {!read.isPending && rosters.length === 0 ? <Text style={styles.hint}>{t("group.membersEmpty")}</Text> : null}
        {rosters.map((roster) => (
          <View key={roster.workspaceId}>
            <Text style={styles.workspace} numberOfLines={1}>
              {roster.name}
              {roster.current ? ` · ${t("group.currentWorkspace")}` : ""}
            </Text>
            {roster.detail ? <Text style={styles.hint}>{t("group.rosterFailed", { detail: roster.detail })}</Text> : null}
            {!roster.detail && roster.staff.length === 0 ? <Text style={styles.hint}>{t("group.rosterEmpty")}</Text> : null}
            {roster.staff.map((person, index) => {
              const selected = picked?.staffId === person.staffId && picked.workspaceId === roster.workspaceId;
              const status = roster.current ? liveStatus.get(person.staffId) : undefined;
              return (
                <Pressable
                  key={`${roster.workspaceId}:${person.staffId}`}
                  accessibilityRole="button"
                  accessibilityLabel={t("group.pick", { name: person.name })}
                  accessibilityState={{ selected }}
                  onPress={() => setPicked({
                    staffId: person.staffId,
                    name: person.name,
                    workspaceId: roster.workspaceId,
                    workspaceDir: roster.workspaceDir,
                    workspaceName: roster.name,
                  })}
                  style={[styles.row, rowDivider(skin, index === 0), selected ? styles.selected : null]}
                >
                  <View style={styles.nameLine}>
                    <Text style={styles.name} numberOfLines={1}>{person.name}</Text>
                    <Text style={styles.kind}>{t(person.kind === "manager" ? "group.kind.manager" : "group.kind.worker")}</Text>
                  </View>
                  {status ? <Text style={styles.status} numberOfLines={1}>{status}</Text> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
        {warnings.map((warning) => <Text key={warning} style={styles.hint}>{warning}</Text>)}
      </OrchSection>

      <GroupProgress skin={skin} t={t} workspaceDir={workspaceDir} number={requirementNumber} />

      <OrchSection skin={skin} title={t("group.messages")} aside={t("group.messageCount", { n: records.length })}>
        {read.isPending && !read.data ? <Text style={styles.hint}>{t("common.loading")}</Text> : null}
        {readError ? (
          <PixelBanner skin={skin}><Text style={skin.error}>{readError}</Text></PixelBanner>
        ) : null}
        {!read.isPending && !readError && records.length === 0 ? <Text style={styles.hint}>{t("group.empty")}</Text> : null}
        {records.map((record, index) => {
          const system = record.kind === "system";
          return (
            <View key={`${record.at}-${index}`} style={[styles.row, rowDivider(skin, index === 0)]}>
              <View style={styles.recordHead}>
                <Text style={[styles.from, system ? styles.system : null]} numberOfLines={1}>
                  {rosters.length > 1 && record.workspaceName ? `${record.from} · ${record.workspaceName}` : record.from}
                </Text>
                <View style={{ flex: 1 }} />
                <Text style={styles.time}>{clockText(record.at)}</Text>
              </View>
              <Text style={[styles.body, system ? styles.system : null]}>{record.text}</Text>
            </View>
          );
        })}
        {read.data?.ok && read.data.skipped > 0 ? (
          <Text style={styles.hint}>{t("group.skipped", { n: read.data.skipped })}</Text>
        ) : null}
        {/* 服务端只取最近 READ_LIMIT 条；读到满额就明说更早的没读，别让人以为这就是全部。 */}
        {records.length >= READ_LIMIT ? (
          <Text style={styles.hint}>{t("group.truncated", { n: READ_LIMIT })}</Text>
        ) : null}
      </OrchSection>

      <OrchSection skin={skin} title={t("group.composer")}>
        <View style={styles.composer}>
          {/* 提示只在这一处：输入框上方一句，说清 @ 与不带 @ 各去哪。 */}
          <Text style={styles.hint}>{t("group.hint")}</Text>

          {problem ? (
            <PixelBanner skin={skin}>
              <Text style={skin.error}>{problem.detail}</Text>
              {problem.candidates?.length ? (
                <>
                  <Text style={styles.hint}>{t("group.candidates")}</Text>
                  {problem.candidates.map((candidate) => (
                    <PixelButton
                      key={`${candidate.workspaceId ?? ""}:${candidate.staffId}`}
                      skin={skin}
                      mini
                      variant="ghost"
                      label={candidate.workspaceName ? `${candidate.name} · ${candidate.workspaceName}` : candidate.name}
                      onPress={() => {
                        setPicked({
                          staffId: candidate.staffId,
                          name: candidate.name,
                          workspaceId: candidate.workspaceId ?? workspaceId,
                          workspaceDir: candidate.workspaceDir ?? workspaceDir,
                          workspaceName: candidate.workspaceName ?? "",
                        });
                        setProblem(null);
                      }}
                    />
                  ))}
                </>
              ) : null}
            </PixelBanner>
          ) : null}

          {failed.length ? (
            <PixelBanner skin={skin} tone="warning">
              <Text style={styles.hint}>{t("group.failed")}</Text>
              {failed.map((delivery, index) => (
                <Text key={`${delivery.staffId ?? ""}#${index}`} style={styles.hint}>
                  {t("group.failedLine", { name: delivery.name, detail: delivery.detail ?? "" })}
                </Text>
              ))}
            </PixelBanner>
          ) : null}

          {preview ? (
            <View style={styles.preview}>
              <Text style={styles.previewTitle}>{t("group.previewTitle", { n: preview.targets.length })}</Text>
              <Text style={styles.hint}>{t("group.previewHint")}</Text>
              {preview.targets.map((target, index) => (
                <Text key={`${target.staffId ?? ""}#${index}`} style={[styles.target, rowDivider(skin, index === 0)]} numberOfLines={1}>
                  {target.name}
                </Text>
              ))}
              {preview.warnings.map((warning) => <Text key={warning} style={styles.hint}>{warning}</Text>)}
              <View style={styles.actions}>
                <PixelButton
                  skin={skin}
                  variant="solid"
                  label={send.isPending ? t("group.sending") : t("group.confirm")}
                  disabled={send.isPending}
                  onPress={confirm}
                />
                <PixelButton
                  skin={skin}
                  variant="ghost"
                  label={t("orch.cancel")}
                  disabled={send.isPending}
                  onPress={() => setPreview(null)}
                />
              </View>
            </View>
          ) : null}

          {picked ? (
            <View style={styles.requirementRow}>
              <Text style={styles.hint}>
                {t("group.picked", { name: picked.name, workspace: picked.workspaceName || picked.workspaceId })}
              </Text>
              <PixelButton skin={skin} mini variant="ghost" label={t("group.clearPick")} onPress={() => setPicked(null)} />
            </View>
          ) : null}

          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t("group.messagePlaceholder")}
            accessibilityLabel={t("group.composer")}
            placeholderTextColor={skin.colors.ink2}
            style={styles.input}
            multiline
          />

          <View style={styles.requirementRow}>
            <Text style={styles.requirementLabel}>{t("group.requirement")}</Text>
            <TextInput
              value={requirement}
              onChangeText={setRequirement}
              placeholder={t("group.requirementPlaceholder")}
              accessibilityLabel={t("group.requirement")}
              placeholderTextColor={skin.colors.ink2}
              keyboardType="numeric"
              style={styles.requirementInput}
            />
            <View style={{ flex: 1 }} />
            <PixelButton
              skin={skin}
              variant="solid"
              label={send.isPending && !preview ? t("group.sending") : t("group.send")}
              disabled={send.isPending}
              onPress={submit}
            />
          </View>
        </View>
      </OrchSection>
    </ScrollView>
  );
}
