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
