import { assert, assertEquals } from "@std/assert";

import { normalizeBatch } from "../src/core/normalize.ts";
import { analyze } from "../src/core/extract.ts";
import { groupListings } from "../src/core/group.ts";
import { rankCandidates } from "../src/core/rank.ts";
import { parseIntentRules } from "../src/core/intent.ts";

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
