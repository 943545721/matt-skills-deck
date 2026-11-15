import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readProviderSource } from "../server/provider-source.ts";

/**
 * 注入源文件视图：卡片上的「N 个密钥」要能对上源文件里的键。
 *
 * 这里钉三件事：源文件路径、生效条目（Codex 派生条目）、以及「凭据只给掩码、
 * 地址与模型名原样」的口径。用临时 home 目录，不碰真实的 ~/.paseo。
 */

function homeWith(config) {
  const home = mkdtempSync(path.join(tmpdir(), "deck-source-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify(config), "utf8");
  return home;
}

const config = {
  agents: {
    providers: {
      codex: {
        enabled: true,
        models: ["gpt-5"],
        env: {
          OPENAI_BASE_URL: "http://192.168.1.2:3425/",
          OPENAI_API_KEY: "sk-live-1234566f2b",
          OPENAI_MODEL: "gpt-5",
        },
      },
      "deck-codex": {
        extends: "codex",
        enabled: true,
        models: ["gpt-5"],
        env: {
          // 排在真实主地址之前的备用键：旧实现会把它当主地址，明文返回带凭据的查询串。
          OPENAI_FIRST_BASE_URL: "https://first.example/v1?api_key=query-secret-77aa",
          OPENAI_BASE_URL: "http://10.0.0.2:8080",
          OPENAI_API_KEY: "sk-live-abcdef9a7c",
          OPENAI_MODEL: "gpt-5",
          MY_TOKEN: "custom-secret-9a7c",
          OPENAI_BACKUP_BASE_URL: "http://user:pass@backup:9000",
          OPENAI_ALT_BASE_URL: "http://backup:9100",
        },
      },
      claude: {
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-secret-1234",
          ANTHROPIC_MODEL: "claude-sonnet-4",
        },
      },
    },
  },
};

test("读源文件：路径、生效条目、env 键名与掩码", (t) => {
  const home = homeWith(config);
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = readProviderSource("codex", home);
  assert.equal(result.ok, true);
  assert.equal(result.path, path.join(home, "config.json"));

  const effective = result.entries.find((entry) => entry.effective);
  assert.equal(effective.id, "deck-codex", "派生条目有地址时应顶替内建 codex");
  assert.equal(effective.extends, "codex");
  assert.deepEqual(effective.models, ["gpt-5"]);
  assert.ok(effective.fields.includes("env"));
  assert.ok(effective.fields.includes("models"));

  const url = effective.env.find((row) => row.key === "OPENAI_BASE_URL");
  assert.equal(url.display, "http://10.0.0.2:8080");
  assert.equal(url.masked, false);

  const credential = effective.env.find((row) => row.key === "OPENAI_API_KEY");
  assert.equal(credential.display, "••••9a7c");
  assert.equal(credential.masked, true);

  // 已配置的模型名可以原样显示；伪装成模型名的自定义 token 仍然掩码。
  const model = effective.env.find((row) => row.key === "OPENAI_MODEL");
  assert.equal(model.display, "gpt-5");
  assert.equal(model.masked, false);
  const custom = effective.env.find((row) => row.key === "MY_TOKEN");
  assert.equal(custom.display, "••••9a7c");
  assert.equal(custom.masked, true);

  // 只有卡片认定的主地址原样；带用户名/密码的备用地址、以及普通备用地址都按凭据处理。
  const backup = effective.env.find((row) => row.key === "OPENAI_BACKUP_BASE_URL");
  assert.equal(backup.masked, true);
  assert.equal(backup.display, "••••9000");
  const alt = effective.env.find((row) => row.key === "OPENAI_ALT_BASE_URL");
  assert.equal(alt.masked, true);
  assert.equal(alt.display, "••••9100");
  // 插在主地址之前的备用键不能被当主地址：它带查询串凭据，必须掩码。
  const first = effective.env.find((row) => row.key === "OPENAI_FIRST_BASE_URL");
  assert.equal(first.masked, true);
  assert.equal(first.display, "••••77aa");

  assert.equal(result.entries.length, 2, "内建 codex 与派生条目都要列出来，便于对照");
  assert.equal(result.entries.find((entry) => entry.id === "codex").effective, false);

  // 原始密钥不能出现在结果里，哪怕只是一次只读查询。
  assert.doesNotMatch(JSON.stringify(result), /sk-live-abcdef9a7c/);
  assert.doesNotMatch(JSON.stringify(result), /custom-secret-9a7c/);
  assert.doesNotMatch(JSON.stringify(result), /query-secret-77aa/);
  assert.doesNotMatch(JSON.stringify(result), /user:pass@backup/);
});

test("主地址自身带查询串凭据也掩码，原始值不返回", (t) => {
  const home = homeWith({
    agents: {
      providers: {
        claude: {
          env: {
            ANTHROPIC_BASE_URL: "https://api.example.com/v1?access_token=primary-secret-4c21",
            ANTHROPIC_API_KEY: "sk-ant-1234",
          },
        },
      },
    },
  });
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = readProviderSource("claude", home);
  assert.equal(result.ok, true);
  const base = result.entries[0].env.find((row) => row.key === "ANTHROPIC_BASE_URL");
  assert.equal(base.masked, true, "主地址里的凭据查询参数不能被明文展示");
  assert.ok(!JSON.stringify(result).includes("primary-secret-4c21"));
});

test("非对象条目不能标成可清理的空条目", (t) => {
  const home = homeWith({ agents: { providers: { codex: null } } });
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = readProviderSource("codex", home);
  assert.equal(result.ok, true);
  assert.equal(result.entries[0].removable, false, "清理侧会报 not-found，界面不能提示这是空条目");
  assert.deepEqual(result.entries[0].fields, []);
});

test("模型名不是机密：ANTHROPIC_MODEL 原样显示", (t) => {
  const home = homeWith(config);
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = readProviderSource("claude", home);
  assert.equal(result.ok, true);
  const entry = result.entries[0];
  assert.equal(entry.effective, true);
  assert.equal(entry.env.find((row) => row.key === "ANTHROPIC_MODEL").display, "claude-sonnet-4");
  assert.equal(entry.env.find((row) => row.key === "ANTHROPIC_MODEL").masked, false);
});

test("源文件不存在 / 不是合法 JSON / 没有这个客户端", (t) => {
  const home = homeWith(config);
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const missing = readProviderSource("codex", path.join(home, "nope"));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "config-missing");

  const brokenHome = mkdtempSync(path.join(tmpdir(), "deck-source-broken-"));
  t.after(() => rmSync(brokenHome, { recursive: true, force: true }));
  writeFileSync(path.join(brokenHome, "config.json"), "{ nope", "utf8");
  const broken = readProviderSource("codex", brokenHome);
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, "config-invalid");

  const notFound = readProviderSource("nope", home);
  assert.equal(notFound.ok, false);
  assert.equal(notFound.reason, "not-found");
  assert.match(notFound.detail, /nope/);
});

test("坏 JSON 的解析错误不回显凭据原文", (t) => {
  const home = homeWith({});
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = "synthetic-source-credential-5de812";
  const configPath = path.join(home, "config.json");
  writeFileSync(configPath, `${secret} {`, "utf8");

  const result = readProviderSource("codex", home);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "config-invalid");
  assert.equal(result.detail, `${configPath} 不是合法 JSON，请修正文件格式后重试`);
  assert.ok(!JSON.stringify(result).includes(secret), "解析器错误可能带原文，不能返回给界面");
});

test("读取配置失败只返回操作、路径与安全错误码", (t) => {
  const home = homeWith({});
  const configPath = path.join(home, "config.json");
  const secret = "synthetic-read-credential-9f120c";
  const originalRead = fs.readFileSync;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(home, { recursive: true, force: true });
  });
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    if (path.resolve(String(target)) === configPath) {
      throw Object.assign(new Error(secret), { code: "EACCES" });
    }
    return originalRead(target, ...args);
  });
  syncBuiltinESMExports();

  const result = readProviderSource("codex", home);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "read-failed");
  assert.equal(result.detail, `读取 ${configPath} 失败（EACCES）`);
  assert.ok(!JSON.stringify(result).includes(secret));
});

for (const [description, code] of [
  ["未知系统错误码", "E_SYNTHETIC_SOURCE_ERRNO_SECRET_8D53B1"],
  ["已知错误码夹带换行与秘密", "EACCES\nsynthetic-source-errno-secret-8d53b1"],
  ["对象继承属性名", "toString"],
]) {
  test(`读取配置遇到${description}时只返回 UNKNOWN`, (t) => {
    const home = homeWith({});
    const configPath = path.join(home, "config.json");
    const secret = "synthetic-source-message-secret-83e9a";
    const originalRead = fs.readFileSync;
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(home, { recursive: true, force: true });
    });
    t.mock.method(fs, "readFileSync", (target, ...args) => {
      if (path.resolve(String(target)) === configPath) {
        throw Object.assign(new Error(secret), { code });
      }
      return originalRead(target, ...args);
    });
    syncBuiltinESMExports();

    const result = readProviderSource("codex", home);

    assert.deepEqual(result, {
      ok: false,
      reason: "read-failed",
      detail: `读取 ${configPath} 失败（UNKNOWN）`,
    });
    assert.ok(!JSON.stringify(result).includes(secret), "不能返回异常 message 中的秘密");
    assert.ok(!JSON.stringify(result).includes(code), "不能返回未被允许的 errno 原文");
  });
}
