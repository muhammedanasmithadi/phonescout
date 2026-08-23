import { assert, assertEquals, assertExists } from "@std/assert";

import {
  normalizeBatch,
  parseMoney,
  titleFromUrl,
} from "../src/core/normalize.ts";
import { analyze } from "../src/core/extract.ts";
import { buildCandidates } from "../src/core/pipeline.ts";
import { canonicalUrl } from "../src/core/normalize.ts";

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
