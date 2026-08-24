# CLAUDE.md — AmazonClaudeBridge

Repo-specific rules. General conventions come from the sibling TFW/dataterminals repos.

## What this repo is

A userscript that publishes `window.__amzx` on `www.amazon.com` — a read-only extractor library.
**You are the caller.** The user pastes a product link, you navigate their Chrome there and
evaluate `__amzx.full()`. They should never have to press a key on the page.

Cosmetics (dark mode) live in the sibling repo **AmazonTweaks**. Do not add UI here, and do not
add extraction there.

## How to use it in a session

```js
// after navigating the tab to an amazon.com URL
await __amzx.full()                 // search page or product page — dispatches on page type
await __amzx.full({limit: 40})      // search page, more rows (default 24)
__amzx.health()                     // which selectors still resolve here
```

**Extra data costs a navigation, not an option flag.** There is no fetch path (see rule 7):

```js
// all sellers — the buy box shows one and it is often not the cheapest
navigate(`https://www.amazon.com/dp/${asin}?aod=1`); await __amzx.full()   // -> .offers
// reviews
navigate(`https://www.amazon.com/product-reviews/${asin}/`); await __amzx.full()
```

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
   `node tests/parse.test.js` (parsers), `node tests/orders.test.js` (order ingest),
   `node tests/vendor.test.js` + `node bin/vendor.js --check` (the injected asset matches source),
   `node tests/package.test.js` (the bundle writer),
   `node bin/skill-drift.js --check` (the two skills are in step).

7. **Do not re-add a fetch path — of either kind.** Sub-page fetching was removed in v0.2.0: the
   all-offers AJAX endpoints 404 in every URL shape, and `?aod=1` over XHR omits the
   client-rendered panel. Separately, **never fetch remote code and eval it** — a session was
   blocked by a safety classifier for exactly that, correctly, and a denial must never be worked
   around by rephrasing. Tier 2 injects the local vendored asset instead.

   Reviews: **every** parameter is ignored, not just `critical`. `filterByStar=one_star` returns
   eight 4-and-5-star reviews, and the cap is site-wide. If you think you have found a working
   endpoint, check the returned stars actually match the filter before believing it — the old code
   "worked" in the sense that it returned reviews.

## There are TWO skill files and they are meant to differ

| | Where | What it is |
|---|---|---|
| Repo skill | `.claude/skills/amazon-shopping/SKILL.md` | **Public and generic.** Source of truth for logic, findings and guidance |
| Plugin skill | `plugin/skills/amazon-shopping/SKILL.md` | **Personal.** The operator's own build, distributed through their account's plugin store |

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

The plugin tree is versioned in a **private** sibling repo,
`dataterminals/AmazonClaudeBridge-plugin`, cloned into `plugin/` here. That repo pins
`eol=lf`: with a global `autocrlf=true`, a clone on a second machine would otherwise rewrite
`amzx.min.js` to CRLF, change its hash, and break both the byte-identical property and the
baseline above. To set up a second machine:

```bash
git clone git@github.com:dataterminals/AmazonClaudeBridge-plugin.git plugin
node bin/skill-drift.js --check
```
On a machine whose git talks to GitHub over HTTPS, that SSH URL fails with `Host key verification
failed` before it ever reaches auth. Use the `gh` credential path instead — same result, no keys
to place:

```bash
gh repo clone dataterminals/AmazonClaudeBridge-plugin plugin
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
`skills\amazon-shopping\SKILL.md`. That is why the container is written by hand.

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

- **Sponsored detection** currently rests on `.puis-sponsored-label-text` /
  `.puis-label-popover-default`. The latter is a generic popover class kept as a last-resort
  fallback; it earned its place only because it flagged exactly the same 6-of-22 results as the
  specific classes on 2026-08-20. A false positive here silently hides a real product, which is
  the expensive direction — re-check it if organic counts look low.
- **Orders pages** have no extractor. Amazon's order history is a React app with per-deploy class
  hashes, and it is the wrong thing to scrape anyway: Amazon's official *Request My Data* export
  hands over the entire order history as CSV, once, with no maintenance. Use that.
- **Price** comes from `#corePrice_feature_div`'s *first* `.a-offscreen`; the second is the unit
  price. If a price ever reads suspiciously low, that ordering is the first thing to check.
- **Search-row `was`** is the same trap one level down, and it bit: through v0.4.0 the fallback
  `.a-text-price .a-offscreen` matched the per-unit block, because Amazon nests
  `span.a-price.a-text-price` for "($0.83/feet)" inside `span.a-size-base.a-color-secondary`.
  On 2026-08-23, 7 of the 10 rows carrying a `was` reported it *below* their own price. Fixed in
  v0.4.1 by narrowing the fallback to a `>` chain that cannot enter that wrapper. The invariant
  worth remembering is cheap to check and was never checked: **`was` must exceed `price`.**
