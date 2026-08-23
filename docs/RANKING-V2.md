# Ranking engine v2 — what changed and why

The old pipeline answered _"best phones under 15000"_ with four ₹1,599 OnePlus
earphones in the top four slots, a ₹15,499 phone that was over budget at #5, and
a wall of 0.00 scores below that. This document explains every root cause and
the fix, so the reasoning is auditable rather than just "it looks better now".

Run the before/after yourself — the failing run is checked in as a fixture:

```bash
deno task rank "best phones under 15000" --replay tests/fixtures/run-phones-15000
```

---

## The five root causes

### 1. Half of every scrape was thrown away

Of 120 Flipkart cards, 54 had no `product_name` and no `selling_price` — the
selectors missed — but **all 120 had an intact product URL**. The old parser
required a name field and dropped the rest. So the ranker was working from a
biased 55% sample, which is why the surviving junk (accessories that happened to
parse) floated to the top.

**Fix** — `src/core/normalize.ts` recovers titles from URL slugs:

```
/poco-c85x-sunset-gold-128-gb/p/itm5e970a19e6ad3  →  "POCO C85X Sunset Gold 128 GB"
```

Coverage went from 66/120 to **120/120**. Cards that still lack a price are kept
as spec/rating evidence for their model group instead of being deleted.

### 2. Relevance was token overlap against the raw query

`relevanceScore()` compared product titles against the tokens of
`"phones under 15000"`. No phone title contains the words "phones", "under" or
"15000", so _every_ product scored the same, and the accessory blocklist ran
only _after_ scoring as a soft penalty.

**Fix** — `src/core/classify.ts` is a weighted rule classifier with strong
signals, weak signals and vetoes, run **before** scoring. Category mismatch is a
hard gate with a recorded reason. `"OnePlus Bullets Z2 … in Ear Earphones"`
classifies as `earbuds` and is removed from a `phone` query, permanently.

### 3. Budget was never enforced

`intent.budget = 15000` was parsed, passed to the URL builder, and then ignored
by the ranker — hence the ₹15,499 phone at #5.

**Fix** — budget is a hard gate in `rankCandidates()`, with `--budget-tolerance`
if you deliberately want to see slightly-over options.

### 4. Every variant was its own row

Dedup was on the exact normalised title, so four colours of the same phone took
four slots. The scoreboard showed variety it did not have.

**Fix** — `src/core/group.ts` groups by **model + memory config**. One phone =
one row, with every offer (across colours, sellers and platforms) attached, and
`siblingConfigs` showing the other memory tiers. Review counts are taken as the
per-platform max rather than summed, so four colours don't inflate credibility
4×. Carrier-locked / refurbished SKUs are deliberately _not_ merged — they are
labelled `[carrier-locked]` and carry a warning, because that is the entire
reason their price looks good.

### 5. The score was price + discount, with no idea what a product is

`score = 0.45·price + 0.25·discount + 0.2·rating + …` cannot distinguish a
₹10,999 phone with a 2019 chipset from a ₹10,999 phone with a current one, and
it actively rewards inflated MRPs. Ratings were used raw, so 4.9★ from 3 reviews
beat 4.2★ from 150,000.

**Fix** — a four-part score, described below.

---

## How ranking works now

```
raw JSON → normalize → classify → extract specs → group variants → gate → score
```

**Spec score (absolute, 0–100).** Measured against fixed anchors, not the
competition, so a 6000mAh battery scores well regardless of what else was
scraped. Weighted per category and re-weighted by query priorities — asking for
a _gaming_ phone raises the performance weight, _camera_ raises camera.

| Component   | Sourced from                                                    |
| ----------- | --------------------------------------------------------------- |
| Performance | SoC → AnTuTu, log-scaled (`src/knowledge/soc.ts`, ~50 chipsets) |
| Display     | panel type, refresh rate, resolution                            |
| Battery     | capacity + charging wattage                                     |
| Camera      | main sensor MP with diminishing returns, OIS bonus              |
| Memory      | RAM + storage curves                                            |
| Extras      | 5G, NFC, IP rating, promised OS upgrades                        |

**Value score (relative, 0–100).** Percentile rank of _spec points per ₹1,000_
across the candidate set. This is what makes the engine willing to say "pay
₹2,000 more, get a materially better phone" instead of always picking cheapest.

**Trust score.** Bayesian-shrunk rating (prior = segment mean, strength = 500
virtual reviews), then pulled toward neutral by an evidence factor that only
approaches 1 at scale. A 14-review product cannot borrow the segment's
reputation.

**Deal score.** Discount credibility (anything over 55% off on a budget device
is treated as marketing, not savings, and flagged with `*`), cross-platform
price spread, and position against the segment median.

**Confidence.** Every candidate reports how much of its spec sheet was actually
known versus imputed from peers. Low-confidence candidates are pulled toward the
middle of the pack (`total × (0.7 + 0.3 × confidence)`) and are excluded from
superlative badges — an unknown-chipset phone can no longer win "BEST VALUE".

Unknown specs are imputed at **90% of the peer median**, on the reasoning that a
product is usually obscure rather than secretly excellent.

---

## Spec data: offline first, live only for finalists

- `src/knowledge/soc.ts` — ~50 chipsets with approximate AnTuTu/Geekbench
  figures, used for _relative_ ranking only and labelled `≈` in the UI.
- `src/knowledge/models.ts` — per-model spec sheets (panel, refresh, charging,
  OIS, IP rating…) that listing cards never expose. Each entry carries a
  `confidence` field; `low` entries are used but flagged in the UI. **A missing
  entry degrades gracefully; a wrong entry corrupts ranking silently — so only
  add what you actually know.**
- `--enrich N` (opt-in) fetches real spec sheets via Web Unlocker for the top N
  finalists only, then re-ranks. Enriching 8 of 120 cards costs ~6% of what
  enriching everything would, and products whose specs are already fully known
  are skipped automatically.

Field precedence: `enriched PDP > knowledge base > title/slug regex > inferred`.
Every field records its source, and the UI never presents an inferred value as a
measured one.

---

## Replay: iterate for free

Every live run writes its raw payloads to `runs/<timestamp>_<query>/` **before**
analysis, so a crash in the ranking code never costs a scrape credit.

```bash
deno task find "best phones under 15000" --pages 1     # spends credit, saves run
deno task rank "best phones under 15000" --replay runs/2026-08-21T...   # free
```

`rank --replay` accepts a run directory, a list of JSON files, or loose
BrightData exports — the platform is inferred from the records themselves. This
is how the ranking logic was iterated dozens of times against your existing
`$20`-budget run data without a single new request.

---

## Scraper fixes

| Platform  | Bug                                                                                                                            | Fix                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Reliance  | URL hard-coded to `/collection/smartphones` for any phone query — returned ₹499 earphones, ignoring the query entirely         | real search endpoint with the query, budget and pagination       |
| Tata CLiQ | `text=query:relevance:category:MSH1210` renders a page whose product grid never mounts → `wait_element_timeout` after 48 polls | plain text search + price facets                                 |
| Flipkart  | unsorted relevance results                                                                                                     | `sort=popularity` + price facets so page 1 holds real contenders |
| All       | no per-platform timeout; one stuck collector blocked the whole run for 8 minutes                                               | per-platform timeout, failures isolated and reported             |

---

## Test coverage

`tests/` holds 188 tests across 14 module files, including regressions pinned to
real captured runs:

- a phone query never returns earphones,
- a keypad phone never survives ranking, with or without a self-describing
  title,
- no model may occupy more than two of the top ten,
- the winner is spec-justified rather than merely cheapest,
- an out-of-stock product never leads the table.

```bash
deno task check     # fmt + lint + type-check + 188 tests, all offline
```

---

## Round 2: what the real Amazon payload taught us

The first pass was built against a Flipkart + Reliance capture. Replaying an
actual Amazon snapshot (`sd_mt2gj3m12b2l7r2jy9`, "phones under 15000") broke
four more assumptions — all of them silently, which is the dangerous kind.

**Amazon titles are marketing strings, not product names.** They look like
`<product> | <feature> | <feature> | …`, and the accessory veto was matching
against the whole string. Result: _"Itel Zeno 200 (…) | … | Charger in Box"_ was
classified as a charger, _"Samsung Galaxy M06 5G | … | Without Charger"_
likewise, and _"realme NARZO 90x 5G | … | 400% Ultra Boom Speaker"_ became a
speaker. Four of sixteen Amazon phones were being deleted. Vetoes now apply only
to the product-noun head (before the first `|`); positive signals may still come
from anywhere, since feature text is legitimate evidence.

**Booleans arrive as strings.** `sponsored: "false"` is truthy in JavaScript.
Every Amazon listing would have been marked sponsored.

**MRPs can be nonsense.** One card claimed ₹1,59,994 MRP on an ₹8,899 phone — a
94% "discount" that would have topped the deal score. Any MRP above 5× the
selling price is now discarded as bad data.

**Those long titles are also a spec goldmine.** Amazon states the chipset,
charging wattage, refresh rate, camera and sometimes the benchmark outright
(`AnTuTu 623K+`, now parsed directly). Amazon has the highest field-fill of any
platform in the fixture at 87%.

One more thing the snapshot revealed: the old code appended the budget to the
_keyword_ rather than using Amazon's price filter, so the search term was
literally `"phones under 15000 under 15000"`. `searchTerm()` now builds a clean
category keyword and the budget is enforced as a hard gate at ranking time.

## Round 2: audio is a first-class category

Replaying the saved `sony wh-1000xm5` runs showed the pipeline ranking a ₹1,000
silicone case at #1 and the WH-1000XM5 itself last — the same failure mode as
the earphones bug, in a different category. Three fixes:

1. **Audio accessories are gated.** Cases, ear pads, headband covers, hinges and
   "replacement for <brand>" parts no longer classify as headphones.
2. **Audio has its own scoring dimensions.** Grading a headphone on chipset and
   camera is meaningless. Audio is scored on sound (codecs, drivers, or a
   reviewer-grade figure from the KB), noise cancellation (hybrid ANC > ANC >
   ENC > passive), battery (on a TWS-aware scale — 8h of buds ≈ 30h of a
   headset), comfort and features. `src/knowledge/audio.ts` seeds ~16 models.
3. **Category is inferred when the query omits it.** "sony wh-1000xm5" names no
   category, so intent parsing returned `unknown` and the ranker fell through to
   phone scoring. The category is now inferred from what actually came back.

## Round 2: naming a specific model

Searching "sony wh-1000xm5" and being shown a WH-CH520 first because it is
better value is a failure, however good the value maths. The intent parser now
recognises alphanumeric part numbers (the old regex could not match `wh-1000xm5`
at all), and an exact model match is floated to the top. Other models are still
shown — they are often the better buy — but badged `ALTERNATIVE`, with a note
explaining why the table is not in score order.

## Testing without spending credit

Three ways, cheapest first:

```bash
# 1. Replay anything already on disk — run dirs, loose exports, v1 outputs.
deno task rank "best phones under 15000" --replay tests/fixtures/run-phones-15000

# 2. Re-download a snapshot you already paid for (a download, not a crawl).
deno task snapshot sd_mt2gj3m12b2l7r2jy9 --platform amazon --out runs/phones

# 3. Only then, a live scrape.
deno task find "best phones under 15000" --pages 1
```

The replay loader accepts run directories, individual JSON files, raw BrightData
exports and the v1 `{query, products[]}` output format, inferring the platform
from the records themselves.

---

## Cleanup: what was removed and why

Once `find`/`rank` worked, the v1 pipeline was dead weight that still had to
compile, type-check and be reasoned about. It was deleted rather than left to
rot.

**Deleted outright** (~3,900 LOC): `score.ts` (token-overlap relevance, no
budget enforcement), `scraper.ts` (v1 orchestration), `lib/specs.ts` (superseded
by `core/extract.ts` plus the knowledge bases), `lib/compare.ts`,
`lib/intelligence.ts`, `lib/catalog.ts`, `lib/serp.ts`, `tools/scraper.ts`'s
product parser, and the v1 `types.ts`. With them went the `search`, `best-deal`,
`compare`, `verdict`, `discover`, `screenshot`, `fetch` and `scrapers` commands,
plus five test files that only exercised deleted code.

`eval-live/` — 96 tracked files of scratch debugging output — is gone too. The
two captures that mattered are preserved as proper fixtures:
`tests/fixtures/run-phones-15000` and `tests/fixtures/run-sony-wh1000xm5`.

**Kept and rewired, not just kept:**

- `heal` used to take a collector id and a hand-written prompt, so you had to
  already know what was broken. It now takes a platform name, diagnoses the
  failure from a real run (live or replayed), and writes the prompt from that
  evidence. It distinguishes the four failure modes actually observed: crawler
  error (Tata CLiQ's `wait_element_timeout`), empty payload, missing fields
  (Flipkart's 54-of-120), and wrong products (Reliance returning earphones).
  Then it re-runs the pipeline to verify the fix took.
- `doctor` absorbed `status` and `scrapers`, and gained `--query`, which prints
  the exact URL each platform would be sent — catching URL-builder bugs for
  free, without spending a request.
- `history` was rekeyed from v1 product names to v2 candidate keys, so one phone
  is one tracked product instead of one per colour. `find` now records
  observations automatically, and the ranker consumes them: a price at its
  recorded low earns a deal-score boost and a `LOWEST YET` badge, one at its
  recorded high is penalised and flagged. A single observation is explicitly not
  treated as history.

The CLI went from 12 commands and 1,210 lines to 6 commands and 34 lines; the
codebase from 11,333 LOC to 7,877, with test count reflecting only live code.

---

## Round 4: phones only, on purpose

The generic category machinery was quietly dangerous. Asked for laptops, the
pipeline produced this:

```
#1 HP Victus Gaming Laptop, AMD Ryzen 5 7535HS...  ₹54,990  score 43  conf 20%
     perf 45  display 45  battery 45  camera 45
```

Three failures in one line. Two of three laptops were dropped because their
titles lack the literal word "laptop", every dimension is the imputation default
because there is no CPU/GPU benchmark table, and it is scoring a laptop on
_camera_. That is the original sin of this project — confident output built on
nothing — reappearing in a new category.

So the tool now ranks phones and declines everything else:

```
$ deno task rank "best earbuds under 2000" --replay runs/x
  This tool ranks phones. "best earbuds under 2000" looks like a search for earbuds.
  Only phones are ranked. Try: "best phones under 15000".
```

`find` refuses _before_ spending a request. The classifier still recognises
earbuds, laptops, TVs and accessories — it has to, in order to reject them and
to keep the funnel readable ("11 earbuds filtered out" is how the Reliance URL
bug was caught in the first place) — but only `phone` is rankable.

Audio support and `src/knowledge/audio.ts` were removed with it (~500 LOC),
along with the dual scoring paths in `rank.ts`, `extract.ts` and the UI. One
component set, one weight map, no possibility of the two disagreeing (which had
already produced NaN scores across every headphone once).

Model-hint extraction was also fixed while narrowing. It previously resolved
"poco m7 pro 5g" to `"pro 5g"`, which would match any Pro 5G phone from any
brand. A model code is now a token mixing letters and digits ("m7", "z10",
"m06", "wh-1000xm5") or a word plus a number ("note 14"), with marketing
suffixes excluded, and short codes require the brand to agree.

## Round 4: the knowledge base, and an honest result

The KB went from 30 to 65 phones and the SoC table from 50 to 65 chipsets, with
integrity tests (no duplicate keys, every declared chipset resolves, values in
plausible ranges, and a Pro variant never resolving to its non-Pro sibling).

**It did not improve the sub-₹15,000 fixture at all.** Coverage there is still
10 of 48 ranked products (21%), average confidence 41% — exactly what it was
before the additions. The reason is visible in the data:

```
KB matched:        POCO M7 Pro/M7/C75, Samsung M06/M07/F07, realme narzo 80 Lite
Chipset unknown:   Itel Zeno 200, Peace I17 Air, ringme BOLD 17 PRO, Peace SC26,
                   Maplin SC26, Ai+ Pulse 2, Peace I-Ultra, itel Zeno 100 …
```

The Indian sub-₹15k shelf is dominated by very recent releases and white-label
brands that no static KB will ever cover. The models added this round — Redmi
Note 13 Pro, POCO X6/X7 Pro, Galaxy A25/A35/A55, Pixel 8a, Nothing Phone (2a) —
live in the ₹15k–45k bracket and simply do not appear in a "under 15000" search.
They should pay off on mid-range queries; that is untested, because there is no
captured payload for one.

The conclusion is that **KB growth is the wrong lever for the budget segment**.
For phones nobody has heard of, `--enrich` (fetch the actual product page for
the finalists) is the only thing that will work, and the confidence figure is
doing its job in the meantime by marking those results as unverified.

---

## Round 5: enrichment works, and it is free

Web Unlocker turned out to be unavailable (it requires business KYC), which
looked like a dead end for the white-label phones the KB cannot cover. It was
not. Marketplaces block _datacenter_ IPs; a normal connection is a different
proposition, so `--enrich` now tries a plain direct fetch first and only falls
back to Web Unlocker if that fails.

Measured on the real sub-₹15,000 fixture:

|                       | before        | after `--enrich 30` |
| --------------------- | ------------- | ------------------- |
| chipset known         | 10 / 48 (21%) | **24 / 48 (50%)**   |
| average confidence    | 41%           | **63%**             |
| Web Unlocker requests | —             | **0**               |

28 of 30 pages fetched directly; the failures were Amazon, which serves a bot
page to unknown clients. On an account that _does_ have a working Web Unlocker
zone, those Amazon pages enrich through the fallback — a real run showed "27
direct (free), 3 via Web Unlocker", i.e. full coverage with three paid requests.
Flipkart returns its "Product highlights" block in the initial HTML, and that
block contains exactly what the ranker needs:

```
4 GB RAM | 128 GB ROM T7250 | Octa Core Processor | 1.8 GHz Clock Speed
```

Concrete outcome: `Ai+ Pulse 2` went from an unknown chipset at 23% confidence
to Unisoc T7250 at 70–83%. `Alcatel V3 Classic 5G` and `Samsung Galaxy F16 5G`
resolved to Dimensity 6300 at 83–85%.

Two bugs had to be fixed to get there, and both are the kind that fail quietly:

1. **Enrichment was aimed at the wrong products.** The implementation sliced the
   top N and _then_ dropped well-documented models, so a budget of 14 fetches
   was spent on ranks 1–14 — nearly all already in the KB — and never reached
   the unknown phones below them. The first measured run recovered _nothing_.
   Selection now filters first and orders least-confident first, so a small
   budget buys the most information.
2. **Stripped markup loses spaces.** Flipkart PDPs yield "Snapdragon6" and bare
   "T7250" once tags are removed, which the SoC matcher did not recognise.
   Vendor names are now re-separated from their digits. Note that "Snapdragon6"
   stays _unresolved_ on purpose — without a generation it is ambiguous, and
   guessing is worse than admitting ignorance.

`ringme BOLD 17 PRO` still has no chipset after enrichment, because its product
page genuinely does not state one. That is the correct outcome: it keeps a low
confidence score and says so.

The ranking table now also nudges you when it is guessing: if three or more
results have sub-50% confidence it prints the exact `--enrich N` command to fix
them.

---

## Round 6: badges are promises, so they need evidence

A live run put `BEST VALUE` on `Maplin SC26 5G` — unknown chipset, zero ratings,
55% confidence — purely because its _imputed_ spec sheet divided nicely by a low
price. The confidence gate (>= 0.5) was not a high enough bar for something the
UI presents as a recommendation.

Superlative badges now require real evidence: a resolved chipset, at least 100
ratings, a rating of 3.5 or better, and 60% confidence. On the reference fixture
`BEST VALUE` moved to `Ai+ Pulse 2` — Unisoc T7250, 4.2★ from 9,500 buyers —
which is a defensible thing to tell someone to buy.

`CHEAPEST` deliberately does _not_ sit behind that bar, because it is a
statement of fact rather than a recommendation. Fixing this exposed a second
bug: it had been computed over the credible pool only, so it could sit on the
cheapest _verified_ phone while a cheaper one was listed above it. It is now
computed over every ranked product and is therefore true.

The `--enrich` hint also stopped contradicting itself. After a run of
`--enrich 30` it used to advise `--enrich 20`; it now reports how many products
remain unverified _after_ enrichment and explains that their pages simply do not
state a chipset.

---

## Round 7: what you actually pay — and a feature that was not worth building

The plan was an "effective price" that folded bank offers and exchange bonuses
into the ranking. Measuring first killed most of it.

Flipkart's `Bank offers ₹X off`, sampled across nine products from nine
different brands:

| brand    | listed  | buy at  | bank offer | %   |
| -------- | ------- | ------- | ---------- | --- |
| POCO     | ₹14,999 | ₹14,249 | ₹750       | 5.0 |
| realme   | ₹12,970 | ₹12,321 | ₹649       | 5.0 |
| Samsung  | ₹11,699 | ₹11,114 | ₹585       | 5.0 |
| Ai+      | ₹11,999 | ₹11,399 | ₹600       | 5.0 |
| Motorola | ₹12,499 | ₹11,874 | ₹625       | 5.0 |
| itel     | ₹10,999 | ₹10,449 | ₹550       | 5.0 |
| LAVA     | ₹11,999 | ₹11,399 | ₹600       | 5.0 |
| Tecno    | ₹12,499 | ₹11,874 | ₹625       | 5.0 |

Exactly 5.0% every time. It is a flat card discount, not a per-product deal. A
uniform proportional discount cancels out of the value ratio, so ranking on
"effective price" would reorder precisely nothing while looking like insight. It
was not built, and a test pins the decision: feeding a synthetic 5% discount
through the pipeline must leave the ranking identical.

What _was_ built is the honest part — the detail cards now show the real
checkout number and the two things that genuinely vary:

```
₹14,999 on Flipkart  (MRP ₹18,999, 21% off)
₹14,249 at checkout (₹750 card offer)  ·  up to ₹10,700 exchange  ·  no-cost EMI
offer/delivery unavailable at the default pincode
```

Exchange value is conditional on the buyer's old handset and is never scored.
Pincode availability is surfaced because a deal you cannot receive is not a
deal.

This changed the enrichment policy too. Spec enrichment targets the products we
know _least_ about, but checkout price is only actionable for the products being
_recommended_ — and those are the well-documented ones enrichment was
deliberately skipping. The top three are now always fetched; the remaining
budget still goes to the least-confident.

### On review sentiment

Star ratings do not discriminate in this segment: nearly everything sits at
4.1–4.3. The signal is in the review text, and it is reachable — the PDP has
none (JS-rendered) but `/product-reviews/` returns it in plain HTML:

```
Verified Purchase · May, 2025 — "Battery performance is good Display is good
better phone Good delivery"
```

Amazon's equivalent is 404 plus bot-blocking, so this would be Flipkart-only and
the UI must say so rather than implying full coverage. The intended design is a
deterministic aspect lexicon (battery, heating, camera, display, performance,
build, charging, service) producing mention counts and polarity — displayed
first, and allowed to affect the score only behind a volume threshold, for the
same reason the BEST VALUE badge now demands evidence.

---

## Round 8: resolve specs before ranking, not after

An audit of the reference run showed how little the ranker actually knew:

```
ranked                        48
fully specced (11/11 fields)   7  (15%)
avg fields known             4.2 / 11
chipset missing on           38 / 48
```

85% of ranked products had an incomplete spec sheet, and the missing fields were
filled with peer medians — invented numbers feeding a visible score.

Worse, the old flow was circular. It ranked first and enriched the top N, which
means a phone ranked low _because_ its specs were unknown never got enriched, so
it stayed low. The ranking was deciding what it was allowed to learn.

Resolution now happens between grouping and ranking, for every candidate:

```
scrape -> normalise -> classify -> group -> RESOLVE SPECS -> rank
```

|                    | before   | after        |
| ------------------ | -------- | ------------ |
| avg fields known   | 4.2 / 11 | **7.1 / 11** |
| chipset known      | 10 / 48  | **28 / 48**  |
| average confidence | 41%      | **68%**      |

It is affordable because specs do not change. A persistent cache
(`.cache/specs.json`, keyed by URL with tracking parameters stripped, 30-day
TTL) makes repeat runs free: the cold run took 21s for 61 pages, the warm run
0.8s for the same catalogue. Paid transports stay behind `--use-unlocker`; the 8
unresolved products are Amazon, which blocks direct fetch.

### The knowledge base audits itself now

Fetching every page made a long-standing gap cheap to close: comparing what the
KB claims against what the merchant states. The very first run found three:

```
POCO M7 5G: KB says Snapdragon 4s Gen 2, page says Snapdragon 4 Gen 2
```

Investigating that produced a subtlety worth recording. The page does not say
"Snapdragon" at all — Flipkart writes
`128 GB ROM 4 Gen 2 5G | Octa Core
Processor`, dropping the vendor name.
`Snapdragon 4 Gen 2` and `4s Gen 2` are different silicon, so the abbreviation
is lossy and cannot be trusted to overwrite a confident hand-entered value.

So `matchSocDetailed()` now reports whether the matching alias named a vendor.
Unambiguous page values overwrite the KB automatically; abbreviated ones are
kept as-is and surfaced for a human to settle. Both paths are tested.

This is the only mechanism in the project capable of catching a KB entry being
_wrong_ rather than merely missing, which matters because that file is
hand-maintained and I am the one who typed it.

---

## Round 9: an external spec database, because guessing does not scale

An audit of where every field came from produced two findings. The first was
that the resolver was reading the wrong half of the page (fixed in round 8). The
second was worse: **merchant pages are actively wrong, not merely incomplete.**

```
POCO C75 5G     page says 240Hz   — that is the touch sampling rate, not refresh
POCO C75 5G     page says 10W     — actual 18W
Samsung M07     page says 45W     — actual 25W
Moto G35        page says 60Hz    — actual 120Hz
```

Confidently wrong data is worse than missing data, and no amount of better regex
fixes a source that states the wrong number. The knowledge base was no better: I
typed it from memory, and every AnTuTu figure in `soc.ts` is an approximation I
recalled rather than measured.

So specs now come from a dedicated spec database (GSMArena), which also
publishes _measured_ benchmarks:

```
Chipset  Mediatek Dimensity 7025 Ultra (6 nm)
Battery  5110 mAh   Charging 45W
Display  AMOLED, 120Hz, 6.67", 1080 x 2400
Tests    AnTuTu: 442015 (v10)   GeekBench: 2452 (v6)
```

Precedence is now `spec database > merchant page > knowledge base > title`, and
a measured AnTuTu replaces the approximation from `soc.ts` whenever one exists.

### Three problems that had to be solved

**Search is behind a bot challenge.** `results.php3` returns a Cloudflare
Turnstile page, so model → URL cannot be resolved by searching. Brand listing
pages are plain static HTML, so an index is built from those instead:
`deno task index` walks 17 brands and caches 1,849 models.

**Guessing a URL returns another phone's specs.** Early on I hand-wrote a
plausible URL and got a completely different handset's spec sheet back. Every
resolution is therefore verified against the page's own title before its data is
accepted, and prefix matching was removed entirely after it silently resolved
"Redmi Note 14 5G" to "Redmi Note 14s" — one character apart, different chipset.
An inexact name now simply does not resolve.

**Rate limiting is real.** Roughly 140 rapid requests during development earned
an HTTP 429, which first appeared as a baffling intermittent "19 matched" then
"0 matched". Requests are now sequential and paced at 1.1s, every resolved model
is cached permanently, and a 429 aborts the remaining queue immediately rather
than grinding through it collecting failures. Re-running later resumes from the
cache.

### Sub-brands

POCO and Redmi are indexed under Xiaomi (`xiaomi_poco_m7_pro_5g`), iQOO under
vivo, CMF under Nothing. Without that mapping the brand filter excluded exactly
the phones that top the rankings.

### Still open

The chipset conflict on POCO M7 5G is now corroborated by two independent
sources — the Flipkart page and the spec database both say Snapdragon 4 Gen 2,
against `models.ts` which says 4s Gen 2. That entry should be corrected.

---

## Round 10: the false-positive that reached #1

Re-running the full pipeline after the rate limit expired produced this:

```
#1  Peace SC26 5G  —  Apple A17 Pro  —  AnTuTu 1,600,000  —  conf 80%
```

A Rs 8,988 white-label handset credited with an iPhone 15 Pro chipset, ranked
first, at high confidence. The cause was in the resolved page text:

```
"… FREE delivery Wed, 26 Aug Feedback Aulumu A17 for iPhone 17 Pro Max
 Magnetic Thermal Case | CoolHyper …"
```

An Amazon recommendation carousel. The bare alias `"a17"` matched a phone case's
brand name.

This is the sharpest illustration so far of the project's recurring theme: _more
data is not automatically better data_. Round 8 widened the input to the whole
page, and the wider input carried other products' names into the spec extractor.

Two fixes, both general rather than patching the one symptom:

1. **Apple aliases now require the vendor word.** `"apple a17"`, `"a17 bionic"`
   and `"a17 pro"` match; bare `"a17"` no longer exists as an alias.
2. **Any vendor-less alias requires processor context.** `"T7250"`, `"4 gen 2"`,
   `"g99"` only resolve when words like _processor_, _chipset_, _octa-core_ or
   _GHz_ appear within 70 characters. That keeps the Flipkart abbreviation
   working ("128 GB ROM T7250 | Octa Core Processor") while rejecting the same
   token loose in unrelated copy.

Both are pinned by regression tests using the exact carousel text.

### Two operational findings

**The model index must not live in `.cache/`.** Tooling treats that directory as
disposable and wipes it, which silently disabled the entire spec database — the
run reported "0 measured benchmarks" with no error. The index is now committed
at `data/gsmarena-index.json` (1,179 models, 88 KB), so a fresh clone works
without a rebuild.

**The rate limit is tighter than the work required.** Building the index costs
~55s of paced requests, and doing that plus resolving a 48-product catalogue in
the same hour reliably earns an HTTP 429. The mitigation is already in place —
resolved models are cached permanently, and a 429 aborts cleanly and resumes on
the next run — but populating a fresh catalogue from the free transport is a
patience exercise. `--use-unlocker` routes through Web Unlocker for anyone who
would rather spend a few requests than wait.

---

## Where correct specs actually come from

Every candidate source was probed rather than assumed. Results:

| source                                                        | result              | notes                                                                                    |
| ------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| GSMArena product pages                                        | **works**           | full specs plus _measured_ AnTuTu/GeekBench; HTTP 429 under load                         |
| GSMArena search                                               | blocked             | Cloudflare Turnstile — hence the offline model index                                     |
| Flipkart embedded JSON                                        | works, partly wrong | free and rich, but states touch sampling rate as refresh rate, and 45W for a 25W charger |
| Samsung / Xiaomi official                                     | works               | authoritative for own models; needs a parser per brand; no white-label coverage          |
| PhoneArena, 91mobiles, Gadgets360, Kimovil, Geekbench Browser | HTTP 403            | hard-blocked to unknown clients                                                          |
| Wikidata                                                      | reachable           | effectively no coverage of Indian budget phones                                          |
| Amazon product pages                                          | blocked direct      | bot page; resolves through Web Unlocker                                                  |

The conclusion is not that a better source exists — it is that the good source
needs a better **transport**. Web Unlocker bypasses both the 429 and the 403s,
and because specs are cached permanently it costs one request per model, once.

`--use-unlocker` grants _permission to fall back_, not an instruction to spend.
Free direct fetch is always attempted first, on both merchant pages and the spec
database; the paid transport is reached only when the free one is blocked or
throttled. The first implementation got this wrong for the spec database — it
routed every lookup through Web Unlocker whenever the flag was present, billing
for pages the free transport serves perfectly well. A test now pins the
ordering, and the transport actually used is recorded per cache entry so the run
report can say how many requests were paid for.

`deno task specs` does that bulk work separately from ranking:

```bash
deno task index                                   # once: build the model index
deno task specs "best phones under 15000" \
    --replay runs/latest --use-unlocker           # once per catalogue
deno task rank  "best phones under 15000" \
    --replay runs/latest                          # instant thereafter
```

It is resumable: an interrupted or throttled run keeps everything it resolved,
and re-running continues from there.

### White-label phones have no authoritative source

Peace, Maplin, ringme, Ai+ and similar appear in no spec database at all. For
those the merchant page is the only source, and it is the least reliable one.
The honest outcome is a low confidence score — which is what the pipeline
reports, rather than inventing a plausible-looking spec sheet.

---

## Round 11: the golden set, and the two flaws it found immediately

Every test until now checked that _inputs_ were parsed correctly. None checked
the thing the product promises: that the **order** is defensible. That gap is
how a Rs 8,988 handset with a misparsed Apple A17 Pro reached #1 — nothing
failed, and only reading the output caught it.

Ground truth is awkward here, because the knowledge base is written by the same
author as the ranker; asserting one against the other proves nothing. So
`tests/golden_test.ts` leans on three kinds of claim that do not depend on
anyone's recollection:

1. **Invariants** — true of any correct ranker regardless of weights.
   Determinism. Cheaper is never worse. A Pareto-dominant phone outranks the one
   it dominates. More memory at the same price never loses.
2. **Gates** — promises the CLI makes out loud: budget, category, bounded and
   ordered scores, and confidence that reflects how much is actually known.
3. **Anchors** — orderings that are uncontroversial on the captured fixture,
   plus adversarial products that must _not_ win.

Two anchors failed on first run. Both were real.

**A fabricated MRP still bought a top placement.** Two identical phones at the
same price, same rating; the one claiming "70% off" ranked higher. The
credibility curve only _reduced_ the bonus for an implausible discount — 70% off
still earned about 28 deal points. It now decays to zero by 80%, and beyond 60%
it is treated as a negative signal, because an invented MRP is evidence about
the seller rather than a neutral quirk. The UI already warned about this in the
cons list while the score was quietly rewarding it.

**An unverifiable bargain beat a verified phone.** A Rs 6,499 listing with no
readable specs and no reviews outranked a Rs 13,000 phone with 4.3 stars from
80,000 buyers. Value is spec-points per rupee, and when the spec sheet is
largely imputed that ratio is an assertion rather than a measurement — but it
was being scored at full weight. The value percentile is now scaled by how much
of the spec sheet is real, so a product cannot claim good value on specs nobody
has verified.

Both flaws had survived every previous round of work. Neither was visible in the
fixture's top ten, which is exactly why adversarial synthetic cases earn their
place alongside real captures.

---

## Round 12: eight of the ranked phones could not be bought

Stock status was known for **0 of 48** ranked products. The pipeline was silent
about it rather than honest, and silence defaults to optimism — an unbuyable
phone rendered identically to a purchasable one.

It turned out the answer was already on disk. The product pages fetched during
spec resolution state it plainly, and Flipkart anchors it to the variant:

```
Selected Color: Guava Red   Out of stock   Variant: 128 GB + 4 GB
```

That anchoring matters. After the Apple A17 incident — where an unanchored match
inherited a _carousel product's_ data — the pattern deliberately requires
"Selected Color: … Out of stock" rather than searching the page for the phrase.
A test feeds it carousel text containing "Out of stock" and asserts the result
is `null`, not `false`.

Result on the reference fixture:

```
stock status known   0/48  ->  39/48
out of stock                    8
```

Among them: **Maplin SC26 5G at #7 — the phone that had earlier been badged BEST
VALUE.** Also realme P4 Lite in two configurations, Motorola g35, and ringme
BOLD 17 PRO.

Unavailable products are now struck through with an `OUT OF STOCK` badge, carry
it as the first entry in their cons list, and are excluded from every
superlative badge — you cannot recommend something nobody can buy.
`--in-stock-only` removes them entirely (48 → 41 here). They are still _listed_
by default, because "this exists but is unavailable right now" is useful
information, and a phone that returns to stock tomorrow is worth knowing about.

Delivery estimates come along for free: `Delivery by 24 Aug, Mon` is parsed and
shown, and its presence is itself weak evidence the item is purchasable.

---

## Round 13: what buyers actually say

Star ratings do not discriminate in this segment. Almost every phone in the
fixture sits between 4.1 and 4.3, so the number is nearly information-free — it
cannot tell you which handset overheats.

The text can, and it is reachable. Product pages carry no reviews (they are
rendered client-side), but `/product-reviews/` returns them as plain HTML, along
with the full ratings histogram:

```
18,971 ratings and 1,065 reviews   1★ 1,239  2★ 647  3★ 1,515  4★ 4,233  5★ 11,337
4.0 • Value-for-money  … Good performance.  … Verified Purchase · Mar, 2025
```

That histogram is worth as much as the prose: a 4.2 with 9% one- and two-star
ratings is a different phone from a 4.2 with 25%, and the average hides it.

### Design

A lexicon, not a model — deterministic, testable offline, and wrong in ways a
human can inspect. Ten aspects (battery, heating, camera, display, performance,
build, sound, software, service, value), with polarity judged **per clause**
rather than per review, because a single review routinely says both:

> "Phone speed just wow.. Camera not good."

Whole-review scoring would average that into mush. Clause-level correctly
records performance-positive and camera-negative.

Negation flips polarity, so "camera not good" is a complaint and "no heating
issues" is praise. Heating counts as a complaint whenever it is mentioned
without negation, since nobody praises a phone for heating. A single grumble is
not reported: an aspect surfaces only with at least two mentions outweighing the
other side two-to-one.

### It stays display-only

The counts are shown and never touch the score. Marketplace reviews are
incentivised and gamed, and this project has twice been burned by trusting a
source further than it deserved. Coverage is Flipkart-only — Amazon's review
pages are bot-blocked — so the UI names the source ("39k Flipkart ratings")
rather than implying a market-wide consensus.

### One trap worth recording

The reviews URL must carry the `pid` parameter across from the product URL.
Without it Flipkart serves a page with no histogram and no reviews, which is
indistinguishable from a product nobody has reviewed. The first implementation
silently reported "0 reviews" for half the catalogue.

---

## An aside: `--pages` was measuring two different things

Asked what `--pages 1` does, the honest answer required reading the captured run
rather than the help text.

```
Flipkart  --pages 1  ->  1 seed URL  ->  120 cards, spanning result pages 1-5
Amazon    --pages 1  ->  pages_to_search: 1  ->  16 products, page 1 only
```

The collector platforms paginate internally, so one seed URL already walks
several result pages; the prebuilt Amazon dataset takes the number literally.
One flag, two meanings, and the asymmetry was invisible: Amazon quietly
contributed 8 in-budget products to a 48-product ranking while Flipkart
contributed 65.

Depth is now scaled per platform so a single `--pages` value means comparable
breadth rather than an equal number of requests.

The first version of this note advised leaving `--pages` at 1, on the assumption
that the collector's internal pagination had already exhausted the catalogue.
Measuring new distinct models per result page showed the opposite:

```
page 1: +13 models    page 3: +14    page 5: +12   (cumulative 60)
```

Flat, not decaying. The deepest page we ever see is still contributing models we
have never encountered, so one page is a slice of the market rather than the
market. 120 cards collapse to 60 distinct models; the remainder are colour and
storage variants.

Depth therefore pays, and seeds are now strided to make it pay properly: since
one seed already walks about five result pages, seeding 1, 2, 3 would re-fetch
the same ground. Seeds step 1, 6, 11, so `--pages 3` covers result pages 1-15
instead of 1-7.

---

## Round 14: the first real multi-page run, and what it exposed

A live `--pages 3` run pulled 425 cards across four platforms — the largest
capture yet, and the first genuine test of the whole pipeline. The ranking it
produced was not usable, and the reasons were all upstream of the ranker.

```
#4   Nokia 150 Dual SIM, Rs 2,699 — "20,000 mAh", "8/128GB", "50MP OIS", "5G",
     on a 2.4-inch screen. Badged BATTERY KING.
#13  Motorola A100 Keypad Mobile, Rs 979
#15  Lava Hero Shakti, Rs 956 — badged CHEAPEST
```

No Redmi. No POCO. No realme, iQOO, vivo or OPPO — precisely the brands that
define value in this segment.

### The query was being thrown away

`searchTerm()` discarded the user's words and sent a bare category term: **"best
phones under 15000" became "mobile phone"**. Marketplace relevance is driven by
the phrase, so a generic term returns the long tail — keypad phones, white-label
listings, accessories — while the popular handsets never surface. The budget
facet on the URL cannot compensate; it filters what came back, it does not
change what the site chose to return.

The user's own words are the better query. Only genuine noise is stripped now
("best", "show me", "top"), so the phrase sent is `phones under 15000`, which is
what the original v1 run used and why _it_ returned mainstream phones.

### Feature phones are not smartphones

Keypad phones match every signal a title can carry — "Mobile Phone", "Dual SIM",
a familiar brand — so they sailed through the classifier. They are now their own
category, recognised before the phone rule and rejected for phone queries.

### Impossible specs are now rejected

That Nokia's "20,000 mAh" and "50MP OIS" came from a _Similar products_ carousel
— the same contamination class as the Apple A17 incident, which is now three
separate occurrences. Beyond the earlier anchoring fixes, values are
bounds-checked: battery outside 1,500-12,000 mAh, refresh rates that are not
real panel rates, cameras beyond 250MP. And a screen under 4.5 inches
invalidates the panel-related fields wholesale, because whatever was matched
alongside it came from somewhere else on the page.

### What the run got right

Worth recording, because it was not all bad. Cross-platform matching finally
fired — several products showed `+1 more` with offers on both Flipkart and
Amazon. Availability caught real out-of-stock listings. Review mining ran on 128
pages. The spec database resolved 48 models before throttling. Amazon returned
235 cards against 168 from Flipkart, so the per-platform depth scaling worked.

---

## What is still worth doing

1. **Amazon PDPs need a transport.** Direct fetch gets a bot page, so Amazon
   listings cannot be enriched. Options: reuse the DCA collector against product
   URLs (same credit type already in use, no KYC), or accept that Amazon rows
   keep lower confidence than Flipkart ones.
2. **Capture a mid-range payload.** The 35 models added in round 4 target
   ₹15k–45k and are completely unexercised by the current fixtures. One
   `find "best phones under 30000"` run would prove or disprove the KB's value.
3. **Reliance and Tata CLiQ have no verified payload.** Their URL builders are
   fixed but unproven — Reliance's only capture is accessories from the wrong
   URL, Tata CLiQ's is a crawler error. Start with
   `deno task doctor --query "best phones under 15000"` to eyeball the URLs for
   free, then `deno task heal reliance --dry-run` to see the diagnosis without
   changing anything.
4. **Review sentiment.** Designed and shown feasible above; not yet built.
5. **Amazon pagination.** The prebuilt dataset is driven by keyword only, so
   `--pages` has less effect there than on the collector platforms.
