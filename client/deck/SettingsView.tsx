import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { copyText, ScrollView, SettingsAction, SettingsSection, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { deckSettings } from "../../shared/settings";
import { updateCheckRpc } from "../../shared/update";
import { useDeckText } from "./i18n";

/**
 * 插件设置页。
 *
 * 三项设置都直接影响服务端行为（后端选择、刷新间隔、日志），所以放在宿主设置里，
 * 而不是散落在面板各页。保存走 `save(values, revision)`：整份文档 + 版本号，
 * 两个客户端同时改时后写的那次会失败，而不是静默覆盖。
 *
 * 更新检查只查不装：宿主没有安装插件的调用面，这里给出一条可复制的命令。
 */

const BACKENDS = ["auto", "github", "gitlab", "local"] as const;
const REFRESH_SECONDS = [0, 15, 30, 60, 120, 300] as const;

export function DeckSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const { t } = useDeckText();
  const toast = useToast();
  const state = useSettings(deckSettings);
  const checkUpdate = useRpc(updateCheckRpc);
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
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderWidth: 2,
        borderColor: theme.colors.border,
        padding: 8,
        fontSize: 11,
      },
    }),
    [theme, layout.compact],
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
    </ScrollView>
  );
}

const BACKEND_LABEL = {
  auto: "settings.backendAuto",
  github: "settings.backendGithub",
  gitlab: "settings.backendGitlab",
  local: "settings.backendLocal",
} as const;
