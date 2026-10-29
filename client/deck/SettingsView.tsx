import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { copyText, ScrollView, SettingsAction, SettingsSection, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { APPEARANCES, deckSettings } from "../../shared/settings";
import type { Appearance } from "../../shared/settings";
import { SKILL_MODES } from "../../shared/workspace-projects";
import type { SkillMode } from "../../shared/workspace-projects";
import { updateCheckRpc } from "../../shared/update";
import { workspaceBindingRpc } from "../../shared/workspace-binding";
import type { WorkspaceBindingInput, WorkspaceBindingOutput } from "../../shared/workspace-binding";
import { useQuery } from "@tanstack/react-query";
import { useDeckText } from "./i18n";
import { usePixel } from "./pixel";
import { useDeckHost } from "./surfaces/host.tsx";

/**
 * 插件设置页。
 *
 * 设置放在宿主设置里，而不是散落在面板各页：后端 / 刷新 / 日志影响服务端行为，
 * 外观决定深色 / 浅色 / 经典像素用哪一套。保存走 `save(values, revision)`：整份文档 + 版本号，
 * 两个客户端同时改时后写的那次会失败，而不是静默覆盖。
 *
 * 更新检查只查不装：宿主没有安装插件的调用面，这里给出一条可复制的命令。
 */

const BACKENDS = ["auto", "github", "gitlab", "local"] as const;
const REFRESH_SECONDS = [0, 15, 30, 60, 120, 300] as const;

export function DeckSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const { t } = useDeckText();
  // 设置行本身是宿主控件，不能换成像素按钮；这里只统一说明文字与命令块，
  // 整页背景交给宿主设置页（改背景会把行里的字色弄坏）。
  const skin = usePixel(theme);
  const { directory } = useDeckHost();
  const toast = useToast();
  const state = useSettings(deckSettings);
  const checkUpdate = useRpc(updateCheckRpc);
  const getWorkspaceBinding = useRpc(workspaceBindingRpc);
  const [updating, setUpdating] = useState(false);
  const [update, setUpdate] = useState<{ current: string; latest: string | null; available: boolean; command: string } | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 12 : 20, gap: 12 },
      status: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      warning: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 18 },
      command: {
        color: skin.colors.paper,
        backgroundColor: skin.colors.shadow,
        borderWidth: 1,
        borderColor: skin.colors.line,
        padding: 8,
        fontSize: 11,
        fontFamily: skin.mono.fontFamily,
      },
    }),
    [theme, layout.compact, skin],
  );

  if (state.status === "loading") {
    return (
      <View style={styles.screen}>
        <View style={styles.content}>
          <Text style={styles.status}>{t("settings.loading")}</Text>
        </View>
      </View>
    );
  }
  if (state.status === "error" || state.status === "invalid") {
    return (
      <View style={styles.screen}>
        <View style={styles.content}>
          <Text style={styles.warning}>{t("settings.loadFailed")}</Text>
          <Text style={styles.status}>{state.error}</Text>
          <SettingsAction label={t("settings.reload")} actionLabel={t("settings.reloadAction")} onPress={() => void state.reload()} />
        </View>
      </View>
    );
  }

  const persist = (patch: Partial<typeof state.values>) => {
    void state.save({ ...state.values, ...patch }, state.revision).then((saved) => {
      if (!saved) toast.error(t("settings.saveFailed"));
    });
  };

  const saveBackend = (value: (typeof BACKENDS)[number]) => persist({ backend: value });
  const saveRefresh = (value: string) => persist({ refreshSeconds: Number(value) });
  const saveAppearance = (value: Appearance) => persist({ appearance: value });
  const saveSkillsMode = (value: SkillMode) => persist({ skillsMode: value });

  const runUpdateCheck = () => {
    setUpdating(true);
    setUpdateError(null);
    void checkUpdate({})
      .then((result) => {
        if (!result.ok) {
          setUpdateError(result.detail);
          setUpdate(null);
          return;
        }
        setUpdate({ current: result.current, latest: result.latest, available: result.updateAvailable, command: result.command });
      })
      .catch((error: unknown) => setUpdateError(error instanceof Error ? error.message : String(error)))
      .finally(() => setUpdating(false));
  };

  const copyCommand = () => {
    if (!update) return;
    void copyText(update.command).then(
      () => toast.show(t("settings.commandCopied"), { variant: "success" }),
      () => toast.error(t("settings.copyFailed")),
    );
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {state.saving ? <Text style={styles.status}>{t("settings.saving")}</Text> : null}
      {state.saveError ? <Text style={styles.warning}>{t("settings.saveFailed")}：{state.saveError}</Text> : null}

      <SettingsSection title={t("settings.appearanceSection")}>
        <SettingsSelect
          label={t("settings.appearanceLabel")}
          hint={t("settings.appearanceHint")}
          value={state.values.appearance}
          options={APPEARANCES.map((value) => ({ value, label: t(APPEARANCE_LABEL[value]) }))}
          onValueChange={saveAppearance}
          disabled={state.saving}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.backendSection")} info={<Text style={styles.status}>{t("settings.backendInfo")}</Text>}>
        <SettingsSelect
          label={t("settings.backendLabel")}
          hint={t("settings.backendHint")}
          value={state.values.backend}
          options={BACKENDS.map((value) => ({ value, label: t(BACKEND_LABEL[value]) }))}
          onValueChange={saveBackend}
          disabled={state.saving}
        />
      </SettingsSection>

      {/* 技能模式放在数据源后面：它决定技能页那两个按钮怎么写盘，跟后端是同级的设置。 */}
      <SettingsSection title={t("skillsMode.section")} info={<Text style={styles.status}>{t("skillsMode.hint")}</Text>}>
        <SettingsSelect<SkillMode>
          label={t("skillsMode.label")}
          hint={t("skillsMode.selectHint")}
          value={state.values.skillsMode}
          options={SKILL_MODES.map((value) => ({ value, label: t(SKILL_MODE_LABEL[value]) }))}
          onValueChange={saveSkillsMode}
          disabled={state.saving}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.refreshSection")}>
        <SettingsSelect
          label={t("settings.refreshLabel")}
          hint={t("settings.refreshHint")}
          value={String(state.values.refreshSeconds)}
          options={REFRESH_SECONDS.map((seconds) => ({
            value: String(seconds),
            label: seconds === 0 ? t("settings.refreshOff") : t("settings.refreshSeconds", { n: seconds }),
          }))}
          onValueChange={saveRefresh}
          disabled={state.saving}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.debugSection")}>
        <SettingsSwitch
          label={t("settings.debugLabel")}
          hint={t("settings.debugHint")}
          value={state.values.debugLogging}
          onValueChange={(value) => persist({ debugLogging: value })}
          disabled={state.saving}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.updateSection")} info={<Text style={styles.status}>{t("settings.updateInfo")}</Text>}>
        <SettingsAction
          label={t("settings.updateLabel")}
          actionLabel={updating ? t("settings.updateChecking") : t("settings.updateAction")}
          onPress={runUpdateCheck}
          disabled={updating}
        />
        {update ? (
          <>
            <Text style={styles.status}>
              {update.available
                ? t("settings.updateAvailable", { current: update.current, latest: update.latest ?? "" })
                : t("settings.updateCurrent", { current: update.current })}
            </Text>
            <Text style={styles.command} selectable>
              {update.command}
            </Text>
            <SettingsAction label={t("settings.updateCommand")} actionLabel={t("settings.updateCopy")} onPress={copyCommand} />
          </>
        ) : null}
        {updateError ? <Text style={styles.warning}>{t("settings.updateFailed")}：{updateError}</Text> : null}
      </SettingsSection>

      <SettingsSection title={t("settings.languageSection")} info={<Text style={styles.status}>{t("settings.languageInfo")}</Text>}>
        <Text style={styles.status}>{t("settings.languageHint")}</Text>
      </SettingsSection>

      <SettingsSection title={t("settings.aboutSection")}>
        <SettingsAction
          label={t("settings.feedbackLabel")}
          actionLabel={t("settings.feedbackAction")}
          onPress={() => {
            void openExternalUrl("https://github.com/943545721/matt-skills-deck/issues/new").catch((error: unknown) =>
              toast.error(error instanceof Error ? error.message : String(error)),
            );
          }}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.workspacesSection")}>
        {directory.getWorkspaces().length === 0 ? (
          <Text style={styles.status}>{t("settings.workspacesEmpty")}</Text>
        ) : (
          directory.getWorkspaces().map((workspace) => (
            <WorkspaceBindingRow
              key={workspace.id}
              workspace={workspace}
              getBinding={getWorkspaceBinding}
              statusStyle={styles.status}
              warningStyle={styles.warning}
              t={t}
            />
          ))
        )}
      </SettingsSection>
    </ScrollView>
  );
}

function WorkspaceBindingRow({ workspace, getBinding, statusStyle, warningStyle, t }: {
  workspace: { id: string; name?: string; directory?: string };
  getBinding: (input: WorkspaceBindingInput) => Promise<WorkspaceBindingOutput>;
  statusStyle: object;
  warningStyle: object;
  t: ReturnType<typeof useDeckText>["t"];
}) {
  const directory = workspace.directory || "";
  const binding = useQuery({
    queryKey: ["deck", "workspace-binding", directory],
    queryFn: () => getBinding({ workspaceDir: directory }),
    enabled: Boolean(directory),
    staleTime: 30_000,
  });
  const result = binding.data?.ok ? binding.data : null;
  const backendLabel = result ? t(`settings.backend${result.backend === "markdown" ? "Local" : result.backend === "none" ? "None" : result.backend === "github" ? "Github" : "Gitlab"}` as never) : null;
  const sourceLabel = result ? t(`settings.bindingSource${result.source === "explicit" ? "Explicit" : result.source === "remote" ? "Remote" : result.source === "fallback" ? "Fallback" : "None"}` as never) : null;
  return (
    <View style={{ gap: 3, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#7773" }}>
      <Text style={statusStyle}>{workspace.name ?? workspace.id} · {directory || t("settings.workspaceUnknown")}</Text>
      {binding.isPending ? <Text style={statusStyle}>{t("settings.bindingLoading" as never)}</Text> : result ? (
        <Text style={statusStyle}>{t("settings.bindingSummary" as never, { backend: backendLabel, source: sourceLabel, state: t(`settings.bindingState${result.state === "decided" ? "Decided" : result.state === "undetermined" ? "Undetermined" : "NoBackend"}` as never) })}</Text>
      ) : <Text style={warningStyle}>{binding.data && !binding.data.ok ? binding.data.detail : binding.error instanceof Error ? binding.error.message : t("settings.bindingFailed" as never)}</Text>}
      {result ? <Text style={result.state === "decided" ? statusStyle : warningStyle}>{result.reason}</Text> : null}
    </View>
  );
}

const BACKEND_LABEL = {
  auto: "settings.backendAuto",
  github: "settings.backendGithub",
  gitlab: "settings.backendGitlab",
  local: "settings.backendLocal",
} as const;

const SKILL_MODE_LABEL = {
  unified: "skillsMode.unified",
  "per-project": "skillsMode.perProject",
} as const;

const APPEARANCE_LABEL = {
  auto: "settings.appearanceAuto",
  dark: "settings.appearanceDark",
  light: "settings.appearanceLight",
  classic: "settings.appearanceClassic",
} as const;
