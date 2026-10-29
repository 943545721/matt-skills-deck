/**
 * GitHub 后端导出面。
 *
 * 分三层：
 * - `createGithubOperations()`：25+ 项操作的统一入口（面板 / MCP 共用）。
 * - 直接导出的函数：每个操作一个，签名是 `(client, repo, ...)`，便于测试与细粒度调用。
 * - 纯函数：归一化、锚点、颜色、HTTP 头解析、判档——全部可单独测。
 */
export * from "./client.ts";
export * from "./errors.ts";
export * from "./queries.ts";
export * from "./normalize.ts";
export * from "./reads.ts";
export * from "./fallback.ts";
export * from "./budget.ts";
export * from "./permissions.ts";
export * from "./preflight.ts";
export * from "./idempotency.ts";
export * from "./labels.ts";
export * from "./writes.ts";
export * from "./graph.ts";
export * from "./conditional.ts";
export * from "./init.ts";
export * from "./operations.ts";
