# CLAUDE.md — ShoppingClaudeBridge

Repo-specific rules. General conventions come from the sibling TFW/dataterminals repos.

## What this repo is

**Two** userscripts, one per marketplace, each publishing a read-only extractor library:

| Source | Publishes | On |
|---|---|---|
| `src/amazon-claude-bridge.user.js` | `window.__amzx` | `www.amazon.com` |
| `src/ebay-claude-bridge.user.js` | `window.__ebayx` | `www.ebay.com` |

**You are the caller.** The user pastes a product link, you navigate their Chrome there and
evaluate `full()`. They should never have to press a key on the page.

They are separate scripts on purpose. `@match` already guarantees the two can never be live on
the same page, so merging them would only double what Tier 2 costs on every injection — the
Amazon half would carry eBay's selectors into every amazon.com page and vice versa. The ~110-line
util block is duplicated across the two instead, held byte-identical by `tests/core-parity.test.js`
(see rule 8).

Cosmetics (dark mode) live in the sibling repo **AmazonTweaks**. Do not add UI here, and do not
add extraction there.

### The two records are deliberately different shapes

Amazon is a catalogue; eBay is a market. On Amazon, condition, seller and postage are mostly
constant, so `price` is decision-grade alone. On eBay all three are seller-set variables and
`price` without `shipping` is simply **wrong** — on a live 60-row search, 57 of 60 positions
changed when sorted by `total` instead of `price` (a re-measure on another query gave 47 of 60;
both are snapshots, the magnitude is the durable claim). Do not "harmonise" the two record shapes; an
eBay record that looks like an Amazon one is actively misleading.

## How to use it in a session

```js
// after navigating the tab to an amazon.com URL
await __amzx.full()                 // search / product / reviews / buyagain — dispatches on page type
await __amzx.full({limit: 40})      // search page, more rows (default 24)
__amzx.health()                     // which selectors still resolve here

// after navigating to an ebay.com URL
await __ebayx.full()                // item / search
__ebayx.health()                    // selectors, plus whether the variant map still parses
```

**Extra data costs a navigation, not an option flag.** There is no fetch path (see rule 7):

```js
// Amazon — all sellers; the buy box shows one and it is often not the cheapest
navigate(`https://www.amazon.com/dp/${asin}?aod=1`); await __amzx.full()   // -> .offers
// Amazon — reviews
navigate(`https://www.amazon.com/product-reviews/${asin}/`); await __amzx.full()
```

eBay needs no equivalent for variants: every option, its stock state, its price and its remaining
quantity are in a static `<script>` on the item page. See rule 9.

`full()` is async. Return it directly — the eval has REPL semantics and top-level `await` works.

Read `_missing` and `_warn` on every result before trusting it. A thin capture is far more often a
broken selector than a genuinely sparse product.

## Rules

1. **The `<script>`-tag loader is load-bearing.** Whether a userscript's `window` is the page's
   `window` depends on how the extension injected it, which the script cannot observe. v0.1.0
   trusted `@grant none` to mean main-world, installed cleanly, and left `__amzx` undefined with no
   error anywhere. The loader stringifies the library into a `<script>` element, which always
   evaluates in the main world because the DOM is shared. Do not simplify it to a direct call.

2. **Selectors live only in `SEL`.** When a field breaks, add a candidate to that registry,
   most-specific first, most-durable last. Never move selector strings into the extraction
   functions — the single registry is what makes a DOM change a one-line fix.

3. **Never commit `/store/`.** Captures carry the user's purchase history (Amazon stamps
   `Purchased Aug 2025` into search results, surfaced as `ownedSince`). This repo is public.
   Same sanitisation doctrine as OCRClaudeBridge: no real paths, no real order data, invented
   figures in docs.

4. **Stay read-only, and network-free.** DOM reads of the page the caller navigated to, and
   nothing else — no writes, no form submits, no cart/buy/checkout controls, no credentials, no
   requests of any kind. (`{deep:true}` is gone; see rule 7.) Do not "just add" a cart helper.

5. **Verify against the live site before believing a selector.** Every fix in v0.1.0 came from
   probing amazon.com, and three of them contradicted what the DOM was assumed to do:
   `[data-component-type="sp-sponsored-result"]` matched nothing, `#bylineInfo` no longer exists,
   and `#acBadge_feature_div` contains a stylesheet on products with no badge. Reading the code is
   not verification.

6. **Run the suites after any change.** All zero-dependency, plain node:
   `node tests/parse.test.js` (Amazon parsers), `node tests/ebay-parse.test.js` (eBay parsers),
   `node tests/orders.test.js` (order ingest),
   `node tests/core-parity.test.js` (the shared util block is identical in both userscripts),
   `node tests/vendor.test.js` + `node bin/vendor.js --check` (both injected assets match source),
   `node tests/package.test.js` (the bundle writer),
   `node bin/skill-drift.js --check` (the two skill trees are in step).

   ```bash
   for t in parse ebay-parse orders core-parity vendor package; do node tests/$t.test.js; done
   ```

7. **Do not re-add a fetch path — of either kind.** Sub-page fetching was removed in v0.2.0: the
   all-offers AJAX endpoints 404 in every URL shape, and `?aod=1` over XHR omits the
   client-rendered panel. Separately, **never fetch remote code and eval it** — a session was
   blocked by a safety classifier for exactly that, correctly, and a denial must never be worked
   around by rephrasing. Tier 2 injects the local vendored asset instead.

   **Per-variant prices are not in the twister payload — do not spike this again.** It is the
   obvious next feature (`variants().available[].price` would collapse a 6-navigation flavour
   comparison into a field read) and it does not exist. Verified 2026-08-27 on a 7-SKU grocery
   listing (ASIN withheld — rule 3: it is something the operator has bought, and this repo is
   public): 217,896 characters of twister blob containing **zero** `$` amounts and zero numeric
   values. There is no `asinVariationValues` and no `priceAsinData`. Every key in there matching
   `/price/i` is a *feature-div name* — `corePrice_feature_div`, `twisterPlusPriceSubtotal…` —
   because Amazon re-renders those slots over AJAX when a variant is picked. The price is fetched
   on selection, by design. The only price on the page is the selected ASIN's own. So a variant
   price costs a navigation or a request, and a request is what this rule forbids.

   Reviews: **every** parameter is ignored, not just `critical`. `filterByStar=one_star` returns
   eight 4-and-5-star reviews, and the cap is site-wide. If you think you have found a working
   endpoint, check the returned stars actually match the filter before believing it — the old code
   "worked" in the sense that it returned reviews.

   **And a third kind: never `WebFetch` an eBay URL.** A WebFetch of an eBay search for Vans
   hi-tops returned a clean, well-formed markdown table of **Bobby Witt Jr. baseball cards** —
   plausible titles, plausible prices, plausible seller handles, entirely unrelated to the query.
   That is worse than an error, because it has the shape of a success and would sail straight into
   a comparison table with nothing announcing it was wrong. Browser only. Nobody has tested
   whether Amazon does the same thing, so do not assume it is safe there either.

8. **The shared util block is duplicated, and that is the design.** Both userscripts carry the
   same ~110 lines between `// --8<-- shared core: START/END` markers. A userscript is one file
   the extension injects, so they cannot share a module, and a build step producing them would
   turn `src/*.user.js` into generated files — which is exactly where `@downloadURL` and
   `@updateURL` point, so the generated artifacts would have to stay committed at those paths
   anyway. Duplication plus detection is the cheaper trade, and it is the same doctrine as
   `vendor.js --check` and `skill-drift.js`: **the copy is allowed, the drift is not.**

   `tests/core-parity.test.js` holds them byte-identical and also evaluates both scripts, because
   identical text can still behave differently if a later line shadows a util. **Fixing a failure
   there means porting the change to every userscript — never deleting the block from one.** The
   markers are `//` on purpose: `vendor.js` strips whole-line comments, so adding or moving them
   leaves the vendored assets byte-identical and no gate needs re-baselining.

9. **eBay's variant map is static — do not add a click to reach it.** The eBay scope notes
   proposed a click-then-read for the size dropdown, on the evidence that `.x-msku select` yields
   0 options and `[role="option"]` looked empty. Both observations are real and the conclusion was
   wrong. Verified 2026-08-27 on item `225056546791`: the entire map — every option, its
   `outOfStock` state, its price, its remaining quantity — is in a static `<script>` at
   document-idle, anchored at `"MSKU":{"_type":"VariationViewModel"`, and `outOfStockLabel`
   ("(Out of stock)") is in the same object. The click only makes eBay *render* a label it already
   has. Read-only (rule 4) therefore stands unamended, and re-introducing a click would mean a
   document-wide button sweep on pages carrying *Buy It Now*, *Place bid* and *Make offer*.

   Three traps in that payload, each producing confident nonsense rather than an error:

   - **The key space is flat and global across axes.** A 4-axis listing puts all 29 options in one
     `menuItemMap`, each axis owning a disjoint slice. Iterating it directly yields sizes, colours
     and pack counts jumbled together. Group through `selectMenus`.
   - **`matchingVariationIds[0]` is only safe on single-axis listings.** On the 4-axis one the
     lengths ran 137, 56, 29, 30, 94, 44, 55, 8, 8, 8. Taking `[0]` reports an arbitrary SKU's
     price as the option's.
   - **`enabled` is selection state, not availability.** Every entry is `enabled: false` on a
     freshly loaded page. `outOfStock` is the field.

   Also: `showMskuPriceRange` is **not** a price-variance signal — it was `false` on a listing
   spanning $12.90 to $49.90 across 7 distinct prices. It is a display preference. Compute
   variance from `variationsMap`.

   Unlike Amazon's twister, eBay **does** ship per-variant prices
   (`variationsMap[id].binModel.price.value.value`). Do not carry an assumption in either
   direction between the two sites.

10. **Row collectors use `pickAll()`, never `cands.join(',')`.** A joined selector unions every
    candidate. When candidates are nested wrappers around the same row — and on eBay
    `.su-card-container` sits inside `.s-card` — the union returns each row once per matching
    candidate. Live on 2026-08-27: 140 nodes for 70 cards, duplicates at adjacent indices, and a
    `full({limit: 600})` that reported 496 rows for 243 distinct items. `pickAll` takes the first
    candidate that matches anything, which is what `pick`/`pickText` have always done for single
    elements. The Amazon side had a hand-rolled version of the same idea and now uses the helper.

    Row collectors should also **scope to the results container** (`#srp-river-results` on eBay)
    and **de-duplicate by id**: the same listing legitimately renders twice when it is in both the
    carousel and the river.

11. **`full()` must lift `_missing` and `_warn` onto the envelope.** Through eBay 0.1.0 they lived
    only where they were produced — `item()._missing` at `out.item._missing`, with `out._missing`
    undefined. The skill's own loop says "check `_missing` and `_warn` on every result", and
    following that instruction returned a clean bill of health on a holed record. That is the
    failure that *hides* the other failures, which is why it outranks the holes themselves. Fixed
    at the envelope in `hoist()` rather than by asking readers to remember nested keys; the nested
    copies stay put, so it is an index, not a move.

## There are TWO skill files and they are meant to differ

| | Where | What it is |
|---|---|---|
| Repo skill | `.claude/skills/shopping-research/` | **Public and generic.** Source of truth for logic, findings and guidance |
| Plugin skill | `plugin/skills/shopping-research/` | **Personal.** The operator's own build, distributed through their account's plugin store |

Each is a tree, not a file: `SKILL.md` routes and holds the shared discipline, and the
site-specific detail lives in `references/amazon.md` and `references/ebay.md`.

The plugin variant names the operator's machines, addresses them directly, bundles `bin/orders.js`,
and routes purchase history through its own `references/` rather than a repo checkout. **This
divergence is correct — do not "fix" it by overwriting either file with the other.** The personal
detail belongs in the plugin precisely because this repo is public; `plugin/` is gitignored for the
same reason, and a skill file that names a real machine has no business being pushed here.

What is NOT correct is drift: one file learning something the other never hears about. That is how
the review-filter guidance outlived its accuracy and got a live session blocked. So:

```bash
node bin/skill-drift.js --check    # nonzero when one changed and the other didn't
node bin/skill-drift.js --diff     # exactly what to carry across
node bin/skill-drift.js --accept   # re-baseline once you have ported it
```

Baseline lives in `skill-sync.json` and stores **hashes only** — never the plugin's content.
`skill-drift.js` hashes **every `*.md` in the tree**, not just `SKILL.md`. That distinction did
not exist when the skill was one flat file, and it matters now: a corrected selector or an
"this parameter is inert" note lands in a *reference*, and a SKILL.md-only check would call that
"in step" while the plugin kept serving the old text. Assets are excluded — `vendor.js --check`
already gates those byte for byte.

The plugin tree is versioned in a **private** sibling repo,
`dataterminals/ShoppingClaudeBridge-plugin`, cloned into `plugin/` here. That repo pins
`eol=lf`: with a global `autocrlf=true`, a clone on a second machine would otherwise rewrite
`amzx.min.js` to CRLF, change its hash, and break both the byte-identical property and the
baseline above. To set up a second machine:

```bash
git clone git@github.com:dataterminals/ShoppingClaudeBridge-plugin.git plugin
node bin/skill-drift.js --check
```
On a machine whose git talks to GitHub over HTTPS, that SSH URL fails with `Host key verification
failed` before it ever reaches auth. Use the `gh` credential path instead — same result, no keys
to place:

```bash
gh repo clone dataterminals/ShoppingClaudeBridge-plugin plugin
```
Porting is deliberately manual, because unlike `bin/vendor.js` there is no mechanical transform
between the two: a human decides which changes are generic and which are personal.

### Building the bundle to hand to Cowork

```bash
node bin/package.js            # -> amazon-claude-bridge.plugin in the repo root (gitignored)
node bin/package.js --list     # what would go in, without writing
```

A `.plugin` is a zip with `.claude-plugin/plugin.json` at the **archive root**, and the bundler
refuses to write one unless `vendor.js --check` and `skill-drift.js --check` both pass **and**
`plugin/`'s copy of `amzx.min.js` is byte-identical to the vendored one. That last gate is the
point of the script: `vendor.js` cannot see `plugin/`, so the bundled copy is hand-maintained and
is the one that silently falls behind — a stale bundle just injects last month's library on every
machine without the userscript, and says nothing.

Output is deterministic (fixed 1980 timestamps), so `sha256` of a bundle answers "is this the
build I already handed over?". **Do not substitute `Compress-Archive` or
`ZipFile.CreateFromDirectory`**: both write backslash entry names, which is off-spec — the archive
looks correct in Explorer and arrives at a strict extractor as one file called
`skills\shopping-research\SKILL.md`. That is why the container is written by hand.

## Order history

`bin/orders.js` ingests Amazon's official *Request My Data* export into `store/`. Check
`store/by-asin.json` before recommending a purchase — "you already bought this, 2025-08-14, for
$16.49" ends most questions, and the last-paid price is the only price history available
anywhere in this toolchain.

Three rules:

- **`store/` is gitignored and stays that way.** It is a complete purchase history. The repo is
  public.
- **Never scrape order pages.** They are a React app with per-deploy class hashes, and the export
  is official, complete, and needs no maintenance. There is deliberately no orders extractor in
  the userscript.
- **The ingest drops addresses and payment columns on the way in** (`PII_DROP`). Don't "helpfully"
  add them back; nothing this tool answers needs them.

## Known-fragile spots

### Amazon

- **Sponsored detection** currently rests on `.puis-sponsored-label-text` /
  `.puis-label-popover-default`. The latter is a generic popover class kept as a last-resort
  fallback; it earned its place only because it flagged exactly the same 6-of-22 results as the
  specific classes on 2026-08-20. A false positive here silently hides a real product, which is
  the expensive direction — re-check it if organic counts look low.
- **Search-row titles are SPLIT into brand and name on footwear, and the h2 keeps only the brand.**
  Verified 2026-08-27 on `k=vans+filmore+hi`: 44 of 47 rows returned the single token "Vans" — the
  model name, the only thing distinguishing a Filmore from an Ashwood, lives in a sibling
  `a.s-line-clamp-2`. `rowTitle()` recombines them, and only prefixes the brand when the name does
  not already start with it, because on `usb c cable` the anchor still carries the full title and
  blind prefixing produces "Anker Anker USB C Cable". A single-token title is the tell.
- **`#feature-bullets` no longer exists on apparel.** Verified on B0949M2KTN and B09FKF4HWL: the
  container is absent outright and the block moved to `#productFactsDesktopExpander`. `health()`
  reported this as BROKEN unprompted, which is the system working — the record was bullet-less,
  not silently truncated. On apparel that block holds fit, material and care notes, which is what
  a sizing question actually turns on.
- **Orders pages** have no extractor. Amazon's order history is a React app with per-deploy class
  hashes, and it is the wrong thing to scrape anyway: Amazon's official *Request My Data* export
  hands over the entire order history as CSV, once, with no maintenance. Use that.
- **Price** comes from `#corePrice_feature_div`'s *first* `.a-offscreen`; the second is the unit
  price. If a price ever reads suspiciously low, that ordering is the first thing to check.
- **Buy Again's anchor is the fragile part, and `[data-asin]` is not it.** `/gp/buyagain` carried
  **392** valid-looking `[data-asin]` nodes for **24** actual cards on 2026-08-27 — Rufus pills,
  recommendation strips and promo blocks all stamp one — so a generic anchor over-matches by ~16x
  and the first hit is not a Buy Again item. `[class*="_gridCell_"]` is not it either: 232 matches,
  because it is the grid *layout* class and only 24 of those cells held a product. The anchor is
  `.almGridDesktopAsinInfoSummary`, which is un-hashed and carries `data-asin` directly on all 24.
  Around it the `_YnV5L_*` classes are content-hashed CSS modules and will rot — match the middle
  segment (`[class*="_gridOfferRow_"]`) so only the suffix has to hold.
  **The cart-sidebar exclusion is unverified.** With a non-empty cart Amazon renders `#ewc`, whose
  rows also carry `data-asin`; the cart was empty when this was probed, so the `:not(#ewc …)` guard
  on the fallback has never actually been exercised. Re-check it with something in the cart.
- **`#aod-offer-heading` is a heading slot, not a condition field.** On listings carrying a
  Subscribe & Save toggle it holds the purchase mode, and through v0.4.1 that arrived as
  `{"condition": "One-time purchase"}` — a value that is not a condition, reads exactly like one,
  and was flagged by nothing. v0.5.0 validates against Amazon's actual vocabulary and routes the
  purchase mode to its own field. Keep `resale` in `CONDITION_RE`: Amazon Resale offers carry
  "Resale - Like New", and the tighter `/^(new|used)/` would silently drop a real offer. Anything
  the two validators both reject is preserved as `_heading` — if that field ever starts appearing,
  Amazon has put a third thing in the slot.
- **`_dilution` is a risk flag, not a finding**, and it must not be written back into an
  assertion. Through v0.4.1 it declared that a pooled rating "is not a rating for this variant
  alone" on *every* multi-SKU listing. That is more than the page supports: on 2026-08-27 a 7-SKU
  listing served 4.3 / 662 on one child and 4.4 / 531 on a sibling, so Amazon was splitting that
  pool. Nothing on a single page separates the two cases, which is why there is no confidence
  score — `_dilutionCheck` names a sibling ASIN and the caller settles it with one navigation. A
  warning that is always on and sometimes wrong is one the reader learns to skip, and the cost of
  that lands on the listings where the pooling is total.
- **Search-row `was`** is the same trap one level down, and it bit: through v0.4.0 the fallback
  `.a-text-price .a-offscreen` matched the per-unit block, because Amazon nests
  `span.a-price.a-text-price` for "($0.83/feet)" inside `span.a-size-base.a-color-secondary`.
  On 2026-08-23, 7 of the 10 rows carrying a `was` reported it *below* their own price. Fixed in
  v0.4.1 by narrowing the fallback to a `>` chain that cannot enter that wrapper. The invariant
  worth remembering is cheap to check and was never checked: **`was` must exceed `price`.**

### eBay

- **Sponsored detection is unsolved, and `__ebayx` deliberately does not attempt it.** Probed
  2026-08-27 across a 70-card search: the reversed literal `derosnopS` matched **70 of 70** cards,
  forward `/Sponsored/i` matched **0**, and `[class*=sponsored]` / `[aria-label*=Sponsored]`
  matched **0**. The only available signal would flag the entire page as advertising. On the
  Amazon side a false positive hides one real product; here it would hide all of them. So
  `search()` ships a `_warn` saying ads are not filtered, and the skill must never claim they
  were. Promo cards are dropped by **requiring an item id**, not by ad detection. If someone
  finds a real marker, that `_warn` is what has to change.
- **`li.s-item` is dead.** It is what every eBay scraping guide on the internet still uses and it
  matched **0** nodes on 2026-08-27, against 70 for `.su-card-container` / `.s-card`. It is kept
  as the last fallback in `SEL.search.results` only so an old layout would still resolve. Do not
  reorder it upward.
- **The item-specifics container is `module-evo`, not `section-evo`.** The scope notes concluded
  there was "no working structured selector" after trying `.ux-layout-section--features` and
  `.ux-layout-section-evo__row`. Both are real classes and both are wrong here: the first also
  matches the *condition* section, and the second matches nothing because that section has no
  rows at all. The right anchor is `.ux-layout-section-module-evo__container` filtered by its
  heading, then `.ux-layout-section-evo__col` → `…__labels-content` / `…__values-content`.
  Verified: exactly 1 container, 16 clean pairs.
- **`[role="option"]` nodes are populated but carry no stock state.** The notes reported them as
  empty; they are not — they hold the label and a `data-sku-value-name`. What they do *not* hold
  is availability: `/out of stock/i` matches nowhere in `document.body.innerText` on a listing
  with five dead sizes. Reading them gives you clean-looking labels stripped of the one fact that
  matters, which is the search-card lie one level down. **Availability comes from `menuItemMap`
  only.**
- **Auctions are a different unit.** `.s-card__price` on an auction row is the *current bid* and
  will rise; a row can carry both a bid and a Buy It Now price. `saleFormat` and `_auctionWarn`
  exist so a comparison table does not silently rank a bid against a purchase price.
- **`condition` has no element of its own on a large class of listings.** On a pre-owned listing,
  `[data-testid="x-item-condition"]`, `.x-item-condition-value` and *every* class or testid
  matching `/condition/i` are absent — the field is simply not rendered as a component there. The
  value survives in the item-specifics form with eBay's boilerplate essay appended, so
  `conditionValue()` falls back to it and `conditionGrade()` keeps the part before the first colon.
  `health()` reports which path won, because "no slot" and "no value" are different answers.
  This matters more than it looks: condition is the field eBay sellers are loosest with, and a
  blank that reads as fine is worse than one that reads as absent.
- **`quantity` absent is normal, not broken.** A single-item listing renders no quantity widget and
  carries no "N available" / "N sold" text at all. It is in `OPTIONAL` for that reason — reporting
  it BROKEN is the cry-wolf failure that makes `health()` worth ignoring.
- **`styleCode` precedence is load-bearing and was backwards until 0.3.0.** `Model` is a
  model-*family* name shared by every colorway; `Style Code` is the SKU. Item 186246168843 carries
  both (`Sk8-Hi Mte-1` and `VN0A5HZYY49`) and the field returned the family name — which inverts
  its documented purpose, since dedupe on `(seller, styleCode, price)` would then collapse three
  colorways into one row. Order is `Style Code` → `MPN` → `Model`.
- **`saleFormat` must never default to `bin`.** eBay renders a fixed-price-with-offers listing as
  "or Best Offer" with **no** "Buy It Now" row, so testing only for the latter left 51 of 65 rows
  unclassified on an `LH_BIN=1` search — where every row is a Buy It Now by definition. Both
  phrases now count, and whatever is left is `'unknown'` with a `_formatWarn`. Absence of evidence
  must not read as "fixed price": an auction whose bid text failed to parse would otherwise put a
  rising current bid in the price column, which is the worst-shaped error this library can make.
- **`sizeHint` only populates when eBay's size facet is applied** — 0 of 60 rows unfiltered, 37 of
  40 facet-filtered. That is correct (it reads the subtitle aspect) but a reader seeing sixty
  nulls could conclude the listings carry no size information and rule out the page.
- **The MSKU anchor is the single point of failure for the best data on the site.** It is a typed
  model name (`"MSKU":{"_type":"VariationViewModel"`), which is far more durable than eBay's
  content-hashed CSS classes — but if it moves, `variants()` returns null and `full()` says so via
  `variantsNote`. `health()` reports it separately from the selectors for that reason.
