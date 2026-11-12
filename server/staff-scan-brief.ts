/**
 * 扫岗的「看」：清点工作区、拼出扫描简报。
 *
 * 与 `staff-scan.ts` 分开，是因为这是两件互不相干的事：这边只读目录、拼文字，
 * 那边负责起会话、读结果。清点与简报是纯的（给定目录 → 一段文字），能单独测；
 * 会话那半边要碰宿主与文件系统，测不起。混在一个文件里，改一处就得读另一处。
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { MAX_STAFF_SCAN_CANDIDATES, STAFF_SCAN_FILE } from "../shared/staff-scan.ts";
import type { StaffCard } from "../shared/staff.ts";
import { sessionErrorDetail } from "./session.ts";


/** 清点时跳过的目录：这些里面没有「谁负责哪片」，只有打包产物和依赖。 */
const SKIP_DIRS = new Set([
  ".git",
  ".github", // CI 单独列，不当作岗位来源
  ".deck",
  ".claude",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  ".turbo",
  ".nx",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "tmp",
  "temp",
]);

/** 值得列进简报的根目录文件：判语言、判包结构、判可部署单元就看这些。 */
const MANIFESTS = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "tsconfig.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "composer.json",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "AGENTS.md",
  "CLAUDE.md",
  "GLOSSARY.md",
  "README.md",
  ".paseo-deck.json",
]);

/** 每个顶层目录往下看几项：够看出它是「一层套一层的包」还是「平铺的文件堆」。 */
const MAX_CHILDREN = 16;
/** 顶层目录最多清点几个：再多简报就成了目录快照，扫的人反而看不清。 */
const MAX_DIRS = 24;

export interface ScanDir {
  name: string;
  /** 直接子项名字（文件与目录都算），已跳过依赖与产物。 */
  children: string[];
}

export interface ScanInventory {
  /** 清点到的顶层目录。 */
  dirs: ScanDir[];
  /** 根目录里存在的清单/说明文件。 */
  files: string[];
  /** CI 配置：有就列出来，它比 README 更能说明「哪些包真的在跑」。 */
  ci: string[];
  /** 清点时读不出来的目录：说出来，不假装它不存在。 */
  warnings: string[];
}

function isSkipped(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

async function childrenOf(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .filter((name) => !isSkipped(name.replace(/\/$/, "")))
    .sort()
    .slice(0, MAX_CHILDREN);
}

/**
 * 清点工作区。
 *
 * 只读两层：顶层目录 + 它们的直接子项。更深的层级交给扫描会话自己去读——
 * 简报的作用是让人知道「从哪儿下手」，不是替它把整个仓库抄一遍。
 */
export async function inventoryOf(workspaceDir: string): Promise<ScanInventory> {
  const warnings: string[] = [];
  const entries = await readdir(workspaceDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && (MANIFESTS.has(entry.name) || /^pm2.*\.json$/i.test(entry.name)))
    .map((entry) => entry.name)
    .sort();

  const ci: string[] = [];
  if (entries.some((entry) => entry.isDirectory() && entry.name === ".github")) {
    try {
      const workflows = await childrenOf(path.join(workspaceDir, ".github", "workflows"));
      ci.push(...workflows.map((name) => `.github/workflows/${name}`));
    } catch (error) {
      warnings.push(`读不出 .github/workflows：${sessionErrorDetail(error)}`);
    }
  }
  for (const name of [".gitlab-ci.yml", "Jenkinsfile", ".drone.yml", "bitbucket-pipelines.yml"]) {
    if (existsSync(path.join(workspaceDir, name))) ci.push(name);
  }

  const dirs: ScanDir[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isSkipped(entry.name)) continue;
    if (dirs.length >= MAX_DIRS) {
      warnings.push(`顶层目录超过 ${MAX_DIRS} 个，只列了前 ${MAX_DIRS} 个`);
      break;
    }
    try {
      dirs.push({ name: entry.name, children: await childrenOf(path.join(workspaceDir, entry.name)) });
    } catch (error) {
      // 读不出来也照样列出来：扫描会话自己会发现读不了，简报不该替它把目录抹掉。
      dirs.push({ name: entry.name, children: [] });
      warnings.push(`读不出 ${entry.name}/ 的子项：${sessionErrorDetail(error)}`);
    }
  }

  return { dirs, files, ci, warnings };
}

/** 名册卡的领地展示：`.` 是整片；空是旧数据「没配」，不能读成整片。 */
function territoryTextOf(paths: readonly string[] | undefined, en: boolean): string {
  if (!paths?.length) return en ? "(not set)" : "（没配）";
  if (paths.length === 1 && paths[0] === ".") return en ? "whole workspace" : "整片";
  return paths.join(en ? ", " : "、");
}

/** 简报里的名册段：只说已有的名字与领地，别重复提案同一片。 */
function rosterLines(cards: readonly StaffCard[], lang?: "zh" | "en"): string[] {
  const en = lang === "en";
  if (!cards.length) return [en ? "(roster is still empty)" : "（名册还是空的）"];
  return cards.map((card) => {
    const kind = en
      ? card.kind === "manager"
        ? "manager"
        : "worker"
      : card.kind === "manager"
        ? "经理"
        : "员工";
    const territory = territoryTextOf(card.paths, en);
    return en
      ? `- ${card.name} (${card.id}, ${kind}) territory: ${territory}`
      : `- ${card.name}（${card.id}，${kind}）领地：${territory}`;
  });
}

export interface ScanBriefInput {
  workspaceDir: string;
  cards: readonly StaffCard[];
  lang?: "zh" | "en";
}

/**
 * 拼扫描简报。
 *
 * 这份文字是发给扫描会话的**第一条提示词**：清点结果 + 规矩 + 落盘格式。
 * 格式必须写死在这里：结果要过 `parseStaffScan`，字段名对不上就是白扫一趟。
 */
export function buildScanBrief(input: ScanBriefInput, inventory: ScanInventory): string {
  const root = path.basename(input.workspaceDir) || input.workspaceDir;
  const dirLines = inventory.dirs.length
    ? inventory.dirs.map((dir) => `- ${dir.name}/ → ${dir.children.join("、") || "（空或读不出来）"}`)
    : ["（没有可列的顶层目录）"];
  const fileLines = inventory.files.length ? inventory.files.join("、") : "（根目录没有清单文件）";
  const ciLines = inventory.ci.length ? inventory.ci.join("、") : "（没找到 CI 配置）";
  const warnLines = inventory.warnings.length ? ["", "清点时读不出来的地方：", ...inventory.warnings.map((w) => `- ${w}`)] : [];

  if (input.lang === "en") {
    return [
      `Staff scan brief for workspace "${root}" (${input.workspaceDir}).`,
      "",
      "Existing roster — do not propose the same territory again:",
      ...rosterLines(input.cards, input.lang),
      "",
      "Top-level directories (with their direct children):",
      ...dirLines,
      "",
      `Root manifests and docs: ${fileLines}`,
      `CI: ${ciLines}`,
      ...warnLines,
      "",
      "How to scan:",
      "1. Read `.claude/skills/project-survey/SKILL.md` if it exists and follow its rules for finding projects and modules.",
      "2. Read the manifests above to confirm languages, package layout and deployable units.",
      "3. Split roles by *who owns which slice of the code*, never by file type (no 'styling engineer').",
      `4. Propose at most ${MAX_STAFF_SCAN_CANDIDATES} roles. Each: name (2-4 words), kind (worker|manager), territories (directories relative to the workspace root that really exist; one or more — write "." only when the whole workspace really is one module), duty (one or two sentences that will become a sub-session system prompt), evidence (1-6 files you actually read, paths relative to the workspace root; at least one must fall inside a territory).`,
      "5. Fewer is better than invented: never claim a directory you did not see.",
      "6. Write exactly one file and nothing else:",
      `   ${path.join(".deck", STAFF_SCAN_FILE)}`,
      '   Format: {"at":"<ISO timestamp>","candidates":[{"name":"Frontend","kind":"worker","duty":"…","paths":["src/web"],"evidence":["src/web/app.tsx"]}]}',
      "   No comments, no prose around it. Do not touch .paseo-deck.json, do not create labels, do not open sub-sessions, do not commit.",
    ].join("\n");
  }

  return [
    `扫岗简报：工作区「${root}」（${input.workspaceDir}）`,
    "",
    "现有名册（同一片领地别再提一次）：",
    ...rosterLines(input.cards),
    "",
    "顶层目录（含直接子项）：",
    ...dirLines,
    "",
    `根目录的清单与说明：${fileLines}`,
    `CI：${ciLines}`,
    ...warnLines,
    "",
    "怎么扫：",
    "1. 先读 `.claude/skills/project-survey/SKILL.md`（存在才读），按它的口径找项目与模块。",
    "2. 再读上面那些清单文件，确认语言、包结构与可部署单元。",
    "3. 按「谁负责哪片代码」切岗位，不按文件类型切（不要「样式岗」「工具函数岗」）。",
    `4. 最多提 ${MAX_STAFF_SCAN_CANDIDATES} 条。每条要有：名字（2–6 字的人话）、身份（worker 或 manager）、领地（相对工作区根、**确实存在**的目录，可多条；只有整个工作区确实是一个模块时才写「.」表示整片）、职责（一两句，会写进子会话的系统提示）、依据（你真读过的文件，1–6 条，路径相对工作区根，至少一条要落在领地里）。`,
    "5. 宁可少一条，也不要编一片你没见过的目录。",
    "6. 只写这一个文件，别的什么都别动：",
    `   ${path.join(".deck", STAFF_SCAN_FILE)}`,
    '   格式：{"at":"<ISO 时间>","candidates":[{"name":"前端","kind":"worker","duty":"…","paths":["src/web"],"evidence":["src/web/app.tsx"]}]}',
    "   不要加注释、不要在文件外再写一遍。不要改 .paseo-deck.json，不要建标签，不要起子会话，不要提交。",
  ].join("\n");
}
