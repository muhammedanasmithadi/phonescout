# Command reference

Every command states plainly whether it spends money. Two things cost:

- **collector credit**: BrightData Data Collector runs, used only by `find`
- **Web Unlocker**: billed per request, used only when you pass `--use-unlocker`

Everything else, including all spec fetching, is free by default.

## Commands

| command                         | spends               | what it does                                                                               |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `find <query>`                  | **collector credit** | Scrapes live listings from the marketplaces, saves the raw payload, resolves specs, ranks. |
| `rank <query> --replay <path>`  | nothing              | Ranks a payload already on disk. Resolves specs (free) and caches them.                    |
| `specs <query> --replay <path>` | nothing              | Pre-fetches spec sheets for a saved run so ranking is instant. Resumable.                  |
| `index`                         | nothing              | Builds the spec-database model index. Run once; committed to the repo.                     |
| `snapshot <id>`                 | nothing              | Re-downloads a BrightData snapshot you already paid for. Not a new scrape.                 |
| `heal <platform>`               | collector credit     | Diagnoses a broken collector from a real run and repairs it. `--dry-run` is free.          |
| `doctor`                        | nothing              | Config, credentials, collector health, and the exact URLs a query would request.           |
| `history [key]`                 | nothing              | Price history for products seen in previous runs.                                          |

`find` is the only command that scrapes listings. `rank` never does; it reads
saved data, so its prices are as old as the capture.

## Shared flags

`find`, `rank` and `specs` use the same vocabulary for spec resolution:

| flag                    | meaning                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-specs`            | Do not resolve specs at all; rank on listing data alone.                                                                                |
| `--specs-source <mode>` | `auto` (free, then Unlocker if permitted) · `direct` (free only) · `unlocker` (paid only) · `cache` (no network).                       |
| `--refresh-prices <n>`  | Refetch the top **n** product pages so the price comes from the buy box rather than the search card. Cached for one hour.               |
| `--max-fetches <n>`     | Cap on **new network fetches** this run. Cached pages are free and uncapped.                                                            |
| `--use-unlocker`        | Permission to fall back to Web Unlocker when a free fetch is blocked. **Billed per request.** It is a fallback, never the first choice. |
| `-v, --verbose`         | Print each page as it resolves.                                                                                                         |

Display flags on `find` and `rank`:

| flag                       | meaning                                        |
| -------------------------- | ---------------------------------------------- |
| `-n, --top <n>`            | Rows in the ranking table (default 15).        |
| `-d, --details <n>`        | Detailed cards for the top N (default 3).      |
| `--no-compare`             | Skip the head-to-head spec matrix.             |
| `--no-diagnostics`         | Skip the coverage and funnel tables.           |
| `--in-stock-only`          | Drop items known to be out of stock.           |
| `--budget-tolerance <pct>` | Allow results this far over the stated budget. |
| `--json`                   | Machine-readable output instead of the report. |

## What `--pages` actually means

`--pages` is search depth per platform on `find`. It is the only flag that
multiplies **collector credit**, so it is worth understanding before raising it.

It does not mean the same thing everywhere, which is why the code scales it:

| platform                      | one page is                    | measured on the reference run                                                                  |
| ----------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Flipkart, Reliance, Tata CLiQ | one seed URL for the collector | `--pages 1` returned **120 cards spanning 5 result pages**; the collector paginates internally |
| Amazon (prebuilt dataset)     | one literal page of results    | `pages_to_search: 1` returned **16 products**, of which 8 were in budget                       |

So a naive `--pages 1` gathers a deep Flipkart catalogue and a thin Amazon one.
Amazon's depth is therefore tripled internally, so one `--pages` value means
roughly comparable breadth rather than an equal number of requests.

### How much catalogue does one page actually give?

Measured by counting _new distinct models_ per result page in the captured run:

| result page | cards | new models | cumulative |
| ----------- | ----- | ---------- | ---------- |
| 1           | 22    | 13         | 13         |
| 2           | 22    | 10         | 23         |
| 3           | 22    | 14         | 37         |
| 4           | 24    | 11         | 48         |
| 5           | 22    | 12         | 60         |

The curve is flat, not decaying: the last page we see still contributes twelve
models we had never encountered. **One page is a slice of the market, not the
market.** 120 cards reduce to 60 distinct models; the rest are colour and
storage variants.

So depth does pay, and seeds are strided to make it pay properly: because one
collector seed already walks about five result pages, seeding 1, 2, 3 would
re-fetch the same catalogue. Seeds step 1, 6, 11 instead, so `--pages 3` covers
result pages 1-15 rather than 1-7.

Practical guidance: **2-3 for a real run**, 1 when you only need a quick look.

## Naming decisions

`--top` rather than `--limit`, because `--limit` meant table rows on one command
and network requests on another. Anything limiting requests is now
`--max-fetches`.

`--use-unlocker` rather than `--allow-paid`, because the old name said neither
which service nor what was billed, and it concealed a bug in which every
spec-database lookup was routed through the paid transport even when the free
one would have served the page.

`--specs-source` rather than `--specs-via`/`--enrich-via`, and the mode `cache`
rather than `cache-only`.

`--enrich` is gone. It named a rank-then-enrich pass that no longer exists:
specs are now resolved for every candidate _before_ ranking, on both `find` and
`rank`.

## A typical session

```bash
deno task index                                  # once, ~1 min

deno task find "best phones under 15000" --pages 1
#   -> spends collector credit, writes runs/<timestamp>_best-phones-under-15000/

deno task specs "best phones under 15000" \
    --replay runs/<that-dir> --use-unlocker
#   -> resolves every spec sheet, free where possible; resumable

deno task rank "best phones under 15000" --replay runs/<that-dir>
#   -> instant, repeatable, costs nothing
```

## Credentials

Every task runs with `--env-file`, so `.env` in the repo root is loaded
automatically. Deno does not read `.env` on its own. Before this, the file was
present and ignored, and `UNLOCKER_ZONE not set` was reported for a zone that
was sitting in it.

```
BRIGHTDATA_API_KEY=...
UNLOCKER_ZONE=cli_unlocker
SERP_ZONE=serp_api1
```

Shell exports still win over the file, so
`UNLOCKER_ZONE=other deno task find ...` overrides it for one run. A missing
`.env` prints a warning and carries on.
