/**
 * 角色窗口的「只读」护栏：主窗口 / 需求窗口 / 派单窗口 / 进度窗口不许改文件。
 *
 * 身份提示词只能劝，劝不住。这里把「什么算改文件」收成纯函数，
 * 由权限请求钩子对这四个窗口的 Write / Edit / 改文件 shell 直接拒绝。
 *
 * 这是护栏，不是沙箱：未知命令一律放行并留日志。宁可漏一次，
 * 也不能因为一条只读命令被误判就把窗口卡死。
 */

import { segmentShellTokens, shellScriptOf } from "./shell-segments.ts";
import type { WindowRole } from "./window-gates.ts";

export interface ExecutionBlock {
  block: boolean;
  /** 命中的类型：`write` / `edit` / `redirect` / 命令名。进日志与拒绝文案。 */
  kind?: string;
}

interface PermissionDetailLike {
  type?: string;
  command?: string;
}

/** `detail` → 是否要拦。只认写文件类；读、搜索、抓取、MCP 工具一律放行。 */
export function executionBlockFor(detail: PermissionDetailLike | null | undefined): ExecutionBlock {
  if (!detail) return { block: false };
  if (detail.type === "write") return { block: true, kind: "write" };
  if (detail.type === "edit") return { block: true, kind: "edit" };
  if (detail.type !== "shell" || typeof detail.command !== "string") return { block: false };
  const verdict = shellMutationVerdict(detail.command);
  return verdict.mutating ? { block: true, kind: verdict.kind ?? "shell" } : { block: false };
}

export interface ShellMutationVerdict {
  mutating: boolean;
  kind?: string;
}

/** 直接改文件的命令。用 denylist：只拦认得出的，认不出就放行。 */
const MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  "rm", "rmdir", "mv", "cp", "install", "touch", "mkdir",
  "chmod", "chown", "ln", "truncate", "dd", "tee", "patch", "sponge", "shred",
  "vim", "vi", "nano", "emacs",
]);

/** 包一层再执行的包装器：剥掉它再判真正的命令。 */
const WRAPPERS: ReadonlySet<string> = new Set([
  "sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "ionice", "stdbuf", "timeout",
]);

/** 会再起一层解析的 shell 与求值命令：`bash -c "rm …"` 不能因为外面套了一层就放行。 */
const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const EVALS: ReadonlySet<string> = new Set(["eval", "source"]);

/** 会写工作区的 git 子命令。只读的 status/diff/log/show 不在里面。 */
const MUTATING_GIT: ReadonlySet<string> = new Set([
  "apply", "commit", "checkout", "switch", "reset", "clean", "merge",
  "rebase", "cherry-pick", "stash",
]);

/** 构建类命令：几乎都会写产物目录。 */
const BUILD_COMMANDS: ReadonlySet<string> = new Set(["make", "cmake", "gradle", "mvn", "gradlew"]);

/** 带子命令的包管理器：只拦会写依赖目录的那些。 */
const PACKAGE_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["install", "i", "ci", "uninstall", "remove", "rm"]),
  pnpm: new Set(["add", "install", "i", "remove", "rm", "uninstall"]),
  yarn: new Set(["add", "install", "remove"]),
  pip: new Set(["install", "uninstall"]),
  pip3: new Set(["install", "uninstall"]),
  poetry: new Set(["add", "remove", "install"]),
  cargo: new Set(["add", "install"]),
  go: new Set(["get", "install"]),
};

function basename(token: string): string {
  const parts = token.split("/");
  return parts[parts.length - 1] ?? token;
}

/** 去掉引号里的内容，避免 `echo "a > b"` 被当成重定向。 */
function withoutQuoted(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

/** 去掉 shell 注释：`#` 前面是空白（或行首）才算，`${#arr}` / `a#b` 不动。 */
function withoutComment(command: string): string {
  return command.replace(/(^|\s)#[^\n]*/g, "$1");
}

/** `>` / `>>` / `&>` 写文件；写 `/dev/null` 不算。 */
function hasFileRedirect(command: string): boolean {
  const stripped = withoutComment(withoutQuoted(command))
    // `[[ a > b ]]` / `(( a > b ))` 是比较，不落盘。
    .replace(/\[\[[\s\S]*?\]\]/g, "")
    .replace(/\(\([\s\S]*?\)\)/g, "")
    .replace(/\d*>&?\s*\/dev\/null/g, "")
    .replace(/&>\s*\/dev\/null/g, "")
    // `2>&1` / `>&2` 是复制文件描述符，不落盘。
    .replace(/\d*>&\s*\d+/g, "")
    .replace(/>&\s*-/g, "");
  return /(^|[^<>=!-])>{1,2}/.test(stripped);
}

/**
 * 从一段命令里找真正的命令名：剥掉 sudo/env/timeout 之类的包装器、
 * 环境变量赋值，以及包装器自己的参数。
 */
function commandOf(tokens: readonly string[]): { name: string; args: string[] } | null {
  let index = 0;
  const takeValue = (flag: string) =>
    /^-[ugpCn]$/.test(flag) || flag === "-s" || flag === "-k" || flag === "--user" || flag === "--group";

  for (;;) {
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
    const head = tokens[index];
    if (!head) return null;
    const name = basename(head);
    if (!WRAPPERS.has(name)) return { name, args: tokens.slice(index + 1) };
    index += 1;
    // 包装器自己的参数：-u root / -n 5 / 5s 这类，别当成真正的命令。
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      if (/^\d+(?:\.\d+)?s?$/.test(token)) {
        index += 1;
        continue;
      }
      if (!token.startsWith("-")) break;
      index += 1;
      if (takeValue(token) && index < tokens.length) index += 1;
    }
  }
}

function mutatingIn(tokens: readonly string[]): ShellMutationVerdict {
  const found = commandOf(tokens);
  if (!found) return { mutating: false };
  const { name, args } = found;

  // 往下钻一层：`bash -c "rm …"` 与 `eval "mv …"` 真正执行的是里面那条。
  if (SHELLS.has(name)) {
    const script = shellScriptOf(args);
    return script ? shellMutationVerdict(script) : { mutating: false };
  }
  if (EVALS.has(name)) return shellMutationVerdict(args.join(" "));

  if (MUTATING_COMMANDS.has(name)) return { mutating: true, kind: name };
  if (BUILD_COMMANDS.has(name)) return { mutating: true, kind: name };

  if (name === "git") {
    // `git -C dir commit`：跳过全局参数，取第一个非参数词。
    let index = 0;
    while (index < args.length) {
      const token = args[index] ?? "";
      if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
        index += 2;
        continue;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
    const sub = args[index];
    if (sub && MUTATING_GIT.has(sub)) return { mutating: true, kind: `git ${sub}` };
  }

  // `-i` 可以和其他短参数并写：`perl -pi -e`、`sed -Ei`。
  if (name === "sed" && args.some((token) => token === "--in-place" || /^-[a-zA-Z]*i/.test(token))) {
    return { mutating: true, kind: "sed -i" };
  }
  if (name === "perl" && args.some((token) => token === "--in-place" || /^-[a-zA-Z]*i/.test(token))) {
    return { mutating: true, kind: "perl -i" };
  }
  if (name === "awk" && args.includes("inplace")) return { mutating: true, kind: "awk -i inplace" };

  const subs = PACKAGE_SUBCOMMANDS[name];
  if (subs) {
    const sub = args.find((token) => !token.startsWith("-"));
    if (sub && subs.has(sub)) return { mutating: true, kind: `${name} ${sub}` };
  }

  if (name === "docker" || name === "podman") {
    const sub = args.find((token) => !token.startsWith("-"));
    if (sub === "build") return { mutating: true, kind: `${name} build` };
  }

  // xargs / find -exec：真正执行的命令在后面。
  if (name === "xargs" || args.includes("-exec") || args.includes("-execdir")) {
    const inner = args.find((token) => {
      const candidate = basename(token);
      return MUTATING_COMMANDS.has(candidate) || PACKAGE_SUBCOMMANDS[candidate] !== undefined || candidate === "git";
    });
    if (inner) {
      const nested = mutatingIn(args.slice(args.indexOf(inner)));
      if (nested.mutating) return nested;
    }
  }

  return { mutating: false };
}

/** 一段 shell 命令是否会写工作区。 */
export function shellMutationVerdict(command: string): ShellMutationVerdict {
  if (!command.trim()) return { mutating: false };
  if (hasFileRedirect(command)) return { mutating: true, kind: "redirect" };
  for (const tokens of segmentShellTokens(command)) {
    const verdict = mutatingIn(tokens);
    if (verdict.mutating) return verdict;
  }
  return { mutating: false };
}

const ROLE_MESSAGES: Readonly<Record<WindowRole, { zh: string; en: string }>> = Object.freeze({
  main: {
    zh: "主窗口不改文件：这是执行窗口的活。把任务交给派单窗口（deck_handoff_to_dispatcher）。",
    en: "The main window does not edit files. Hand the task to the dispatcher with deck_handoff_to_dispatcher.",
  },
  requirement: {
    zh: "需求窗口只建需求票，不改文件：改代码交给派单窗口派的执行窗口。",
    en: "The requirement window only files requirement tickets; it does not edit files. Let an execution window do that.",
  },
  dispatcher: {
    zh: "派单窗口只拆活和派单，不写代码、不改文件：交给执行窗口。",
    en: "The dispatcher only splits and dispatches work; it does not edit files. Let an execution window do it.",
  },
  progress: {
    zh: "进度窗口只旁听，不改文件。",
    en: "The progress window only observes; it does not edit files.",
  },
});

/**
 * 拒绝文案：按角色说，shell 再补一句命中的命令种类。
 *
 * 中英两行都给：权限请求来自哪个语言的会话，插件这边没有可靠来源（编排设置里没有语言字段，
 * 宿主事件也不带），与其猜错语言，不如两行都写。
 */
export function executionDenyMessage(role: WindowRole, kind: string): string {
  const messages = ROLE_MESSAGES[role];
  const base = `${messages.zh}\n${messages.en}`;
  if (kind === "write" || kind === "edit") return base;
  return `${base}\n这条命令会改文件（${kind}），属于执行窗口。\nThis command writes files (${kind}) and belongs to an execution window.`;
}
