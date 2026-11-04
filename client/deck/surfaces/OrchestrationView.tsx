import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  orchestrationArchivedRpc,
  orchestrationProfileRpc,
  type ArchivedAgentRow,
  orchestrationProviderDiagnosticRpc,
  orchestrationProviderInstallRpc,
  orchestrationProviderModelsRpc,
  orchestrationProviderRefreshRpc,
  orchestrationProviderRevealRpc,
  orchestrationProviderRpc,
  orchestrationSaveRpc,
  orchestrationSiteRpc,
  orchestrationStaffStopRpc,
  orchestrationStateRpc,
  orchestrationWindowRpc,
} from "../../../shared/orchestration-rpc.ts";
import type { FixedRole } from "../../../shared/orchestration.ts";
import { MAX_STAFF_CARDS, rosterOf, withDirectoryRoster } from "../../../shared/staff.ts";
import type { DeckLang } from "../../../shared/requirement.ts";
import { usePanelText } from "../panel/panelText.tsx";
import { PixelBanner, PixelButton, PixelScreen, usePixel } from "../pixel.tsx";
import type { SessionNavigation } from "../session/SessionSheet.tsx";
import { useDeckWorkspaceAgents } from "./host.tsx";
import type { AgentInfo } from "./registry.ts";
import { ArchivedPanel } from "./orchestration/ArchivedPanel.tsx";
import { OrchNav } from "./orchestration/OrchNav.tsx";
import { DEFAULT_SECTION, sectionLabel, type OrchestrationSection } from "./orchestration/nav.ts";
import { GroupPanel } from "./orchestration/GroupPanel.tsx";
import { InboxPanel } from "./orchestration/InboxPanel.tsx";
import { mergeArchivedRows } from "./orchestration/archivedFilter.ts";
import { ClientsPanel } from "./orchestration/ClientsPanel.tsx";
import { DispatchPanel } from "./orchestration/DispatchPanel.tsx";
import { ProfilesPanel } from "./orchestration/ProfilesPanel.tsx";
import { RolesPanel } from "./orchestration/RolesPanel.tsx";
import type { StaffStopOutcome } from "./orchestration/StopSection.tsx";
import { RoutingPanel } from "./orchestration/RoutingPanel.tsx";
import { StaffPanel } from "./orchestration/StaffPanel.tsx";
import { TreePanel } from "./orchestration/TreePanel.tsx";
import {
  withMapBudget,
  withRoles,
  withRoute,
  type ClientProfile,
  type ClientTarget,
  type Difficulty,
  type LimitsPatch,
  type OrchestrationSettings,
  type RolesPatch,
  type StaffMutation,
} from "./orchestration/types.ts";

/**
 * 编排页：角色 / 注入 / 档案 / 路由 / 会话树。
 *
 * 一个工作区一套编排，落在 `.deck/orchestration.json`：谁讨论、谁派单、
 * 每档难度用哪个客户端与模型、派出去的子会话怎么往回传。
 *
 * 数据每次现取：宿主配置可能在别处被改（用户也可能直接编辑 config.json），
 * 存一份快照在客户端，下一次打开就变成了「界面说的和宿主不一样」。
 * 每个改动都是「读当前设置 → 不可变地换一项 → 整份写回」，不做局部补丁。
 */

/** 页签与分组在 `nav.ts`：那里是纯数据，能单测「每一页都恰好出现一次」。 */
type Section = OrchestrationSection;

/** 编排页两份查询共用的新鲜期：宿主配置与归档清单都不值得每条都重读。 */
const STALE_MS = 15_000;

export function OrchestrationView({
  theme,
  layout,
  workspaceId,
  workspaceDir,
  navigation,
}: {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceId: string;
  workspaceDir: string;
  /** 宿主的切窗能力。旧宿主没有，此时角色照样能设，只是点了不跳过去。 */
  navigation?: SessionNavigation;
}) {
  const { t, zh } = usePanelText();
  const lang: DeckLang = zh ? "zh" : "en";
  const skin = usePixel(theme);
  const toast = useToast();
  const [section, setSection] = useState<Section>(DEFAULT_SECTION);
  /** 这三页读的是自己的 RPC，不依赖编排设置：顶栏的刷新与状态报错都不该出现在它们上面。 */
  const ownsItsQuery = section === "archived" || section === "group" || section === "inbox";

  const stateRpc = useRpc(orchestrationStateRpc);
  const archivedRpc = useRpc(orchestrationArchivedRpc);
  const saveRpc = useRpc(orchestrationSaveRpc);
  const windowRpc = useRpc(orchestrationWindowRpc);
  const providerRpc = useRpc(orchestrationProviderRpc);
  const profileRpc = useRpc(orchestrationProfileRpc);
  const installRpc = useRpc(orchestrationProviderInstallRpc);
  const diagnosticRpc = useRpc(orchestrationProviderDiagnosticRpc);
  const revealRpc = useRpc(orchestrationProviderRevealRpc);
  const modelsRpc = useRpc(orchestrationProviderModelsRpc);
  const refreshCatalogRpc = useRpc(orchestrationProviderRefreshRpc);
  const siteRpc = useRpc(orchestrationSiteRpc);
  const stopRpc = useRpc(orchestrationStaffStopRpc);

  const agents = useDeckWorkspaceAgents(workspaceId, workspaceDir);

  const state = useQuery({
    queryKey: ["deck", "orchestration", workspaceId, workspaceDir],
    queryFn: () => stateRpc({ workspaceId, workspaceDir }),
    enabled: Boolean(workspaceId && workspaceDir),
    staleTime: STALE_MS,
    retry: false,
  });

  const data = state.data && state.data.ok ? state.data : null;

  /**
   * 已归档清单只在打开那个页签时才取：它要翻宿主的存档（`includeArchived`），
   * 比状态那一份重，没必要每次进编排页都拉一遍。
   */
  const archived = useQuery({
    queryKey: ["deck", "orchestration", "archived", workspaceId, workspaceDir],
    queryFn: () => archivedRpc({ workspaceId, workspaceDir }),
    enabled: section === "archived" && Boolean(workspaceId && workspaceDir),
    staleTime: STALE_MS,
    retry: false,
  });

  /**
   * 往更早读的那几批。
   *
   * 宿主的归档是跨全部工作区的：本工作区的记录可能排在 1000 条之后，单次调用
   * 翻不到底。`older` 存的是用户在「读取更早的」之后追加的批，跟着第一次那份
   * 一起显示；`older` 为 null 表示「还没往后读」，此时游标才用首屏那一份的。
   */
  const [older, setOlder] = useState<{
    rows: ArchivedAgentRow[];
    nextCursor: string | null;
    /** 最后一趟读回来的截断状态与警告：它们说的是「这次读到哪」，不能拿首屏那份顶。 */
    truncated: boolean;
    warnings: string[];
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  /**
   * 当前看的是哪个工作区。
   *
   * 「读取更早的」是一次跨宿主翻页的异步请求：等它回来时用户可能已经切了工作区，
   * 那批行（连同命令里的 `--cwd`）属于上一个工作区，接进新清单就是错的。所以请求
   * 回来先比一次，不一致就整批丢掉。
   */
  const scopeKey = `${workspaceId}\u0000${workspaceDir}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  // 换工作区时，已经追加的旧批必须丢掉：留着就成了上一份清单的残影。
  useEffect(() => {
    setOlder(null);
  }, [scopeKey]);

  /** 成功的那一份才算数：失败分支没有 rows / warnings，别在渲染处反复判三次。 */
  const archivedView = archived.data?.ok ? archived.data : null;
  const archivedRows = older
    ? mergeArchivedRows(archivedView?.rows ?? [], older.rows)
    : (archivedView?.rows ?? []);
  const archivedCursor = older ? older.nextCursor : (archivedView?.nextCursor ?? null);

  /**
   * 失败只说 `detail`：`invalid-workspace` / `agents-failed` 是给代码看的机器码，
   * 印给用户看的只有那句人话。传输层异常本身可能就是一句宿主内部报错，也不原样摆上来。
   */
  let archivedError: string | null = null;
  if (archived.data && !archived.data.ok) archivedError = archived.data.detail;
  else if (!archived.data && archived.error) archivedError = t("orch.archived.failed");

  const loadOlder = async () => {
    if (!archivedCursor || loadingOlder) return;
    const startedIn = scopeRef.current;
    setLoadingOlder(true);
    try {
      const result = await archivedRpc({ workspaceId, workspaceDir, cursor: archivedCursor });
      // 走完一趟回来已经换了工作区：这批行属于上一个工作区，不能接进来。
      if (scopeRef.current !== startedIn) return;
      if (!result.ok) {
        toast.error(result.detail);
        return;
      }
      setOlder((previous) => ({
        rows: mergeArchivedRows(previous?.rows ?? [], result.rows),
        nextCursor: result.nextCursor,
        truncated: result.truncated,
        warnings: result.warnings,
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingOlder(false);
    }
  };

  /** 重新读首屏：追加的旧批一起清掉，否则「刷新」之后新旧两批会混着显示。 */
  const reloadArchived = () => {
    setOlder(null);
    void archived.refetch();
  };

  const copyArchived = (text: string) => {
    void copyText(text).then(
      () => toast.show(t("orch.archived.copied"), { variant: "success" }),
      () => toast.error(t("orch.archived.copyFailed")),
    );
  };

  /**
   * 设置是「整份写回」，所以两次改动之间必须先读一次新的：
   * 若拿界面上那份快照去算，连点两下（改 A 再改 B）会把 A 覆盖回旧值。
   * 这里把改动排队，每次落盘前现读一次宿主状态，再把改动叠在最新那份上。
   */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);
  const [saving, setSaving] = useState(false);

  /**
   * 点一个会话：先把它设成角色，再切过去。
   *
   * 只设不跳是上一版的行为——用户点了「主沟通窗口」里的某个会话，
   * 看到的是名字变了、窗口却没动，会以为没生效。
   * 跨工作区的会话要先切工作区：只调 `openAgent` 时当前工作区里没这个 id，聊天不会切过去。
   */
  const openAgent = (agent: AgentInfo) => {
    if (!navigation) return;
    try {
      if (agent.workspaceId && agent.workspaceId !== workspaceId) {
        navigation.openWorkspace?.({ workspaceId: agent.workspaceId });
      }
      navigation.openAgent({ agentId: agent.id });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const applySettings = (update: (current: OrchestrationSettings) => OrchestrationSettings): Promise<boolean> => {
    pendingSaves.current += 1;
    setSaving(true);
    const run = saveQueue.current.then(async (): Promise<boolean> => {
      try {
        const fresh = await stateRpc({ workspaceId, workspaceDir });
        if (!fresh.ok) {
          toast.error(`${fresh.reason}：${fresh.detail}`);
          return false;
        }
        const result = await saveRpc({ workspaceId, workspaceDir, settings: update(fresh.settings) });
        if (!result.ok) {
          toast.error(result.detail);
          return false;
        }
        for (const warning of result.warnings) toast.show(warning, { variant: "warning" });
        toast.show(t("orch.saved"), { variant: "success" });
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    });
    const settled = run.then(async (ok) => {
      pendingSaves.current = Math.max(pendingSaves.current - 1, 0);
      // 等刷新回来再解除忙碌：否则按钮在「旧 settings 还在界面上」的那一小段里又能点，
      // 连点两下仍然按同一份旧值算，这个护栏就等于没上。
      try {
        await state.refetch();
      } catch {
        // 保存已经成功：重取失败只让这一屏的数字旧一会儿，下一次刷新会补上。
      }
      if (pendingSaves.current === 0) setSaving(false);
      return ok;
    });
    // 队列只等「上一单结束」，不把错误往下传；调用方自己看返回值决定是否收起草稿。
    saveQueue.current = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  };

  /**
   * 建/重建一个固定窗口。
   *
   * 窗口由服务端用该角色的身份提示词创建，并把新会话写回槽位；这里只负责
   * 把失败原因说清楚、成功后重取设置与角色。不另做一次 `onPatch`：
   * 服务端已经写回了，客户端再写一遍就成了两个来源。
   */
  const buildWindow = async (role: FixedRole, recreate: boolean): Promise<void> => {
    try {
      const result = await windowRpc({
        workspaceDir,
        workspaceId,
        role,
        ...(recreate ? { recreate: true } : {}),
        lang,
      });
      if (!result.ok) {
        // `detail` 已经写清是哪一步失败；不再把 `create-failed` 这类机器码印给用户。
        toast.error(result.detail);
        return;
      }
      toast.show(t("orch.windowBuilt", { title: result.title }), { variant: "success" });
      await state.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * 阀门四：全停。
   *
   * 结果就地显示在面板里（面板自己管「待确认 / 已停」两种状态），这里只负责调 RPC、
   * 把失败说清楚、停完把状态重读一次——停手会改会话存活情况，名册与树都跟着变。
   */
  const stopStaff = async ({ archive }: { archive: boolean }): Promise<StaffStopOutcome> => {
    try {
      const result = await stopRpc({ workspaceId, workspaceDir, ...(archive ? { archive: true } : {}) });
      if (!result.ok) return { ok: false, detail: result.detail };
      void state.refetch();
      return {
        ok: true,
        stopped: result.stopped,
        denied: result.denied,
        interrupted: result.interrupted,
        archived: result.archived,
        failures: result.failures,
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  };

  const patchProvider = useMutation({
    mutationFn: (input: { provider: string; env?: Record<string, string>; models?: string[]; label?: string }) =>
      providerRpc({
        provider: input.provider,
        ...(input.env ? { env: input.env } : {}),
        ...(input.models ? { models: input.models } : {}),
        ...(input.label ? { label: input.label } : {}),
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.detail);
        return;
      }
      for (const warning of result.warnings) toast.show(warning, { variant: "warning" });
      toast.show(t("orch.saved"), { variant: "success" });
      void state.refetch();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const patchProfile = useMutation({
    mutationFn: (input: { profile?: ClientProfile; removeId?: string }) => profileRpc(input),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.detail);
        return;
      }
      void state.refetch();
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const settings = data?.settings ?? null;
  const busy = saving;

  const limits = (patch: LimitsPatch) => applySettings((current) => ({ ...current, ...patch }));
  const roles = (patch: RolesPatch) => applySettings((current) => withRoles(current, workspaceId, patch));
  const staff = (mutate: StaffMutation) =>
    applySettings((current) => {
      const next = mutate(rosterOf(current));
      if (next.length > MAX_STAFF_CARDS) {
        // 另一个窗口刚把名册加满：归一化会把多出来的卡悄悄截掉，所以在这里明确拒绝，
        // 让 `applySettings` 返回 false、表单草稿留着。
        throw new Error(t("orch.staffFull", { max: MAX_STAFF_CARDS }));
      }
      return withDirectoryRoster(current, workspaceId, next);
    });
  const route = (difficulty: Difficulty, rule: { profileId?: string; target?: ClientTarget } | null) =>
    applySettings((current) => withRoute(current, difficulty, rule));
  const mapBudget = (map: string, concurrency: number | null) =>
    applySettings((current) => withMapBudget(current, map, concurrency));

  const styles = useMemo(
    () => ({
      screen: { padding: layout.compact ? 8 : 10, gap: 8 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, flexWrap: "wrap" as const },
      title: {
        color: skin.colors.ink,
        fontSize: 13,
        fontWeight: "700" as const,
        fontFamily: skin.mono.fontFamily,
      },
      /** 左栏 + 正文：宽屏并排，窄屏上下（左栏在 `OrchNav` 里自己折成一行页签）。 */
      body: {
        flex: 1,
        flexDirection: layout.compact ? ("column" as const) : ("row" as const),
        gap: layout.compact ? 6 : 10,
      },
      pane: { flex: 1, gap: 8, minHeight: 0 },
      /** 正文与左栏之间只画一条线：两块同属一页，不需要各套一个框。 */
      paneEdge: layout.compact
        ? { borderTopWidth: 1, borderTopColor: skin.colors.line, paddingTop: 6 }
        : { borderLeftWidth: 1, borderLeftColor: skin.colors.line, paddingLeft: 10 },
      notice: skin.hint,
      /** 提醒不各占一行散在顶上：一道竖线把它们收成一块，正文让位给真正要操作的东西。 */
      noticeBlock: { borderLeftWidth: 1, borderLeftColor: skin.colors.warn, paddingLeft: 8, gap: 2 },
      noticeLine: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      error: skin.error,
      content: { flex: 1 },
      footer: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
    }),
    [skin, layout.compact],
  );

  if (!workspaceDir) {
    return (
      <PixelScreen skin={skin} style={styles.screen}>
        <Text style={styles.notice}>{t("common.noWorkspace")}</Text>
      </PixelScreen>
    );
  }

  return (
    <PixelScreen skin={skin} style={styles.screen}>
      {/* 顶栏只留「现在在哪一页」与刷新：页签本身在左栏，顶栏再排一遍等于两份导航。 */}
      <View style={styles.toolbar}>
        <Text style={styles.title} numberOfLines={1}>
          {t(sectionLabel(section))}
        </Text>
        <View style={{ flex: 1 }} />
        {/* 已归档、群、收件箱各自读另一份数据、各自带刷新，顶栏这颗在那几页会变成第二颗空按钮。 */}
        {ownsItsQuery ? null : (
          <PixelButton
            skin={skin}
            mini
            variant="ghost"
            label={state.isFetching ? t("common.refreshing") : t("common.refresh")}
            onPress={() => void state.refetch()}
          />
        )}
      </View>

      <View style={styles.body}>
        <OrchNav skin={skin} t={t} section={section} compact={layout.compact} onPick={setSection} />
        <View style={[styles.pane, styles.paneEdge]}>
          {/* 群读的是自己的 RPC：编排状态读不到时，不该在群页顶上来一条无关的报错。 */}
          {!ownsItsQuery && state.error ? (
            <PixelBanner skin={skin}>
              <Text style={styles.error}>{state.error.message}</Text>
            </PixelBanner>
          ) : null}
          {!ownsItsQuery && state.data && !state.data.ok ? (
            <PixelBanner skin={skin}>
              <Text style={styles.error}>
                {state.data.reason}：{state.data.detail}
              </Text>
            </PixelBanner>
          ) : null}
          {!ownsItsQuery && data?.warnings.length ? (
            <View style={styles.noticeBlock}>
              {data.warnings.map((warning) => (
                <Text key={warning} style={styles.noticeLine}>
                  {warning}
                </Text>
              ))}
            </View>
          ) : null}

          <View style={styles.content}>
            {section === "archived" ? (
              <ArchivedPanel
                skin={skin}
                t={t}
                rows={archivedRows}
                // 往后读过了就以最后一趟为准：首屏那句「可以继续往前」在读到末批后已经过期。
                truncated={older ? older.truncated : (archivedView?.truncated ?? false)}
                warnings={older ? older.warnings : (archivedView?.warnings ?? [])}
                loading={archived.isFetching}
                error={archivedError}
                hasOlder={archivedCursor !== null}
                loadingOlder={loadingOlder}
                onLoadOlder={() => void loadOlder()}
                onReload={reloadArchived}
                onCopy={copyArchived}
              />
            ) : section === "group" ? (
              // 群读的是自己的 RPC，不依赖编排设置：编排数据读不到时也能进群。
              <GroupPanel
                skin={skin}
                t={t}
                lang={lang}
                workspaceId={workspaceId}
                workspaceDir={workspaceDir}
                large={!layout.compact}
                onOpenStaff={() => setSection("staff")}
              />
            ) : section === "inbox" ? (
              // 收件箱同样读自己的 RPC：越界请求与编排设置无关。
              <InboxPanel theme={theme} workspaceId={workspaceId} workspaceDir={workspaceDir} />
            ) : !data || !settings ? (
              <Text style={styles.notice}>{state.isPending ? t("common.loading") : t("orch.empty")}</Text>
            ) : section === "roles" ? (
              <RolesPanel
                skin={skin}
                t={t}
                lang={lang}
                workspaceId={workspaceId}
                settings={settings}
                agents={agents}
                knownAgentIds={data.agents.map((agent) => agent.agentId)}
                busy={busy}
                onPatch={roles}
                onBuildWindow={buildWindow}
                onLimits={limits}
                onMapBudget={mapBudget}
                onStop={stopStaff}
                {...(navigation ? { onOpen: openAgent } : {})}
              />
            ) : section === "staff" ? (
              <StaffPanel
                skin={skin}
                t={t}
                workspaceId={workspaceId}
                workspaceDir={workspaceDir}
                lang={lang}
                cards={rosterOf(settings)}
                profiles={data.profiles}
                busy={busy}
                onSave={staff}
              />
            ) : section === "dispatch" ? (
              <DispatchPanel
                skin={skin}
                t={t}
                lang={lang}
                workspaceId={workspaceId}
                workspaceDir={workspaceDir}
                cards={rosterOf(settings)}
              />
            ) : section === "clients" ? (
              <ClientsPanel
                skin={skin}
                t={t}
                providers={data.providers}
                busy={patchProvider.isPending}
                onSaveEnv={(input) => patchProvider.mutate(input)}
                onSaveModel={(input) => patchProvider.mutate(input)}
                onSaveLabel={(input) => patchProvider.mutate(input)}
                onDiagnose={async (provider) => {
                  try {
                    const result = await diagnosticRpc({ provider });
                    return result;
                  } catch (error) {
                    return { ok: false as const, detail: error instanceof Error ? error.message : String(error) };
                  }
                }}
                onReveal={async (provider, key) => {
                  try {
                    const result = await revealRpc({ provider, key });
                    return result.ok ? { ok: true as const, value: result.value } : { ok: false as const, detail: result.detail };
                  } catch (error) {
                    return { ok: false as const, detail: error instanceof Error ? error.message : String(error) };
                  }
                }}
                onInstall={async (provider) => {
                  try {
                    const result = await installRpc({ provider });
                    // 装完之后宿主要重新解析命令：只有重取状态，界面上的「未安装」才会变成「可用」。
                    if (result.ok) void state.refetch();
                    return result;
                  } catch (error) {
                    return { ok: false as const, detail: error instanceof Error ? error.message : String(error) };
                  }
                }}
                onSaveSite={async (input) => {
                  try {
                    const result = await siteRpc(input);
                    if (!result.ok) return { ok: false as const, detail: result.detail };
                    for (const warning of result.warnings) toast.show(warning, { variant: "warning" });
                    // 站点表与「现在生效的是哪条」都是服务端读盘 + 读宿主配置算出来的：重取一次。
                    await state.refetch();
                    return { ok: true as const };
                  } catch (error) {
                    return { ok: false as const, detail: error instanceof Error ? error.message : String(error) };
                  }
                }}
                onFetchModels={async (provider) => {
                  try {
                    const result = await modelsRpc({ provider });
                    return result.ok
                      ? { ok: true as const, endpoint: result.endpoint, models: result.models }
                      : { ok: false as const, detail: result.detail };
                  } catch (error) {
                    return { ok: false as const, detail: error instanceof Error ? error.message : String(error) };
                  }
                }}
                onRefreshCatalog={async () => {
                  try {
                    const result = await refreshCatalogRpc({ workspaceDir });
                    if (!result.ok) return { ok: false as const, detail: result.detail };
                    // 刷新后宿主的快照变了：本页的模型计数也重取一次，两处说的是同一份目录。
                    // 不 await：重取失败是「本页数字旧了」，不能把已经成功的刷新报成失败。
                    // 警告由客户端面板就地显示（带警告色），不再另弹一层 toast。
                    void state.refetch();
                    return result;
                  } catch (error) {
                    return { ok: false as const, detail: error instanceof Error ? error.message : String(error) };
                  }
                }}
              />
            ) : section === "profiles" ? (
              <ProfilesPanel
                skin={skin}
                t={t}
                profiles={data.profiles}
                providers={data.providers}
                busy={patchProfile.isPending}
                onSave={(profile) => patchProfile.mutate({ profile })}
                onRemove={(removeId) => patchProfile.mutate({ removeId })}
              />
            ) : section === "routing" ? (
              <RoutingPanel
                skin={skin}
                t={t}
                routing={data.routing}
                profiles={data.profiles}
                providers={data.providers}
                busy={busy}
                onPatch={route}
              />
            ) : (
              <TreePanel skin={skin} t={t} tree={data.tree} />
            )}
          </View>
        </View>
      </View>

      {/* 角色页的计数器已经在说明层数与单次上限，底栏再写一遍只是噪音；已归档与群与派单无关。 */}
      {section === "roles" || ownsItsQuery ? null : (
        <View style={styles.footer}>
          <Text style={styles.meta}>{t("orch.footer", { depth: settings?.maxDepth ?? 0, children: settings?.maxChildrenPerDispatch ?? 0 })}</Text>
        </View>
      )}
    </PixelScreen>
  );
}
