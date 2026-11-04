import { useMemo, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import {
  orchestrationDispatchRpc,
  type DispatchOutcomeWire,
} from "../../../../shared/orchestration-rpc.ts";
import { buildDispatchTask, type DispatchFormTask } from "../../../../shared/dispatch-form.ts";
import { repoTargetsRpc } from "../../../../shared/repo.ts";
import type { StaffCard } from "../../../../shared/staff.ts";
import type { PanelKey } from "../../panel/panelText.tsx";
import type { PixelSkin } from "../../pixel.tsx";
import { PixelButton } from "../../pixel.tsx";
import { OrchSection } from "./parts.tsx";

/**
 * 派单台：完全不经过模型的一条派单路。
 *
 * 它省掉的是「先开一个会话，让模型去调 `deck_dispatch_plan`」，**不是确认**：
 * 按下去仍然先建票、再建会话（服务端 `runDispatch` 的顺序没变），并且这里要多点一次
 * 「确认派出」——票建出来就删不干净，误点一次的代价比多点一次大。
 *
 * 面板只做「把表填成一份任务」和「把结果说清楚」；链条闸、repoKey 归属、层数、并发、
 * 名册不空时必须选卡这些判定全在服务端，前端只是提前把能说清的错说清楚
 * （见 `shared/dispatch-form.ts`，那里有单测）。
 */

type DispatchResponse =
  | { ok: true; results: DispatchOutcomeWire[]; warnings: string[] }
  | { ok: false; detail: string };

function useDispatchStyles(skin: PixelSkin) {
  return useMemo(
    () => ({
      hint: { color: skin.colors.ink2, fontSize: 11, lineHeight: 16, fontFamily: skin.mono.fontFamily },
      label: { color: skin.colors.ink2, fontSize: 11, fontFamily: skin.mono.fontFamily, paddingTop: 4 },
      warn: skin.error,
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 4 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 4, paddingTop: 2 },
      promptInput: { minHeight: 104, textAlignVertical: "top" as const },
      row: { gap: 2 },
    }),
    [skin],
  );
}

function Chips({
  skin,
  value,
  options,
  onPick,
  disabled,
}: {
  skin: PixelSkin;
  value: string | null;
  options: { id: string; label: string }[];
  onPick(id: string | null): void;
  disabled?: boolean;
}) {
  const styles = useDispatchStyles(skin);
  return (
    <View style={styles.chips}>
      {options.map((option) => (
        <PixelButton
          key={option.id}
          skin={skin}
          mini
          variant="outline"
          active={value === option.id}
          disabled={disabled}
          label={option.label}
          onPress={() => onPick(value === option.id ? null : option.id)}
        />
      ))}
    </View>
  );
}

export function DispatchPanel({
  skin,
  t,
  lang,
  workspaceId,
  workspaceDir,
  cards,
}: {
  skin: PixelSkin;
  t(key: PanelKey, vars?: Record<string, string | number>): string;
  lang: "zh" | "en";
  workspaceId: string;
  workspaceDir: string;
  cards: readonly StaffCard[];
}) {
  const styles = useDispatchStyles(skin);
  // 语言跟界面走（`zh` → 中文）。`t` 只解决界面文案，派单抬头由服务端拼，得单独传。
  const dispatchRpc = useRpc(orchestrationDispatchRpc);
  const repoRpc = useRpc(repoTargetsRpc);

  const repoListing = useQuery({
    queryKey: ["deck", "repo", "targets", workspaceDir],
    queryFn: () => repoRpc({ workspaceDir }),
    enabled: Boolean(workspaceDir),
    staleTime: 60_000,
    retry: false,
  });
  const repos = repoListing.data?.ok ? repoListing.data.repos : [];
  const multiRepo = repos.length > 1;
  // 读不出仓库清单时 `repos` 是空的：芯片与 `repoRequired` 会一起消失，看起来像「单仓库」。
  // 这里必须把「不知道」说出来（同 `server/tracker/targets.ts` 那句：缺失不能看起来像不存在）。
  // `no-repo` 不是失败——那就是单仓库工作区，不用提示。
  const repoProblem = ((): string | null => {
    if (repoListing.isError) return t("orch.dispatch.repoUnknown");
    const listing = repoListing.data;
    // `no-repo` 不是失败：那就是单仓库工作区，不该提示。
    if (!listing || listing.ok || listing.reason === "no-repo") return null;
    return `${t("orch.dispatch.repoUnknown")}${listing.detail}`;
  })();

  const [requirementText, setRequirementText] = useState("");
  const [requirementRepo, setRequirementRepo] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [repoKey, setRepoKey] = useState<string | null>(null);
  const [pathPrefix, setPathPrefix] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState<DispatchFormTask | null>(null);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DispatchResponse | null>(null);

  const requirementNumber = requirementText.trim() ? Number(requirementText.trim()) : null;
  // 按过「派出去」之后就锁表：`pending` 里的那份任务不会再重生，表还能改就等于
  // 「屏幕上看到的」和「确认时派出去的」是两件事。要改先按「取消」。
  const locked = pending !== null || running;

  const arm = () => {
    const built = buildDispatchTask({
      // key 一下就好：同一批里唯一即可，它也是重试时的幂等键，所以存进 `pending` 后不再重生。
      key: `desk-${Date.now().toString(36)}`,
      prompt,
      title,
      ...(staffId ? { staffId } : {}),
      ...(repoKey ? { repoKey } : {}),
      pathPrefix,
      requirementNumber,
      ...(requirementRepo ? { requirementRepoKey: requirementRepo } : {}),
      staffRequired: cards.length > 0,
      repoRequired: multiRepo,
    });
    if (!built.ok) {
      setProblem(built.problem);
      return;
    }
    setProblem(null);
    setOutcome(null);
    setPending(built.task);
  };

  const submit = async () => {
    if (!pending || running) return;
    setRunning(true);
    try {
      const result = await dispatchRpc({ workspaceId, workspaceDir, tasks: [pending], lang });
      if (!result.ok) {
        setOutcome({ ok: false, detail: result.detail });
        return;
      }
      setOutcome({ ok: true, results: result.results, warnings: result.warnings });
      setPending(null);
      // 派完就把提示词清掉：同一段话再派一次几乎总是手滑。
      setPrompt("");
      setTitle("");
    } catch (error) {
      setOutcome({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16, gap: 10 }}>
      <OrchSection skin={skin} title={t("orch.dispatch.title")} aside={t("orch.dispatch.staffCount", { n: cards.length })}>
        <Text style={styles.hint}>{t("orch.dispatch.blurb")}</Text>

        <View style={styles.row}>
          <Text style={styles.label}>{t("orch.dispatch.requirement")}</Text>
          <TextInput
            accessibilityLabel={t("orch.dispatch.requirement")}
            style={skin.input}
            value={requirementText}
            onChangeText={setRequirementText}
            keyboardType="number-pad"
            editable={!locked}
            placeholder="#"
            placeholderTextColor={skin.colors.ink2}
          />
          <Text style={styles.hint}>{t("orch.dispatch.requirementHint")}</Text>
        </View>

        {multiRepo && requirementText.trim() ? (
          <View style={styles.row}>
            <Text style={styles.label}>{t("orch.dispatch.requirementRepo")}</Text>
            <Chips
              skin={skin}
              value={requirementRepo}
              options={repos.map((repo) => ({ id: repo.key, label: repo.key }))}
              onPick={setRequirementRepo}
              disabled={locked}
            />
          </View>
        ) : null}

        <View style={styles.row}>
          <Text style={styles.label}>{t("orch.dispatch.staff")}</Text>
          {cards.length === 0 ? <Text style={styles.hint}>{t("orch.dispatch.staffEmpty")}</Text> : null}
          <Chips
            skin={skin}
            value={staffId}
            options={cards.map((card) => ({ id: card.id, label: card.name || card.id }))}
            onPick={setStaffId}
            disabled={locked}
          />
        </View>

        {repoProblem ? <Text style={styles.warn}>{repoProblem}</Text> : null}

        {multiRepo ? (
          <View style={styles.row}>
            <Text style={styles.label}>{t("orch.dispatch.repo")}</Text>
            <Chips
              skin={skin}
              value={repoKey}
              options={repos.map((repo) => ({ id: repo.key, label: repo.key }))}
              onPick={setRepoKey}
              disabled={locked}
            />
          </View>
        ) : null}

        <View style={styles.row}>
          <Text style={styles.label}>{t("orch.dispatch.region")}</Text>
          <TextInput
            accessibilityLabel={t("orch.dispatch.region")}
            style={skin.input}
            value={pathPrefix}
            onChangeText={setPathPrefix}
            editable={!locked}
            placeholder="apps/web"
            placeholderTextColor={skin.colors.ink2}
          />
          <Text style={styles.hint}>{t("orch.dispatch.regionHint")}</Text>
        </View>

        <View style={styles.row}>
          <Text style={styles.label}>{t("orch.dispatch.titleField")}</Text>
          <TextInput
            accessibilityLabel={t("orch.dispatch.titleField")}
            style={skin.input}
            value={title}
            onChangeText={setTitle}
            editable={!locked}
            placeholderTextColor={skin.colors.ink2}
          />
        </View>

        <View style={styles.row}>
          <Text style={styles.label}>{t("orch.dispatch.prompt")}</Text>
          <TextInput
            accessibilityLabel={t("orch.dispatch.prompt")}
            style={[skin.input, styles.promptInput]}
            value={prompt}
            onChangeText={setPrompt}
            editable={!locked}
            multiline
            placeholder={t("orch.dispatch.promptPlaceholder")}
            placeholderTextColor={skin.colors.ink2}
          />
        </View>

        {pending ? (
          <View style={styles.actions}>
            <Text style={styles.hint}>{t("orch.dispatch.summary")}</Text>
            <PixelButton
              skin={skin}
              mini
              label={running ? t("orch.dispatch.running") : t("orch.dispatch.confirm")}
              disabled={running}
              onPress={() => void submit()}
            />
            <PixelButton
              skin={skin}
              mini
              variant="ghost"
              label={t("orch.dispatch.cancel")}
              disabled={running}
              onPress={() => setPending(null)}
            />
          </View>
        ) : (
          <View style={styles.actions}>
            <PixelButton skin={skin} mini variant="outline" label={t("orch.dispatch.arm")} disabled={locked} onPress={arm} />
          </View>
        )}

        {problem ? <Text style={styles.warn}>{problem}</Text> : null}
        {outcome && !outcome.ok ? <Text style={styles.warn}>{`${t("orch.dispatch.failed")}${outcome.detail}`}</Text> : null}
        {outcome && outcome.ok ? (
          <>
            <Text style={styles.hint}>
              {t("orch.dispatch.done", {
                ok: outcome.results.filter((row) => row.ok).length,
                bad: outcome.results.filter((row) => !row.ok).length,
              })}
            </Text>
            {outcome.results.map((row) =>
              row.ok ? (
                // `ok` 不等于「全都写进去了」：`partial` 时会话起来了，但标签 / 父票没落地，
                // 票是真的、那些要人补（`ticketNotes`）。画成全绿等于把要补的活吞掉。
                <View key={row.key} style={styles.row}>
                  <Text style={styles.hint}>
                    {[
                      row.title ?? row.key,
                      t("orch.dispatch.session", { id: row.agentId.slice(0, 8) }),
                      row.ticket ? t("orch.dispatch.ticket", { number: row.ticket.number }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                  {row.partial ? (
                    <Text style={styles.warn}>{`${t("orch.dispatch.partial")}${row.failureDetail ?? ""}`}</Text>
                  ) : null}
                  {row.ticketNotes.map((note, index) => (
                    <Text key={`${index}-${note}`} style={styles.warn}>{note}</Text>
                  ))}
                </View>
              ) : (
                <Text key={row.key} style={styles.warn}>
                  {`${row.key}：${row.detail}`}
                </Text>
              ),
            )}
            {outcome.warnings.length > 0 ? <Text style={styles.hint}>{t("orch.dispatch.warnings")}</Text> : null}
            {outcome.warnings.map((warning, index) => (
              // 同一句警告出现两次是可能的（同一批两条任务撞同一个理由），别用正文当 key。
              <Text key={`${index}-${warning}`} style={styles.hint}>{warning}</Text>
            ))}
          </>
        ) : null}
      </OrchSection>
    </ScrollView>
  );
}
