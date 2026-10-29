import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { issuesCreateRpc } from "../../shared/issues";
import {
  activeNewIssueRepoKey,
  planCurrentSettleNotice,
  planLateFailure,
  planLateSuccess,
  sameNewIssueDraft,
  writableNewIssueRepos,
  type LateNotice,
  type NewIssueDraft,
  type NewIssueRepo,
} from "../../shared/new-issue";
import { PixelButton, PixelModalBody, usePixel } from "./pixel";
import { FAILURE_KEYS, staticText, useDeckText } from "./i18n";

/**
 * 普通建票表单。
 *
 * DSH 的「新建需求」与「+ bug」在 RequirementEntry 里：点卡直接带着技能
 * 开场白创建新会话，不先建票。这个窗口只保留它自己的职责——手动写一张普通票。
 */
export function NewIssueModal({
  theme,
  workspaceDir,
  repos,
  defaultRepoKey,
  open,
  onClose,
  onCreated,
}: {
  theme: PluginTheme;
  workspaceDir: string;
  /** 工作区里的全部仓库；只读目标不能建票。 */
  repos: NewIssueRepo[];
  /** 当前筛选的仓库：新建时默认落到它上面。 */
  defaultRepoKey: string | null;
  open: boolean;
  onClose(): void;
  /** 建票成功后把界面切到能看见它的位置（仓库 / 页签 / 视图）。 */
  onCreated?(repoKey: string): void;
}) {
  const { t } = useDeckText();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [isMap, setIsMap] = useState(false);
  const [pickedRepo, setPickedRepo] = useState<string | null>(null);
  /** 迟到的结果提示：只存事实（哪一代、票号、是否还有未知请求），文案在渲染时算。 */
  const [lateNotice, setLateNotice] = useState<LateNotice | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();
  const skin = usePixel(theme);

  const createIssue = useRpc(issuesCreateRpc);
  // 只读目标不要列成可选：能不能写由服务端每次操作的权限闸门判断，别让「创建」看起来成功。
  const writableRepos = writableNewIssueRepos(repos);
  const activeRepoKey = activeNewIssueRepoKey(repos, pickedRepo, defaultRepoKey);
  const blocked = repos.length > 0 && writableRepos.length === 0;

  /**
   * 每次提交的代次。宿主 RPC 没有客户端超时，强制关闭时必须立刻释放 busy；
   * 旧请求迟到的成功 / 失败只认代次，不能清掉之后重新输入或重新提交的草稿。
   */
  const seqRef = useRef(0);
  const activeTokenRef = useRef<number | null>(null);
  /** 强制关闭后还没等到结果的代次：结果未知时，重开 / 重新提交都要保留警告。 */
  const unsettledRef = useRef<Set<number>>(new Set());
  /** 已经结算过的最大代次：用来区分「之后又有提交已结束」和普通迟到。 */
  const settledRef = useRef(0);
  /** 最近一次成功建票：旧的强制关闭请求失败时，用它判断「之后其实已经建过票」。 */
  const lastCreatedRef = useRef<{ token: number; number: number } | null>(null);
  const [submittingToken, setSubmittingToken] = useState<number | null>(null);
  const draftRef = useRef<NewIssueDraft>({
    title: "",
    body: "",
    labels: "",
    mode: "issue",
    bug: { actual: "", expected: "", reproduce: "", environment: "" },
    bugDiagnosed: false,
    isMap: false,
    copyPrompt: false,
    repoKey: null,
  });
  draftRef.current = {
    title: title.trim(),
    body,
    labels,
    mode: "issue",
    bug: { actual: "", expected: "", reproduce: "", environment: "" },
    bugDiagnosed: false,
    isMap,
    copyPrompt: false,
    repoKey: activeRepoKey,
  };

  // 提示只存事实；这样当前提交结束后，「还在提交」之类的旧措辞会自动消失。
  const lateNoticeText = (notice: LateNotice | null): string | null => {
    if (!notice) return null;
    if (notice.kind === "force-closed") return t("new.forceClosedNotice");
    if (notice.kind === "maybe-created") return t("new.maybeCreatedNotice");
    if (notice.kind === "force-closed-failed") {
      return notice.createdNumber === null
        ? t("new.forceClosedFailed")
        : t("new.lateFailedAfterCreated", { number: notice.createdNumber });
    }
    const base =
      notice.notice === "still-pending"
        ? t("new.lateCreatedDuringSubmit", { number: notice.number })
        : notice.notice === "after-new-submit"
          ? t("new.lateCreatedAfterNew", { number: notice.number })
          : notice.notice === "newer-unsettled"
            ? t("new.lateCreatedNewerUnsettled", { number: notice.number })
            : notice.notice === "cleared"
              ? t("new.lateCreatedCleared", { number: notice.number })
              : t("new.lateCreatedKept", { number: notice.number });
    return notice.unseen ? `${base} ${t("new.stillUnsettledSuffix")}` : base;
  };
  const lateNoticeBody = lateNoticeText(lateNotice);

  const resetForm = () => {
    setTitle("");
    setBody("");
    setLabels("");
    setIsMap(false);
    setPickedRepo(null);
  };

  const submit = async () => {
    // 同一时刻只允许一个提交：第二次点击在 rerender 前也能被这个 ref 挡住。
    if (activeTokenRef.current !== null) return;
    const token = ++seqRef.current;
    const draft = draftRef.current;
    activeTokenRef.current = token;
    setSubmittingToken(token);
    // 还有强制关闭后未返回的旧请求，或上一条提示是「票可能已建」时，别清掉警告。
    // （后者可能来自一次结果不确定的失败：超时 / 5xx 之后重提就是重复票。）
    if (
      unsettledRef.current.size === 0 &&
      lateNotice?.kind !== "force-closed" &&
      lateNotice?.kind !== "maybe-created"
    ) {
      setLateNotice(null);
    }
    setSlow(false);

    const submittedLabels = draft.labels
      .split(/[,，]/)
      .map((name) => name.trim())
      .filter(Boolean);
    const finalLabels = [...new Set(submittedLabels)];
    const bodyText = draft.body;
    try {
      const result = await createIssue({
        workspaceDir,
        repoKey: draft.repoKey ?? undefined,
        title: draft.title,
        body: bodyText,
        labels: finalLabels,
        isMap: draft.isMap,
      });
      if (!result.ok) {
        settledRef.current = Math.max(settledRef.current, token);
        const detail = `${t("new.failed")}：${staticText(t, FAILURE_KEYS[result.reason] ?? "failure.read")} — ${result.detail}`;
        if (activeTokenRef.current === token) {
          toast.show(detail, { variant: "error" });
          // 当前这次既然结束了，指向它的「还在提交」提示就不能继续挂着；
          // 但失败不等于没建（超时 / 5xx），这种未知要留下警告。
          setLateNotice(planCurrentSettleNotice(unsettledRef.current.size, result.maybeCreated === true));
        } else {
          unsettledRef.current.delete(token);
          toast.show(t("new.lateFailed", { detail }), { variant: "error" });
          const newerCreated = lastCreatedRef.current;
          setLateNotice(
            planLateFailure({
              remainingUnsettled: unsettledRef.current.size,
              maybeCreated: result.maybeCreated === true,
              newerPending: activeTokenRef.current !== null,
              newerCreatedNumber:
                newerCreated && newerCreated.token > token ? newerCreated.number : null,
            }),
          );
        }
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["deck", "issues", workspaceDir] });
      // 记录最近一次成功建票：之后若有更旧的强制关闭请求失败，不能再提示「可以重新提交」。
      if (!lastCreatedRef.current || token > lastCreatedRef.current.token) {
        lastCreatedRef.current = { token, number: result.number };
      }
      // 代次已变：强制关闭过，或用户已经发起了下一次提交。票确实建好了，但别碰当前草稿。
      if (activeTokenRef.current !== token) {
        // 先算「之后有没有更新的提交」，再更新已结算代次。
        const newerPending = activeTokenRef.current !== null;
        const newerSettled = settledRef.current > token;
        unsettledRef.current.delete(token);
        const newerUnsettled = [...unsettledRef.current].some((value) => value > token);
        settledRef.current = Math.max(settledRef.current, token);
        const plan = planLateSuccess({
          newerPending,
          newerSettled,
          newerUnsettled,
          draftUnchanged: sameNewIssueDraft(draft, draftRef.current),
          remainingUnsettled: unsettledRef.current.size,
        });
        const lateBase = result.labelsFailed
          ? t("new.lateDoneLabelsFailed", { number: result.number })
          : t("new.lateCreatedToast", { number: result.number });
        toast.show(lateBase, { variant: "warning" });
        // 票已经建出来了，必须让任务板切过去；即使有更新的提交，也不能让这张票不可见。
        // 但 keep 的草稿目标不能被板子筛选改掉：onCreated 会改 defaultRepoKey，
        // 这里把迟到的票落地前、当前草稿的目标仓库重新钉住。
        const keepRepo = draftRef.current.repoKey;
        onCreated?.(result.repoKey);
        if (plan.draft === "keep" && keepRepo) setPickedRepo(keepRepo);
        if (plan.draft === "clear") resetForm();
        setLateNotice({
          kind: "late-created",
          notice: plan.notice,
          number: result.number,
          unseen: plan.unseen,
        });
        return;
      }
      settledRef.current = Math.max(settledRef.current, token);
      const done = result.labelsFailed
        ? t("new.doneLabelsFailed", { number: result.number })
        : t("new.done", { number: result.number });
      const variant = result.labelsFailed ? ("warning" as const) : ("success" as const);
      toast.show(done, { variant });
      // 在「拉取请求」页签或别的仓库筛选下建票时，不切过去就等于「建完什么都没发生」。
      onCreated?.(result.repoKey);
      // 先释放 busy 再关：程序化关闭若触发 Modal.onOpenChange，不会再弹「正在创建」。
      activeTokenRef.current = null;
      setSubmittingToken(null);
      resetForm();
      // 还有旧请求没结算时，换成统一的「票可能已建」警告；否则旧提示已过期。
      setLateNotice(planCurrentSettleNotice(unsettledRef.current.size));
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settledRef.current = Math.max(settledRef.current, token);
      if (activeTokenRef.current === token) {
        toast.error(message);
        // 通道异常同样不能证明没建：保留「先核对任务板」的警告。
        setLateNotice(planCurrentSettleNotice(unsettledRef.current.size, true));
      } else {
        unsettledRef.current.delete(token);
        toast.show(t("new.lateFailed", { detail: message }), { variant: "error" });
        const newerCreated = lastCreatedRef.current;
        setLateNotice(
          planLateFailure({
            remainingUnsettled: unsettledRef.current.size,
            maybeCreated: true,
            newerPending: activeTokenRef.current !== null,
            newerCreatedNumber:
              newerCreated && newerCreated.token > token ? newerCreated.number : null,
          }),
        );
      }
    } finally {
      // 只有当前代次能释放 busy；旧请求不能把新提交的锁解开。
      if (activeTokenRef.current === token) {
        activeTokenRef.current = null;
        setSubmittingToken(null);
      }
    }
  };

  const busy = submittingToken !== null;
  const canSubmit = !busy && !blocked && Boolean(title.trim());
  // 建票 + 改标签最多两次 gh（各 20s）；45s 还没回来就允许用户强行关闭。
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), 45_000);
    return () => clearTimeout(timer);
  }, [busy]);
  // 建票已经发出时默认不许关：否则「取消」看起来成功了，票其实已经建出来。
  // 用 ref 而不是渲染态 busy：成功路径会先作废代次再关窗，避免程序化关闭时误弹「正在创建」。
  const requestClose = (force = false) => {
    if (activeTokenRef.current !== null) {
      if (!force || !slow) {
        toast.show(t("new.busy"), { variant: "warning" });
        return;
      }
      // 请求可能永远不 settle：作废当前代次并立即释放 busy，重开弹窗后可以重新提交。
      // 旧请求迟到时只刷新板子 / 给出迟到提示，不再碰之后的草稿。
      const abandoned = activeTokenRef.current;
      if (abandoned !== null) unsettledRef.current.add(abandoned);
      activeTokenRef.current = null;
      setSubmittingToken(null);
      setSlow(false);
      // 重开时先看到这条，避免在旧请求还没回来时又提一遍同一张票。
      setLateNotice({ kind: "force-closed" });
    }
    onClose();
  };

  // 关闭弹窗或切换工作区后，下一次打开跟随任务板当前筛选；别让上一次手选的仓库继续盖住默认值。
  // 但强制关闭后还有结果未知的请求时不清：自动回退会改掉 draftRef.repoKey，
  // 让迟到成功误判成「用户改过仓库」，提示失真。
  useEffect(() => {
    if (unsettledRef.current.size > 0 || activeTokenRef.current !== null) return;
    setPickedRepo(null);
  }, [workspaceDir, open]);

  const styles = useMemo(
    () => ({
      body: { gap: 10 },
      field: { gap: 4 },
      fieldLabel: { ...skin.label },
      hint: skin.hint,
      warnText: { ...skin.hint, color: skin.colors.warn },
      input: skin.input,
      inputBody: { minHeight: 120 },
      inputTall: { minHeight: 72 },
      inputShort: { minHeight: 44 },
      actions: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const, flexWrap: "wrap" as const },
    }),
    [skin],
  );

  return (
    <Modal title={t("new.title")} open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
      <Modal.Content>
        <PixelModalBody skin={skin} style={styles.body}>
          <TextInput
            accessibilityLabel={t("new.titleField")}
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            editable={!busy}
            placeholder={t("new.titleField")}
            placeholderTextColor={skin.colors.ink2}
          />
          <TextInput
            accessibilityLabel={t("new.bodyField")}
            style={[styles.input, styles.inputBody]}
            value={body}
            onChangeText={setBody}
            editable={!busy}
            placeholder={t("new.bodyField")}
            placeholderTextColor={skin.colors.ink2}
            multiline
          />
          <TextInput
            accessibilityLabel={t("new.labelsField")}
            style={styles.input}
            value={labels}
            onChangeText={setLabels}
            editable={!busy}
            placeholder={t("new.labelsField")}
            placeholderTextColor={skin.colors.ink2}
          />
          {writableRepos.length > 1 ? (
            <View style={styles.actions}>
              <Text style={styles.hint}>{t("new.repoLabel")}</Text>
              {writableRepos.map((repo) => (
                <PixelButton
                  key={repo.key}
                  skin={skin}
                  variant="tab"
                  label={repo.name}
                  active={activeRepoKey === repo.key}
                  disabled={busy}
                  onPress={() => setPickedRepo(repo.key)}
                />
              ))}
            </View>
          ) : null}
          {blocked ? <Text style={styles.hint}>{t("new.noWritable")}</Text> : null}

          <View style={styles.actions}>
            <PixelButton
              skin={skin}
              label={isMap ? t("new.markMapOn") : t("new.markMap")}
              active={isMap}
              disabled={busy}
              onPress={() => setIsMap((value) => !value)}
            />
          </View>

          {lateNoticeBody ? <Text style={styles.warnText}>{lateNoticeBody}</Text> : null}
          {busy ? <Text style={styles.hint}>{slow ? t("new.busySlow") : t("new.busy")}</Text> : null}
          <View style={styles.actions}>
            <PixelButton
              skin={skin}
              label={busy ? t("new.submitting") : t("new.submit")}
              disabled={!canSubmit}
              onPress={() => void submit()}
            />
            <PixelButton skin={skin} label={t("common.cancel")} disabled={busy} onPress={() => requestClose()} />
            {slow ? (
              <PixelButton skin={skin} label={t("new.forceClose")} onPress={() => requestClose(true)} />
            ) : null}
          </View>
          <Text style={styles.hint}>{t("new.hint")}</Text>
        </PixelModalBody>
      </Modal.Content>
    </Modal>
  );
}
