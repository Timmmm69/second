import { test } from "node:test";
import assert from "node:assert/strict";
import { clothingBrands, clothingColors, russianCountries, canonicalChoice } from "../client/clothing-options.js";

test("Russian countries are alphabetized by localized label, searchable and unique", () => {
  const countries = russianCountries();
  assert.ok(countries.length >= 190, "ISO country coverage");
  assert.ok(countries.includes("Беларусь"));
  assert.ok(countries.includes("Аргентина"));
  assert.ok(countries.includes("Франция"));
  assert.deepEqual(countries, [...countries].sort((a, b) => a.localeCompare(b, "ru", { sensitivity: "base" })));
  assert.equal(new Set(countries).size, countries.length);
});

test("free-form tag values remain valid while known choices are canonicalized", () => {
  assert.ok(clothingColors.includes("Хаки"));
  assert.ok(clothingBrands.includes("Nike"));
  assert.equal(canonicalChoice("  чёрный ", clothingColors), "Чёрный");
  assert.equal(canonicalChoice("NIKE", clothingBrands), "Nike");
  assert.equal(canonicalChoice("необычный авторский оттенок", clothingColors), "необычный авторский оттенок");
  assert.equal(canonicalChoice(" ", clothingBrands), "");
});
