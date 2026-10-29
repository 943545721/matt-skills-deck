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
  specOf,
  type ClientProfile,
  type ClientTarget,
  type Difficulty,
  type ProviderRow,
  type RoutingRow,
} from "./types.ts";

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
        const via = row.resolved.ok && row.resolved.via === "profile" ? ` · ${t("orch.route.viaProfile")}` : "";
        const summary = row.resolved.ok ? `${specOf(row.resolved.target)}${via}` : t("orch.route.empty");
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
                  {providers.map((provider) => (
                    <PixelButton
                      key={provider.id}
                      skin={skin}
                      mini
                      variant="tab"
                      active={row.target?.provider === provider.id && !row.profileId}
                      label={provider.id}
                      onPress={() => onPatch(difficulty, { target: { provider: provider.id } })}
                    />
                  ))}
                </View>
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
                    disabled={busy || !model.trim() || !row.target}
                    onPress={() => {
                      if (!row.target) return;
                      onPatch(difficulty, { target: { ...row.target, model: model.trim() } });
                      setModel("");
                    }}
                  />
                  <PixelButton
                    skin={skin}
                    mini
                    variant="ghost"
                    label={t("orch.clear")}
                    disabled={busy}
                    onPress={() => onPatch(difficulty, null)}
                  />
                </View>
                {!row.target ? <Text style={styles.hint}>{t("orch.route.clientFirst")}</Text> : null}
              </>
            ) : null}
          </PixelCard>
        );
      })}
    </ScrollView>
  );
}
