import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { DeckLang } from "../../../../shared/requirement.ts";
import type { StaffScanCandidate } from "../../../../shared/staff-scan.ts";
import { staffScanKeyOf } from "../../../../shared/staff-scan.ts";
import { staffScanReadRpc, staffScanStartRpc } from "../../../../shared/staff-scan-rpc.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelBanner, PixelButton } from "../../pixel.tsx";
import { OrchSection, rowDivider } from "./parts.tsx";
import { territoryText } from "./staff-draft.ts";

/**
 * 一键扫岗：起一个会话读工作区，把它提的岗位摊在这里，人点了「采纳」才进名册。
 *
 * 为什么不扫完直接写：扫描是模型干的，它会看错、也会编。名册是派活的依据，
 * 一张编出来的领地会让活派进空气里，而且进了名册之后没人会再回头核对一遍——
 * 所以这里只呈现，不落盘。
 *
 * 结果走文件（`.deck/staff-scan.json`）而不是聊天：文件能校验、能重读、能被人
 * 改一句再采纳；扒聊天记录只能靠猜哪一段是 JSON。
 */

/** 轮询间隔：扫描读写一次仓库要几分钟，密了只是白跑。 */
const POLL_MS = 3_000;

/** 等这么久还没结果就停轮询：再等下去只是空转，留一颗「再读一次」给人自己决定。 */
const TIMEOUT_MS = 10 * 60_000;

function shortId(agentId: string): string {
  return agentId.length > 8 ? agentId.slice(0, 8) : agentId;
}

/** 读失败时把原话摆出来：轮询里吞掉错误，只会让人以为「还在扫」。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function StaffScan({
  skin,
  t,
  workspaceId,
  workspaceDir,
  lang,
  disabled,
  note,
  onAdopt,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  workspaceId: string;
  workspaceDir: string;
  /** 扫描简报用哪种语言写：界面是英文的人，不该收到一份中文提示词。 */
  lang: DeckLang;
  /** 名册正在写盘时不许再动：采纳与手填卡共用同一条写回路径。 */
  disabled: boolean;
  /** 上一次采纳的结果（加了几张、跳过几条）；没有就什么都不写。 */
  note?: string | null;
  /** 采纳这批候选；返回 true 表示已经写进名册。 */
  onAdopt(candidates: readonly StaffScanCandidate[]): Promise<boolean>;
}) {
  const startRpc = useRpc(staffScanStartRpc);
  const readRpc = useRpc(staffScanReadRpc);
  const queryClient = useQueryClient();

  const [agentId, setAgentId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<readonly string[]>([]);
  const startedAt = useRef<number | null>(null);

  const key = ["deck", "staff-scan", workspaceDir] as const;

  const read = useQuery({
    queryKey: key,
    queryFn: () => readRpc({ workspaceDir }),
    // 一进这一页就读一次：上次扫出来的候选可能还没采纳，切走再回来不该消失。
    enabled: Boolean(workspaceDir),
    staleTime: 0,
    retry: false,
    // 只有「正在扫」的时候才轮询；出结果就停，没在扫也不轮询。
    refetchInterval: (query) => {
      if (!scanning) return false;
      const data = query.state.data;
      if (data?.ok && (data.status === "ready" || data.status === "invalid")) return false;
      const began = startedAt.current;
      if (began !== null && Date.now() - began > TIMEOUT_MS) return false;
      return POLL_MS;
    },
  });

  const start = useMutation({
    mutationFn: () => startRpc({ workspaceId, workspaceDir, lang }),
    onSuccess: (result) => {
      if (!result.ok) {
        setStartError(result.detail);
        setScanning(false);
        return;
      }
      setStartError(null);
      setAdopted([]);
      setAgentId(result.agentId);
      setScanning(true);
      startedAt.current = Date.now();
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error: unknown) => {
      setStartError(error instanceof Error ? error.message : String(error));
      setScanning(false);
    },
  });

  const data = read.data;
  const ready = data?.ok === true && data.status === "ready";
  const invalid = data?.ok === true && data.status === "invalid";
  const timedOut = startedAt.current !== null && Date.now() - startedAt.current > TIMEOUT_MS;
  const pending = scanning && !ready && !invalid;

  const adopt = async (picked: readonly StaffScanCandidate[]) => {
    if (disabled || !picked.length) return;
    const keys = picked.map((candidate) => staffScanKeyOf(candidate));
    const done = await onAdopt(picked);
    if (done) setAdopted((current) => [...current, ...keys]);
  };

  const candidates = ready ? data.candidates : [];
  const open = candidates.filter((candidate) => !adopted.includes(staffScanKeyOf(candidate)));

  const styles = useMemo(
    () => ({
      row: { paddingVertical: 7, gap: 3 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      name: { flexShrink: 1, color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
      kind: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      spacer: { flex: 1 },
      duty: { color: skin.colors.ink, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      meta: { color: skin.colors.ink2, fontSize: 10, lineHeight: 15, fontFamily: skin.mono.fontFamily },
      /** 领地与名册卡同一种绿；行高阶不变，只换颜色。 */
      territory: { color: skin.colors.ok, fontSize: 10, lineHeight: 15, fontFamily: skin.mono.fontFamily },
      hint: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      warn: skin.error,
    }),
    [skin],
  );

  return (
    <OrchSection
      skin={skin}
      title={t("orch.scan")}
      aside={pending ? t("common.loading") : ready ? t("orch.scanCount", { n: candidates.length }) : undefined}
    >
      <Text style={styles.hint}>{t("orch.scanHint")}</Text>

      <View style={styles.actions}>
        <PixelButton
          skin={skin}
          mini
          variant={candidates.length ? "ghost" : "solid"}
          label={start.isPending ? t("orch.scanStarting") : candidates.length ? t("orch.scanAgain") : t("orch.scanStart")}
          disabled={disabled || start.isPending || pending}
          onPress={() => start.mutate()}
        />
        {pending ? (
          <PixelButton
            skin={skin}
            mini
            variant="ghost"
            label={t("orch.scanReadNow")}
            disabled={read.isFetching}
            onPress={() => void read.refetch()}
          />
        ) : null}
        {ready && open.length ? (
          <PixelButton
            skin={skin}
            mini
            variant="ghost"
            label={t("orch.scanAcceptAll", { n: open.length })}
            disabled={disabled}
            onPress={() => void adopt(open)}
          />
        ) : null}
      </View>

      {startError ? (
        <PixelBanner skin={skin}>
          <Text style={styles.warn}>{t("orch.scanFailed", { detail: startError })}</Text>
        </PixelBanner>
      ) : null}

      {pending ? (
        <Text style={styles.hint}>
          {agentId && !timedOut
            ? t("orch.scanRunning", { id: shortId(agentId) })
            : t("orch.scanTimeout")}
        </Text>
      ) : null}

      {pending && read.error ? (
        <Text style={styles.hint}>{errorText(read.error)}</Text>
      ) : null}

      {invalid ? (
        <PixelBanner skin={skin} tone="warning">
          <Text style={styles.warn}>{t("orch.scanInvalid", { detail: data?.ok ? (data.detail ?? "") : "" })}</Text>
        </PixelBanner>
      ) : null}

      {ready ? (
        <Text style={styles.hint}>
          {candidates.length ? t("orch.scanReady", { n: candidates.length }) : t("orch.scanEmpty")}
        </Text>
      ) : null}

      {note ? <Text style={styles.hint}>{note}</Text> : null}

      {candidates.map((candidate, index) => {
        const scanKey = staffScanKeyOf(candidate);
        const done = adopted.includes(scanKey);
        const territory = territoryText(candidate.paths, t("orch.scanWhole"));
        return (
          <View key={`${scanKey}#${index}`} style={[styles.row, rowDivider(skin, index === 0)]}>
            <View style={styles.head}>
              <Text style={styles.name} numberOfLines={1}>
                {candidate.name}
              </Text>
              <Text style={styles.kind}>
                {candidate.kind === "manager" ? t("orch.staffManager") : t("orch.staffWorker")}
              </Text>
              <View style={styles.spacer} />
              <PixelButton
                skin={skin}
                mini
                variant="ghost"
                label={done ? t("orch.scanAccepted") : t("orch.scanAccept")}
                disabled={disabled || done}
                onPress={() => void adopt([candidate])}
              />
            </View>
            {candidate.duty ? <Text style={styles.duty} numberOfLines={3}>{candidate.duty}</Text> : null}
            {territory ? (
              <Text style={styles.territory} numberOfLines={1}>
                {territory}
              </Text>
            ) : null}
            {candidate.evidence.length ? (
              <Text style={styles.meta} numberOfLines={2}>
                {`${t("orch.scanEvidence")}：${candidate.evidence.join("、")}`}
              </Text>
            ) : null}
          </View>
        );
      })}

      {data?.ok ? data.warnings.map((warning) => <Text key={warning} style={styles.hint}>{warning}</Text>) : null}
    </OrchSection>
  );
}
