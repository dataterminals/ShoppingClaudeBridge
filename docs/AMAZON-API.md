# `window.__amzx` — Amazon API

Every call is synchronous except `full()`. (`criticalReviews()` was removed in v0.2.0 and
`offers()` has been synchronous since the fetch path went with it.)

**0.7.0 (2026-09-03) is about the things the extractor could not see and did not say so.**
Review text was silently absent after Amazon renamed two hooks; the star histogram was silently
empty after a class became content-hashed; size charts were a table sweep that returned the wrong
garment's chart with nothing marking it. Now: `reviews()` carries `title`, `body` and `format`
again, `product.rating.distribution` arrives with every product capture, `charts()` enumerates
every size-chart candidate and warns when they disagree, `full({reviews: true})` reads the sample on
the product page (the reviews page redirects a signed-out browser to sign-in), and `health()`
checks the review selectors on any product page that reports ratings.

**Search rows live under `search.results` here and `search.rows` on eBay.** Different keys, same
idea. Reading the wrong one looks like an empty search.

**Search-row `title` is composed from two elements as of 0.6.0.** On current footwear cards Amazon
puts the brand in the `h2` and the product name in a sibling anchor, so the old selector returned
`"Vans"` for 44 of 47 rows. `title` now recombines brand and name, skipping the prefix when the
name already starts with the brand — on categories where the anchor still holds a full title,
blind prefixing would produce "Anker Anker USB C Cable".

**`bullets` reads `#productFactsDesktopExpander` too.** `#feature-bullets` is absent outright on
apparel listings, where the block holds the fit and material notes a sizing question turns on.

**As of 0.5.1, `full()` lifts `_missing` and `_warn` from its sub-records onto the envelope.**
Before that they lived only where they were produced — `product()._missing` at `.product._missing`
with `._missing` undefined — so checking the envelope reported a clean capture on a holed record.
The nested copies stay; the envelope is an index. `_missing` carries paths like `product.price`;
`_warn` names which sub-records carry caveat prose.
All output is pruned: nulls, empty objects and empty arrays are dropped before returning.

## `full(opts?)` → Promise\<object\>

The one you want. Dispatches on page type and returns page metadata plus the matching record.

```js
await __amzx.full()                  // whatever this page is
await __amzx.full({limit: 40})       // search pages: more rows (default 24)
```

Extra data costs a **navigation**, not an option flag — the library makes no network requests.
Navigate to `/dp/<ASIN>?aod=1` and call `full()` again to get `offers`.

Always present: `type`, `url`, `capturedAt`, `_v`. Present when relevant: `asin`, `title`.
On a CAPTCHA or error interstitial it returns `{blocked, error}` and nothing else — a human has to
clear that in the browser.

### On a search page

```jsonc
{
  "type": "search",
  "url": "https://www.amazon.com/s",
  "search": {
    "query": "usb c cable",
    "sortedBy": "relevance",
    "shown": 16,
    "organicTotal": 16,
    "sponsoredRemoved": 6,        // 6 of the 22 result nodes were ads
    "resultCountText": "1-16 of over 70,000 results for",
    "results": [
      {
        "pos": 1,
        "asin": "B07DC5PPFV",
        "title": "Anker USB A to USB C Cable (2-Pack, 6 ft, Black)",
        "price": 9.99,
        "stars": 4.7,
        "ratings": 147100,        // "(147.1K)" on the page
        "prime": true,
        "ownedSince": "Aug 2026", // Amazon says you already bought this
        "url": "https://www.amazon.com/dp/B07DC5PPFV"
      }
    ]
  }
}
```

`badge` and `ownedSince` share one slot on the page. A `Purchased …` badge becomes `ownedSince`;
anything else (`Best Seller`, `Amazon's Choice`) stays in `badge`.

### On a product page

```jsonc
{
  "type": "product",
  "asin": "B07DC5PPFV",
  "product": {
    "title": "...",
    "brand": "Anker",
    "price": { "current": 9.99, "currency": "USD", "unit": "$0.83 / feet" },
    "rating": { "stars": 4.7, "count": 147109,
                "distribution": { "5star": 76, "4star": 12, "3star": 5, "2star": 4, "1star": 3 } },
    "availability": "In Stock",
    "shipsFrom": "Amazon",
    "soldBy": "AnkerDirect",
    "delivery": "FREE delivery Overnight 7 AM - 11 AM ...",
    "category": "Electronics > Computers & Accessories > ...",
    "bullets": ["..."],
    "specs": { "Brand": "Anker", "Connector Type": "USB-C", "...": "..." },
    "url": "https://www.amazon.com/dp/B07DC5PPFV"
  }
}
```

`price.was` appears only when there is a strikethrough list price; `coupon` and `badges` only when
present. **`_missing`** lists any of `title / price / rating / availability / soldBy` that came
back empty — always check it.

#### `coupon` is parsed, not passed through

Coupon text is prose with the largest number on the page inside it, and the qualifier that decides
whether the number is real sits in the same sentence:

```jsonc
"coupon": {
  "pct": 30,
  "applied": true,
  "conditional": true,
  "requires": "first-subscribe-and-save-order",
  "text": "30% off coupon applied. First Subscribe & Save orders only. Shop items | Terms"
}
```

Real capture, 2026-08-27. **Read `conditional` before quoting `pct`.** A 30% coupon that only
exists if you also start a subscription is a decision, not a discount, and a comparison table that
prints "30% off" has told the user something false. `requires` is one of
`first-subscribe-and-save-order`, `subscribe-and-save`, `multi-buy`, `minimum-spend`.

`applied: true` means the discount is already inside `price.current` — subtracting it again
double-counts. Its absence means the coupon still has to be clipped. `amount` replaces `pct` for
flat-dollar coupons, and is deliberately **not** populated when a percentage is present: "10% off,
up to $20" carries both numbers and the $20 is a cap, not a saving.

### Buy Again — `/gp/buyagain`

The page a recurring order starts from. Until v0.5.0 `page()` returned `type: "unknown"` here and
there was no extractor at all.

```jsonc
{
  "type": "buyagain",
  "buyAgain": {
    "shown": 24,
    "hasMore": true,
    "items": [
      {
        "asin": "B0EXAMPLE1",
        "title": "…",
        "price": 10.00,
        "unit": "$9.90/fluid ounce",
        "offers": [
          { "mode": "One-time purchase", "price": 10.00 },
          { "mode": "Subscribe & Save",  "price": 9.50 }
        ],
        "promo": { "pct": 10, "conditional": true, "requires": "multi-buy", "text": "Save 10% when you reorder 5 qualifying items…" },
        "url": "https://www.amazon.com/dp/B0EXAMPLE1"
      }
    ]
  }
}
```

**`offers` is the reason to read this page through the extractor.** On a 24-card capture,
**10 cards had a Subscribe & Save price below the headline price on the card** — the card shows
one number and the cheaper one sits in a pill beside it. Same shape of finding as `offers()` on a
product page.

`was` is emitted only when it genuinely exceeds `price`. A card-wide `[data-a-strike="true"]`
reported `was === price` on 8 of 13 rows, because strike markup outside the offer row re-renders
the *current* price; the selector is scoped to the offer row and excludes the pills. The invariant
check stays in the code as a tripwire and reports through `_warn` if it ever starts firing.

`shown` is what is on the page, not what exists — Amazon paginates behind a **Load more** button
and this library clicks nothing. `hasMore: true` means there are more.

### All sellers

Navigate to `https://www.amazon.com/dp/<ASIN>?aod=1` and call `full()` again. The panel renders
client-side, so fetching that URL returns a page without it — you have to actually go there.

```jsonc
"offers": [
  { "price": 9.99, "seller": "AnkerDirect",   "shipsFrom": "Amazon.com", "condition": "New" },
  { "price": 9.89, "seller": "Amazon Resale", "shipsFrom": "Amazon.com", "condition": "Resale - Like New" },
  { "price": 18.29,"seller": "Amazon.com",    "shipsFrom": "Amazon.com", "condition": "New" }
]
```

Real capture — note the buy box was showing $9.99 while Amazon Resale had it at $9.89. That gap
is the reason this call exists.

Call `offers()` on a page without the panel and you get `{_needs: "navigate to …"}` rather than
an empty result, so a missing panel can't be mistaken for a product with one seller.

**`condition` is validated against Amazon's own vocabulary, and is `null` when the heading slot
holds something else.** `#aod-offer-heading` is a heading, not a condition field: on listings with
a Subscribe & Save toggle it carries the purchase mode, and through v0.4.1 that landed in
`condition` verbatim — a grocery listing reported `"condition": "One-time purchase"` on 2026-08-27,
which is not a condition and reads exactly like one. Purchase mode now has its own field:

```jsonc
{ "price": 21.85, "seller": "Amazon.com", "purchaseMode": "One-time purchase" }
```

If the heading is neither, the raw text is kept as `_heading` rather than dropped — an
unrecognised value there means Amazon has put a third thing in the slot, and that is worth seeing.

### Variants — `variants(opts?)`

Included in `full()` on every product page. Decodes Amazon's twister payload
(`dimensions` / `variationValues` / `dimensionToAsinMap`).

```jsonc
"variants": {
  "axes": { "color_name": ["01 Claddagh-Gold", "…"], "ring_size": ["4","5","…","12"] },
  "skuCount": 45,
  "selected": { "color_name": "01 Claddagh-Silver", "ring_size": "8", "asin": "B0BV9YJ7LS" },
  "possibleCombos": 56,        // only when it exceeds skuCount
  "unavailable": [             // advertised in the dropdown, absent from the map
    { "ring_size": "8", "gem_type": "natural green peridot" }
  ],
  "_dilution": "Amazon pools one star rating across a listing, and this listing has 45 SKUs (5 color_name x 9 ring_size). The rating shown may therefore have been earned mostly by a variant other than this one. …",
  "_dilutionCheck": "Compare rating.count here against https://www.amazon.com/dp/B0BV9YJ7XX — the same count on both means one pooled rating; different counts mean Amazon is splitting it, …"
}
```

`_dilution` is the payload. **A rating earned by one product and a rating pooled across ninety are
different numbers wearing the same badge**, and nothing on the rendered page distinguishes them.

**It is a risk flag, not a finding.** Before v0.5.0 this asserted the rating "is not a rating for
this variant alone" on every multi-SKU listing, which is more than the page supports: verified
2026-08-27, a 7-SKU listing served 4.3 / 662 on one child and 4.4 / 531 on a sibling — different
stars *and* different counts, so Amazon was splitting that pool rather than pooling it. There is
no confidence score, because nothing on the page distinguishes the two cases. `_dilutionCheck`
names a sibling ASIN instead: navigate there, compare `rating.count`, and you have the answer for
one navigation. Same count on both means genuinely pooled; different counts mean it is split and
the number in front of you is this variant's own.

`unavailable` is the other half: verified on `B015WD11L6`, "natural green peridot" is stocked in
ring sizes 7 and 10 only — the dropdown offers it in size 8 and no such SKU exists.

**There are no per-variant prices, and there is no way to add them.** Verified 2026-08-27: the
twister blob holds zero `$` amounts and zero numeric price values across 218 KB. Every key in it
matching `/price/i` is a *feature-div name* (`corePrice_feature_div`), because Amazon re-renders
those slots over AJAX when a variant is selected — the price is fetched on selection. Comparing
prices across variants costs one navigation each, and that is not an oversight in this library.

Pass `{full: true}` for the complete decoded combination list (large; omitted by default). The
decode is **self-validating**: map keys are underscore-joined value indices matching `dimensions`
positionally, and `selected` is found by locating the current page's own ASIN in the map. If
`selected` is null on a variation page, the convention has moved and `_warn` says so.

### Size charts — `charts()`

Included in `full()` on every product page; `null`, and therefore absent, on most of the
catalogue. On apparel it is the difference between a capri's inseam and the garment's.

```jsonc
"charts": {
  "count": 2,
  "candidates": [
    { "source": "amazon-size-chart", "label": "US CAPRI LEGGINGS",
      "sizes": ["XS", "S", "M", "L", "XL", "XXL"],
      "measures": { "US Size":    ["0-2", "4-6", "8-10", "12-14", "16-18", "20-22"],
                    "Waist (in)": ["24 - 26", "26 - 28", "28 - 30", "30 - 32", "32 - 34", "35 - 37"],
                    "Inseam (in)": [19.7, 19.7, 19.7, 20.1, 20.5, 21.3] } },
    { "source": "aplus-image", "heading": "Get the Right Size for Maximum Performance",
      "url": "https://m.media-amazon.com/images/S/aplus-media-library-service-media/….jpg" }
  ],
  "_warn": "2 size-chart candidates on this page (1 readable table(s), 1 image(s)). Amazon renders its size-chart widget from brand-level data that can belong to a DIFFERENT garment in the same line, and an image cannot be read from markup. …",
  "_labelCheck": "The widget chart label(s) mention \"CAPRI\", which the product title does not. …"
}
```

Real capture, 2026-09-03, on a full-length legging listing. The HTML chart says L inseam 20.1";
the image says 27.4". Amazon's widget (`#sizeChartV2Data_feature_div`, a preloaded popover with
one `div#fit-sizechartv2-N` per chart and an `<h5>` label above each table) is brand-level data,
and the brand's capri chart had been attached to a full-length garment. A table sweep that stops
at the first chart has a coin-flip chance of being wrong and no signal that it flipped. On a
second listing, with three widget charts for three fit types, the first in DOM order was the 25"
fit on the 28" variant's own page.

`charts()` does not pick. It enumerates: the widget's charts with their labels, seller-written
tables under A+ content or the description that pass the size-chart heuristic, images inside A+
modules whose heading mentions size (A+ images carry `alt="1"` throughout, so the heading is the
only marker), and any image with a size-chart `alt`. Then it says what it knows:

| Field | When | Says |
|---|---|---|
| `_warn` | more than one candidate, or an image-only chart | do not quote a figure until the others are checked; screenshot the image |
| `_disagree` | two readable charts differ | which measurement, at which size, by how much: `Inseam (in) at L: 26.6 vs 28.7` |
| `_selectedCheck` | several widget charts and a twister selection | which chart's label matches the selected variant (`matchesSelected: true` on it), and how many belong to siblings |
| `_labelCheck` | a widget label names a garment the title does not | `"CAPRI"` on a listing titled "Leggings" |

`measures` rows are aligned to `sizes`: a lone figure is a number, a range stays a string, an
empty cell is `null` and holds its place. Sizes are read down the first column (Amazon's widget)
or across the header (seller tables), and the grid is transposed so the shape is always the same.

An image candidate carries no figures and never will. Its `url` has the A+ crop suffix stripped,
so it is the full upload; navigate a tab there and take a screenshot — the route is in the skill.

### Reviews: eight, unsteerable, and with their text back

Verified 2026-08-21 on `B0BV9YJ7LS`: `filterByStar=one_star` returns eight reviews rated
5,5,5,5,4,5,5,5. The same eight come back for `two_star`, `three_star`, `critical`, both `sortBy`
values and `pageNumber=2`. There is no pagination control. This is site-wide — `B0BGKYF5VZ` served
224 reviews under its 1★ filter on 18 Aug and eight on 20 Aug. `criticalReviews()` was removed in
v0.2.0 rather than left to mislead.

**Two things changed on 2026-09-03.** Amazon renamed the title and body hooks (`review-title` →
`reviewTitle`, `review-body` → `reviewText`) while the stars, date, badge and helpful hooks kept
their names, so through 0.6.0 every review in the sample arrived as `{stars, date, verified,
helpful}` with no prose — a record that was 90% hole and read as complete. And `/product-reviews/`
now redirects a signed-out browser to sign-in (`full()` returns `{blocked: "signin"}` there). The
product page carries the same sample and the histogram for everyone, so read them there:

```js
await __amzx.full({reviews: true})                    // product page: + reviews, with text
await __amzx.full({reviews: true, bodyChars: 800})    // longer bodies (default 400)
```

```jsonc
"reviews": {
  "distribution": { "5star": 76, "4star": 12, "3star": 5, "2star": 4, "1star": 3 },
  "sampling": { "n": 8, "ratingsTotal": 132, "coverage": "6.1%",
                "earliest": "2025-11-02", "latest": "2026-01-19", "ceiling": true, "complete": false },
  "sample": [
    { "stars": 5, "title": "Love them!", "date": "the United States on January 19, 2026",
      "format": "Size: XX-Large | Color: Black", "verified": true,
      "body": "These leggings are true to size and I love that they actually reach my ankles…" }
  ],
  "_warn": "Only 8 of 132 reviews are reachable and there is no way to page further …"
}
```

`format` is the variant a review is about, and on a multi-fit listing it is the only thing on the
page that says so: on an 879-rating child every sampled review carried `Fit Type: 4 Pockets 28"
Inseam`, which confirmed a split rating pool independently of `_dilutionCheck`.

`sampling.earliest` / `latest` bracket the sample's dates. When the specs carry `Date First
Available` and the earliest review predates it by more than a month, `_dateWarn` says so —
reviews from 2020 on a 2025 ASIN describe some other product, and stars alone cannot show it.

**The star distribution is the only trustworthy aggregate**, and it now arrives with every
product capture as `product.rating.distribution` (percent per star, 5-star first). It is read from
each histogram row's `aria-valuenow`, the five figures are checked to sum to roughly 100, and
`_histWarn` fires when they do not, because five wrong spans look exactly like five right ones.

## `health()` → object

```jsonc
{
  "pageType": "product",
  "ok":      ["product.title", "product.shipsFrom (fallback #1)", "product.image"],
  "absent":  ["product.coupon", "product.badgeChoice"],   // legitimately not on this page
  "broken":  [],                                          // selectors that resolve nowhere
  "summary": "14 ok, 2 absent-but-optional, 0 BROKEN"
}
```

Run it whenever a capture looks thin. `absent` is expected — most products have no coupon.
Anything in `broken` means Amazon moved something and `SEL` needs a new candidate.
`(fallback #N)` means the primary selector stopped matching and a backup carried it — an early
warning that the primary is rotting.

On a product page that reports ratings it also checks the `reviews` group (cards, title, body,
histogram), because that is where those render and, through 0.6.0, nothing ever looked — which is
how the histogram rotted unreported. The `charts` group is checked on every product page and is
all-optional: most of the catalogue has no size chart.

## Narrower calls

| Call | Returns |
|---|---|
| `page()` | Page type, canonical URL, ASIN, timestamp, `blocked` state |
| `product()` | Product record only |
| `search(opts?)` | Search record only |
| `reviews(doc?, opts?)` | Star distribution + review sample (title, body, format, dates) from a document — the product page works |
| `charts()` | Every size-chart candidate on the page, parsed where possible, with the disagreement and label checks |
| `histogram(doc?)` | `{distribution}` from the star histogram, with a `_warn` when the five figures cannot be the five rows |
| `offers()` | All sellers on the current page, or `{_needs}` if the panel isn't loaded |
| `variants(opts?)` | Every SKU in the listing, what's actually stocked, and `_dilution`. `{full:true}` for the whole decoded list |
| `text(max?)` | Rough visible text. Escape hatch for page types with no extractor (cart, wishlists) |
| `SEL` | The live selector registry — inspect it when debugging |

## Failure modes worth knowing

| Symptom | Cause |
|---|---|
| `__amzx is not defined` | Script not installed, or a `GM_*` grant was added and moved it into Tampermonkey's sandbox |
| `{blocked: "captcha"}` | Robot wall. A human must clear it in this browser |
| `{blocked: "signin"}` | The page asked for a session — `/product-reviews/` does this to a signed-out browser. Do not sign in; use `full({reviews: true})` on the product page |
| Review sample has stars and dates but no text | The title/body hooks moved again. Through 0.6.0 this was the shipped state; run `health()` on the product page and look for `reviews.rTitle` / `reviews.rBody` |
| Record present but `_missing` lists most fields | Page still rendering, or a real DOM change — run `health()` |
| `sponsoredRemoved` unusually high | Possible false positives in ad detection, which silently hides real products |
| Review count ~100× too low | Abbreviated form (`"22.2K"`) reaching a parser that strips non-digits. Fixed in 0.1.0; check `num()` if it returns |
