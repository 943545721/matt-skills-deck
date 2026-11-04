import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { TextInput } from "@getpaseo/plugin/client/ui";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton, PixelCard } from "../../pixel.tsx";
import type { PanelKey } from "../../panel/panelText.tsx";
import {
  DIFFICULTIES,
  DIFFICULTY_KEY,
  directTargetOf,
  displayTargetOf,
  liveProfileOf,
  modelChoicesOf,
  profileWithoutModel,
  specOf,
  thinkingChoicesOf,
  withModelClearingThinking,
  type ClientProfile,
  type ClientTarget,
  type Difficulty,
  type ProviderRow,
  type RoutingRow,
} from "./types.ts";
import { ModelChoices } from "./ModelChoices.tsx";
import { ThinkingChoices } from "./ThinkingChoices.tsx";

/**
 * 难度路由：trivial / normal / hard / critical 各落到哪个客户端与模型。
 *
 * 每一档只有两种填法：
 * 1. 选一份档案（推荐，宿主别处也用同一份）；
 * 2. 直接写 provider/model。
 *
 * 路由只回答「用哪个客户端、哪个模型」：客户端自己的地址与凭证在「客户端」页签下维护，
 * 换地址不用回来改四条路由。
 *
 * 没配的档位**真的会借用** `normal` 的规则（连 normal 都没有就用内置默认目标）——
 * 否则四档全空时整个派单功能开箱不可用。但借用必须写在界面上：
 * 用户以为 `critical` 跑在最强的客户端上、实际借用的是 normal 的模型，是这套编排最容易出事的地方。
 */
export function RoutingPanel({
  skin,
  t,
  routing,
  profiles,
  providers,
  onPatch,
  busy,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  routing: RoutingRow[];
  profiles: ClientProfile[];
  providers: ProviderRow[];
  onPatch(difficulty: Difficulty, rule: { profileId?: string; target?: ClientTarget } | null): void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState<Difficulty | null>(null);
  const [model, setModel] = useState("");
  /**
   * 手填兜底：宿主没给这个模型报档位时，用户仍能写一个 id。
   * 按难度分开存：四档共用一份草稿时，在「简单」写一半切到「常规」会把内容带过去。
   */
  const [thinking, setThinking] = useState<Partial<Record<Difficulty, string>>>({});
  const styles = useMemo(
    () => ({
      screen: { flex: 1, gap: 8 },
      row: { padding: 10, marginBottom: 6, gap: 4 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      name: { color: skin.colors.ink, fontSize: 12, fontFamily: skin.mono.fontFamily, fontWeight: "700" as const },
      meta: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily },
      /** 落到哪个客户端：单独一行，和难度名分开，扫一列时对得齐。 */
      target: {
        color: skin.colors.ink,
        fontSize: 12,
        fontFamily: skin.mono.fontFamily,
        paddingLeft: 2,
      },
      /** 「借用 X 的路由」是提示，不是错误：用次要色，红只留给「这档根本发不出去」。 */
      borrowed: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, paddingLeft: 2 },
      hint: skin.hint,
      input: skin.input,
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4, marginTop: 4 },
      form: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const, marginTop: 4 },
      bad: skin.error,
    }),
    [skin],
  );

  const rowOf = (difficulty: Difficulty): RoutingRow =>
    routing.find((row) => row.difficulty === difficulty) ?? {
      difficulty,
      profileId: null,
      target: null,
      resolved: { ok: false, reason: "no-target", detail: t("orch.route.empty") },
    };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 16 }}>
      <Text style={styles.hint}>{t("orch.routeHint")}</Text>

      {DIFFICULTIES.map((difficulty) => {
        const row = rowOf(difficulty);
        const open = editing === difficulty;
        const thinkingDraft = thinking[difficulty] ?? "";
        const via = row.resolved.ok && row.resolved.via === "profile" ? ` · ${t("orch.route.viaProfile")}` : "";
        // 配了但发不出去（比如只选了客户端没填模型）时仍要显示配的是什么，
        // 否则行上写「未配置」、用户会以为自己根本没选过。
        const target = directTargetOf(row, profiles);
        const liveProfile = liveProfileOf(row, profiles);
        const choices = modelChoicesOf(target?.provider ?? "", providers);
        // 走的是没写模型的档案：模型在档案里，这里点不了，得把人指回去。
        const modelessProfile = profileWithoutModel(row, profiles);
        // 行上只印**这一档真正会用的那条**：档案还活着时 `row.target` 是被它盖掉的旧配置，
        // 印出来会和下面的红字各说各话；档案缺模型时也不能印成「未配置」——用户明明配过。
        const shown = displayTargetOf(row, profiles);
        const summary = row.resolved.ok
          ? `${specOf(row.resolved.target)}${via}`
          : shown
            ? specOf(shown)
            : t("orch.route.empty");
        return (
          <PixelCard key={difficulty} skin={skin} style={styles.row}>
            <View style={styles.head}>
              <Text style={styles.name}>{t(DIFFICULTY_KEY[difficulty] as PanelKey)}</Text>
              <View style={{ flex: 1 }} />
              <PixelButton
                skin={skin}
                mini
                variant="ghost"
                label={open ? t("orch.collapse") : t("orch.edit")}
                onPress={() => setEditing(open ? null : difficulty)}
              />
            </View>
            <Text style={styles.target} numberOfLines={1}>
              {summary}
            </Text>
            {row.routeFrom
              ? (
                  <Text style={styles.borrowed}>
                    ↳{" "}
                    {t(row.routeFrom === "default" ? "orch.route.fromDefault" : "orch.route.borrowed", {
                      from: row.routeFrom === "default" ? t("orch.route.fromDefaultName") : t(DIFFICULTY_KEY[row.routeFrom] as PanelKey),
                    })}
                  </Text>
                )
              : null}
            {row.resolved.ok ? null : <Text style={styles.bad}>{row.resolved.detail}</Text>}
            {modelessProfile ? (
              <Text style={styles.borrowed}>{t("orch.route.fixInProfile", { name: modelessProfile.name })}</Text>
            ) : null}

            {open ? (
              <>
                <Text style={styles.meta}>{t("orch.route.pickProfile")}</Text>
                <View style={styles.chips}>
                  {profiles.length === 0 ? <Text style={styles.hint}>{t("orch.profileEmpty")}</Text> : null}
                  {profiles.map((profile) => (
                    <PixelButton
                      key={profile.id}
                      skin={skin}
                      mini
                      variant="tab"
                      active={row.profileId === profile.id}
                      label={`${profile.name} · ${specOf(profile)}`}
                      onPress={() => onPatch(difficulty, { profileId: profile.id })}
                    />
                  ))}
                </View>

                <Text style={styles.meta}>{t("orch.route.pickClient")}</Text>
                <View style={styles.chips}>
                  {/* 宿主一个客户端都没报：不解释一句，这一排就是空的，下面还叫人「先选客户端」。 */}
                  {providers.length === 0 ? <Text style={styles.hint}>{t("orch.noProviders")}</Text> : null}
                  {providers.map((provider) => (
                    <PixelButton
                      key={provider.id}
                      skin={skin}
                      mini
                      variant="tab"
                      active={target?.provider === provider.id}
                      label={provider.id}
                      // 点已选中的客户端是无操作：否则会顺手把模型和档位一起清掉。
                      onPress={() => {
                        if (target?.provider === provider.id) return;
                        onPatch(difficulty, { target: { provider: provider.id } });
                      }}
                    />
                  ))}
                </View>

                {liveProfile ? (
                  // 走档案的档位：模型在档案里，这里没有可点的东西，说清楚去哪改，
                  // 别留一个空格子按钮让人以为「配过却不能用」。
                  <Text style={styles.hint}>
                    {t("orch.route.modelInProfile", { name: liveProfile.name, spec: specOf(liveProfile) })}
                  </Text>
                ) : (
                  <>
                    {/* 模型：宿主报出清单就点选，没报出来才回到手填。 */}
                    {target ? (
                      <ModelChoices
                        skin={skin}
                        t={t}
                        state={choices}
                        current={target.model ?? null}
                        // 换模型顺手清旧档位：档位按模型报，旧 id 可能不属于新模型。
                        onPick={(picked) => onPatch(difficulty, { target: withModelClearingThinking(target, picked) })}
                      />
                    ) : null}

                    <View style={styles.form}>
                      <TextInput
                        accessibilityLabel={t("orch.route.modelField")}
                        style={styles.input}
                        value={model}
                        onChangeText={setModel}
                        placeholder={t("orch.route.modelField")}
                        placeholderTextColor={skin.colors.ink2}
                        autoCapitalize="none"
                      />
                      <PixelButton
                        skin={skin}
                        mini
                        label={t("orch.route.useModel")}
                        disabled={busy || !model.trim() || !target}
                        onPress={() => {
                          if (!target) return;
                          onPatch(difficulty, { target: withModelClearingThinking(target, model.trim()) });
                          setModel("");
                        }}
                      />
                    </View>

                    {/* 档位：宿主为这个模型报了才出现；没报就只剩下面的手填框。 */}
                    {target ? (
                      <ThinkingChoices
                        skin={skin}
                        t={t}
                        state={thinkingChoicesOf(target.provider, target.model, providers)}
                        current={target.thinkingOptionId ?? null}
                        onPick={(thinkingOptionId) => onPatch(difficulty, { target: { ...target, thinkingOptionId } })}
                      />
                    ) : null}
                    <View style={styles.form}>
                      <TextInput
                        accessibilityLabel={t("orch.route.thinkingField")}
                        style={styles.input}
                        value={thinkingDraft}
                        onChangeText={(value) => setThinking((prev) => ({ ...prev, [difficulty]: value }))}
                        placeholder={t("orch.route.thinkingField")}
                        placeholderTextColor={skin.colors.ink2}
                        autoCapitalize="none"
                      />
                      <PixelButton
                        skin={skin}
                        mini
                        label={t("orch.route.useThinking")}
                        disabled={busy || !thinkingDraft.trim() || !target?.model?.trim()}
                        onPress={() => {
                          if (!target) return;
                          onPatch(difficulty, { target: { ...target, thinkingOptionId: thinkingDraft.trim() } });
                          setThinking((prev) => ({ ...prev, [difficulty]: "" }));
                        }}
                      />
                    </View>
                    {/* 宿主没报客户端时上面已经说了，这里不再叫「先选客户端」——没得选。 */}
                    {target || providers.length === 0 ? null : (
                      <Text style={styles.hint}>{t("orch.modelChoices.clientFirst")}</Text>
                    )}
                  </>
                )}
                {/* 清掉这一档：两种填法（档案 / 直填）都要能清，所以放在条件外面。 */}
                <View style={styles.form}>
                  <PixelButton
                    skin={skin}
                    mini
                    variant="ghost"
                    label={t("orch.clear")}
                    disabled={busy}
                    onPress={() => onPatch(difficulty, null)}
                  />
                </View>
              </>
            ) : null}
          </PixelCard>
        );
      })}
    </ScrollView>
  );
}
