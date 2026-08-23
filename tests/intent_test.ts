import { assert, assertEquals, assertExists } from "@std/assert";

import { deriveModelKey } from "../src/core/extract.ts";
import { specWeights } from "../src/core/rank.ts";
import { parseIntentRules, unsupportedReason } from "../src/core/intent.ts";

Deno.test("deriveModelKey collapses colour and config variants", () => {
  const variants = [
    "POCO M7 5G (Ocean Blue, 128 GB) (8 GB RAM)",
    "POCO M7 5G (Mint Green, 128 GB) (6 GB RAM)",
    "POCO M7 5G Satin Black 128 GB",
  ];
  const keys = new Set(variants.map(deriveModelKey));
  assertEquals(keys.size, 1, [...keys].join(" | "));
  assertEquals([...keys][0], "poco m7 5g");
});

Deno.test("intent parsing extracts category, budget and priorities", () => {
  const i = parseIntentRules("best gaming phones under 15000");
  assertEquals(i.category, "phone");
  assertEquals(i.budgetMax, 15000);
  assertEquals(i.budgetOperator, "under");
  assert(i.priorities.includes("performance"));
});

Deno.test("camera queries boost camera, OIS phrasing becomes a must-have", () => {
  const cam = parseIntentRules("best phones under 50000 with good camera");
  assert(cam.priorities.includes("camera"));

  const plain = parseIntentRules("best phones under 50000");
  const weighted = specWeights({ ...cam, mustHave: [] });
  const unweighted = specWeights(plain);
  assert(weighted.camera > unweighted.camera);

  const ois = parseIntentRules("camera phones under 50000 with OIS");
  assert(ois.mustHave.includes("ois"));

  const stab = parseIntentRules(
    "phones under 30000 with stabilized video",
  );
  assert(stab.mustHave.includes("ois"));
});

Deno.test("intent parsing understands k-suffixes, ranges and around", () => {
  assertEquals(parseIntentRules("phones under 20k").budgetMax, 20000);
  const between = parseIntentRules("laptops between 40000 and 60000");
  assertEquals(between.budgetMin, 40000);
  assertEquals(between.budgetMax, 60000);
  const around = parseIntentRules("earbuds around 3000");
  assertEquals(around.budgetOperator, "around");
  assert(around.budgetMax! > 3000 && around.budgetMin! < 3000);
});

Deno.test("intent parsing picks up brands and 5G requirements", () => {
  const i = parseIntentRules("samsung 5g phone under 15000");
  assertEquals(i.brands, ["Samsung"]);
  assert(i.mustHave.includes("5g"));
});

Deno.test("model hints parse for alphanumeric part numbers", () => {
  assertEquals(parseIntentRules("sony wh-1000xm5").modelHint, "wh-1000xm5");
  assertEquals(parseIntentRules("best phones under 15000").modelHint, null);
  assertExists(parseIntentRules("redmi note 14 5g").modelHint);
});

Deno.test("non-phone queries are declined, not badly ranked", () => {
  for (
    const q of [
      "best earbuds under 2000",
      "sony wh-1000xm5 headphones",
      "best gaming laptop under 80000",
      "55 inch smart tv under 40000",
      "smartwatch under 5000",
    ]
  ) {
    const reason = unsupportedReason(parseIntentRules(q));
    assertExists(reason, `expected "${q}" to be declined`);
    assert(/ranks phones/.test(reason!));
  }
});

Deno.test("phone queries are accepted", () => {
  for (
    const q of [
      "best phones under 15000",
      "samsung 5g phone under 20000",
      "poco m7 pro 5g",
      "phones under 10k",
    ]
  ) {
    assertEquals(unsupportedReason(parseIntentRules(q)), null, q);
  }
});

Deno.test("a bare model query is not mistaken for another category", () => {
  assertEquals(unsupportedReason(parseIntentRules("iqoo z10 lite 5g")), null);
});

Deno.test("model hints resolve to the model code, not marketing suffixes", () => {
  assertEquals(parseIntentRules("poco m7 pro 5g").modelHint, "m7");
  assertEquals(parseIntentRules("iqoo z10 lite 5g").modelHint, "z10");
  assertEquals(parseIntentRules("sony wh-1000xm5").modelHint, "wh-1000xm5");
  assertEquals(parseIntentRules("redmi note 14 5g").modelHint, "note 14");
  assertEquals(parseIntentRules("best phones under 15000").modelHint, null);
});

Deno.test("enrichment targets the least-known products, not the top of the table", () => {
  const mk = (
    key: string,
    confidence: number,
    completeness: number,
    kb: string,
  ) =>
    ({
      key,
      modelName: key,
      specCompleteness: completeness,
      kbConfidence: kb,
      score: { confidence },
      listings: [{
        id: key,
        url: `https://www.flipkart.com/${key}/p/itm${key}`,
      }],
      best: { url: `https://www.flipkart.com/${key}/p/itm${key}` },
      // deno-lint-ignore no-explicit-any
    }) as any;

  const ranked = [
    mk("well-known-1", 1.0, 0.95, "high"),
    mk("well-known-2", 1.0, 0.9, "high"),
    mk("mystery-phone", 0.2, 0.3, "none"),
    mk("half-known", 0.6, 0.6, "medium"),
  ];

  const eligible = ranked.filter((r) =>
    !(r.specCompleteness >= 0.85 && r.kbConfidence === "high")
  );
  const ordered = [...eligible].sort((a, b) =>
    a.score.confidence - b.score.confidence
  );

  assertEquals(eligible.length, 2);
  assertEquals(ordered[0].key, "mystery-phone");
});
