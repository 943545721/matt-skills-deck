import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { copyText, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { AuthSnapshot } from "../../shared/auth";
import { authCancelRpc, authStartRpc, authStatusRpc, authTokenRpc } from "../../shared/auth";
import { useDeckText } from "./i18n";
import { PixelButton, PixelModalBody, usePixel } from "./pixel";

const AUTH_KEY = ["deck", "auth", "status"] as const;
const TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo,read:org&description=Paseo%20Deck";

/**
 * GitHub 登录弹窗。
 *
 * 两种入口，主路径是浏览器：
 * 1. 浏览器：服务端跑 `gh auth login --web`，把 gh 打印的验证码与授权页搬到面板上，
 *    客户端每 2 秒问一次登录态；授权完成后面板与任务板一起刷新。
 * 2. Token：浏览器流程不可用时兜底。token 只通过本机 RPC 走 stdin 交给 gh，
 *    插件不保存、不打印。
 *
 * 关闭弹窗不会取消已经发出的验证码——用户可能只是切出去授权；要取消有明确的按钮。
 */
export function GithubAuthModal({
  theme,
  open,
  onClose,
}: {
  theme: PluginTheme;
  open: boolean;
  onClose(): void;
}) {
  const { t } = useDeckText();
  const skin = usePixel(theme);
  const toast = useToast();
  const queryClient = useQueryClient();
  const readAuth = useRpc(authStatusRpc);
  const startAuth = useRpc(authStartRpc);
  const cancelAuth = useRpc(authCancelRpc);
  const tokenAuth = useRpc(authTokenRpc);

  const [mode, setMode] = useState<"device" | "token">("device");
  const [token, setToken] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const refreshed = useRef(false);

  const status = useQuery({
    queryKey: AUTH_KEY,
    queryFn: () => readAuth({}),
    enabled: open,
    staleTime: 0,
    // pending 等授权，checking 等 token 校验：两种都在等服务端出结果，轮询才能自己变。
    refetchInterval: (query) => {
      const state = (query.state.data as AuthSnapshot | undefined)?.state;
      return state === "pending" || state === "checking" ? 2_000 : false;
    },
  });

  const start = useMutation({
    mutationFn: () => startAuth({}),
    onSuccess: (result) => {
      queryClient.setQueryData(AUTH_KEY, result);
      setMode("device");
      setLocalError(null);
    },
    onError: (error: unknown) => setLocalError(error instanceof Error ? error.message : String(error)),
  });

  const cancel = useMutation({
    mutationFn: () => cancelAuth({}),
    onSuccess: (result) => queryClient.setQueryData(AUTH_KEY, result),
    onError: (error: unknown) => setLocalError(error instanceof Error ? error.message : String(error)),
  });

  const submitToken = useMutation({
    mutationFn: () => tokenAuth({ token: token.trim() }),
    onSuccess: (result) => {
      queryClient.setQueryData(AUTH_KEY, result);
      setLocalError(result.state === "error" ? (result.detail ?? t("auth.tokenFailed")) : null);
      if (result.state === "authenticated") setToken("");
    },
    onError: (error: unknown) => setLocalError(error instanceof Error ? error.message : String(error)),
  });

  const snapshot = status.data;
  const state = snapshot?.state ?? "unknown";

  /** 登录成功后只做两件事：刷新任务板和诊断；不自动关窗，让人看见结果。 */
  useEffect(() => {
    if (!open || state !== "authenticated") {
      if (state !== "authenticated") refreshed.current = false;
      return;
    }
    if (refreshed.current) return;
    refreshed.current = true;
    void queryClient.invalidateQueries({ queryKey: ["deck", "issues"] });
    void queryClient.invalidateQueries({ queryKey: ["deck", "env"] });
  }, [open, state, queryClient]);

  /** 每次重新打开都从「浏览器登录」开始；token 输入不丢，但错误提示要清掉。 */
  useEffect(() => {
    if (!open) return;
    setMode("device");
    setLocalError(null);
  }, [open]);

  const copyCode = () => {
    const code = snapshot?.code;
    if (!code) return;
    void copyText(code)
      .then(() => toast.show(t("auth.codeCopied"), { variant: "success" }))
      .catch(() => toast.error(t("common.copyFailed")));
  };

  const openDevicePage = () => {
    const url = snapshot?.url ?? "https://github.com/login/device";
    void openExternalUrl(url).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    );
  };

  const createToken = () => {
    void openExternalUrl(TOKEN_URL).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    );
  };

  const styles = useMemo(
    () => ({
      body: { gap: 10 },
      hint: skin.hint,
      error: skin.error,
      success: { color: skin.colors.ok, fontSize: 14, fontWeight: "700" as const, fontFamily: skin.mono.fontFamily },
      account: { color: skin.colors.ink, fontSize: 13, fontFamily: skin.mono.fontFamily },
      codeBox: {
        borderWidth: 1,
        borderColor: skin.colors.line,
        backgroundColor: skin.colors.stripe,
        paddingVertical: 12,
        paddingHorizontal: 16,
        alignItems: "center" as const,
      },
      code: {
        color: skin.colors.ink,
        fontFamily: skin.mono.fontFamily,
        fontWeight: "700" as const,
        fontSize: 28,
        letterSpacing: 4,
      },
      actions: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const, alignItems: "center" as const },
      input: skin.input,
      sectionHead: { ...skin.head, fontSize: 14 },
    }),
    [skin],
  );

  /** 错误原因 → 一句人话；detail 单独放在下面，方便贴给排错的人。 */
  const errorTitle = (value: AuthSnapshot | undefined): string => {
    switch (value?.reason) {
      case "gh-missing":
        return t("auth.ghMissing");
      case "expired":
        return t("auth.expired");
      case "cancelled":
        return t("auth.cancelled");
      case "device-unavailable":
        return t("auth.deviceUnavailable");
      case "web-blocked":
        return t("auth.webBlocked");
      case "token-invalid":
        return t("auth.tokenFailed");
      default:
        return t("auth.error");
    }
  };

  const showIntro = state === "unknown" || state === "needs-login" || state === "error";
  /** 网络层已经证明浏览器流程走不通时，把 Token 放到主按钮，别让人反复点必然失败的路。 */
  const preferToken = snapshot?.reason === "web-blocked" || snapshot?.reason === "device-unavailable";

  return (
    <Modal title={t("auth.title")} open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Content>
        <PixelModalBody skin={skin} style={styles.body}>
          {state === "authenticated" ? (
            <>
              <Text style={styles.success}>✓ {t("auth.authenticated")}</Text>
              {snapshot?.login ? <Text style={styles.account}>{t("auth.account", { login: snapshot.login })}</Text> : null}
              <Text style={styles.hint}>{t("auth.signedInHint")}</Text>
              <View style={styles.actions}>
                <PixelButton skin={skin} label={t("auth.done")} onPress={onClose} />
              </View>
            </>
          ) : mode === "token" ? (
            <>
              <Text style={styles.sectionHead}>{t("auth.token")}</Text>
              <Text style={styles.hint}>{t("auth.tokenHint")}</Text>
              <TextInput
                accessibilityLabel={t("auth.tokenPlaceholder")}
                style={styles.input}
                value={token}
                onChangeText={(value) => {
                  setToken(value);
                  setLocalError(null);
                }}
                placeholder={t("auth.tokenPlaceholder")}
                placeholderTextColor={skin.colors.ink2}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.hint}>{t("auth.tokenScope")}</Text>
              <Text style={styles.hint}>{t("auth.tokenPrivacy")}</Text>
              {localError ? <Text style={styles.error}>{localError}</Text> : null}
              <View style={styles.actions}>
                <PixelButton
                  skin={skin}
                  label={submitToken.isPending ? t("auth.tokenSubmitting") : t("auth.tokenSubmit")}
                  disabled={submitToken.isPending || token.trim().length < 16}
                  onPress={() => {
                    if (token.trim().length < 16) {
                      setLocalError(t("auth.tokenRequired"));
                      return;
                    }
                    submitToken.mutate();
                  }}
                />
                <PixelButton skin={skin} label={t("auth.tokenCreate")} onPress={createToken} />
                <PixelButton
                  skin={skin}
                  label={t("auth.browser")}
                  disabled={submitToken.isPending}
                  onPress={() => {
                    setMode("device");
                    setLocalError(null);
                  }}
                />
              </View>
            </>
          ) : (
            <>
              <Text style={styles.hint}>{t("auth.intro")}</Text>
              {showIntro && snapshot?.state === "error" ? (
                <>
                  <Text style={styles.error}>{errorTitle(snapshot)}</Text>
                  {snapshot.detail ? <Text style={styles.hint}>{snapshot.detail}</Text> : null}
                  {snapshot.reason === "gh-missing" ? (
                    <>
                      <Text style={styles.hint}>{t("auth.ghMissingHint")}</Text>
                      <View style={styles.actions}>
                        <PixelButton
                          skin={skin}
                          label={t("auth.installGithub")}
                          onPress={() => {
                            void openExternalUrl("https://cli.github.com/").catch((error: unknown) =>
                              toast.error(error instanceof Error ? error.message : String(error)),
                            );
                          }}
                        />
                      </View>
                    </>
                  ) : null}
                </>
              ) : null}

              {state === "pending" ? (
                snapshot?.code ? (
                  <>
                    <Text style={styles.sectionHead}>{t("auth.code")}</Text>
                    <View style={styles.codeBox}>
                      <Text selectable style={styles.code}>
                        {snapshot.code}
                      </Text>
                    </View>
                    <Text style={styles.hint}>{t("auth.browserHint")}</Text>
                    <Text style={styles.hint}>{t("auth.waiting")}</Text>
                    <View style={styles.actions}>
                      <PixelButton skin={skin} label={t("auth.openGithub")} active onPress={openDevicePage} />
                      <PixelButton skin={skin} label={t("auth.copyCode")} onPress={copyCode} />
                      <PixelButton
                        skin={skin}
                        label={cancel.isPending ? t("common.loading") : t("auth.cancel")}
                        disabled={cancel.isPending}
                        onPress={() => cancel.mutate()}
                      />
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={styles.hint}>{t("auth.starting")}</Text>
                    <View style={styles.actions}>
                      <PixelButton
                        skin={skin}
                        label={cancel.isPending ? t("common.loading") : t("auth.cancel")}
                        disabled={cancel.isPending}
                        onPress={() => cancel.mutate()}
                      />
                      <PixelButton skin={skin} label={t("auth.token")} onPress={() => setMode("token")} />
                    </View>
                  </>
                )
              ) : state === "checking" ? (
                <>
                  <Text style={styles.hint}>{t("auth.tokenSubmitting")}</Text>
                  <View style={styles.actions}>
                    <PixelButton
                      skin={skin}
                      label={cancel.isPending ? t("common.loading") : t("auth.cancel")}
                      disabled={cancel.isPending}
                      onPress={() => cancel.mutate()}
                    />
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.hint}>{t("auth.browserHint")}</Text>
                  {localError ? <Text style={styles.error}>{localError}</Text> : null}
                  <View style={styles.actions}>
                    {preferToken ? (
                      <>
                        <PixelButton skin={skin} label={t("auth.token")} active onPress={() => setMode("token")} />
                        <PixelButton
                          skin={skin}
                          label={start.isPending ? t("auth.starting") : t("auth.retry")}
                          disabled={start.isPending}
                          onPress={() => start.mutate()}
                        />
                      </>
                    ) : (
                      <>
                        <PixelButton
                          skin={skin}
                          label={start.isPending ? t("auth.starting") : t("auth.browser")}
                          active
                          disabled={start.isPending}
                          onPress={() => start.mutate()}
                        />
                        <PixelButton skin={skin} label={t("auth.token")} onPress={() => setMode("token")} />
                      </>
                    )}
                    <PixelButton skin={skin} label={t("common.close")} onPress={onClose} />
                  </View>
                </>
              )}
            </>
          )}
        </PixelModalBody>
      </Modal.Content>
    </Modal>
  );
}
