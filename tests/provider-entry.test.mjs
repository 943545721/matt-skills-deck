import assert from "node:assert/strict";
import { test } from "node:test";
import { mirroredModelsOf, withMissingModels } from "../server/provider-entry.ts";

/**
 * 内建 `codex` 那一行的清单该写成什么。
 *
 * 背景：宿主的模型选择器按 provider 条目各显示一份，「Codex」那行读内建条目。插件面板读的
 * 是真正生效的派生条目，所以保存模型时要把同一份清单照写到内建那条上——但**不能**把
 * 用户自己在 Paseo 设置里加在内建那条上的模型删掉（面板上看不见它们，删掉就是替人做决定）。
 *
 * 三条边界：只补不删（读状态自愈）、删「插件照写过去的」（保存时取消勾选）、
 * 保留「内建独有的」（用户自己加的）。
 */

const id = (item) => item.id;

test("读状态自愈只补不删：内建那行原有的模型一个不动", () => {
  const existing = [{ id: "a", label: "A" }, { id: "user", label: "User" }];
  const wanted = [{ id: "a", label: "A" }, { id: "c", label: "C" }];

  assert.deepEqual(withMissingModels(existing, wanted).map(id), ["a", "user", "c"]);
});

test("保存模型：面板里取消的那个两行一起消失，内建独有的留着", () => {
  const existing = [{ id: "a" }, { id: "auto/b", label: "b" }, { id: "user", label: "User" }];
  const wanted = [{ id: "a", label: "A" }];
  const previous = [{ id: "a" }, { id: "auto/b", label: "b" }];

  // `auto/b` 在派生条目改之前就有、这次没勾 → 插件自己写的，两边一起删；
  // `user` 既不在这次清单、也不在派生条目上 → 用户自己加的，留着。
  assert.deepEqual(mirroredModelsOf(existing, wanted, previous).map(id), ["a", "user"]);
});

test("保存模型：内建那行原来什么都没有时，这份清单整个补上", () => {
  const wanted = [{ id: "a", label: "A" }, { id: "b", label: "B" }];

  assert.deepEqual(mirroredModelsOf(undefined, wanted, undefined).map(id), ["a", "b"]);
  assert.deepEqual(mirroredModelsOf([], wanted, []).map(id), ["a", "b"]);
});

test("手改过的配置里同一个模型写了两遍：收成一个", () => {
  const existing = [{ id: "a", label: "A" }, { id: "a", label: "A" }];

  assert.deepEqual(mirroredModelsOf(existing, [{ id: "a", label: "A" }], [{ id: "a" }]).map(id), ["a"]);
});

test("默认模型跟着内建那行自己的来：照搬派生条目的 isDefault 会造出两个默认", () => {
  const existing = [{ id: "a", label: "A", isDefault: true }];
  const wanted = [{ id: "a", label: "A", isDefault: true }, { id: "c", label: "C", isDefault: true }];

  const merged = mirroredModelsOf(existing, wanted, []);
  assert.deepEqual(merged.map(id), ["a", "c"]);
  assert.equal(merged[0].isDefault, true, "内建那行原来的默认不动");
  assert.equal(merged[1].isDefault, undefined, "补上的那条不能也标成默认");
});

test("内建那行本来没有默认：派生条目的默认跟着过来，只一个", () => {
  const wanted = [{ id: "a", label: "A", isDefault: true }, { id: "b", label: "B", isDefault: true }];

  const merged = mirroredModelsOf([], wanted, []);
  assert.equal(merged[0].isDefault, true);
  assert.equal(merged[1].isDefault, undefined);
});
