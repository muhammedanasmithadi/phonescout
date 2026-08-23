# Data sources

Every source below was probed from this machine, not assumed. Reachability is
what decides whether a source can be used at all, and several well-regarded ones
cannot be reached without paying for a proxy.

Trust order follows the usual hierarchy: the manufacturer is always right about
its own hardware, independent databases are broad but occasionally confuse
variants, and lab measurements are the most accurate and the narrowest.

## Probe results, 2026-08-21

| Tier | Source                               | Status                                                   | Verdict                                                |
| ---- | ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------ |
| 1    | realme.com/in                        | **200**, JSON-LD spec block                              | usable                                                 |
| 1    | mi.com/in                            | **200**                                                  | usable                                                 |
| 1    | apple.com/in specs                   | **200**                                                  | usable                                                 |
| 1    | samsung.com, oneplus.in, motorola.in | reachable, **no derivable URL**                          | needs per-brand discovery                              |
| 1    | FCC OET database                     | **403**                                                  | unusable free; radio bands only, which we do not score |
| 2    | GSMArena                             | **200** (after redirect)                                 | primary, but rate-limits hard                          |
| 2    | Beebom Gadgets                       | **200**, no throttling observed                          | best coverage of the Indian budget shelf               |
| 2    | nanoreview                           | **200**, AnTuTu v11 + Geekbench 6 per chip               | benchmark calibration source                           |
| 2    | Kimovil                              | **403**                                                  | unusable free                                          |
| 2    | DeviceSpecifications                 | 200 but **opaque URLs** (`/model/<hash>`)                | not addressable without their search                   |
| 2    | PhoneDB                              | **connection refused**                                   | unusable                                               |
| 3    | DXOMARK                              | 200, but device links are **JS-rendered**; flagship-only | not usable yet, and irrelevant sub-₹15k                |
| 3    | DisplayMate                          | 200, article-based, no per-model addressing              | not machine-readable                                   |

## Marketplaces

| Platform         | Default | Why                                                                                                     |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| Flipkart         | **on**  | 156 cards, 70 in category, 88% field fill                                                               |
| Amazon India     | **on**  | 162 cards, 138 in category, 88% field fill                                                              |
| Reliance Digital | **off** | returns accessories, not phones; 0 in-category products in every recorded run                           |
| Tata CLiQ        | **off** | its collector's product selector no longer matches the site; 1 usable product from 35 cards, after 276s |

Both disabled platforms are BrightData-hosted collectors: this repo supplies the
seed URL, and the extraction runs inside the collector. Tata CLiQ says so in its
own error, waiting for selector "a[id^="ProductModule-"]" failed, which is the
collector's selector, not ours. Reliance's seed URL is a correct search endpoint
yet it returns earphones, so its collector appears to read an accessories rail
instead of the product grid.

Neither can be fixed from here: this repo supplies the seed URL and the
extraction runs inside the collector. They stay in the default set anyway,
because breadth is the point and the run reports what each one contributed:

    Reliance Digital returned 11 cards and no phones; its collector returns
    accessories rather than phones …

Narrow the set when you want a fast run:

    deno task find "best phones under 15000" --platforms flipkart,amazon

## What each source is actually used for

**Chipset and spec sheet, per phone.** GSMArena first, Beebom second. Neither is
authoritative: the audit caught Beebom reporting the Redmi 14C **5G** with the
4G model's Snapdragon 4 Gen 2. So a high-confidence knowledge-base entry is
never silently overwritten by either; the disagreement is raised instead.

**Benchmarks, per chip.** nanoreview only, via `deno task calibrate`. Not per
phone, and deliberately so. The performance score is _relative_, and only some
phones resolve against a live source, so pulling a measured figure per phone
mixes AnTuTu v10 and v11, a 20-45% difference that lands on the ranking looking
like a hardware gap. One source, one version, applied to every phone on that
chip at once.

Its per-phone coverage of the Indian budget shelf is thin (1 of 8 sampled),
which is exactly why it is used for chips rather than phones.

**Marketplace facts** (price, MRP, rating, review text, stock) are scraped live
every run and never come from any of the above.

## Known caveats

- GSMArena quotes **manufacturer-claimed** peak brightness, which runs 10-20%
  high, and rounds PPI. We do not score brightness for this reason.
- Beebom mixes benchmark versions between pages, so its numbers are read for
  specs but never for the performance scale.
- Unisoc's budget parts are missing from nanoreview's chip pages. They are
  measured off phones that use them (T760 from the Moto G35, T8300 from the
  Redmi A7 Pro 5G) or bridged via the Tiger T615, which two sources publish.
- White-label phones (Ai+, ringme, Peace, Yunicorn, Maplin) publish no specs
  anywhere. `SoC ?` on those rows is the correct answer, not a gap to fill.

## Keeping it honest

    deno task audit       KB vs a live source, per phone
    deno task calibrate   chip table vs the benchmark source

Three tests fail the build if the chip table drifts off one scale, inverts a
known hardware ordering, or names a chipset that does not exist in it.
