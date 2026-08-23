import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertExists,
} from "@std/assert";

import { rankCandidates, specWeights } from "../src/core/rank.ts";
import { parseIntentRules, unsupportedReason } from "../src/core/intent.ts";
import type { Candidate } from "../src/core/types.ts";
import { loadRun } from "../src/core/replay.ts";
import {
  attachCheckout,
  buildCandidates,
  runPipeline,
} from "../src/core/pipeline.ts";

const FIXTURE = "tests/fixtures/run-phones-15000";

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

Deno.test("a ceiling query ranks quality first; a bargain query rewards cheapness", () => {
  // Synthetic stand-ins on purpose: this asserts a ranking property that
  // must hold for any product pair, not a verdict about real phones.
  let seq = 0;
  const synthetic = (
    price: number,
    antutu: number,
    overrides: Partial<Candidate> = {},
  ): Candidate => ({
    key: `test:${seq}`,
    modelName: `Test Device ${seq++}`,
    brand: null,
    category: "phone",
    specs: {
      ramGb: 8,
      storageGb: 128,
      batteryMah: null,
      chargingW: null,
      displayInches: null,
      refreshHz: null,
      panel: null,
      resolution: null,
      mainCameraMp: null,
      ultraWideMp: null,
      teleMp: null,
      aperture: null,
      ois: null,
      has5g: true,
      ipRating: null,
      nfc: null,
      socName: "Test Chip",
      antutu,
      perfTier: null,
      osUpgrades: null,
      releaseYear: null,
      colour: null,
    },
    specSources: { socName: "kb", antutu: "kb", ramGb: "title" },
    specCompleteness: 0.6,
    kbConfidence: "none",
    best: {
      platform: "flipkart",
      platformName: "Flipkart",
      price,
      mrp: null,
      discountPct: null,
      url: `https://www.flipkart.com/test-${price}/p/itm${seq}`,
      inStock: true,
      rating: null,
      ratingCount: null,
    },
    offers: [],
    siblingConfigs: [],
    rating: 4.3,
    ratingCount: 50000,
    imageUrl: null,
    listings: [],
    ...overrides,
  });
  // Same trust, same memory class; only chip tier and price differ.
  const affordable = synthetic(12999, 470_000);
  const premium = synthetic(45999, 1_800_000);

  // "best under X" asks for the best phone the budget allows.
  const ceiling = rankCandidates(
    [affordable, premium],
    parseIntentRules("best phones under 50000"),
  );
  assertEquals(ceiling.ranked[0].key, premium.key);
  assert(!ceiling.ranked[0].verdict.includes("Cheapest way"));

  // The same pair asked as a bargain hunt keeps rewarding cheapness.
  const bargain = rankCandidates(
    [structuredClone(affordable), structuredClone(premium)],
    parseIntentRules("budget phones under 50000"),
  );
  assertEquals(bargain.ranked[0].key, affordable.key);
});

Deno.test("camera priority can separate phones beyond the main sensor", () => {
  let seq = 0;
  const withCamera = (
    camera: Partial<Candidate["specs"]>,
  ): Candidate =>
    ({
      key: `test:${seq}`,
      modelName: `Test Device ${seq++}`,
      brand: null,
      category: "phone",
      specs: {
        ramGb: 8,
        storageGb: 128,
        batteryMah: null,
        chargingW: null,
        displayInches: null,
        refreshHz: null,
        panel: null,
        resolution: null,
        mainCameraMp: null,
        ultraWideMp: null,
        teleMp: null,
        aperture: null,
        ois: null,
        has5g: true,
        ipRating: null,
        nfc: null,
        socName: "Test Chip",
        antutu: 900_000,
        perfTier: null,
        osUpgrades: null,
        releaseYear: null,
        colour: null,
        ...camera,
      },
      specSources: { socName: "kb" },
      specCompleteness: 0.6,
      kbConfidence: "none",
      best: {
        platform: "flipkart",
        platformName: "Flipkart",
        price: 29_999,
        mrp: null,
        discountPct: null,
        url: `https://www.flipkart.com/t${seq}/p/itm`,
        inStock: true,
        rating: null,
        ratingCount: null,
      },
      offers: [],
      siblingConfigs: [],
      rating: 4.3,
      ratingCount: 50000,
      imageUrl: null,
      listings: [],
    }) as Candidate;

  // Same main sensor, same OIS - the old score called these identical.
  const bare = withCamera({ mainCameraMp: 50, ois: true });
  const full = withCamera({
    mainCameraMp: 50,
    ois: true,
    teleMp: 10,
    ultraWideMp: 50,
    aperture: 1.5,
  });

  const ceiling = rankCandidates(
    [bare, full],
    parseIntentRules("best camera phones under 50000"),
  );
  assert(ceiling.ranked[0].score.camera > ceiling.ranked[1].score.camera);
  assertEquals(ceiling.ranked[0].key, full.key);
});

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

Deno.test("model hints parse for alphanumeric part numbers", () => {
  assertEquals(parseIntentRules("sony wh-1000xm5").modelHint, "wh-1000xm5");
  assertEquals(parseIntentRules("best phones under 15000").modelHint, null);
  assertExists(parseIntentRules("redmi note 14 5g").modelHint);
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

Deno.test("a same-platform out-of-stock reading demotes; another platform's does not", () => {
  let seq = 0;
  const phone = (price: number): Candidate =>
    ({
      key: `test:${seq}`,
      modelName: `Test Device ${seq++}`,
      brand: null,
      category: "phone",
      specs: {
        ramGb: 8,
        storageGb: 128,
        batteryMah: null,
        chargingW: null,
        displayInches: null,
        refreshHz: null,
        panel: null,
        resolution: null,
        mainCameraMp: null,
        ultraWideMp: null,
        teleMp: null,
        aperture: null,
        ois: null,
        has5g: true,
        ipRating: null,
        nfc: null,
        socName: "Test Chip",
        antutu: 900_000,
        perfTier: null,
        osUpgrades: null,
        releaseYear: null,
        colour: null,
      },
      specSources: { socName: "kb" },
      specCompleteness: 0.6,
      kbConfidence: "none",
      best: {
        platform: "flipkart",
        platformName: "Flipkart",
        price,
        mrp: null,
        discountPct: null,
        url: `https://www.flipkart.com/p${price}/p/itm`,
        inStock: true,
        rating: null,
        ratingCount: null,
      },
      offers: [],
      siblingConfigs: [],
      rating: 4.3,
      ratingCount: 50000,
      imageUrl: null,
      listings: [
        {
          id: `f${price}`,
          platform: "flipkart",
          url: `https://www.flipkart.com/p${price}/p/itm`,
          title: `Test Device ${price}`,
          price,
          mrp: null,
          rating: null,
          ratingCount: null,
        } as never,
      ],
    }) as Candidate;

  const oos = phone(20_000);
  const buyable = phone(21_000);
  const dead = {
    pagePrice: null,
    pageMrp: null,
    seller: null,
    inStock: false as boolean | null,
    deliveryBy: null,
    buyAt: null,
    bankOffer: null,
    exchangeUpTo: null,
    noCostEmi: false,
    pincodeBlocked: false,
    sampledAt: "2026-08-22T10:00:00Z",
  };

  // Same platform reads its own page: the sold-out phone must sink.
  attachCheckout([oos, buyable], new Map([["f20000", dead]]));
  assertEquals(oos.best.inStock, false);
  assertEquals(buyable.best.inStock, true);
  const { ranked } = rankCandidates(
    [oos, buyable],
    parseIntentRules("best phones under 50000"),
  );
  assert(
    ranked.find((r) => r.key === oos.key)!.rank >
      ranked.find((r) => r.key === buyable.key)!.rank,
    "an out-of-stock phone must not lead a buyable one",
  );

  // A Flipkart reading says nothing about an Amazon offer.
  const amazon = phone(22_000);
  amazon.best = {
    ...amazon.best,
    platform: "amazon",
    platformName: "Amazon India",
  };
  attachCheckout([amazon], new Map([["f22000", dead]]));
  assertEquals(amazon.best.inStock, true);
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
