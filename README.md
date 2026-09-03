# Shopping Claude Bridge

**Read-only extractor libraries** for `www.amazon.com` and `www.ebay.com`. They install as
userscripts, render nothing, and bind no keys. All they do is define `window.__amzx` and
`window.__ebayx` — so an assistant driving the browser can pull a compact JSON record of whatever
page is open, instead of reading a 60 KB accessibility tree and guessing.

| Userscript | Publishes | On |
|---|---|---|
| [`src/amazon-claude-bridge.user.js`](src/amazon-claude-bridge.user.js) | `window.__amzx` | `www.amazon.com` |
| [`src/ebay-claude-bridge.user.js`](src/ebay-claude-bridge.user.js) | `window.__ebayx` | `www.ebay.com` |

> **Cosmetic changes live elsewhere.** The dark theme is
> [AmazonTweaks](https://github.com/dataterminals/AmazonTweaks). This repo is the data side.
> Keep the two apart.

---

## Why

Reading a marketplace through a general browser tool is expensive and lossy:

- A search results page serialises to tens of KB of nav, ads, carousels and footer. The ~15 fields
  that actually inform a decision are 1–2 KB. You run out of context long before you run out of
  products.
- On Amazon, sponsored placements are interleaved with organic results and look nearly identical,
  so every read spends effort re-deciding which is which.
- Comparing five candidates means five expensive page reads, then assembling a table by hand.

The fix is to extract *inside the page*, where the DOM already is, and hand back only the fields
that change a decision. On a real Amazon search page that is 22 raw result nodes in, 16 organic
products out, ads counted and dropped.

## The two records are deliberately different shapes

Amazon is a catalogue. eBay is a market. On Amazon, condition, seller and postage are mostly
constant, so `price` is a decision-grade number by itself. On eBay every one of those is a
variable the seller sets, and `price` alone is **wrong**.

On a live 60-row eBay search, **57 of 60 positions changed** when sorted by landed cost instead of
sticker price; a re-measure on another query gave 47 of 60. Both are snapshots of one page — the
magnitude is the durable claim, not the constant. `$8.99 + $8.07 = $17.06` ranks below `$9.95 + $5.80 = $15.75`, and the listing
price says the opposite. So every eBay row carries `{price, shipping, total}` and `total` is the
sort key.

An eBay record that looked like an Amazon one would be actively misleading, so it doesn't.

## What it does

### Amazon — `__amzx`

| Page | Call | You get |
|---|---|---|
| Search results | `__amzx.full()` | Organic results only — ASIN, title, price, stars, review count, Prime, badge — plus how many ads were removed |
| Product | `__amzx.full()` | Price (with unit price and list price), rating, availability, ships-from / sold-by, delivery, a parsed coupon (percentage split from the condition attached to it), badges, breadcrumb, feature bullets, spec table, canonical URL |
| All sellers | navigate to `/dp/<ASIN>?aod=1`, then `__amzx.full()` | Every offer with price, seller, ships-from, validated condition and purchase mode. Worth doing: on the test product the buy box showed $9.99 while Amazon Resale had it at $9.89 |
| Reviews | `__amzx.full({reviews: true})` on a product page | The star distribution (also on every product capture as `rating.distribution`), plus the capped sample **with title, body and the variant it was written about** — Amazon returns 8 reviews regardless of any filter, and the reviews page now redirects a signed-out browser to sign-in |
| Size charts | `__amzx.full()` on a product page | Every size-chart candidate — Amazon's widget with its label, seller tables, A+ images — parsed where possible, with a warning when they disagree. On a real listing the HTML chart was a capri's (L inseam 20.1") and the garment's chart was an image reading 27.4" |
| Variants | `__amzx.full()` on a product page | Every SKU in the listing, which combinations are actually stocked, and `_dilution` — how many products share the one star rating |
| Buy Again | navigate to `/gp/buyagain`, then `__amzx.full()` | Every reorder card — ASIN, title, price, unit price, list price, promo, and the Subscribe & Save vs one-time offer pills. On a 24-card capture, 10 cards had a subscription price below the price printed on the card |

### eBay — `__ebayx`

| Page | Call | You get |
|---|---|---|
| Search results | `__ebayx.full()` | Per row: item id, title, condition, `sizeHint`, `{price, shipping, total}`, sale format, bids, watchers. **Ads are not filtered** — see below. A facet filter that renders zero rows against a positive count is reported as such, with the filters named |
| Item | `__ebayx.full()` | Price, discount, shipping (cost + origin), `total`, returns as a tri-state, seller as `{name, feedbackCount, positivePct}`, quantity available and sold, item specifics, the style code, and the photos — count, full-size URL, and eBay's own caption of the first one. Silhouette specifics (`Style`, `Leg Style`) carry a warning: they are dropdowns, and one read "Ankle" on a flare |
| Variants | `__ebayx.full()` on an item page | Every option per axis with its stock state, price and remaining quantity — from a static payload, with **no click and no request** |

Anything: `health()` reports which selectors still resolve on the current page — see *Maintenance*.

Every record is pruned of nulls and empty branches before it is returned, and long strings are
capped. Compactness is the product.

### Two things the eBay half will tell you loudly

- **The search index lies about stock.** A card's size aspect (`Brand New · VANS · US W 9`) is a
  listing aspect, not an inventory check — verified on a listing whose own variant map marks that
  size out of stock. The field is called `sizeHint` for that reason, and `variants()` is the only
  stock truth.
- **Sponsored placements are not filtered, and the result says so.** eBay has no reliable ad marker
  in the DOM: across a 70-card search the only candidate signal matched **70 of 70** cards, while
  forward `Sponsored` text and every `[class*=sponsored]` / `[aria-label*=Sponsored]` matched zero.
  Filtering on that would hide the entire page, so the library refuses to guess and ships a
  `_warn`. On Amazon you get a count of ads removed; on eBay you get an honest "none were".

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open each `.user.js` above **raw** and let Tampermonkey take the install. Install only the
   sites you want.
3. Load a page and check the console: `__amzx.version` / `__ebayx.version` should return a string.

If the global is `undefined` on a matching page, the most likely cause is that you are looking at a
different browser than the one it is installed in — check that first, then see *Maintenance*.

### The companion skill

[`.claude/skills/shopping-research/`](.claude/skills/shopping-research/) carries the research
playbook. `SKILL.md` holds the preflight, the extraction loop and the reporting rules; the
site-specific detail — search-URL parameters, listing-vetting checklists, the traps in each site's
payload — lives in [`references/amazon.md`](.claude/skills/shopping-research/references/amazon.md)
and [`references/ebay.md`](.claude/skills/shopping-research/references/ebay.md).

It lives **inside the repo** rather than at user scope, so it travels with the code it depends on:
any session working in this checkout picks it up automatically, with no install step and nothing
to re-sync after a pull. That includes environments that can only reach this repo by cloning it.

The skill opens with a preflight, because it depends on a browser holding the userscripts and on a
local `store/`. A session with neither is told to say so rather than silently substituting a
different browser and presenting the results as equivalent.

## Scope, deliberately narrow

Each script reads the DOM of the page the caller navigated to. That is the entire footprint —
**no network requests at all**.

They do **not** write to the page, submit a form, touch a cart / buy / bid / checkout control, read
credentials, contact any third-party host, or crawl in the background. Anything that changes
account state belongs in a different, clearly-scoped tool.

That constraint survived contact with the one case that looked like it needed an exception. eBay's
size dropdown yields zero `<option>` elements and its listbox nodes carry no stock state, which
argues for a click. It isn't necessary: the entire variant map — every option, its stock state,
its price and its remaining quantity — sits in a static `<script>` at document-idle, and the label
the click reveals is in the same object. The click only makes eBay *render* something it already
had.

### Things the sites no longer allow, and what the libraries do about it

v0.1.0 fetched sub-pages for extra data. Both paths were dead, and testing them against the live
site is the only reason that was caught:

- **The all-offers AJAX endpoints 404**, and `/dp/<ASIN>?aod=1` fetched over XHR omits the panel
  because it renders client-side. `offers()` now reads the live DOM and returns a `_needs` hint
  naming the URL to navigate to, instead of quietly returning nothing.
- **Every Amazon review parameter is ignored, and the sample is capped at 8.** Not just `critical`:
  verified 2026-08-21, `filterByStar=one_star` returns eight reviews rated 5,5,5,5,4,5,5,5, and the
  same eight come back for every other filter, both sorts and `pageNumber=2`. It is site-wide — one
  listing served 224 reviews under its 1★ filter on 18 Aug and eight on 20 Aug. `reviews()` reports
  `coverage` and `ceiling` so the gap is visible, and the star distribution is the only figure
  still worth quoting. Since 2026-09-03 the reviews page also redirects a signed-out browser to
  sign-in; the product page carries the same sample, and `full({reviews: true})` reads it there.
- **Neither library can see a picture, and both now say where it is.** A size chart that lives in
  an A+ image, or an eBay silhouette that only the photographs contradict, is handed over as a URL
  to screenshot — with a warning in the record that a figure from the visible part is not the
  whole answer.
- **`WebFetch` on eBay returns confidently wrong content, not an error.** A fetch of an eBay search
  for Vans hi-tops came back as a clean, well-formed table of *Bobby Witt Jr. baseball cards* —
  plausible titles, plausible prices, plausible seller handles, entirely unrelated. Browser only.

## Captures contain personal data

Amazon stamps the signed-in user's own history into search results — a badge reading
`Purchased Aug 2025`, which this library surfaces as `ownedSince`. It is genuinely useful
("do I already own this?") and it is also purchase history.

`.gitignore` excludes `/store/` for exactly this reason. **Keep captures out of the repo.** Treat
this repo as publishable; what it extracts is not.

## Maintenance

Both sites reshuffle their DOM constantly, and the dangerous failure is the quiet one — a selector
that stops matching, returns `null`, and lets the caller reason confidently about a price that was
never read.

Three things are built to make that loud instead:

- **`health()`** reports, for the current page, which fields resolved, which resolved only via a
  fallback candidate, and which are outright `broken`. Fields legitimately absent on most pages
  (coupon, list price, badges) are reported as `absent`, so a real break is not buried. On eBay it
  additionally reports whether the variant payload still parses, since that is not a selector.
- **Every record carries `_missing`** listing which load-bearing fields came back empty.
- **`_warn` states what the capture cannot support** rather than leaving the reader to assume.

When a field breaks, **add a candidate selector to the `SEL` registry** near the top of the
script — never rewrite the extraction logic. Candidates are tried in order, most-specific first.

**The loader publishes via a `<script>` tag, and that is load-bearing.** Whether a userscript's
`window` is the page's `window` depends on how the extension injected it — something the script
cannot observe. v0.1.0 assumed `@grant none` meant main-world, installed cleanly, and left
`__amzx` undefined with no error anywhere. A `<script>` element always evaluates in the main world
because the DOM is shared. Do not simplify it back to a direct call.

**The shared util block is duplicated between the two scripts on purpose**, between
`// --8<-- shared core` markers, and `tests/core-parity.test.js` holds the copies byte-identical.
A userscript is one file the extension injects, so they cannot share a module. Fixing a parser
means porting it to both — never deleting the block from one.

## Order history

The extractor can tell you what a thing costs today. It cannot tell you what *you* paid for it in
2023 — and that is usually the more useful number.

Amazon's official **Request My Data** export closes that gap: a one-time request, delivered as
CSV, needing no maintenance and no scraping. `bin/orders.js` ingests it.

```bash
node bin/orders.js ingest ~/Downloads/Your\ Orders.zip
node bin/orders.js asin B07DC5PPFV
```

```
B07DC5PPFV: bought 3× (qty 3), 2023-04-11 to 2025-08-14
  Anker USB-C Cable, 2-Pack, 6ft
  last price 16.49, total spent 44.47
```

Full walkthrough in [docs/ORDER-EXPORT.md](docs/ORDER-EXPORT.md). Output lands in `store/`, which
is gitignored — it is a complete purchase history and this repo is public. Addresses, payment
instruments, tracking numbers and gift messages are dropped during ingest and never hit disk.

There is deliberately **no order-page extractor**. Order pages are a React app with per-deploy
class hashes; the official export is complete and stable, so scraping them would be strictly
worse. There is no eBay equivalent ingested.

## Tests

Zero-dependency, plain node. No install step, no runner.

```bash
for t in parse ebay-parse orders core-parity vendor package; do node tests/$t.test.js; done
node bin/vendor.js --check       # both injected assets match src/
node bin/skill-drift.js --check  # the two skill trees are in step
```

| Suite | Covers |
|---|---|
| `parse` | 129 Amazon parser cases |
| `ebay-parse` | 68 eBay parser cases |
| `orders` | 47 order-ingest cases |
| `core-parity` | the shared util block is byte-identical across both userscripts |
| `vendor` | each skill-injected copy matches its source and still evaluates |
| `package` | the plugin bundle writer |

Every parser case is a defect found by running the extractor against the live site rather than by
reading it — abbreviated review counts (`"(22.2K)"` parsed as 222), doubled unit prices
(`"$0.83$0.83 / feet"`), CSS leaking out of `textContent` and fabricating a badge that was not on
the page, and eBay welding `Opens in a new window or tab` onto the end of every result title.

Selectors cannot be tested offline. `health()` is the check for those, against the live site.

## License

MIT
