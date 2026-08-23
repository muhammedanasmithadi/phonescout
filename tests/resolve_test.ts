import { assert, assertEquals, assertExists } from "@std/assert";

import { normalizeBatch } from "../src/core/normalize.ts";
import { analyze } from "../src/core/extract.ts";
import { groupListings } from "../src/core/group.ts";
import {
  refreshPrices,
  reportRefresh,
  reportRefreshDetail,
} from "../src/core/resolve.ts";
import { ageLabel, SpecStore } from "../src/core/spec-cache.ts";
import { specRichness } from "../src/core/resolve.ts";

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

Deno.test("ages read the way a person reads them", () => {
  const now = Date.parse("2026-08-22T01:45:00Z");
  assertEquals(ageLabel("2026-08-22T01:26:00Z", now), "19m");
  assertEquals(ageLabel("2026-08-20T22:45:00Z", now), "27h 00m");
  assertEquals(ageLabel("2026-08-19T21:45:00Z", now), "2d 4h");
  assertEquals(ageLabel("not a date", now), null);
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
