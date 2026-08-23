import { categoryMatches } from "./classify.ts";
import type { Candidate, RankIntent } from "./types.ts";
import type { RankOptions } from "./rank-types.ts";

function modelToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A model hint like "galaxy s24" must name a real model number before it
 * may demote every other row; short digit-less hints ("phone") would
 * otherwise match everything.
 */
export function matchesModel(
  hint: string | null,
  brands: string[],
  name: string,
  key: string,
): boolean {
  if (!hint) return false;
  const h = modelToken(hint);
  if (h.length < 2 || !/\d/.test(h)) return false;
  const hay = modelToken(`${name} ${key}`);
  if (!hay.includes(h)) return false;
  if (h.length <= 3 && brands.length > 0) {
    return brands.some((b) => hay.includes(modelToken(b)));
  }
  return true;
}

/**
 * Hard gates run before any scoring. A candidate either clears them all or
 * is rejected with the reasons a reader would need to accept the omission:
 * wrong category, no usable price, outside budget, brand not requested,
 * missing a must-have feature, or unavailable stock.
 */
export function gateCandidates(
  candidates: Candidate[],
  intent: RankIntent,
  options: Pick<RankOptions, "inStockOnly" | "budgetTolerance"> = {},
): {
  survivors: Candidate[];
  rejected: Array<{ candidate: Candidate; reasons: string[] }>;
} {
  const tolerance = options.budgetTolerance ?? 0;
  const rejected: Array<{ candidate: Candidate; reasons: string[] }> = [];
  const survivors: Candidate[] = [];

  for (const c of candidates) {
    const reasons: string[] = [];

    if (!categoryMatches(intent.category, c.category)) {
      reasons.push(`category: ${c.category} ≠ ${intent.category}`);
    }
    if (c.category === "accessory") reasons.push("accessory, not a product");

    const price = c.best.price;
    if (!price || price <= 0) reasons.push("no usable price");

    if (price && intent.budgetMax) {
      const ceiling = intent.budgetMax * (1 + tolerance);
      if (price > ceiling) {
        reasons.push(
          `₹${price.toLocaleString("en-IN")} over budget ₹${
            intent.budgetMax.toLocaleString("en-IN")
          }`,
        );
      }
    }
    if (price && intent.budgetMin && price < intent.budgetMin) {
      reasons.push(`₹${price.toLocaleString("en-IN")} below asked range`);
    }

    if (intent.brands.length && c.brand && !intent.brands.includes(c.brand)) {
      reasons.push(`brand ${c.brand} not requested`);
    }
    if (
      intent.excludeBrands.length && c.brand &&
      intent.excludeBrands.includes(c.brand)
    ) {
      reasons.push(`brand ${c.brand} excluded`);
    }

    for (const must of intent.mustHave) {
      if (must === "5g" && c.specs.has5g === false) reasons.push("not 5G");
      if (must === "amoled" && c.specs.panel && !/oled/i.test(c.specs.panel)) {
        reasons.push("not AMOLED");
      }
      if (must === "nfc" && c.specs.nfc === false) reasons.push("no NFC");
      if (must === "ois" && c.specs.ois === false) {
        reasons.push("no stabilisation on the main camera");
      }
    }

    if (options.inStockOnly && c.offers.every((o) => o.inStock === false)) {
      reasons.push("out of stock everywhere");
    }

    if (reasons.length) rejected.push({ candidate: c, reasons });
    else survivors.push(c);
  }

  return { survivors, rejected };
}
