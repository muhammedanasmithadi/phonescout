import type { Candidate, RankIntent } from "../types.ts";
import type { PriceHistoryEntry } from "../rank-types.ts";
import { clamp } from "./curves.ts";

// ── Ceiling query blend ("best phone under X") ────────────────────────────
// The spec sheet leads, trust breaks ties between equals, deal only polishes.
export const CEILING_SPEC_WEIGHT = 0.6;
export const CEILING_TRUST_WEIGHT = 0.25;
export const CEILING_DEAL_WEIGHT = 0.15;

// ── Bargain query blend ("budget phones", "value for money") ──────────────
// Quality per rupee carries the largest single share of the score.
export const BARGAIN_VALUE_WEIGHT = 0.35;
export const BARGAIN_SPEC_WEIGHT = 0.3;
export const BARGAIN_TRUST_WEIGHT = 0.2;
export const BARGAIN_DEAL_WEIGHT = 0.15;

// A score computed from half-imputed specs must not present itself as a
// confident one. Total is damped toward FLOOR as confidence falls.
export const CONFIDENCE_DAMPING_FLOOR = 0.7;
export const CONFIDENCE_DAMPING_SPAN = 0.3;

// How much of a phone's spec sheet is measured vs filled from peers decides
// how loudly it may speak.
export const CONFIDENCE_IMPUTED_PENALTY = 60;
export const CONFIDENCE_COMPLETENESS_WEIGHT = 20;
export const CONFIDENCE_HAS_RATING_BONUS = 10;
const KB_CONFIDENCE_BONUS = { high: 10, medium: 6, low: 3 } as const;

function kbConfidenceBonus(c: Pick<Candidate, "kbConfidence">): number {
  switch (c.kbConfidence) {
    case "high":
      return KB_CONFIDENCE_BONUS.high;
    case "medium":
      return KB_CONFIDENCE_BONUS.medium;
    case "low":
      return KB_CONFIDENCE_BONUS.low;
    default:
      return 0;
  }
}

// Bayesian shrinkage prior: a rating needs volume before it means anything.
const TRUST_PRIOR_REVIEWS = 500;
const TRUST_NEUTRAL = 45;
// Value earns credibility only from measured specs, never from imputed ones.
const VALUE_EVIDENCE_FLOOR = 0.45;
const VALUE_EVIDENCE_SPAN = 0.55;

// Above this discount the offer is a story, not a price - the same threshold
// the table stars with an asterisk.
export const INFLATED_MRP_PCT = 55;
const CREDIBLE_DISCOUNT_CAP = 40;

/**
 * Intent decides what each spec component is worth. Priorities boost their
 * component before normalisation, so "camera phones" really do trade RAM
 * importance for lens importance.
 */
export function specWeights(intent: RankIntent): Record<string, number> {
  const base: Record<string, number> = {
    performance: 0.3,
    memory: 0.15,
    display: 0.18,
    battery: 0.17,
    camera: 0.12,
    extras: 0.08,
  };

  const boost: Record<string, string> = {
    performance: "performance",
    camera: "camera",
    battery: "battery",
    display: "display",
  };
  for (const p of intent.priorities) {
    const key = boost[p];
    if (key && base[key] !== undefined) base[key] += 0.15;
  }
  const total = Object.values(base).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(base)) base[k] /= total;
  return base;
}

export function trustScore(
  rating: number | null,
  count: number | null,
  priorMean: number,
): number | null {
  if (rating === null) return null;
  const v = count ?? 0;
  const blended = (v / (v + TRUST_PRIOR_REVIEWS)) * rating +
    (TRUST_PRIOR_REVIEWS / (v + TRUST_PRIOR_REVIEWS)) * priorMean;
  const base = clamp(((blended - 3.0) / 1.7) * 100);
  const evidence = clamp(
    0.35 + Math.log10(v + 1) / 5.5,
    0.35,
    1,
  );
  return clamp(TRUST_NEUTRAL + (base - TRUST_NEUTRAL) * evidence);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Specs nobody can vouch for are claims, not facts. A listing with real
 * buyer volume, or one the knowledge base independently confirms, gets
 * full credit; an anonymous sheet on a no-name card gets a fraction.
 * Without this, "Dimensity 7400 + pOLED for ₹8,499" from a 1-rating
 * seller outranks every honest phone in the table.
 */
export function corroboration(c: {
  ratingCount?: number | null;
  kbConfidence?: Candidate["kbConfidence"];
}): number {
  if ((c.ratingCount ?? 0) >= 5) return 1;
  switch (c.kbConfidence) {
    case "high":
      return 0.95;
    case "medium":
      return 0.85;
    case "low":
      return 0.75;
    default:
      return 0.6;
  }
}

function percentileRank(value: number, sorted: number[]): number {
  if (sorted.length <= 1) return 50;
  let below = 0;
  for (const v of sorted) if (v < value) below++;
  return (below / (sorted.length - 1)) * 100;
}

/** Spec-points-per-rupee percentile, discounted when specs were imputed. */
export function valueScore(
  ratio: number,
  sortedRatios: number[],
  imputedWeight: number,
): number {
  const evidence = 1 - imputedWeight;
  return clamp(
    percentileRank(ratio, sortedRatios) *
      (VALUE_EVIDENCE_FLOOR + VALUE_EVIDENCE_SPAN * evidence),
  );
}

export function computeConfidence(
  imputedWeight: number,
  c: Pick<Candidate, "specCompleteness" | "rating" | "kbConfidence">,
): number {
  return clamp(
    (1 - imputedWeight) * CONFIDENCE_IMPUTED_PENALTY +
      c.specCompleteness * CONFIDENCE_COMPLETENESS_WEIGHT +
      (c.rating !== null ? CONFIDENCE_HAS_RATING_BONUS : 0) +
      kbConfidenceBonus(c),
    0,
    100,
  ) / 100;
}

/**
 * Deal measures the offer, not the phone: honest discount, competition
 * between platforms, standing against the segment median, and recorded
 * price history. A fabricated discount must not buy ranking points.
 */
export function computeDealScore(
  c: Candidate,
  medPrice: number,
  hist?: PriceHistoryEntry,
): number {
  let deal = 50;
  const o = c.best;
  if (o.discountPct !== null && o.mrp) {
    const d = o.discountPct;
    if (d > INFLATED_MRP_PCT) {
      deal -= 6;
    } else {
      const credible = d <= CREDIBLE_DISCOUNT_CAP
        ? d
        : Math.max(0, CREDIBLE_DISCOUNT_CAP - (d - CREDIBLE_DISCOUNT_CAP) * 2);
      deal += credible * 0.6;
    }
  }
  if (c.offers.length > 1) {
    const spread = Math.max(...c.offers.map((x) => x.price)) - o.price;
    if (spread > 0) deal += Math.min(15, (spread / o.price) * 100);
    deal += 5;
  }
  if (medPrice && o.price < medPrice) deal += 5;

  if (hist && hist.runs >= 2) {
    if (o.price <= hist.min) deal += 20;
    else if (hist.position <= 0.15) deal += 12;
    else if (hist.position >= 0.85) deal -= 12;
    if (hist.trend === "falling") deal -= 4;
    else if (hist.trend === "rising") deal += 4;
  }
  return clamp(deal);
}

export function blendTotal(opts: {
  bargain: boolean;
  corroboratedSpec: number;
  trust: number | null;
  valueScore: number;
  dealScore: number;
}): number {
  const trust = opts.trust ?? TRUST_NEUTRAL;
  return opts.bargain
    ? opts.valueScore * BARGAIN_VALUE_WEIGHT +
      opts.corroboratedSpec * BARGAIN_SPEC_WEIGHT +
      trust * BARGAIN_TRUST_WEIGHT +
      opts.dealScore * BARGAIN_DEAL_WEIGHT
    : opts.corroboratedSpec * CEILING_SPEC_WEIGHT +
      trust * CEILING_TRUST_WEIGHT +
      opts.dealScore * CEILING_DEAL_WEIGHT;
}
