import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";

import { normalizeBatch } from "../src/core/normalize.ts";
import { analyze } from "../src/core/extract.ts";
import {
  beebomSlugs,
  nameMatches,
  parseBeebomPage,
} from "../src/knowledge/beebom.ts";
import { toSpecs } from "../src/core/resolve.ts";
import {
  matchSoc,
  matchSocDetailed,
  matchSocExact,
  SOCS,
} from "../src/knowledge/soc.ts";
import { lookupModel, PHONE_MODELS } from "../src/knowledge/models.ts";
import {
  fetchSpecs as fetchExternalSpecs,
  normaliseModel,
  parseSpecPage,
  RateLimited,
  resolveModel,
} from "../src/knowledge/gsmarena.ts";

Deno.test("SoC lookup resolves aliases and ignores near-misses", () => {
  assertEquals(
    matchSoc("Snapdragon 4s Gen 2 processor")?.name,
    "Snapdragon 4s Gen 2",
  );
  assertEquals(matchSoc("MediaTek Dimensity 7025")?.name, "Dimensity 7025");
  assertEquals(matchSoc("Helio G99 Ultra")?.name, "Helio G99");
  assertEquals(matchSoc("no chipset mentioned here"), null);
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
