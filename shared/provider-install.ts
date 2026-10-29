/**
 * 客户端（provider CLI）在这台机器上「装没装」与「能不能从这里装」。
 *
 * 装没装由宿主判定：provider 快照的 `status` 只有
 * `ready | loading | error | unavailable` 四种，其中 `unavailable` 才是
 * 「这台机器上找不到这个命令」。**不自己 `which` 一遍**：插件与宿主可能跑在不同
 * 的 PATH 上，自己查出来的结论会和正要拿来跑命令的那个环境不一致。
 *
 * 能不能装：宿主没有安装 API，这里只收「官方 npm 包」这一种确定能执行的方式。
 * 表里没有的客户端一律不给安装按钮，让用户按官方文档自己装——
 * 编一条装不上的命令比没有按钮更糟。
 */

export type ProviderInstallState = "ready" | "loading" | "missing" | "broken" | "unknown";

/** 宿主状态 → 界面要说的话。`error` 是「装了但跑不起来」，和「没装」不是一回事。 */
export function installStateOf(status: string | null | undefined): ProviderInstallState {
  switch ((status ?? "").trim().toLowerCase()) {
    case "ready":
      return "ready";
    case "loading":
      return "loading";
    case "unavailable":
      return "missing";
    case "error":
      return "broken";
    default:
      return "unknown";
  }
}

export interface InstallRecipe {
  /** npm 包名。 */
  readonly packageName: string;
  /** 装完宿主应该能解析到的命令名；只写进结果文案，不拿来拼命令。 */
  readonly binary: string;
}

/**
 * 一份客户端 id → 官方 npm 包名的对照表。
 *
 * 每个包名都在本机用 `npm view <pkg> version` 核实过确实存在；
 * 没核实的（`pi` / `omp` / `antigravity` / `muse` 这类不走 npm 或包名对不上的）
 * 就不进表——它们没有安装按钮，只有诊断。
 */
export const INSTALL_RECIPES: Readonly<Record<string, InstallRecipe>> = Object.freeze({
  claude: { packageName: "@anthropic-ai/claude-code", binary: "claude" },
  codex: { packageName: "@openai/codex", binary: "codex" },
  copilot: { packageName: "@github/copilot", binary: "copilot" },
  opencode: { packageName: "opencode-ai", binary: "opencode" },
});

/** 只认表里的 key（大小写不敏感）；其余一律没有安装方式。 */
export function installRecipeFor(provider: string): InstallRecipe | null {
  const id = provider.trim().toLowerCase();
  if (!id) return null;
  return Object.prototype.hasOwnProperty.call(INSTALL_RECIPES, id) ? INSTALL_RECIPES[id] ?? null : null;
}

/** 给人看的命令文本（复制用）。真正执行时走 execFile，不经过 shell。 */
export function installCommandOf(recipe: InstallRecipe): string {
  return `npm install -g ${recipe.packageName}`;
}
