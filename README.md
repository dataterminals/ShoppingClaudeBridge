# Amazon Claude Bridge

A **read-only extractor library** for `www.amazon.com`. It installs as a userscript, renders
nothing, and binds no keys. All it does is define `window.__amzx` — so an assistant driving the
browser can pull a compact, de-sponsored JSON record of whatever page is open, instead of reading
a 60 KB accessibility tree and guessing.

> **Cosmetic changes live elsewhere.** The dark theme is
> [AmazonTweaks](https://github.com/dataterminals/AmazonTweaks). This repo is the data side.
> Keep the two apart.

---

## Why

Reading Amazon through a general browser tool is expensive and lossy:

- A search results page serialises to tens of KB of nav, ads, carousels and footer. The ~15 fields
  that actually inform a decision are 1–2 KB. You run out of context long before you run out of
  products.
- Sponsored placements are interleaved with organic results and look nearly identical, so every
  read spends effort re-deciding which is which.
- Comparing five candidates means five expensive page reads, then assembling a table by hand.

The fix is to extract *inside the page*, where the DOM already is, and hand back only the fields
that change a decision. On a real search page that is 22 raw result nodes in, 16 organic products
out, ads counted and dropped.

## What it does

| Page | Call | You get |
|---|---|---|
| Search results | `__amzx.full()` | Organic results only — ASIN, title, price, stars, review count, Prime, badge — plus how many ads were removed |
| Product | `__amzx.full()` | Price (with unit price and list price), rating, availability, ships-from / sold-by, delivery, a parsed coupon (percentage split from the condition attached to it), badges, breadcrumb, feature bullets, spec table, canonical URL |
| All sellers | navigate to `/dp/<ASIN>?aod=1`, then `__amzx.full()` | Every offer with price, seller, ships-from, validated condition and purchase mode. Worth doing: on the test product the buy box showed $9.99 while Amazon Resale had it at $9.89 |
| Reviews | navigate to `/product-reviews/<ASIN>/`, then `__amzx.full()` | Star distribution, plus a capped sample with `coverage` and `ceiling` flags — Amazon now returns 8 reviews regardless of any filter |
| Variants | `__amzx.full()` on a product page | Every SKU in the listing, which combinations are actually stocked, and `_dilution` — how many products share the one star rating |
| Buy Again | navigate to `/gp/buyagain`, then `__amzx.full()` | Every reorder card — ASIN, title, price, unit price, list price, promo, and the Subscribe & Save vs one-time offer pills. On a 24-card capture, 10 cards had a subscription price below the price printed on the card |
| Anything | `__amzx.health()` | Which selectors still resolve on this page — see *Maintenance* |

Every record is pruned of nulls and empty branches before it is returned, and long strings are
capped. Compactness is the product.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [`src/amazon-claude-bridge.user.js`](src/amazon-claude-bridge.user.js) **raw** and let
   Tampermonkey take the install.
3. Load any Amazon page and check the console: `__amzx.version` should return a string.

If `__amzx` is `undefined` on an Amazon page, the most likely cause is that you are looking at a
different browser than the one it is installed in — check that first, then see *Maintenance*.

### The companion skill

[`.claude/skills/amazon-shopping/SKILL.md`](.claude/skills/amazon-shopping/SKILL.md) carries the
research playbook — the search-URL parameters worth building by hand, how to report a comparison,
and a listing-vetting checklist.

It lives **inside the repo** rather than at user scope, so it travels with the code it depends on:
any session working in this checkout picks it up automatically, with no install step and nothing
to re-sync after a pull. That includes environments that can only reach this repo by cloning it.

To also have it available outside a checkout, copy it to user scope — but note that a
user-scope copy is a *copy*, and drifts:

```bash
mkdir -p ~/.claude/skills/amazon-shopping && cp .claude/skills/amazon-shopping/SKILL.md ~/.claude/skills/amazon-shopping/
```

The skill opens with a preflight, because it depends on a browser holding the userscript and on a
local `store/`. A session with neither is told to say so rather than silently substituting a
different browser and presenting the results as equivalent.

## Scope, deliberately narrow

The script reads the DOM of the page the caller navigated to. That is the entire footprint — as
of v0.2.0 it makes **no network requests at all**.

It does **not** write to the page, submit a form, touch a cart / buy / checkout control, read
credentials, contact any third-party host, or crawl in the background. Anything that changes
account state belongs in a different, clearly-scoped tool.

### Two things Amazon no longer allows, and what the library does about it

v0.1.0 fetched sub-pages for extra data. Both paths were dead, and testing them against the live
site is the only reason that was caught:

- **The all-offers AJAX endpoints 404**, and `/dp/<ASIN>?aod=1` fetched over XHR omits the panel
  because it renders client-side. `offers()` now reads the live DOM and returns a `_needs` hint
  naming the URL to navigate to, instead of quietly returning nothing.
- **Every review parameter is ignored, and the sample is capped at 8.** Not just `critical`:
  verified 2026-08-21, `filterByStar=one_star` returns eight reviews rated 5,5,5,5,4,5,5,5, and the
  same eight come back for every other filter, both sorts and `pageNumber=2`. No pagination control
  exists. It is site-wide — one listing served 224 reviews under its 1★ filter on 18 Aug and eight
  on 20 Aug. `criticalReviews()` was removed outright; `reviews()` now reports `coverage` and
  `ceiling` so the gap is visible, and the star distribution is the only figure still worth
  quoting.

## Captures contain personal data

Amazon stamps the signed-in user's own history into search results — a badge reading
`Purchased Aug 2025`, which this library surfaces as `ownedSince`. It is genuinely useful
("do I already own this?") and it is also purchase history.

`.gitignore` excludes `/store/` for exactly this reason. **Keep captures out of the repo.** Treat this
repo as publishable; what it extracts is not.

## Maintenance

Amazon reshuffles its DOM constantly, and the dangerous failure is the quiet one — a selector that
stops matching, returns `null`, and lets the caller reason confidently about a price that was
never read.

Two things are built to make that loud instead:

- **`__amzx.health()`** reports, for the current page, which fields resolved, which resolved only
  via a fallback candidate, and which are outright `broken`. Fields that are legitimately absent on
  most pages (coupon, list price, badges) are reported as `absent`, so a real break is not buried.
- **Every record carries `_missing`** listing which of the load-bearing fields came back empty.

When a field breaks, **add a candidate selector to the `SEL` registry** near the top of the
script — never rewrite the extraction logic. Candidates are tried in order, most-specific first.

**The loader publishes via a `<script>` tag, and that is load-bearing.** Whether a userscript's
`window` is the page's `window` depends on how the extension injected it — something the script
cannot observe. v0.1.0 assumed `@grant none` meant main-world, installed cleanly, and left
`__amzx` undefined with no error anywhere. A `<script>` element always evaluates in the main world
because the DOM is shared. Do not simplify it back to a direct call.

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

There is deliberately **no order-page extractor** in the userscript. Order pages are a React app
with per-deploy class hashes; the official export is complete and stable, so scraping them would
be strictly worse.

## Tests

```bash
node tests/parse.test.js    # 64 extractor parser tests
node tests/orders.test.js   # 47 order-ingest tests
node tests/vendor.test.js   # 9 checks that the skill's injected copy matches src/
node bin/vendor.js --check  # same sync check, for CI
```

60 zero-dependency tests over the pure parsers. Each case is a defect found by running the
extractor against live amazon.com rather than by reading it — abbreviated review counts
(`"(22.2K)"` parsed as 222), doubled unit prices (`"$0.83$0.83 / feet"`), and CSS leaking out of
`textContent` and fabricating a badge that was not on the page.

Selectors cannot be tested offline. `health()` is the check for those, against the live site.

## License

MIT
