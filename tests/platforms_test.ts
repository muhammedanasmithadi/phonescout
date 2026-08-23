import { assert, assertEquals } from "@std/assert";

import { specsFromText } from "../src/core/extract.ts";
import { parseIntentRules } from "../src/core/intent.ts";
import { ALL_ENABLED, PLATFORMS } from "../src/config.ts";
import { buildUrls, searchTerm } from "../src/core/collect.ts";
import {
  htmlToText,
  jsonStateText,
  pageToText,
} from "../src/lib/fetch-page.ts";

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
