import { Command } from "@cliffy/command";
import { colors } from "@cliffy/ansi/colors";
import { ALL_ENABLED, type Platform, PLATFORMS } from "../config.ts";
import { collectRaw, searchTerm } from "../core/collect.ts";
import { runPipeline } from "../core/pipeline.ts";
import {
  describeIntent,
  parseIntentRules,
  unsupportedReason,
} from "../core/intent.ts";
import { runDirFor, saveRun } from "../core/replay.ts";
import { renderFull } from "../ui/render.ts";
import {
  type FetchMode,
  refreshPrices,
  reportRefresh,
  reportRefreshDetail,
  reportResolution,
  resolveSpecs,
} from "../core/resolve.ts";
import { buildCandidates } from "../core/pipeline.ts";
import type { CheckoutInfo } from "../core/checkout.ts";
import { getStatsFor, savePrices } from "../core/price-history.ts";
import type { RankIntent } from "../core/types.ts";

function parsePlatforms(raw?: string): Platform[] {
  if (!raw) return ALL_ENABLED;
  const wanted = raw.split(",").map((s) => s.trim().toLowerCase());
  const valid = Object.keys(PLATFORMS) as Platform[];
  const picked = valid.filter((p) => wanted.includes(p));
  if (!picked.length) return ALL_ENABLED;

  return picked;
}

async function maybeEnhanceIntent(intent: RankIntent): Promise<RankIntent> {
  if (!Deno.env.get("GEMINI_API_KEY")) return intent;
  try {
    const { parseIntent } = await import("../lib/llm-intent.ts");
    const llm = await parseIntent(intent.raw);
    return {
      ...intent,
      category: intent.category === "unknown"
        ? (llm.category as RankIntent["category"]) ?? "unknown"
        : intent.category,
      budgetMax: intent.budgetMax ?? llm.budget ?? null,
      brands: intent.brands.length
        ? intent.brands
        : llm.brand
        ? [llm.brand]
        : [],
      priorities: intent.priorities.length
        ? intent.priorities
        : llm.useCase ?? [],
    };
  } catch {
    return intent;
  }
}

export const findCommand = new Command()
  .description(
    "Scrape live listings and rank them — SPENDS BrightData collector credit",
  )
  .arguments("<query:string>")
  .option(
    "-p, --platforms <list:string>",
    "Comma-separated: flipkart,amazon,reliance,tatacliq",
  )
  .option(
    "--pages <n:number>",
    "Search depth per platform. Each step is one more collector request but ~12 more distinct models — the catalogue is not exhausted at 1. Try 2-3 for a real run.",
    { default: 1 },
  )
  .option(
    "--timeout <seconds:number>",
    "Per-platform collector deadline. Must exceed the collector's own polling budget (~480s).",
    { default: 540 },
  )
  .option("-n, --top <n:number>", "Rows to show in the ranking table", {
    default: 15,
  })
  .option("-d, --details <n:number>", "Detailed cards for the top N", {
    default: 3,
  })
  .option("--no-compare", "Skip the head-to-head matrix")
  .option("--no-diagnostics", "Skip the coverage/funnel tables")
  .option("--in-stock-only", "Drop items known to be out of stock")
  .option("--no-specs", "Skip spec resolution and rank on listing data alone")
  .option("--no-reviews", "Skip review mining (Flipkart only, display-only)")
  .option(
    "--specs-source <mode:string>",
    "Where spec pages come from: auto | direct | unlocker | cache",
    { default: "auto" },
  )
  .option(
    "--refresh-prices <n:number>",
    "Refetch the top N product pages so prices come from the buy box, not the search card",
  )
  .option(
    "--max-fetches <n:number>",
    "Cap NEW spec-page fetches this run (cached pages are free and uncapped)",
  )
  .option(
    "--use-unlocker",
    "Fall back to BrightData Web Unlocker (BILLED per request) when a free fetch is blocked",
  )
  .option("-v, --verbose", "Show each page as it resolves")
  .option(
    "--budget-tolerance <pct:number>",
    "Allow N% over the stated budget",
    { default: 0 },
  )
  .option("--save-dir <path:string>", "Where to write the raw run", {
    default: "runs",
  })
  .option("--no-save", "Do not persist raw payloads (not recommended)")
  .option("--no-history", "Skip reading/writing price history")
  .option("--json", "Emit JSON instead of the terminal report", {
    default: false,
  })
  .action(async (options, query) => {
    const platforms = parsePlatforms(options.platforms);
    let intent = parseIntentRules(query);
    intent = await maybeEnhanceIntent(intent);

    const unsupported = unsupportedReason(intent);
    if (unsupported) {
      console.error(colors.yellow(`\n  ${unsupported}`));
      console.error(
        colors.dim(
          '  Phone specs, benchmarks and value scoring are the only thing it does well,\n  so it declines rather than guess. Try: "best phones under 15000".\n',
        ),
      );
      Deno.exit(2);
    }

    if (!options.json) {
      console.log("");
      console.log(colors.bold(`  Searching: ${colors.white(`"${query}"`)}`));
      console.log(colors.dim(`  Understood as: ${describeIntent(intent)}`));
      console.log(colors.dim(`  Marketplace query: "${searchTerm(intent)}"`));
      console.log(
        colors.dim(
          `  Platforms: ${
            platforms.map((p) => PLATFORMS[p].name).join(", ")
          } · ${options.pages} page(s)`,
        ),
      );
      console.log("");
    }

    const batches = await collectRaw(platforms, intent, {
      pages: options.pages,
      timeoutMs: (options.timeout ?? 540) * 1000,
    });

    let savedTo: string | null = null;
    if (options.save !== false) {
      try {
        savedTo = await saveRun(
          runDirFor(query, options.saveDir),
          query,
          searchTerm(intent),
          batches,
        );
      } catch (err) {
        console.error(
          colors.yellow(
            `  Could not save run: ${err instanceof Error ? err.message : err}`,
          ),
        );
      }
    }

    let enrichedCount = 0;
    let mergedCheckout = new Map<string, CheckoutInfo>();
    let lastOptions: Record<string, unknown> = {};
    let result = runPipeline(query, intent, batches, {
      inStockOnly: options.inStockOnly,
      budgetTolerance: (options.budgetTolerance ?? 0) / 100,
    });

    if (options.history !== false && result.ranked.length > 0) {
      const stats = await getStatsFor(result.ranked.map((r) => r.key));
      if (stats.size > 0) {
        result = runPipeline(query, intent, batches, {
          inStockOnly: options.inStockOnly,
          budgetTolerance: (options.budgetTolerance ?? 0) / 100,
          priceHistory: stats,
        });
      }
    }

    if (options.specs !== false) {
      const { candidates } = buildCandidates(intent, batches);
      const resolved = await resolveSpecs(candidates, {
        mode: options.specsSource as FetchMode,
        limit: options.maxFetches,
        allowPaid: options.useUnlocker,
        withReviews: options.reviews !== false,
        verbose: options.verbose,
      });
      reportResolution(resolved);
      enrichedCount = resolved.gsmMatched + resolved.fromCache +
        resolved.fetchedDirect + resolved.fetchedPaid;
      if (
        resolved.text.size > 0 || resolved.external.size > 0 ||
        resolved.reviews.size > 0
      ) {
        lastOptions = {
          inStockOnly: options.inStockOnly,
          budgetTolerance: (options.budgetTolerance ?? 0) / 100,
          enrichText: resolved.text,
          externalSpecs: resolved.external,
          reviewData: resolved.reviews,
        };
        mergedCheckout = resolved.checkout;
        result = runPipeline(query, intent, batches, {
          inStockOnly: options.inStockOnly,
          budgetTolerance: (options.budgetTolerance ?? 0) / 100,
          enrichText: resolved.text,
          checkoutInfo: resolved.checkout,
          externalSpecs: resolved.external,
          reviewData: resolved.reviews,
        });
      }
    }

    if (options.history !== false && result.ranked.length > 0) {
      const stats = await getStatsFor(result.ranked.map((r) => r.key));
      if (stats.size > 0) {
        result = runPipeline(query, intent, batches, {
          inStockOnly: options.inStockOnly,
          budgetTolerance: (options.budgetTolerance ?? 0) / 100,
          priceHistory: stats,
        });
      }
    }

    if (options.history !== false && result.ranked.length > 0) {
      try {
        const n = await savePrices(result.ranked, query);
        if (!options.json && n > 0) {
          console.error(
            colors.dim(
              `  ${n} price observations recorded (deno task dev history)`,
            ),
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(colors.dim(`  price history not recorded: ${msg}`));
      }
    }

    if (options.refreshPrices && options.refreshPrices > 0) {
      const fresh = await refreshPrices(
        result.ranked as unknown as Parameters<typeof refreshPrices>[0],
        {
          limit: options.refreshPrices,
          allowPaid: options.useUnlocker,
          mode: options.specsSource as FetchMode,
        },
      );
      reportRefresh(fresh);
      if (options.verbose) reportRefreshDetail(fresh);
      if (fresh.checkout.size) {
        const merged = new Map(mergedCheckout);
        for (const [k, v] of fresh.checkout) merged.set(k, v);
        mergedCheckout = merged;
        result = runPipeline(query, intent, batches, {
          ...lastOptions,
          checkoutInfo: merged,
        });
      }
    }

    for (const d of result.diagnostics) {
      const entry = Object.values(PLATFORMS).find((p) => p.name === d.platform);
      if (!entry?.knownIssue) continue;
      if (d.categoryMatched > 0) continue;
      console.error(
        colors.yellow(
          `  ${d.platform} returned ${d.rawCards} cards and no phones — ${entry.knownIssue}`,
        ),
      );
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          { ...result, savedTo },
          (k, v) => (k === "raw" || k === "listings" ? undefined : v),
          2,
        ),
      );
    } else {
      let historyView;
      if (options.history !== false && options.details > 0) {
        const { getSeries } = await import("../core/price-history.ts");
        const keys = result.ranked.slice(0, options.details).map((r) => r.key);
        const stats = await getStatsFor(keys);
        if (stats.size) {
          const series = new Map<
            string,
            Awaited<ReturnType<typeof getSeries>>
          >();
          for (const k of stats.keys()) series.set(k, await getSeries(k));
          historyView = { stats, series };
        }
      }
      console.log(
        renderFull(result, {
          limit: options.top,
          details: options.details,
          compare: options.compare !== false,
          diagnostics: options.diagnostics !== false,
          enriched: enrichedCount,
          priceHistory: historyView,
        }),
      );
      if (savedTo) {
        console.log(
          colors.dim(
            `  Raw payloads saved to ${colors.white(savedTo)}\n` +
              `  Re-rank for free:  deno task rank "${query}" --replay ${savedTo}\n`,
          ),
        );
      }
    }

    const allFailed = result.diagnostics.every((d) => d.status !== "ok");
    if (result.ranked.length === 0 && allFailed) Deno.exit(1);
  });
