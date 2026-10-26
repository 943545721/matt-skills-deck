import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 假 `gh`：塞进 PATH 顶替真命令，用于测「我们怎么调用它、失败怎么分类」。
 *
 * 每次调用往日志里写一行「子命令|第二参数」，脚本体由调用方给（决定这次成什么样），
 * 所以既能断言调用次数，也能断言第一个参数是 `api` 还是 `issue`。
 * 用完必须 `restore()`——它会还原 PATH 并删掉临时目录。
 */
export function fakeGh(body) {
  const dir = mkdtempSync(path.join(tmpdir(), "deck-gh-"));
  const bin = path.join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s|%s\\n' "$1" "$2" >> "$GH_LOG"\n${body}\n`, "utf8");
  chmodSync(bin, 0o755);
  const log = path.join(dir, "gh.log");
  const previousPath = process.env.PATH;
  const previousLog = process.env.GH_LOG;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  process.env.GH_LOG = log;
  return {
    dir,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((entry) => entry.split("|")[0])
        : [],
    restore: () => {
      process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = previousLog;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
