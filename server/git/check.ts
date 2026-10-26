import type { Plan, WriteOp } from "./tickets.ts";

export interface JudgeInput {
  op: WriteOp;
  branch: string;
  upstream: string;
  upstreamGone: boolean;
  stagedCount: number;
  hasIntentToAdd: boolean;
  remotes: readonly string[];
  requestedRemote?: string;
}

export type Judgement =
  | { verdict: "allow"; plan: Plan }
  | { verdict: "block"; reasons: string[] }
  | { verdict: "need-choice"; candidates: string[] };

/**
 * 写操作判定：只读、纯函数，输入是首屏读数。
 *
 * 分开写是为了能用固定读数测——「没有暂存就挡提交」「多远端要人选」这些规则
 * 是这套界面最该有测试的部分，而它们与 git 命令的执行方式无关。
 */
export function judge(input: JudgeInput): Judgement {
  if (input.op === "commit") {
    if (input.stagedCount === 0) {
      // i-t-a 是更具体的理由：用户确实改过文件，只是它们还没真正进索引。
      return { verdict: "block", reasons: [input.hasIntentToAdd ? "intent-to-add" : "nothing-staged"] };
    }
    if (!input.branch) return { verdict: "block", reasons: ["detached-head"] };
    return { verdict: "allow", plan: { remote: "", branch: input.branch, setUpstream: false } };
  }

  if (!input.branch) return { verdict: "block", reasons: ["detached-head"] };

  if (input.op === "pull") {
    if (!input.upstream || input.upstreamGone) return { verdict: "block", reasons: ["no-upstream"] };
    return {
      verdict: "allow",
      plan: { remote: input.upstream.split("/")[0] ?? "", branch: input.branch, setUpstream: false },
    };
  }

  // push / fetch 都要远端。多远端时让用户选，不替人挑。
  if (input.op === "fetch" || input.op === "push") {
    if (input.remotes.length === 0) return { verdict: "block", reasons: ["no-remote"] };
    const candidates = input.remotes;
    if (input.requestedRemote) {
      if (!candidates.includes(input.requestedRemote)) {
        return { verdict: "need-choice", candidates: [...candidates] };
      }
      return {
        verdict: "allow",
        plan: {
          remote: input.requestedRemote,
          branch: input.branch,
          setUpstream: input.op === "push" && (!input.upstream || input.upstreamGone),
        },
      };
    }
    if (candidates.length > 1) return { verdict: "need-choice", candidates: [...candidates] };
    return {
      verdict: "allow",
      plan: {
        remote: candidates[0] ?? "",
        branch: input.branch,
        setUpstream: input.op === "push" && (!input.upstream || input.upstreamGone),
      },
    };
  }

  return { verdict: "block", reasons: ["bad-target"] };
}

/** 原因码 → 一句人话。界面直接显示，不再二次翻译。 */
export const REASON_TEXT: Record<string, string> = {
  "nothing-staged": "还没有暂存任何改动，先勾几个文件",
  "intent-to-add": "这些文件只是「打算加」的空占位，先完整地 git add 一次",
  "detached-head": "当前处于分离 HEAD，先切到一个分支",
  "no-upstream": "这个分支没有上游，先推送一次建立跟踪",
  "no-remote": "这个仓库没有配置远端",
  "bad-target": "这次操作缺少必要的目标",
};
