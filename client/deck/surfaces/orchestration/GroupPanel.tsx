import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  groupReadRpc,
  groupSendRpc,
  groupTextIsBroadcast,
  type GroupDelivery,
  type GroupRoster,
  type GroupTargetPlan,
} from "../../../../shared/group-rpc.ts";
import type { DeckLang } from "../../../../shared/requirement.ts";
import { clockText } from "../../format.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelBanner, PixelButton } from "../../pixel.tsx";
import { GroupProgress } from "./GroupProgress.tsx";
import { MemberRail } from "./MemberRail.tsx";
import { railRowsOf, type GroupPick } from "./rail-model.ts";

/**
 * 群：派活的入口，不是聊天窗口。
 *
 * 左边是说过什么 + 下一句发给谁，右边是这屋里坐着谁。两块并排，是因为派活时
 * 「说给谁听」和「说什么」是同一件事：把人名塞进消息区上面，点人就得先滚回去找人。
 * 点右栏一个人：下一句发给他，并就地展开他的进度与交接（见 `MemberDetail`）。
 *
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
/** 需求进度只占一段高度：它是参考，不该把消息区挤没。 */
const PROGRESS_MAX_HEIGHT = 168;
/** 右栏宽度：够放一行「头像 + 名字 + 状态」，再宽就只剩空白。 */
const RAIL_WIDTH = 228;

type Scope = { workspaceId: string; workspaceDir: string };

type SendInput = { text: string; requirementNumber: number | null };

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
  /** 重名时列出来的候选：都在本群名册上，点一张就把这句派给他。 */
  candidates?: { staffId: string; name: string }[];
};

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
  large,
  onOpenStaff,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  lang: DeckLang;
  workspaceId: string;
  workspaceDir: string;
  /** 宽屏两栏（消息 + 成员）；窄屏上下叠，成员在上。 */
  large: boolean;
  /** 名册空时把人送去「岗位」：右栏空着没有出路，等于把人卡在这一页。 */
  onOpenStaff?(): void;
}) {
  const readRpc = useRpc(groupReadRpc);
  const sendRpc = useRpc(groupSendRpc);
  const toast = useToast();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState("");
  const [requirement, setRequirement] = useState("");
  const [picked, setPicked] = useState<GroupPick | null>(null);
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

  // 一个项目一个群：本目录一份名册、本目录一份记录，没有第二份可以混进来。
  const roster: GroupRoster = read.data?.ok ? read.data.roster : { staff: [] };
  const records = read.data?.ok ? read.data.records : [];
  const warnings = read.data?.ok ? read.data.warnings : [];
  // 名册与会话合并成右栏的行：同一个人只出现一次，在跑的会话顶掉已归档的。
  const rows = useMemo(
    () => railRowsOf({ roster, members: read.data?.ok ? read.data.members : [] }),
    // 只跟这份读回来的数据走：`roster` 是每次渲染新取的对象，放进依赖等于没缓存。
    [read.data],
  );
  // 群属于哪个目录，页面顶上那行要说清楚：名字读宿主，读不到时退回目录，不留空。
  const workspace = useWorkspace(workspaceId, (snapshot) => snapshot.name);
  const workspaceLabel = workspace?.trim() || workspaceDir;
  // 名册读失败时 `staff` 是空的：空的不能说成「这个群没有人」，原因要摆出来。
  const rosterProblems = roster.detail ? [roster.detail] : [];
  const requirementParsed = parseRequirement(requirement);
  const requirementNumber = requirementParsed.ok ? requirementParsed.number : null;

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
    // 一律按**这个页面**的工作区发：群属于一个目录，换 scope 就不是这个群了。
    send.mutate({
      input: { text, requirementNumber: parsed.number },
      confirmAll: false,
      scope,
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
      shell: { flex: 1, gap: 8, minHeight: 0 },
      page: { flex: 1, gap: 10, minHeight: 0, minWidth: 0 },
      pageWide: { flexDirection: "row" as const },
      /**
       * `minWidth: 0` 不是多余的：弹性盒里 flex 子项的默认最小宽度是「内容宽度」，
       * 消息区里一句长文案就能把右栏整条挤出屏幕（web 上表现为右栏消失）。
       */
      chat: { flex: 1, gap: 6, minHeight: 0, minWidth: 0 },
      railWrap: {
        width: RAIL_WIDTH,
        flexShrink: 0,
        borderLeftWidth: 1,
        borderLeftColor: skin.colors.line,
        paddingLeft: 10,
      },
      railWrapCompact: { borderBottomWidth: 1, borderBottomColor: skin.colors.line, paddingBottom: 6 },
      /** 这个群属于哪个目录：名字 + 路径一行说完，进页面第一眼就该看到。 */
      workspaceBar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, minWidth: 0 },
      workspaceLabel: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      /**
       * 名字是用户自己填的，可能是一整句话；路径也可能很长。两个都能让位
       * （`minWidth: 0` 是让位的前提），并各自收成一行省略，谁也不把谁挤出屏幕。
       */
      workspaceName: {
        color: skin.colors.ink,
        fontSize: 11,
        fontWeight: "700" as const,
        fontFamily: skin.mono.fontFamily,
        flexShrink: 1,
        minWidth: 0,
      },
      workspaceDir: {
        flexShrink: 1,
        minWidth: 0,
        color: skin.colors.ink2,
        fontSize: 10,
        fontFamily: skin.mono.fontFamily,
      },
      hint: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      chatHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      chatTitle: { color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
      count: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      log: { gap: 8 },
      system: { color: skin.colors.ink2, fontSize: 10, textAlign: "center" as const, fontFamily: skin.mono.fontFamily },
      bubbleRow: { flexDirection: "row" as const, gap: 6, alignItems: "flex-end" as const },
      bubbleBody: { maxWidth: "84%" as const, gap: 2 },
      bubble: { borderRadius: 8, paddingVertical: 6, paddingHorizontal: 8 },
      from: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      body: { color: skin.colors.ink, fontSize: 12, lineHeight: 17, fontFamily: skin.mono.fontFamily },
      composer: { gap: 6, borderTopWidth: 1, borderTopColor: skin.colors.line, paddingTop: 8 },
      input: { ...skin.input, minHeight: 54, textAlignVertical: "top" as const },
      requirementRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      requirementLabel: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      requirementInput: { ...skin.input, width: 92 },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      preview: { borderLeftWidth: 1, borderLeftColor: skin.colors.acc, paddingLeft: 8, paddingVertical: 2, gap: 5 },
      previewTitle: { color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
      target: { color: skin.colors.ink, fontSize: 11, fontFamily: skin.mono.fontFamily, paddingVertical: 3, paddingLeft: 6 },
    }),
    [skin],
  );

  const chat = (
    <View style={styles.chat}>
      <View style={styles.chatHead}>
        <Text style={styles.chatTitle}>{t("group.messages")}</Text>
        <Text style={styles.count}>{t("group.messageCount", { n: records.length })}</Text>
        <View style={{ flex: 1 }} />
        {/* 群读的是自己的 RPC：顶栏那颗刷编排状态，刷不到这里，所以自带一颗。 */}
        <PixelButton
          skin={skin}
          mini
          variant="ghost"
          label={read.isFetching ? t("common.refreshing") : t("common.refresh")}
          onPress={() => void read.refetch()}
        />
      </View>

      {/* 填了需求票号才占地方：没填时这里是空的，正好把高度留给消息。 */}
      {requirementNumber === null ? null : (
        <ScrollView style={{ maxHeight: PROGRESS_MAX_HEIGHT }} contentContainerStyle={{ paddingBottom: 4 }}>
          <GroupProgress skin={skin} t={t} workspaceDir={workspaceDir} number={requirementNumber} />
        </ScrollView>
      )}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.log}>
        {read.isPending && !read.data ? <Text style={styles.hint}>{t("common.loading")}</Text> : null}
        {!read.isPending && !readError && records.length === 0 ? <Text style={styles.hint}>{t("group.empty")}</Text> : null}
        {records.map((record, index) => {
          if (record.kind === "system") {
            return (
              <Text key={`${record.at}-${index}`} style={styles.system}>
                {`${record.text} · ${clockText(record.at)}`}
              </Text>
            );
          }
          // 自己发的靠右、底色偏强调；别人发的靠左、底色中性。一眼分出「我说的」与「他们说的」。
          const mine = record.kind === "user";
          return (
            <View
              key={`${record.at}-${index}`}
              style={[styles.bubbleRow, { justifyContent: mine ? "flex-end" : "flex-start" }]}
            >
              <View style={styles.bubbleBody}>
                <Text style={[styles.from, { textAlign: mine ? "right" : "left" }]}>
                  {`${record.from} · ${clockText(record.at)}`}
                </Text>
                <View style={[styles.bubble, { backgroundColor: mine ? skin.colors.hi : skin.colors.stripe }]}>
                  <Text style={styles.body}>{record.text}</Text>
                </View>
              </View>
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
      </ScrollView>

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
                    key={candidate.staffId}
                    skin={skin}
                    mini
                    variant="ghost"
                    // 重名才走到这里，按钮上只写名字会长得一模一样：带上 id 才点得定。
                    label={`${candidate.name}（${candidate.staffId}）`}
                    onPress={() => {
                      setPicked({
                        staffId: candidate.staffId,
                        name: candidate.name,
                        // 候选来自发送校验，没带会话 id：进度与记忆要等他被点开时再按名册找。
                        agentId: null,
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
              <Text key={`${target.staffId ?? ""}#${index}`} style={styles.target} numberOfLines={1}>
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
              {t("group.picked", { name: picked.name })}
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
    </View>
  );

  const rail = (
    <MemberRail
      skin={skin}
      t={t}
      workspaceDir={workspaceDir}
      rows={rows}
      pick={picked}
      onPick={setPicked}
      {...(onOpenStaff ? { onAddStaff: onOpenStaff } : {})}
      rosterProblems={rosterProblems}
      loading={read.isPending}
      error={readError}
      warnings={warnings}
      scrollable={large}
    />
  );

  // 读失败是一整页的事（名册和消息一起没了）：只在顶上写一条，两栏里不再各写一遍。
  const failedPage = readError ? (
    <PixelBanner skin={skin}>
      <Text style={skin.error}>{readError}</Text>
    </PixelBanner>
  ) : null;

  return (
    <View style={styles.shell}>
      {/* 一个项目一个群：先说明是哪个项目、落在哪个目录，再谈消息。 */}
      <View style={styles.workspaceBar}>
        <Text style={styles.workspaceLabel}>{t("group.workspace")}</Text>
        <Text style={styles.workspaceName} numberOfLines={1}>
          {workspaceLabel}
        </Text>
        {/* 没起名字的工作区，名字本来就退回目录：同一行再写一遍只是噪声。 */}
        {workspaceLabel === workspaceDir ? null : (
          <Text style={styles.workspaceDir} numberOfLines={1}>
            {workspaceDir}
          </Text>
        )}
      </View>
      {failedPage}
      {large ? (
        <View style={[styles.page, styles.pageWide]}>
          {chat}
          <View style={styles.railWrap}>{rail}</View>
        </View>
      ) : (
        <View style={styles.page}>
          <View style={styles.railWrapCompact}>{rail}</View>
          {chat}
        </View>
      )}
    </View>
  );
}
