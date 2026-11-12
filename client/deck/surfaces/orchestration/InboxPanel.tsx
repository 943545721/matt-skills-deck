import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  orchestrationInboxActRpc,
  orchestrationInboxRpc,
  orchestrationStateRpc,
  type CoordinationActionWire,
  type CoordinationInboxRowWire,
} from "../../../../shared/orchestration-rpc.ts";
import { rosterOf } from "../../../../shared/staff.ts";
import { clockText } from "../../format.ts";
import { usePanelText } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelBanner, PixelButton, usePixel } from "../../pixel.tsx";
import { OrchSection, rowDivider } from "./parts.tsx";
import { territoryLines } from "./staff-draft.ts";

/**
 * 协调收件箱。
 *
 * 员工会话写到别人的区时，越界闸会拒绝那次写并在这里落一条请求。收件箱只做
 * 三件事：这条请求是什么、归谁、人打算怎么处置。三个按钮都走 RPC——客户端
 * 没有文件系统访问，写请求不能由界面直接落盘。
 *
 * 「不派」不是「禁止」：驳回后原会话收到的是「这片归 X，去跟 X 协调」；
 * 「批准这一次」只放行（会话，路径）这一次，不改变领地。
 */

const EN = {
  title: "Coordination inbox",
  blurb: "Staff sessions that write outside their own territory land here. Denying means coordinate with the owner, not that the work is forbidden.",
  count: "{n} requests",
  loading: "Reading the inbox…",
  empty: "Nothing waiting. Requests appear when a staff session writes outside its area.",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  readFailed: "Could not read the inbox. If this panel was just updated, reload the plugin first.",
  from: "from {staff}",
  to: "to {staff}",
  rootManager: "root manager",
  task: "Task",
  paths: "Paths",
  needLine: "Need: {value}",
  fieldLine: "Field: {value}",
  target: "Reassign to",
  approveOnce: "Approve once",
  reassign: "Reassign",
  deny: "Do not dispatch",
  staff: "Staff it",
  decline: "Do not staff",
  contractChanged: "Contract changed",
  implChanged: "Implementation changed",
  applied: "Request updated.",
  noTarget: "Pick a card before reassigning.",
  expired: "expired",
  kinds: { territory: "territory", staffing: "staffing", contract: "contract", lineage: "session link" },
  states: {
    "pending": "pending",
    "approved-once": "approved once",
    "consumed": "consumed",
    "reassigned": "reassigned",
    "denied": "denied",
    "staffed": "staffed",
    "declined": "declined",
    "contract-changed": "contract changed",
    "impl-changed": "implementation changed",
    "superseded": "superseded",
    "cancelled": "cancelled",
    "recorded": "recorded",
  },
};

const ZH: typeof EN = {
  title: "协调收件箱",
  blurb: "员工会话写到别人的区时，请求会落在这里。驳回是「去跟归属人协调」，不是「这件事不许做」。",
  count: "{n} 条请求",
  loading: "正在读收件箱…",
  empty: "没有待处置的请求。员工写出自己的区时，请求才会出现。",
  refresh: "刷新",
  refreshing: "刷新中…",
  readFailed: "读不出收件箱。如果面板刚更新过，先重新加载插件。",
  from: "来自 {staff}",
  to: "转给 {staff}",
  rootManager: "根经理",
  task: "任务",
  paths: "路径",
  needLine: "缺人：{value}",
  fieldLine: "字段：{value}",
  target: "转给",
  approveOnce: "批准这一次",
  reassign: "转给",
  deny: "不派",
  staff: "派人",
  decline: "不派",
  contractChanged: "契约已改",
  implChanged: "实现已改",
  applied: "请求已更新。",
  noTarget: "先选一张目标卡再转派。",
  expired: "已超时",
  kinds: { territory: "越界", staffing: "要人手", contract: "契约对不上", lineage: "会话血缘" },
  states: {
    "pending": "待处置",
    "approved-once": "已批准一次",
    "consumed": "已用掉",
    "reassigned": "已转派",
    "denied": "已驳回",
    "staffed": "已派人",
    "declined": "未派人",
    "contract-changed": "契约已改",
    "impl-changed": "实现已改",
    "superseded": "已被覆盖",
    "cancelled": "已取消",
    "recorded": "已记录",
  },
};

function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}

type Copy = typeof EN;

/** 一条记录「谁 → 谁」：territory 的 toStaff 为空时是根经理接手。 */
function whoLine(row: CoordinationInboxRowWire, copy: Copy): string {
  const from = fill(copy.from, { staff: row.fromStaff });
  if (row.toStaff) return `${from} → ${fill(copy.to, { staff: row.toStaff })}`;
  if (row.kind === "territory") return `${from} → ${fill(copy.to, { staff: copy.rootManager })}`;
  return from;
}

/** 动作 → 文案键。与 `actionsOf` 一起，保证界面不靠级联三元挑标签。 */
const ACTION_LABEL_KEYS: Record<
  CoordinationActionWire,
  "approveOnce" | "reassign" | "deny" | "staff" | "decline" | "contractChanged" | "implChanged"
> = {
  "approve-once": "approveOnce",
  reassign: "reassign",
  deny: "deny",
  staff: "staff",
  decline: "decline",
  "contract-changed": "contractChanged",
  "impl-changed": "implChanged",
};

function useInboxStyles(skin: PixelSkin) {
  return useMemo(
    () => ({
      hint: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      warn: skin.error,
      row: { paddingVertical: 7, gap: 3 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      kind: { color: skin.colors.acc, fontSize: 10, fontFamily: skin.mono.fontFamily },
      state: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      who: { flex: 1, color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily },
      time: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      body: { color: skin.colors.ink, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      /** 路径行与岗位领地同一种绿，版式不变。 */
      path: { color: skin.colors.ok, fontSize: 11, fontFamily: skin.mono.fontFamily },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 4, paddingTop: 2 },
      targetLine: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 4 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    }),
    [skin],
  );
}

/** 一条记录能用哪些动作：终端态不给按钮，避免点了必然失败。 */
function actionsOf(row: CoordinationInboxRowWire): CoordinationActionWire[] {
  if (row.kind === "territory") {
    if (row.state === "pending") return ["approve-once", "reassign", "deny"];
    if (row.state === "approved-once") return ["reassign", "deny"];
    return [];
  }
  if (row.kind === "staffing") return row.state === "pending" ? ["staff", "decline"] : [];
  return row.state === "pending" ? ["contract-changed", "impl-changed"] : [];
}

export function InboxPanel({
  theme,
  workspaceId,
  workspaceDir,
}: {
  theme: PluginTheme;
  workspaceId: string;
  workspaceDir: string;
}) {
  const { zh, t } = usePanelText();
  const copy = zh ? ZH : EN;
  const skin = usePixel(theme);
  const styles = useInboxStyles(skin);
  const toast = useToast();

  const inboxRpc = useRpc(orchestrationInboxRpc);
  const actRpc = useRpc(orchestrationInboxActRpc);
  const stateRpc = useRpc(orchestrationStateRpc);

  const enabled = Boolean(workspaceId && workspaceDir);
  const inbox = useQuery({
    queryKey: ["deck", "orchestration", "inbox", workspaceId, workspaceDir],
    queryFn: () => inboxRpc({ workspaceId, workspaceDir }),
    enabled,
    staleTime: 10_000,
    retry: false,
  });

  // 名册只用来给「转给」提供目标卡；与编排页共用同一份状态查询。
  const state = useQuery({
    queryKey: ["deck", "orchestration", workspaceId, workspaceDir],
    queryFn: () => stateRpc({ workspaceId, workspaceDir }),
    enabled,
    staleTime: 15_000,
    retry: false,
  });
  // 名册按目录取：同一目录会有好几个 workspaceId，按 id 取会读成空名册。
  const roster = state.data?.ok ? rosterOf(state.data.settings) : [];

  const [targets, setTargets] = useState<Record<number, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: (vars: { index: number; action: CoordinationActionWire; toStaff?: string }) =>
      actRpc({ workspaceId, workspaceDir, ...vars }),
    onSuccess: (result) => {
      if (!result.ok) {
        // 失败原样显示服务端那句 detail：那是唯一说清「为什么这次没成」的东西。
        setProblem(result.detail);
        return;
      }
      setProblem(null);
      toast.show(copy.applied, { variant: "success" });
      void inbox.refetch();
    },
    onError: (error) => {
      setProblem(error instanceof Error ? error.message : String(error));
    },
  });

  const rows = inbox.data?.ok ? inbox.data.records : [];
  const warnings = inbox.data?.ok ? inbox.data.warnings : [];
  let readError: string | null = problem;
  if (inbox.data && !inbox.data.ok) readError = inbox.data.detail;
  else if (!inbox.data && inbox.error) readError = copy.readFailed;

  const targetFor = (row: CoordinationInboxRowWire): string =>
    targets[row.index] ?? row.toStaff ?? "";

  const run = (row: CoordinationInboxRowWire, action: CoordinationActionWire) => {
    const toStaff = action === "reassign" ? targetFor(row).trim() : undefined;
    if (action === "reassign" && !toStaff) {
      setProblem(copy.noTarget);
      return;
    }
    setProblem(null);
    act.mutate({ index: row.index, action, ...(toStaff ? { toStaff } : {}) });
  };

  const aside = inbox.isFetching ? copy.refreshing : fill(copy.count, { n: rows.length });

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16, gap: 10 }}>
      <OrchSection skin={skin} title={copy.title} aside={aside}>
        <Text style={styles.hint}>{copy.blurb}</Text>

        <View style={styles.toolbar}>
          <View style={{ flex: 1 }} />
          <PixelButton
            skin={skin}
            mini
            variant="ghost"
            label={inbox.isFetching ? copy.refreshing : copy.refresh}
            onPress={() => void inbox.refetch()}
          />
        </View>

        {warnings.map((warning) => (
          <Text key={warning} style={styles.hint}>{warning}</Text>
        ))}
        {readError ? (
          <PixelBanner skin={skin}>
            <Text style={styles.warn}>{readError}</Text>
          </PixelBanner>
        ) : null}
        {inbox.isPending && !inbox.data ? <Text style={styles.hint}>{copy.loading}</Text> : null}
        {!inbox.isPending && !readError && rows.length === 0 ? (
          <Text style={styles.hint}>{copy.empty}</Text>
        ) : null}

        {rows.map((row, index) => {
          const actions = actionsOf(row);
          const selected = targetFor(row);
          return (
            <View key={`${row.at}-${row.index}`} style={[styles.row, rowDivider(skin, index === 0)]}>
              <View style={styles.head}>
                <Text style={styles.kind}>{copy.kinds[row.kind]}</Text>
                <Text style={styles.state}>
                  {copy.states[row.state] ?? row.state}
                  {row.expired ? ` · ${copy.expired}` : ""}
                </Text>
                <View style={{ flex: 1 }} />
                <Text style={styles.time}>{clockText(row.at)}</Text>
              </View>

              <Text style={styles.who} numberOfLines={2}>{whoLine(row, copy)}</Text>

              <Text style={styles.body} numberOfLines={3}>{row.taskSummary}</Text>
              {territoryLines(row.paths).map((line, lineIndex) => (
                <Text key={`${line.path}#${lineIndex}`} style={styles.path} numberOfLines={1}>
                  {line.whole ? t("orch.staffWholeTerritory") : line.path}
                </Text>
              ))}
              {row.need ? <Text style={styles.hint}>{fill(copy.needLine, { value: row.need })}</Text> : null}
              {row.field ? <Text style={styles.hint}>{fill(copy.fieldLine, { value: row.field })}</Text> : null}

              {actions.includes("reassign") ? (
                <View style={styles.targetLine}>
                  <Text style={styles.hint}>{copy.target}</Text>
                  {roster.map((card) => (
                    <PixelButton
                      key={card.id}
                      skin={skin}
                      mini
                      variant="outline"
                      active={selected === card.id}
                      label={card.name || card.id}
                      onPress={() => setTargets((previous) => ({ ...previous, [row.index]: card.id }))}
                    />
                  ))}
                  {!selected && roster.length === 0 ? <Text style={styles.hint}>{copy.noTarget}</Text> : null}
                </View>
              ) : null}

              {actions.length > 0 ? (
                <View style={styles.actions}>
                  {actions.map((action) => (
                    <PixelButton
                      key={action}
                      skin={skin}
                      mini
                      variant={action === "deny" || action === "decline" ? "ghost" : "outline"}
                      label={copy[ACTION_LABEL_KEYS[action]]}
                      disabled={act.isPending || (action === "reassign" && !selected)}
                      onPress={() => run(row, action)}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </OrchSection>
    </ScrollView>
  );
}
