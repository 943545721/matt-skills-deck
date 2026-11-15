/**
 * 进程内的 provider 配置写锁。
 *
 * `paseo.config.patch` 对 provider 是「读整条 → 改 → 写回」：清理、卡片保存、站点启用
 * 如果并发，后写者会用旧快照盖掉先写者。这个锁只覆盖本插件的写入口，让它们排队；
 * 外部直接改 `config.json` 仍要靠 patch 前重读快照来发现（`provider-cleanup` 已这么做）。
 *
 * 链式 Promise 而不是布尔锁：失败的上一项不能让后面永久卡住，`catch` 后继续排队。
 */
let tail: Promise<unknown> = Promise.resolve();

export function withProviderConfigWriteLock<T>(run: () => Promise<T>): Promise<T> {
  const next = tail.then(run, run);
  tail = next.catch(() => undefined);
  return next;
}
