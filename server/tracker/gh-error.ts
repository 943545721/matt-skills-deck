/**
 * 把 `gh` 的失败归成三类：没装、没登录、其它。
 *
 * 以前只区分 `ENOENT` 与「其它」，于是「装了 gh 但没登录」被归进 `gh-failed`，界面标题写成
 * 「GitHub 拒绝了这次操作」——可请求根本没到 GitHub。用户会顺着这个提示去查仓库权限，
 * 方向从一开始就是错的。gh 用退出码 4 表示需要认证，stderr 也会点名 `gh auth login`，
 * 两者命中任意一个就够判定。
 *
 * 放在这里而不是每个调用点各写一遍：读、写、标签、地图四条链路都会调 gh，
 * 分类口径必须只有一份，否则某条路径又会退回「一律 gh-failed」。
 */
export type GhFailureReason = "gh-missing" | "gh-unauth" | "gh-failed";

export interface GhFailure {
  reason: GhFailureReason;
  detail: string;
}

/**
 * 未登录时 gh 的说法。刻意只认这两句：
 * 泛化的 `authentication required` 会命中企业代理的 407，
 * 把「代理要密码」说成「gh 没登录」，用户会朝完全错误的方向排查。
 */
const UNAUTH_HINT = /gh auth login|not logged into any GitHub hosts/i;

const MAX_DETAIL = 800;

export function classifyGhError(error: unknown, retryHint = "刷新"): GhFailure {
  // 非零退出时 `code` 是数字，找不到命令时是字符串 "ENOENT"，所以按 unknown 收。
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") {
    return { reason: "gh-missing", detail: `没有找到 gh 命令：装好后执行 gh auth login 再${retryHint}` };
  }

  // 只认真正的 stderr。error.message 拼着完整 argv（可能含用户写的评论正文），
  // 拿它做关键词匹配，会让「正文里写了 gh auth login」的超时被误判成没登录，
  // 进而绕过「评论可能已写入」的保护。argv 也不该出现在界面详情里。
  const stderr = (error as { stderr?: unknown }).stderr;
  const stderrText = typeof stderr === "string" && stderr.trim() ? stderr.trim() : "";
  const detail = stderrText ? stderrText.slice(0, MAX_DETAIL) : fallbackDetail(error, code);

  // 退出码 4 是 gh 的「需要认证」约定；提示词只在 stderr 真的这么说了时才作数。
  if (code === 4 || (stderrText && UNAUTH_HINT.test(stderrText))) return { reason: "gh-unauth", detail };
  return { reason: "gh-failed", detail };
}

/** stderr 为空时的详情：只说发生了什么，不回显命令行（命令行里可能有用户内容）。 */
function fallbackDetail(error: unknown, code: unknown): string {
  // 超时时 killed=true；被外部信号带走时只有 signal。两种都没有可用输出。
  if ((error as { killed?: unknown }).killed || (error as { signal?: unknown }).signal) {
    return "gh 命令被终止，没有返回任何输出";
  }
  if (typeof code === "number") return `gh 退出码 ${code}，没有输出错误信息`;
  return error instanceof Error ? error.message : String(error);
}
