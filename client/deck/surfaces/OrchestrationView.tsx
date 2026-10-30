import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  orchestrationProfileRpc,
  orchestrationProviderDiagnosticRpc,
  orchestrationProviderInstallRpc,
  orchestrationProviderModelsRpc,
  orchestrationProviderRevealRpc,
  orchestrationProviderRpc,
  orchestrationSaveRpc,
  orchestrationSiteRpc,
  orchestrationStateRpc,
} from "../../../shared/orchestration-rpc.ts";
import { usePanelText, type PanelKey } from "../panel/panelText.tsx";
import { PixelBanner, PixelButton, PixelScreen, usePixel } from "../pixel.tsx";
import type { SessionNavigation } from "../session/SessionSheet.tsx";
import { useDeckWorkspaceAgents } from "./host.tsx";
import type { AgentInfo } from "./registry.ts";
import { ClientsPanel } from "./orchestration/ClientsPanel.tsx";
import { ProfilesPanel } from "./orchestration/ProfilesPanel.tsx";
import { RolesPanel } from "./orchestration/RolesPanel.tsx";
import { RoutingPanel } from "./orchestration/RoutingPanel.tsx";
import { TreePanel } from "./orchestration/TreePanel.tsx";
import {
  withMapBudget,
  withRoles,
  withRoute,
  type ClientProfile,
  type ClientTarget,
  type Difficulty,
  type OrchestrationSettings,
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

type Section = "roles" | "clients" | "profiles" | "routing" | "tree";

const SECTIONS: { key: Section; label: PanelKey }[] = [
  { key: "roles", label: "orch.section.roles" },
  { key: "clients", label: "orch.section.clients" },
  { key: "profiles", label: "orch.section.profiles" },
  { key: "routing", label: "orch.section.routing" },
  { key: "tree", label: "orch.section.tree" },
];

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
  const { t } = usePanelText();
  const skin = usePixel(theme);
  const toast = useToast();
  const [section, setSection] = useState<Section>("roles");

  const stateRpc = useRpc(orchestrationStateRpc);
  const saveRpc = useRpc(orchestrationSaveRpc);
  const providerRpc = useRpc(orchestrationProviderRpc);
  const profileRpc = useRpc(orchestrationProfileRpc);
  const installRpc = useRpc(orchestrationProviderInstallRpc);
  const diagnosticRpc = useRpc(orchestrationProviderDiagnosticRpc);
  const revealRpc = useRpc(orchestrationProviderRevealRpc);
  const modelsRpc = useRpc(orchestrationProviderModelsRpc);
  const siteRpc = useRpc(orchestrationSiteRpc);

  const agents = useDeckWorkspaceAgents(workspaceId, workspaceDir);

  const state = useQuery({
    queryKey: ["deck", "orchestration", workspaceId, workspaceDir],
    queryFn: () => stateRpc({ workspaceId, workspaceDir }),
    enabled: Boolean(workspaceId && workspaceDir),
    staleTime: 15_000,
    retry: false,
  });

  const data = state.data && state.data.ok ? state.data : null;

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

  const applySettings = (update: (current: OrchestrationSettings) => OrchestrationSettings) => {
    pendingSaves.current += 1;
    setSaving(true);
    const run = saveQueue.current.then(async () => {
      const fresh = await stateRpc({ workspaceId, workspaceDir });
      if (!fresh.ok) {
        toast.error(`${fresh.reason}：${fresh.detail}`);
        return;
      }
      const result = await saveRpc({ workspaceId, workspaceDir, settings: update(fresh.settings) });
      if (!result.ok) {
        toast.error(result.detail);
        return;
      }
      for (const warning of result.warnings) toast.show(warning, { variant: "warning" });
      toast.show(t("orch.saved"), { variant: "success" });
    });
    saveQueue.current = run.catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
    void saveQueue.current.then(async () => {
      pendingSaves.current = Math.max(pendingSaves.current - 1, 0);
      // 等刷新回来再解除忙碌：否则按钮在「旧 settings 还在界面上」的那一小段里又能点，
      // 连点两下仍然按同一份旧值算，这个护栏就等于没上。
      await state.refetch();
      if (pendingSaves.current === 0) setSaving(false);
    });
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

  const limits = (patch: { maxDepth?: number; maxChildrenPerDispatch?: number; reportOnFinish?: boolean }) =>
    applySettings((current) => ({ ...current, ...patch }));
  const roles = (patch: { mainAgentId?: string | null; dispatcherAgentId?: string | null }) =>
    applySettings((current) => withRoles(current, workspaceId, patch));
  const route = (difficulty: Difficulty, rule: { profileId?: string; target?: ClientTarget } | null) =>
    applySettings((current) => withRoute(current, difficulty, rule));
  const mapBudget = (map: string, concurrency: number | null) =>
    applySettings((current) => withMapBudget(current, map, concurrency));

  const styles = useMemo(
    () => ({
      screen: { padding: layout.compact ? 8 : 10, gap: 8 },
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, flexWrap: "wrap" as const },
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
      <View style={styles.toolbar}>
        {SECTIONS.map((item) => (
          <PixelButton
            key={item.key}
            skin={skin}
            variant="tab"
            label={t(item.label)}
            active={section === item.key}
            onPress={() => setSection(item.key)}
          />
        ))}
        <View style={{ flex: 1 }} />
        <PixelButton
          skin={skin}
          mini
          variant="ghost"
          label={state.isFetching ? t("common.refreshing") : t("common.refresh")}
          onPress={() => void state.refetch()}
        />
      </View>

      {state.error ? (
        <PixelBanner skin={skin}>
          <Text style={styles.error}>{state.error.message}</Text>
        </PixelBanner>
      ) : null}
      {state.data && !state.data.ok ? (
        <PixelBanner skin={skin}>
          <Text style={styles.error}>
            {state.data.reason}：{state.data.detail}
          </Text>
        </PixelBanner>
      ) : null}
      {data?.warnings.length ? (
        <View style={styles.noticeBlock}>
          {data.warnings.map((warning) => (
            <Text key={warning} style={styles.noticeLine}>
              {warning}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.content}>
        {!data || !settings ? (
          <Text style={styles.notice}>{state.isPending ? t("common.loading") : t("orch.empty")}</Text>
        ) : section === "roles" ? (
          <RolesPanel
            skin={skin}
            t={t}
            workspaceId={workspaceId}
            settings={settings}
            agents={agents}
            busy={busy}
            onPatch={roles}
            onLimits={limits}
            onMapBudget={mapBudget}
            {...(navigation ? { onOpen: openAgent } : {})}
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

      {/* 角色页的计数器已经在说明层数与单次上限，底栏再写一遍只是噪音。 */}
      {section === "roles" ? null : (
        <View style={styles.footer}>
          <Text style={styles.meta}>{t("orch.footer", { depth: settings?.maxDepth ?? 0, children: settings?.maxChildrenPerDispatch ?? 0 })}</Text>
        </View>
      )}
    </PixelScreen>
  );
}
