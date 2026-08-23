import { assert, assertEquals } from "@std/assert";

import { normalizeBatch } from "../src/core/normalize.ts";
import { analyze } from "../src/core/extract.ts";
import { groupListings } from "../src/core/group.ts";
import { rankCandidates } from "../src/core/rank.ts";
import { parseIntentRules } from "../src/core/intent.ts";
import type { Candidate } from "../src/core/types.ts";
import { attachCheckout } from "../src/core/pipeline.ts";

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
