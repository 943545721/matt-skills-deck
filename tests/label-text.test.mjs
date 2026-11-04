import assert from "node:assert/strict";
import { test } from "node:test";
import { labelDisplayName, labelMatches } from "../client/deck/labelText.ts";

test("中文界面翻译插件与技能约定的固定标签", () => {
  assert.equal(labelDisplayName("requirement", "zh"), "需求");
  assert.equal(labelDisplayName("bug", "zh-CN"), "缺陷");
  assert.equal(labelDisplayName("needs-triage", "zh"), "待分诊");
  assert.equal(labelDisplayName("ready-for-agent", "zh"), "可交给代理");
  assert.equal(labelDisplayName("wayfinder:map", "zh"), "地图");
  assert.equal(labelDisplayName("wayfinder:task", "zh"), "任务");
});

test("难度与客户端前缀只翻前缀，值原样保留", () => {
  assert.equal(labelDisplayName("difficulty:hard", "zh"), "难度：困难");
  assert.equal(labelDisplayName("difficulty:CRITICAL", "zh"), "难度：关键");
  assert.equal(labelDisplayName("client:claude", "zh"), "客户端：claude");
});

test("认不出的标签、缺值的标签原样返回", () => {
  assert.equal(labelDisplayName("priority:high", "zh"), "priority:high");
  assert.equal(labelDisplayName("requirement-backlog", "zh"), "requirement-backlog");
  assert.equal(labelDisplayName("difficulty:", "zh"), "difficulty:");
  assert.equal(labelDisplayName("paseo.parent-agent-id:abc123", "zh"), "paseo.parent-agent-id:abc123");
  assert.equal(labelDisplayName("", "zh"), "");
});

test("英文界面一律返回标签真名", () => {
  for (const name of ["requirement", "difficulty:hard", "client:claude", "wayfinder:map"]) {
    assert.equal(labelDisplayName(name, "en"), name);
  }
});

test("搜索同时匹配标签真名与中文显示名", () => {
  assert.equal(labelMatches("requirement", "requirement", "zh"), true);
  assert.equal(labelMatches("requirement", "需求", "zh"), true);
  assert.equal(labelMatches("requirement", "故事", "zh"), false);
  assert.equal(labelMatches("requirement", "需求", "en"), false);
  assert.equal(labelMatches("requirement", "  ", "zh"), false);
});
