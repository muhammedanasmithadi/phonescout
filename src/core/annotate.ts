import type { RankedCandidate, RankIntent } from "./types.ts";
import type { PriceHistoryEntry } from "./rank-types.ts";
import { INFLATED_MRP_PCT, median } from "./scoring/blend.ts";

export function formatCount(n: number): string {
  if (n >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function buildVerdict(
  r: RankedCandidate,
  intent: RankIntent,
  medPrice: number,
  leadsPerformance: boolean,
): string {
  const price = `₹${r.best.price.toLocaleString("en-IN")}`;
  const bits: string[] = [];
  // A ceiling query picked this phone for quality, not price. Calling the
  // best phone "the cheapest way into the segment" reads like an apology.
  const bargain = intent.priorities.includes("value");

  if (r.rank === 1) {
    bits.push(`Best overall pick at ${price}`);
  } else if (r.score.valueScore >= 80 && bargain) {
    bits.push(`Strong value at ${price}`);
  } else if (bargain && r.best.price < medPrice * 0.85) {
    bits.push(`Cheapest way into this segment at ${price}`);
  } else {
    bits.push(`Solid option at ${price}`);
  }

  const strengths: string[] = [];
  if (r.score.performance >= 65) strengths.push("performance");
  if (r.score.battery >= 75) strengths.push("battery");
  if (r.score.display >= 75) strengths.push("display");
  if (r.score.camera >= 75) strengths.push("camera");
  if (strengths.length) bits.push(`leads on ${strengths.join(" and ")}`);

  const weak: string[] = [];
  if (r.score.performance < 40 && !leadsPerformance) weak.push("raw speed");
  if (r.score.display < 45) weak.push("screen quality");
  if (r.score.battery < 45) weak.push("battery");
  if (weak.length) bits.push(`compromises on ${weak.join(" and ")}`);

  if (intent.priorities.includes("performance") && r.score.performance < 50) {
    bits.push("not ideal for gaming");
  }
  if (r.score.confidence < 0.5) bits.push("specs partly inferred");

  return `${bits.join("; ")}.`;
}

/**
 * Turns scores into sentences. Pros and cons are always comparative against
 * this result set's own medians, never absolute claims - a 5000mAh battery
 * is only a pro in a segment where that beats the median.
 */
export function annotate(
  ranked: RankedCandidate[],
  intent: RankIntent,
  priceHistory?: Map<string, PriceHistoryEntry>,
): void {
  if (ranked.length === 0) return;
  const anyMatch = ranked.some((r) => r.matchesRequestedModel);

  const med = {
    price: median(ranked.map((r) => r.best.price)) ?? 0,
    battery: median(
      ranked.map((r) => r.specs.batteryMah).filter((v): v is number =>
        v !== null
      ),
    ),
    antutu: median(
      ranked.map((r) => r.specs.antutu).filter((v): v is number => v !== null),
    ),
    ram: median(
      ranked.map((r) => r.specs.ramGb).filter((v): v is number => v !== null),
    ),
    storage: median(
      ranked.map((r) => r.specs.storageGb).filter((v): v is number =>
        v !== null
      ),
    ),
  };

  const badgesFromHistory = new Set<string>();
  const credible = ranked.filter((r) => r.score.confidence >= 0.5);
  const pool = credible.length >= 2 ? credible : ranked;

  const isVouchable = (r: RankedCandidate) =>
    r.best.inStock !== false &&
    r.score.confidence >= 0.6 &&
    r.specs.socName !== null &&
    (r.ratingCount ?? 0) >= 100 &&
    (r.rating ?? 0) >= 3.5;

  const vouchable = pool.filter(isVouchable);
  const recommendPool = vouchable.length >= 2 ? vouchable : pool;

  const cheapest = ranked.reduce((
    a,
    b,
  ) => (b.best.price < a.best.price ? b : a));
  const bestValue = recommendPool.reduce((
    a,
    b,
  ) => (b.score.valueScore > a.score.valueScore ? b : a));
  const fastest = pool.reduce((
    a,
    b,
  ) => (b.score.performance > a.score.performance ? b : a));
  const fastestIsClear = !pool.some((r) =>
    r !== fastest && r.score.performance >= fastest.score.performance - 0.5
  );
  const bestRated = pool
    .filter((r) => (r.ratingCount ?? 0) > 500)
    .reduce<RankedCandidate | null>(
      (a, b) => (a === null || b.score.trustScore > a.score.trustScore ? b : a),
      null,
    );
  const bestBattery = pool.reduce((
    a,
    b,
  ) => (b.score.battery > a.score.battery ? b : a));
  const batteryIsClear = !pool.some((r) =>
    r !== bestBattery && r.score.battery >= bestBattery.score.battery - 0.5
  );

  for (const r of ranked) {
    const pros: string[] = [];
    const cons: string[] = [];
    const s = r.specs;

    if (s.socName) {
      const tierWord = s.perfTier?.replace("-", " ") ?? "";
      if (med.antutu && s.antutu && s.antutu > med.antutu * 1.15) {
        pros.push(
          tierWord
            ? `${s.socName} — faster than most here (${tierWord})`
            : `${s.socName} — faster than most here`,
        );
      } else if (med.antutu && s.antutu && s.antutu < med.antutu * 0.8) {
        cons.push(`${s.socName} is slower than the segment median`);
      }
    } else {
      cons.push("chipset unknown — performance not verified");
    }

    if (s.panel && /oled/i.test(s.panel)) {
      pros.push(`${s.panel} panel`);
    } else if (s.panel) cons.push(`${s.panel} panel (no OLED)`);
    if (s.refreshHz && s.refreshHz >= 120) {
      pros.push(`${s.refreshHz}Hz display`);
    } else if (s.refreshHz && s.refreshHz <= 60) cons.push("60Hz display");
    if (s.resolution === "HD+") cons.push("HD+ resolution only");

    if (
      s.batteryMah && med.battery && s.batteryMah >= med.battery * 1.1
    ) {
      pros.push(`${s.batteryMah}mAh battery`);
    }
    if (s.chargingW && s.chargingW >= 33) {
      pros.push(`${s.chargingW}W charging`);
    } else if (s.chargingW && s.chargingW <= 15) {
      cons.push(`slow ${s.chargingW}W charging`);
    }

    if (s.ramGb && med.ram && s.ramGb > med.ram) {
      pros.push(`${s.ramGb}GB RAM`);
    }
    if (s.storageGb && med.storage && s.storageGb < med.storage) {
      cons.push(`only ${s.storageGb}GB storage`);
    }
    if (s.has5g === false) cons.push("4G only");
    if (s.ois) pros.push("OIS on main camera");
    if (s.ipRating) pros.push(`${s.ipRating} rated`);

    if (r.best.price < med.price * 0.85) {
      pros.push(
        `₹${
          Math.round(med.price - r.best.price).toLocaleString("en-IN")
        } below segment median`,
      );
    }
    if (r.offers.length > 1) {
      pros.push(
        `${r.offers.length} offers — cheapest on ${r.best.platformName}`,
      );
    }
    if (r.rating !== null && r.rating >= 4.2 && (r.ratingCount ?? 0) > 1000) {
      pros.push(`${r.rating}★ from ${formatCount(r.ratingCount!)} buyers`);
    }
    if (r.rating !== null && r.rating < 3.9) {
      cons.push(`weak ${r.rating}★ rating`);
    }
    if (r.unvouchable) {
      cons.unshift("no chipset found and almost no buyers — nothing to verify");
    }
    if ((r.ratingCount ?? 0) < 100) cons.push("very few reviews — unproven");
    if (r.best.inStock === false) {
      cons.unshift("out of stock in this colour/variant right now");
    }

    const hist = priceHistory?.get(r.key);
    if (hist && hist.runs >= 2) {
      if (r.best.price <= hist.min) {
        pros.unshift(
          hist.daysTracked >= 1
            ? `lowest price in ${hist.daysTracked} day(s) of tracking`
            : "lowest price we have recorded so far",
        );
        badgesFromHistory.add(r.key);
      } else if (hist.position >= 0.85) {
        cons.push(
          `near its recorded high of ₹${hist.max.toLocaleString("en-IN")}`,
        );
      }
      if (hist.trend === "falling") {
        cons.push("price is still trending down — worth waiting");
      }
    }
    if (r.best.discountPct !== null && r.best.discountPct > INFLATED_MRP_PCT) {
      cons.push(`${r.best.discountPct}% "discount" — inflated MRP likely`);
    }
    if (r.score.confidence < 0.5) {
      cons.push("limited spec data — verify before buying");
    }
    if (r.kbConfidence === "low") cons.push("spec sheet partly unverified");
    const qualifier = r.key.match(/#([a-z+-]+)\|/)?.[1];
    if (qualifier) {
      cons.unshift(
        qualifier === "carrier-locked"
          ? "carrier-locked SKU — cheaper but tied to one network"
          : `${
            qualifier.replace(/[+]/g, " + ")
          } unit, not a standard new device`,
      );
    }

    const badges: string[] = [];
    if (anyMatch && !r.matchesRequestedModel) badges.push("ALTERNATIVE");
    if (r === bestValue && isVouchable(r)) badges.push("BEST VALUE");
    if (r === cheapest) badges.push("CHEAPEST");
    if (
      r === fastest && fastestIsClear && (r.specs.antutu ?? 0) > 0 &&
      isVouchable(r)
    ) {
      badges.push("FASTEST");
    }
    if (
      r === bestBattery && batteryIsClear && (r.specs.batteryMah ?? 0) > 0
    ) {
      badges.push("BATTERY KING");
    }
    if (bestRated && r === bestRated) badges.push("BEST RATED");
    if (r.best.inStock === false) badges.unshift("OUT OF STOCK");
    if (badgesFromHistory.has(r.key)) badges.push("LOWEST YET");
    if (r.rank === 1) badges.unshift("TOP PICK");

    r.pros = pros.slice(0, 5);
    r.cons = cons.slice(0, 4);
    r.badges = badges;
    r.verdict = buildVerdict(r, intent, med.price, r === fastest);
  }
}
