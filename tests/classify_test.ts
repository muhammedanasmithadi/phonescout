import { assert, assertEquals } from "@std/assert";

import { categoryMatches, classify } from "../src/core/classify.ts";

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
