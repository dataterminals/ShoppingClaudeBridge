# eBay — `window.__ebayx`

Site-specific reference. The preflight, tier ladder, blocked-page rules and reporting rules are in
[SKILL.md](../SKILL.md) and apply here too. In particular: **never `WebFetch` an eBay URL**, and
never touch *Place bid*, *Make offer*, *Buy It Now* or a cart control.

```js
await __ebayx.full()                 // item / search — dispatches on page type
await __ebayx.full({limit: 40})      // search page, more rows (default 24)
__ebayx.health()                     // which selectors still resolve, plus the variant map
```

Search rows are under **`search.rows`** here and **`search.results`** on Amazon. Same idea,
different key; reading the wrong one looks like an empty search, and did, once.

## Two shapes of blank you should know about

**`condition` usually arrives via item specifics, not its own field.** On pre-owned listings eBay
renders no condition element at all, so the extractor falls back to the specifics form and keeps
the grade before the colon — `"Pre-owned - Good"`. If you ever see `condition` empty *and*
`health()` saying `no slot AND no specifics entry`, that is a genuine gap, not the normal path.

**`quantity` empty is normal.** A single-item listing renders no quantity widget and no
"N available" text. It is reported as absent rather than broken for that reason.

## Rank on `total`, never on `price`

Every search row and item carries `{price, shipping, total}`. `total` is the sort key.

On a live 60-row search for "vans sk8-hi womens 9", **57 of 60 positions changed** between the two
orderings; a re-measure on a different query the same day gave 47 of 60. Both are snapshots of one
page — the magnitude is the durable claim, not the constant. A worked example from that page: `$8.99 + $8.07 = $17.06` ranks *below*
`$9.95 + $5.80 = $15.75`, and sticker price says the opposite. Postage is a seller margin lever on
eBay in a way it is not on Amazon.

`_sop=15` sorts by price+shipping server-side and is the right default, but **the cards still
display only the item price**, so anything reading them has to compute the total anyway.

Two shipping states are distinct and must not be collapsed:

- `shipping.free === true` with `cost: 0` — genuinely free.
- `cost` **absent** — the cost did not parse. `total` is then absent too, deliberately, rather
  than silently treating unknown as zero. Do not rank such a row against rows that have a total;
  say it needs opening.

## The search index lies about stock — `sizeHint` is never `size`

A result card's size aspect (`Brand New · VANS · US W 9`) is a listing **aspect**, not an
inventory check. Verified on item `225056546791`: the card advertised `US W 9` while the listing's
own variant map marks 9.0 US Women **out of stock**. Good seller, good price, wrong reality.

**It is also only populated when eBay's own size facet is applied.** Measured: 0 of 60 rows on an
unfiltered search carried a `sizeHint`, against 37 of 40 on a facet-filtered one. That is correct
behaviour — it reads the subtitle aspect, not the title — but sixty nulls do not mean sixty
listings without size information, and reading it that way would rule out the whole page.

The field is called `sizeHint` for that reason. Treat it as a filter hint only. **`variants()` on
the item page is the only stock truth**, and checking it is what kills the listings that look
perfect from search.

## `variants()` — the whole point, and three traps

Everything comes from a static `<script>` payload at document-idle: every option, its stock state,
its price, its remaining quantity. **No click is required**, and none is performed — the size
dropdown's click only makes eBay render a label it already has.

Unlike Amazon, **eBay ships per-variant prices**. `price: {min, max, distinct}` is computed across
the whole listing.

Three traps, each of which produces confident nonsense rather than an error. The library handles
all three; they are documented so a reader knows why the output is shaped as it is:

1. **The option key space is flat and global across axes.** On a 4-axis listing (Size Type × Size ×
   Pack Size × Colour), all 29 options live in one map and each axis owns a disjoint slice.
   Anything iterating that map directly gets sizes, colours and pack counts jumbled together.
2. **An option can span many SKUs.** On single-axis listings each option pins exactly one; on the
   4-axis one the counts ran to 137. So on a multi-axis listing the library reports a price
   **range** per option and omits quantity, and sets `_multiAxis`. If an exact price matters,
   navigate to the specific SKU.
3. **`enabled` is not availability.** It tracks selection state, and on a freshly loaded page every
   option is `enabled: false`. `available` in the output comes from `outOfStock`.

Also: eBay's own `showMskuPriceRange` flag is **not** a price-variance signal — it was `false` on a
listing spanning $12.90 to $49.90 across 7 distinct prices. Read `price.min` / `price.max`, and
`_warn` fires when they differ.

## Build search URLs directly

Base: `https://www.ebay.com/sch/i.html?_nkw=<query>`

| Parameter | Effect |
|---|---|
| `&_sop=15` | **Price + shipping, lowest first — the right default** |
| `&_sop=12` | Best match (eBay's default) |
| `&_sop=10` | Newly listed |
| `&LH_BIN=1` | Buy It Now only — drops auctions |
| `&LH_ItemCondition=1000` | New only (`1500` open box, `3000` used) |
| `&_udlo=25&_udhi=75` | Price range, in **dollars** (Amazon's is in cents — don't mix them up) |
| `&rt=nc&_pgn=2` | Pagination |

Only `_nkw`, `_sop=12` and `_sop=15` were exercised directly; the rest are conventional. Same rule
as Amazon's `rh` nodes: if a filtered search returns zero or nonsense, **drop the filter and filter
in your own analysis** rather than retrying parameter guesses.

That failure is now detected rather than left to memory. On 2026-09-03 `&Size=L&Color=Black%7CGray`
on a 300-result query rendered **0 rows** with no error and no warning. `search()` reports
`filterParams` (the narrowing parameters on the URL), `appliedFilters` (what the page's own chips
say is applied, in either of the two layouts eBay serves), and **`_emptyWarn`** when there are no rows — naming the count and the filters, or
pointing at `health()` when the URL carried none. The same URL rendered 64 rows on another machine
the same day: intermittent, not a property of those parameters, so one unfiltered re-run is the
right response and a retry loop is not.

Item pages: `https://www.ebay.com/itm/<itemId>`.

## Ads are NOT filtered, and you must not imply otherwise

`__ebayx` does not attempt sponsored detection, because every available signal is wrong. Probed
across a 70-card search: the reversed literal `derosnopS` matched **70 of 70** cards, forward
`/Sponsored/i` matched **0**, and `[class*=sponsored]` / `[aria-label*=Sponsored]` matched **0**.
Filtering on the only candidate would hide the entire page.

The result carries a `_warn` saying so. Carry it through to the user. On Amazon you must state the
count of ads removed; on eBay you must state that none were.

Promo cards ("Shop on eBay") are dropped, but by requiring an item id — not by ad detection.

Rows are also scoped to the results river and de-duplicated by item id, so the "similar items"
carousel does not pad the shortlist. `duplicatesDropped` appears when any were collapsed.

## Rows you must not rank, and rows whose price is not a price

`searchResults()` counts both and warns:

| Field | Meaning |
|---|---|
| `rowsWithoutTotal` + `_totalWarn` | shipping could not be read, so `total` is absent. Do not rank these against rows that have one — open them instead |
| `saleFormat: "unknown"` + `_formatWarn` | no readable sale format. Treat `price` as unverified |
| `duplicatesDropped` | the same listing rendered twice (carousel plus river) and was collapsed |

`saleFormat` is `bin` when the row says *Buy It Now* **or** *or Best Offer* — eBay renders
fixed-price-with-offers without a Buy It Now row, and reading only the latter left 51 of 65 rows
on a Buy-It-Now-only search unclassified. What is left over is `'unknown'`, never a silent
default to `bin`: an auction whose bid text did not parse would otherwise sit in the price column
looking like a purchase price.

## Auctions are a different unit of comparison

`price` on an auction row is the **current bid** and will rise. `saleFormat` is one of `auction`,
`bin`, `auction+bin`, and `_auctionWarn` fires when any row is an auction. Never put a bid in the
same column as a Buy It Now price without labelling it — the auction row will look like the
cheapest option and it isn't a price at all.

## Fields that price the risk

**`returns` is a tri-state, and the highest-signal field on the page.**

| Observed | Parsed |
|---|---|
| `30 days returns. Seller pays for return shipping.` | `{accepted: true, days: 30, shippingPaidBy: 'seller'}` |
| `30 days returns. Buyer pays for return shipping.` | `{accepted: true, days: 30, shippingPaidBy: 'buyer'}` |
| `Seller does not accept returns.` | `{accepted: false}` |

On something that might not fit, the gap between the first and third is worth more than $15 of
sticker price, and the middle one quietly costs $10–15 when it goes wrong.

**`seller` is `{name, feedbackCount, positivePct}`** — and per SKILL.md, never print the percentage
without the count. These are all "positive":

| Seller | Feedback | % | Read |
|---|---|---|---|
| 10,025 | 99.7% | joined 2005, 20K sold | trustworthy |
| 106 | 100% | 100% of very little |
| 32 | 96.4% | closet cleanout |
| 0 | — | no history at all |

**Condition is seller-declared and unverified.** The ladder runs `Brand New` / `New with box` /
`New without box` / `New (Other)` / `Pre-Owned`.

> "New without box" is **not** a red flag on its own — it is how sample pairs and
> employee-purchase stock reaches the market, and three of the best-value finds on one real run
> were exactly that. It *is* worth flagging in **combination**: sub-200-feedback seller **and** no
> returns **and** New-without-box. Compute the intersection; don't warn on the condition string,
> or you recreate the always-on warning nobody reads.

## Specifics beat titles, and carry the style code

Titles are seller prose. Item specifics are a form. Where they disagree, the specifics win — one
listing titled *"Men's 8 / Women's 9"* carried `US 8 / UK 7 / EU 40.5` in its own specifics, and
Vans men's 8 is women's **9.5**. The seller did the conversion by hand and got it wrong by half a
size. `item().specifics` surfaces both so you can catch it; a report built off the title ships the
error downstream.

**But a form has two kinds of field, and they fail differently.** A typed measurement (`Inseam:
28.5 in`, `Waist Size: 30 in`, `Rise`) is a claim about a tape measure. `Style`, `Leg Style`,
`Silhouette` and `Fit` are dropdowns the seller clicked past on the way to listing. Verified
2026-09-03 on a listing whose form was unusually complete and ranked second on the strength of it:
every measurement was right, and `Style: Ankle` was a flare, visible in the photographs. `item()`
sets **`_silhouetteWarn`** naming the field and value whenever one of those keys is present, and
stays silent on the measurements. When it fires, the photograph is the check — `images.description`
is eBay's caption of the first photo, `images.url` the photo to screenshot.

`styleCode` reads `Style Code`, then `MPN`, then `Model` — **in that order, and the order is the
whole point.** Until 0.3.0 it checked `Model` first, which is a model-*family* name shared by every
colorway: item 186246168843 carries `Model: "Sk8-Hi Mte-1"` and `Style Code: "VN0A5HZYY49"`, and
the field returned the former. That inverted its own purpose — dedupe on it and three different
colorways from one seller at one price collapse into a single row. It is the **only reliable
colorway identifier** on a platform where
the same shoe is listed as "Burnt Ochre", "Tan" and "Brown" by three different sellers. Use it to
group and to dedupe.

## Collapse duplicate listings

One seller listing the same shoe twice is common — two item ids, same style code, same price, same
seller. In a ten-row shortlist that is two rows of nothing. Dedupe on
`(seller.name, styleCode, price)` when building the table. The library does not do this for you;
it returns what the page returned.

## What eBay can't tell you

**Sold-listing price history exists on the site and is not wired into this skill.** It is real
price history that Amazon does not have — but do not imply you checked it.

**Seller tenure and items-sold** are not in `seller`. They live further down the item page in the
About-this-seller block and would cost a navigation.

**What the photographs show.** `item().images` is as far as markup goes: `count`, the first photo's
full-size `url` (`s-l1600`), and `description` — eBay's own machine-written caption of the first
photo ("Black high-waisted women's leggings with front and side cargo pockets, hanging on a white
plastic hanger."). The caption is real signal and free; it will not always name a silhouette. To
see the picture, navigate a tab to `url` and take a screenshot — the route, and the three routes
that do not work, are in SKILL.md under *Seeing a picture*.
