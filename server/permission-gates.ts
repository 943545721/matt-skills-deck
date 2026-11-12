/**
 * 权限闸的共用记账：先「替用户按住」这条请求，再异步判定，最后交还或拒绝。
 *
 * 两道闸（票闸的 shell 侧、角色窗口的执行门）都要处理同一组竞态：
 * 判定要读文件、起 git，这期间自动放行可能已经跑到了同一条请求上。
 * 所以标记必须在任何 await 之前同步打上，判定也要登记进 `gateInFlight`，
 * 让自动放行等这次判定落定，而不是靠注册顺序碰运气。
 *
 * 语义只有三条：
 *   1. 进闸先按住；
 *   2. `release()` 交还给自动放行（这道闸不管这条请求）；
 *   3. 没 release 就等判定结果——拒绝送达失败也保持按住，绝不让自动放行把它翻回来。
 */

export interface PermissionGateDeps {
  permissionKey: (agentId: string, requestId: string) => string;
  /** 闸「留给用户确认」的请求；自动放行看到标记就跳过。 */
  heldForUserConfirmation: Set<string>;
  /** 正在判定的请求；自动放行先等这次判定落定，不只靠注册顺序。 */
  gateInFlight: Map<string, Promise<void>>;
}

/**
 * 跑一次权限判定。
 *
 * `decide` 里要嘛调 `release()` 放手，要嘛直接拒绝；抛出的异常原样往外传，
 * 由调用方决定怎么记日志——但无论如何 `gateInFlight` 都会被清掉。
 */
export async function runPermissionGate(
  deps: PermissionGateDeps,
  agentId: string,
  requestId: string,
  decide: (release: () => void) => Promise<void>,
): Promise<void> {
  const key = deps.permissionKey(agentId, requestId);
  const release = () => {
    deps.heldForUserConfirmation.delete(key);
  };
  // 同步先打标记：宿主若并发分发，自动放行可能在任何 await 之前就看到这条请求。
  deps.heldForUserConfirmation.add(key);
  const run = decide(release);
  // 自动放行会 `await` 这张表里的 promise；判定抛错不该连带把它变成 unhandled rejection。
  // held 标记这时还留着，所以放行侧会停在「交给用户确认」，不会误放。
  deps.gateInFlight.set(key, run.catch(() => undefined));
  try {
    await run;
  } finally {
    deps.gateInFlight.delete(key);
  }
}
