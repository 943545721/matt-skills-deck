import { constants } from "node:os";

/** 配置可能包含凭据：只返回系统错误码，不转发异常 message 或解析器原文。 */
export function providerFileFailure(operation: string, target: string, error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const safeCode = typeof code === "string" && Object.hasOwn(constants.errno, code) ? code : "UNKNOWN";
  return `${operation} ${target} 失败（${safeCode}）`;
}

export function invalidProviderJson(target: string): string {
  return `${target} 不是合法 JSON，请修正文件格式后重试`;
}
