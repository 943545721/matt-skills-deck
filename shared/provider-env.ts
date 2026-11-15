/**
 * 客户端的「接入地址」与「凭据」写在哪个 env 键上。
 *
 * 照客户端自己的 env 键抄（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`），
 * 客户端没有才按前缀给默认——键名写错等于静默不生效，比报错更糟。
 *
 * 这个文件只放纯函数：不读文件、不碰宿主、不打日志。
 */

export interface EnvKeyHint {
  baseUrlKey: string;
  credentialKey: string;
}

const ENV_PREFIX: Record<string, string> = {
  claude: "ANTHROPIC",
  codex: "OPENAI",
  copilot: "GITHUB",
  opencode: "OPENAI",
};

const URL_KEY = /BASE_URL$/i;
const CREDENTIAL_KEY = /(_AUTH_TOKEN|_API_KEY|_TOKEN)$/i;

export function envKeysFor(provider: string, baseEnvKeys: readonly string[]): EnvKeyHint {
  const prefix = ENV_PREFIX[provider] ?? "OPENAI";
  return {
    baseUrlKey: baseEnvKeys.find((key) => URL_KEY.test(key)) ?? `${prefix}_BASE_URL`,
    credentialKey: baseEnvKeys.find((key) => CREDENTIAL_KEY.test(key)) ?? `${prefix}_API_KEY`,
  };
}

/**
 * 地址/凭据键：清理注入源时默认保护，需要用户二次确认。
 *
 * 前后端共用同一判据：不能靠 `envDisplayOf` 的 `masked`（空值也会返回 false），
 * 也不能让两端各写一份后缀正则——那正是「UI 不确认、服务端拒绝」的来源。
 */
export function isProtectedEnvKey(key: string): boolean {
  return /(_BASE_URL|_API_KEY|_AUTH_TOKEN|_TOKEN)$/i.test(key.trim());
}
