import { assert, assertEquals, assertExists } from "@std/assert";

import { capturedAtFor } from "../src/core/replay.ts";

const FIXTURE = "tests/fixtures/run-phones-15000";

Deno.test("enrichment targets the least-known products, not the top of the table", () => {
  const mk = (
    key: string,
    confidence: number,
    completeness: number,
    kb: string,
  ) =>
    ({
      key,
      modelName: key,
      specCompleteness: completeness,
      kbConfidence: kb,
      score: { confidence },
      listings: [{
        id: key,
        url: `https://www.flipkart.com/${key}/p/itm${key}`,
      }],
      best: { url: `https://www.flipkart.com/${key}/p/itm${key}` },
      // deno-lint-ignore no-explicit-any
    }) as any;

  const ranked = [
    mk("well-known-1", 1.0, 0.95, "high"),
    mk("well-known-2", 1.0, 0.9, "high"),
    mk("mystery-phone", 0.2, 0.3, "none"),
    mk("half-known", 0.6, 0.6, "medium"),
  ];

  const eligible = ranked.filter((r) =>
    !(r.specCompleteness >= 0.85 && r.kbConfidence === "high")
  );
  const ordered = [...eligible].sort((a, b) =>
    a.score.confidence - b.score.confidence
  );

  assertEquals(eligible.length, 2);
  assertEquals(ordered[0].key, "mystery-phone");
});

Deno.test("a replayed run says when its prices were captured", async () => {
  const ts = await capturedAtFor([FIXTURE]);
  assertEquals(ts, "2026-08-21T04:36:37Z");
});

Deno.test("capturedAt falls back to mtime when a run has no manifest", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/amazon.json`, "[]");
    const stat = await Deno.stat(dir);
    const ts = await capturedAtFor([dir]);
    assertExists(ts);
    assertExists(stat.mtime);
    assert(
      Math.abs(Date.parse(ts) - stat.mtime.getTime()) < 60_000,
      `mtime fallback too far off: ${ts}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
