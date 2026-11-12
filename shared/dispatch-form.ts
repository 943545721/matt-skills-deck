/**
 * 派单台（面板表单）到 `deck.orchestration.dispatch` 入参的那一跳。
 *
 * 之所以单独抽成纯函数而不是写在面板里：这段「什么算填好了」的判定有几条硬规则
 * （空提示词、名册非空却没选卡、没填需求票号或票号不是正整数），面板里夹在 JSX 里
 * 就没法单独钉住。服务器也会拒这些，但让它先拒一遍意味着用户点一次、等一个往返、
 * 再看一句机器码；在这里拦住能直接说人话。
 *
 * 只做形状整理，不做业务判定：链条闸、repoKey 归属、层数、并发都在服务端。
 */

export interface DispatchFormTask {
  key: string;
  prompt: string;
  title?: string;
  staff?: string;
  repoKey?: string;
  requirementKey?: number;
  requirementRepoKey?: string;
  region?: { repoKey?: string; pathPrefix?: string };
}

export interface DispatchFormInput {
  /** 任务 key：同一批里唯一即可，面板用时间戳生成。 */
  key: string;
  prompt: string;
  title?: string;
  staffId?: string;
  repoKey?: string;
  pathPrefix?: string;
  /** 需求票号；必填。无票不干活，服务器也会拒。 */
  requirementNumber?: number | null;
  requirementRepoKey?: string;
  /** 名册非空时为真：没选卡就让调用方先拒，别等服务器按 region 猜一个人。 */
  staffRequired?: boolean;
  /** 工作区有多个仓库时为真：没选仓库就让调用方先拒，服务器那边是多仓库必填。 */
  repoRequired?: boolean;
}

export type DispatchFormResult = { ok: true; task: DispatchFormTask } | { ok: false; problem: string };

const MAX_PROMPT_CHARS = 100_000;
const MAX_TITLE_CHARS = 500;

const text = (value: string | undefined): string => (typeof value === "string" ? value.trim() : "");

export function buildDispatchTask(input: DispatchFormInput): DispatchFormResult {
  if (!text(input.key)) return { ok: false, problem: "任务 key 不能为空" };

  const prompt = text(input.prompt);
  if (!prompt) return { ok: false, problem: "提示词不能为空" };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false, problem: `提示词最多 ${MAX_PROMPT_CHARS} 字：拆成两条任务，别塞成一条` };
  }

  const title = text(input.title);
  if (title.length > MAX_TITLE_CHARS) {
    return { ok: false, problem: `标题最多 ${MAX_TITLE_CHARS} 字` };
  }

  const staffId = text(input.staffId);
  if (input.staffRequired && !staffId) {
    return { ok: false, problem: "名册里已经有人：先选一张卡，不替你猜" };
  }

  // 多仓库工作区的 `repoKey` 是服务端必填（见 `runDispatch` 的多仓库校验）：在这里拦比
  // 等一个往返再看机器码好，但判定依据只能是调用方给的那面镜子，这里不自己去读仓库。
  const repoKey = text(input.repoKey);
  if (input.repoRequired && !repoKey) {
    return { ok: false, problem: "这个工作区有多个仓库：先选一个，不替你猜" };
  }

  const requirementNumber = input.requirementNumber ?? null;
  if (requirementNumber === null) {
    return { ok: false, problem: "需求票号必填：无票不干活，先建一张需求票再派" };
  }
  if (!Number.isInteger(requirementNumber) || requirementNumber < 1) {
    return { ok: false, problem: "需求票号是正整数，比如 42" };
  }

  const pathPrefix = text(input.pathPrefix);
  const requirementRepoKey = text(input.requirementRepoKey);
  // `region` 只在真的写了区域时出现：空对象会被服务端当「声明了区域但什么都没填」。
  const region =
    repoKey || pathPrefix
      ? { ...(repoKey ? { repoKey } : {}), ...(pathPrefix ? { pathPrefix } : {}) }
      : undefined;

  return {
    ok: true,
    task: {
      key: input.key.trim(),
      prompt,
      ...(title ? { title } : {}),
      ...(staffId ? { staff: staffId } : {}),
      ...(repoKey ? { repoKey } : {}),
      ...(requirementNumber !== null ? { requirementKey: requirementNumber } : {}),
      ...(requirementNumber !== null && requirementRepoKey ? { requirementRepoKey } : {}),
      ...(region ? { region } : {}),
    },
  };
}
