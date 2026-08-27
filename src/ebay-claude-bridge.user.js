// ==UserScript==
// @name         eBay Claude Bridge
// @namespace    https://github.com/dataterminals/AmazonClaudeBridge
// @version      0.1.0
// @description  Read-only extractor library for ebay.com. Exposes window.__ebayx so an assistant driving the browser can pull a compact JSON record of the current page instead of reading a 60 KB accessibility tree. Never clicks a control, submits a form, or reads credentials.
// @author       dataterminals
// @homepageURL  https://github.com/dataterminals/AmazonClaudeBridge
// @supportURL   https://github.com/dataterminals/AmazonClaudeBridge/issues
// @match        https://www.ebay.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/dataterminals/AmazonClaudeBridge/main/src/ebay-claude-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/dataterminals/AmazonClaudeBridge/main/src/ebay-claude-bridge.user.js
// @noframes
// ==/UserScript==
//
// DESIGN NOTES (for the next maintainer — human or Claude):
//
//   * SAME CONTRACT AS THE AMAZON HALF. A library, not a feature. No UI, no hotkey, no page
//     mutation. It defines window.__ebayx and stops. Same <script>-tag loader for the same
//     reason (see the bottom of this file, and rule 1 in CLAUDE.md).
//
//   * READ-ONLY, AND IT DID NOT HAVE TO BE NEGOTIATED. The eBay scope notes proposed a
//     click-then-read for the size dropdown, because `.x-msku select` yields 0 options and the
//     [role="option"] nodes were reported empty. Probed live 2026-08-27 on item 225056546791:
//     the whole variant map — every size, its stock state, its price, its remaining quantity —
//     is sitting in a static <script> at document-idle, and `outOfStockLabel` ("(Out of stock)")
//     is in the same object. The click only makes eBay RENDER a label it already has. So there
//     is no interaction here, no allowlist, no deny-list, and rule 4 stands unamended. Do not
//     add a click back.
//
//   * NEVER WebFetch AN EBAY URL. A WebFetch of an eBay search for Vans hi-tops returned a
//     clean, well-formed table of Bobby Witt Jr. BASEBALL CARDS — plausible titles, plausible
//     prices, plausible seller handles, all unrelated to the query. It has the shape of a
//     success and nothing about it announces the failure, so it sails straight into a comparison
//     table. Browser only. Same family of rule as "never fetch remote code and eval it".
//
//   * THE SEARCH LAYER LIES ABOUT STOCK. A result card's size aspect ("Brand New · VANS ·
//     US W 9") is a listing ASPECT, not an inventory check. Verified: a card advertising US W 9
//     belonged to a listing whose own variant map marks 9.0 US Women out of stock. That is why
//     the field is called `sizeHint` and never `size`. Treat it as a filter hint. The item
//     page's variants() is the only stock truth.
//
//   * PRICE IS NOT THE PRICE. Shipping ranged $0.00-$19.00 across one real run and inverted the
//     ranking twice. Every row carries {price, shipping, total} and `total` is the sort key.
//
//   * COMPACTNESS IS THE PRODUCT, and `_missing` / `_warn` mean what they mean on the Amazon
//     side. Read them before trusting a capture.
//
'use strict';
(function () {
  function __ebayxLib() {
  'use strict';
  const VERSION = '0.1.0';

  // --8<-- shared core: START. Byte-identical across every *.user.js in src/.
  // Verify with `node tests/core-parity.test.js`. These markers are `//` on purpose:
  // bin/vendor.js drops whole-line // comments, so adding them leaves the vendored
  // asset byte-identical and neither --check gate needs re-baselining.
  /* ---------------------------------------------------------------- utils */

  const $ = (sel, root = document) => { try { return root.querySelector(sel); } catch { return null; } };
  const $$ = (sel, root = document) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

  // Collapse whitespace, strip the zero-width junk Amazon sprinkles into labels.
  const clean = (s) => (s == null ? null : String(s)
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null);

  const clip = (s, n) => { const c = clean(s); return c && c.length > n ? c.slice(0, n - 1) + '\u2026' : c; };

  // First candidate selector that yields an element.
  const pick = (cands, root = document) => {
    for (const c of cands) { const el = $(c, root); if (el) return el; }
    return null;
  };

  // textContent minus <style>/<script> payloads. Amazon ships inline CSS *inside* feature
  // containers — #acBadge_feature_div holds a stylesheet on products that have no badge — so
  // raw textContent returns a wall of CSS. That reads as a present, non-empty value and
  // silently invents an "Amazon Choice" badge that was never on the page.
  const txtOf = (el) => {
    if (!el) return null;
    if (!el.querySelector || !el.querySelector('style,script,noscript')) return clean(el.textContent);
    const copy = el.cloneNode(true);
    for (const n of copy.querySelectorAll('style,script,noscript')) n.remove();
    return clean(copy.textContent);
  };

  // First candidate that yields non-empty text (an element can exist but be blank —
  // .priceToPay .a-offscreen is present and empty on current product pages).
  const pickText = (cands, root = document) => {
    for (const c of cands) {
      const t = txtOf($(c, root));
      if (t) return t;
    }
    return null;
  };

  const pickAttr = (cands, attr, root = document) => {
    for (const c of cands) {
      const el = $(c, root);
      const v = el && el.getAttribute(attr);
      if (v && v.trim()) return v.trim();
    }
    return null;
  };

  // "$1,234.56" / "US$12.34" / "12,34 EUR" -> 1234.56 . Returns null rather than NaN.
  //
  // Takes the FIRST well-formed amount rather than stripping separators across the whole
  // string. Amazon renders a price twice inside one node (offscreen + visible), so "$9.99$9.99"
  // stripped to "9.999.99" parses as 9.999 — a plausible-looking wrong number, which is the
  // worst kind. Seen live in the all-sellers panel: $18.29 arrived as 18.2918.
  const money = (s) => {
    const c = clean(s);
    if (!c) return null;
    const m = c.match(/\d[\d.,]*/);
    if (!m) return null;
    const t = m[0].replace(/[.,]+$/, '');
    // A trailing comma with exactly 2 digits after it is a decimal comma, not a thousands mark.
    const norm = /,\d{2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    const n = parseFloat(norm);
    return Number.isFinite(n) ? n : null;
  };

  // Counts, including Amazon's abbreviated form. Search results render "(22.2K)", so a naive
  // strip-non-digits reads that as 222 — off by two orders of magnitude, and silently.
  const num = (s) => {
    const c = clean(s);
    if (!c) return null;
    const m = c.match(/([\d,.]+)\s*([KMkm])?/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    const suffix = (m[2] || '').toUpperCase();
    return Math.round(n * (suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : 1));
  };

  // Per-unit price renders as "($0.83$0.83 / feet)": the offscreen and the visible span both
  // contribute, so the amount arrives doubled. Strip the parens, then collapse the repeat.
  const unitPrice = (s) => clean((s || '').replace(/[()]/g, '').replace(/^([^\d]*[\d.,]+)\1/, '$1'));

  const currency = (s) => {
    const c = clean(s) || '';
    if (c.includes('$')) return 'USD';
    if (c.includes('\u00A3')) return 'GBP';
    if (c.includes('\u20AC')) return 'EUR';
    return null;
  };

  // Drop nulls / empty arrays / empty objects, recursively. This is where the token savings land.
  const compact = (v) => {
    if (Array.isArray(v)) {
      const a = v.map(compact).filter((x) => x !== null && x !== undefined);
      return a.length ? a : null;
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) {
        const c = compact(val);
        if (c !== null && c !== undefined) o[k] = c;
      }
      return Object.keys(o).length ? o : null;
    }
    if (typeof v === 'string') return clean(v);
    return v === undefined ? null : v;
  };
  // --8<-- shared core: END.
  /* ----------------------------------------------------------- ebay helpers */

  const itemIdFrom = (url) => {
    const m = String(url || '').match(/\/itm\/(?:[^/]+\/)?(\d{9,})/);
    return m ? m[1] : null;
  };
  const itmUrl = (id) => (id ? 'https://www.ebay.com/itm/' + id : null);

  // eBay ships prose as {textSpans:[{text}]}. Join rather than reaching for [0] — a "Was US
  // $55.21 (6% off)" arrives as three spans and [0] is the word "Was".
  const spans = (td) => {
    if (!td || !Array.isArray(td.textSpans)) return null;
    return clean(td.textSpans.map((t) => (t && t.text) || '').join(' '));
  };

  // Titles carry the screen-reader affordance welded onto the end with no separator:
  // "...Rubber Sole 507698Opens in a new window or tab".
  const A11Y_TAIL = /\s*Opens? in a new window or tab\s*$/i;
  const deA11y = (s) => clean(String(s || '').replace(A11Y_TAIL, ''));

  // "Free Standard Shipping. See detailsfor shippingLocated in: Wheeling, Illinois, United
  // States" — one blob holding cost AND origin, with adjacent spans concatenated ("detailsfor").
  // Free is a distinct state from unknown: a null cost must never be summed as zero.
  const shippingInfo = (s) => {
    const text = clean(s);
    if (!text) return null;
    const free = /\bfree\b/i.test(text);
    const cost = free ? 0 : money((text.match(/[+]?\s*\$[\d.,]+/) || [])[0]);
    const loc = (text.match(/Located in:?\s*([^.]+?)(?:\s*$|\.)/i) || [])[1];
    return compact({ text: clip(text, 120), free: free || undefined, cost: cost, from: clean(loc) });
  };

  // Three states, not two, and the gap between (1) and (3) is worth more than $15 of sticker
  // price on anything that might not fit:
  //   "30 days returns. Seller pays for return shipping."
  //   "30 days returns. Buyer pays for return shipping."
  //   "Seller does not accept returns."
  const returnsInfo = (s) => {
    const text = clean(s);
    if (!text) return null;
    if (/does not accept returns|no returns/i.test(text)) return { accepted: false };
    const days = num((text.match(/(\d+)\s*days?\s*returns/i) || [])[1]);
    const payer = /seller pays for return/i.test(text) ? 'seller'
      : /buyer pays for return/i.test(text) ? 'buyer' : null;
    return compact({ accepted: true, days: days, shippingPaidBy: payer });
  };

  // "Was US $55.21 (6% off)". The strikethrough node this used to be read from does not exist
  // on current item pages — .x-price-transparency--discount is where it actually lives.
  const discountInfo = (s) => {
    const text = clean(s);
    if (!text) return null;
    return compact({ was: money((text.match(/\$[\d.,]+/) || [])[0]),
                     pct: num((text.match(/([\d.]+)\s*%\s*off/i) || [])[1]),
                     text: clip(text, 60) });
  };

  /* ------------------------------------------------------- selector registry */
  // Most-specific first, most-durable last. Same doctrine as the Amazon half: when a field
  // breaks, add a candidate HERE, never inline it into an extractor.

  const SEL = {
    item: {
      title:      ['.x-item-title__mainTitle span', '.x-item-title__mainTitle', 'h1.x-item-title'],
      price:      ['.x-price-primary span.ux-textspans', '.x-price-primary',
                   '[data-testid="x-price-primary"]'],
      discount:   ['.x-price-transparency--discount', '.x-additional-info__textual-display'],
      shipping:   ['.ux-labels-values--shipping .ux-labels-values__values',
                   '.ux-labels-values--shipping'],
      returns:    ['.ux-labels-values--returns .ux-labels-values__values',
                   '.ux-labels-values--returns'],
      delivery:   ['.ux-labels-values--deliverto .ux-labels-values__values',
                   '.ux-labels-values--delivery'],
      // The first .ux-textspans under here is the LABEL ("Condition:"); the value is the second.
      // conditionValue() handles that rather than encoding an index into a selector string.
      condition:  ['[data-testid="x-item-condition"]', '.x-item-condition-value'],
      sellerCard: ['.x-sellercard-atf__info', '.x-sellercard-atf'],
      sellerName: ['.x-sellercard-atf__info__about-seller a span',
                   '.x-sellercard-atf__info__about-seller'],
      quantity:   ['.x-quantity__availability', '.d-quantity__availability'],
      // Item specifics: the scope notes reported "no working structured selector" after trying
      // .ux-layout-section--features and .ux-layout-section-evo__row. Both are real classes and
      // both are wrong here — the first also matches the CONDITION section, and the second
      // matches nothing because this section has no rows at all. The container is module-evo
      // and its pairs hang off columns. Verified 2026-08-27: exactly 1 container, 16 clean pairs.
      specSection:['.ux-layout-section-module-evo__container'],
      specHeading:['.section-title__title', 'h2', 'h3'],
      specCol:    ['.ux-layout-section-evo__col'],
      specLabel:  ['.ux-labels-values__labels-content', '.ux-labels-values__labels'],
      specValue:  ['.ux-labels-values__values-content', '.ux-labels-values__values'],
    },
    search: {
      // li.s-item is DEAD. It is what every scraping guide on the internet still uses and it
      // matched 0 nodes on 2026-08-27 while .su-card-container matched 70. Keep .s-card as the
      // fallback; it matched the same 70.
      results:    ['.su-card-container', '.s-card', 'li.s-item'],
      link:       ['a[href*="/itm/"]'],
      title:      ['.s-card__title', '.s-item__title'],
      subtitle:   ['.s-card__subtitle', '.s-item__subtitle'],
      price:      ['.s-card__price', '.s-item__price'],
      attrRow:    ['.s-card__attribute-row', '.s-item__detail'],
      resultCount:['.srp-controls__count-heading', '.result-count__count-heading'],
    },
  };

  // Absent on plenty of healthy pages: most listings carry no discount, plenty are Buy-It-Now
  // only with no separate delivery row, and a search card need not carry a subtitle.
  const OPTIONAL = new Set([
    'discount', 'delivery', 'subtitle', 'attrRow', 'resultCount', 'specHeading',
  ]);

  /* ------------------------------------------------------------- page type */

  function pageType() {
    const p = location.pathname;
    if (/^\/itm\//.test(p)) return 'item';
    if (/^\/sch\//.test(p) || location.search.includes('_nkw=')) return 'search';
    if (/^\/(str|usr)\//.test(p)) return 'seller';
    if (/^\/b\//.test(p)) return 'browse';
    if (/^\/mye\//.test(p)) return 'myebay';
    if (/^\/cart/.test(p)) return 'cart';
    return 'unknown';
  }

  // TWO shapes, one cure, and they must not be conflated with a real wall. Both were hit on
  // ordinary navigations on 2026-08-27 and both cleared with a 5s wait plus ONE re-navigation of
  // the identical URL — no interaction, nothing clicked:
  //   * /splashui/challenge, "Pardon Our Interruption"
  //   * a plain "Something went wrong on our end" error page carrying a trace id
  // The caller's rule is exactly one timed wait, exactly one re-navigation, then stop and
  // report. Never interact with the challenge itself, ever, and never loop.
  function blocked() {
    if ($('.x-item-title__mainTitle') || $('.su-card-container')) return null;
    const body = document.body ? document.body.innerText : '';
    if (/splashui|challenge/.test(location.pathname) || /Pardon Our Interruption/i.test(body)) return 'challenge';
    if (/Something went wrong on our end/i.test(body)) return 'transient-error';
    return null;
  }

  function page() {
    return compact({
      type: pageType(),
      url: location.href.split('?')[0],
      itemId: itemIdFrom(location.href),
      title: clip(document.title, 120),
      blocked: blocked(),
      capturedAt: new Date().toISOString(),
    }) || {};
  }

  /* -------------------------------------------------------------- variants */
  //
  // THE WHOLE POINT OF THE EBAY HALF, and the reason no click is needed. Three traps live in
  // here, and each of them produces confident nonsense rather than an error.

  function mskuModel() {
    const ANCHOR = '"MSKU":{"_type":"VariationViewModel"';
    const KEY = '"MSKU":';
    for (const el of $$('script')) {
      const s = el.textContent || '';
      const at = s.indexOf(ANCHOR);
      if (at === -1) continue;
      const start = at + KEY.length;
      // String-aware brace walk. A naive depth counter breaks on the first seller-written value
      // containing a brace, and this blob is ~450 KB of exactly that kind of prose. This is the
      // step the scope notes reported as "did not parse"; it parses.
      let depth = 0, i = start, inStr = false, esc = false;
      for (; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
      }
      try { return JSON.parse(s.slice(start, i)); } catch (e) { return null; }
    }
    return null;
  }

  function variants() {
    const m = mskuModel();
    if (!m) return null;
    const map = m.menuItemMap || {};
    const menus = m.selectMenus || [];
    const vars = m.variationsMap || {};

    const priceOf = (id) => {
      const bin = (vars[id] || {}).binModel || {};
      const v = bin.price && bin.price.value;
      return v && typeof v.value === 'number' ? v.value : null;
    };

    // TRAP 1: menuItemMap is a FLAT, GLOBAL key space shared by every axis, and each menu owns
    // a disjoint slice of it. Verified on a 4-axis listing: 29 keys, sliced [0,1] / [2..9] /
    // [10,11,12] / [13..28]. Iterating menuItemMap directly yields sizes, colours and pack
    // counts jumbled together with nothing marking which axis each belongs to. Group through
    // selectMenus. Always.
    const axes = menus.map((menu) => {
      const ids = menu.menuItemValueIds || [];
      const options = ids.map((id) => {
        const e = map[String(id)];
        if (!e) return null;
        const matched = e.matchingVariationIds || [];
        const prices = matched.map(priceOf).filter((x) => x != null);
        const lo = prices.length ? Math.min.apply(null, prices) : null;
        const hi = prices.length ? Math.max.apply(null, prices) : null;
        // TRAP 2: matchingVariationIds has length 1 only on a SINGLE-axis listing. On the
        // 4-axis one the lengths were 137, 56, 29, 30, 94, 44, 55, 8, 8, 8 — one colour spans
        // every size and pack count. Taking [0] picks an arbitrary SKU and reports its price
        // and stock as this option's. So quantity is emitted only where it is exact, and price
        // degrades to a range.
        const sig = matched.length === 1
          ? spans(((vars[matched[0]] || {}).quantity || {}).availabilitySignal) : null;
        return compact({
          value: e.valueName,
          // TRAP 3: `outOfStock` is the field. `enabled` is NOT — it tracks selection state,
          // and on a freshly loaded page every entry carries enabled:false (all 16 of them on
          // the listing this was verified against). Reading it reports zero available sizes on
          // every listing on eBay.
          available: !e.outOfStock,
          qtyAvailable: sig ? num((sig.match(/(\d[\d,]*)\s*available/i) || [])[1]) : undefined,
          sold: sig ? num((sig.match(/(\d[\d,]*)\s*sold/i) || [])[1]) : undefined,
          price: lo != null && lo === hi ? lo : undefined,
          priceFrom: lo != null && lo !== hi ? lo : undefined,
          priceTo: hi != null && lo !== hi ? hi : undefined,
          skus: matched.length > 1 ? matched.length : undefined,
        });
      }).filter(Boolean);
      return compact({
        axis: menu.displayLabel,
        options: options,
        availableCount: options.filter((o) => o.available).length,
        totalCount: options.length,
      });
    });

    const allPrices = Object.keys(vars).map(priceOf).filter((x) => x != null);
    const lo = allPrices.length ? Math.min.apply(null, allPrices) : null;
    const hi = allPrices.length ? Math.max.apply(null, allPrices) : null;

    const rec = compact({
      axes: axes,
      variationCount: Object.keys(vars).length,
      price: lo == null ? null : { min: lo, max: hi, distinct: new Set(allPrices).size },
    }) || {};

    // showMskuPriceRange is NOT a price-variance signal, however much it reads like one. On a
    // listing spanning $12.90 to $49.90 across 7 distinct prices it was still false. It is a
    // display preference. Anything that needs to know whether price varies must compute it,
    // which is what `price` above is.
    if (lo != null && lo !== hi) {
      rec._warn = 'Price varies across variants ($' + lo.toFixed(2) + '-$' + hi.toFixed(2)
        + '). The headline price on this page belongs to the selected SKU only.';
    }
    if (axes.length > 1) {
      rec._multiAxis = axes.length + ' axes (' + axes.map((a) => a.axis).join(' x ')
        + '). An option here spans many SKUs, so its price is reported as a RANGE rather than a '
        + 'figure, and its quantity is omitted. Pinning one combination to one price needs '
        + 'menuItemCombinations, which this does not yet decode.';
    }
    return rec;
  }

  /* ------------------------------------------------------------------ item */

  function conditionValue() {
    const el = pick(SEL.item.condition);
    if (!el) return null;
    const parts = $$('.ux-textspans', el).map(txtOf).filter(Boolean);
    const val = parts.find((t) => !/^condition\s*:?$/i.test(t));
    return clip(val || txtOf(el), 60);
  }

  function specifics() {
    const out = {};
    for (const sec of $$(SEL.item.specSection.join(','))) {
      const head = pickText(SEL.item.specHeading, sec) || '';
      if (!/item specifics/i.test(head)) continue;
      for (const col of $$(SEL.item.specCol.join(','), sec)) {
        const k = pickText(SEL.item.specLabel, col);
        const v = pickText(SEL.item.specValue, col);
        if (k && v && Object.keys(out).length < 30) out[clean(k).replace(/:$/, '')] = clip(v, 120);
      }
    }
    return Object.keys(out).length ? out : null;
  }

  // A bare "100% positive" is the least informative version of this data and it is exactly what
  // the card shows. 100% of 32 sales and 99.7% of 10,025 are different objects. Never print the
  // percentage without the count.
  function seller() {
    const card = pick(SEL.item.sellerCard);
    if (!card) return null;
    const text = txtOf(card) || '';
    const pct = parseFloat((text.match(/([\d.]+)\s*%\s*positive/i) || [])[1]);
    return compact({
      name: pickText(SEL.item.sellerName) || clean((text.match(/^([^(]+)\(/) || [])[1]),
      feedbackCount: num((text.match(/\((\d[\d,]*)\)/) || [])[1]),
      positivePct: Number.isFinite(pct) ? pct : null,
    });
  }

  function item() {
    const S = SEL.item;
    const id = itemIdFrom(location.href);
    const priceRaw = pickText(S.price);
    const price = money(priceRaw);
    const ship = shippingInfo(pickText(S.shipping));
    const qty = pickText(S.quantity);
    const spec = specifics();

    const rec = compact({
      itemId: id,
      url: itmUrl(id),
      title: deA11y(pickText(S.title)),
      condition: conditionValue(),
      price: price,
      currency: currency(priceRaw),
      discount: discountInfo(pickText(S.discount)),
      shipping: ship,
      // The sort key. A $29.99 shoe with $14.95 postage loses to a $43.47 one shipping free,
      // and the listing price alone says the opposite.
      total: price != null && ship && ship.cost != null
        ? Math.round((price + ship.cost) * 100) / 100 : undefined,
      returns: returnsInfo(pickText(S.returns)),
      delivery: clip(pickText(S.delivery), 100),
      seller: seller(),
      quantity: qty ? compact({
        available: num((qty.match(/(\d[\d,]*)\s*available/i) || [])[1]),
        sold: num((qty.match(/(\d[\d,]*)\s*sold/i) || [])[1]),
      }) : undefined,
      specifics: spec,
      // Specifics beat the title, and the gap is real: one listing titled "Men's 8 / Women's 9"
      // carried US 8 / UK 7 / EU 40.5 in its own form, and Vans men's 8 is women's 9.5. The
      // title is seller prose; the specifics are a form. This is also where the only reliable
      // colorway identifier lives, on a platform that lists one shoe as Burnt Ochre, Tan and
      // Brown by three different sellers.
      styleCode: spec ? (spec.Model || spec.MPN || spec['Style Code'] || null) : undefined,
    }) || {};

    const want = ['title', 'price', 'condition', 'seller'];
    const missing = want.filter((k) => rec[k] == null);
    if (missing.length) rec._missing = missing;
    if (ship && ship.cost == null) {
      rec._warn = 'Shipping cost did not parse out of "' + clip(ship.text, 60) + '", so `total` '
        + 'is absent rather than wrong. Do not rank this against rows that have one.';
    }
    return rec;
  }

  /* ---------------------------------------------------------------- search */

  function searchRow(el) {
    const S = SEL.search;
    const href = pickAttr(S.link, 'href', el);
    const id = itemIdFrom(href);
    // Promo cards ("Shop on eBay") render in the same container with no item id. Requiring one
    // drops them without having to guess at an ad marker — see the _warn in searchResults().
    if (!id) return null;

    const attrs = $$(S.attrRow.join(','), el).map(txtOf).filter(Boolean);
    const ship = shippingInfo(attrs.find((t) => /delivery|shipping|postage/i.test(t)));
    const priceRaw = pickText(S.price, el);
    const price = money(priceRaw);
    const bidM = (attrs.find((t) => /\bbids?\b/i.test(t)) || '').match(/(\d+)\s*bids?/i);
    const bids = bidM ? num(bidM[1]) : null;
    const hasBin = attrs.some((t) => /buy it now/i.test(t));
    const watchM = (attrs.find((t) => /watchers?/i.test(t)) || '').match(/(\d[\d,]*)\s*watchers?/i);
    const locRow = attrs.find((t) => /^Located in/i.test(t));
    const segs = (pickText(S.subtitle, el) || '').split(/\s+·\s+/).map(clean).filter(Boolean);

    return compact({
      itemId: id,
      url: itmUrl(id),
      title: deA11y(pickText(S.title, el)),
      // Segment 0 is the condition ladder; the rest are listing aspects. The size aspect is a
      // HINT — it is not stock-checked against the listing's own variant map. Never call it
      // `size`, and never rank on it without opening the item.
      condition: segs[0] || null,
      sizeHint: segs.slice(1).find((s) => /\bUS\s*[MWY]?\s*[\d.]+|\bsize\b/i.test(s)) || null,
      aspects: segs.length > 1 ? segs.slice(1) : undefined,
      price: price,
      currency: currency(priceRaw),
      shipping: ship,
      total: price != null && ship && ship.cost != null
        ? Math.round((price + ship.cost) * 100) / 100 : undefined,
      saleFormat: bids != null ? (hasBin ? 'auction+bin' : 'auction') : (hasBin ? 'bin' : undefined),
      bids: bids != null ? bids : undefined,
      watchers: watchM ? num(watchM[1]) : undefined,
      from: ship && ship.from ? undefined
        : clean((locRow || '').replace(/^Located in:?\s*/i, '')),
    });
  }

  function searchResults(opts) {
    opts = opts || {};
    const limit = opts.limit || 24;
    const nodes = $$(SEL.search.results.join(','));
    const rows = [];
    for (const el of nodes) {
      if (rows.length >= limit) break;
      const r = searchRow(el);
      if (r) rows.push(r);
    }

    const out = compact({
      resultCount: num(pickText(SEL.search.resultCount)),
      shown: rows.length,
      scanned: nodes.length,
      rows: rows,
    }) || {};

    // SPONSORED DETECTION IS UNSOLVED ON EBAY AND THIS DOES NOT GUESS. Probed 2026-08-27 across
    // a 70-card search: the reversed literal "derosnopS" matched 70 of 70 cards, forward
    // /Sponsored/i matched 0, and [class*=sponsored] / [aria-label*=Sponsored] matched 0. So the
    // one available signal would flag the ENTIRE page as advertising. On the Amazon side a false
    // positive silently hides one real product; here it would hide all of them. Saying "ads not
    // filtered" is the honest output, and the caller must not claim otherwise.
    out._warn = 'Sponsored placements are NOT filtered out of these rows — eBay has no reliable '
      + 'ad marker in the DOM (the only candidate matched every card on the page). Unlike the '
      + 'Amazon extractor, do not tell the user that ads were removed.';
    const auctions = rows.filter((r) => r.saleFormat && r.saleFormat.indexOf('auction') === 0);
    if (auctions.length) {
      out._auctionWarn = auctions.length + ' of ' + rows.length + ' rows are auctions, where '
        + '`price` is the CURRENT BID and will rise. Their `total` is not comparable with a '
        + 'Buy It Now row.';
    }
    return out;
  }

  /* ------------------------------------------------------------------ full */

  async function full(opts) {
    opts = opts || {};
    const meta = page();
    if (meta.blocked) {
      return Object.assign({}, meta, {
        error: meta.blocked === 'challenge'
          ? 'eBay served its bot challenge. Wait ~5s and re-navigate the SAME url ONCE. If it '
            + 'persists, stop and report — never interact with the challenge itself.'
          : 'eBay served a transient error page. Wait ~5s and re-navigate the SAME url ONCE, '
            + 'then stop and report.',
      });
    }
    const out = Object.assign({}, meta, { _v: VERSION });
    try {
      if (meta.type === 'item') {
        out.item = item();
        const v = variants();
        if (v) out.variants = v;
        else out.variantsNote = 'no MSKU model on this page — either a single-SKU listing, or '
          + 'the "MSKU":{"_type":"VariationViewModel" anchor has moved. __ebayx.health() says which.';
      } else if (meta.type === 'search') {
        out.search = searchResults(opts);
      } else {
        out.note = 'no extractor for page type "' + meta.type + '"; use __ebayx.text() for a rough read';
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  }

  /* ---------------------------------------------------------------- health */

  function health() {
    const t = pageType();
    const groups = t === 'item' ? { item: SEL.item }
      : t === 'search' ? { search: SEL.search }
      : { item: SEL.item, search: SEL.search };
    const report = { version: VERSION, pageType: t, url: location.href.split('?')[0],
                     ok: [], absent: [], broken: [] };
    for (const gname of Object.keys(groups)) {
      const g = groups[gname];
      for (const field of Object.keys(g)) {
        const cands = g[field];
        const idx = cands.findIndex((c) => $(c));
        const name = gname + '.' + field;
        if (idx === -1) {
          (OPTIONAL.has(field) ? report.absent : report.broken).push(name);
        } else {
          report.ok.push(name
            + (idx ? ' (fallback #' + idx + ')' : '')
            + (txtOf($(cands[idx])) === null ? ' [element only, no text]' : ''));
        }
      }
    }
    // The variant map is not a selector, so the loop above cannot reach it — but it is the most
    // valuable thing on an item page and its anchor is the thing most likely to move.
    if (t === 'item') {
      const m = mskuModel();
      if (m) {
        report.ok.push('item.mskuModel (' + (m.selectMenus || []).length + ' axes, '
          + Object.keys(m.variationsMap || {}).length + ' variations)');
      } else {
        report.absent.push('item.mskuModel (single-SKU listing, or the anchor moved)');
      }
    }
    report.summary = report.ok.length + ' ok, ' + report.absent.length
      + ' absent-but-optional, ' + report.broken.length + ' BROKEN';
    return report;
  }

  // Escape hatch: rough visible text, for page types with no extractor yet.
  function text(max) {
    const el = document.querySelector('#mainContent, .x-item-title, #srp-river-results, main, body');
    return clip(el ? el.innerText : null, max == null ? 4000 : max);
  }

  /* ---------------------------------------------------------------- expose */

  const API = {
    version: VERSION,
    page: page,
    item: item,
    search: searchResults,
    variants: variants,
    specifics: specifics,
    seller: seller,
    full: full,
    health: health,
    text: text,
    SEL: SEL,
    // Exposed for tests/parse.test.js, which runs this file under node with a stub window.
    // Not part of the caller-facing surface — do not build on it.
    _internals: { clean, clip, money, num, currency, compact, txtOf,
                  itemIdFrom, spans, deA11y, shippingInfo, returnsInfo, discountInfo },
  };
  Object.defineProperty(window, '__ebayx', { value: API, writable: true, configurable: true });
  }

  /* --------------------------------------------------------------- publish */
  //
  // Same loader as the Amazon half, for the same reason: whether a userscript's `window` is the
  // page's `window` depends on how the extension injected it, which the script cannot observe.
  // A <script> element always evaluates in the main world because the DOM is shared. See rule 1
  // in CLAUDE.md before simplifying this.
  try {
    const el = document.createElement('script');
    el.textContent = '(' + __ebayxLib.toString() + ')();';
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  } catch (e) {
    // Strict CSP, or no DOM at all (the node test harness). Define it here and let the caller
    // find out from health() whether it can actually see the page.
    try { __ebayxLib(); } catch (_) { /* nothing left to try */ }
  }
})();
