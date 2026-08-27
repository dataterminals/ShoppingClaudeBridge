---
name: shopping-research
description: Research products on amazon.com and ebay.com — search, compare candidates across both markets, check price and shipping, vet sellers, read the variant map, and check stock before recommending. Extracts compact structured data through the __amzx and __ebayx libraries instead of reading whole pages. Use whenever the user pastes an Amazon, amzn.to or eBay link, asks about a product, asks to compare or find the best option in a category, asks whether something is a good price or a good buy, asks about a seller, a rating, or reviews, or asks what they previously bought or paid. Do not use for placing orders, bidding, or operating a cart.
---

# Shopping research — Amazon and eBay

The user's browser has **ShoppingClaudeBridge** installed, which publishes two read-only
extractor libraries:

| Site | Global | Reference |
|---|---|---|
| `www.amazon.com` | `window.__amzx` | [references/amazon.md](references/amazon.md) |
| `www.ebay.com` | `window.__ebayx` | [references/ebay.md](references/ebay.md) |

Extract through them. **Do not read shopping pages with `read_page` or `get_page_text`** — a
search page serialises to tens of KB and you will run out of context after three or four
products.

**Never operate a cart, buy, bid, checkout, or account control.** This skill researches. The user
buys. That includes eBay's *Place bid* and *Make offer*, which are irreversible in a way an
Amazon cart is not.

## The two markets are not the same shape, and the report must not pretend they are

Amazon is a catalogue. eBay is a market. On Amazon, condition, seller and postage are mostly
constant, so `price` is a decision-grade number by itself. On eBay every one of those is a
variable the seller sets, and `price` alone is **wrong**:

- Shipping ranged $0.00–$19.00 across one real run. On a live 60-row search, **57 of 60 positions
  changed** when sorted by `total` instead of `price`. Always rank eBay on `total`.
- Returns has three states, not two, and the gap between "seller pays" and "no returns" is worth
  more than $15 of sticker price on anything that might not fit.
- Condition is seller-asserted and unverified.

So a cross-market table must carry those columns for the eBay rows, and must not silently compare
an Amazon `price` against an eBay `price`. Compare landed cost to landed cost.

## Preflight — check this before promising anything

**Pick the browser BEFORE the liveness probe.** With more than one Chrome connected,
`tabs_context_mcp` hard-errors rather than guessing which one you meant — and the labels on offer
("Browser 1 (Windows)", "Browser 2 (Windows)") do not say which machine is which, so the user
cannot answer at a glance either. Hitting that mid-session costs a full round-trip before a single
byte has been read. Get it out of the way first:

```
mcp__claude-in-chrome__list_connected_browsers   # how many, and what they are called
mcp__claude-in-chrome__select_browser            # commit to one
```

One browser connected: select it and carry on without asking. Two or more: ask once, quoting the
labels you were given back to the user. If those labels are unhelpfully generic, tell them the
browsers can be renamed in the Chrome extension — it is a one-time fix that removes this question
permanently.

This also settles Tier 1 vs Tier 2 before you spend anything discovering it, because the
userscripts are installed per-browser.

**Use claude-in-chrome, not an in-app or cloud browser.** Prices, Prime eligibility, delivery
estimates, eBay's location-based postage quotes and the `Purchased …` badge all depend on the
user's signed-in session, and the userscripts are installed in their real browser.

**Probe liveness FIRST — before any library check.** The first thing that can fail is
`javascript_tool` itself, and when it does, every probe looks identical to "the library is
missing". Make this the first JS call of the session:

```js
1  // liveness probe
```

| Probe result | Meaning | Do |
|---|---|---|
| returns `1` | JS execution works | continue to the library check |
| **`Permission for this action was denied by the … classifier`** | a safety classifier refused the payload | **do not retry, do not rephrase.** Name the refused call and stop |
| **`javascript_tool did not respond in time`** | usually an unanswered permission prompt in the Chrome side panel | ask the user to check the side panel. **One retry, then stop** |

Only once the probe returns `1`:

- **The library for this site is undefined** → go to the ladder below. Do not conclude the tooling
  is broken — a browser without it is the expected case in a hosted or sandboxed environment.
- **No `mcp__claude-in-chrome__*` tools at all** → you cannot reach the user's browsers from this
  environment. Report that plainly instead of substituting a different browser and implying the
  results are equivalent.
- **Signed out** → on Amazon, `#nav-link-accountList` reads "Sign in". Say the figures are the
  signed-out view. **Do not sign in**, and do not present them as the user's own.
- **No filesystem / no `store/`** → purchase-history answers are unavailable. Do not guess, and do
  not scrape order pages.

**Never present unverified data in the shape of an extractor capture.** If you did not get results
through the library, you do not know what you are looking at — see the sponsored rules below,
which differ per site and where getting it wrong is a material error.

### Getting the library: a three-tier ladder, in order

**Tier 1 — the installed userscript. This is the happy path.** If `typeof __amzx !== 'undefined'`
(or `__ebayx` on eBay), use it. Zero cost, zero injection. This is the normal case on an
operator's own machine, which is where most work happens. Try this first and expect it to succeed.

**Tier 2 — inject the vendored copy.** If the global is undefined, read the matching asset from
this skill's own directory and evaluate that string in the page:

| Site | Asset | Cost per injection |
|---|---|---|
| Amazon | `assets/amzx.min.js` | ~31 KB of context |
| eBay | `assets/ebayx.min.js` | ~21 KB of context |

It is local, version-locked to this skill, and reviewed at install time. The skill directory is
announced when this skill loads; if it is not to hand:

```bash
find ~/.claude /root/.claude -path '*shopping-research/assets/*.min.js' 2>/dev/null
```

That cost is roughly what one raw search-results read costs, so it pays for itself the moment you
make two calls on the same page — and it is pure waste if you inject it to read one field. Prefer
Tier 1 deliberately rather than falling into Tier 2 by habit. **Inject only the site you are on.**

**Tier 3 — stop.** No library and no vendored asset: name the missing capability and stop. You may
read the page with ordinary browser tools as an explicitly labelled degraded mode, but say so, and
expect it to cost 10–30× the tokens.

> **Never fetch code over the network and eval it.** A previous version of this skill told you to
> `fetch()` the library from GitHub and `(0, eval)` it. That is the textbook shape of what safety
> tooling exists to stop, and it was **blocked by a classifier** in a real session — correctly, and
> not as a flake. `main` is mutable, so what would execute is not knowable at review time. Do not
> reintroduce it, and do not route around a denial by rephrasing the payload.

> **Never `WebFetch` an eBay URL.** A WebFetch of an eBay search for Vans hi-tops returned a clean,
> well-formed markdown table of **Bobby Witt Jr. baseball cards** — plausible titles, plausible
> prices, plausible seller handles, all completely unrelated to the query. This is worse than an
> error because it has the shape of a success and would sail straight into a comparison table.
> Browser only. Nobody has tested whether Amazon does the same thing, so do not assume it is safe
> there either.

## The loop

0. If the Chrome tools are deferred, load them in **one** ToolSearch call — don't spend a
   round-trip per tool:
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__tabs_close_mcp`
   Close any tab you opened when you're done.
1. Navigate the tab to a URL you built from the parameters in the site reference — don't click
   through UI.
2. `await __amzx.full()` / `await __ebayx.full()`. Both are async; return the call directly, the
   eval has REPL semantics and top-level `await` works.
3. Check `_missing` and `_warn` on **every** result before trusting it. `full()` lifts both onto
   the top level, so the envelope is enough — you do not have to remember which nested key a hole
   was reported under. (Before 0.2.0 it did not, and this instruction quietly returned a clean
   bill of health on a holed record.) `_missing` carries full paths like `item.condition`;
   `_warn` names where the caveat prose lives. A thin capture is far more often a broken selector
   than a genuinely sparse product — if either is substantial, run `health()` before believing
   anything.
4. Report as a comparison table, not prose.

**Extra data costs a navigation, not an option flag.** Neither library makes network requests.
Amazon's all-sellers panel needs `?aod=1`; eBay's per-seller history needs the seller page. See
the site references.

## When a page won't load

Both sites interpose. They are different animals and conflating them is a mistake in both
directions — treating a transient error as a wall wastes a working path, treating a real wall as
transient invites a retry loop against a bot check.

**eBay — transient, self-clearing.** Two shapes, one cure: `/splashui/challenge` ("Pardon Our
Interruption"), and a plain "Something went wrong on our end" error page carrying a trace id. Both
were hit on ordinary navigations and both cleared with a ~5s wait plus **one** re-navigation of
the identical URL.

> **Exactly one timed wait, exactly one re-navigation, then stop and report. Never interact with
> the challenge itself, ever, and never loop.** `full()` returns a `blocked` field and an `error`
> saying which shape it was.

**Amazon — captcha is a wall.** `full()` returns `blocked: 'captcha'`. A human has to clear it in
that browser. Do not attempt it.

**Other retailers — report the wall and stop.** Cloudflare interstitials block `WebFetch` *and* a
live browser. Name the retailer, say what blocked you, hand the user the URL to open themselves.
Do not retry, do not cycle user agents or headers, and never work around a bot check or a CAPTCHA.
A refusal is a result, not an obstacle to be re-attempted in a different shape. A comparison you
could not complete belongs in the report as a stated gap — silence reads as "I checked and Amazon
was cheapest", which is a different claim entirely.

## Reporting

Lead with a table. Columns that actually change a decision:

**Amazon:** `# | Product | Price | Unit | ★ | Reviews | Sold by | Notes`

**eBay:** `# | Item | Price | Ship | Total | Cond | Returns | Seller (count + %) | Notes`

Then a short recommendation with the reason, and the rule-outs with *why* — the rule-outs are the
part that saves the user repeating this later.

Three rules that are not optional:

- **State `sponsoredRemoved` on every Amazon search report, without exception.** About a quarter of
  a plain Amazon search page is advertising, and a report that omits the figure is
  indistinguishable from one where filtering never happened. "16 organic results, 6 ads filtered"
  takes four words.
- **Never claim ads were filtered on eBay.** They are not. eBay has no reliable ad marker in the
  DOM and `__ebayx` refuses to guess — see [references/ebay.md](references/ebay.md). The result
  carries a `_warn` saying so; carry it through to the user rather than dropping it.
- **Never print a seller percentage without its count.** "100% positive" across 32 sales and
  "99.7%" across 10,025 are different objects, and the card shows the least informative version.

If `ownedSince` is set on any Amazon result, lead with that — Amazon is reporting the user already
bought it, and that usually ends the question.

## Check purchase history first

Amazon only, and only where there is a filesystem. If `store/by-asin.json` exists in the repo,
**check it before recommending anything** — it is the local mirror of Amazon's official
order-history export and it answers things the live site can't. Commands and caveats are in
[references/amazon.md](references/amazon.md).

There is no eBay equivalent ingested. eBay does show sold-listing history on the site, which is
real price history Amazon does not have — but it is not wired into this skill, so do not imply
you checked it.

## What neither side can tell you

**Price history.** Neither library sees it. If the user asks whether something is a good price,
say plainly that you can compare against current alternatives but cannot see last month.
The Amazon order export is the one exception, and only for things they already bought.

**Whether a listing is honest.** State what you observed and let the user judge. Don't refuse to
report a product because it looks suspicious, and don't declare a listing fraudulent — describe
the signal.
