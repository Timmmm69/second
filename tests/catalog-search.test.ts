import { test } from "node:test";
import assert from "node:assert/strict";
import { SEARCH_DEBOUNCE_MS, normalizeCatalogSearch, shouldApplyCatalogSearch } from "../client/catalog-search.js";

test("catalog search waits 700 ms after typing pauses", () => {
  assert.equal(SEARCH_DEBOUNCE_MS, 700);
});

test("repeating the applied search does not require another catalog request", () => {
  for (const [applied, typed] of [
    ["Джинсы", "Джинсы"],
    ["  Джинсы ", "джинсы"],
    ["красное  платье", "КРАСНОЕ платье  "],
    [undefined, ""],
    ["", "  "],
  ] as const) {
    assert.equal(shouldApplyCatalogSearch(applied, typed), false);
  }
  assert.equal(normalizeCatalogSearch("  ЛЁН  XL "), "лён xl");
});

test("a new or cleared search applies exactly when the query changes", () => {
  assert.equal(shouldApplyCatalogSearch("джинсы", "куртка"), true);
  assert.equal(shouldApplyCatalogSearch("джинсы", ""), true);
  assert.equal(shouldApplyCatalogSearch(undefined, "пальто"), true);
  assert.equal(shouldApplyCatalogSearch("куртка", "куртка зимняя"), true);
});
