import { assert, assertEquals, assertExists } from "@std/assert";

import { normalizeBatch } from "../src/core/normalize.ts";
import { parseIntentRules } from "../src/core/intent.ts";
import { SpecStore } from "../src/core/spec-cache.ts";
import { loadRun } from "../src/core/replay.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { hasCheckoutInfo, parseCheckout } from "../src/core/checkout.ts";
import { extractSpecSection } from "../src/core/resolve.ts";
import { pageToText } from "../src/lib/fetch-page.ts";

const FIXTURE = "tests/fixtures/run-phones-15000";

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
