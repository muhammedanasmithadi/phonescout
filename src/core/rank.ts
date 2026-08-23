import type {
  Candidate,
  RankedCandidate,
  RankIntent,
  ScoreBreakdown,
} from "./types.ts";
import { gateCandidates, matchesModel } from "./gates.ts";
import {
  batteryScore,
  cameraScore,
  clamp,
  displayScore,
  extrasScore,
  memoryScore,
  perfScore,
} from "./scoring/curves.ts";
import {
  blendTotal,
  computeConfidence,
  computeDealScore,
  CONFIDENCE_DAMPING_FLOOR,
  CONFIDENCE_DAMPING_SPAN,
  corroboration,
  median,
  specWeights,
  trustScore,
  valueScore,
} from "./scoring/blend.ts";
import { annotate } from "./annotate.ts";
import type { RankOptions, RankOutcome } from "./rank-types.ts";

export { formatCount } from "./annotate.ts";
export { corroboration, specWeights } from "./scoring/blend.ts";
export type {
  PriceHistoryEntry,
  RankOptions,
  RankOutcome,
} from "./rank-types.ts";

/**
 * Ranks a filtered candidate list for one intent. The pipeline is:
 * gate (hard rules) → score components (curves) → blend (policy weights)
 * → order (availability before score) → annotate (sentences and badges).
 */
export function rankCandidates(
  candidates: Candidate[],
  intent: RankIntent,
  options: RankOptions = {},
): RankOutcome {
  const { survivors, rejected } = gateCandidates(candidates, intent, options);
  if (survivors.length === 0) return { ranked: [], rejected };

  const weights = specWeights(intent);
  const rawComponents: Array<Record<string, number | null>> = survivors.map((
    c,
  ): Record<string, number | null> => ({
    performance: perfScore(c.specs.antutu),
    memory: memoryScore(c.specs),
    display: displayScore(c.specs),
    battery: batteryScore(c.specs),
    camera: cameraScore(c.specs),
    extras: extrasScore(c.specs),
  }));

  const peerMedian: Record<string, number> = {};
  for (const key of Object.keys(weights)) {
    const vals = rawComponents
      .map((r) => (r as Record<string, number | null>)[key])
      .filter((v): v is number => v !== null);
    peerMedian[key] = (median(vals) ?? 50) * 0.9;
  }

  const ratings = survivors.map((c) => c.rating).filter((r): r is number =>
    r !== null
  );
  const priorMean = ratings.length
    ? ratings.reduce((a, b) => a + b, 0) / ratings.length
    : 4.0;

  const specScores = survivors.map((_c, i) => {
    const comp = rawComponents[i] as unknown as Record<string, number | null>;
    let total = 0;
    let imputedWeight = 0;
    for (const [key, w] of Object.entries(weights)) {
      if (w === 0) continue;
      const v = comp[key];
      if (v === null) {
        total += peerMedian[key] * w;
        imputedWeight += w;
      } else {
        total += v * w;
      }
    }
    return { total: clamp(total), imputedWeight, comp };
  });

  const ratios = survivors.map((c, i) =>
    specScores[i].total * corroboration(c) /
    (c.best.price / 1000)
  );
  const sortedRatios = [...ratios].sort((a, b) => a - b);

  const prices = survivors.map((c) => c.best.price);
  const medPrice = median(prices) ?? 0;

  // Two products share this ranker. A bargain query ("budget phones",
  // "value for money") wants the most quality per rupee, so cheapness
  // carries half the score. A ceiling query ("best under 50000") wants
  // the best phone the budget allows - there the spec sheet leads,
  // trust breaks ties between equals, and deal only polishes.
  const bargain = intent.priorities.includes("value");

  const ranked: RankedCandidate[] = survivors.map((c, i) => {
    const spec = specScores[i];
    const comp = spec.comp;

    const value = valueScore(ratios[i], sortedRatios, spec.imputedWeight);
    const trust = trustScore(c.rating, c.ratingCount, priorMean);
    const hist = options.priceHistory?.get(c.key);
    const deal = computeDealScore(c, medPrice, hist);

    const confidence = computeConfidence(spec.imputedWeight, c);
    const corroboratedSpec = spec.total * corroboration(c);
    const totalRaw = blendTotal({
      bargain,
      corroboratedSpec,
      trust,
      valueScore: value,
      dealScore: deal,
    });
    const total = clamp(
      totalRaw *
        (CONFIDENCE_DAMPING_FLOOR + CONFIDENCE_DAMPING_SPAN * confidence),
    );

    const pick = (k: string) => Math.round(comp[k] ?? peerMedian[k] ?? 45);
    const score: ScoreBreakdown = {
      performance: pick("performance"),
      display: pick("display"),
      battery: pick("battery"),
      camera: pick("camera"),
      memory: pick("memory"),
      extras: pick("extras"),
      specScore: Math.round(spec.total),
      valueScore: Math.round(value),
      trustScore: Math.round(trust ?? 45),
      dealScore: Math.round(deal),
      total: Math.round(total * 10) / 10,
      confidence: Math.round(confidence * 100) / 100,
    };

    return {
      ...c,
      rank: 0,
      matchesRequestedModel: matchesModel(
        intent.modelHint,
        intent.brands,
        c.modelName,
        c.key,
      ),
      score,
      pros: [],
      cons: [],
      verdict: "",
      badges: [],
    };
  });

  const anyExactMatch = ranked.some((r) => r.matchesRequestedModel);
  // Anything you cannot buy sorts below everything you can. A replay put an
  // out-of-stock Galaxy M17 at #1 wearing TOP PICK, which is not a
  // recommendation — it is a phone the reader cannot act on. It stays in the
  // table, badged, because the price is still useful context; it just cannot
  // lead. Applied before score so no amount of value outranks availability.
  const unbuyable = (r: RankedCandidate) => Number(r.best.inStock === false);
  // Nothing to go on: no chipset read from anywhere, and too few buyers for
  // the rating to mean anything. A 1-star phone with one review and "SoC ?"
  // was reaching the top ten on a fabricated discount. Scored down rather
  // than sorted into a hidden tier, so the table stays ordered by the number
  // it displays and the reason shows up in the row.
  for (const r of ranked) {
    r.unvouchable = !r.specs.socName && (r.ratingCount ?? 0) < 20;
    if (r.unvouchable) r.score.total = clamp(r.score.total * 0.7);
  }
  ranked.sort((a, b) =>
    (anyExactMatch
      ? Number(b.matchesRequestedModel) - Number(a.matchesRequestedModel)
      : 0) ||
    unbuyable(a) - unbuyable(b) ||
    b.score.total - a.score.total ||
    b.score.confidence - a.score.confidence ||
    a.best.price - b.best.price
  );
  // One row per phone. Three storage variants of the same handset filling
  // three of the top five is a list of configs, not a recommendation - and
  // every row already carries its siblings under "Other configs".
  const bestOfModel = new Map<string, RankedCandidate>();
  for (const r of ranked) {
    const model = r.key.split("|")[0];
    const seen = bestOfModel.get(model);
    if (seen) r.variantOf = seen.modelName;
    else bestOfModel.set(model, r);
  }

  ranked.forEach((r, i) => (r.rank = i + 1));

  annotate(ranked, intent, options.priceHistory);
  return { ranked, rejected };
}
