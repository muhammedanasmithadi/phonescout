import { assert, assertEquals } from "@std/assert";

import {
  deriveModelKey,
  detectQualifiers,
  specsFromText,
} from "../src/core/extract.ts";

Deno.test("carrier-locked SKUs stay separate from the unlocked phone", () => {
  const locked = deriveModelKey(
    "POCO M7 5G - Locked with Airtel Prepaid (Mint Green, 128 GB)",
  );
  const unlocked = deriveModelKey("POCO M7 5G (Mint Green, 128 GB) (6 GB RAM)");
  assert(locked !== unlocked);
  assert(locked.includes("#carrier-locked"));
  assertEquals(detectQualifiers("Refurbished iPhone 13"), ["refurbished"]);
});

Deno.test("specs are parsed out of a standard listing title", () => {
  const { specs } = specsFromText("POCO M7 5G (Ocean Blue, 128 GB) (8 GB RAM)");
  assertEquals(specs.ramGb, 8);
  assertEquals(specs.storageGb, 128);
  assertEquals(specs.has5g, true);
  assertEquals(specs.colour, "Ocean Blue");
});

Deno.test("the camera array is read: telephoto, ultrawide and aperture", () => {
  const rich = specsFromText(
    "MOTOROLA Edge 70 Pro 5G (8 GB RAM) (256 GB) 50 MP + 50MP ultrawide +" +
      " 10 MP telephoto periscope 3x optical, f/1.5 aperture",
  ).specs;
  assertEquals(rich.mainCameraMp, 50);
  assertEquals(rich.ultraWideMp, 50);
  assertEquals(rich.teleMp, 10);
  assertEquals(rich.aperture, 1.5);

  const plain = specsFromText(
    "Ai+ Nova 2 Ultra 5G (6 GB RAM) (128 GB) 50 MP OIS camera",
  ).specs;
  assertEquals(plain.mainCameraMp, 50);
  // specsFromText only reports what it read; unset lenses are absent.
  assertEquals(plain.ultraWideMp ?? null, null);
  assertEquals(plain.teleMp ?? null, null);
  assertEquals(plain.aperture ?? null, null);
});

Deno.test("Amazon: a stated AnTuTu score in the title is used", () => {
  const { specs } = specsFromText(
    "Samsung Galaxy M06 5G Mobile (Sage Green, 4GB RAM, 128GB Storage) | MediaTek Dimensity 6300 | AnTuTu 623K+ | 25W Fast Charging",
  );
  assertEquals(specs.antutu, 623000);
  assertEquals(specs.chargingW, 25);
});

Deno.test("the same phone groups across Flipkart and Amazon title styles", () => {
  const pairs: Array<[string, string]> = [
    [
      "POCO M7 5G (Ocean Blue, 128 GB) (6 GB RAM)",
      "POCO M7 5G Smartphone (Ocean Blue, 6GB RAM, 128GB Storage) | Snapdragon 4s Gen 2",
    ],
    [
      "Samsung Galaxy M06 5G (Sage Green, 128 GB) (4 GB RAM)",
      "Samsung Galaxy M06 5G Mobile (Sage Green, 4GB RAM, 128GB Storage) | MediaTek Dimensity 6300 | AnTuTu 623K+",
    ],
    [
      "realme narzo 100 Lite 5G (Thunder Black, 64 GB) (4 GB RAM)",
      "realme narzo 100 Lite 5G (Thunder Black,4GB+64GB) | 7000mAh Titan Battery",
    ],
    [
      "iQOO Z10 Lite 5G (Cyber Green, 64 GB) (4 GB RAM)",
      "iQOO Z10 Lite 5G (Cyber Green 2026, 4GB RAM, 64GB Storage) | Dimensity 6300",
    ],
  ];
  for (const [flipkart, amazon] of pairs) {
    assertEquals(deriveModelKey(amazon), deriveModelKey(flipkart), flipkart);
  }
});

Deno.test("model numbers inside parens survive the model key", () => {
  // "(4a)" is a model number, not a config: dropping it collapsed every
  // Nothing Phone into one phantom key and split real variants apart.
  assertEquals(
    deriveModelKey("Nothing Phone (4a) (Blue, 256 GB) (12 GB RAM)"),
    "nothing 4a",
  );
  assertEquals(
    deriveModelKey("Nothing Phone (4a) Pro (Silver, 128 GB) (8 GB RAM)"),
    "nothing pro 4a",
  );
  // Colour/config parens still strip; ordinary keys are unchanged.
  assertEquals(
    deriveModelKey("Samsung Galaxy M17 5G (Sapphire Black, 128 GB) (6 GB RAM)"),
    "samsung galaxy m17 5g",
  );
});

Deno.test("REGRESSION: impossible specs are rejected, not recorded", () => {
  const contaminated =
    "Nokia 150 Keypad Phone | 2.4 inch display | 1000 mAh | Similar products " +
    "20000 mAh Power Bank 8GB 128GB 50MP OIS 120Hz 5G";
  const { specs } = specsFromText(contaminated);
  assertEquals(specs.batteryMah, undefined, "20000 mAh is a power bank");
  assertEquals(
    specs.displayInches,
    undefined,
    "2.4in is not a smartphone panel",
  );
  assertEquals(
    specs.refreshHz,
    undefined,
    "dropped along with the tiny screen",
  );
  assertEquals(specs.has5g, undefined);
  assertEquals(specs.ois, undefined);

  const real = specsFromText(
    "POCO M7 Pro 5G (Olive Twilight, 128 GB) (6 GB RAM) | 6.67 inch AMOLED 120Hz | 5110 mAh | 45W | 50MP OIS | 5G",
  ).specs;
  assertEquals(real.batteryMah, 5110);
  assertEquals(real.refreshHz, 120);
  assertEquals(real.displayInches, 6.67);
  assertEquals(real.has5g, true);
});

Deno.test("implausible refresh rates are dropped rather than believed", () => {
  assertEquals(
    specsFromText("6.7 inch display 240Hz touch sampling").specs.refreshHz,
    undefined,
  );
  assertEquals(
    specsFromText("6.7 inch 120Hz AMOLED display").specs.refreshHz,
    120,
  );
});

Deno.test("panel and charging must be described, not merely mentioned", () => {
  const contaminated =
    "Galaxy F07 6.7 inch HD+ PLS LCD display 90Hz refresh rate. " +
    "5000 mAh battery with 25 W charging. " +
    "Similar products: Galaxy M36 AMOLED 120Hz, realme P4 70W fast charging";
  const a = specsFromText(contaminated);
  assertEquals(a.specs.panel, "PLS LCD");
  assertEquals(a.specs.chargingW, 25);
});

Deno.test("a genuine AMOLED is still read", () => {
  const a = specsFromText(
    "6.65 inch FHD+ Super AMOLED display, 90Hz, 5000mAh, 25W charging",
  );
  assertEquals(a.specs.panel, "AMOLED");
  assertEquals(a.specs.chargingW, 25);
});
