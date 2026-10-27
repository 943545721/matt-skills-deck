import type { PluginTheme } from "@getpaseo/plugin";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { STANDARD_LABELS } from "../../shared/labels";
import { useDeckText } from "./i18n";
import { PixelButton, usePixel } from "./pixel";

/**
 * 仓库初始化指引（六步）。
 *
 * 只给命令、只复制、不代跑：`git init`、建远端、`gh auth login` 都会改变用户机器或
 * 远端账户的状态，替用户按下回车就是把「确认」这一步删掉了。仓库可见性也不替用户选，
 * `gh repo create` 留成交互式。
 */

const LABEL_COMMANDS = STANDARD_LABELS.map(
  (label) => `gh label create "${label.name}" --color "${label.color}" --description "${label.description}" --force`,
).join("\n");

const STEPS = [
  { titleKey: "diag.setupStep1", command: "git init", noteKey: "diag.setupStep1Note" },
  { titleKey: "diag.setupStep2", command: "git remote add origin <仓库地址>", noteKey: "diag.setupStep2Note" },
  { titleKey: "diag.setupStep3", command: "gh repo create --source=. --remote=origin", noteKey: "diag.setupStep3Note" },
  { titleKey: "diag.setupStep4", command: "gh auth login", noteKey: "diag.setupStep4Note" },
  { titleKey: "diag.setupStep5", command: LABEL_COMMANDS, noteKey: "diag.setupStep5Note" },
  { titleKey: "diag.setupStep6", command: "mkdir -p docs .claude/skills .agents/skills", noteKey: "diag.setupStep6Note" },
] as const;

export function SetupGuide({ theme }: { theme: PluginTheme }) {
  const { t } = useDeckText();
  const toast = useToast();
  const skin = usePixel(theme);
  const [open, setOpen] = useState(false);

  const styles = useMemo(
    () => ({
      card: {
        borderWidth: 2,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: 10,
        gap: 8,
      },
      step: { gap: 2 },
      title: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 },
      command: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        padding: 6,
        fontSize: 11,
      },
      copy: { color: theme.colors.accent, fontSize: 11 },
    }),
    [theme],
  );

  const copy = (text: string, message: string) => {
    void copyText(text).then(
      () => toast.show(message, { variant: "success" }),
      () => toast.error(t("common.copyFailed")),
    );
  };

  return (
    <View style={styles.card}>
      <View style={{ flexDirection: "row" as const, alignItems: "center" as const, gap: 8 }}>
        <Text style={styles.title}>{t("diag.setupTitle")}</Text>
        <View style={{ marginLeft: "auto" as const }}>
          <PixelButton
            skin={skin}
            label={open ? t("diag.setupHide") : t("diag.setupShow")}
            onPress={() => setOpen((value) => !value)}
          />
        </View>
      </View>
      <Text style={styles.hint}>{t("diag.setupHint")}</Text>
      {open ? (
        <>
          {STEPS.map((step, index) => (
            <View key={step.titleKey} style={styles.step}>
              <Text style={styles.title}>
                {index + 1}. {t(step.titleKey)}
              </Text>
              <Text style={styles.hint}>{t(step.noteKey)}</Text>
              <Text style={styles.command} selectable>
                {step.command}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t("common.copy")}: ${t(step.titleKey)}`}
                onPress={() => copy(step.command, t("diag.setupCopied"))}
              >
                <Text style={styles.copy}>{t("common.copy")}</Text>
              </Pressable>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("diag.setupCopyAll")}
            onPress={() => copy(STEPS.map((step) => step.command).join("\n"), t("diag.setupCopied"))}
          >
            <Text style={styles.copy}>{t("diag.setupCopyAll")}</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
