import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { orchestrationRequirementDispatchRpc } from "../../../shared/orchestration-rpc.ts";
import { usePanelText } from "./panelText.tsx";
import { PixelBanner, PixelButton, usePixel, type PixelSkin } from "../pixel.tsx";

/**
 * 需求定稿之后的「按区派单」。
 *
 * 需求票确认定稿（`deck:定稿`）之前这块不出现——定稿是整条链的分界，没定稿
 * 就拆票等于按一份还在改的图纸开工。定稿之后第一次点只拿清单（几个区、每区
 * 派给谁、开几个会话），再点一次才真建票建会话：八个会话是八份钱。
 *
 * 计划与拒绝原因都原样摆在票面上，不在这里再解释一遍——说两遍就会两边不一致。
 */

type SummaryRow = {
  kind: "work" | "research";
  workspaceId: string;
  area: string;
  repoKey: string | null;
  staffId: string | null;
  staffName: string | null;
  provider: string | null;
  model: string | null;
  sessions: number;
};

const EN = {
  title: "Dispatch by area",
  blurb: "Split the finalized requirement into one ticket per area and one session per staff card. The first click only previews.",
  plan: "Preview split",
  planning: "Planning…",
  confirm: "Create {n} sessions",
  confirming: "Creating…",
  cancel: "Cancel",
  empty: "No area rows matched. Check the impact table's area and repo columns.",
  research: "research",
  work: "work",
  unassigned: "unassigned",
  done: "Created {tickets} tickets and {sessions} sessions.",
  sessions: "{n} sessions",
  failed: "Could not dispatch",
};

const ZH = {
  title: "按区派单",
  blurb: "把定稿的需求拆成每区一张票、每张岗位卡一个会话。第一次点只出清单。",
  plan: "看拆分清单",
  planning: "正在算…",
  confirm: "确认新建 {n} 个会话",
  confirming: "正在新建…",
  cancel: "取消",
  empty: "没有对上任何区域。检查影响面表里的「区」与「仓库」两列。",
  research: "研究",
  work: "工作",
  unassigned: "未指派",
  done: "已建 {tickets} 张票、{sessions} 个会话。",
  sessions: "{n} 个会话",
  failed: "派不出去",
};

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

export function RequirementDispatchButton({
  theme,
  workspaceId,
  workspaceDir,
  requirementNumber,
  requirementRepoKey,
  finalized,
  disabled = false,
  onDispatched,
}: {
  theme: PluginTheme;
  workspaceId: string;
  workspaceDir: string;
  requirementNumber: number;
  requirementRepoKey?: string;
  finalized: boolean;
  disabled?: boolean;
  onDispatched?: () => void;
}) {
  const { zh } = usePanelText();
  const copy = zh ? ZH : EN;
  const skin = usePixel(theme);
  const rpc = useRpc(orchestrationRequirementDispatchRpc);
  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  /** 失败原因（红色）：读不懂就别让人猜。 */
  const [detail, setDetail] = useState<string | null>(null);
  /** 成功回执（中性色）：建了几张票、几个会话。 */
  const [notice, setNotice] = useState<string | null>(null);

  const dispatch = useMutation({
    mutationFn: async (confirm: boolean) =>
      rpc({
        workspaceId,
        workspaceDir,
        requirementNumber,
        ...(requirementRepoKey ? { requirementRepoKey } : {}),
        ...(confirm ? { confirm: true } : {}),
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        setSummary(null);
        setNotice(null);
        setDetail(result.detail);
        return;
      }
      setDetail(null);
      setSummary(result.summary);
      if (result.created) {
        const tickets = result.summary.length;
        const sessions = result.summary.reduce((total, row) => total + row.sessions, 0);
        setNotice(fill(copy.done, { tickets, sessions }));
        onDispatched?.();
      }
    },
    onError: (error) => {
      setSummary(null);
      setNotice(null);
      setDetail(error instanceof Error ? error.message : String(error));
    },
  });

  if (!finalized) return null;

  const plannedSessions = (summary ?? []).reduce((total, row) => total + row.sessions, 0);
  const busy = dispatch.isPending;

  return (
    <View style={sectionStyle(skin)}>
      <Text style={titleStyle(skin)}>{copy.title}</Text>
      <Text style={blurbStyle(skin)}>{copy.blurb}</Text>

      {summary === null ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <PixelButton
            skin={skin}
            active
            label={busy ? copy.planning : copy.plan}
            disabled={disabled || busy}
            onPress={() => dispatch.mutate(false)}
          />
        </View>
      ) : (
        <View style={{ gap: 6 }}>
          {summary.length === 0 ? <Text style={blurbStyle(skin)}>{copy.empty}</Text> : null}
          {summary.map((row) => (
            <Text key={`${row.workspaceId}:${row.area}:${row.staffId ?? ""}`} style={rowStyle(skin)}>
              {row.kind === "research" ? copy.research : copy.work} · {row.area}
              {" · "}
              {row.staffName ?? copy.unassigned}
              {row.provider ? ` · ${row.provider}${row.model ? `/${row.model}` : ""}` : ""}
              {` · ${fill(copy.sessions, { n: row.sessions })}`}
            </Text>
          ))}
          {plannedSessions > 0 ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <PixelButton
                skin={skin}
                active
                label={busy ? copy.confirming : fill(copy.confirm, { n: plannedSessions })}
                disabled={disabled || busy}
                onPress={() => dispatch.mutate(true)}
              />
              <PixelButton skin={skin} variant="ghost" label={copy.cancel} disabled={busy} onPress={() => setSummary(null)} />
            </View>
          ) : null}
        </View>
      )}

      {notice ? <Text style={skin.hint}>{notice}</Text> : null}

      {detail ? (
        <PixelBanner skin={skin}>
          <Text style={skin.error}>{detail}</Text>
        </PixelBanner>
      ) : null}
    </View>
  );
}

function sectionStyle(skin: PixelSkin) {
  return {
    borderTopWidth: 1,
    borderTopColor: skin.colors.line,
    paddingTop: 10,
    marginTop: 10,
    gap: 6,
  } as const;
}

function titleStyle(skin: PixelSkin) {
  return skin.label;
}

function blurbStyle(skin: PixelSkin) {
  return skin.hint;
}

function rowStyle(skin: PixelSkin) {
  return skin.value;
}
