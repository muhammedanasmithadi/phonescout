import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertExists,
} from "@std/assert";

import { normalizeBatch } from "../src/core/normalize.ts";
import { parseIntentRules } from "../src/core/intent.ts";
import { capturedAtFor, loadRun } from "../src/core/replay.ts";
import { renderFull } from "../src/ui/render.ts";
import type { PriceStats } from "../src/core/price-history.ts";
import { buildCandidates, runPipeline } from "../src/core/pipeline.ts";
import { parseCheckout } from "../src/core/checkout.ts";

const FIXTURE = "tests/fixtures/run-phones-15000";

Deno.test("REGRESSION: a phone query never returns earphones", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const result = runPipeline("best phones under 15000", intent, batches);

  assert(result.ranked.length > 10, `only ${result.ranked.length} ranked`);
  for (const r of result.ranked) {
    assertEquals(
      r.category,
      "phone",
      `${r.modelName} classified ${r.category}`,
    );
    assert(
      !/earphone|earbud|headphone|bullets/i.test(r.modelName),
      `audio product in phone results: ${r.modelName}`,
    );
    assert(
      r.best.price <= 15000,
      `${r.modelName} at ₹${r.best.price} exceeds budget`,
    );
  }
});

Deno.test("REGRESSION: the same phone does not occupy several top slots", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const { ranked } = runPipeline("best phones under 15000", intent, batches);

  const top10 = ranked.slice(0, 10);
  const models = top10.map((r) => r.key.split("|")[0]);
  const unique = new Set(models);
  for (const m of unique) {
    const n = models.filter((x) => x === m).length;
    assert(n <= 2, `${m} occupies ${n} of the top 10`);
  }
});

Deno.test("REGRESSION: the winner is spec-justified, not just cheap", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const { ranked } = runPipeline("best phones under 15000", intent, batches);

  const winner = ranked[0];
  const cheapest = [...ranked].sort((a, b) => a.best.price - b.best.price)[0];
  assert(
    winner.score.confidence >= 0.8,
    `winner confidence ${winner.score.confidence}`,
  );
  assertExists(winner.specs.socName);
  assert(
    winner.best.price >= cheapest.best.price,
    "winner should not simply be the cheapest item",
  );
  assert(
    winner.score.specScore > 40,
    `winner specScore ${winner.score.specScore}`,
  );
});

Deno.test("scores stay inside 0..100 and rank order is monotonic", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const { ranked } = runPipeline("best phones under 15000", intent, batches);

  for (const r of ranked) {
    for (const [k, v] of Object.entries(r.score)) {
      if (k === "confidence") {
        assert(v >= 0 && v <= 1, `${k}=${v}`);
      } else {
        assert(v >= 0 && v <= 100, `${k}=${v}`);
      }
    }
  }
  for (let i = 1; i < ranked.length; i++) {
    assert(
      ranked[i - 1].score.total >= ranked[i].score.total,
      "not sorted by score",
    );
    assertEquals(ranked[i].rank, i + 1);
  }
});

Deno.test("diagnostics account for every scraped card", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const { diagnostics, stats } = runPipeline(
    "best phones under 15000",
    intent,
    batches,
  );

  const totalRaw = diagnostics.reduce((s, d) => s + d.rawCards, 0);
  assertEquals(totalRaw, stats.rawCards);

  const flipkart = diagnostics.find((d) => d.platform === "Flipkart")!;
  assertEquals(flipkart.rawCards, 120);
  assertEquals(flipkart.normalized, 120);
  assert(flipkart.titleRecovered >= 50);

  const reliance = diagnostics.find((d) => d.platform === "Reliance Digital")!;
  assertEquals(reliance.categoryMatched, 0);
  assertAlmostEquals(reliance.fieldFill, 0.6, 0.15);
});

Deno.test("recorded history sharpens the deal score", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const base = runPipeline("q", intent, batches);
  const top = base.ranked[0];

  const history = new Map([[top.key, {
    min: top.best.price,
    max: Math.round(top.best.price * 1.18),
    position: 0,
    trend: "stable" as const,
    observations: 3,
    runs: 3,
    daysTracked: 30,
  }]]);

  const withHistory = runPipeline("q", intent, batches, {
    priceHistory: history,
  });
  const same = withHistory.ranked.find((r) => r.key === top.key)!;

  assert(
    same.score.dealScore > top.score.dealScore,
    `deal ${same.score.dealScore} should beat ${top.score.dealScore}`,
  );
  assert(same.badges.includes("LOWEST YET"));
  assert(
    same.pros.some((p) => /lowest price in 30 day/.test(p)),
    same.pros.join(" | "),
  );
});

Deno.test("a price sitting at its recorded high is penalised and flagged", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const base = runPipeline("q", intent, batches);
  const top = base.ranked[0];

  const history = new Map([[top.key, {
    min: Math.round(top.best.price * 0.8),
    max: top.best.price,
    position: 1,
    trend: "rising" as const,
    observations: 5,
    runs: 5,
    daysTracked: 20,
  }]]);

  const withHistory = runPipeline("q", intent, batches, {
    priceHistory: history,
  });
  const same = withHistory.ranked.find((r) => r.key === top.key)!;
  assert(same.cons.some((c) => /recorded high/.test(c)), same.cons.join(" | "));
  assert(!same.badges.includes("LOWEST YET"));
});

Deno.test("a single observation is not treated as history", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const base = runPipeline("q", intent, batches);
  const top = base.ranked[0];

  const history = new Map([[top.key, {
    min: top.best.price,
    max: top.best.price,
    position: 0,
    trend: "stable" as const,
    observations: 1,
    runs: 1,
    daysTracked: 0,
  }]]);

  const withHistory = runPipeline("q", intent, batches, {
    priceHistory: history,
  });
  const same = withHistory.ranked.find((r) => r.key === top.key)!;
  assertEquals(same.score.dealScore, top.score.dealScore);
  assert(!same.badges.includes("LOWEST YET"));
});

Deno.test("one run's breadth is not price history", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const base = runPipeline("q", intent, batches);
  const top = base.ranked[0];

  const sameRunBreadth = new Map([[top.key, {
    min: top.best.price,
    max: Math.round(top.best.price * 1.2),
    position: 0,
    trend: "stable" as const,
    observations: 3,
    runs: 1,
    daysTracked: 0,
  }]]);

  const withBreadth = runPipeline("q", intent, batches, {
    priceHistory: sameRunBreadth,
  });
  const same = withBreadth.ranked.find((r) => r.key === top.key)!;
  assertEquals(same.score.dealScore, top.score.dealScore);
  assert(!same.badges.includes("LOWEST YET"));
});

Deno.test("superlative badges require a clear win, not a tie", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const result = runPipeline("q", intent, batches);

  for (
    const [badge, of] of [
      ["FASTEST", (r: typeof result.ranked[number]) => r.score.performance],
      ["BATTERY KING", (r: typeof result.ranked[number]) => r.score.battery],
    ] as const
  ) {
    const holder = result.ranked.find((r) => r.badges.includes(badge));
    if (!holder) continue;
    const runnerUp = Math.max(
      ...result.ranked.filter((r) => r !== holder).map(of),
    );
    assert(
      of(holder) > runnerUp,
      `${badge} went to a tie: ${of(holder)} vs runner-up ${runnerUp}`,
    );
  }
});

Deno.test("the set's fastest phone is never told it compromises on speed", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const result = runPipeline("q", intent, batches);

  const best = result.ranked
    .filter((r) => (r.specs.antutu ?? 0) > 0)
    .reduce<typeof result.ranked[number] | null>(
      (
        a,
        b,
      ) => (a === null || b.score.performance > a.score.performance ? b : a),
      null,
    );
  if (best) {
    assert(
      !best.verdict.includes("compromises on raw speed"),
      `fastest phone's verdict contradicts itself: ${best.verdict}`,
    );
  }
});

Deno.test("a phone you cannot buy never leads the ranking", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const result = runPipeline("q", intent, batches);
  const first = result.ranked[0];
  assert(
    first.best.inStock !== false,
    `#1 is out of stock: ${first.modelName}`,
  );
  let seenUnbuyable = false;
  for (const r of result.ranked) {
    if (r.best.inStock === false) seenUnbuyable = true;
    else if (seenUnbuyable) {
      throw new Error(
        `${r.modelName} is buyable but ranked below one that is not`,
      );
    }
  }
});

Deno.test("naming a phone model floats it above better-value alternatives", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("poco m7 pro");
  const { ranked } = runPipeline("poco m7 pro", intent, batches);

  assert(ranked.length > 1);
  assertEquals(ranked[0].matchesRequestedModel, true);
  assert(/m7 pro/i.test(ranked[0].modelName), ranked[0].modelName);
  assert(ranked.slice(1).some((r) => r.badges.includes("ALTERNATIVE")));
});

Deno.test("REGRESSION: audio payloads yield nothing for a phone query", async () => {
  const batches = await loadRun(["tests/fixtures/run-sony-wh1000xm5"]);
  const result = runPipeline(
    "best phones under 15000",
    parseIntentRules("best phones under 15000"),
    batches,
  );
  assertEquals(result.ranked.length, 0);
  const reasons = Object.keys(
    result.diagnostics.reduce<Record<string, number>>(
      (acc, d) => ({ ...acc, ...d.rejectionReasons }),
      {},
    ),
  );
  assert(
    reasons.some((r) => /headphone|earbuds|accessory|unknown/.test(r)),
    reasons.join(", "),
  );
});

Deno.test("BEST VALUE requires evidence, not just a good ratio", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const { ranked } = runPipeline("q", intent, batches);

  for (const r of ranked) {
    if (!r.badges.includes("BEST VALUE") && !r.badges.includes("FASTEST")) {
      continue;
    }
    assertExists(
      r.specs.socName,
      `${r.modelName} badged without a known chipset`,
    );
    assert(
      (r.ratingCount ?? 0) >= 100,
      `${r.modelName} badged on ${r.ratingCount ?? 0} reviews`,
    );
    assert(
      r.score.confidence >= 0.6,
      `${r.modelName} badged at ${r.score.confidence} confidence`,
    );
  }
});

Deno.test("CHEAPEST is still allowed on an unverified product", async () => {
  const batches = await loadRun([FIXTURE]);
  const { ranked } = runPipeline(
    "q",
    parseIntentRules("best phones under 15000"),
    batches,
  );
  const cheapest = [...ranked].sort((a, b) => a.best.price - b.best.price)[0];
  assert(cheapest.badges.includes("CHEAPEST"), cheapest.badges.join(","));
});

Deno.test("the flat card discount does not reorder results", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const plain = runPipeline("q", intent, batches);

  const checkout = new Map(
    plain.ranked.flatMap((r) =>
      r.listings.map((l) =>
        [l.id, {
          pagePrice: null,
          pageMrp: null,
          seller: null,
          inStock: null,
          deliveryBy: null,
          buyAt: Math.round(r.best.price * 0.95),
          bankOffer: Math.round(r.best.price * 0.05),
          exchangeUpTo: null,
          noCostEmi: true,
          pincodeBlocked: false,
        }] as const
      )
    ),
  );

  const withOffers = runPipeline("q", intent, batches, {
    checkoutInfo: checkout,
  });
  assertEquals(
    withOffers.ranked.map((r) => r.key),
    plain.ranked.map((r) => r.key),
  );
  assertExists(withOffers.ranked[0].checkout);
});

Deno.test("buildCandidates groups without ranking, so specs can resolve first", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const { candidates, intent: resolved } = buildCandidates(intent, batches);
  assert(candidates.length > 40, `only ${candidates.length} candidates`);
  assertEquals(resolved.category, "phone");
  assert(!("score" in candidates[0]));
});

Deno.test("a card price contradicted by the page is replaced, not averaged", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const base = runPipeline("q", intent, batches);
  const top = base.ranked[0];
  const cardPrice = top.best.price;

  const checkout = new Map(
    top.listings.map((l) =>
      [
        l.id,
        parseCheckout(`8% 15,999 ₹14,499 +₹109 Protect Promise Fee`),
      ] as const
    ),
  );
  const out = runPipeline("q", intent, batches, { checkoutInfo: checkout });
  const same = out.ranked.find((r) => r.key === top.key)!;
  assert(
    same.offers.some((o) => o.price === 14499),
    `page price not applied: ${same.offers.map((o) => o.price).join(", ")}`,
  );
  assert(cardPrice !== 14499);
});

Deno.test("one platform's page price never becomes another platform's", () => {
  const flipkart = normalizeBatch([
    {
      product_name: "realme Narzo 90x 5G (Flash Blue, 128 GB) (8 GB RAM)",
      selling_price: 14134,
      original_price: 17999,
      product_url: "https://www.flipkart.com/realme-narzo-90x-5g/p/itm1?pid=A",
    },
  ], "flipkart");
  const amazon = normalizeBatch([
    {
      title: "realme Narzo 90x 5G (8GB/128GB)",
      final_price: 21499,
      url: "https://www.amazon.in/dp/B0TEST123",
    },
  ], "amazon");

  const page = parseCheckout("21% 17,999 ₹14,134 +₹109 Protect Promise Fee");
  const checkout = new Map([[flipkart.listings[0].id, page]]);

  const out = runPipeline(
    "phones under 25000",
    parseIntentRules("phones under 25000"),
    [
      {
        platform: "flipkart",
        platformName: "Flipkart",
        items: [],
        status: "ok",
      },
    ],
    { checkoutInfo: checkout },
  );
  assertEquals(out.ranked.length, 0);
  assert(!checkout.has(amazon.listings[0]?.id ?? "none"));
});

Deno.test("the table shows one row per phone, not one per storage config", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const { ranked } = runPipeline("q", intent, batches);

  const table = ranked.filter((r) => !r.variantOf);
  const models = table.map((r) => r.key.split("|")[0]);
  assertEquals(
    models.length,
    new Set(models).size,
    `a phone appears twice in the table: ${models.join(", ")}`,
  );
  // The collapsed ones are still ranked, just folded into their sibling.
  const folded = ranked.filter((r) => r.variantOf);
  for (const f of folded) {
    assert(f.variantOf!.length > 0);
  }
});

Deno.test("a listing with nothing to verify is scored down, not hidden", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const { ranked } = runPipeline("q", intent, batches);
  const junk = ranked.filter((r) => r.unvouchable);
  for (const r of junk) {
    assertEquals(r.specs.socName, null);
    assert((r.ratingCount ?? 0) < 20);
    assert(
      r.cons.some((c) => c.includes("nothing to verify")),
      `${r.modelName} was penalised without saying why`,
    );
  }
  // Still ordered by the number the table prints.
  for (let i = 1; i < ranked.length; i++) {
    if (ranked[i - 1].best.inStock === false) break;
    assert(ranked[i - 1].score.total >= ranked[i].score.total);
  }
});

Deno.test("a replayed run says when its prices were captured", async () => {
  const ts = await capturedAtFor([FIXTURE]);
  assertEquals(ts, "2026-08-21T04:36:37Z");
});

Deno.test("capturedAt falls back to mtime when a run has no manifest", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/amazon.json`, "[]");
    const stat = await Deno.stat(dir);
    const ts = await capturedAtFor([dir]);
    assertExists(ts);
    assertExists(stat.mtime);
    assert(
      Math.abs(Date.parse(ts) - stat.mtime.getTime()) < 60_000,
      `mtime fallback too far off: ${ts}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the report warns when replayed prices are old", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const result = runPipeline("best phones under 15000", intent, batches);
  const fresh = renderFull(result, {
    limit: 5,
    details: 0,
    compare: false,
    diagnostics: false,
    capturedAt: new Date().toISOString(),
  });
  assert(fresh.includes("prices captured"));
  assert(!fresh.includes("may have moved"));

  const stale = renderFull(result, {
    limit: 5,
    details: 0,
    compare: false,
    diagnostics: false,
    capturedAt: "2026-08-20T01:00:00Z",
  });
  assert(stale.includes("prices captured"));
  assert(stale.includes("may have moved"));
  assert(stale.includes("--refresh-prices"));

  const live = renderFull(result, {
    limit: 5,
    details: 0,
    compare: false,
    diagnostics: false,
  });
  assert(!live.includes("prices captured"));
});

Deno.test("a measured page price outranks the card quotes around it", () => {
  const raws = [
    {
      product_name:
        "Samsung Galaxy M17 5G (Moonlight Silver, 128 GB) (6 GB RAM)",
      selling_price: 12951,
      product_url:
        "https://www.flipkart.com/samsung-galaxy-m17-5g-a/p/itmA?pid=MOBHA",
    },
    {
      product_name:
        "Samsung Galaxy M17 5G (Moonlight Silver, 128 GB) (6 GB RAM)",
      selling_price: 13499,
      product_url:
        "https://www.flipkart.com/samsung-galaxy-m17-5g-b/p/itmB?pid=MOBHB",
    },
  ];
  const { listings } = normalizeBatch(raws, "flipkart");
  const { candidates } = buildCandidates(
    {
      raw: "test",
      category: "phone",
      brands: [],
      excludeBrands: [],
      budgetMax: 15000,
      budgetMin: null,
      budgetOperator: "under",
      priorities: [],
      mustHave: [],
      modelHint: null,
    },
    [{
      platform: "flipkart",
      platformName: "Flipkart",
      items: raws,
      status: "ok",
    }],
    {
      checkoutInfo: new Map([[
        listings[0].id,
        {
          pagePrice: 19474,
          pageMrp: null,
          seller: "SmartTechMart",
          inStock: true,
          deliveryBy: null,
          buyAt: null,
          bankOffer: null,
          exchangeUpTo: null,
          noCostEmi: false,
          pincodeBlocked: false,
        },
      ]]),
    },
  );
  const [c] = candidates;
  assertEquals(c.best.price, 19474); // measured, not the cheapest card
  assertEquals(c.offers[0].url, listings[0].url);
  assertEquals(c.offers.some((o) => o.price === 13499), true); // kept below
});

Deno.test("a tracked price shows its history and where it sits", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const result = runPipeline("q", intent, batches);
  const top = result.ranked[0];
  const stats: PriceStats = {
    key: top.key,
    name: top.modelName,
    current: top.best.price,
    min: Math.round(top.best.price * 0.8),
    max: Math.round(top.best.price * 1.2),
    avg: top.best.price,
    observations: 12,
    runs: 4,
    firstSeen: "2026-08-01T00:00:00Z",
    lastSeen: new Date().toISOString(),
    daysTracked: 21,
    position: 0.5,
    trend: "stable",
  };
  const out = renderFull(result, {
    limit: 3,
    details: 1,
    compare: false,
    diagnostics: false,
    priceHistory: {
      stats: new Map([[top.key, stats]]),
      series: new Map([[
        top.key,
        [
          { t: "2026-08-19T00:00:00Z", p: stats.max },
          { t: "2026-08-20T00:00:00Z", p: stats.min },
          { t: "2026-08-21T00:00:00Z", p: top.best.price },
        ],
      ]]),
    },
  });
  assert(out.includes("trend"), "history line missing");
  assert(out.includes("checks"), "observation count missing");
  assert(out.includes("█") && out.includes("▁"), "sparkline missing");
});
