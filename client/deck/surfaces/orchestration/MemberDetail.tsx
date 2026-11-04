import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { sessionHandoffReadRpc, sessionHandoffsListRpc, sessionLedgerRpc } from "../../../../shared/session-rpc.ts";
import { clockText } from "../../format.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { OrchSection } from "./parts.tsx";
import { clipLines, routeStatusKey, ticketsOfAgent, type RailRow } from "./rail-model.ts";

/**
 * 右栏里点开的那个人：他手上挂着什么票、他上次交了什么。
 *
 * 两块都读已有接口：
 * - 执行进度读工作票台账（`deck.session.ledger`，按工作区读、按会话筛）——
 *   台账只记「谁接过手、做到哪」，票面真相仍在 GitHub；
 * - 记忆读交接目录（`deck.session.handoffs.list` / `.read`，按会话读）——
 *   那就是他把活交回来时写的那份东西，不是我另外攒的摘要。
 *
 * 读不出来时说读不出来：空列表不能画成「他没有票」。
 */

/** 台账与交接都只在展开时读，且短时间不重读：这是「确认一下」，不是监视器。 */
const STALE_MS = 15_000;
/** 交接文档只露开头这么多行，超了就明说被截断了。 */
const MEMORY_LINES = 8;

export function MemberDetail({
  skin,
  t,
  workspaceDir,
  row,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  /** 群所在目录：台账按目录读，人属于这个群，就属于这个目录。 */
  workspaceDir: string;
  row: RailRow;
}) {
  const ledgerRpc = useRpc(sessionLedgerRpc);
  const handoffsRpc = useRpc(sessionHandoffsListRpc);
  const readHandoffRpc = useRpc(sessionHandoffReadRpc);
  const [openName, setOpenName] = useState<string | null>(null);

  const ledger = useQuery({
    queryKey: ["deck", "rail-ledger", workspaceDir],
    // `agentId: null` 是「按工作区读」的显式写法（见 `server/ledger.ts` 的作用域说明）。
    queryFn: () => ledgerRpc({ cwd: workspaceDir, agentId: null }),
    staleTime: STALE_MS,
    retry: false,
  });

  const handoffs = useQuery({
    queryKey: ["deck", "rail-handoffs", row.agentId],
    // 只有起了会话才有交接目录；`agentId: null` 会被读成工作区作用域，那不归这个人。
    queryFn: () => handoffsRpc({ agentId: row.agentId }),
    enabled: row.agentId !== null,
    staleTime: STALE_MS,
    retry: false,
  });

  const opened = useQuery({
    queryKey: ["deck", "rail-handoff", row.agentId, openName],
    queryFn: () => readHandoffRpc({ agentId: row.agentId, name: openName ?? "" }),
    enabled: row.agentId !== null && openName !== null,
    staleTime: 60_000,
    retry: false,
  });

  const styles = useMemo(
    () => ({
      hint: { color: skin.colors.ink2, fontSize: 10, lineHeight: 15, fontFamily: skin.mono.fontFamily },
      line: { color: skin.colors.ink, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      time: { color: skin.colors.ink2, fontSize: 10, fontFamily: skin.mono.fontFamily },
      file: { paddingVertical: 3, gap: 1 },
      doc: {
        color: skin.colors.ink2,
        fontSize: 10,
        lineHeight: 15,
        fontFamily: skin.mono.fontFamily,
        borderLeftWidth: 1,
        borderLeftColor: skin.colors.line,
        paddingLeft: 6,
      },
      error: { color: skin.colors.bad, fontSize: 10, lineHeight: 15, fontFamily: skin.mono.fontFamily },
    }),
    [skin],
  );

  const entries = ledger.data?.ok ? ledger.data.ledger.entries : [];
  const tickets = ticketsOfAgent(entries, row.agentId);
  let ledgerProblem: string | null = null;
  if (ledger.error) ledgerProblem = ledger.error.message;
  else if (ledger.data && !ledger.data.ok) ledgerProblem = ledger.data.detail;

  const files = handoffs.data?.ok ? handoffs.data.files : [];
  let memoryProblem: string | null = null;
  if (row.agentId === null) memoryProblem = null;
  else if (handoffs.error) memoryProblem = handoffs.error.message;
  else if (handoffs.data && !handoffs.data.ok) memoryProblem = handoffs.data.detail;

  const doc = opened.data?.ok ? clipLines(opened.data.markdown, MEMORY_LINES) : null;

  return (
    <View style={{ gap: 8 }}>
      <OrchSection skin={skin} title={t("group.rail.progress")}>
        {row.agentId === null ? <Text style={styles.hint}>{t("group.rail.noSession")}</Text> : null}
        {ledger.isPending && row.agentId !== null ? <Text style={styles.hint}>{t("common.loading")}</Text> : null}
        {ledgerProblem ? <Text style={styles.error}>{t("group.rail.progressFailed", { detail: ledgerProblem })}</Text> : null}
        {row.agentId !== null && !ledgerProblem && !ledger.isPending && tickets.length === 0 ? (
          <Text style={styles.hint}>{t("group.rail.progressEmpty")}</Text>
        ) : null}
        {tickets.map((ticket) => (
          <Text key={ticket.ticketKey} style={styles.line} numberOfLines={2}>
            {`#${ticket.number} ${ticket.title} · ${t(routeStatusKey(ticket.status))}`}
          </Text>
        ))}
      </OrchSection>

      <OrchSection skin={skin} title={t("group.rail.memory")}>
        {row.agentId === null ? <Text style={styles.hint}>{t("group.rail.memoryNoSession")}</Text> : null}
        {row.agentId !== null && handoffs.isPending ? <Text style={styles.hint}>{t("common.loading")}</Text> : null}
        {memoryProblem ? <Text style={styles.error}>{t("group.rail.memoryFailed", { detail: memoryProblem })}</Text> : null}
        {row.agentId !== null && !memoryProblem && !handoffs.isPending && files.length === 0 ? (
          <Text style={styles.hint}>{t("group.rail.memoryEmpty")}</Text>
        ) : null}
        {files.map((file) => (
          <Pressable
            key={file.name}
            accessibilityRole="button"
            accessibilityLabel={t("group.rail.memoryOpen", { name: file.name })}
            accessibilityState={{ expanded: openName === file.name }}
            onPress={() => setOpenName(openName === file.name ? null : file.name)}
            style={styles.file}
          >
            <Text style={styles.line} numberOfLines={1}>{file.name}</Text>
            <Text style={styles.time}>{clockText(file.modifiedAt)}</Text>
          </Pressable>
        ))}
        {opened.isPending && openName !== null ? <Text style={styles.hint}>{t("group.rail.memoryReading")}</Text> : null}
        {opened.data && !opened.data.ok ? (
          <Text style={styles.error}>{t("group.rail.memoryReadFailed", { detail: opened.data.detail })}</Text>
        ) : null}
        {doc ? (
          <>
            <Text style={styles.doc}>{doc.text}</Text>
            {doc.clipped ? <Text style={styles.hint}>{t("group.rail.memoryClipped", { n: MEMORY_LINES })}</Text> : null}
          </>
        ) : null}
      </OrchSection>
    </View>
  );
}
