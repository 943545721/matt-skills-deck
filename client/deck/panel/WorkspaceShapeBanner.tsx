import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { workspaceAcknowledgeRpc, workspaceShapeRpc } from "../../../shared/repo";
import { PixelBanner, PixelButton, usePixel } from "../pixel";
import { useDeckWorkspaceProvider } from "../surfaces/host.tsx";
import { usePanelText } from "./panelText";

/**
 * 工作区形态提示条。
 *
 * 打开一个目录不等于打开一套项目：这里把服务端的判定（单项目 / 多项目 / 不成套）摊开，
 * 连同判定依据一起给人看，再给一个「复制梳理提示词」的按钮。
 *
 * 刻意不做的事：不自动跑技能、不自动写配置、不自动建票。判成多项目只是一个建议，
 * 真正的动作要人点、人要粘。`acknowledged`（人已经表过态）时整条不出现。
 */
export function WorkspaceShapeBanner({
  theme,
  workspaceId,
  workspaceDir,
}: {
  theme: PluginTheme;
  workspaceId: string;
  /** 已解析的绝对目录；空串表示还没解析出来，此时不读盘。 */
  workspaceDir: string;
}) {
  const { t, zh } = usePanelText();
  const skin = usePixel(theme);
  const toast = useToast();
  const provider = useDeckWorkspaceProvider(workspaceId);
  const readShape = useRpc(workspaceShapeRpc);
  const acknowledge = useRpc(workspaceAcknowledgeRpc);
  const queryClient = useQueryClient();
  const lang = zh ? "zh" : "en";

  const query = useQuery({
    // provider 进键：同一个目录挂在两个工作区里时，别让提示串台。
    queryKey: ["deck", "workspace-shape", provider, workspaceDir, lang],
    queryFn: () => readShape({ workspaceDir, lang }),
    enabled: workspaceDir.length > 0,
    staleTime: 60_000,
  });

  const styles = useMemo(
    () => ({
      body: { gap: 6 },
      title: { color: skin.colors.ink, fontSize: 12, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
      reason: { color: skin.colors.ink2, fontSize: 11 },
      hint: { color: skin.colors.ink2, fontSize: 11 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    }),
    [skin],
  );

  /** 「不再提示」把判定的形状记进配置：人说过一次，就不该再被问第二次。 */
  const dismiss = useMutation({
    mutationFn: (shape: "single" | "container" | "mixed") => acknowledge({ workspaceDir, shape }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.detail);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["deck", "workspace-shape"] });
    },
  });

  const data = query.data;
  // 单项目、人已表态、或读不到：都不打扰。注意：这个提前返回必须在所有 Hook 之后，
  // 否则首次渲染少调用一个 Hook、数据到达后多调用一个，React 会直接抛 #310。
  if (!data || data.shape === "single" || data.acknowledged || !data.prompt) return null;

  const copy = () => {
    if (!data.surveyPrompt) return;
    void copyText(data.surveyPrompt).then(
      () => toast.show(t("shape.surveyCopied"), { variant: "success" }),
      () => toast.error(t("common.copyFailed")),
    );
  };

  const optionKey = (option: string) =>
    option === "subset" ? "shape.option.subset" : option === "split" ? "shape.option.split" : "shape.option.all-with-source";

  return (
    <PixelBanner skin={skin} tone="warning">
      <View style={styles.body}>
        <Text style={styles.title}>{t(data.prompt.kind === "mixed" ? "shape.title.mixed" : "shape.title.survey")}</Text>
        {data.prompt.lines.map((line) => (
          <Text key={line} style={styles.reason}>
            {line}
          </Text>
        ))}

        <Text style={styles.hint}>{t("shape.reasons")}</Text>
        {data.reasons.map((line) => (
          <Text key={line} style={styles.reason}>
            {line}
          </Text>
        ))}

        {data.prompt.options.length > 0 ? (
          <View style={styles.body}>
            {data.prompt.options.map((option) => (
              <Text key={option} style={styles.reason}>
                · {t(optionKey(option))}
              </Text>
            ))}
          </View>
        ) : null}

        {data.configError ? (
          <Text style={styles.reason}>{t("shape.configError", { detail: data.configError.detail })}</Text>
        ) : null}
        {data.truncated ? <Text style={styles.reason}>{t("shape.truncated", { n: data.repos.length })}</Text> : null}

        <View style={styles.row}>
          {data.surveyPrompt ? (
            <PixelButton skin={skin} label={t("shape.surveyCta")} onPress={copy} />
          ) : null}
          <PixelButton
            skin={skin}
            label={t("shape.dismiss")}
            onPress={() => dismiss.mutate(data.shape)}
          />
        </View>
        <Text style={styles.hint}>{t("shape.surveyHint")}</Text>
      </View>
    </PixelBanner>
  );
}
