import { assert, assertEquals } from "@std/assert";

import { buildPrompt, classifyFailure } from "../src/commands/heal.ts";

Deno.test("heal classifies the failure modes seen in real runs", () => {
  const base = {
    platform: "X",
    rawCards: 100,
    normalized: 100,
    titleRecovered: 0,
    priced: 90,
    categoryMatched: 90,
    inBudget: 50,
    survived: 50,
    fieldFill: 0.85,
    status: "ok" as const,
    rejectionReasons: {},
  };

  assertEquals(
    classifyFailure({
      ...base,
      status: "error",
      error: "Crawler error: waiting for selector failed",
      rawCards: 0,
    }),
    "crawler_error",
  );
  assertEquals(classifyFailure({ ...base, rawCards: 0, priced: 0 }), "empty");
  assertEquals(
    classifyFailure({ ...base, categoryMatched: 0 }),
    "wrong_products",
  );
  assertEquals(
    classifyFailure({ ...base, rawCards: 120, priced: 66, fieldFill: 0.5 }),
    "fields_missing",
  );
  assertEquals(classifyFailure(base), "healthy");
});

Deno.test("heal prompts name the specific fault, not a generic ask", () => {
  const base = {
    platform: "Tata CLiQ",
    rawCards: 0,
    normalized: 0,
    titleRecovered: 0,
    priced: 0,
    categoryMatched: 0,
    inBudget: 0,
    survived: 0,
    fieldFill: 0,
    status: "error" as const,
    error: "Crawler error: wait_element_timeout",
    rejectionReasons: {},
  };
  const prompt = buildPrompt(base, "crawler_error");
  assert(prompt.includes("wait_element_timeout"));
  assert(/product_name|selling_price/.test(prompt));

  const missing = buildPrompt(
    {
      ...base,
      status: "ok",
      error: undefined,
      rawCards: 120,
      priced: 66,
      fieldFill: 0.5,
    },
    "fields_missing",
  );
  assert(missing.includes("120"));
  assert(missing.includes("66"));
});
