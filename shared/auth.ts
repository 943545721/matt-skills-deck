import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * GitHub 登录契约。
 *
 * 登录是**机器级**的：`gh` 把凭据写进自己的配置，所有工作区共用一份。
 * 因此这里没有 workspaceDir——面板在哪个项目里点「登录」，登的都是同一台机器上的 gh。
 *
 * 服务端不保存 token：浏览器流程只把一次性验证码交回界面，Token 流程把 token
 * 直接喂给 `gh auth login --with-token`，插件自己的设置与日志里都不落这份秘密。
 */
export const authState = z.enum([
  /** 还没检查过。 */
  "unknown",
  /** 正在向 gh 查询登录态。 */
  "checking",
  /** gh 装了，但没有登录。 */
  "needs-login",
  /** 浏览器流程已启动，等用户在 GitHub 上授权。 */
  "pending",
  "authenticated",
  /** 失败：gh 没装、命令失败、验证码过期等，原因在 reason/detail。 */
  "error",
]);

export const authReason = z.enum([
  "gh-missing",
  "gh-failed",
  "expired",
  "cancelled",
  "token-invalid",
  "device-unavailable",
  /** 本机到 github.com 的 443 连不上：浏览器流程还没开始就注定失败。 */
  "web-blocked",
]);

const snapshot = z.object({
  state: authState,
  host: z.literal("github.com"),
  /** gh 报告的账号名；只有已登录时才有。 */
  login: z.string().optional(),
  /** 浏览器流程的一次性验证码，例如 `E5D8-3766`。 */
  code: z.string().optional(),
  /** 授权页地址，只允许 GitHub 的 device 页。 */
  url: z.string().optional(),
  /** 当前状态的人话补充；失败时是排错线索，不含 token。 */
  detail: z.string().optional(),
  reason: authReason.optional(),
  /** 浏览器流程的时间点，界面用来显示「还剩多久」。 */
  startedAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

export type AuthSnapshot = z.infer<typeof snapshot>;
export type AuthState = z.infer<typeof authState>;

export const authStatusRpc = defineRpc({
  name: "deck.auth.status",
  input: z.object({
    /** 忽略服务端几秒内的缓存，强制重新跑一次 `gh auth status`。 */
    refresh: z.boolean().optional(),
  }),
  output: snapshot,
});

export const authStartRpc = defineRpc({
  name: "deck.auth.start",
  input: z.object({}),
  output: snapshot,
});

export const authCancelRpc = defineRpc({
  name: "deck.auth.cancel",
  input: z.object({}),
  output: snapshot,
});

export const authTokenRpc = defineRpc({
  name: "deck.auth.token",
  // 不把长度上限放得太死：GitHub 以后可能换前缀 / 长度，真正的校验交给 gh。
  input: z.object({ token: z.string().min(16).max(1024) }),
  output: snapshot,
});
