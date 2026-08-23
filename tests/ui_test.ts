import { assert, assertEquals } from "@std/assert";

import { parseIntentRules } from "../src/core/intent.ts";
import { loadRun } from "../src/core/replay.ts";
import { renderFull, sparkline } from "../src/ui/render.ts";
import type { PriceStats } from "../src/core/price-history.ts";
import { runPipeline } from "../src/core/pipeline.ts";

const FIXTURE = "tests/fixtures/run-phones-15000";

Deno.test("the report warns when replayed prices are old", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const result = runPipeline("best phones under 15000", intent, batches);
  const fresh = renderFull(result, {
    limit: 5,
    details: 0,
    compare: false,
    diagnostics: false,
    capturedAt: new Date().toISOString(),
  });
  assert(fresh.includes("prices captured"));
  assert(!fresh.includes("may have moved"));

  const stale = renderFull(result, {
    limit: 5,
    details: 0,
    compare: false,
    diagnostics: false,
    capturedAt: "2026-08-20T01:00:00Z",
  });
  assert(stale.includes("prices captured"));
  assert(stale.includes("may have moved"));
  assert(stale.includes("--refresh-prices"));

  const live = renderFull(result, {
    limit: 5,
    details: 0,
    compare: false,
    diagnostics: false,
  });
  assert(!live.includes("prices captured"));
});

Deno.test("a sparkline maps the range onto eight levels", () => {
  assertEquals(sparkline([]), "");
  assertEquals(sparkline([5, 5, 5]), "▄▄▄"); // flat reads as steady
  assertEquals(sparkline([1, 9]), "▁█");
  assertEquals(sparkline([10, 1, 5]), "█▁▄");
});

Deno.test("a tracked price shows its history and where it sits", async () => {
  const batches = await loadRun([FIXTURE]);
  const intent = parseIntentRules("best phones under 15000");
  const result = runPipeline("q", intent, batches);
  const top = result.ranked[0];
  const stats: PriceStats = {
    key: top.key,
    name: top.modelName,
    current: top.best.price,
    min: Math.round(top.best.price * 0.8),
    max: Math.round(top.best.price * 1.2),
    avg: top.best.price,
    observations: 12,
    runs: 4,
    firstSeen: "2026-08-01T00:00:00Z",
    lastSeen: new Date().toISOString(),
    daysTracked: 21,
    position: 0.5,
    trend: "stable",
  };
  const out = renderFull(result, {
    limit: 3,
    details: 1,
    compare: false,
    diagnostics: false,
    priceHistory: {
      stats: new Map([[top.key, stats]]),
      series: new Map([[
        top.key,
        [
          { t: "2026-08-19T00:00:00Z", p: stats.max },
          { t: "2026-08-20T00:00:00Z", p: stats.min },
          { t: "2026-08-21T00:00:00Z", p: top.best.price },
        ],
      ]]),
    },
  });
  assert(out.includes("trend"), "history line missing");
  assert(out.includes("checks"), "observation count missing");
  assert(out.includes("█") && out.includes("▁"), "sparkline missing");
});
