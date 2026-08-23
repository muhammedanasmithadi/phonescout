import { colors } from "@cliffy/ansi/colors";
import { fetchDirect, fetchPageHtml, pageToText } from "../lib/fetch-page.ts";
import { isoNow } from "./clock.ts";
import {
  type CheckoutInfo,
  hasCheckoutInfo,
  parseCheckout,
} from "./checkout.ts";
import { SpecStore } from "./spec-cache.ts";
import { canonicalUrl } from "./normalize.ts";
import {
  type ReviewSummary,
  reviewsUrlFor,
  summariseReviews,
} from "./reviews.ts";
import { matchSocDetailed, matchSocExact } from "../knowledge/soc.ts";
import {
  fetchSpecs as fetchExternalSpecs,
  loadIndex,
  RateLimited,
  resolveModel,
} from "../knowledge/gsmarena.ts";
import { fetchBeebom, type MarketPrice } from "../knowledge/beebom.ts";
import type { ExternalSpecs } from "../knowledge/spec-source.ts";
import type { Candidate, Specs } from "./types.ts";
import {
  extractSpecSection,
  type FetchMode,
  fetchPage,
  pidOf,
  sleep,
  specRichness,
  type Transport,
} from "./page-text.ts";
import {
  conflictsAgainstKb,
  detectConflicts,
  type SpecConflict,
} from "./spec-conflicts.ts";

export interface ResolveOptions {
  mode?: FetchMode;
  withReviews?: boolean;
  pace?: number;
  useExternal?: boolean;
  limit?: number;
  concurrency?: number;
  allowPaid?: boolean;
  /** Cap on paid re-fetches of spec-poor Flipkart pages per run. */
  maxSpecRescues?: number;
  store?: SpecStore;
  transport?: Transport;
  verbose?: boolean;
}

export interface ResolveResult {
  text: Map<string, string>;
  checkout: Map<string, CheckoutInfo>;
  external: Map<string, Partial<Specs>>;
  reviews: Map<string, ReviewSummary>;
  reviewsFetched: number;
  gsmMatched: number;
  gsmUnmatched: number;
  beebomMatched: number;
  marketPrices: Map<string, MarketPrice>;
  gsmRateLimited: boolean;
  fromCache: number;
  fetchedDirect: number;
  fetchedPaid: number;
  failed: number;
  skippedComplete: number;
  skippedPaid: number;
  conflicts: SpecConflict[];
  errors: string[];
}

export function toSpecs(g: ExternalSpecs): Partial<Specs> {
  const out: Partial<Specs> = {};
  const set = <K extends keyof Specs>(k: K, v: Specs[K] | null) => {
    if (v !== null && v !== undefined) out[k] = v;
  };
  if (g.socName) {
    const exact = matchSocExact(g.socName);
    const soc = exact ? { soc: exact } : matchSocDetailed(g.socName);
    set("socName", soc ? soc.soc.name : g.socName);
    set("antutu", soc?.soc.antutu ?? g.antutu ?? null);
  }
  set("batteryMah", g.batteryMah);
  set("chargingW", g.chargingW);
  set("panel", g.panel);
  set("displayInches", g.inches);
  set("refreshHz", g.refreshHz);
  set("resolution", g.resolution);
  set("mainCameraMp", g.mainCameraMp);
  set("ipRating", g.ipRating);
  set("nfc", g.nfc);
  if (g.ois) set("ois", true);
  return out;
}

function isFullySpecced(c: Candidate): boolean {
  return c.specCompleteness >= 0.95 && c.kbConfidence === "high" &&
    c.checkout !== undefined;
}

export async function resolveSpecs(
  candidates: Candidate[],
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const mode = opts.mode ?? "auto";
  const allowPaid = opts.allowPaid ?? false;
  const t = opts.transport;
  const store = opts.store ?? new SpecStore();
  await store.load();

  const result: ResolveResult = {
    text: new Map(),
    checkout: new Map(),
    external: new Map(),
    reviews: new Map(),
    reviewsFetched: 0,
    gsmMatched: 0,
    beebomMatched: 0,
    marketPrices: new Map(),
    gsmUnmatched: 0,
    gsmRateLimited: false,
    fromCache: 0,
    fetchedDirect: 0,
    fetchedPaid: 0,
    failed: 0,
    skippedComplete: 0,
    skippedPaid: 0,
    conflicts: [],
    errors: [],
  };

  const queue = candidates
    .filter((c) => {
      if (isFullySpecced(c)) {
        result.skippedComplete++;
        return false;
      }
      return Boolean(c.best.url);
    })
    .sort((a, b) => a.specCompleteness - b.specCompleteness);

  let budget = opts.limit ?? Number.POSITIVE_INFINITY;

  const apply = (c: Candidate, text: string, sourceUrl: string) => {
    const section = extractSpecSection(text);
    for (const l of c.listings) result.text.set(l.id, section);
    const checkout = parseCheckout(text, pidOf(sourceUrl));
    if (hasCheckoutInfo(checkout)) {
      // A cached page was fetched some time ago; say when.
      checkout.sampledAt = store.fetchedAt(sourceUrl) ?? isoNow();
      const want = canonicalUrl(sourceUrl);
      const from = c.listings.find((l) => canonicalUrl(l.url) === want) ??
        c.listings[0];
      result.checkout.set(from.id, checkout);
    }
    result.conflicts.push(...detectConflicts(c, section));
  };

  if (opts.useExternal !== false) {
    const index = await loadIndex();
    if (index.length > 0) {
      let fetchedThisRun = 0;
      for (const c of candidates) {
        const lookupName = c.key.split("|")[0].split("#")[0].trim();
        const hit = resolveModel(lookupName, c.brand, index);
        if (!hit) {
          result.gsmUnmatched++;
          continue;
        }
        try {
          const cacheKey = `gsm://${hit.slug}`;
          let g: ExternalSpecs | null = null;

          const cached = store.get(cacheKey);
          if (cached) {
            g = JSON.parse(cached) as ExternalSpecs;
          } else if (mode === "cache") {
            // Cache mode is offline by contract: a model the store never
            // saw stays on knowledge-base data instead of reaching out.
            result.gsmUnmatched++;
            continue;
          } else {
            if (fetchedThisRun > 0) await sleep(opts.pace ?? 1100);
            let via: "direct" | "unlocker" = "direct";
            g = await fetchExternalSpecs(hit, lookupName, async (u) => {
              try {
                return await fetchDirect(u, 15000);
              } catch (err) {
                if (!allowPaid) throw err;
                via = "unlocker";
                result.fetchedPaid++;
                return await fetchPageHtml(u);
              }
            });
            fetchedThisRun++;
            if (g) store.set(cacheKey, JSON.stringify(g), via);
          }

          if (!g) {
            result.gsmUnmatched++;
            continue;
          }
          const partial = toSpecs(g);
          for (const l of c.listings) result.external.set(l.id, partial);
          result.gsmMatched++;
          result.conflicts.push(...conflictsAgainstKb(c, g));
        } catch (err) {
          if (err instanceof RateLimited) {
            result.gsmRateLimited = true;
            break;
          }
          result.gsmUnmatched++;
        }
      }
    }
  }

  if (opts.useExternal !== false) {
    let fetchedThisRun = 0;
    for (const c of candidates) {
      if (c.listings.some((l) => result.external.has(l.id))) continue;
      if (c.specs.socName && c.specSources.socName === "gsmarena") continue;

      const lookupName = c.key.split("|")[0].split("#")[0].trim();
      const cacheKey = `beebom://${lookupName.toLowerCase()}`;
      try {
        let b: ExternalSpecs | null = null;
        const cached = store.get(cacheKey);
        if (cached) {
          b = JSON.parse(cached) as ExternalSpecs;
          const cm = store.get(`${cacheKey}#market`);
          if (cm) {
            const mp = JSON.parse(cm) as MarketPrice;
            for (const l of c.listings) result.marketPrices.set(l.id, mp);
          }
        } else if (mode === "cache") {
          // Cache mode is offline by contract; skip live lookups.
          continue;
        } else {
          if (fetchedThisRun > 0) await sleep(opts.pace ?? 1100);
          const got = await fetchBeebom(lookupName, c.brand ?? undefined);
          b = got.specs;
          if (got.market) {
            for (const l of c.listings) {
              result.marketPrices.set(l.id, got.market);
            }
            store.set(
              `${cacheKey}#market`,
              JSON.stringify(got.market),
              "direct",
            );
          }
          fetchedThisRun++;
          if (b) store.set(cacheKey, JSON.stringify(b), "direct");
        }
        if (!b) continue;

        const partial = toSpecs(b);
        const kbDisagrees = c.kbConfidence === "high" &&
          c.specSources.socName === "kb" && c.specs.socName &&
          partial.socName &&
          partial.socName !== c.specs.socName;
        if (kbDisagrees) {
          delete partial.socName;
          delete partial.antutu;
        }
        for (const l of c.listings) result.external.set(l.id, partial);
        result.beebomMatched++;
        result.conflicts.push(...conflictsAgainstKb(c, b));
      } catch {
        // ignored
      }
    }
  }

  const needsFetch: Candidate[] = [];
  for (const c of queue) {
    // Same rule as the price refresh: fetch the product, not one seller's
    // listing. The card URL carries lid; the canonical URL does not.
    const url = canonicalUrl(c.best.url);
    const cached = store.get(url);
    if (cached) {
      apply(c, cached, url);
      result.fromCache++;
    } else {
      needsFetch.push(c);
    }
  }

  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const pending = mode === "cache" ? [] : [...needsFetch];
  let rescuesLeft = Math.max(0, opts.maxSpecRescues ?? 12);

  const worker = async () => {
    while (pending.length) {
      if (budget <= 0) return;
      const c = pending.shift();
      if (!c) return;
      budget--;
      const url = canonicalUrl(c.best.url);
      try {
        let { text, via } = await fetchPage(url, mode, allowPaid, t);
        // Flipkart serves its spec table through lazy loading, so a plain
        // fetch yields chipset for one phone in ten. When the section came
        // back spec-poor and paid fetching is on, pay once for the rendered
        // DOM and keep whichever read is richer. The winner is cached for
        // 30 days, so each phone costs at most one extra request ever.
        if (
          /flipkart\.com/.test(url) && via === "direct" && allowPaid &&
          rescuesLeft > 0 && specRichness(extractSpecSection(text)) < 2
        ) {
          rescuesLeft--;
          try {
            const rendered = await fetchPage(url, "unlocker", true, t);
            if (
              specRichness(extractSpecSection(rendered.text)) >
                specRichness(extractSpecSection(text))
            ) {
              text = rendered.text;
              via = "unlocker";
            }
          } catch {
            // The direct text stands; nothing to report.
          }
        }
        apply(c, text, url);
        store.set(url, extractSpecSection(text), via);
        if (via === "direct") result.fetchedDirect++;
        else result.fetchedPaid++;
        if (opts.verbose) {
          console.error(colors.dim(`    ${via}: ${c.modelName}`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no transport|unlocker/.test(msg) && !allowPaid) {
          result.skippedPaid++;
        }
        result.failed++;
        if (result.errors.length < 3) {
          result.errors.push(`${c.modelName}: ${msg}`);
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, worker),
  );

  const reviewMode: FetchMode = opts.mode ?? "auto";
  if (opts.withReviews !== false && reviewMode !== "unlocker") {
    for (const c of candidates) {
      const url = reviewsUrlFor(canonicalUrl(c.best.url));
      if (!url) continue;
      try {
        const key = `reviews://${url}`;
        let text = store.get(key);
        if (!text) {
          if (reviewMode === "cache") continue;
          text = pageToText(await fetchDirect(url, 15000));
          store.set(key, text.slice(0, 24_000), "direct");
          result.reviewsFetched++;
          await sleep(250);
        }
        const summary = summariseReviews(text);
        if (summary.sampled > 0 || summary.distribution) {
          for (const l of c.listings) result.reviews.set(l.id, summary);
        }
      } catch {
        // ignored
      }
    }
  }

  // Cache mode still serves what it already holds - reviews included -
  // it just never reaches for the network.
  if (mode === "cache") {
    await store.save();
    return result;
  }

  await store.save();
  return result;
}

export function reportResolution(r: ResolveResult): void {
  const parts: string[] = [];
  if (r.gsmMatched) parts.push(`${r.gsmMatched} from spec database`);
  if (r.gsmRateLimited) parts.push("spec DB throttled");
  if (r.beebomMatched) parts.push(`${r.beebomMatched} from secondary source`);
  if (r.fromCache) parts.push(`${r.fromCache} cached`);
  if (r.fetchedDirect) parts.push(`${r.fetchedDirect} fetched free`);
  if (r.fetchedPaid) parts.push(`${r.fetchedPaid} via Web Unlocker`);
  if (r.reviews.size) parts.push(`${r.reviews.size} review pages`);
  if (r.skippedComplete) parts.push(`${r.skippedComplete} already complete`);
  if (r.failed) parts.push(`${r.failed} unavailable`);
  console.error(colors.dim(`  Specs: ${parts.join(", ") || "nothing to do"}`));

  if (r.gsmRateLimited) {
    console.error(
      colors.yellow(
        "  The spec database rate-limited this IP. Resolved models are cached\n  permanently, so re-running later continues where this left off.",
      ),
    );
  }

  if (r.conflicts.length) {
    console.error(
      colors.yellow(
        `  ${r.conflicts.length} knowledge-base conflict(s) — the product page disagrees:`,
      ),
    );
    for (const c of r.conflicts.slice(0, 5)) {
      console.error(
        colors.yellow(
          `    ${c.product}: KB says ${c.knowledgeBase}, page says ${c.productPage}${
            c.ambiguous
              ? colors.dim(" (page abbreviated — verify by hand)")
              : ""
          }`,
        ),
      );
    }
    if (r.conflicts.length > 5) {
      console.error(
        colors.yellow(`    …and ${r.conflicts.length - 5} more`),
      );
    }
    console.error(
      colors.dim(
        "    A high-confidence knowledge-base entry wins and the page is ignored;\n    below that the page wins. Either way, correct the loser in\n    src/knowledge/models.ts.",
      ),
    );
  }
}
