import assert from "node:assert/strict";
import { test } from "node:test";
import { isProtectedEnvKey } from "../shared/provider-env.ts";

/** 地址/凭据键判定必须前后端共用：UI 决定要不要二次确认，服务端决定要不要拒绝。 */
test("地址/凭据键：大小写不敏感，只认后缀", () => {
  for (const key of [
    "OPENAI_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CUSTOM_TOKEN",
    "custom_token",
  ]) {
    assert.equal(isProtectedEnvKey(key), true, `${key} 应受保护`);
  }
  for (const key of ["ANTHROPIC_MODEL", "OPENAI_MODEL", "EXTRA_FLAG", "ANTHROPIC_BEDROCK_BASE_URL_2", ""]) {
    assert.equal(isProtectedEnvKey(key), false, `${key} 不该受保护`);
  }
});
