import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  buildActionPrompt,
  buildSkillPrompt,
  sessionTitle,
  truncateTitle,
} from "../../../shared/session.ts";
import type { PromptActionContext, PromptActionKind } from "../../../shared/session.ts";
import type { AgentInfo } from "../surfaces/registry.ts";
import { messageOf } from "../surfaces/registry.ts";
import { useDeckAgent, useDeckHost, useDeckWorkspaceAgents } from "../surfaces/host.tsx";
import { AGENT_STATUS_KEY, useSurfaceText } from "../surfaces/text.ts";
import { PixelBanner, PixelButton, PixelModalBody, usePixel } from "../pixel.tsx";
import { fillVisibleComposer } from "./composer-fill.ts";
import { creationOutcome, creationRoute, type CreationSnapshotLike } from "./creation.ts";
import { prefillAgentDraft } from "./prefill.ts";
import type { PrefillFailureCode } from "./prefill.ts";

/**
 * 会话面板：把一段提示词填进 Paseo 聊天窗口的输入框。
 *
 * 这里不发送消息。用户要的效果是「打开聊天窗口，输入框里已经有这段文字」，
 * 最后一步由用户自己检查并按下发送。实现边界见 `prefill.ts`：
 * 写宿主的草稿 store 并读回校验；失败时复制提示词，绝不猜一个 DOM 输入框填进去。
 *
 * - 已有会话：选一个聊天窗口，把编辑后的提示词填进它的输入框；
 * - 新会话：先建一个空会话，再把提示词填进它的输入框；
 * - 只复制：不碰会话，永远可用的一等公民。
 */

export interface SessionNavigation {
  openAgent(input: { agentId: string; serverId?: string }): void;
  /** 目标会话在另一个工作区时先切工作区；老宿主没有这个面就只调 openAgent。 */
  openWorkspace?(input: { workspaceId: string; serverId?: string }): void;
}

export interface SessionSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  theme: PluginTheme;
  workspaceId: string;
  workspaceDir: string;
  agentId?: string;
  /** 兼容调用方；预填不依赖忙碌态，保留字段避免一次性改所有入口。 */
  agentStatus?: AgentInfo["status"] | null;
  /** 默认 provider/model，例如 claude/sonnet；没有就留空让用户填。 */
  provider?: string | null;
  /** 初始标题；只在目标为新会话时使用。 */
  title?: string;
  action: PromptActionKind;
  context: Omit<PromptActionContext, "lang">;
  /** 建议气泡等场景已经有一段现成提示词；给了就不再调用 buildActionPrompt。 */
  initialPrompt?: string;
  /** 技能详情入口：只给技能名，由本面板按目标 provider 选择斜杠或纯文本方言。 */
  skill?: string;
  /** 调用方的语义默认值：新建需求应落在「新会话」，普通动作可落在已有会话。 */
  defaultTarget?: "current" | "new" | "copy";
  navigation?: SessionNavigation;
}

type TargetKind = "current" | "new" | "copy";

const clampTitle = (value: string): string => truncateTitle(value);

export function SessionSheet(props: SessionSheetProps) {
  const {
    open, onOpenChange, theme, workspaceId, workspaceDir, agentId,
    provider: defaultProvider, title: initialTitle, action, context, initialPrompt,
    skill: initialSkill, defaultTarget, navigation,
  } = props;
  const requestedSkill = initialSkill?.trim().replace(/^\/+/, "") ?? "";
  const { paseo, serverId } = useDeckHost();
  const { t, locale } = useSurfaceText();
  const skin = usePixel(theme);
  const toast = useToast();
  const lang: "en" | "zh" = locale.startsWith("zh") ? "zh" : "en";
  const prefillReason = (code: PrefillFailureCode): string => {
    switch (code) {
      case "empty":
        return t("session.prefillReason.empty");
      case "missing-target":
        return t("session.prefillReason.missingTarget");
      case "no-loader":
        return t("session.prefillReason.noLoader");
      case "no-store":
        return t("session.prefillReason.noStore");
      case "draft-occupied":
        return t("session.draftOccupied");
      case "read-back-failed":
        return t("session.prefillReason.readBackFailed");
      case "write-failed":
        return t("session.prefillReason.writeFailed");
    }
  };
  const workspaceAgents = useDeckWorkspaceAgents(workspaceId, workspaceDir);
  const explicitAgent = useDeckAgent(agentId);
  /**
   * 同一目录可能合并了多个工作区的会话。默认目标优先选当前工作区的会话：
   * 否则「填入」会默认落到另一个工作区的聊天里，用户在自己窗口看不到文字。
   */
  const defaultAgentId = useMemo(() => {
    const own = workspaceAgents.filter((candidate) => candidate.workspaceId === workspaceId);
    const pool = own.length > 0 ? own : workspaceAgents;
    return pool[0]?.id ?? null;
  }, [workspaceAgents, workspaceId]);

  const [draft, setDraft] = useState("");
  const draftTouched = useRef(false);
  const [target, setTarget] = useState<TargetKind>(agentId ? "current" : "new");
  const [pickedAgentId, setPickedAgentId] = useState<string | null>(agentId ?? null);
  const targetTouched = useRef(false);
  const [provider, setProvider] = useState(defaultProvider ?? "");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 目标输入框已有草稿：第一次只提示，第二次点击才允许覆盖。 */
  const [occupiedAgentId, setOccupiedAgentId] = useState<string | null>(null);
  /** 新建目标已经建过的会话 id；预填失败后重试只重填，不再建第二个。 */
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  /** 创建事件里先拿到的 id；即使 create 调用最终报错，也能接着填这个会话。 */
  const createdAgentIdRef = useRef("");
  const busyRef = useRef(false);
  const providerTouched = useRef(false);
  const idempotencyKey = useRef<string | null>(null);

  const pickedAgent = pickedAgentId
    ? workspaceAgents.find((candidate) => candidate.id === pickedAgentId) ?? null
    : null;
  const selectedAgentId = agentId ?? pickedAgent?.id ?? defaultAgentId;
  const selectedAgent = selectedAgentId
    ? workspaceAgents.find((candidate) => candidate.id === selectedAgentId) ?? null
    : null;
  const displayedAgent = agentId ? explicitAgent.agent ?? selectedAgent : selectedAgent;
  /**
   * 提示词方言必须跟随真正要接收它的 provider：当前会话用选中 agent 的配置，
   * 新会话用输入框里的配置。否则 claude 也只会收到纯文本，斜杠技能永远不触发。
   */
  const promptProvider =
    context.provider?.trim() ||
    (target === "current"
      ? displayedAgent?.provider ?? defaultProvider ?? undefined
      : provider.trim() || defaultProvider || undefined);
  const ctx = useMemo<PromptActionContext>(
    () => ({
      ...context,
      lang,
      ...(promptProvider ? { provider: promptProvider } : {}),
    }),
    [context, lang, promptProvider],
  );

  // 每次打开都从动作重新生成：关闭后用户改了票，下一次不能带着上一张票的草稿。
  useEffect(() => {
    if (!open) return;
    const openTarget =
      defaultTarget ?? (agentId ? "current" : workspaceAgents.length > 0 ? "current" : "new");
    const openProvider =
      openTarget === "current"
        ? displayedAgent?.provider ?? defaultProvider ?? undefined
        : provider.trim() || defaultProvider || undefined;
    const openCtx: PromptActionContext = {
      ...context,
      lang,
      ...(openProvider ? { provider: openProvider } : {}),
    };
    setDraft(
      initialPrompt ??
        (requestedSkill ? buildSkillPrompt(requestedSkill, openCtx) : buildActionPrompt(action, openCtx)),
    );
    draftTouched.current = false;
    setTarget(openTarget);
    setPickedAgentId(agentId ?? defaultAgentId);
    targetTouched.current = defaultTarget !== undefined;
    setProvider(defaultProvider ?? "");
    providerTouched.current = false;
    setTitle(clampTitle(initialTitle ?? sessionTitle(action, openCtx)));
    setBusy(false);
    setError(null);
    setNotice(null);
    setOccupiedAgentId(null);
    setCreatedAgentId(null);
    createdAgentIdRef.current = "";
    idempotencyKey.current = null;
    // 只在打开时重置；ctx 在打开期间变化不应吞掉用户正在编辑的草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 用户没改过草稿时，让动作提示词跟随最终 provider / 目标重新生成；
  // 一旦动过正文就停下，绝不覆盖用户输入。
  useEffect(() => {
    if (!open || initialPrompt || draftTouched.current) return;
    setDraft(requestedSkill ? buildSkillPrompt(requestedSkill, ctx) : buildActionPrompt(action, ctx));
  }, [open, action, ctx, initialPrompt, requestedSkill]);

  // provider 也可能晚于面板到达；只在用户没动过输入框时回填，避免覆盖手动清空。
  useEffect(() => {
    if (!open || providerTouched.current || provider.trim() || !defaultProvider) return;
    setProvider(defaultProvider);
  }, [open, defaultProvider, provider]);

  // 会话列表晚于面板到达时，补一个默认选中项；不覆盖用户已经选过的会话。
  useEffect(() => {
    if (!open || agentId) return;
    setPickedAgentId((current) =>
      current && workspaceAgents.some((candidate) => candidate.id === current)
        ? current
        : defaultAgentId,
    );
  }, [open, agentId, workspaceAgents, defaultAgentId]);

  // 打开时还没有会话，列表随后到达：没动过目标就自动切到「已有会话」。
  useEffect(() => {
    if (!open || agentId || targetTouched.current || target !== "new") return;
    // 正在新建 / 已经建出会话时不要替用户切目标：切走会让按钮和创建结果对不上。
    if (busy || createdAgentId) return;
    if (workspaceAgents.length > 0) setTarget("current");
  }, [open, agentId, target, workspaceAgents.length, busy, createdAgentId]);

  // 选中的会话变了，之前为另一个会话点开的“覆盖”确认就作废。
  useEffect(() => {
    setOccupiedAgentId(null);
  }, [selectedAgentId]);

  const copy = async (text: string, message: string): Promise<boolean> => {
    try {
      await copyText(text);
      toast.show(t("common.copied"), { variant: "success" });
      setNotice(message);
      return true;
    } catch {
      setError(t("common.copyFailed"));
      return false;
    }
  };

  const openTargetAgent = (targetAgentId: string): void => {
    if (!navigation) {
      toast.show(t("session.createdWithoutNavigation", { id: targetAgentId }), { variant: "warning" });
      return;
    }
    const targetAgent = workspaceAgents.find((candidate) => candidate.id === targetAgentId) ?? null;
    try {
      // 目标会话可能在同目录的另一个工作区：先切到那个工作区再开会话。
      // 只调 openAgent 时当前工作区里找不到这个 agent，聊天不会切过去，
      // 用户看到「已填入」但输入框仍是原来的会话。
      if (targetAgent?.workspaceId && targetAgent.workspaceId !== workspaceId) {
        navigation.openWorkspace?.({ workspaceId: targetAgent.workspaceId });
      }
      navigation.openAgent({ agentId: targetAgentId });
    } catch {
      // 导航失败不影响已经写进草稿 store 的文字，只退化成手动打开。
      toast.show(t("session.createdWithoutNavigation", { id: targetAgentId }), { variant: "warning" });
    }
  };

  const fill = async (overwrite = false): Promise<void> => {
    if (busyRef.current) return;
    const prompt = draft.trim();
    setError(null);
    setNotice(null);
    if (!prompt) {
      setError(t("session.errorDraft"));
      return;
    }
    if (target === "copy") {
      if (await copy(prompt, t("session.targetCopied"))) onOpenChange(false);
      return;
    }
    if (target === "current" && !selectedAgentId) {
      setError(t("session.errorNoAgent"));
      return;
    }
    const route = creationRoute({ workspaceId, workspaceDir });
    if (target === "new") {
      if (!provider.trim()) {
        setError(t("session.errorProvider"));
        return;
      }
      if (route.kind === "blocked") {
        setError(t("session.errorDirectory"));
        return;
      }
    }

    if (!serverId) {
      // 没有 host.id 就拼不出草稿 key；先建会话只会留下一个填不进去的空会话。
      let copied = false;
      try {
        await copyText(prompt);
        copied = true;
      } catch {
        copied = false;
      }
      setError(t("session.prefillFailed", { error: prefillReason("missing-target") }));
      toast.show(copied ? t("session.prefillCopied") : t("session.prefillCopyFailed"), {
        variant: copied ? "warning" : "error",
      });
      return;
    }

    // 用户按了「创建并填入」就等于选定了「新建」，后续会话列表到达也不要自动切走。
    if (target === "new") targetTouched.current = true;
    busyRef.current = true;
    setBusy(true);
    /** 创建调用报错且宿主自己说「结果不确定」：不能自动重试，先让用户核对。 */
    let uncertainCreation = false;
    try {
      let targetAgentId = selectedAgentId ?? "";
      if (target === "new") {
        if (createdAgentId) {
          // 上一次已经建过会话：重试只重新填入，避免留下孤立的空会话。
          targetAgentId = createdAgentId;
        } else {
          if (!idempotencyKey.current) {
            idempotencyKey.current = `${workspaceId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
          }
          setNotice(t("session.creating"));
          const request = {
            config: { provider: provider.trim() },
            title: clampTitle(title.trim() || sessionTitle(action, ctx)),
            idempotencyKey: idempotencyKey.current,
          };
          // onEvent 里只认快照的 `agent`：`accepted` 阶段的 agentId 是宿主预留的，
          // 不代表会话已经建好；把预留 id 当成功会写进一个不存在的会话。
          let observedId = "";
          let lastSnapshot: CreationSnapshotLike | null = null;
          const observe = (snapshot: CreationSnapshotLike): void => {
            lastSnapshot = snapshot;
            const outcome = creationOutcome(snapshot);
            if (!outcome.agentId) return;
            observedId = outcome.agentId;
            createdAgentIdRef.current = outcome.agentId;
            setCreatedAgentId(outcome.agentId);
          };
          const createAgent = async (): Promise<{ id: string }> => {
            // 用工作区句柄创建。裸 `agents.create({ cwd })` 会按目录重新解析工作区，
            // 同一目录已有两个工作区时新会话会落到另一个（实测 wks_7d9f…），
            // 当前工作区的「已有会话」列表里就看不到它。
            if (route.kind === "workspace") {
              return paseo.workspaces.ref(route.workspaceId).agents.create({ ...request, onEvent: observe });
            }
            if (route.kind === "cwd") {
              return paseo.agents.create({ ...request, cwd: route.cwd, onEvent: observe });
            }
            throw new Error("no workspace route for agent creation");
          };
          let failure: unknown = null;
          try {
            observedId = (await createAgent()).id;
          } catch (error) {
            failure = error;
          }
          const createdId = observedId || createdAgentIdRef.current;
          if (!createdId) {
            // 没有真实 agent 就是没建出来。保留幂等键：宿主对已确定失败的请求
            // 允许同 key 重试并复用预留 id；结果不确定时改由文案让用户先核对。
            if (creationOutcome(lastSnapshot).outcomeUnknown) uncertainCreation = true;
            throw failure instanceof Error ? failure : new Error(String(failure ?? "agent creation returned no id"));
          }
          targetAgentId = createdId;
          setCreatedAgentId(createdId);
          if (failure) {
            // 会话已经存在，继续填它；创建调用自身的错误不再覆盖预填结果。
            setNotice(null);
          }
        }
      }
      if (!targetAgentId) {
        setError(t("session.errorNoAgent"));
        return;
      }

      // 只写宿主草稿 store；这里不发送、也不猜 DOM 输入框属于哪个会话。
      const result = prefillAgentDraft({
        serverId,
        agentId: targetAgentId,
        text: prompt,
        overwrite: overwrite && occupiedAgentId === targetAgentId,
      });
      if (!result.ok) {
        if (result.code === "draft-occupied") {
          setOccupiedAgentId(targetAgentId);
          setError(t("session.draftOccupied"));
          if (target === "new") openTargetAgent(targetAgentId);
          return;
        }
        setOccupiedAgentId(null);
        let copied = false;
        try {
          await copyText(prompt);
          copied = true;
        } catch {
          copied = false;
        }
        const reason = prefillReason(result.code);
        setError(
          target === "new"
            ? t("session.createdPrefillFailed", { id: targetAgentId, error: reason })
            : t("session.prefillFailed", { error: reason }),
        );
        if (target === "new" && navigation) {
          // 已创建会话但没填进去：导航过去让用户直接粘贴；导航失败不再叠一条误导提示。
          try {
            navigation.openAgent({ agentId: targetAgentId });
          } catch {
            // 保持当前面板，错误文案里已经给出会话 id。
          }
        }
        if (copied) toast.show(t("session.prefillCopied"), { variant: "warning" });
        else toast.show(t("session.prefillCopyFailed"), { variant: "error" });
        return;
      }

      setOccupiedAgentId(null);
      openTargetAgent(targetAgentId);
      // 草稿 store 只对「之后才挂载」的输入框生效；已经打开的会话要靠这一步
      // 把文字写进唯一可见的输入框。拿不准就放弃，草稿仍在。
      void fillVisibleComposer(prompt);
      toast.show(
        target === "new" ? t("session.successNew") : t("session.successCurrent"),
        { variant: "success" },
      );
      onOpenChange(false);
    } catch (failure) {
      setError(
        uncertainCreation
          ? t("session.createUncertain")
          : t("session.requestFailed", { error: messageOf(failure) }),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
      // 「正在创建会话…」只在请求进行中成立；失败后不能和错误横幅同时挂着。
      setNotice(null);
    }
  };

  const selectAgent = (id: string): void => {
    if (busy) return;
    setPickedAgentId(id);
    setOccupiedAgentId(null);
    setError(null);
    setNotice(null);
  };

  const targetButton = (kind: TargetKind, label: string, disabled = false) => (
    <PixelButton
      skin={skin}
      variant="outline"
      label={label}
      active={target === kind}
      disabled={disabled || busy}
      onPress={() => {
        targetTouched.current = true;
        setTarget(kind);
        setOccupiedAgentId(null);
        setError(null);
        setNotice(null);
      }}
    />
  );

  return (
    <Modal
      title={t("session.title")}
      open={open}
      onOpenChange={(next) => {
        // 填入中不允许用背景点击关闭：新建请求可能已经在宿主侧发生。
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <Modal.Content>
        <PixelModalBody skin={skin}>
          <Text style={skin.label}>{t("session.target")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {targetButton("current", agentId ? t("session.current") : t("session.pickSession"), !selectedAgentId)}
            {targetButton("new", t("session.new"))}
            {targetButton("copy", t("session.copy"))}
          </View>
          {target === "new" && workspaceAgents.length > 0 ? (
            <Text style={skin.hint}>{t("session.existingAvailable", { count: workspaceAgents.length })}</Text>
          ) : null}
          {target === "current" && !agentId ? (
            workspaceAgents.length > 0 ? (
              <>
                <Text style={skin.hint}>{t("session.pickSessionHint")}</Text>
                <ScrollView style={{ maxHeight: 168 }} contentContainerStyle={{ gap: 4 }}>
                  {workspaceAgents.map((candidate) => {
                    const active = candidate.id === selectedAgentId;
                    const meta = `${candidate.provider}${candidate.model ? `/${candidate.model}` : ""} · ${t(AGENT_STATUS_KEY[candidate.status])}`;
                    return (
                      <Pressable
                        key={candidate.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active, disabled: busy }}
                        accessibilityLabel={candidate.title?.trim() || candidate.id}
                        disabled={busy}
                        onPress={() => selectAgent(candidate.id)}
                        style={[
                          skin.card,
                          {
                            paddingHorizontal: 8,
                            paddingVertical: 6,
                            gap: 2,
                            borderColor: active ? skin.colors.acc : skin.colors.line,
                          },
                          busy ? { opacity: 0.5 } : null,
                        ]}
                      >
                        <Text style={skin.value} numberOfLines={1}>{candidate.title?.trim() || candidate.id}</Text>
                        <Text style={skin.hint} numberOfLines={1}>{meta}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </>
            ) : (
              <Text style={skin.hint}>{t("session.currentUnavailable")}</Text>
            )
          ) : null}
          {target === "current" && agentId && displayedAgent ? (
            <Text style={skin.hint} numberOfLines={1}>
              {`${displayedAgent.title?.trim() || displayedAgent.id} · ${displayedAgent.provider}${displayedAgent.model ? `/${displayedAgent.model}` : ""}`}
            </Text>
          ) : null}

          <Text style={skin.label}>{t("session.prompt")}</Text>
          <TextInput
            multiline
            value={draft}
            onChangeText={(value) => {
              draftTouched.current = true;
              setDraft(value);
              setOccupiedAgentId(null);
            }}
            editable={!busy}
            placeholder={target === "new" ? t("session.initialPromptHint") : t("session.promptHint")}
            placeholderTextColor={skin.colors.ink2}
            style={[skin.input, { minHeight: 150, textAlignVertical: "top" }]}
            accessibilityLabel={t("session.prompt")}
          />
          <Text style={skin.hint}>{t("session.promptHint")}</Text>

          {target === "new" ? (
            <>
              <Text style={skin.label}>{t("session.provider")}</Text>
              <TextInput
                value={provider}
                onChangeText={(value) => {
                  providerTouched.current = true;
                  setProvider(value);
                  // 改了创建参数就必须换幂等键，否则宿主的请求指纹校验会一直拒绝。
                  if (!createdAgentId) idempotencyKey.current = null;
                }}
                editable={!busy && !createdAgentId}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="claude/sonnet"
                placeholderTextColor={skin.colors.ink2}
                style={skin.input}
                accessibilityLabel={t("session.provider")}
              />
              <Text style={skin.hint}>{t("session.providerHint")}</Text>

              <Text style={skin.label}>{t("session.agentTitle")}</Text>
              <TextInput
                value={title}
                onChangeText={(value) => {
                  setTitle(value);
                  if (!createdAgentId) idempotencyKey.current = null;
                }}
                editable={!busy && !createdAgentId}
                maxLength={60}
                style={skin.input}
                accessibilityLabel={t("session.agentTitle")}
              />
              <Text style={skin.hint}>{t("session.agentTitleHint")}</Text>
              {createdAgentId ? (
                <Text style={skin.hint}>{t("session.createdRetryHint", { id: createdAgentId })}</Text>
              ) : null}
              <Text style={skin.hint}>{t("session.newHint")}</Text>
            </>
          ) : target === "current" ? (
            <Text style={skin.hint}>{t("session.fillHint")}</Text>
          ) : null}

          {error ? (
            <PixelBanner skin={skin}>
              <Text style={skin.bannerText}>{error}</Text>
            </PixelBanner>
          ) : null}
          {notice ? <Text style={skin.hint}>{notice}</Text> : null}

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
            <PixelButton skin={skin} variant="ghost" label={t("session.copyPrompt")} disabled={busy} onPress={() => void copy(draft, t("common.copied"))} />
            <PixelButton skin={skin} variant="ghost" label={t("session.cancel")} disabled={busy} onPress={() => onOpenChange(false)} />
            <PixelButton
              skin={skin}
              variant="solid"
              label={
                busy
                  ? t("session.filling")
                  : target === "copy"
                    ? t("session.copyAndClose")
                    : occupiedAgentId
                      ? t("session.overwriteAndFill")
                      : target === "new" && createdAgentId
                        ? t("session.fillCreated")
                        : target === "new"
                          ? t("session.createAndFill")
                          : t("session.fill")
              }
              disabled={busy}
              onPress={() => void fill(occupiedAgentId !== null)}
            />
          </View>
        </PixelModalBody>
      </Modal.Content>
    </Modal>
  );
}
