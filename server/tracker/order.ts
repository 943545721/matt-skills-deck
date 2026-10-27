/**
 * 列表排序的旧入口。
 *
 * 排序本体已合并到 `readiness.ts`：可接/阻塞的判定与排序必须看同一份 fields，
 * 分成两个文件迟早会出现「列表说它可接、地图说它阻塞」。这里只保留原函数名，
 * 免得 MCP 与既有测试跟着改一圈。
 */
export { sortBoard as sortIssues } from "./readiness.ts";
