# eBay — `window.__ebayx`

Site-specific reference. The preflight, tier ladder, blocked-page rules and reporting rules are in
[SKILL.md](../SKILL.md) and apply here too. In particular: **never `WebFetch` an eBay URL**, and
never touch *Place bid*, *Make offer*, *Buy It Now* or a cart control.

```js
await __ebayx.full()                 // item / search — dispatches on page type
await __ebayx.full({limit: 40})      // search page, more rows (default 24)
__ebayx.health()                     // which selectors still resolve, plus the variant map
```

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
orderings. A worked example from that page: `$8.99 + $8.07 = $17.06` ranks *below*
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

`styleCode` (from `Model` / `MPN`) is the **only reliable colorway identifier** on a platform where
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
