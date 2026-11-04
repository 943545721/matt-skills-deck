import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton, usePixel } from "../../pixel.tsx";
import { OrchSection } from "./parts.tsx";

/**
 * 阀门四：全停。
 *
 * 从 `RolesPanel` 里单独拆出来：它自带一套「待确认 → 执行 → 报结果」的状态机，
 * 和角色槽位、限制那几个字段没有共享状态；放一起只会让那块面板越来越长。
 *
 * 不可逆的一次动作（没有暂停态），所以要点两下：第一下只是「待确认」，第二下才真的停。
 * 两段文案不是装饰：
 * - 「顺手归档」旁边必须写清**连坐**——归档父窗口会一起归档它派出去的同区子会话；
 * - 结尾那句「不保证已回传」，防止人以为停了就等于结果都收齐了。
 */

/** 服务端逐条失败不影响其它会话，所以 failures 是数组而不是一个错误。 */
export type StaffStopOutcome =
  | { ok: true; stopped: number; denied: number; interrupted: number; archived: number; failures: string[] }
  | { ok: false; detail: string };

function useStopStyles(skin: PixelSkin) {
  return useMemo(
    () => ({
      hint: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      warn: skin.error,
      toggleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 4 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 4 },
    }),
    [skin],
  );
}

export function StopSection({
  skin,
  t,
  busy,
  onStop,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  /** 有设置在保存：先禁用，避免两份写同时打出去。 */
  busy: boolean;
  onStop(input: { archive: boolean }): Promise<StaffStopOutcome>;
}) {
  const stopStyles = useStopStyles(skin);
  const [arming, setArming] = useState(false);
  const [archive, setArchive] = useState(false);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<StaffStopOutcome | null>(null);

  const run = async () => {
    if (running) return;
    setRunning(true);
    try {
      setOutcome(await onStop({ archive }));
      setArming(false);
    } catch (error) {
      setOutcome({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <OrchSection skin={skin} title={t("orch.staffStop")}>
      <Text style={stopStyles.hint}>{t("orch.staffStopHint")}</Text>
      <View style={stopStyles.toggleRow}>
        <PixelButton
          skin={skin}
          mini
          variant={archive ? "outline" : "ghost"}
          active={archive}
          label={`${archive ? "◉" : "○"} ${t("orch.staffStopArchive")}`}
          disabled={running || busy}
          onPress={() => setArchive((current) => !current)}
        />
      </View>
      <Text style={stopStyles.hint}>{t("orch.staffStopArchiveHint")}</Text>
      <Text style={stopStyles.hint}>{t("orch.staffStopNoRelay")}</Text>

      {arming ? (
        <View style={stopStyles.actions}>
          <PixelButton
            skin={skin}
            mini
            label={running ? t("orch.staffStopRunning") : t("orch.staffStopConfirm")}
            disabled={running || busy}
            onPress={() => void run()}
          />
          <PixelButton
            skin={skin}
            mini
            variant="ghost"
            label={t("orch.staffStopCancel")}
            disabled={running}
            onPress={() => setArming(false)}
          />
        </View>
      ) : (
        <View style={stopStyles.actions}>
          <PixelButton
            skin={skin}
            mini
            variant="outline"
            label={t("orch.staffStopArm")}
            disabled={busy}
            onPress={() => {
              // 上一次的结果先清掉：留着会让人以为这次也停了。
              setOutcome(null);
              setArming(true);
            }}
          />
        </View>
      )}

      {outcome && !outcome.ok ? (
        <Text style={stopStyles.warn}>{`${t("orch.staffStopFailed")}${outcome.detail}`}</Text>
      ) : null}
      {outcome && outcome.ok ? (
        <>
          <Text style={stopStyles.hint}>
            {t("orch.staffStopDone", {
              stopped: outcome.stopped,
              denied: outcome.denied,
              interrupted: outcome.interrupted,
              archived: outcome.archived,
            })}
          </Text>
          {outcome.failures.map((failure) => (
            <Text key={failure} style={stopStyles.warn}>
              {failure}
            </Text>
          ))}
        </>
      ) : null}
    </OrchSection>
  );
}
