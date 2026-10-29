import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  CHECK_CATALOG,
  catalogFor,
  guideProgress,
  type CheckAction,
  type CheckField,
  type CheckItem,
  type CheckResult,
} from "../../../shared/checks";
import { checksRunRpc } from "../../../shared/checks-rpc";
import { authStatusRpc } from "../../../shared/auth";
import { publishRunRpc } from "../../../shared/publish-rpc";
import { deckSettings } from "../../../shared/settings";
import { skillsInstallRpc, skillsListRpc } from "../../../shared/skills";
import { GithubAuthModal } from "../GithubAuthModal";
import { PixelBanner, PixelButton, PixelCard, PixelHead, PixelStatusLine, usePixel } from "../pixel";
import { SessionSheet } from "../session/SessionSheet.tsx";
import type { SessionNavigation } from "../session/SessionSheet.tsx";
import { useDeckWorkspaceProvider } from "../surfaces/host.tsx";
import { CheckActionModal, type WizardStepSpec } from "./CheckActionModal";
import {
  checkGuidePromptOf,
  ensureLabelsPromptOf,
  installSkillsPromptOf,
  setupPromptOf,
  type BackendId,
  type DeckLang,
  type SetupLayout,
} from "./checksPrompts";
import { usePanelText, type PanelKey, type PanelTextFn } from "./panelText";

/**
 * 检查页签。
 *
 * 数据来自 `deck.checks.run`：服务端一次跑完目录里的全部谓词，并把结果交给六步引导
 * 状态机；界面只渲染结果、按 `group` 分组、按 `action` 分发，不自己探测、不改判据。
 *
 * 动作分发（与 DSH 同一个动作词汇表）：
 * - `refresh` → 重新求值；
 * - `open-url` → 系统浏览器；
 * - `rpc deck.auth.start` → 面板里的 GitHub 登录弹窗；
 * - `inject-prompt`：
 *   - `installSkills` → 插件自带的技能安装器（比注入提示词更直接）；
 *   - `cliInstall` / `ghAuthLogin` / `glabAuthLogin` → SessionSheet 把 DSH 原文填进会话输入框；
 *   - `setupRun` → 先问域文档布局（DSH 的 setup-layout 卡），再填入 v15 初始化原文；
 *   - `ensureLabels` → SessionSheet 填入按 STANDARD_LABELS 现拼的补全原文；
 * - `wizard publish` → DSH 的两步建仓向导（仓库名 → 可见性），提交走 `deck.publish.run`；
 * - `wizard backend-picker` → 选择后端并写进设置，然后重查；
 * - `form` → 通用表单（CheckActionModal），submitAction 按上面的同一套规则分发。
 *
 * 手动刷新，不挂定时器：检查会起子进程（gh / glab / git），
 * 在后台每 5 秒跑一遍的代价和读一次票列表完全不是一回事。
 */

const GROUP_OF: Record<string, CheckItem["group"]> = Object.fromEntries(
  CHECK_CATALOG.map((item) => [item.id, item.group]),
);

const ITEM_KEY: Record<string, PanelKey> = {
  "skill:wayfinder": "checks.item.skill-wayfinder",
  "skill:setup-matt-pocock-skills": "checks.item.skill-setup",
  "skill:ask-matt": "checks.item.skill-ask",
  "env:home": "checks.item.home",
  "tracker:initialized": "checks.item.tracker",
  "gh:remote": "checks.item.ghRemote",
  "gh:installed": "checks.item.ghInstalled",
  "gh:authed": "checks.item.ghAuthed",
  "gh:repoAccess": "checks.item.ghAccess",
  "gh:labels": "checks.item.ghLabels",
  "glab:installed": "checks.item.glabInstalled",
  "glab:authed": "checks.item.glabAuthed",
  "glab:repoAccess": "checks.item.glabAccess",
  "md:workspace": "checks.item.mdWorkspace",
  "md:scratchWritable": "checks.item.mdWritable",
  "md:containersReadable": "checks.item.mdContainers",
};

/** 引导步骤 id → 文案键；认不出的步骤显示原 id，不编一个标题。 */
const STEP_KEY: Record<string, PanelKey> = {
  "selection:backendSelected": "checks.step.selection",
  "gh:installed": "checks.step.ghInstalled",
  "gh:authed": "checks.step.ghAuthed",
  "gh:remote": "checks.step.ghRemote",
  "tracker:initialized": "checks.step.tracker",
  "skill:wayfinder": "checks.step.skills",
};

const STATUS_KEY: Record<CheckResult["status"], PanelKey> = {
  ok: "checks.status.ok",
  warn: "checks.status.warn",
  fail: "checks.status.fail",
  unknown: "checks.status.unknown",
};

type GuidePromptId = "cliInstall" | "ghAuthLogin" | "glabAuthLogin";

/** RPC 把 action 放宽成 unknown[]（form → submitAction 是递归结构），这里按目录侧的真源收窄。 */
interface CheckRow {
  id: string;
  status: CheckResult["status"];
  detail?: string;
  action?: readonly unknown[];
}

/** 当前打开的动作弹窗：form 带字段、wizard 带名字，一次只开一个。 */
type ActiveModal =
  | { kind: "form"; title: string; schema: readonly CheckField[]; submitAction: Exclude<CheckAction, { type: "form" }> }
  | { kind: "wizard"; wizard: string; title: string }
  | null;

export function ChecksTab({
  theme,
  workspaceId,
  workspaceDir,
  navigation,
}: {
  theme: PluginTheme;
  workspaceId: string;
  workspaceDir: string;
  navigation?: SessionNavigation;
}) {
  const { t, zh } = usePanelText();
  const lang: DeckLang = zh ? "zh" : "en";
  const skin = usePixel(theme);
  const provider = useDeckWorkspaceProvider(workspaceId);
  const toast = useToast();
  const runChecks = useRpc(checksRunRpc);
  const installAll = useRpc(skillsInstallRpc);
  const listSkills = useRpc(skillsListRpc);
  const readAuth = useRpc(authStatusRpc);
  const publishRun = useRpc(publishRunRpc);
  const settings = useSettings(deckSettings);
  const [authOpen, setAuthOpen] = useState(false);
  const [sheet, setSheet] = useState<{ open: boolean; prompt: string }>({ open: false, prompt: "" });
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  /** setupRun 先问布局：弹窗是否打开。 */
  const [setupAsking, setSetupAsking] = useState(false);

  const query = useQuery({
    queryKey: ["deck", "checks", workspaceDir],
    queryFn: () => runChecks({ workspaceDir }),
    staleTime: 30_000,
    retry: false,
  });

  /** 发布向导的预览要填 {owner}：读一次 gh 登录态；没登录就显示通用 owner 占位。 */
  const auth = useQuery({
    queryKey: ["deck", "auth", "status"],
    queryFn: () => readAuth({}),
    staleTime: 30_000,
    retry: false,
  });
  const owner = auth.data && auth.data.state === "authenticated" ? (auth.data.login ?? "") : "";

  /** installSkills 注入文本的探针清单：用插件实际打包的技能名单，不写死 27 个名字。 */
  const skills = useQuery({
    queryKey: ["deck", "skills", "list", workspaceDir, lang],
    queryFn: () => listSkills({ workspaceDir, lang }),
    staleTime: 60_000,
    retry: false,
  });
  const skillIds = useMemo(() => (skills.data?.skills ?? []).map((skill) => skill.id), [skills.data]);

  const install = useMutation({
    mutationFn: () => installAll({ workspaceDir, lang }),
    onSuccess: (result) => {
      toast.show(
        t("checks.action.installed", {
          written: result.written.length,
          skipped: result.skipped.length,
          conflicts: result.conflicts.length,
        }),
        { variant: result.conflicts.length ? "warning" : "success" },
      );
      void query.refetch();
    },
    onError: (error: unknown) =>
      toast.error(t("checks.action.installFailed", { error: error instanceof Error ? error.message : String(error) })),
  });

  const data = query.data;
  const backend = (data?.backend ?? null) as BackendId | null;
  const checks = data?.checks ?? [];
  const attention = checks.filter((item) => item.status === "fail" || item.status === "warn");
  const unknownCount = checks.filter((item) => item.status === "unknown").length;
  const items = useMemo(() => new Map(catalogFor(backend).map((item) => [item.id, item])), [backend]);
  const guide = data ? guideProgress(data.guide, data.backend) : null;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      bar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      spacer: { marginLeft: "auto" as const },
      onScreen: skin.hintOnChecker,
      hint: skin.hint,
      error: skin.error,
      body: { padding: 10, gap: 6 },
      row: { gap: 3 },
      rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      label: { color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, flexShrink: 1 },
      detail: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      status: {
        fontSize: 10,
        lineHeight: 16,
        paddingHorizontal: 6,
        borderWidth: 1,
        borderColor: skin.colors.line,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
      },
      actions: { flexDirection: "row" as const, gap: 6, flexWrap: "wrap" as const, alignItems: "center" as const },
      meta: skin.statuslineText,
    }),
    [skin],
  );

  const statusStyle = (status: CheckResult["status"]) =>
    status === "ok"
      ? { backgroundColor: skin.colors.okBg, color: skin.colors.ok }
      : status === "fail"
        ? { backgroundColor: skin.colors.badBg, color: skin.colors.bad }
        : status === "warn"
          ? { backgroundColor: skin.colors.warnBg, color: skin.colors.warnInk }
          : { backgroundColor: skin.colors.stripe, color: skin.colors.ink2 };

  const checkedLabel = data
    ? t("checks.checkedAt", { date: new Date(data.checkedAt).toLocaleString() })
    : query.isFetching
      ? t("checks.running")
      : "";

  const labelOf = (check: { id: string }): string => {
    const key = ITEM_KEY[check.id];
    if (key) return t(key);
    return items.get(check.id)?.label ?? check.id;
  };

  const openGuide = (prompt: GuidePromptId): void =>
    setSheet({ open: true, prompt: checkGuidePromptOf(prompt, lang) });

  /** 打开一段注入文本（布局问完后的 setupRun / ensureLabels 都从这里出）。 */
  const injectPrompt = (prompt: string): void => setSheet({ open: true, prompt });

  /**
   * setupRun：gh:remote 没过时不注入（DSH 的 blocksSetup 定案）。
   * 先弹布局问题，答完再注入 v15 原文；没有可用的阻断步骤时直接问布局。
   */
  const setupBlockedStep = useMemo(() => {
    if (!data || backend !== "github") return null;
    const remote = checks.find((check) => check.id === "gh:remote");
    return remote && remote.status !== "ok" ? remote : null;
  }, [data, backend, checks]);

  const startSetup = (): void => {
    if (setupBlockedStep) {
      const stepKey: PanelKey = STEP_KEY["gh:remote"] ?? "checks.step.ghRemote";
      // unknown 是「查不到」不是「确定没关联」（DSH #916 同一口径）：话术改成先重查。
      const variant = setupBlockedStep.status === "unknown" ? "checks.action.setupUnknown" : "checks.action.setupBlocked";
      toast.show(t(variant, { step: t(stepKey) }), { variant: "warning" });
      return;
    }
    setSetupAsking(true);
  };

  const finishSetup = (layout: SetupLayout): void => {
    setSetupAsking(false);
    injectPrompt(setupPromptOf(backend, layout, lang));
  };

  /** 发布向导提交：真建仓（git init/add/commit + gh repo create + push）。 */
  const runPublish = async (values: Record<string, string>): Promise<boolean> => {
    const name = (values.name ?? "").trim();
    const visibility = values.visibility === "public" ? "public" : "private";
    const result = await publishRun({ workspaceDir, name, visibility });
    if (!result.ok) {
      toast.show(t("checks.publish.failed", { detail: result.detail }), { variant: "error" });
      return false;
    }
    toast.show(
      result.route === "existing"
        ? t("checks.publish.doneExisting", { url: result.url })
        : t("checks.publish.done", { url: result.url }),
      { variant: "success" },
    );
    void query.refetch();
    return true;
  };

  /** 后端选择向导提交：写设置（host 级），然后重查。 */
  const saveBackend = async (values: Record<string, string>): Promise<boolean> => {
    const picked = (values.backend ?? "auto") as "auto" | "github" | "gitlab" | "local";
    if (settings.status !== "ready") {
      toast.show(t("checks.backend.saveFailed", { error: settings.status }), { variant: "error" });
      return false;
    }
    try {
      await settings.save({ ...settings.values, backend: picked }, settings.revision);
    } catch (error) {
      toast.show(
        t("checks.backend.saveFailed", { error: error instanceof Error ? error.message : String(error) }),
        { variant: "error" },
      );
      return false;
    }
    const nameKey: PanelKey =
      picked === "github"
        ? "checks.backend.github"
        : picked === "gitlab"
          ? "checks.backend.gitlab"
          : picked === "local"
            ? "checks.backend.local"
            : "checks.backend.auto";
    toast.show(t("checks.backend.saved", { backend: t(nameKey) }), { variant: "success" });
    void query.refetch();
    return true;
  };

  /**
   * 通用 submitAction 分发：form 与向导收完值之后都走到这里。
   * `cwd` 已经由 CheckActionModal 并进 values。
   *
   * 与 DSH 的两处合并约定差异（有意，目录当前不受影响）：
   * - `submitAction.params` 不参与合并：DSH 约定 params + 表单值 + cwd 一起提交，
   *   这里 params 是目录作者给的静态参数，与表单值撞名时会互相覆盖，语义不清；
   *   当前目录所有 submitAction 的 params 都为空，等真出现带 params 的动作再定优先级。
   * - form → wizard 接力由 formModalSubmit 处理（不在本函数里直接 setActiveModal）。
   */
  const dispatchSubmitAction = async (
    action: Exclude<CheckAction, { type: "form" }>,
    values: Record<string, string>,
  ): Promise<boolean> => {
    if (action.type === "rpc" && action.method === "deck.publish.run") return runPublish(values);
    if (action.type === "rpc" && action.method === "deck.auth.start") {
      setAuthOpen(true);
      return true;
    }
    if (action.type === "open-url") {
      await openExternalUrl(action.url).catch(() => toast.error(t("checks.openFailed")));
      return true;
    }
    if (action.type === "refresh") {
      void query.refetch();
      return true;
    }
    if (action.type === "inject-prompt") return dispatchInject(action.prompt, values);
    // wizard 形态不进这里：formModalSubmit 单独拦，避免同一拍 setActiveModal 接力被关窗回调清掉。
    toast.show(t("checks.action.unsupported", { label: action.label ?? action.type }), { variant: "warning" });
    return false;
  };

  /**
   * form 弹窗的提交入口：submitAction 是 wizard 时接力开向导。
   * 顺序必须「先清 form、同拍塞 wizard」：dispatch 返回 true 后 CheckActionModal
   * 会调 onOpenChange(false)，而 form 的 onOpenChange 只在 activeModal 仍是 form
   * 时才清状态，所以塞进来的 wizard 不会被同一次关窗回调抹掉。
   */
  const formModalSubmit = (values: Record<string, string>): Promise<boolean> | boolean => {
    if (activeModal?.kind !== "form") return false;
    const { submitAction } = activeModal;
    if (submitAction.type === "wizard") {
      setActiveModal({
        kind: "wizard",
        wizard: submitAction.wizard,
        title: submitAction.label ?? submitAction.wizard,
      });
      return true;
    }
    return dispatchSubmitAction(submitAction, values);
  };

  /** inject-prompt 的五个已知键；认不出的键不编文本，按未接线明示。 */
  const dispatchInject = (prompt: string, values: Record<string, string>): boolean => {
    if (prompt === "cliInstall" || prompt === "ghAuthLogin" || prompt === "glabAuthLogin") {
      injectPrompt(checkGuidePromptOf(prompt, lang));
      return true;
    }
    if (prompt === "setupRun") {
      startSetup();
      return true;
    }
    if (prompt === "ensureLabels") {
      injectPrompt(ensureLabelsPromptOf(lang));
      return true;
    }
    if (prompt === "installSkills") {
      injectPrompt(installSkillsPromptOf(skillIds, lang));
      return true;
    }
    toast.show(t("checks.action.unsupported", { label: prompt }), { variant: "warning" });
    return false;
  };

  const actionLabel = (action: CheckAction): string => {
    if (action.type === "refresh") return action.label ?? t("checks.action.refresh");
    if (action.type === "open-url") return action.label ?? t("checks.action.openUrl");
    if (action.type === "rpc" && action.method === "deck.auth.start") return action.label ?? t("checks.action.auth");
    if (action.type === "inject-prompt") {
      if (action.prompt === "installSkills") return action.label ?? t("checks.action.installSkills");
      if (action.prompt === "cliInstall") return action.label ?? t("checks.action.installGuide");
      if (action.prompt === "ghAuthLogin") return action.label ?? t("checks.action.loginGuide");
      if (action.prompt === "glabAuthLogin") return action.label ?? t("checks.action.loginGuide");
      if (action.prompt === "setupRun") return action.label ?? t("checks.action.setupRun");
      if (action.prompt === "ensureLabels") return action.label ?? t("checks.action.ensureLabels");
    }
    if (action.type === "wizard") {
      if (action.wizard === "publish") return action.label ?? t("checks.action.publish");
      if (action.wizard === "backend-picker") return action.label ?? t("checks.action.pickBackend");
      // setup-layout 不在目录里出现：布局问题由 SetupLayoutModal 独立处理。
    }
    return action.label ?? action.type;
  };

  const renderAction = (action: CheckAction, index: number) => {
    const label = actionLabel(action);
    const key = `${action.type}-${index}`;

    if (action.type === "refresh") {
      return (
        <PixelButton skin={skin} key={key} mini variant="ghost" label={label} onPress={() => void query.refetch()} />
      );
    }
    if (action.type === "open-url") {
      return (
        <PixelButton
          skin={skin}
          key={key}
          mini
          variant="ghost"
          label={label}
          onPress={() => void openExternalUrl(action.url).catch(() => toast.error(t("checks.openFailed")))}
        />
      );
    }
    if (action.type === "rpc" && action.method === "deck.auth.start") {
      return <PixelButton skin={skin} key={key} mini variant="ghost" label={label} onPress={() => setAuthOpen(true)} />;
    }
    if (action.type === "rpc" && action.method === "deck.publish.run") {
      // 直接挂 rpc 建仓而不带表单时（没有名字可填），改走发布向导。
      return (
        <PixelButton
          skin={skin}
          key={key}
          mini
          variant="ghost"
          label={label}
          onPress={() => setActiveModal({ kind: "wizard", wizard: "publish", title: t("checks.publish.title") })}
        />
      );
    }
    if (action.type === "inject-prompt" && action.prompt === "installSkills" && skillIds.length > 0) {
      // 技能在面板里有真安装器：主按钮直接装，安装指引作为第二条动作仍在（目录里就带着）。
      return (
        <PixelButton
          skin={skin}
          key={key}
          mini
          variant="ghost"
          label={install.isPending ? t("checks.running") : label}
          disabled={install.isPending}
          onPress={() => install.mutate()}
        />
      );
    }
    if (action.type === "inject-prompt") {
      return (
        <PixelButton
          skin={skin}
          key={key}
          mini
          variant="ghost"
          label={label}
          onPress={() => void dispatchInject(action.prompt, {})}
        />
      );
    }
    if (action.type === "form") {
      return (
        <PixelButton
          skin={skin}
          key={key}
          mini
          variant="ghost"
          label={label}
          onPress={() =>
            setActiveModal({
              kind: "form",
              title: label,
              schema: action.schema,
              submitAction: action.submitAction,
            })
          }
        />
      );
    }
    if (action.type === "wizard") {
      return (
        <PixelButton
          skin={skin}
          key={key}
          mini
          variant="ghost"
          label={label}
          onPress={() => setActiveModal({ kind: "wizard", wizard: action.wizard, title: label })}
        />
      );
    }
    return (
      <Text key={key} style={styles.hint}>
        {t("checks.action.unsupported", { label })}
      </Text>
    );
  };

  const groups: { key: CheckItem["group"]; title: PanelKey; checks: CheckRow[] }[] = [
    { key: "gate", title: "checks.group.gate", checks: [] },
    { key: "env", title: "checks.group.env", checks: [] },
    { key: "backend", title: "checks.group.backend", checks: [] },
  ];
  for (const check of checks) {
    const group = GROUP_OF[check.id] ?? "env";
    groups.find((item) => item.key === group)?.checks.push(check);
  }

  /** 发布向导（DSH 原文两步：仓库信息 → 可见性）。 */
  const publishSteps: readonly WizardStepSpec[] = [
    {
      key: "info",
      title: t("checks.publish.stepInfo"),
      schema: [
        {
          name: "name",
          type: "text",
          required: true,
          label: t("checks.publish.name"),
          pattern: "^[A-Za-z0-9._-]{1,100}$",
          defaultFrom: "cwd-basename",
          preview: t("checks.publish.preview"),
        },
      ],
    },
    {
      key: "visibility",
      title: t("checks.publish.stepVisibility"),
      schema: [
        {
          name: "visibility",
          type: "single",
          label: t("checks.publish.visibility"),
          options: ["private", "public"],
          optionSubs: { private: t("checks.publish.private"), public: t("checks.publish.public") },
          defaultValue: "private",
        },
      ],
    },
  ];

  /** 后端选择向导：写进设置（host 级），与设置页同一个字段。 */
  const backendSteps: readonly WizardStepSpec[] = [
    {
      key: "backend",
      title: t("checks.backend.question"),
      schema: [
        {
          name: "backend",
          type: "single",
          label: t("checks.backend.title"),
          options: ["auto", "github", "gitlab", "local"],
          optionSubs: {
            auto: t("checks.backend.auto"),
            github: t("checks.backend.github"),
            gitlab: t("checks.backend.gitlab"),
            local: t("checks.backend.local"),
          },
          defaultValue: settings.status === "ready" ? settings.values.backend : "auto",
          required: true,
        },
      ],
    },
  ];

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <Text style={styles.label}>{t("checks.title")}</Text>
        <View style={styles.spacer} />
        <PixelButton
          skin={skin}
          label={query.isFetching ? t("checks.running") : t("checks.run")}
          disabled={query.isFetching}
          onPress={() => void query.refetch()}
        />
      </View>

      {query.error ? (
        <PixelBanner skin={skin}>
          <Text style={styles.error}>{query.error.message}</Text>
          <PixelButton skin={skin} label={t("common.retry")} onPress={() => void query.refetch()} />
        </PixelBanner>
      ) : null}

      {attention.length ? (
        <PixelBanner skin={skin} tone="warning">
          <Text style={styles.error}>{t("checks.banner", { n: attention.length })}</Text>
        </PixelBanner>
      ) : null}
      {unknownCount > 0 ? <Text style={styles.onScreen}>{t("checks.unknown", { n: unknownCount })}</Text> : null}

      {data && checks.length > 0 && attention.length === 0 && unknownCount === 0 ? (
        <Text style={styles.onScreen}>{t("checks.allOk")}</Text>
      ) : null}

      {data ? (
        <Text style={styles.onScreen}>
          {data.guide.current
            ? t("checks.guide", {
                done: guide?.done ?? 0,
                total: guide?.total ?? 0,
                step: STEP_KEY[data.guide.current] ? t(STEP_KEY[data.guide.current] as PanelKey) : data.guide.current,
              })
            : t("checks.guideDone")}
        </Text>
      ) : null}

      {query.isPending ? <Text style={styles.onScreen}>{t("common.loading")}</Text> : null}
      {data && checks.length === 0 ? <Text style={styles.onScreen}>{t("checks.empty")}</Text> : null}

      {groups.map((group) =>
        group.checks.length ? (
          <PixelCard key={group.key} skin={skin}>
            <View style={styles.body}>
              <PixelHead skin={skin}>{t(group.title)}</PixelHead>
              {group.checks.map((check) => (
                <View key={check.id} style={styles.row}>
                  <View style={styles.rowHead}>
                    <Text style={[styles.status, statusStyle(check.status)]}>{t(STATUS_KEY[check.status])}</Text>
                    <Text style={styles.label}>{labelOf(check)}</Text>
                  </View>
                  {check.detail ? <Text style={styles.detail}>{check.detail}</Text> : null}
                  {check.action?.length ? (
                    <View style={styles.actions}>
                      {(check.action as CheckAction[]).map((action, index) => renderAction(action, index))}
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          </PixelCard>
        ) : null,
      )}

      <PixelStatusLine skin={skin}>
        <Text style={styles.meta}>
          {checkedLabel}
          {data ? ` · ${data.backend}` : ""}
        </Text>
      </PixelStatusLine>
      <Text style={styles.hint}>{t("checks.readOnly")}</Text>

      <GithubAuthModal theme={theme} open={authOpen} onClose={() => setAuthOpen(false)} />
      <SessionSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((current) => ({ ...current, open }))}
        theme={theme}
        workspaceId={workspaceId}
        workspaceDir={workspaceDir}
        provider={provider}
        action="custom"
        context={{}}
        initialPrompt={sheet.prompt}
        navigation={navigation}
      />

      {/* 发布向导（gh:remote / gh:repoAccess 的「创建并发布」） */}
      <CheckActionModal
        theme={theme}
        open={activeModal?.kind === "wizard" && activeModal.wizard === "publish"}
        onOpenChange={(open) => {
          if (!open) setActiveModal(null);
        }}
        title={t("checks.publish.title")}
        wizard={{ steps: publishSteps }}
        workspaceDir={workspaceDir}
        owner={owner}
        t={t}
        submit={runPublish}
      />

      {/* 后端选择向导（引导第一步 selection:backendSelected） */}
      <CheckActionModal
        theme={theme}
        open={activeModal?.kind === "wizard" && activeModal.wizard === "backend-picker"}
        onOpenChange={(open) => {
          if (!open) setActiveModal(null);
        }}
        title={t("checks.backend.title")}
        wizard={{ steps: backendSteps }}
        workspaceDir={workspaceDir}
        owner={owner}
        t={t}
        submit={saveBackend}
      />

      {/* 通用表单（目录里带 schema 的 form 动作，例如技能安装的「帮我安装」） */}
      <CheckActionModal
        theme={theme}
        open={activeModal?.kind === "form"}
        onOpenChange={(open) => {
          // 接力场景（form → wizard）里关窗回调跑时 activeModal 已是 wizard，不许清。
          if (!open) setActiveModal((current) => (current?.kind === "form" ? null : current));
        }}
        title={activeModal?.kind === "form" ? activeModal.title : ""}
        form={activeModal?.kind === "form" ? { schema: activeModal.schema } : null}
        workspaceDir={workspaceDir}
        owner={owner}
        t={t}
        submit={(values) => formModalSubmit(values)}
      />

      {/* setupRun 的布局问题（DSH 的 setup-layout 卡：每次初始化前先问一次） */}
      <SetupLayoutModal
        theme={theme}
        open={setupAsking}
        onOpenChange={(open) => {
          if (!open) setSetupAsking(false);
        }}
        onPick={finishSetup}
      />
    </View>
  );
}

/** 布局问题的最小弹窗：一个问题 + 两个互斥选项，选一个立即注入。 */
function SetupLayoutModal({
  theme,
  open,
  onOpenChange,
  onPick,
}: {
  theme: PluginTheme;
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(value: SetupLayout): void;
}) {
  const { t } = usePanelText();
  return (
    <CheckActionModal
      theme={theme}
      open={open}
      onOpenChange={onOpenChange}
      title={t("checks.setup.title")}
      form={{
        schema: [
          {
            name: "layout",
            type: "single",
            label: t("checks.setup.layoutQuestion"),
            options: ["single", "multi"],
            optionSubs: { single: t("checks.setup.layoutSingle"), multi: t("checks.setup.layoutMulti") },
            defaultValue: "single",
            required: true,
          },
        ],
      }}
      workspaceDir="/"
      owner=""
      t={t}
      submit={(values) => {
        onPick(values.layout === "multi" ? "multi" : "single");
        return true;
      }}
    />
  );
}
