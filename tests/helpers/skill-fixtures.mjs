import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 多项目技能安装的测试夹具。
 *
 * 技能源用临时目录现造，而不是拿 `templates/skills` 里的真技能：这样才能精确控制
 * 「谁有 references」「谁的正文是旧版本」，也免得测试跟着技能包内容一起漂。
 */

export function tempRoot(tag = "skills") {
  return mkdtempSync(path.join(tmpdir(), `deck-${tag}-`));
}

/** 造一份技能（主文件必写），额外文件按相对路径给。返回 `BundledSkill` 形状。 */
export function makeSkill(sourceRoot, id, extra = {}) {
  const base = path.join(sourceRoot, id);
  mkdirSync(base, { recursive: true });
  writeFileSync(path.join(base, "SKILL.md"), `---\nname: ${id}\ndescription: ${id} 的测试技能\n---\n正文\n`, "utf8");
  for (const [rel, body] of Object.entries(extra)) {
    const file = path.join(base, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
  }
  return { id, name: id, description: `${id} 的测试技能`, file: path.join(base, "SKILL.md") };
}

/** 造一个 v2 工作区：项目目录按 `dir` 建好，`.paseo-deck.json` 写清单。 */
export function workspaceWith(projects, options = {}) {
  const workspace = tempRoot("ws");
  for (const project of projects) {
    mkdirSync(path.join(workspace, project.dir), { recursive: true });
  }
  const config = { version: 2, projects };
  writeFileSync(path.join(workspace, ".paseo-deck.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  if (options.deckAsFile) writeFileSync(path.join(workspace, ".deck"), "挡住备份", "utf8");
  return workspace;
}

/** 直接往项目里写一份「项目自己写的技能」。 */
export function writeLocalSkill(projectDir, clientRoot, id, body = "自写技能", extra = {}) {
  const base = path.join(projectDir, clientRoot, "skills", id);
  mkdirSync(base, { recursive: true });
  writeFileSync(path.join(base, "SKILL.md"), body, "utf8");
  for (const [rel, text] of Object.entries(extra)) {
    const file = path.join(base, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
  }
  return base;
}

/** 一个目录的完整内容：相对路径 → 正文。用来比较备份与原件是否逐字节一致。 */
export function snapshotTree(root) {
  const out = new Map();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else out.set(rel, readFileSync(abs, "utf8"));
    }
  };
  walk(root, "");
  return out;
}

export function cleanup(dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
