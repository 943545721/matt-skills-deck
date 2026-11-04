import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { issuesCreateRpc } from "../../shared/issues";
import { areaLabelName, roleLabelName } from "../../shared/labels";
import { workspaceProjectsRpc } from "../../shared/repo";
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
import {
  deckLang,
  mergeRequirementLabels,
  planRequirementBody,
  type RequirementMode,
} from "../../shared/requirement.ts";
import { PixelButton, PixelModalBody, usePixel } from "./pixel";
import { FAILURE_KEYS, staticText, useDeckText } from "./i18n";
import { usePanelText } from "./panel/panelText";

/** `.paseo-deck.json` 里的一行项目（只取这个窗口要用的字段）。 */
interface ProjectRow {
  key: string;
  repo: string | null;
  owner: string | null;
  areas: string[];
  resolved: { owner: string; name: string } | null;
  problem: string | null;
}

/** 项目对应哪个仓库键（`owner/name`）：配置里写的优先，其次磁盘上认出来的远端。 */
function projectRepoKeyOf(project: ProjectRow): string | null {
  if (project.repo) return project.repo;
  return project.resolved ? `${project.resolved.owner}/${project.resolved.name}` : null;
}

/** 仓库键比较不分大小写：GitHub 的 owner/name 本来就不分，配置是手写的更容易大小写不一。 */
function sameRepoKey(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * 建票表单：普通票，或带六节骨架 + 影响面表的需求票。
 *
 * 从前它只建普通票，需求入口只开会话、不建票；现在「新建需求」也走这里，
 * 由票型决定正文骨架与 `requirement` 标签。开会话谈需求是另一扇门（「探讨需求」）。
 *
 * 多项目工作区（v2 清单里有两个以上项目）多两步：先选项目、再选模块，然后才是票型。
 * 项目决定票落在哪个仓库，模块决定 `area:<k>` 标签；项目有 owner 时再带 `role:<owner>`。
 * 单项目工作区这两步不出现，布局与以前一样——没有清单时客户端一个标签都不自己加。
 */
/** 表单能建的三类票：普通票，或两种需求票（决定六节骨架的形状）。 */
export type NewIssueChoice = "issue" | RequirementMode;

const MODE_CHOICES: readonly { mode: NewIssueChoice; label: "new.modeIssue" | "new.modeExplore" | "new.modeImplement" }[] = [
  { mode: "issue", label: "new.modeIssue" },
  { mode: "explore", label: "new.modeExplore" },
  { mode: "implement", label: "new.modeImplement" },
];

export function NewIssueModal({
  theme,
  workspaceDir,
  repos,
  defaultRepoKey,
  defaultMode = "issue",
  open,
  inline = false,
  onClose,
  onCreated,
}: {
  theme: PluginTheme;
  workspaceDir: string;
  /** 工作区里的全部仓库；只读目标不能建票。 */
  repos: NewIssueRepo[];
  /** 当前筛选的仓库：新建时默认落到它上面。 */
  defaultRepoKey: string | null;
  /** 打开时预选的票型；面板的「新建需求」用它预选探索需求。 */
  defaultMode?: NewIssueChoice;
  open: boolean;
  /** 整页入口用：把表单直接铺在页面上，不套宿主 Modal，`open` 也被忽略。 */
  inline?: boolean;
  onClose(): void;
  /** 建票成功后把界面切到能看见它的位置（仓库 / 页签 / 视图）。 */
  onCreated?(repoKey: string): void;
}) {
  const { t, locale } = useDeckText();
  const lang = deckLang(locale);
  // 新增的两步（项目 / 模块）文案走「本线新增」的键，不往 messages.ts 里塞。
  const { t: tp } = usePanelText();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [mode, setMode] = useState<NewIssueChoice>(defaultMode);
  const [isMap, setIsMap] = useState(false);
  const [pickedRepo, setPickedRepo] = useState<string | null>(null);
  /** 手选的项目键：多项目工作区里决定「票落在哪个仓库、属于哪个模块」。 */
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  /** 手选的模块键：必须是该项目 areas 里的一个。 */
  const [pickedArea, setPickedArea] = useState<string | null>(null);
  /** 迟到的结果提示：只存事实（哪一代、票号、是否还有未知请求），文案在渲染时算。 */
  const [lateNotice, setLateNotice] = useState<LateNotice | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();
  const skin = usePixel(theme);

  const createIssue = useRpc(issuesCreateRpc);
  // 只读目标不要列成可选：能不能写由服务端每次操作的权限闸门判断，别让「创建」看起来成功。
  const writableRepos = writableNewIssueRepos(repos);
  const blocked = repos.length > 0 && writableRepos.length === 0;

  // 项目清单是只读的：它只回答「有哪些项目、各自有哪些模块、属于哪个仓库」。
  const readProjects = useRpc(workspaceProjectsRpc);
  const projectList = useQuery({
    queryKey: ["deck", "workspace-projects", workspaceDir],
    queryFn: () => readProjects({ workspaceDir }),
    staleTime: 60_000,
  });
  // 只有 v2 清单里有两个以上项目才算多项目工作区：v1 / 没配置 / 只有一个项目都保持原布局。
  const projects: ProjectRow[] = projectList.data?.ok && projectList.data.kind === "v2" ? projectList.data.projects : [];
  const multiProject = projects.length > 1;

  const isWritableRepo = (key: string | null): key is string =>
    key !== null && writableRepos.some((repo) => sameRepoKey(repo.key, key));
  /** 没手选项目时跟随任务板当前筛选：默认项已经高亮，不用人再点一次。 */
  const projectOfBoardRepo = multiProject
    ? (projects.find((project) => sameRepoKey(projectRepoKeyOf(project), activeNewIssueRepoKey(repos, pickedRepo, defaultRepoKey))) ?? null)
    : null;
  const selectedProject = multiProject
    ? (projects.find((project) => project.key === pickedProject) ?? projectOfBoardRepo)
    : null;
  const selectedProjectRepo = selectedProject ? projectRepoKeyOf(selectedProject) : null;
  const projectRepoWritable = isWritableRepo(selectedProjectRepo);
  const selectedAreas = selectedProject?.areas ?? [];

  /**
   * 多项目工作区里仓库由项目决定：项目没选、或它的仓库不能写，就明确不给建，
   * 绝不退回「第一个可写仓库」——那会把票建进一个用户没看过的项目。
   */
  const activeRepoKey = multiProject
    ? (projectRepoWritable ? selectedProjectRepo : null)
    : activeNewIssueRepoKey(repos, pickedRepo, defaultRepoKey);

  /** 提交前要给人确认的自动标签：与服务端同一套拼法（`area:<k>` / `role:<owner>`）。 */
  const scopedLabels: string[] = multiProject && selectedProject
    ? [
        ...(pickedArea ? [areaLabelName(pickedArea)] : []),
        ...(selectedProject.owner ? [roleLabelName(selectedProject.owner)] : []),
      ]
    : [];

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
    mode: defaultMode,
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
    mode,
    bug: { actual: "", expected: "", reproduce: "", environment: "" },
    bugDiagnosed: false,
    isMap,
    copyPrompt: false,
    repoKey: activeRepoKey,
  };
  /**
   * 项目 / 模块的提交快照。
   *
   * `NewIssueDraft`（shared/new-issue.ts）不认识这两个字段，也不该为了这一处去改它；
   * 于是单独记一份，提交那一刻取用，效果与 draftRef 一致。
   */
  const scopeRef = useRef<{ project: string | null; area: string | null; labels: string[] }>({
    project: null,
    area: null,
    labels: [],
  });
  scopeRef.current = { project: selectedProject?.key ?? null, area: pickedArea, labels: scopedLabels };

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

  /** 选项目：仓库跟着项目走；模块属于项目，换项目就清空——留着会挂着上一个项目的键。 */
  const pickProject = (project: ProjectRow) => {
    setPickedProject(project.key);
    setPickedArea(null);
    const repoKey = projectRepoKeyOf(project);
    setPickedRepo(isWritableRepo(repoKey) ? repoKey : null);
  };

  /**
   * 选票型：切到需求时把当前正文铺成六节 + 影响面表。
   * 已经有 `## ` 小节就原样保留（用户可能自己重写过）；纯散文当成备注套进去，
   * 不把用户刚写的那段吞掉。切回普通票不改正文——删除文字要由用户自己按。
   */
  const pickMode = (next: NewIssueChoice) => {
    setMode(next);
    if (next === "issue") return;
    setIsMap(false);
    setBody((current) => planRequirementBody(next, current, lang));
  };

  const resetForm = () => {
    setTitle("");
    setBody("");
    setLabels("");
    setMode(defaultMode);
    setIsMap(false);
    setPickedRepo(null);
    setPickedProject(null);
    setPickedArea(null);
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

    const requirementMode =
      draft.mode === "explore" || draft.mode === "implement" ? draft.mode : null;
    const typedLabels = draft.labels
      .split(/[,，]/)
      .map((name) => name.trim())
      .filter(Boolean);
    // 需求票的正文与标签在提交这一刻定形：即使人在切换票型后又把正文清空，
    // 建出来的仍是一张有六节骨架、带 requirement 的票（闸门靠它认得出来）。
    const submittedLabels = requirementMode ? mergeRequirementLabels(typedLabels) : typedLabels;
    const bodyText = requirementMode ? planRequirementBody(requirementMode, draft.body, lang) : draft.body;
    try {
      const result = await createIssue({
        workspaceDir,
        repoKey: draft.repoKey ?? undefined,
        title: draft.title,
        body: bodyText,
        labels: submittedLabels,
        isMap: draft.isMap,
        // 项目 / 模块只报名字，`area:*` / `role:*` 由服务端核对后并进标签：
        // 界面自己拼一套、服务端再判一套，两边口径一歪就会写出挂着错标签的票。
        ...(scopeRef.current.project ? { project: scopeRef.current.project } : {}),
        ...(scopeRef.current.area ? { area: scopeRef.current.area } : {}),
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
  // 多项目工作区里项目必选：项目决定仓库，模块决定 area 标签，缺哪一步都不给建。
  // 项目登记了模块就必须选一个：不选就建出来的票不带 area，按 area 筛人的时候它会消失。
  const projectReady = !multiProject || (selectedProject !== null && projectRepoWritable);
  const areaReady = !multiProject || selectedAreas.length === 0 || pickedArea !== null;
  const canSubmit = !busy && !blocked && Boolean(title.trim()) && projectReady && areaReady;
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
    // 项目 / 模块不跨窗口保留：下次打开跟着当前筛选重新对一遍。
    setPickedProject(null);
    setPickedArea(null);
    // 票型回到入口给的默认值：面板「新建需求」每次打开都预选探索需求。
    setMode(defaultMode);
  }, [workspaceDir, open, defaultMode]);

  /** 提交前的一行交代：还缺哪一步，或者这次会带哪些标签。 */
  const scopeHint: string | null = !multiProject
    ? null
    : selectedProject === null
      ? tp("newIssue.pickProject")
      : !projectRepoWritable
        ? // 项目的仓库不能写：上面那条警示已经说明了原因，这里不再重复。
          null
        : selectedAreas.length > 0 && pickedArea === null
          ? tp("newIssue.pickArea")
          : scopedLabels.length > 0
            ? tp("newIssue.autoLabels", { labels: scopedLabels.join(" ") })
            : tp("newIssue.noAutoLabels");

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

  const content = (
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
          {/* 票型：普通票，或两种需求票（决定六节骨架的形状与 requirement 标签）。 */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t("new.kindLabel")}</Text>
            <View style={styles.actions}>
              {MODE_CHOICES.map((choice) => (
                <PixelButton
                  key={choice.mode}
                  skin={skin}
                  variant="tab"
                  label={t(choice.label)}
                  active={mode === choice.mode}
                  disabled={busy}
                  onPress={() => pickMode(choice.mode)}
                />
              ))}
            </View>
            <Text style={styles.hint}>{t("new.modeHint")}</Text>
          </View>
          {/* 项目 → 模块 → 票型：多项目工作区才出现前两步，单项目保持原布局。 */}
          {multiProject ? (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{tp("newIssue.project")}</Text>
              <View style={styles.actions}>
                {projects.map((project) => {
                  const writable = isWritableRepo(projectRepoKeyOf(project));
                  return (
                    <PixelButton
                      key={project.key}
                      skin={skin}
                      variant="tab"
                      label={project.key}
                      active={selectedProject?.key === project.key}
                      disabled={busy || !writable}
                      onPress={() => pickProject(project)}
                    />
                  );
                })}
              </View>
              <Text style={styles.hint}>{tp("newIssue.projectHint")}</Text>
              {selectedProject && !projectRepoWritable ? (
                <Text style={styles.warnText}>
                  {tp("newIssue.projectProblem", { problem: selectedProject.problem ?? "—" })}
                </Text>
              ) : null}
            </View>
          ) : null}

          {multiProject && selectedProject ? (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{tp("newIssue.area")}</Text>
              {selectedAreas.length > 0 ? (
                <>
                  <View style={styles.actions}>
                    {selectedAreas.map((area) => (
                      <PixelButton
                        key={area}
                        skin={skin}
                        variant="tab"
                        label={areaLabelName(area)}
                        active={pickedArea === area}
                        disabled={busy}
                        onPress={() => setPickedArea(pickedArea === area ? null : area)}
                      />
                    ))}
                  </View>
                  <Text style={styles.hint}>{tp("newIssue.areaHint")}</Text>
                </>
              ) : (
                <Text style={styles.hint}>{tp("newIssue.noAreas")}</Text>
              )}
            </View>
          ) : null}

          {/* 自动标签在按「创建」之前就摆出来，让人先确认再加。 */}
          {scopeHint ? <Text style={styles.hint}>{scopeHint}</Text> : null}

          {writableRepos.length > 1 && !multiProject ? (
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

          {/* 需求票不是地图票：切到需求后不摆这个开关，避免两种标记同时出现。 */}
          {mode === "issue" ? (
            <View style={styles.actions}>
              <PixelButton
                skin={skin}
                label={isMap ? t("new.markMapOn") : t("new.markMap")}
                active={isMap}
                disabled={busy}
                onPress={() => setIsMap((value) => !value)}
              />
            </View>
          ) : null}

          {lateNoticeBody ? <Text style={styles.warnText}>{lateNoticeBody}</Text> : null}
          {busy ? <Text style={styles.hint}>{slow ? t("new.busySlow") : t("new.busy")}</Text> : null}
          <View style={styles.actions}>
            <PixelButton
              skin={skin}
              label={busy ? t("new.submitting") : t("new.submit")}
              disabled={!canSubmit}
              onPress={() => void submit()}
            />
            {/* 整页入口没有可关的浮层：退回上一步交给宿主的返回键，不摆一个点了没反应的「取消」。 */}
            {inline ? null : (
              <PixelButton skin={skin} label={t("common.cancel")} disabled={busy} onPress={() => requestClose()} />
            )}
            {slow ? (
              <PixelButton skin={skin} label={t("new.forceClose")} onPress={() => requestClose(true)} />
            ) : null}
          </View>
          <Text style={styles.hint}>{t("new.hint")}</Text>
        </PixelModalBody>
      </Modal.Content>
  );

  // 整页入口（`/deck new`）把同一份表单直接铺在页面上：不是第二套表单，
  // 也没有「弹窗套弹窗」；宿主 Modal 只在面板里用。
  if (inline) return content;

  return (
    <Modal title={t("new.title")} open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
      {content}
    </Modal>
  );
}
