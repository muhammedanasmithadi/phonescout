# phonescout

> Rank phones across Indian e-commerce on measured specs, verified prices, and
> buyer trust. Not on price alone.

Built for the
[ScrapeVerse Hackathon](https://www.wemakedevs.org/hackathons/scrape-verse)
using Bright Data Scraper Studio.

## What it does

**Phones, ranked properly.** This tool does one category and declines the rest;
[docs/ENGINEERING-LOG.md](docs/ENGINEERING-LOG.md) explains why. The query is
understood, products are classified and spec-matched, variants are grouped, and
results are ranked on value rather than on price alone:

```bash
deno task find "best phones under 15000"                  # live scrape + rank (spends credit)
deno task rank "best phones under 15000" --replay runs/…  # re-rank offline, free
deno task snapshot sd_xxx --platform amazon --out runs/x  # re-download a paid snapshot
deno task index                                           # once: build the spec-DB model index
deno task specs "..." --replay runs/… --use-unlocker      # once: populate the spec cache
deno task doctor --query "phones under 15000"             # config + the exact URLs we'd call
deno task heal reliance --dry-run                         # diagnose a broken collector
deno task history                                         # price history across runs
```

Full flag and command reference: [docs/CLI.md](docs/CLI.md).

**Try it with no API keys.** The repo ships one captured run; this replays it
fully offline. No collector credit, no spec cache, no Bright Data calls:

```bash
deno task rank "best phones under 15000" --replay examples/run-budget-15000 --specs-source cache --no-reviews
```

In cache mode the tool touches nothing off-disk: uncached models fall back to
the knowledge base instead of fetching. The same command produced the committed
outputs: [docs/sample-output.txt](docs/sample-output.txt) (terminal) and
[docs/sample-output.json](docs/sample-output.json) (structured, as consumed by
`--json`).

### Features

- **Hard relevance gating**: a phone query returns phones. Category is decided
  before scoring, not patched afterwards, and the budget is enforced.
- **Spec-aware scoring**: chipset (AnTuTu), display, battery, camera, memory,
  and extras, weighted by what the query actually asked for.
- **Value, not just price**: percentile of spec-points-per-rupee, so the engine
  can recommend paying ₹2,000 more for a materially better phone.
- **Honest confidence**: every product reports how much of its spec sheet was
  known versus inferred; low-confidence items cannot win badges.
- **Variant grouping**: one phone is one row, with every colour, seller, and
  platform offer attached. Carrier-locked and refurbished SKUs stay separate and
  labelled.
- **Trustworthy ratings**: Bayesian shrinkage, so 4.9★ from 3 reviews loses to
  4.2★ from 150,000. Inflated MRPs are flagged instead of rewarded.
- **Replayable runs**: raw payloads are saved before analysis, so ranking can be
  iterated endlessly without spending scraping credit.
- **Price-aware over time**: `find` records every observation, and the ranker
  uses it. A price at its recorded low earns a `LOWEST YET` badge; one at its
  recorded high gets flagged.
- **Diagnosis-driven self-healing**: `heal <platform>` works out _what_ broke
  (crawler error, empty payload, missing fields, wrong products) from a real
  run, writes the repair prompt from that evidence, and verifies the fix.
- **Rich terminal UI**: ranked table, per-product verdict cards with score bars
  and pros/cons, head-to-head spec matrix, and a coverage funnel showing where
  every scraped card went.
- **Four Indian platforms**: Flipkart, Amazon India, Reliance Digital, Tata CLiQ
  (see the honesty note under Platforms).
- **Phones only, on purpose**: the scoring curves, benchmark table, and
  knowledge base are phone-specific. Everything else (headphones, laptops,
  accessories) is classified and filtered out so it can never pollute a ranking.

## Install

Requires [Deno](https://deno.land) v2.9+ (tested on v2.9.5):

```bash
# macOS / Linux
curl -fsSL https://deno.land/install.sh | sh

# Or via Homebrew
brew install deno
```

Clone and enter the project:

```bash
git clone https://github.com/muhammedanasmithadi/phonescout.git
cd phonescout
```

Set your Bright Data API key (required):

```bash
export BRIGHTDATA_API_KEY=your_key
```

Or copy the example and edit:

```bash
cp .env.example .env
```

### Required zones

```bash
# Required for SERP API (Google Shopping discovery)
export SERP_ZONE=serp_api1

# Required for Web Unlocker (screenshots + markdown)
export UNLOCKER_ZONE=cli_unlocker
```

Create zones at
[brightdata.com/cp/web_access/new](https://brightdata.com/cp/web_access/new).

### Collector IDs

The project includes default collector IDs. To use your own:

```bash
export FLIPKART_COLLECTOR_ID=c_your_collector_id
export RELIANCE_COLLECTOR_ID=c_your_collector_id
export TATACLIQ_COLLECTOR_ID=c_your_collector_id
export AMAZON_COLLECTOR_ID=c_your_collector_id
```

To recreate the custom collectors, see [Collector Setup](#collector-setup).

## Usage

```bash
# Live scrape + rank (spends Bright Data credit)
deno task find "best phones under 15000"
deno task find "best camera phones under 50000 with OIS" --pages 2 --refresh-prices 8

# Re-rank a saved run offline, free. Iterate without re-spending.
deno task rank "best phones under 15000" --replay runs/<run-dir>
deno task rank "…" --replay runs/<run-dir> --specs-source cache --refresh-prices 5 --use-unlocker

# Price history across runs
deno task history

# Config check + the exact URLs a run would call
deno task doctor --query "phones under 15000"

# Diagnose a broken collector from real evidence
deno task heal reliance --dry-run

# Once: build the spec-DB model index / populate the spec cache
deno task index
deno task specs "best phones under 15000" --replay runs/<run-dir>

# Re-download a paid snapshot
deno task snapshot sd_xxx --platform amazon --out runs/x
```

Full flag and command reference: [docs/CLI.md](docs/CLI.md), the source of
truth. The flags that matter most on `find`:

| Flag                    | What it does                                             |
| ----------------------- | -------------------------------------------------------- |
| `--pages <n>`           | Search depth per platform (default 1; try 2-3)           |
| `--platforms <list>`    | Comma-separated: flipkart,amazon,reliance,tatacliq       |
| `--top <n>`             | Rows in the ranking table (default 15)                   |
| `--details <n>`         | Verdict cards for the top N (default 3)                  |
| `--refresh-prices <n>`  | Re-fetch top N product pages for buy-box prices (billed) |
| `--use-unlocker`        | Allow billed Web Unlocker fallback when sites block      |
| `--max-fetches <n>`     | Cap new spec-page fetches this run                       |
| `--specs-source <mode>` | auto \| direct \| unlocker \| cache                      |
| `--in-stock-only`       | Drop known out-of-stock items                            |
| `--budget-tolerance %`  | Allow N% over the stated budget                          |

## Platforms

| Platform         | Method              | Pagination   | Scraper Type         |
| ---------------- | ------------------- | ------------ | -------------------- |
| Flipkart         | Scraper Studio      | page-based   | Custom collector     |
| Reliance Digital | Scraper Studio      | scroll-based | Custom collector     |
| Tata CLiQ        | Scraper Studio      | scroll-based | Custom collector     |
| Amazon India     | Pre-built or Custom | page-based   | Dataset or collector |
| Google Shopping  | SERP API            | N/A          | Deal discovery       |

**What actually works today, honestly:** Flipkart and Amazon India are solid.
Reliance Digital's hosted collector returns accessories instead of phones (the
extraction lives in the BrightData dashboard, not this repo; `find` says so in
its report when it happens). Tata CLiQ works but its bot-wall defeats free
fetches, so its spec pages arrive only via `--use-unlocker`. The tool reports
per-platform coverage so a degraded platform is visible, not silent.

### URL templates

| Platform         | Template                                                       |
| ---------------- | -------------------------------------------------------------- |
| Flipkart         | `https://www.flipkart.com/search?q={q}&page={page}`            |
| Reliance Digital | `https://www.reliancedigital.in/products?q={q}`                |
| Tata CLiQ        | `https://www.tatacliq.com/search/?searchCategory=all&text={q}` |
| Amazon India     | `https://www.amazon.in/s?k={q}&page={page}`                    |

## Architecture

One query flows left to right: collection through Bright Data, save-first
storage of raw payloads, an offline-testable pipeline, then ranked output.
Because every payload is saved before analysis, any run replays offline with
identical results.

![phonescout architecture](docs/architecture.png)

```
main.ts                     Entry point, loads .env
src/
  cli.ts                    Command registry (find, rank, specs, index, snapshot, heal, doctor, history)
  config.ts                 Platform definitions and collector IDs
  commands/
    find.ts                 Live scrape + rank. The only command that spends collector credit.
    rank.ts                 Rank a saved run. Free and repeatable.
    specs.ts                Bulk-resolve spec sheets for a saved run. Resumable.
    spec-index.ts           Build the external spec-database model index (run once).
    snapshot.ts             Re-download a BrightData snapshot by id.
    heal.ts                 Diagnose a broken collector from a real run and repair it.
    doctor.ts               Config, credentials, collector health, request plan.
    history.ts              Price history across runs.
  core/                     The pipeline. Marketplace-agnostic and offline-testable.
    types.ts                Listing, Candidate, Specs, RankIntent, scores
    normalize.ts            Raw payload -> Listing, including title recovery from URL slugs
    classify.ts             What is this product? Phones vs audio vs accessories vs feature phones
    extract.ts              Specs from titles, slugs and pages, with plausibility bounds
    group.ts                Colour and storage variants -> one candidate, many offers
    resolve.ts              Fetch specs BEFORE ranking; spec DB, product pages, reviews
    gates.ts                Hard rejection rules: category, budget, brand, must-haves, stock
    scoring/
      curves.ts             Spec components scored through piecewise-linear curves
      blend.ts              Policy weights and formulas: spec/value/trust/deal, confidence
    annotate.ts             Pros, cons, badges and verdicts, comparative within the result set
    rank.ts                 Orchestrates gates -> scoring -> ordering; stable import surface
    rank-types.ts           Shared option and outcome types for the ranking API
    pipeline.ts             Wires the above together
    checkout.ts             Real price at checkout, offers, stock, delivery
    reviews.ts              Ratings histogram and aspect-level sentiment
    price-history.ts        Observations over time, via Deno KV
    spec-cache.ts           Persistent page cache so specs are fetched once
    replay.ts               Save and reload raw runs
    collect.ts              Live collection and per-platform search URLs
  knowledge/
    soc.ts                  ~65 chipsets with approximate benchmarks (fallback)
    models.ts               ~65 phone spec sheets, hand-maintained, confidence-tagged
    gsmarena.ts             External spec database: model index, verified lookup, measured benchmarks
  lib/
    brightdata.ts           REST client (handles NDJSON)
    collector.ts            Data Collector API driver (trigger + poll)
    amazon-dataset.ts       Amazon prebuilt dataset client
    fetch-page.ts           Page fetching: free direct, Web Unlocker fallback, HTML/JSON to text
    heal-api.ts             Self-healing API wrapper
    llm-intent.ts           Optional Gemini intent parsing
  ui/
    render.ts               Ranking table, detail cards, head-to-head matrix, coverage funnel
tests/
  rank_test.ts              Scoring policy: blends, badges, history effects
  pipeline_test.ts          Fixture-driven end-to-end runs and REGRESSION cases
  intent_test.ts            Query parsing: budgets, brands, priorities
  classify_test.ts          Category rules on real titles
  normalize_test.ts         Payload parsing and title recovery
  extract_test.ts           Spec extraction from titles, slugs and pages
  group_test.ts             Variant grouping across platforms
  knowledge_test.ts         Chip tables, model KB integrity, spec-database parsing
  resolve_test.ts           Spec resolution, caching, refresh pricing
  checkout_test.ts          Checkout price and stock reading
  reviews_test.ts           Review summarisation and polarity
  platforms_test.ts         Per-platform URL building
  heal_test.ts              Failure-mode classification prompts
  ui_test.ts                Table rendering and sparklines
  golden_test.ts            Ranking invariants, gates and anchors
  llm-intent_test.ts        Optional LLM intent layer
  mock_fetch_test.ts        Transport injection
  fixtures/                 Real captured runs and pages; see tests/fixtures/README.md
```

### Data flow

```
User query
  → parseIntentRules() reads category, budget, brands, priorities, must-haves
  → searchTerm() and buildUrls() make per-platform search URLs
  → collectRaw() triggers all platforms in parallel and polls Bright Data
    → Scraper Studio custom collectors: Flipkart, Reliance Digital, Tata CLiQ
    → Pre-built dataset: Amazon India
    → On empty results: auto-heal → re-run the same collector
  → normalizeBatch() turns raw cards into Listings, recovering titles from slugs
  → resolveModel() fills spec gaps from the spec database and product pages
    (the find/specs commands drive this BEFORE ranking; replay uses the cache)
  → runPipeline() does everything offline-testable:
    → classify() phones vs audio vs accessories vs feature phones
    → groupListings() variants → one candidate, many offers
    → gateCandidates() hard rules: category, price, brand, must-haves, stock
    → rankCandidates() spec/value/trust/deal blend, availability sorts first
  → savePrices() records observations for price history (Deno KV)
  → Recommendation + ranked comparison table
```

## How Bright Data is used

### Scraper Studio (custom collectors)

Custom collectors are created via the DCA REST API targeting specific product
listing pages. Products are scraped in batch mode via `/dca/trigger` endpoint.
Used for Flipkart, Reliance Digital, and Tata CLiQ.

### Pre-built scrapers (Amazon)

Uses Bright Data's pre-built Amazon India scraper (`gd_lwdb4vjm1ehb499uxs`) via
`/datasets/v3/trigger`. Returns product data: name, price, MRP, discount,
rating, reviews, brand, images.

### SERP API (deal discovery)

Searches Google Shopping for deals using `POST /request` with `udm=28`. Returns
structured shopping results with prices, ratings, and merchant info.

### Web Unlocker (screenshots + markdown)

Used for taking screenshots of deal pages and fetching pages as markdown.
Optional fifth source behind `--discover` flag.

### Self-healing

The `refactor_template` API analyzes broken selectors and proposes code fixes
using AI. Full flow: trigger → poll → preview → approve → verify. Auto-heal runs
when a platform returns empty results or field fill rate < 50%.

## Scoring

One ranker, two modes, decided by the query:

- **Ceiling queries** ("best phone under 50000") ask for the best phone the
  budget allows. Quality leads: absolute spec curves (chipset via AnTuTu,
  display, battery, camera array incl. telephoto/ultrawide/aperture, memory,
  extras), weighted by what the query emphasises. Trust breaks ties; deal polish
  is capped at 15%.
- **Bargain queries** ("budget phones", "value for money", "cheap") keep the
  value-first formula: spec-points-per-rupee percentile within the result set
  carries half the score.

On top of either mode:

- **Trust**: Bayesian rating shrinkage. 4.9★ from 3 reviews loses to 4.2★ from
  150,000.
- **Corroboration gating**: a spec sheet with no buyer or knowledge-base backing
  scores its specs at a discount and cannot win badges.
- **Availability sorts before score**: anything you cannot buy ranks below
  everything you can, however attractive its price.
- **Honest confidence**: each row reports how much of its spec sheet was read vs
  inferred; low-confidence items are scored down visibly.
- **Inflated MRPs** (>55% off) earn no deal credit and get an asterisk.
- **Verified prices win**: where a product page was fetched, its buy-box price
  replaces the search-card quote (which often belongs to one dead seller's
  listing).

## Tech stack

- [Deno](https://deno.land) v2: runtime
- [Cliffy](https://cliffy.io): CLI framework (commands, tables, prompts)
- [Deno KV](https://deno.land/kv): embedded key-value store for price history
- [Bright Data](https://www.brightdata.com): web scraping infrastructure

## Collector Setup

The project uses custom Scraper Studio collectors:

| Platform         | Collector ID                       | Target URL pattern                  |
| ---------------- | ---------------------------------- | ----------------------------------- |
| Flipkart         | `c_mt1bpy5nvn2i7o1r7`              | `flipkart.com/search?q=...`         |
| Reliance Digital | `c_msxt4lsv12k5p1328b`             | `reliancedigital.in/products?q=...` |
| Tata CLiQ        | `c_mt0oxjk82pao8tyc4u`             | `tatacliq.com/search/?text=...`     |
| Amazon India     | Prebuilt (`gd_lwdb4vjm1ehb499uxs`) | `amazon.in/s?k=...`                 |

### Recreating collectors

Since we use Deno (not Node/npx), collectors must be created via the REST API or
the Bright Data dashboard. The `npx -p @brightdata/cli bdata` commands below
require Node.js, so run them manually if you need to recreate collectors.

**Flipkart (Search type):**

```bash
# Create collector
curl -X POST "https://api.brightdata.com/dca/collector" \
  -H "Authorization: Bearer $BRIGHTDATA_API_KEY" \
  -d '{"name": "Flipkart Scraper", "url": "https://www.flipkart.com/search?q=iphone"}'

# The AI template is generated via refactor_template after creation.
# Use: deno task dev heal <collector_id> "Fix selectors for product cards"
```

**Reliance Digital (scroll-based):**

```bash
# Seed URL uses /products?q= (NOT /search?q= which returns 404)
curl -X POST "https://api.brightdata.com/dca/collector" \
  -H "Authorization: Bearer $BRIGHTDATA_API_KEY" \
  -d '{"name": "Reliance Scraper", "url": "https://www.reliancedigital.in/products?q=iphone"}'
```

**Tata CLiQ (scroll-based):**

```bash
# Uses searchCategory=all&text= param format
curl -X POST "https://api.brightdata.com/dca/collector" \
  -H "Authorization: Bearer $BRIGHTDATA_API_KEY" \
  -d '{"name": "Tata CLiQ Scraper", "url": "https://www.tatacliq.com/search/?searchCategory=all&text=iphone"}'
```

After creation, set the collector IDs in `.env`:

```bash
FLIPKART_COLLECTOR_ID=c_your_new_id
RELIANCE_COLLECTOR_ID=c_your_new_id
TATACLIQ_COLLECTOR_ID=c_your_new_id
```

Verify with: `deno task dev doctor`

## How to reproduce

```bash
# Clone
git clone https://github.com/muhammedanasmithadi/phonescout.git
cd phonescout

# Set API key
export BRIGHTDATA_API_KEY=your_key
export SERP_ZONE=serp_api1
export UNLOCKER_ZONE=cli_unlocker

# Rank (offline replay of a saved run, free)
deno task rank "best phones under 15000" --replay runs/<dir> --json

# Expected JSON shape:
# {
#   "query": "…",
#   "ranked": [
#     {
#       "modelName": "Samsung Galaxy M17 5G (6GB/128GB)",
#       "rank": 1,
#       "best": { "price": 13499, "platformName": "Flipkart", "inStock": true },
#       "score": { "total": 78.2, "confidence": 0.9 },
#       "specs": { "socName": "Exynos 1330", "antutu": 615000 }
#     }
#   ],
#   "diagnostics": [...]
# }
```

## AI tools disclosure

This project was built with assistance from AI coding tools. The self-healing
feature uses Bright Data's AI-powered `refactor_template` API to analyze and fix
broken scraper selectors.

## License

MIT
