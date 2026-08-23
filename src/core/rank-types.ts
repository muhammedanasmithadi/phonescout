import type { Candidate, RankedCandidate } from "./types.ts";

export interface PriceHistoryEntry {
  min: number;
  max: number;
  position: number;
  trend: "falling" | "rising" | "stable";
  observations: number;
  runs: number;
  daysTracked: number;
}

export interface RankOptions {
  priceHistory?: Map<string, PriceHistoryEntry>;
  inStockOnly?: boolean;
  excludeSponsored?: boolean;
  budgetTolerance?: number;
}

export interface RankOutcome {
  ranked: RankedCandidate[];
  rejected: Array<{ candidate: Candidate; reasons: string[] }>;
}
