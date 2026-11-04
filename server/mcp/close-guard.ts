/**
 * 关容器前的闸门（照 DSH `src/deck/shell/spec-close-guard.ts` 的口径移植）。
 *
 * 为什么要有它：`deck_issue_patch` 的契约里已经写了「关地图要求同一次调用带评论、
 * 子票必须全关」，但实现里只查了评论。契约与代码不一致时，agent 会照着契约相信
 * 「都关完了」，用户看到的就是「代码做完了、容器还开着」。
 *
 * 判据，全部只读、只判，不写任何东西：
 *   1. 子票清单读不回 / 读不全 = 判不了，整笔拒绝（宁可这次没关成，也不能凭一次读失败当完成）；
 *   2. 还有没关的子票 = 拒绝，逐张报出票号、标题、当前状态；
 *   3. 关闭调用里没带 comment = 拒绝（核对结论与关闭必须在同一次调用里）。
 *
 * 规格还多一条（DSH #1298 的口径）：一张实施票都没有的规格，没有可核对的东西，
 * 不能按完成态关它。地图不套这条——一张没派过工单就被放弃的探索地图是可以关的。
 */

/** 子票清单里这一层真正会读的字段。 */
export interface CloseChild {
  key: string;
  title: string;
  state: string;
}

/**
 * 子票清单的两种状态。
 *
 * 不要用「空数组」表示读不到：空数组在规格上会被判成「没有实施票」，
 * 方向正好相反——它会让一张还有子票的票被放行。
 */
export type CloseChildren =
  | { readable: true; list: readonly CloseChild[] }
  | { readable: false; problem: string };

/**
 * 详情里子票列的原始形状。缺省（`undefined`）表示后端这次没给这一列，不等于 0 张。
 */
export interface DetailChildren {
  children?: readonly { number: number; title: string; state: string }[];
  childrenTotal?: number;
  childrenTruncated?: boolean;
  /** 后端读子票清单失败时的原始原因：原样传给调用方，方便排查。 */
  childrenProblem?: string;
}

/**
 * 把详情里的子票列转成闸门输入。
 *
 * 截断的清单不能当全集的证据：`childrenTotal` 大于读到的张数、或后端自己标了
 * `childrenTruncated`，都按「判不了」处理，让关闭整笔拒绝。
 */
export function closeChildrenOf(detail: DetailChildren): CloseChildren {
  if (detail.children === undefined) {
    return {
      readable: false,
      problem: detail.childrenProblem?.trim() || "这张票的详情里没有子票清单（后端这次没给父子信息）",
    };
  }
  if (detail.childrenTruncated === true) {
    return {
      readable: false,
      problem: `后端明说子票清单被截断：读到的 ${detail.children.length} 张不是全集，拿残表核对会漏掉没关的子票`,
    };
  }
  const total = detail.childrenTotal ?? detail.children.length;
  if (total > detail.children.length) {
    return {
      readable: false,
      problem: `子票清单只读到 ${detail.children.length} 张（共 ${total} 张），拿残表核对会漏掉没关的子票`,
    };
  }
  return {
    readable: true,
    list: detail.children.map((child) => ({
      key: String(child.number),
      title: child.title,
      state: child.state,
    })),
  };
}

export interface CloseGuardInput {
  /** 调用方已确认这是容器；普通票不会进这道闸门。 */
  kind: "map" | "spec";
  key: number;
  hasComment: boolean;
  children: CloseChildren;
}

export type CloseGuardResult = { kind: "ok" } | { kind: "refuse"; rule: string; text: string };

/** 容器中文名与它下面的子票叫法：拒绝文案里必须说人话，不能只给一个 kind。 */
const NAMES: Readonly<Record<"map" | "spec", { label: string; child: string }>> = Object.freeze({
  map: { label: "地图", child: "工单" },
  spec: { label: "规格", child: "实施票" },
});

/** 一张子票是不是已经关了：后端给的状态大小写不一致（CLOSED / closed），统一按大写比。 */
function isClosed(child: CloseChild): boolean {
  return String(child.state ?? "").trim().toUpperCase() === "CLOSED";
}

function childLine(child: CloseChild): string {
  const title = child.title?.trim() || "没标题";
  return `#${child.key}（${title}，当前 ${child.state || "未知"}）`;
}

const refuse = (rule: string, text: string): CloseGuardResult => ({ kind: "refuse", rule, text });

/** 还有没关的子票：逐张报出，并说清下一步。 */
function openChildrenRefusal(
  kind: "map" | "spec",
  scene: string,
  open: readonly CloseChild[],
): CloseGuardResult {
  const names = NAMES[kind];
  return refuse(
    "container-close-children-open",
    `${scene} 下面还有 ${open.length} 张${names.child}没关：` +
      open.map(childLine).join("；") +
      `。${names.child}没全关时不能关${names.label}：先把没做完的做完或说明清楚，再回来走收口核对。`,
  );
}

/**
 * 判一次关闭能不能放行。
 *
 * `children.readable === false` 表示清单没读到 / 不完整（截断、后端不给父子信息）；
 * 调用方不能先把它压成空数组再传进来。
 */
export function containerCloseGuard(input: CloseGuardInput): CloseGuardResult {
  const names = NAMES[input.kind];
  const scene = `${names.label} #${input.key}`;
  if (!input.children.readable) {
    const why = input.children.problem.trim() || "读不出子票清单";
    return refuse(
      "container-close-children-unreadable",
      `${scene} 下面的${names.child}没取到（${why}）：判不了是不是全关，先不关。等能读回${names.child}清单再调一次。`,
    );
  }

  const children = input.children.list;
  if (input.kind === "spec" && children.length === 0) {
    return refuse(
      "container-close-no-children",
      `${scene} 下面还没有${names.child}：没有${names.child}就没有可核对的东西，不能按完成态关它。先补${names.child}（跑 /to-tickets）再回来关。`,
    );
  }

  const open = children.filter((child) => !isClosed(child));
  if (open.length > 0) return openChildrenRefusal(input.kind, scene, open);

  if (!input.hasComment) {
    return refuse(
      "container-close-no-comment",
      `关${names.label}前必须留一条评论写明逐张核对结论：这次调用里没带 comment，关闭动作没做` +
        `（评论与关闭要在同一次调用里）。先在 comment 里写每一张${names.child}的核对结论，再带 close:true 一起调一次。`,
    );
  }
  return { kind: "ok" };
}
