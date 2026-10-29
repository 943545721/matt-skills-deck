/**
 * 本地 Markdown 后端的「工作单元目录」参数（照抄 DSH `src/deck/tools/md-scope.ts`，#1480 T2）。
 *
 * 规格、实施票、普通票住在 `.scratch/<feature-slug>/`；探索地图与它的子票住在 `.scratch/<effort>/`。
 * 工具面对 AI 时按场景给词（feature / effort），落到后端仍是同一个寻址范围：`.scratch/` 下的目录名。
 *
 * 约定：两个参数互斥；目录名只能是单段普通目录名；都不填时不限定，由调用方按父票或标题决定。
 * 远端后端忽略这两个参数。
 */

export type MdScope =
  | { ok: true; effortId: string; scene: "" | "effort" | "feature" }
  | { ok: false; message: string };

/** 目录名里不能出现的东西：返回一句人话原因，能用就返回空串。 */
function badDirName(name: string): string {
  if (name === "." || name === "..") return "它表示当前目录或上一级目录";
  // 路径分隔符与 Windows 保留字符：拼进路径后会变成另一条路，或者写不出来。
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return "含有路径分隔符或文件名里不允许的字符";
  // Windows 会把结尾的点和空格吞掉，导致「以为写了 A、实际落在 A」。
  if (/[. ]$/.test(name)) return "末尾是点或空格（Windows 上会被吞掉）";
  return "";
}

/**
 * 把模型给的两个参数收成一份寻址范围：两个都填 → 拒绝；目录名不安全 → 拒绝；
 * 都没填 → 不限定（返回 ok，effortId 为空串）。选择困难时不猜，把话说明白让它重填。
 */
export function readMdScope(args: Record<string, unknown>): MdScope {
  const effort = typeof args.effort === "string" ? args.effort.trim() : "";
  const feature = typeof args.feature === "string" ? args.feature.trim() : "";
  if (effort && feature) {
    return {
      ok: false,
      message: "effort 与 feature 只能填一个：它们都指本地后端 `.scratch/` 下的同一个目录名，"
        + "只是原文两套技能叫法不同（探索地图叫 `<effort>`，规格体系叫 `<feature-slug>`）。这次在办哪套就留哪个，两个都填会让人猜你要听哪个。",
    };
  }
  const name = effort || feature;
  if (name) {
    const bad = badDirName(name);
    if (bad) {
      return {
        ok: false,
        message: "目录名不能用「" + name + "」：" + bad + "。这个值会直接拼成 `.scratch/<目录>/`，只接受单段普通目录名（例如 buy-coffee、买咖啡积分）。",
      };
    }
  }
  return { ok: true, effortId: name, scene: effort ? "effort" : feature ? "feature" : "" };
}
