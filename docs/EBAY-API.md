# `window.__ebayx` — eBay API

Every call is synchronous except `full()`.

Published by `src/ebay-claude-bridge.user.js` on `www.ebay.com`. Read-only: it makes no network
requests and clicks nothing. See [AMAZON-API.md](AMAZON-API.md) for the other half — the two
records are deliberately different shapes, and comparing them field-for-field is a mistake.

```js
await __ebayx.full()               // item / search — dispatches on page type
await __ebayx.full({limit: 40})    // search page, more rows (default 24)
__ebayx.health()                   // selectors, plus whether the variant payload still parses
```

Every record is pruned of nulls and empty branches, and long strings are capped.

---

## `full(opts?)` → Promise\<object\>

Common envelope on every page:

```json
{
  "type": "item",
  "url": "https://www.ebay.com/itm/225056546791",
  "itemId": "225056546791",
  "title": "…",
  "capturedAt": "2026-08-27T…Z",
  "_v": "0.4.0",
  "_missing": ["item.condition"],
  "_warn": "2 caveat(s) on this capture: search._warn, search._auctionWarn — read them before reporting."
}
```

**`_missing` and `_warn` are lifted from the sub-records onto the envelope.** Through 0.1.0 they
were not: `item()._missing` sat at `.item._missing` while `._missing` was undefined, so a caller
following the documented "check `_missing` on every result" instruction got a clean bill of health
on a record with a hole in it. The nested copies are still there — the envelope is an index, not a
move, and `_warn` names where the prose lives rather than repeating it.

If the page is interposed, `blocked` is set and `error` says what to do:

| `blocked` | Meaning |
|---|---|
| `challenge` | `/splashui/challenge`, "Pardon Our Interruption" |
| `transient-error` | "Something went wrong on our end", with a trace id |

Both clear the same way: **one ~5s wait, one re-navigation of the identical URL, then stop.**
Never interact with the challenge, and never loop.

---

### On a search page

**Rows live under `search.rows` here and `search.results` on Amazon.** Different keys, same
idea. Reading the wrong one looks like an empty search, and did, in a cross-market session.

```json
{
  "search": {
    "query": "vans sk8-hi womens 9",
    "shown": 24,
    "scanned": 70,
    "rows": [
      {
        "itemId": "168604533032",
        "url": "https://www.ebay.com/itm/168604533032",
        "title": "Vans Sk8-Hi …",
        "condition": "Pre-Owned",
        "sizeHint": "US W 9",
        "aspects": ["US W 9", "VANS"],
        "price": 9.95,
        "currency": "USD",
        "shipping": { "text": "+$5.80 delivery", "cost": 5.8 },
        "total": 15.75,
        "saleFormat": "bin",
        "bestOffer": true,
        "watchers": 10
      }
    ],
    "_warn": "Sponsored placements are NOT filtered out of these rows …"
  }
}
```

**`total` is the sort key, not `price`.** On a live 60-row search, 57 of 60 positions changed
between the two orderings.

**`sizeHint` is a hint.** It is the listing's own aspect and is *not* stock-checked — a card
advertising `US W 9` belonged to a listing whose variant map marks that size out of stock. Only
`variants()` on the item page knows.

**`_warn` about ads is always present and must be carried through.** `__ebayx` does not attempt
sponsored detection: across a 70-card search the only candidate signal matched 70 of 70 cards,
while forward `Sponsored` text and every class/aria candidate matched 0. Promo cards are dropped
by requiring an `itemId`, not by ad detection.

**Rows are collected from the results river and de-duplicated by item id.** Two things made that
necessary. The candidate selectors are nested — `.su-card-container` sits inside `.s-card` — so a
joined selector returned 140 nodes for 70 cards, every result twice at adjacent indices; rows are
taken from the first candidate that matches anything instead. And the page renders a "similar
items" carousel using the same card markup, whose entries also appear below. `scanned` is how many
nodes were examined and `duplicatesDropped` appears when any were collapsed.

**`_auctionWarn`** appears when any row is an auction. `price` on those rows is the current bid
and will rise. `saleFormat` is `auction`, `bin`, `auction+bin`, or **`unknown`** — never a silent
default. `bin` is set by *Buy It Now* **or** *or Best Offer*, since eBay renders fixed-price-with-
offers without a Buy It Now row; reading only the latter left 51 of 65 rows unclassified on a
Buy-It-Now-only search. `bestOffer: true` marks the negotiable ones. `_formatWarn` counts the
unknowns, and `rowsWithoutTotal` / `_totalWarn` count rows whose shipping could not be read.

Shipping has three distinguishable states:

| Output | Meaning |
|---|---|
| `{free: true, cost: 0}` | genuinely free |
| `{cost: 5.83}` | a parsed surcharge |
| `cost` absent | **did not parse.** `total` is absent too, deliberately — never treat unknown as zero |

**A facet filter can eat the page, and since 0.4.0 that is detected.** On 2026-09-03,
`&Size=L&Color=Black%7CGray` on a 300-result query rendered **0 rows** with no error and no
warning. The page is mechanically distinguishable from an empty search — a result count, no rows,
filters on the URL — so `search()` reports:

| Field | Meaning |
|---|---|
| `filterParams` | the narrowing parameters on the URL (`["Size=L", "Color=Black\|Gray"]`); `_nkw`, `_sop`, `_pgn` and tracking noise are excluded |
| `appliedFilters` | what the page's own chips say is applied (`["Size: L", "Black", "Gray"]`), in either of the two layouts eBay serves for the same URL — separate chips, or a collapsed "3 filters applied" flyout. Both mark each applied aspect with a "Remove filter" affordance, which is what the extractor keys on |
| `_emptyWarn` | zero rows: names the count, the filters, and says to drop them and filter in your own analysis. With nothing on the URL it points at `health()` instead |

The same URL rendered 64 rows on another machine the same day, so treat the failure as
intermittent rather than as a property of those parameters.

---

### On an item page

```json
{
  "item": {
    "itemId": "225056546791",
    "title": "*NEW* Unisex VANS SK8-HI BLACK / BLACK / WHITE (VN000D5IB8C)",
    "condition": "New with box",
    "price": 51.9,
    "currency": "USD",
    "discount": { "was": 55.21, "pct": 6, "text": "Was US $55.21 (6% off)" },
    "shipping": { "free": true, "cost": 0, "from": "Wheeling, Illinois, United States" },
    "total": 51.9,
    "returns": { "accepted": true, "days": 30, "shippingPaidBy": "buyer" },
    "seller": { "name": "…", "feedbackCount": 31571, "positivePct": 99.9 },
    "quantity": { "available": 2, "sold": 236 },
    "specifics": { "Brand": "VANS", "Model": "VN000D5IB8C", "…": "…" },
    "styleCode": "VN000D5IB8C",
    "images": { "count": 9, "url": "https://i.ebayimg.com/images/g/…/s-l1600.webp",
                "description": "Black high-top canvas sneakers with white laces, on a wooden floor." }
  }
}
```

`_missing` lists which of `title`, `price`, `condition`, `seller` came back empty, and is also
lifted onto the envelope.

**`condition` falls back to item specifics, and that path is the common one.** On a pre-owned
listing there is no condition element on the page at all — `[data-testid="x-item-condition"]`,
`.x-item-condition-value` and every `/condition/i` class miss. The value survives in the
item-specifics form with eBay's boilerplate essay appended, so the grade before the first colon is
taken: `"Pre-owned - Good: This item has been gently used…"` → `"Pre-owned - Good"`. `health()`
distinguishes the two outcomes explicitly — `item.condition (recovered from item specifics)` versus
`item.condition (no slot AND no specifics entry — genuinely gone)`.

**`quantity` is absent, not broken, on single-item listings.** Those pages render no quantity
widget and carry no "N available" / "N sold" text anywhere.

**`returns` is a tri-state**, and on anything that might not fit it is the highest-signal field on
the page:

| Page text | Parsed |
|---|---|
| `30 days returns. Seller pays for return shipping.` | `{accepted: true, days: 30, shippingPaidBy: "seller"}` |
| `30 days returns. Buyer pays for return shipping.` | `{accepted: true, days: 30, shippingPaidBy: "buyer"}` |
| `Seller does not accept returns.` | `{accepted: false}` |

**Never print `positivePct` without `feedbackCount`.** 100% across 32 sales and 99.7% across
10,025 are different objects, and the card shows the less informative one.

**`specifics` beats the title where they disagree.** One listing titled *"Men's 8 / Women's 9"*
carried `US 8 / UK 7 / EU 40.5` in its own specifics, and Vans men's 8 is women's 9.5 — the seller
converted by hand and got it wrong by half a size.

`styleCode` reads **`Style Code`, then `MPN`, then `Model`** — the order matters. Until 0.3.0 it
checked `Model` first, which is a model-*family* name shared by every colorway (item
186246168843: `Model: "Sk8-Hi Mte-1"`, `Style Code: "VN0A5HZYY49"`), so the field returned the
opposite of what it documents. It is the only reliable colorway identifier on a platform where one
shoe is listed as "Burnt Ochre", "Tan" and "Brown" by three different sellers, and dedupe depends
on it.

**`_silhouetteWarn` fires when the specifics carry `Style`, `Leg Style`, `Silhouette` or `Fit`.**
Those are dropdowns the seller clicked past on the way to listing; the typed fields on the same
form are claims about a tape measure. Verified 2026-09-03 on a listing whose form was unusually
complete — `Inseam: 28.5 in`, `Rise: High`, `Waist Size: 30 in`, all right — and `Style: Ankle`
on a garment the photographs show to be a flare. The warning names the field and its value and
stays silent on the measurements, or it becomes the always-on kind nobody reads.

**`images` is as far as markup takes a photograph.** `count` is the number of distinct photos,
`url` the first one at full size (`s-l1600`; the carousel serves `s-l500`), and `description` is
eBay's own machine-written caption of the first photo, which is the only textual path from the
picture to the caller. To see the picture itself, navigate a tab to `url` and take a screenshot —
the route, and what does not work, are in the skill.

---

## `variants(opts?)` → object | null

The most valuable call in the library, and it needs **no click and no request** — everything comes
from a static `<script>` at document-idle, anchored at `"MSKU":{"_type":"VariationViewModel"`.

```json
{
  "axes": [
    {
      "axis": "US Shoe Size",
      "availableCount": 8,
      "totalCount": 16,
      "options": [
        { "value": "7.0 US Men / 8.5 US Women", "available": true,
          "qtyAvailable": 3, "sold": 236, "price": 51.9 },
        { "value": "7.5 US Men / 9.0 US Women", "available": false, "sold": 236, "price": 51.9 }
      ]
    }
  ],
  "variationCount": 16,
  "price": { "min": 51.9, "max": 51.9, "distinct": 1 }
}
```

Returns `null` on a single-SKU listing — `full()` then sets `variantsNote` saying so, and
`health()` distinguishes "no variants here" from "the anchor moved".

**Unlike Amazon, eBay ships per-variant prices.** `price.{min,max,distinct}` is computed across
the whole listing. `_warn` fires when `min !== max`.

Three traps, all handled, documented so the output shape makes sense:

- **The option key space is flat and global across axes.** A 4-axis listing puts all 29 options in
  one map, each axis owning a disjoint slice. `axes` is built by grouping through `selectMenus`;
  anything iterating the raw map gets sizes, colours and pack counts jumbled together.
- **An option can span many SKUs.** Single-axis listings pin one; a 4-axis one ran to 137. So on a
  multi-axis listing each option reports `priceFrom` / `priceTo` and `skus` instead of `price`,
  omits quantity, and `_multiAxis` explains why.
- **`enabled` is selection state, not availability.** Every option is `enabled: false` on a freshly
  loaded page. `available` comes from `outOfStock`.

eBay's own `showMskuPriceRange` flag is **not** a variance signal — it was `false` on a listing
spanning $12.90 to $49.90 across 7 distinct prices.

---

## `health()` → object

Which selectors resolve on the current page, split into `ok` / `absent` / `broken`. `absent`
covers fields legitimately missing on healthy pages (no discount, no delivery row), so a real
break is not buried in expected noise.

On item pages it additionally reports `item.mskuModel` with the axis and variation counts, because
the variant payload is not a selector and the loop cannot otherwise see it.

## Narrower calls

| Call | Returns |
|---|---|
| `page()` | the envelope only — type, url, itemId, blocked |
| `item()` | the item record |
| `search(opts?)` | the search record |
| `specifics()` | the item-specifics map alone |
| `seller()` | the seller object alone |
| `text(max?)` | rough visible text, for page types with no extractor |

## Failure modes worth knowing

- **`li.s-item` is dead.** Every scraping guide online still uses it; it matched 0 nodes against 70
  for `.su-card-container`. It survives only as the last fallback candidate.
- **`[role="option"]` nodes look usable and are not.** They carry the label and a
  `data-sku-value-name`, but no stock state — `/out of stock/i` matches nowhere in the page text on
  a listing with five dead sizes. Availability comes from the variant payload only.
- **The MSKU anchor is a single point of failure** for the best data on the site. It is a typed
  model name rather than a content-hashed CSS class, so it should outlast the selectors around it —
  but if it moves, `variants()` returns `null` and `health()` says which case you are in.
