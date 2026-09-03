# Amazon — `window.__amzx`

Site-specific reference. The preflight, tier ladder, blocked-page rules and reporting rules are in
[SKILL.md](../SKILL.md) and apply here too.

```js
await __amzx.full()                 // search / product / reviews / buyagain — dispatches on page type
await __amzx.full({limit: 40})      // search page, more rows (default 24)
await __amzx.full({reviews: true})  // product page: + the review sample WITH text, and the date check
__amzx.health()                     // which selectors still resolve on this page
```

Search rows are under **`search.results`** here and **`search.rows`** on eBay. Same idea,
different key; reading the wrong one looks like an empty search.

## Build search URLs directly

Base: `https://www.amazon.com/s?k=<query>`

| Parameter | Effect |
|---|---|
| `&s=price-asc-rank` | Cheapest first |
| `&s=review-rank` | Best reviewed first |
| `&s=date-desc-rank` | Newest first |
| `&s=exact-aware-popularity-rank` | "Featured" / default |
| `&rh=p_36:1000-3000` | Price $10.00–$30.00 — **in cents** |
| `&rh=p_72:1248915011` | 4 stars and up (US marketplace node) |
| `&rh=p_6:ATVPDKIKX0DER` | Sold by Amazon itself, not a marketplace seller |
| `&page=2` | Pagination |

Combine `rh` filters with commas: `&rh=p_36:1000-3000,p_72:1248915011`.

Node IDs like `p_72:…` and `p_85:…` are marketplace-specific and Amazon does change them. If a
filtered search returns zero or nonsense, drop the `rh` and filter in your own analysis instead —
don't keep retrying node IDs.

Other useful URLs:

- `https://www.amazon.com/gp/buyagain` — **start a reorder here.** `full()` returns every card with
  price, unit price, promo and the Subscribe & Save vs one-time pills, so you get the whole
  shopping list in one capture instead of navigating per item. `shown` is what is on the page:
  Amazon paginates behind a "Load more" button and the library clicks nothing, so `hasMore: true`
  means the list is longer than what you have. Don't click it — say so and work with what loaded.
- `https://www.amazon.com/dp/<ASIN>` — canonical product page, no tracking cruft
- `https://www.amazon.com/dp/<ASIN>?aod=1` — all sellers. The panel renders client-side, so you
  must **navigate** here; fetching it returns a page without the offers
- `https://www.amazon.com/product-reviews/<ASIN>/` — the reviews list

## Reviews are capped at 8 and the parameters are inert — read them on the product page

Not just `critical` — **every** review parameter is ignored. Verified 2026-08-21 on `B0BV9YJ7LS`:
`filterByStar=one_star` returned eight reviews rated 5,5,5,5,4,5,5,5. Identical eight for
`two_star`, `three_star`, `critical`, both `sortBy` values and `pageNumber=2`. No pagination
control exists. It is site-wide, not one bad listing — `B0BGKYF5VZ` served 224 reviews under its
1★ filter on 18 Aug and eight on 20 Aug.

**The reviews page now redirects a signed-out browser to sign-in** (`full()` says
`blocked: "signin"`; do not sign in). The product page carries the same eight cards and the
histogram for everyone, so that is where to read them: `full({reviews: true})`. Through library
0.6.0 the sample came back as `{stars, date, verified, helpful}` with no text at all — Amazon had
renamed the title and body hooks — and every real finding had to be dug out of the DOM by hand.
Fixed on 2026-09-03; if the text ever vanishes again, `health()` on the product page will name
`reviews.rTitle` / `reviews.rBody`.

What the text is for, in this order:

- **`format`** — `Size: L | Color: Black`, or `Fit Type: 4 Pockets 28" Inseam | …` on a multi-fit
  listing. It is the only thing on the page that says which variant a review is about, and it
  settles `_dilution` from the other side: on an 879-rating child every sampled review named the
  child's own fit, so the pool was split.
- **Reviewers who contradict the listing.** A butt-lifting claim contradicted by a reviewer; a
  waistband failure a reviewer misdiagnosed as slippery fabric. This is the scrutiny the skill
  exists for and it is only in the body.
- **Reviewers who publish their own measurements.** Inseam and hip figures in a review are a
  second size chart, and one that was worn.
- **Reviews describing a different product.** `sampling.earliest` / `latest` bracket the dates;
  `_dateWarn` fires when the earliest predates `Date First Available` by more than a month.
  Flower-print reviews from 2020 on a 2025 ASIN are contamination that stars alone cannot show.

**The star distribution is the only trustworthy aggregate**, and it now arrives with every
product capture as `rating.distribution` (percent per star, 5-star first). The sample is not
representative, cannot be made representative, and no amount of URL fiddling will reach review
number nine — don't try. On one ring: 8 readable against 574 rated is **1.4% coverage**, while
the distribution says 3% are 1★ — roughly 17 angry reviews the "one star" filter will not show
you. Quote the distribution and the coverage figure. Never characterise a product's problems from
the sample; do quote what the sample says, with `format` attached.

## Size charts: the HTML one can belong to a different garment

On 2026-09-03 a `querySelectorAll('table')` sweep of a legging listing returned one size chart
reading **L inseam 20.1"**, and the figure went into a recommendation. The chart for the garment
on the page was an A+ **image** reading **27.4"** — a capri versus the full-length garment being
bought. The two charts were near-identical (same brand, same waist and hip grid, one row
different), and the only thing in the markup that said so was the widget's own label:
**"US CAPRI LEGGINGS"**, on a listing whose specs say "Long Length". A second listing carried
three widget charts for three fit types, and the first in DOM order was the 25" fit — on the 28"
variant's own page.

`full()` on a product page now includes **`charts`** whenever the page has any candidate. It does
not pick; it enumerates, and says what it knows:

| Field | Read it as |
|---|---|
| `candidates[].source` | `amazon-size-chart` (the widget, with its `label`), `aplus-table`, `description-table`, `aplus-image`, `image` |
| `candidates[].sizes` / `measures` | aligned: `measures["Inseam (in)"][i]` belongs to `sizes[i]`. A lone figure is a number, a range stays a string |
| `_warn` | more than one candidate, or an image-only chart: **do not quote a figure until the others are checked** |
| `_disagree` | two readable charts differ, and where: `Inseam (in) at L: 26.6 vs 28.7` |
| `_selectedCheck` | which chart's label matches the selected variant (`matchesSelected: true`); the rest are siblings' |
| `_labelCheck` | the widget label names a garment the title does not (`"CAPRI"`) |

An image candidate carries a `url` and no figures, and never will — navigate a tab to it and take
a screenshot (the route is in SKILL.md, under *Seeing a picture*). A+ images carry `alt="1"`
throughout, so the only markup that identifies a size-chart image is its module heading; the crop
suffix is stripped from the URL so the whole upload renders.

If a sizing question turns on one row, the row to check is the one that differs between garment
types: inseam or length for trousers, sleeve for tops. Waist and hip grids are shared across a
brand's line and will agree even when the chart is wrong.

## Check purchase history first

If `store/by-asin.json` exists in the repo, check it **before** recommending anything.

```bash
node bin/orders.js asin B07DC5PPFV     # bought before? when? what did I pay?
node bin/orders.js search "usb c"      # everything matching, newest first
node bin/orders.js stats               # spend by year, repurchase table
```

Lead with anything it turns up — it usually ends the question:

- **Already owned.** "You bought this 2025-08-14 for $16.49" beats any comparison table.
- **Price drift.** If the last price was lower than today's, say so with both figures. This is the
  only real price history available anywhere in this toolchain.
- **Reorder cadence.** A thing bought 3× at roughly even intervals is a consumable, and the useful
  answer is "you're about due" rather than a fresh product comparison.

If the file doesn't exist, don't guess and don't scrape order pages — say the export hasn't been
ingested yet and point at `docs/ORDER-EXPORT.md`.

## Vetting a listing

- **Sold-by / ships-from mismatch** — a third-party seller shipping directly is a different risk
  and a different returns path than Amazon-fulfilled.
- **Cheapest offer isn't the buy box.** `offers` frequently shows a lower price than the default.
  Say so, with the seller. Costs one navigation to `?aod=1`.
- **A rating pooled across many SKUs.** With review reading capped, `variants` is the primary audit
  tool — check it on every product page. `full()` includes it automatically and sets `_dilution`
  whenever a listing has more than one SKU. Real catches: a Claddagh listing whose colour axis held
  four Triquetra knots — a different ring entirely; a 24-rating birthstone listing where every
  rating belonged to one colourway.

  **`_dilution` is a risk flag, not a finding — report it as one.** It fires on every multi-SKU
  listing, because nothing on the page distinguishes a pooled rating from a split one. Amazon does
  sometimes split: on 2026-08-27 a 7-SKU listing served 4.3 / 662 on one child and 4.4 / 531 on a
  sibling. If the rating is load-bearing, spend the one navigation `_dilutionCheck` names and
  compare `rating.count` — same count means genuinely pooled, different counts mean the number in
  front of you is this variant's own. Otherwise say "may be pooled across N SKUs", not "is not a
  rating for this variant".

- **A coupon with a condition attached.** `coupon.conditional` marks the discounts that are not
  really discounts. **Never quote `coupon.pct` without `coupon.requires`** — "30% off" that applies
  only to a first Subscribe & Save order is a subscription decision wearing a price tag, and it is
  the biggest number on the page. `coupon.applied` says whether the saving is already inside
  `price.current`; if it is, don't subtract it again.
- **A cheaper offer sitting next to the price.** On Buy Again, `items[].offers` carries the
  Subscribe & Save and one-time prices as separate pills. On a 24-card capture, **10 cards had a
  subscription price below the number printed on the card**. Report both, and say which requires a
  subscription.
- **A variant that is advertised but not stocked.** `variants().unavailable` lists combinations the
  dropdown offers and the map doesn't have. Verified on `B015WD11L6`: "natural green peridot"
  exists in sizes 7 and 10 only — not in size 8, and the rendered dropdown never says so.
- **Reviews describing a different product.** Classic listing hijack. You'll have to spot it in the
  8-review sample, and 8 of several hundred may well not contain it. Absence of evidence here is
  close to worthless.
- **Rating count wildly out of scale with the product's apparent age**, or a bimodal distribution
  (heavy 5s and 1s, little middle).
- **Price far below the category norm** with no explanation in the specs.

## What Amazon can't tell you

**Prices for variants you are not looking at.** `variants()` gives you every SKU's ASIN but not its
price — the twister payload contains no prices at all (verified 2026-08-27: 218 KB, zero `$`
amounts), because Amazon fetches the price when a variant is selected. Comparing flavours or sizes
costs **one navigation per variant**. Budget for that, or compare fewer, and say so before
promising a comparison you'd need six round-trips to deliver.

> This is the sharpest difference from eBay, which *does* ship every variant's price in its page
> payload. Do not carry an assumption in either direction between the two.

**Complete order history.** Search results carry a `Purchased <date>` badge, but that is
per-result and incidental. For real history use the *Request My Data* export — see
`docs/ORDER-EXPORT.md`. There is deliberately no orders extractor: order pages are a React app
with per-deploy class hashes, and the export is official, complete and needs no maintenance.
