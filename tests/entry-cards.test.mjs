import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENTRY_CARD_H,
  ENTRY_CARD_W,
  entryCardDataUri,
  entryCardSvg,
} from "../client/deck/entry/entryCardSvg.ts";
import { entryCopy } from "../client/deck/entry/entryCopy.ts";

/**
 * 入口卡的编码与结构契约。
 *
 * 卡是 SVG 原文（DSH entry-card 的移植），在宿主里经 data URI 交给 Image。
 * 编码器是为修掉 btoa / Buffer 依赖而重写的纯 JS 实现，所以必须拿 Node Buffer
 * 做逐字节对照，覆盖余数 0/1/2 与多字节字符，防止日后回归成「只在某宿主能显示」。
 */
const b64 = (svg) => Buffer.from(svg, "utf8").toString("base64");

test("entryCardDataUri 与 Node Buffer 的 Base64 逐字节一致（四张真实卡）", () => {
  for (const lang of ["zh", "en"]) {
    const copy = entryCopy(lang);
    for (const mode of ["explore", "implement"]) {
      const cardCopy = mode === "explore" ? copy.explore : copy.impl;
      const svg = entryCardSvg(mode, cardCopy, lang);
      assert.equal(entryCardDataUri(svg), `data:image/svg+xml;base64,${b64(svg)}`);
    }
  }
});

test("entryCardDataUri 覆盖空串与余数 0/1/2（含多字节）", () => {
  for (const sample of ["", "a", "ab", "abc", "中", "中文", "中文a", "😀", "😀a"]) {
    assert.equal(entryCardDataUri(sample), `data:image/svg+xml;base64,${b64(sample)}`);
  }
});

test("卡片 SVG 保持自包含与定稿几何", () => {
  for (const lang of ["zh", "en"]) {
    const copy = entryCopy(lang);
    for (const mode of ["explore", "implement"]) {
      const cardCopy = mode === "explore" ? copy.explore : copy.impl;
      const svg = entryCardSvg(mode, cardCopy, lang);
      assert.ok(svg.startsWith("<svg "), "应以下 `<svg ` 开头");
      assert.ok(svg.endsWith("</svg>"), "应以 `</svg>` 结尾");
      assert.ok(svg.includes(`width="${ENTRY_CARD_W}"`), "宽度应固定 368");
      assert.ok(svg.includes(`height="${ENTRY_CARD_H}"`), "高度应固定 232");
      assert.ok(svg.includes(cardCopy.brow), "卡面应含 brow 文案");
    }
  }
});
