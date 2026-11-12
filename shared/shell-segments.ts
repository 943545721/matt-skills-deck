/**
 * 把一条 shell 命令拆成「几条会被依次执行的简单命令」。
 *
 * 两道闸都要看命令里真正会跑的是什么：票闸找 `gh` / `glab`，执行门找改文件的命令。
 * 拆法只留一份，免得同一条命令在两道闸里被切成不同的段、得出相反的结论。
 *
 * 命令替换与子 shell 也算一条：`$(gh …)`、`` `gh …` ``、`(gh …)` 里的东西真的会跑，
 * 双引号里的 `$(…)` 同样会展开。单引号里不展开，所以只在双引号里认这两个。
 *
 * 纯函数：不执行命令、不读文件，只看命令文本。
 */

/** 取出 `$(…)` / 反引号里真正会执行的那段，并给出它结束的位置。 */
function substitutionAt(command: string, index: number): { inner: string; next: number } {
  const char = command[index]!;
  const start = index + (char === "$" ? 2 : 1);
  const close = command.indexOf(char === "$" ? ")" : "`", start);
  return { inner: command.slice(start, close >= 0 ? close : undefined), next: close >= 0 ? close : command.length };
}

/**
 * `bash -c "…"` / `bash -lc "…"` 里真正会跑的脚本；没有 `-c` 就看不进去（脚本在文件里）。
 *
 * 两道闸都要往下钻这一层：`bash -c "gh issue create …"` 与 `bash -c "rm -rf …"`
 * 不改个判法就能绕过各自的门。
 */
export function shellScriptOf(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return null;
    if (/^-[a-z]*c[a-z]*$/i.test(arg)) return args[index + 1] ?? null;
    if (!arg.startsWith("-")) return null;
  }
  return null;
}

/** 拆成若干段，每段是一组已去掉引号的 token。 */
export function segmentShellTokens(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  const pushToken = () => { if (token) { tokens.push(token); token = ""; } };
  const pushSegment = () => { pushToken(); if (tokens.length) segments.push(tokens); tokens = []; };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const substitution = char === "`" || (char === "$" && command[index + 1] === "(");
    if (quote) {
      if (char === quote) quote = null;
      // 双引号里命令替换照样展开：把括号里那段单独再拆一遍，整体当一个新段。
      // 单引号里不展开，照原文收进 token。
      else if (quote === '"' && substitution) {
        pushSegment();
        const taken = substitutionAt(command, index);
        segments.push(...segmentShellTokens(taken.inner));
        index = taken.next;
      } else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (substitution || char === "(" || char === ")" || char === "{" || char === "}") {
      pushSegment();
      if (char === "$") index += 1;
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (next) {
        token += next;
        index += 1;
      }
      continue;
    }
    if (char === " " || char === "\t") {
      pushToken();
      continue;
    }
    // `;` `&&` `||` `|` 换行：下一条命令从这里开始。`&` 一并当分隔符，
    // 顺带把 `2>&1` 拆开也无妨——它两侧本来就不是新的命令调用。
    if (char === "\n" || char === ";" || char === "&" || char === "|") {
      pushSegment();
      continue;
    }
    token += char;
  }
  pushSegment();
  return segments;
}
