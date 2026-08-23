import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import { reviewsUrlFor, summariseReviews } from "../src/core/reviews.ts";

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
