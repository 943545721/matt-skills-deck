/**
 * 票闸的 shell 侧闸门：认出「用 gh / glab 直接动票」的命令。
 *
 * MCP 的 `deck_issue_create` / `deck_issue_patch` 会拒绝 `deck:` 前缀、要求需求先定稿，
 * 但会话只要肯敲 `gh issue create`，这些闸就一条都不经过——同一张板子上于是出现两张
 * 互不相认的票。插件能挂到的唯一位置是 `agent.permission_requested` 的 shell 详情，
 * 所以这里只做一件事：在命令真正跑起来之前认出来并拒绝。
 *
 * 认出的是**改动票面**的命令，不是所有 gh：
 * - `gh|glab issue <写动作>`：建、关、改、评论、删、转移、锁、置顶；
 * - `gh|glab api` 且方法/字段意味着写，并且目标是票面（issues / labels / milestones / graphql）——
 *   往 PR、release、gist 上写不归这道闸管；
 * - `label delete / edit / clone`：删掉或改名一个标签，会让票闸认不出它。
 * 读命令（`gh issue list` / `gh issue view` / `gh api` 的 GET）一律放行——
 * 只读是排查问题的正常手段，拦它只会逼人去找别的绕法。`label create` 也放行：
 * 建一个标签定义不改变任何一张票，而且票级提示词本来就让用户缺标签时先建。
 *
 * 会往下钻的写法：`bash -c "…"` / `bash -lc` / `eval …`、`$(…)` 与反引号、`(…)` 子 shell、
 * `sudo bash -c …` / `timeout 30 sh -c …` 这类包装词套 shell、`gh -R owner/repo …`、
 * `sudo -u root …`、`VAR=x …`。
 *
 * **边界（写在这里，免得被当成「全封死」）**：这是按命令文本认形状，不解释变量展开与
 * 别名；`curl https://api.github.com/…`、`gh alias set` 之后再调别名、把脚本从标准输入
 * 喂给 shell（`echo "gh …" | bash`），以及不带 shell 详情的客户端窗口，这里都认不出来。
 * 它挡的是「顺手用 gh 绕过去」，不是沙箱。
 * 真正的底线仍是不给会话 GitHub 写凭证；这条闸只是让默认路径走回插件。
 *
 * 纯函数：不执行命令、不读文件。判断只看命令文本。
 */

import { segmentShellTokens, shellScriptOf } from "./shell-segments.ts";

/** 给会话看的一句话：说清该走哪条路，而不是只说「不许」。 */
export const TICKET_GUARD_MESSAGE =
  "票要走插件的票闸：建票、改票、打标签请用 deck_issue_create / deck_issue_patch / deck_issue_labels。gh 能绕过票闸，插件不允许。";

/** 会被这道闸认作「票务工具」的命令名。 */
const TICKET_TOOLS = new Set(["gh", "glab"]);

/** `issue` 子命令里会改动票面的动词（gh 与 glab 的常用写法都在这里）。 */
const ISSUE_WRITE_VERBS = new Set([
  "create",
  "close",
  "reopen",
  "edit",
  "update",
  "comment",
  "note",
  "delete",
  "transfer",
  "lock",
  "unlock",
  "pin",
  "unpin",
  "develop",
]);

/** `label` 子命令里会让已有标签消失或改名的动词（标签决定一张票能不能被派）。 */
const LABEL_WRITE_VERBS = new Set(["delete", "edit", "clone"]);

/** `api` 里明确表示写的方法。 */
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** 带这些参数时默认就是 POST：不写方法也是在写。 */
const API_BODY_FLAGS = new Set(["-f", "--field", "-F", "--raw-field", "--input"]);

/** `api` 里会吃掉下一个 token 的参数：找 endpoint 时要跳过它们的值。 */
const API_VALUE_FLAGS = new Set([
  "-x",
  "--method",
  "-f",
  "--field",
  "-F",
  "--raw-field",
  "--input",
  "-H",
  "--header",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
]);

/** 只有写到这些资源上才算碰票面；PR / release / gist 不归这道闸管。 */
const TICKET_ENDPOINT = /(^|\/)(issues|labels|milestones)(\/|$)|graphql/i;
/** PR / release / gist 自己的子资源（例如 `pulls/1/labels`）也算它们的，不算票面。 */
const NON_TICKET_ENDPOINT = /(^|\/)(pulls|releases|gists)(\/|$)/i;

/**
 * 命令前面那些不改变「真正跑的是谁」的词。
 *
 * `sudo timeout 30 gh ...` 与 `FOO=1 gh ...` 都得认出 `gh`，否则改个前缀就绕过去了。
 */
const WRAPPERS = new Set(["sudo", "command", "exec", "env", "nice", "nohup", "time", "timeout", "xargs", "doas"]);

/** 包装词里会吃掉下一个 token 的选项（`sudo -u root`、`env -C dir`）。 */
const WRAPPER_VALUE_OPTIONS = new Set(["-u", "--user", "-g", "--group", "-c", "--chdir"]);

/** gh / glab 放在子命令之前的全局参数（`gh -R owner/repo issue create`）。 */
const GLOBAL_VALUE_FLAGS = new Set(["-r", "--repo", "--hostname", "--config"]);

/** 会再起一层解析的 shell 与求值命令。 */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const EVALS = new Set(["eval", "source"]);

function baseName(token: string): string {
  const parts = token.split(/[\\/]/);
  return (parts[parts.length - 1] ?? token).toLowerCase();
}

/**
 * 跳过包装词、选项与环境变量赋值，返回真正要跑的命令名与下标；没有命令时 index 为 -1。
 *
 * 这里不假定「包装词后面只可能是 gh」：`sudo bash -c "gh …"` 的真正命令是 `bash`，
 * 交给调用方决定怎么往下钻。
 */
function commandStart(tokens: readonly string[]): { name: string; index: number } {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    const name = baseName(token);
    if (!WRAPPERS.has(name)) return { name, index };
    index += 1;
    // 跳过包装词自己的选项与参数：`timeout -s KILL 30 gh`、`sudo --user=root gh`、`nice -n 5 gh`；
    // `env FOO=1 gh` 里的赋值交回外层循环，和普通前缀一样处理。
    while (index < tokens.length) {
      const arg = tokens[index]!;
      if (WRAPPER_VALUE_OPTIONS.has(arg.toLowerCase())) {
        index += 2;
        continue;
      }
      if (/^[-+]?\d+$/.test(arg) || arg.startsWith("-") || /^(?:KILL|TERM|INT|HUP|QUIT)$/i.test(arg)) {
        index += 1;
        continue;
      }
      break;
    }
  }
  return { name: "", index: -1 };
}

/** 跳过 `gh -R owner/repo …` 这类全局参数，剩下的第一个词才是子命令。 */
function ticketArgs(args: readonly string[]): readonly string[] {
  let index = 0;
  while (index < args.length) {
    const lower = args[index]!.toLowerCase();
    if (GLOBAL_VALUE_FLAGS.has(lower)) {
      index += 2;
      continue;
    }
    if ([...GLOBAL_VALUE_FLAGS].some((flag) => lower.startsWith(`${flag}=`))) {
      index += 1;
      continue;
    }
    return args.slice(index);
  }
  return [];
}

/** `gh api` 的目标资源：第一个不是选项、也不是选项值的 token。 */
function apiEndpoint(args: readonly string[]): string {
  let skipValue = false;
  for (const arg of args.slice(1)) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    const lower = arg.toLowerCase();
    if (API_VALUE_FLAGS.has(lower)) {
      skipValue = true;
      continue;
    }
    if (lower.startsWith("-")) continue;
    return arg;
  }
  return "";
}

/** 判断一条简单命令；命中返回简短理由（进日志用），否则 null。 */
function reasonOfSegment(tokens: readonly string[]): string | null {
  const start = commandStart(tokens);
  if (start.index < 0) return null;
  const args = tokens.slice(start.index + 1);

  if (SHELLS.has(start.name)) {
    const script = shellScriptOf(args);
    return script ? reasonOfCommand(script) : null;
  }
  if (EVALS.has(start.name)) return reasonOfCommand(args.join(" "));
  if (!TICKET_TOOLS.has(start.name)) return null;

  const tool = start.name;
  const trimmed = ticketArgs(args);
  const group = (trimmed[0] ?? "").toLowerCase();
  const verb = (trimmed[1] ?? "").toLowerCase();

  if (group === "issue" && ISSUE_WRITE_VERBS.has(verb)) return `${tool} issue ${verb}`;
  if (group === "label" && LABEL_WRITE_VERBS.has(verb)) return `${tool} label ${verb}`;
  if (group !== "api") return null;

  let method = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const arg = trimmed[index]!;
    const lower = arg.toLowerCase();
    if (lower === "-x" || lower === "--method") {
      method = (trimmed[index + 1] ?? "").toUpperCase();
      continue;
    }
    if (lower.startsWith("--method=")) method = arg.slice("--method=".length).toUpperCase();
    if (/^-x(?:post|patch|put|delete)$/.test(lower)) method = lower.slice(2).toUpperCase();
  }
  const hasBody = trimmed.some((arg) => {
    const lower = arg.toLowerCase();
    return API_BODY_FLAGS.has(lower) || [...API_BODY_FLAGS].some((flag) => lower.startsWith(`${flag}=`));
  });
  // 没写方法时带字段就是 gh 的默认 POST；写了 GET / HEAD 就是读，字段只是查询参数。
  const writes = method ? MUTATING_METHODS.has(method) : hasBody;
  if (!writes) return null;

  // 写到 PR / release / gist 上不是这道闸的事；认不出 endpoint 时按票面处理（宁严勿漏）。
  const endpoint = apiEndpoint(trimmed);
  if (!endpoint) return `${tool} api 写票面`;
  if (NON_TICKET_ENDPOINT.test(endpoint)) return null;
  return TICKET_ENDPOINT.test(endpoint) ? `${tool} api 写票面` : null;
}

function reasonOfCommand(command: string): string | null {
  for (const tokens of segmentShellTokens(command)) {
    const reason = reasonOfSegment(tokens);
    if (reason) return reason;
  }
  return null;
}

/** 命中时带理由与回话，没命中就是干净的 false：调用方不用记「两个空串」的约定。 */
export type TicketCommandVerdict =
  | { blocked: true; /** 给日志的简短理由。 */ reason: string; /** 回给会话的话。 */ message: string }
  | { blocked: false };

/**
 * 这条命令会不会绕开票闸去改票。
 *
 * 逐段判断：`cd x && gh issue create ...` 与 `gh issue list | head` 里的两段分开看，
 * 前者拦、后者放。判断只看文本，不解析别名与变量展开——那是 shell 的活，
 * 我们只需要挡住最常见的那条路，剩下的写进日志让人知道边界在哪。
 */
export function ticketCommandVerdict(command: string): TicketCommandVerdict {
  const reason = reasonOfCommand(command);
  return reason ? { blocked: true, reason, message: TICKET_GUARD_MESSAGE } : { blocked: false };
}
