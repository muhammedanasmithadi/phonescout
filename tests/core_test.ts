import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertExists,
  assertRejects,
} from "@std/assert";
import {
  normalizeBatch,
  parseMoney,
  titleFromUrl,
} from "../src/core/normalize.ts";
import { categoryMatches, classify } from "../src/core/classify.ts";
import {
  analyze,
  deriveModelKey,
  detectQualifiers,
  specsFromText,
} from "../src/core/extract.ts";
import { groupListings } from "../src/core/group.ts";
import { rankCandidates, specWeights } from "../src/core/rank.ts";
import { parseIntentRules, unsupportedReason } from "../src/core/intent.ts";
import { ALL_ENABLED, PLATFORMS } from "../src/config.ts";
import {
  beebomSlugs,
  nameMatches,
  parseBeebomPage,
} from "../src/knowledge/beebom.ts";
import { toSpecs } from "../src/core/resolve.ts";
import {
  refreshPrices,
  reportRefresh,
  reportRefreshDetail,
} from "../src/core/resolve.ts";
import type { Candidate } from "../src/core/types.ts";
import { ageLabel, SpecStore } from "../src/core/spec-cache.ts";
import { capturedAtFor, loadRun } from "../src/core/replay.ts";
import { renderFull, sparkline } from "../src/ui/render.ts";
import type { PriceStats } from "../src/core/price-history.ts";
import {
  attachCheckout,
  buildCandidates,
  runPipeline,
} from "../src/core/pipeline.ts";
import {
  matchSoc,
  matchSocDetailed,
  matchSocExact,
  SOCS,
} from "../src/knowledge/soc.ts";
import { lookupModel, PHONE_MODELS } from "../src/knowledge/models.ts";
import { hasCheckoutInfo, parseCheckout } from "../src/core/checkout.ts";
import { extractSpecSection, specRichness } from "../src/core/resolve.ts";
import { reviewsUrlFor, summariseReviews } from "../src/core/reviews.ts";
import { buildUrls, searchTerm } from "../src/core/collect.ts";
import { canonicalUrl } from "../src/core/normalize.ts";
import {
  htmlToText,
  jsonStateText,
  pageToText,
} from "../src/lib/fetch-page.ts";
import {
  fetchSpecs as fetchExternalSpecs,
  normaliseModel,
  parseSpecPage,
  RateLimited,
  resolveModel,
} from "../src/knowledge/gsmarena.ts";
import { buildPrompt, classifyFailure } from "../src/commands/heal.ts";

const FIXTURE = "tests/fixtures/run-phones-15000";

Deno.test("parseMoney handles numbers, strings and BrightData price objects", () => {
  assertEquals(parseMoney(13999), 13999);
  assertEquals(parseMoney("₹13,999"), 13999);
  assertEquals(
    parseMoney({ value: 10999, currency: "INR", symbol: "₹" }),
    10999,
  );
  assertEquals(parseMoney("13,999.00"), 13999);
  assertEquals(parseMoney(null), null);
  assertEquals(parseMoney(0), null);
  assertEquals(parseMoney("out of stock"), null);
});

Deno.test("titleFromUrl recovers a product name from a Flipkart slug", () => {
  const url =
    "https://www.flipkart.com/poco-c85x-sunset-gold-128-gb/p/itm5e970a19e6ad3?pid=MOBHMGG5BR94DQRY";
  assertEquals(titleFromUrl(url), "POCO C85X Sunset Gold 128 GB");
});

Deno.test("titleFromUrl strips Reliance's opaque SKU suffix", () => {
  const url =
    "https://www.reliancedigital.in/product/samsung-galaxy-m06-5g-black-lgm2lf";
  assertEquals(titleFromUrl(url), "Samsung Galaxy M06 5G Black");
});

Deno.test("normalizeBatch recovers the cards the old parser silently dropped", async () => {
  const raw = JSON.parse(await Deno.readTextFile(`${FIXTURE}/flipkart.json`));
  const { listings, stats } = normalizeBatch(raw, "flipkart");

  assertEquals(stats.rawCards, 120);
  assertEquals(listings.length, 120);
  assert(
    stats.titleRecovered >= 50,
    `expected >=50 recovered, got ${stats.titleRecovered}`,
  );
  assert(listings.every((l) => l.title.length > 3));
});

Deno.test("normalizeBatch counts upstream crawler errors instead of parsing them", async () => {
  const raw = JSON.parse(await Deno.readTextFile(`${FIXTURE}/tatacliq.json`));
  const { listings, stats } = normalizeBatch(raw, "tatacliq");
  assertEquals(listings.length, 0);
  assertEquals(stats.errorCards, 1);
});

Deno.test("an MRP below the selling price is discarded, not shown as a discount", () => {
  const { listings } = normalizeBatch([
    {
      product_name: "Test Phone",
      selling_price: 15000,
      original_price: 12000,
      product_url: "https://www.flipkart.com/test-phone/p/itm1",
    },
  ], "flipkart");
  assertEquals(listings[0].mrp, null);
  assertEquals(listings[0].discountPct, null);
});

Deno.test("earphones are never classified as phones", () => {
  const cases = [
    "OnePlus Bullets Z2 Bluetooth Wireless in Ear Earphones with Mic",
    "Reconnect Dank Wireless Earphone with IPX4 Water Resistant, Up to 16 Hours of playtime",
    "boAt Airdopes 141 TWS Earbuds",
  ];
  for (const title of cases) {
    const c = classify(title);
    assert(
      c.category === "earbuds" || c.category === "headphone",
      `${title} -> ${c.category}`,
    );
    assertEquals(categoryMatches("phone", c.category), false);
  }
});

Deno.test("accessory vetoes fire on real titles, not just in theory", () => {
  // These carry earbud bait words ("airpods", "for boAt") but are
  // accessories. Their veto regexes were double-escaped and matched
  // nothing - the one-character class of bug that silently passes tests.
  const cases = [
    "Silicone Case Cover for Sony WF-1000XM5 Earbuds",
    "Ear Tips Replacement Pouch for boAt Airdopes 141",
    "Charger Stand Holder Compatible with Apple AirPods Pro",
  ];
  for (const title of cases) {
    const c = classify(title);
    assert(
      c.category !== "earbuds" && c.category !== "headphone",
      `${title} -> ${c.category}`,
    );
  }
});

Deno.test("Indian phone listing cards are classified as phones", () => {
  const cases = [
    "POCO M7 5G (Ocean Blue, 128 GB) (8 GB RAM)",
    "Samsung Galaxy M07 (Black, 64 GB) (4 GB RAM)",
    "realme narzo 100 Lite 5G (Thunder Black, 4GB RAM, 64GB Storage)",
  ];
  for (const title of cases) {
    assertEquals(classify(title).category, "phone", title);
  }
});

Deno.test("phone accessories are rejected even when they name a phone", () => {
  const c = classify("Back Cover for Samsung Galaxy M07, Tempered Glass Combo");
  assert(c.category !== "phone", `got ${c.category}`);
});

Deno.test("keypad phones without self-describing titles still classify as featurephone", () => {
  // Real leaks from a live run: these titles carry no "keypad"/"feature
  // phone" words, so only the model patterns can catch them. The Moto A-
  // and LAVA A1/Hero lineages are keypad-only; pure-digit Nokias are too.
  const cases = [
    "LAVA A1 Josh",
    "MOTOROLA Moto A300 2026",
    "LAVA Hero Shakti 2026",
    "MOTOROLA Moto A100",
    "Nokia 130 Music Dual Sim with Music Player, Dedicated Music Buttons",
    "LAVA A2 Smart",
  ];
  for (const title of cases) {
    assertEquals(classify(title).category, "featurephone", title);
    assertEquals(
      categoryMatches("phone", "featurephone"),
      false,
      `${title} must not survive a phone gate`,
    );
  }
});

Deno.test("modern lines that resemble keypad models stay phones", () => {
  const cases = [
    "Motorola Edge 60 Pro (Deep Sea Blue, 256 GB) (12 GB RAM)",
    "Nokia G42 5G (So Purple, 128 GB) (6 GB RAM)",
    "LAVA Blaze 5G (Glass Green, 128 GB) (6 GB RAM)",
    "Motorola E13 (Cosmic Black, 64 GB) (4 GB RAM)",
  ];
  for (const title of cases) {
    assertEquals(classify(title).category, "phone", title);
  }
});

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

Deno.test("carrier-locked SKUs stay separate from the unlocked phone", () => {
  const locked = deriveModelKey(
    "POCO M7 5G - Locked with Airtel Prepaid (Mint Green, 128 GB)",
  );
  const unlocked = deriveModelKey("POCO M7 5G (Mint Green, 128 GB) (6 GB RAM)");
  assert(locked !== unlocked);
  assert(locked.includes("#carrier-locked"));
  assertEquals(detectQualifiers("Refurbished iPhone 13"), ["refurbished"]);
});

Deno.test("specs are parsed out of a standard listing title", () => {
  const { specs } = specsFromText("POCO M7 5G (Ocean Blue, 128 GB) (8 GB RAM)");
  assertEquals(specs.ramGb, 8);
  assertEquals(specs.storageGb, 128);
  assertEquals(specs.has5g, true);
  assertEquals(specs.colour, "Ocean Blue");
});

Deno.test("SoC lookup resolves aliases and ignores near-misses", () => {
  assertEquals(
    matchSoc("Snapdragon 4s Gen 2 processor")?.name,
    "Snapdragon 4s Gen 2",
  );
  assertEquals(matchSoc("MediaTek Dimensity 7025")?.name, "Dimensity 7025");
  assertEquals(matchSoc("Helio G99 Ultra")?.name, "Helio G99");
  assertEquals(matchSoc("no chipset mentioned here"), null);
});

Deno.test("knowledge base fills specs the listing never mentions", () => {
  const { listings } = normalizeBatch([
    {
      product_name: "POCO M7 Pro 5G (Olive Twilight, 128 GB) (6 GB RAM)",
      selling_price: 14999,
      product_url:
        "https://www.flipkart.com/poco-m7-pro-5g-olive-twilight-128-gb/p/itm1",
    },
  ], "flipkart");
  const a = analyze(listings[0]);
  assertEquals(a.specs.socName, "Dimensity 7025");
  assertEquals(a.specs.panel, "AMOLED");
  assertEquals(a.specs.ois, true);
  assertExists(a.specs.antutu);
  assertEquals(a.specSources.panel, "kb");
});

Deno.test("colour variants collapse into one candidate with one offer list", () => {
  const raws = ["Ocean Blue", "Mint Green", "Satin Black"].map((colour, i) => ({
    product_name: `POCO M7 5G (${colour}, 128 GB) (6 GB RAM)`,
    selling_price: 12499 + i,
    product_url: `https://www.flipkart.com/poco-m7-5g-${
      colour.toLowerCase().replace(" ", "-")
    }-128-gb/p/itm${i}`,
  }));
  const { listings } = normalizeBatch(raws, "flipkart");
  const candidates = groupListings(listings.map((l) => analyze(l)));
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].best.price, 12499);
});

Deno.test("different memory configs remain distinct candidates", () => {
  const raws = [
    { ram: 6, price: 12499 },
    { ram: 8, price: 13499 },
  ].map((c, i) => ({
    product_name: `POCO M7 5G (Ocean Blue, 128 GB) (${c.ram} GB RAM)`,
    selling_price: c.price,
    product_url:
      `https://www.flipkart.com/poco-m7-5g-ocean-blue-128-gb/p/itm${i}`,
  }));
  const { listings } = normalizeBatch(raws, "flipkart");
  const candidates = groupListings(listings.map((l) => analyze(l)));
  assertEquals(candidates.length, 2);
  assert(candidates.every((c) => c.siblingConfigs.length === 1));
});

Deno.test("the same phone on two platforms becomes one candidate with two offers", () => {
  const { listings } = normalizeBatch([
    {
      product_name: "POCO M7 5G (Ocean Blue, 128 GB) (6 GB RAM)",
      selling_price: 12499,
      product_url:
        "https://www.flipkart.com/poco-m7-5g-ocean-blue-128-gb/p/itm1",
    },
    {
      product_name: "POCO M7 5G (Ocean Blue, 128 GB) (6 GB RAM)",
      selling_price: 12999,
      product_url: "https://www.amazon.in/poco-m7-5g/dp/B0TEST",
    },
  ]);
  const candidates = groupListings(listings.map((l) => analyze(l)));
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].offers.length, 2);
  assertEquals(candidates[0].best.platform, "flipkart");
});

Deno.test("review counts are not summed across colour variants", () => {
  const raws = ["Blue", "Black"].map((colour, i) => ({
    product_name: `POCO M7 5G (${colour}, 128 GB) (6 GB RAM)`,
    selling_price: 12499,
    rating: 4.1,
    review_count: 78000,
    product_url:
      `https://www.flipkart.com/poco-m7-5g-${colour.toLowerCase()}-128-gb/p/itm${i}`,
  }));
  const { listings } = normalizeBatch(raws, "flipkart");
  const [c] = groupListings(listings.map((l) => analyze(l)));
  assertEquals(c.ratingCount, 78000);
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

Deno.test("budget is a hard gate, not a penalty", () => {
  const { listings } = normalizeBatch([
    {
      product_name: "POCO M7 5G (Ocean Blue, 128 GB) (6 GB RAM)",
      selling_price: 12499,
      product_url: "https://www.flipkart.com/poco-m7-5g/p/itm1",
    },
    {
      product_name: "Samsung Galaxy M35 5G (Blue, 128 GB) (6 GB RAM)",
      selling_price: 19999,
      product_url: "https://www.flipkart.com/samsung-galaxy-m35-5g/p/itm2",
    },
  ], "flipkart");
  const candidates = groupListings(listings.map((l) => analyze(l)));
  const { ranked, rejected } = rankCandidates(
    candidates,
    parseIntentRules("phones under 15000"),
  );
  assertEquals(ranked.length, 1);
  assertEquals(rejected.length, 1);
  assert(rejected[0].reasons[0].includes("over budget"));
});

Deno.test("a 4.9-star product with 3 reviews cannot outrank 4.2 with 150k", () => {
  const mk = (name: string, rating: number, count: number) => ({
    product_name: `${name} (Black, 128 GB) (6 GB RAM)`,
    selling_price: 12000,
    rating,
    review_count: count,
    product_url: `https://www.flipkart.com/${
      name.toLowerCase().replace(/ /g, "-")
    }/p/itm${name}`,
  });
  const { listings } = normalizeBatch(
    [mk("Nomame Alpha", 4.9, 3), mk("POCO M7 5G", 4.2, 150000)],
    "flipkart",
  );
  const candidates = groupListings(listings.map((l) => analyze(l)));
  const { ranked } = rankCandidates(
    candidates,
    parseIntentRules("phones under 15000"),
  );
  assertEquals(ranked[0].modelName.includes("POCO"), true);
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

Deno.test("the camera array is read: telephoto, ultrawide and aperture", () => {
  const rich = specsFromText(
    "MOTOROLA Edge 70 Pro 5G (8 GB RAM) (256 GB) 50 MP + 50MP ultrawide +" +
      " 10 MP telephoto periscope 3x optical, f/1.5 aperture",
  ).specs;
  assertEquals(rich.mainCameraMp, 50);
  assertEquals(rich.ultraWideMp, 50);
  assertEquals(rich.teleMp, 10);
  assertEquals(rich.aperture, 1.5);

  const plain = specsFromText(
    "Ai+ Nova 2 Ultra 5G (6 GB RAM) (128 GB) 50 MP OIS camera",
  ).specs;
  assertEquals(plain.mainCameraMp, 50);
  // specsFromText only reports what it read; unset lenses are absent.
  assertEquals(plain.ultraWideMp ?? null, null);
  assertEquals(plain.teleMp ?? null, null);
  assertEquals(plain.aperture ?? null, null);
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

Deno.test("an inflated MRP is flagged rather than rewarded", () => {
  const { listings } = normalizeBatch([
    {
      product_name: "Nomame Ultra (Black, 128 GB) (6 GB RAM)",
      selling_price: 9999,
      original_price: 29999,
      product_url: "https://www.flipkart.com/nomame-ultra/p/itm1",
    },
    {
      product_name: "POCO M7 5G (Black, 128 GB) (6 GB RAM)",
      selling_price: 12499,
      original_price: 12999,
      rating: 4.2,
      review_count: 78000,
      product_url: "https://www.flipkart.com/poco-m7-5g/p/itm2",
    },
  ], "flipkart");
  const candidates = groupListings(listings.map((l) => analyze(l)));
  const { ranked } = rankCandidates(
    candidates,
    parseIntentRules("phones under 15000"),
  );
  const fake = ranked.find((r) => r.modelName.includes("Nomame"))!;
  assert(
    fake.cons.some((c) => c.includes("inflated MRP")),
    fake.cons.join(" / "),
  );
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

Deno.test("REGRESSION: a keypad phone never survives rankCandidates", () => {
  const { listings } = normalizeBatch([
    {
      product_name: "LAVA A1 Josh",
      selling_price: 1049,
      product_url: "https://www.flipkart.com/lava-a1-josh/p/itm1",
    },
    {
      product_name: "POCO M7 5G (Ocean Blue, 128 GB) (6 GB RAM)",
      selling_price: 12499,
      product_url: "https://www.flipkart.com/poco-m7-5g/p/itm2",
    },
  ], "flipkart");
  const candidates = groupListings(listings.map((l) => analyze(l)));
  const { ranked } = rankCandidates(
    candidates,
    parseIntentRules("phones under 15000"),
  );

  assertEquals(ranked.length, 1);
  assert(
    !/a1 josh/i.test(ranked[0].modelName),
    `keypad phone in ranked output: ${ranked[0].modelName}`,
  );
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

Deno.test('Amazon: booleans arrive as the strings "true"/"false"', () => {
  const { listings } = normalizeBatch([
    {
      name: "Peace SC26 5G 6GB/64GB Smartphone (Silver)",
      final_price: 8988,
      sponsored: "false",
      url: "https://www.amazon.in/Xifo-Peace-5G/dp/B0HC7NKZGV",
    },
    {
      name: "Some Sponsored Phone (Black, 128 GB) (6 GB RAM)",
      final_price: 9999,
      sponsored: "true",
      url: "https://www.amazon.in/x/dp/B0OTHER",
    },
  ], "amazon");
  assertEquals(listings[0].sponsored, false);
  assertEquals(listings[1].sponsored, true);
});

Deno.test("Amazon: an absurd MRP is treated as bad data, not a 94% discount", () => {
  const { listings } = normalizeBatch([
    {
      name: "Peace I-Ultra 6GB/64GB Smartphone (Orange)",
      final_price: 8899,
      initial_price: 159994,
      url: "https://www.amazon.in/peace-i-ultra/dp/B0X",
    },
  ], "amazon");
  assertEquals(listings[0].mrp, null);
  assertEquals(listings[0].discountPct, null);
});

Deno.test("Amazon: feature text in the title tail must not veto the category", () => {
  const titles = [
    'Itel Zeno 200 (Nightly Blue, 4 GB RAM, 128 GB Storage) | 6.75" HD+ Display | 120 Hz Refresh Rate | IP65 Dust & Water Resistance | 13 MP Camera | 5000 mAh Battery | Charger in Box',
    "Samsung Galaxy M06 5G Mobile (Sage Green, 4GB RAM, 128GB Storage) | MediaTek Dimensity 6300 | AnTuTu 623K+ | 25W Fast Charging | 4 Gen OS Upgrades | 50MP Camera | Without Charger",
    "realme NARZO 90x 5G (Aqua Blue 2026, 6GB+128GB) | 7000mAh + 60W Biggest Battery & Fastest Charging in the Segment* | 144Hz Bright Display | Sony 50MP AI Rear Camera | 400% Ultra Boom Speaker",
  ];
  for (const t of titles) {
    assertEquals(classify(t).category, "phone", t.slice(0, 50));
  }
});

Deno.test("a genuine accessory is still rejected after the veto change", () => {
  const titles = [
    "Silicone Case for Sony WH-1000XM5 Headphones, Xm5 Headband Cover & Ear Cups Protector - Navy Blue",
    "SOULWIT Ear Pads Cushions Replacement for Sony WH-1000XM4",
    "Back Cover for Samsung Galaxy M07 | Shockproof | Camera Protection",
  ];
  for (const t of titles) {
    assert(classify(t).category !== "phone", t.slice(0, 40));
    assert(classify(t).category !== "headphone", t.slice(0, 40));
  }
});

Deno.test("Amazon: a stated AnTuTu score in the title is used", () => {
  const { specs } = specsFromText(
    "Samsung Galaxy M06 5G Mobile (Sage Green, 4GB RAM, 128GB Storage) | MediaTek Dimensity 6300 | AnTuTu 623K+ | 25W Fast Charging",
  );
  assertEquals(specs.antutu, 623000);
  assertEquals(specs.chargingW, 25);
});

Deno.test("REGRESSION: every phone in the real Amazon snapshot is kept", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(`${FIXTURE}/amazon.json`),
  );
  const { listings } = normalizeBatch(raw, "amazon");
  assertEquals(listings.length, 16);
  const analyzed = listings.map((l) => analyze(l));
  const phones = analyzed.filter((a) => a.category === "phone");
  assertEquals(phones.length, 16, "all 16 Amazon cards are phones");
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

Deno.test("a chip name from a structured field needs no context word", () => {
  assertEquals(matchSocExact("T7250")?.name, "Unisoc T7250");
  assertEquals(matchSocExact("Unisoc T7250")?.name, "Unisoc T7250");
  assertEquals(matchSocExact("Dimensity 6300")?.name, "Dimensity 6300");
  assertEquals(matchSocExact("Aulumu A17 for iPhone 17 Pro Max Case"), null);
  assertEquals(matchSoc("Aulumu A17 for iPhone 17 Pro Max Case"), null);
});

Deno.test("a product page cannot overwrite a trusted knowledge-base entry", () => {
  const { listings } = normalizeBatch([
    {
      product_name: "Motorola G45 5G (Brilliant Blue, 128 GB) (8 GB RAM)",
      selling_price: 12414,
      product_url:
        "https://www.flipkart.com/motorola-g45-5g-brilliant-blue-128-gb/p/itm1",
    },
  ], "flipkart");

  const enrichText = new Map([[
    listings[0].id,
    "Super AMOLED Display 70W Fast Charging MediaTek Helio G81 7000 mAh",
  ]]);
  const a = analyze(listings[0], { enrichText });

  const kb = lookupModel("Motorola G45 5G")!;
  assertEquals(kb.confidence, "high");
  assertEquals(a.specs.panel, kb.panel);
  assertEquals(a.specs.chargingW, kb.chargingW);
  assertEquals(a.specs.socName, kb.soc);
  assertEquals(a.specSources.panel, "kb");
});

Deno.test("a page still fills gaps the knowledge base leaves", () => {
  const { listings } = normalizeBatch([
    {
      product_name: "Motorola G45 5G (Brilliant Blue, 128 GB) (8 GB RAM)",
      selling_price: 12414,
      product_url:
        "https://www.flipkart.com/motorola-g45-5g-brilliant-blue-128-gb/p/itm1",
    },
  ], "flipkart");
  const a = analyze(listings[0], {
    enrichText: new Map([[listings[0].id, "Weight 183 g Android 14"]]),
  });
  assertEquals(a.specs.panel, lookupModel("Motorola G45 5G")!.panel);
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

Deno.test("a rendered product link is never truncated", () => {
  const url =
    "https://www.flipkart.com/samsung-galaxy-m17-5g-moonlight-silver-128-gb/p/itmc3b8f7b511eca" +
    "?pid=MOBHGU9DYEBQW6NW&lid=LSTMOBHGU9DYEBQW6NWIWMUZV&marketplace=FLIPKART" +
    "&q=phones+under+15000&srno=s_5_106&otracker=search&fm=organic";
  const shown = canonicalUrl(url);
  assert(shown.includes("pid=MOBHGU9DYEBQW6NW"), `pid was mangled: ${shown}`);
  assert(!shown.includes("…"));
  assert(!shown.includes("otracker") && !shown.includes("lid="));
});

Deno.test("all four marketplaces run, and the broken ones say why", () => {
  // Breadth is the point for this tool, and two of these are hosted
  // collectors we cannot repair from here. They stay in the default set; what
  // they contribute is reported per run rather than hidden behind a count.
  assertEquals(ALL_ENABLED.sort(), [
    "amazon",
    "flipkart",
    "reliance",
    "tatacliq",
  ]);
  for (const p of ["reliance", "tatacliq"] as const) {
    assert(PLATFORMS[p].enabled);
    assert(
      (PLATFORMS[p].knownIssue ?? "").length > 40,
      `${p} has a known defect recorded without an explanation`,
    );
  }
  for (const p of ["amazon", "flipkart"] as const) {
    assertEquals(PLATFORMS[p].knownIssue, undefined);
  }
});

Deno.test("every platform builds a seed URL for its own site", () => {
  const intent = parseIntentRules("phones under 15000");
  assert(buildUrls("reliance", intent, 1)[0].includes("reliancedigital.in"));
  assert(buildUrls("tatacliq", intent, 1)[0].includes("tatacliq.com"));
  assert(buildUrls("flipkart", intent, 1)[0].includes("flipkart.com"));
  assert(buildUrls("amazon", intent, 1)[0].includes("amazon.in"));
});

Deno.test("every chip is on the same benchmark scale", () => {
  for (const soc of SOCS) {
    assert(
      soc.antutu >= 100_000 && soc.antutu <= 3_000_000,
      `${soc.name} at ${soc.antutu} is outside the v11 range — wrong scale?`,
    );
  }
});

Deno.test("the benchmark table preserves known hardware ordering", () => {
  const at = (n: string) => SOCS.find((s) => s.name === n)!.antutu;
  assert(at("Snapdragon 8 Gen 3") > at("Dimensity 8300"));
  assert(at("Dimensity 8300") > at("Dimensity 6300"));
  assert(at("Dimensity 6300") > at("Unisoc T7250"));
  assert(at("Unisoc T7250") > at("Unisoc SC9863A"));
  assert(at("Snapdragon 6s Gen 3") > at("Helio G85"));
});

Deno.test("every chipset named in the model KB exists in the chip table", () => {
  for (const m of PHONE_MODELS) {
    if (!m.soc) continue;
    assert(
      SOCS.some((s) => s.name === m.soc),
      `${m.display} names "${m.soc}", which is not in soc.ts`,
    );
  }
});

Deno.test("the secondary spec source reads a full sheet and a real benchmark", async () => {
  const html = await Deno.readTextFile(
    "tests/fixtures/beebom/realme-narzo-90x.html",
  );
  const s = parseBeebomPage(html, "u", "realme-narzo-90x")!;
  assert(s !== null);
  assertEquals(s.socName, "MediaTek Dimensity 6300");
  assertEquals(s.antutu, 560000);
  assertEquals(s.batteryMah, 7000);
  assertEquals(s.refreshHz, 144);
  assertEquals(s.panel, "LCD");
  assertEquals(s.nm, 6);
  assertEquals(s.resolution, "HD+");
  assertEquals(s.mainCameraMp, 50);
  assertEquals(s.ipRating, "IP65");
});

Deno.test("a spec sheet without a benchmark still resolves the chipset", () => {
  const html = Deno.readTextFileSync(
    "tests/fixtures/beebom/itel-zeno-200.html",
  );
  const s = parseBeebomPage(html, "u", "itel-zeno-200")!;
  assertEquals(s.socName, "Unisoc T7250");
  assertEquals(s.antutu, null);
  assertEquals(s.batteryMah, 5000);
});

Deno.test("slug candidates cope with how brands are actually written", () => {
  assertEquals(
    beebomSlugs("Motorola G45 5G (8GB/128GB)", "Motorola")[0],
    "moto-g45-5g",
  );
  assert(
    !beebomSlugs("realme Narzo 90x 5G (8GB/128GB)", "realme")[0].includes(
      "8gb",
    ),
  );
  assertEquals(
    beebomSlugs("REDMI A7 Pro 4G (4GB/64GB)", "Xiaomi")[0],
    "redmi-a7-pro-4g",
  );
});

Deno.test("a near-miss page is rejected rather than mis-attributed", () => {
  assertEquals(
    beebomSlugs("Redmi Note 13 Pro+ 5G", "Xiaomi")[0],
    "redmi-note-13-pro-plus-5g",
  );
  const wrongPhone =
    '<title>Redmi Note 13 Pro - Price in India</title>{"name":"Redmi Note 13 Pro"}';
  assertEquals(
    nameMatches("Redmi Note 13 Pro+ 5G", wrongPhone, "redmi-note-13-pro"),
    false,
  );
  const rightPhone = "<title>Redmi Note 13 Pro+ 5G - Price in India</title>";
  assertEquals(
    nameMatches(
      "Redmi Note 13 Pro+ 5G",
      rightPhone,
      "redmi-note-13-pro-plus-5g",
    ),
    true,
  );
});

Deno.test("phones on the same chipset score the same, resolved or not", () => {
  const chip = matchSocDetailed("Dimensity 6300")!.soc;
  const resolved = toSpecs({
    url: "u",
    matchedName: "m",
    socName: "MediaTek Dimensity 6300",
    antutu: 560000,
    nm: null,
    geekbench: null,
    batteryMah: null,
    chargingW: null,
    panel: null,
    inches: null,
    refreshHz: null,
    resolution: null,
    mainCameraMp: null,
    ois: false,
    nfc: null,
    ipRating: null,
    weightG: null,
  });
  assertEquals(resolved.antutu, chip.antutu);
});

Deno.test("a page value cannot silently correct a confident KB chipset", () => {
  const kb = lookupModel("Redmi 14C 5G");
  assertEquals(kb?.soc, "Snapdragon 4s Gen 2");
  assertEquals(kb?.confidence, "high");
});

Deno.test("a page with no chipset yields nothing rather than a hollow record", () => {
  assertEquals(
    parseBeebomPage("<html><body>not a phone</body></html>", "u", "x"),
    null,
  );
});

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

Deno.test("KB: no duplicate model keys", () => {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const m of PHONE_MODELS) {
    if (seen.has(m.key)) dupes.push(m.key);
    seen.add(m.key);
    for (const a of m.aliases ?? []) {
      if (seen.has(a)) dupes.push(a);
      seen.add(a);
    }
  }
  assertEquals(dupes, []);
});

Deno.test("KB: every declared chipset resolves in the SoC table", () => {
  const unresolved = PHONE_MODELS
    .filter((m) => m.soc && !matchSoc(m.soc))
    .map((m) => `${m.key} -> ${m.soc}`);
  assertEquals(unresolved, []);
});

Deno.test("KB: values are inside plausible ranges", () => {
  for (const m of PHONE_MODELS) {
    if (m.batteryMah !== undefined) {
      assert(m.batteryMah >= 2000 && m.batteryMah <= 8000, `${m.key} battery`);
    }
    if (m.chargingW !== undefined) {
      assert(m.chargingW >= 5 && m.chargingW <= 300, `${m.key} charging`);
    }
    if (m.refreshHz !== undefined) {
      assert([60, 90, 120, 144, 165].includes(m.refreshHz), `${m.key} refresh`);
    }
    if (m.inches !== undefined) {
      assert(m.inches >= 4 && m.inches <= 8, `${m.key} size`);
    }
    if (m.mainCameraMp !== undefined) {
      assert(m.mainCameraMp >= 5 && m.mainCameraMp <= 250, `${m.key} camera`);
    }
    if (m.osUpgrades !== undefined) {
      assert(m.osUpgrades >= 0 && m.osUpgrades <= 8, `${m.key} updates`);
    }
  }
});

Deno.test("KB: a Pro variant never resolves to its non-Pro sibling", () => {
  const pairs: Array<[string, string]> = [
    ["POCO X6 Pro 5G (Black, 256 GB) (8 GB RAM)", "poco x6 pro 5g"],
    ["POCO X6 5G (Blue, 128 GB) (8 GB RAM)", "poco x6 5g"],
    ["Redmi Note 13 Pro+ 5G (Fusion Purple, 256 GB)", "redmi note 13 pro+ 5g"],
    ["Redmi Note 13 5G (Arctic White, 128 GB)", "redmi note 13 5g"],
    ["POCO M7 Pro 5G (Olive Twilight, 128 GB)", "poco m7 pro 5g"],
    ["POCO M7 5G (Ocean Blue, 128 GB)", "poco m7 5g"],
  ];
  for (const [title, expected] of pairs) {
    assertEquals(lookupModel(title)?.key, expected, title);
  }
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

Deno.test("SoC matching survives Flipkart's space-stripped highlight strings", () => {
  assertEquals(
    matchSoc("4 GB RAM | 128 GB ROM T7250 | Octa Core Processor")?.name,
    "Unisoc T7250",
  );
  assertEquals(
    matchSoc("Dimensity6300 | Octa Core Processor")?.name,
    "Dimensity 6300",
  );
  assertEquals(matchSoc("Snapdragon6 | Octa Core Processor"), null);
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

Deno.test("checkout details are parsed from a real Flipkart offer block", () => {
  const text =
    "Protect Promise Fee Buy at ₹14,249 Apply offers for maximum savings ₹14,249 " +
    "Lowest price for you OR ₹662 x 24m Pay ₹15,875 Exchange offer Not available at " +
    "this Pincode Up to ₹10,700 Change pincode to exchange item Exchange offer Up to " +
    "₹10,700 Bank offers Bank offers ₹750 off View EMI offers No Cost EMI* | Unlock ₹1 lakh";

  const c = parseCheckout(text);
  assertEquals(c.buyAt, 14249);
  assertEquals(c.bankOffer, 750);
  assertEquals(c.exchangeUpTo, 10700);
  assertEquals(c.noCostEmi, true);
  assertEquals(c.pincodeBlocked, true);
});

Deno.test("checkout parsing degrades quietly on a page with no offers", () => {
  const c = parseCheckout("Some product page with no offer block at all");
  assertEquals(c.buyAt, null);
  assertEquals(c.bankOffer, null);
  assertEquals(hasCheckoutInfo(c), false);
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

Deno.test("the same phone groups across Flipkart and Amazon title styles", () => {
  const pairs: Array<[string, string]> = [
    [
      "POCO M7 5G (Ocean Blue, 128 GB) (6 GB RAM)",
      "POCO M7 5G Smartphone (Ocean Blue, 6GB RAM, 128GB Storage) | Snapdragon 4s Gen 2",
    ],
    [
      "Samsung Galaxy M06 5G (Sage Green, 128 GB) (4 GB RAM)",
      "Samsung Galaxy M06 5G Mobile (Sage Green, 4GB RAM, 128GB Storage) | MediaTek Dimensity 6300 | AnTuTu 623K+",
    ],
    [
      "realme narzo 100 Lite 5G (Thunder Black, 64 GB) (4 GB RAM)",
      "realme narzo 100 Lite 5G (Thunder Black,4GB+64GB) | 7000mAh Titan Battery",
    ],
    [
      "iQOO Z10 Lite 5G (Cyber Green, 64 GB) (4 GB RAM)",
      "iQOO Z10 Lite 5G (Cyber Green 2026, 4GB RAM, 64GB Storage) | Dimensity 6300",
    ],
  ];
  for (const [flipkart, amazon] of pairs) {
    assertEquals(deriveModelKey(amazon), deriveModelKey(flipkart), flipkart);
  }
});

Deno.test("a cross-platform pair produces one candidate with the cheaper offer first", () => {
  const { listings } = normalizeBatch([
    {
      product_name: "POCO M7 5G (Ocean Blue, 128 GB) (6 GB RAM)",
      selling_price: 12499,
      product_url:
        "https://www.flipkart.com/poco-m7-5g-ocean-blue-128-gb/p/itm1",
    },
    {
      name:
        "POCO M7 5G Smartphone (Ocean Blue, 6GB RAM, 128GB Storage) | Snapdragon 4s Gen 2 | 5160mAh",
      final_price: 11999,
      url: "https://www.amazon.in/POCO-M7-5G/dp/B0TEST123",
    },
  ]);
  const candidates = groupListings(listings.map((l) => analyze(l)));
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].offers.length, 2);
  assertEquals(candidates[0].best.platform, "amazon");
  assertEquals(candidates[0].best.price, 11999);
});

Deno.test("SoC matches record whether the page named the vendor", () => {
  const named = matchSocDetailed("Qualcomm Snapdragon 4 Gen 2 processor");
  assertEquals(named?.soc.name, "Snapdragon 4 Gen 2");
  assertEquals(named?.ambiguous, false);

  const abbreviated = matchSocDetailed(
    "6 GB RAM | 128 GB ROM 4 Gen 2 5G | Octa Core",
  );
  assertEquals(abbreviated?.soc.name, "Snapdragon 4 Gen 2");
  assertEquals(abbreviated?.ambiguous, true);

  assertEquals(matchSocDetailed("no chipset here"), null);
});

Deno.test("an abbreviated page value cannot overwrite a confident KB entry", () => {
  const { listings } = normalizeBatch([
    {
      product_name: "POCO C75 5G (Enchanted Green, 64 GB) (4 GB RAM)",
      selling_price: 7499,
      product_url:
        "https://www.flipkart.com/poco-c75-5g-enchanted-green-64-gb/p/itm1",
    },
  ], "flipkart");

  const enrichText = new Map([[
    listings[0].id,
    "Product highlights 4 GB RAM | 64 GB ROM 4 Gen 2 5G | Octa Core Processor | 2.2 GHz",
  ]]);
  const a = analyze(listings[0], { enrichText });

  assertEquals(a.specs.socName, "Snapdragon 4s Gen 2");
  assertEquals(a.specSources.socName, "kb");
});

Deno.test("an unambiguous page value overwrites a KB entry we doubt", () => {
  // This test used to assert the opposite for a high-confidence entry. The
  // 14:39 replay overturned it: of the conflicts raised, the page was wrong
  // in three of four — a Dimensity 6300 claimed for the Unisoc Redmi A7 Pro
  // 4G, a 7400 for the narzo 80 Lite, a 6100+ for the Exynos Galaxy F17 5G.
  // Unambiguous is not the same as correct when the value may have come from
  // a comparison table further down the page. So precedence now follows how
  // much we trust the entry: high-confidence entries hold, and anything less
  // yields to the page, which is the case where the page usually is better.
  const { listings } = normalizeBatch([
    {
      product_name: "MOTOROLA g35 5G (Leaf Green, 128 GB) (4 GB RAM)",
      selling_price: 9999,
      product_url:
        "https://www.flipkart.com/motorola-g35-5g-leaf-green-128-gb/p/itm1",
    },
  ], "flipkart");

  const kb = lookupModel("Motorola G35 5G")!;
  assertEquals(kb.confidence, "medium");

  const enrichText = new Map([[
    listings[0].id,
    "Specifications Processor Qualcomm Snapdragon 6 Gen 1 Octa Core",
  ]]);
  const a = analyze(listings[0], { enrichText });
  assertEquals(a.specs.socName, "Snapdragon 6 Gen 1");
  assertEquals(a.specSources.socName, "enrich");
});

Deno.test("model numbers inside parens survive the model key", () => {
  // "(4a)" is a model number, not a config: dropping it collapsed every
  // Nothing Phone into one phantom key and split real variants apart.
  assertEquals(
    deriveModelKey("Nothing Phone (4a) (Blue, 256 GB) (12 GB RAM)"),
    "nothing 4a",
  );
  assertEquals(
    deriveModelKey("Nothing Phone (4a) Pro (Silver, 128 GB) (8 GB RAM)"),
    "nothing pro 4a",
  );
  // Colour/config parens still strip; ordinary keys are unchanged.
  assertEquals(
    deriveModelKey("Samsung Galaxy M17 5G (Sapphire Black, 128 GB) (6 GB RAM)"),
    "samsung galaxy m17 5g",
  );
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

Deno.test("the spec cache round-trips and reports hits", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  const url = "https://www.flipkart.com/x/p/itm1?pid=ABC&lid=noise&srno=junk";

  const a = new SpecStore(path);
  await a.load();
  assertEquals(a.get(url), null);
  assertEquals(a.stats.misses, 1);
  a.set(url, "Product highlights 8 GB RAM | 256 GB ROM", "direct");
  await a.save();

  const b = new SpecStore(path);
  await b.load();
  assertExists(b.get("https://www.flipkart.com/x/p/itm1?pid=ABC&other=1"));
  assertEquals(b.stats.hits, 1);

  await Deno.remove(path);
});

Deno.test("spec text is harvested from the embedded JSON, not just visible markup", () => {
  const html = `<html><body><div>Product highlights 6 GB RAM</div>
    <script>window.__INITIAL_STATE__ = {"a":{"label_0":{"value":{"text":"Display Type"}},
    "label_1":{"value":{"text":["HD+ 120Hz Display"]}},
    "label_2":{"value":{"text":["Refresh Rate:120Hz, 240Hz Touch Sampling Rate"]}},
    "label_3":{"value":{"text":["5160 mAh Battery"]}},
    "label_4":{"value":{"text":["33W Fast Charging"]}}}}</script></body></html>`;

  const visible = htmlToText(html);
  assert(
    !visible.includes("Refresh Rate"),
    "script content must be stripped from visible text",
  );

  const harvested = jsonStateText(html);
  assert(harvested.includes("Refresh Rate:120Hz"), harvested);
  assert(harvested.includes("5160 mAh"), harvested);

  const combined = pageToText(html);
  assert(combined.includes("Product highlights"), "keeps visible text");
  assert(combined.includes("33W Fast Charging"), "adds JSON text");

  const { specs } = specsFromText(combined);
  assertEquals(specs.refreshHz, 120);
  assertEquals(specs.batteryMah, 5160);
  assertEquals(specs.chargingW, 33);
});

Deno.test("JSON harvesting is bounded and survives malformed input", () => {
  assertEquals(jsonStateText(""), "");
  assertEquals(jsonStateText("<html>no json here</html>"), "");
  const huge = `<script>${
    '{"text":"filler value here"},'.repeat(5000)
  }</script>`;
  assert(jsonStateText(huge, 5_000).length <= 5_000);
});

Deno.test("external spec pages parse into structured specs and benchmarks", async () => {
  const text = await Deno.readTextFile(
    "tests/fixtures/gsmarena/poco-m7-pro.txt",
  );
  const s = parseSpecPage(text, "https://example.test/poco.php")!;
  assertExists(s);
  assertEquals(s.socName, "Dimensity 7025 Ultra");
  assertEquals(s.nm, 6);
  assertEquals(s.antutu, 442015);
  assertEquals(s.geekbench, 2452);
  assertEquals(s.batteryMah, 5110);
  assertEquals(s.chargingW, 45);
  assertEquals(s.panel, "AMOLED");
  assertEquals(s.inches, 6.67);
  assertEquals(s.refreshHz, 120);
  assertEquals(s.resolution, "FHD+");
  assertEquals(s.mainCameraMp, 50);
  assertEquals(s.ois, true);
  assertEquals(s.nfc, true);
  assertEquals(s.ipRating, "IP64");
});

Deno.test("model resolution refuses near-misses", () => {
  const index = [
    {
      name: "Redmi Note 14s",
      brand: "Xiaomi",
      slug: "xiaomi_redmi_note_14s-1.php",
    },
    {
      name: "Poco M7 Pro",
      brand: "Xiaomi",
      slug: "xiaomi_poco_m7_pro_5g-2.php",
    },
    { name: "Poco M7", brand: "Xiaomi", slug: "xiaomi_poco_m7-3.php" },
    { name: "Galaxy M07", brand: "Samsung", slug: "samsung_galaxy_m07-4.php" },
  ];

  assertEquals(
    resolveModel("poco m7 pro 5g", "POCO", index)?.slug,
    "xiaomi_poco_m7_pro_5g-2.php",
  );
  assertEquals(
    resolveModel("poco m7", "POCO", index)?.slug,
    "xiaomi_poco_m7-3.php",
  );
  assertEquals(
    resolveModel("samsung galaxy m07", "Samsung", index)?.slug,
    "samsung_galaxy_m07-4.php",
  );

  assertEquals(resolveModel("redmi note 14", "Xiaomi", index), null);
  assertEquals(resolveModel("nonexistent phone 9000", "Xiaomi", index), null);
});

Deno.test("model names are normalised across marketplace and database spellings", () => {
  assertEquals(normaliseModel("MOTOROLA g35 5G"), normaliseModel("Moto G35"));
  assertEquals(
    normaliseModel("Samsung Galaxy M07 5G"),
    normaliseModel("samsung galaxy m07"),
  );
});

Deno.test("REGRESSION: a case brand name must not be read as a chipset", () => {
  const carousel =
    "P: null Rs 9,999.00 FREE delivery Wed, 26 Aug Feedback Aulumu A17 for " +
    "iPhone 17 Pro Max Magnetic Thermal Case | CoolHyper | with stand";
  assertEquals(matchSoc(carousel), null);

  assertEquals(matchSoc("Chipset Apple A17 Pro (3 nm)")?.name, "Apple A17 Pro");
  assertEquals(
    matchSoc("A17 Bionic hexa-core processor")?.name,
    "Apple A17 Pro",
  );
});

Deno.test("vendor-less chipset aliases require processor context", () => {
  assertEquals(
    matchSoc("4 GB RAM | 64 GB ROM T7250 | Octa Core Processor | 1.8 GHz")
      ?.name,
    "Unisoc T7250",
  );
  assertEquals(matchSoc("Order reference T7250 shipped on Tuesday"), null);
  assertEquals(matchSoc("Model number G99 packaging box"), null);
  assertEquals(matchSoc("Processor Helio G99 octa-core")?.name, "Helio G99");
});

Deno.test("--allow-paid is permission to fall back, not to spend by default", async () => {
  let directCalls = 0;
  let paidCalls = 0;

  const entry = { name: "Poco M7 Pro", brand: "Xiaomi", slug: "x-1.php" };
  const page = await Deno.readTextFile(
    "tests/fixtures/gsmarena/poco-m7-pro.txt",
  );

  const ok = await fetchExternalSpecs(entry, "poco m7 pro", (_u) => {
    directCalls++;
    return Promise.resolve(page);
  });
  assertExists(ok);
  assertEquals(directCalls, 1);
  assertEquals(paidCalls, 0);

  const viaFallback = await fetchExternalSpecs(
    entry,
    "poco m7 pro",
    async (_u) => {
      directCalls++;
      try {
        throw new Error("HTTP 403");
      } catch {
        paidCalls++;
        return await Promise.resolve(page);
      }
    },
  );
  assertExists(viaFallback);
  assertEquals(paidCalls, 1);
});

Deno.test("a 429 from the spec database is surfaced as a distinct, stoppable error", async () => {
  const entry = { name: "Poco M7 Pro", brand: "Xiaomi", slug: "x-1.php" };
  await assertRejects(
    () =>
      fetchExternalSpecs(
        entry,
        "poco m7 pro",
        () => Promise.reject(new Error("HTTP 429")),
      ),
    RateLimited,
  );
});

Deno.test("availability is read from the selected variant, not the page at large", async () => {
  const out = await Deno.readTextFile(
    "tests/fixtures/pages/maplin-sc26-5g.txt",
  );
  assertEquals(parseCheckout(out).inStock, false);

  const ok = await Deno.readTextFile("tests/fixtures/pages/poco-m7-pro-5g.txt");
  const c = parseCheckout(ok);
  assertEquals(c.inStock, true);
  assertExists(c.deliveryBy);
});

Deno.test("a carousel's stock status cannot leak onto the product", () => {
  const carousel =
    "Buy now Similar products Aulumu Case Out of stock Feedback More like this";
  assertEquals(parseCheckout(carousel).inStock, null);
});

Deno.test("an out-of-stock product is flagged and never recommended", () => {
  const rows = [
    {
      product_name:
        "Ghost Phone (Black, 128 GB) (6 GB RAM) | 5000 mAh | 120Hz AMOLED | 50MP | 5G",
      selling_price: 9999,
      rating: 4.3,
      review_count: 40000,
      product_url: "https://www.flipkart.com/ghost-phone/p/itmghost",
    },
    {
      product_name:
        "Stocked Phone (Black, 128 GB) (6 GB RAM) | 5000 mAh | 120Hz AMOLED | 50MP | 5G",
      selling_price: 12999,
      rating: 4.3,
      review_count: 40000,
      product_url: "https://www.flipkart.com/stocked-phone/p/itmstocked",
    },
  ];
  const { listings } = normalizeBatch(rows, "flipkart");
  const analyzed = listings.map((l) => analyze(l));
  const candidates = groupListings(analyzed);

  const ghost = candidates.find((c) => /Ghost/.test(c.modelName))!;
  ghost.best.inStock = false;

  const { ranked } = rankCandidates(
    candidates,
    parseIntentRules("best phones under 15000"),
  );
  const g = ranked.find((r) => /Ghost/.test(r.modelName))!;

  assert(g.badges.includes("OUT OF STOCK"), g.badges.join(","));
  assert(g.cons.some((c) => /out of stock/i.test(c)), g.cons.join(" | "));
  assert(!g.badges.includes("BEST VALUE"));
  assert(!g.badges.includes("FASTEST"));
});

Deno.test("--in-stock-only removes unavailable products entirely", () => {
  const rows = [{
    product_name:
      "Ghost Phone (Black, 128 GB) (6 GB RAM) | 5000 mAh | 120Hz | 50MP | 5G",
    selling_price: 9999,
    product_url: "https://www.flipkart.com/ghost-phone/p/itmghost",
  }];
  const { listings } = normalizeBatch(rows, "flipkart");
  const candidates = groupListings(listings.map((l) => analyze(l)));
  candidates[0].best.inStock = false;

  const intent = parseIntentRules("best phones under 15000");
  assertEquals(rankCandidates(candidates, intent).ranked.length, 1);
  assertEquals(
    rankCandidates(candidates, intent, { inStockOnly: true }).ranked.length,
    0,
  );
});

Deno.test("the ratings histogram is parsed", async () => {
  const t = await Deno.readTextFile("tests/fixtures/reviews/poco-m7-5g.txt");
  const s = summariseReviews(t);
  assertEquals(s.totalRatings, 18971);
  assertEquals(s.totalReviews, 1065);
  assertEquals(s.distribution, { 1: 1239, 2: 647, 3: 1515, 4: 4233, 5: 11337 });
  assertAlmostEquals(s.negativeShare!, 0.099, 0.005);
});

Deno.test("polarity is judged per clause, not per review", async () => {
  const t = await Deno.readTextFile("tests/fixtures/reviews/poco-m7-5g.txt");
  const s = summariseReviews(t);
  const by = (a: string) => s.aspects.find((x) => x.aspect === a);

  assert(
    (by("performance")?.positive ?? 0) > 0,
    JSON.stringify(by("performance")),
  );
  assert((by("camera")?.negative ?? 0) > 0, JSON.stringify(by("camera")));
});

Deno.test("negation flips polarity", () => {
  const withNot = summariseReviews(
    "5.0 • Title Camera not good at all. Verified Purchase · Jan, 2025",
  );
  assert(
    (withNot.aspects.find((a) => a.aspect === "camera")?.negative ?? 0) > 0,
  );

  const plain = summariseReviews(
    "5.0 • Title Camera is good. Verified Purchase · Jan, 2025",
  );
  assert((plain.aspects.find((a) => a.aspect === "camera")?.positive ?? 0) > 0);
});

Deno.test("heating counts as a complaint even when phrased neutrally", () => {
  const s = summariseReviews(
    "3.0 • Title Phone heats while gaming. Verified Purchase · Jan, 2025",
  );
  assert((s.aspects.find((a) => a.aspect === "heating")?.negative ?? 0) > 0);
});

Deno.test("variant boilerplate does not become a review of storage", () => {
  const s = summariseReviews(
    "4.0 • Nice Review for: Color Ocean Blue • RAM 8 GB • Storage 128 GB Good phone. Verified Purchase · Jan, 2025",
  );
  assertEquals(s.sampled, 1);
  assert(
    !/Storage 128 GB/.test(s.aspects.map((a) => a.example ?? "").join(" ")),
  );
});

Deno.test("a single grumble is not reported as a pattern", () => {
  const s = summariseReviews(
    "3.0 • Meh Battery is bad. Verified Purchase · Jan, 2025",
  );
  assert((s.aspects.find((a) => a.aspect === "battery")?.negative ?? 0) > 0);
  assertEquals(s.complained.length, 0);
});

Deno.test("reviews URL keeps the pid, without which Flipkart serves nothing", () => {
  assertEquals(
    reviewsUrlFor(
      "https://www.flipkart.com/poco-m7-5g/p/itm7c4?pid=MOBH9H&lid=x",
    ),
    "https://www.flipkart.com/poco-m7-5g/product-reviews/itm7c4?pid=MOBH9H",
  );
  assertEquals(reviewsUrlFor("https://www.amazon.in/x/dp/B0TEST"), null);
});

Deno.test("collector seeds are strided so extra requests buy new products", () => {
  const intent = parseIntentRules("best phones under 15000");
  const urls = buildUrls("flipkart", intent, 3);
  assertEquals(urls.length, 3);
  assertEquals(new Set(urls).size, 3);
  assert(urls[0].includes("page=1"), urls[0]);
  assert(urls[1].includes("page=6"), urls[1]);
  assert(urls[2].includes("page=11"), urls[2]);

  const az = buildUrls("amazon", intent, 3);
  assert(az[1].includes("page=2"), az[1]);
});

Deno.test("the budget filter is applied at the source, not just in ranking", () => {
  const intent = parseIntentRules("best phones under 15000");
  for (const p of ["flipkart", "tatacliq"] as const) {
    const url = buildUrls(p, intent, 1)[0];
    assert(/15000/.test(url), `${p} did not carry the budget: ${url}`);
  }
});

Deno.test("REGRESSION: the marketplace query keeps the user's words", () => {
  assertEquals(
    searchTerm(parseIntentRules("best phones under 15000")),
    "phones under 15000",
  );
  assertEquals(
    searchTerm(parseIntentRules("best gaming phone under 30000")),
    "gaming phone under 30000",
  );
  assertEquals(
    searchTerm(parseIntentRules("redmi phones under 15000")),
    "redmi phones under 15000",
  );
});

Deno.test("REGRESSION: keypad phones are not smartphones", () => {
  for (
    const t of [
      "Nokia 150 Dual SIM Premium Keypad Mobile Phone with MP3 Player, Wireless FM Radio",
      "Motorola A100 Keypad Mobile Phone with 2.4 inch display",
      "Lava Hero Shakti 2026 Dual Sim Keypad Phone 1200mAh",
    ]
  ) {
    assertEquals(classify(t).category, "featurephone", t.slice(0, 40));
    assertEquals(categoryMatches("phone", classify(t).category), false);
  }
  assertEquals(
    classify("POCO M7 Pro 5G (Olive Twilight, 128 GB) (6 GB RAM)").category,
    "phone",
  );
});

Deno.test("REGRESSION: impossible specs are rejected, not recorded", () => {
  const contaminated =
    "Nokia 150 Keypad Phone | 2.4 inch display | 1000 mAh | Similar products " +
    "20000 mAh Power Bank 8GB 128GB 50MP OIS 120Hz 5G";
  const { specs } = specsFromText(contaminated);
  assertEquals(specs.batteryMah, undefined, "20000 mAh is a power bank");
  assertEquals(
    specs.displayInches,
    undefined,
    "2.4in is not a smartphone panel",
  );
  assertEquals(
    specs.refreshHz,
    undefined,
    "dropped along with the tiny screen",
  );
  assertEquals(specs.has5g, undefined);
  assertEquals(specs.ois, undefined);

  const real = specsFromText(
    "POCO M7 Pro 5G (Olive Twilight, 128 GB) (6 GB RAM) | 6.67 inch AMOLED 120Hz | 5110 mAh | 45W | 50MP OIS | 5G",
  ).specs;
  assertEquals(real.batteryMah, 5110);
  assertEquals(real.refreshHz, 120);
  assertEquals(real.displayInches, 6.67);
  assertEquals(real.has5g, true);
});

Deno.test("implausible refresh rates are dropped rather than believed", () => {
  assertEquals(
    specsFromText("6.7 inch display 240Hz touch sampling").specs.refreshHz,
    undefined,
  );
  assertEquals(
    specsFromText("6.7 inch 120Hz AMOLED display").specs.refreshHz,
    120,
  );
});

Deno.test("panel and charging must be described, not merely mentioned", () => {
  const contaminated =
    "Galaxy F07 6.7 inch HD+ PLS LCD display 90Hz refresh rate. " +
    "5000 mAh battery with 25 W charging. " +
    "Similar products: Galaxy M36 AMOLED 120Hz, realme P4 70W fast charging";
  const a = specsFromText(contaminated);
  assertEquals(a.specs.panel, "PLS LCD");
  assertEquals(a.specs.chargingW, 25);
});

Deno.test("a genuine AMOLED is still read", () => {
  const a = specsFromText(
    "6.65 inch FHD+ Super AMOLED display, 90Hz, 5000mAh, 25W charging",
  );
  assertEquals(a.specs.panel, "AMOLED");
  assertEquals(a.specs.chargingW, 25);
});

Deno.test("the product page's price beats the search card's", () => {
  const page = parseCheckout(
    "Galaxy M17 5G (Moonlight Silver, 128 GB) (6 GB RAM) 4.4 | 1,525 " +
      "19% 23,999 ₹19,474 +₹109 Protect Promise Fee Buy at ₹18,500 " +
      "Delivery by Tomorrow | Bank offers ₹974 off",
  );
  assertEquals(page.pagePrice, 19474);
  assertEquals(page.pageMrp, 23999);
  assertEquals(page.buyAt, 18500);
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

Deno.test("the cached page section keeps the price block", async () => {
  const page = await Deno.readTextFile(
    "tests/fixtures/pages/samsung-galaxy-m07.txt",
  );
  assert(
    page.indexOf("Protect Promise Fee") <
      page.toLowerCase().indexOf("product highlights"),
  );
  const cached = extractSpecSection(page);
  assertEquals(parseCheckout(cached).pagePrice, 11699);
  assertEquals(parseCheckout(cached).pageMrp, 11999);
});

Deno.test("specRichness tells a spec table from marketing shell", () => {
  const rich = [
    "MediaTek Dimensity 6300 octa core processor",
    "6 GB RAM | 128 GB ROM",
    "5000 mAh battery",
    "6.67 inch HD+ AMOLED display",
    "50 MP + 2 MP | 8 MP front camera",
    "5G dual sim",
  ].join("\n");
  assert(specRichness(rich) >= 4);

  const flipkartShell =
    "Samsung Galaxy M17 5G (Sapphire Black, 128 GB) (6 GB RAM) " +
    "4.4 1,525 ratings ₹13,499 Free delivery Bank Offer UPI available " +
    "Protect Promise Fee Buy at ₹18,500 See Details";
  assert(specRichness(flipkartShell) < 2);

  assertEquals(specRichness(""), 0);
  assertEquals(specRichness("no specs here at all"), 0);
});

Deno.test("the buy box seller is read off the page", () => {
  const live =
    "Samsung Galaxy M17 5G (Moonlight Silver, 128 GB) (6 GB RAM) 4.4 | 1,525 " +
    "19% 23,999 ₹19,474 +₹109 Protect Promise Fee Buy at ₹18,500 " +
    "Bank offers ₹974 off Delivery by 25 Aug, Tue " +
    "Fulfilled by SmartTechMart 4.7 • 1 year with Flipkart See other sellers";
  const c = parseCheckout(live);
  assertEquals(c.pagePrice, 19474);
  assertEquals(c.pageMrp, 23999);
  assertEquals(c.buyAt, 18500);
  assertEquals(c.seller, "SmartTechMart");
});

Deno.test("prices expire from the cache long before specs do", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  const store = new SpecStore(path);
  await store.load();
  const url = "https://www.flipkart.com/x/p/itm1?pid=P1";

  store.set(url, "spec text", "direct");
  store.setPrice(url, "19% 23,999 ₹19,474 +₹109 Protect Promise Fee", "direct");
  await store.save();

  const reread = new SpecStore(path);
  await reread.load();
  assertEquals(reread.get(url), "spec text");
  assertEquals(parseCheckout(reread.getPrice(url) ?? "").pagePrice, 19474);

  // An hour-old price entry is gone; the spec text beside it survives.
  const raw = JSON.parse(await Deno.readTextFile(path)) as Record<
    string,
    { fetchedAt: string }
  >;
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("price://")) {
      v.fetchedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    }
  }
  await Deno.writeTextFile(path, JSON.stringify(raw));

  const stale = new SpecStore(path);
  await stale.load();
  assertEquals(stale.getPrice(url), null);
  assertEquals(stale.get(url), "spec text");
  await Deno.remove(path);
});

Deno.test("the price parses from markdown as well as page text", () => {
  // The unlocker returned markdown, where the fee link renders as
  // "₹19,474\n\n[+₹109 Protect Promise Fee](...)". The bracket broke the
  // pattern, so --refresh-prices fetched 15 pages and reported one change.
  const markdown = [
    "# Samsung Galaxy M17 5G (Moonlight Silver, 128 GB) (6 GB RAM)",
    "19%",
    "23,999",
    "₹19,474",
    "[+₹109 Protect Promise Fee](https://www.flipkart.com/pp-protect-promise-fee?pid=X)",
    "Buy at ₹18,500",
    "Fulfilled by SmartTechMart",
  ].join("\n\n");
  const c = parseCheckout(markdown);
  assertEquals(c.pagePrice, 19474);
  assertEquals(c.pageMrp, 23999);
  assertEquals(c.buyAt, 18500);
  assertEquals(c.seller, "SmartTechMart");
});

Deno.test("the page's own structured data is preferred to reading prose", () => {
  // Flipkart publishes application/ld+json with the price, the sku (which is
  // the pid, so a wrong-listing match is detectable), availability and the
  // seller. Reading that beats hunting rupee glyphs through prose, and it is
  // the same number the site shows.
  const html = `<html><head>
<script type="application/ld+json">${
    JSON.stringify({
      "@type": "Product",
      name: "Samsung Galaxy M17 5G (Moonlight Silver, 128 GB)",
      sku: "MOBHGU9DYEBQW6NW",
      offers: {
        price: 19474,
        priceCurrency: "INR",
        availability: "https://schema.org/InStock",
        seller: { name: "SmartTechMart" },
      },
    })
  }</script></head>
<body><div>19% 23,999 ₹19,474 +₹109 Protect Promise Fee</div></body></html>`;

  const c = parseCheckout(pageToText(html));
  assertEquals(c.pagePrice, 19474);
  assertEquals(c.pageMrp, 23999);
  assertEquals(c.seller, "SmartTechMart");
  assertEquals(c.inStock, true);
});

Deno.test("a sold-out listing is read from the structured data", () => {
  const html = `<html><head>
<script type="application/ld+json">${
    JSON.stringify({
      "@type": "Product",
      sku: "X",
      offers: { price: 9999, availability: "https://schema.org/OutOfStock" },
    })
  }</script></head><body></body></html>`;
  assertEquals(parseCheckout(pageToText(html)).inStock, false);
});

Deno.test("an unreadable page is not cached as if it were a price", async () => {
  // The previous run stored markdown no parser could read. For the next hour
  // the cache reported it "still fresh", so --refresh-prices refetched
  // nothing and the stale number survived a fix that had already shipped.
  const path = await Deno.makeTempFile({ suffix: ".json" });
  const store = new SpecStore(path);
  await store.load();
  const url = "https://www.flipkart.com/x/p/itm1?pid=P1";

  const unreadable = "19%\n\n23,999\n\n\u20b919,474\n\n[+";
  if (parseCheckout(unreadable).pagePrice === null) {
    // exactly the condition the caller now checks before writing
  } else {
    store.setPrice(url, unreadable, "unlocker");
  }
  await store.save();

  const reread = new SpecStore(path);
  await reread.load();
  assertEquals(reread.getPrice(url), null);
  await Deno.remove(path);
});

Deno.test("the price cache key carries a parser version", async () => {
  // A parser change must invalidate what an older parser wrote, otherwise a
  // fix cannot take effect until the entries age out.
  const path = await Deno.makeTempFile({ suffix: ".json" });
  const store = new SpecStore(path);
  await store.load();
  store.setPrice(
    "https://x/y?pid=P",
    "19% 23,999 ₹19,474 +₹109 Protect Promise Fee",
    "direct",
  );
  await store.save();
  const raw = JSON.parse(await Deno.readTextFile(path)) as Record<
    string,
    unknown
  >;
  assert(
    Object.keys(raw).some((k) => /^price:\/\/v\d+\//.test(k)),
    `no versioned price key: ${Object.keys(raw).join(", ")}`,
  );
  await Deno.remove(path);
});

Deno.test("the buy box wins over a sold-out seller's cheaper offer", () => {
  // Measured on the live M17 listing: the page carries an AggregateOffer
  // whose lowPrice is a seller that has sold out, while the buy box shows a
  // different seller at a higher price. Reading the aggregate reported
  // "₹12,951, out of stock, AwesomeOnline" and sank a phone that is in fact
  // on sale at ₹19,474 from SmartTechMart.
  const html = `<html><head>
<script type="application/ld+json">${
    JSON.stringify({
      "@type": "Product",
      sku: "MOBHGU9DYEBQW6NW",
      offers: {
        "@type": "AggregateOffer",
        lowPrice: 12951,
        highPrice: 19474,
        availability: "https://schema.org/OutOfStock",
        seller: { name: "AwesomeOnline" },
      },
    })
  }</script></head><body>
19% 23,999 ₹19,474 +₹109 Protect Promise Fee Buy at ₹18,500
Delivery by 25 Aug, Tue Fulfilled by SmartTechMart 4.7 See other sellers
</body></html>`;

  const c = parseCheckout(pageToText(html));
  assertEquals(c.pagePrice, 19474);
  assertEquals(c.pageMrp, 23999);
  assertEquals(c.seller, "SmartTechMart");
  assertEquals(c.inStock, true);
});

Deno.test("no buy box and a sold-out offer still reads as out of stock", () => {
  const html = `<html><head>
<script type="application/ld+json">${
    JSON.stringify({
      "@type": "Product",
      sku: "X",
      offers: {
        "@type": "Offer",
        price: 9999,
        availability: "https://schema.org/OutOfStock",
      },
    })
  }</script></head><body>Currently unavailable</body></html>`;
  assertEquals(parseCheckout(pageToText(html)).inStock, false);
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

Deno.test("ages read the way a person reads them", () => {
  const now = Date.parse("2026-08-22T01:45:00Z");
  assertEquals(ageLabel("2026-08-22T01:26:00Z", now), "19m");
  assertEquals(ageLabel("2026-08-20T22:45:00Z", now), "27h 00m");
  assertEquals(ageLabel("2026-08-19T21:45:00Z", now), "2d 4h");
  assertEquals(ageLabel("not a date", now), null);
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

Deno.test("the cache can say when a sample was taken", () => {
  const dir = Deno.makeTempDirSync();
  try {
    const store = new SpecStore(`${dir}/specs.json`);
    const url = "https://www.flipkart.com/x/p/itm1?pid=P1";
    store.setPrice(url, "28% 17,999 ₹12,951", "direct");
    assertExists(store.priceFetchedAt(url));
    assertEquals(store.priceFetchedAt("https://www.flipkart.com/y"), null);
    store.set(url, "spec text", "direct");
    assertExists(store.fetchedAt(url));
    assertEquals(store.fetchedAt("https://www.flipkart.com/z"), null);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("a refreshed price reports when we sampled it", async () => {
  // Real pages are big; the transport treats short bodies as blocks.
  const filler = "x".repeat(3000);
  const html =
    `<html><body>${filler} Samsung Galaxy M17 5G (Moonlight Silver, 128 GB) (6 GB RAM) 4.4 | 1,525 28% 17,999 ₹12,951 +₹109 Protect Promise Fee</body></html>`;
  const origFetch = globalThis.fetch;
  globalThis.fetch =
    (() =>
      Promise.resolve(new Response(html, { status: 200 }))) as typeof fetch;
  try {
    const raws = [{
      product_name:
        "Samsung Galaxy M17 5G (Moonlight Silver, 128 GB) (6 GB RAM)",
      selling_price: 12951,
      product_url:
        "https://www.flipkart.com/samsung-galaxy-m17-5g-moonlight-silver-128-gb/p/itmc3b8f7b511eca?pid=MOBHTEST1",
    }];
    const { listings } = normalizeBatch(raws, "flipkart");
    const candidates = groupListings(listings.map((l) => analyze(l)));
    const fresh = await refreshPrices(candidates, {
      limit: 1,
      mode: "direct",
      pace: 0,
    });
    assertEquals(fresh.fetched, 1);
    const seen = fresh.seen[0];
    assertExists(seen.sampledAt);
    const co = [...fresh.checkout.values()][0];
    assertExists(co?.sampledAt);

    const lines: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    reportRefreshDetail(fresh);
    console.error = origErr;
    assert(
      lines.join("\n").includes("sampled"),
      "the verbose report must carry the sample time",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("a price fetch drops the seller-specific listing id", () => {
  // pid identifies the phone and colour; lid identifies ONE SELLER's offer.
  // The search card links to the cheapest seller, who is often the one that
  // sells out - fetching with lid returned "₹12,951, AwesomeOnline" while the
  // buy box on the same product was ₹19,474 from SmartTechMart.
  const cardUrl =
    "https://www.flipkart.com/samsung-galaxy-m17-5g-moonlight-silver-128-gb/p/itmc3b8f7b511eca" +
    "?pid=MOBHGU9DYEBQW6NW&lid=LSTMOBHGU9DYEBQW6NWIWMUZV&marketplace=FLIPKART&q=phones+under+15000";
  const fetched = canonicalUrl(cardUrl);
  assert(fetched.includes("pid=MOBHGU9DYEBQW6NW"), fetched);
  assert(!fetched.includes("lid="), `lid survived: ${fetched}`);
  assert(!fetched.includes("marketplace="), fetched);
});

Deno.test("an in-stock offer outranks a cheaper sold-out one", () => {
  const raws = [
    {
      product_name: "POCO M7 5G (Ocean Blue, 128 GB) (6 GB RAM)",
      selling_price: 12499,
      product_url:
        "https://www.flipkart.com/poco-m7-5g-ocean-blue-128-gb/p/itm1?pid=P1",
      availability: "In stock",
    },
    {
      product_name: "POCO M7 5G (Ocean Blue, 128 GB) (6 GB RAM)",
      selling_price: 9999,
      product_url:
        "https://www.flipkart.com/poco-m7-5g-ocean-blue-128-gb/p/itm2?pid=P2",
      availability: "Out of stock",
    },
  ];
  const { listings } = normalizeBatch(raws, "flipkart");
  const [c] = groupListings(listings.map((l) => analyze(l)));
  assertEquals(c.best.price, 12499);
  assertEquals(c.best.inStock, true);
  assertEquals(c.offers[1].price, 9999); // kept, but demoted below buyable
});

Deno.test("structured data from another variant never becomes our price", () => {
  // Buy box missing, but the page's ld+json describes a different sku.
  const text =
    "Samsung Galaxy M17 5G specs and details | LD_SKU=MOBHOTHER999 | LD_PRICE=10499 | LD_STOCK=InStock";
  const guarded = parseCheckout(text, "MOBHGU9DYEBQW6NW");
  assertEquals(guarded.pagePrice, null); // not our variant, not our price
  assertEquals(guarded.inStock, null);

  // Same sku: the fallback may speak for this listing.
  const trusted = parseCheckout(
    text.replace("MOBHOTHER999", "MOBHGU9DYEBQW6NW"),
    "MOBHGU9DYEBQW6NW",
  );
  assertEquals(trusted.pagePrice, 10499);
  assertEquals(trusted.inStock, true);

  // No pid asked for (e.g. Amazon): behaviour unchanged.
  assertEquals(parseCheckout(text).pagePrice, 10499);
});

Deno.test("a price refresh refuses to spend a fetch on an unparseable platform", async () => {
  const raws = [
    {
      product_name: "Motorola G45 5G (Brilliant Green, 64 GB) (4 GB RAM)",
      selling_price: 10997,
      product_url: "https://www.amazon.in/dp/B0DGJ7M6XV",
    },
    {
      product_name: "POCO M7 5G (Ocean Blue, 128 GB) (6 GB RAM)",
      selling_price: 12499,
      product_url:
        "https://www.flipkart.com/poco-m7-5g-ocean-blue-128-gb/p/itm1?pid=MOBHTEST2",
    },
  ];
  let billedCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("flipkart")) {
      return Promise.resolve(
        new Response(
          "x".repeat(3000) + " 28% 17,999 ₹12,499 +₹109 Protect Promise Fee",
          { status: 200 },
        ),
      );
    }
    billedCalls++;
    throw new Error("no paid call may reach Amazon");
  }) as typeof fetch;
  try {
    const { listings } = normalizeBatch(raws, "flipkart" as never);
    void listings;
    const flipkartOnly = normalizeBatch([raws[1]], "flipkart").listings;
    const amazonOnly = normalizeBatch([raws[0]], "amazon").listings;
    const candidates = groupListings(
      [...flipkartOnly, ...amazonOnly].map((l) => analyze(l)),
    );
    const fresh = await refreshPrices(candidates, {
      limit: 5,
      mode: "direct",
      pace: 0,
    });
    assertEquals(fresh.skipped, 1);
    assertEquals(fresh.fetched, 1);
    assertEquals(billedCalls, 0);
    assert(
      fresh.seen.every((s) => s.product.includes("POCO")),
      "skipped products must not appear in the report",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("a refresh that reached nothing says so instead of going quiet", () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  reportRefresh({
    checkout: new Map(),
    fetched: 0,
    cached: 0,
    unpriced: 0,
    failed: 3,
    skipped: 0,
    changed: [],
    stockChanged: [],
    seen: [],
  });
  console.error = orig;
  const out = lines.join("\n");
  assert(
    out.includes("unreachable") && out.includes("keeps its card prices"),
    `silent failure: ${out}`,
  );
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

Deno.test("a sparkline maps the range onto eight levels", () => {
  assertEquals(sparkline([]), "");
  assertEquals(sparkline([5, 5, 5]), "▄▄▄"); // flat reads as steady
  assertEquals(sparkline([1, 9]), "▁█");
  assertEquals(sparkline([10, 1, 5]), "█▁▄");
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

Deno.test("a spec sheet with no one behind it cannot outrank a vetted phone", () => {
  const make = (
    name: string,
    url: string,
    rating: number | null,
    count: number | null,
  ) => ({
    product_name: name,
    selling_price: 8999,
    rating,
    review_count: count,
    product_url: url,
  });
  const raws = [
    // Identical claimed specs, identical price. Only trust differs.
    make(
      "Peace I17 AIR 5G (6GB+64GB) | Dimensity 7400 | pOLED 120Hz | 5000mAh",
      "https://www.amazon.in/dp/FAKE001",
      1,
      1,
    ),
    make(
      "Motorola G45 5G (6GB+128GB) | Dimensity 7300 | IPS 120Hz | 5000mAh",
      "https://www.amazon.in/dp/REAL01",
      4.3,
      217,
    ),
  ];
  const { listings } = normalizeBatch(raws, "amazon");
  const candidates = groupListings(listings.map((l) => analyze(l)));
  assertEquals(candidates.length, 2);
  const { ranked } = rankCandidates(candidates, {
    raw: "q",
    category: "phone",
    brands: [],
    excludeBrands: [],
    budgetMax: 15000,
    budgetMin: null,
    budgetOperator: "under",
    priorities: [],
    mustHave: [],
    modelHint: null,
  }, {});
  assertEquals(ranked[0].brand?.toLowerCase(), "motorola");
});
