import { assert, assertEquals } from "@std/assert";

import { normalizeBatch } from "../src/core/normalize.ts";
import { analyze } from "../src/core/extract.ts";
import { groupListings } from "../src/core/group.ts";

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
