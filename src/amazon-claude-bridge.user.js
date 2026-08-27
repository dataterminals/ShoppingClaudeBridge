// ==UserScript==
// @name         Shopping Claude Bridge — Amazon
// @namespace    https://github.com/dataterminals/ShoppingClaudeBridge
// @version      0.5.0
// @description  Read-only extractor library for amazon.com. Exposes window.__amzx so an assistant driving the browser can pull a compact, de-sponsored JSON record of the current page instead of reading a 60 KB accessibility tree. Never clicks a buy control, submits a form, or reads credentials.
// @author       dataterminals
// @homepageURL  https://github.com/dataterminals/ShoppingClaudeBridge
// @supportURL   https://github.com/dataterminals/ShoppingClaudeBridge/issues
// @match        https://www.amazon.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/dataterminals/ShoppingClaudeBridge/main/src/amazon-claude-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/dataterminals/ShoppingClaudeBridge/main/src/amazon-claude-bridge.user.js
// @noframes
// ==/UserScript==
//
// DESIGN NOTES (for the next maintainer — human or Claude):
//
//   * WHAT THIS IS. A *library*, not a feature. It renders no UI, binds no hotkey, and changes
//     nothing on the page. It defines window.__amzx and stops. The caller is an assistant
//     driving this browser, which navigates to a URL and then evaluates `__amzx.full()`.
//     Cosmetics live in the sibling repo AmazonTweaks; keep the two apart.
//
//   * IT PUBLISHES ITSELF VIA A <script> TAG, and that is not decoration — see the loader at
//     the bottom. Whether a userscript's `window` is the page's `window` depends on how the
//     extension injected it, which the script cannot observe. v0.1.0 relied on `@grant none`
//     meaning main-world, installed fine, and left `__amzx` undefined with no error anywhere.
//     A <script> element always evaluates in the main world because the DOM is shared, so the
//     loader is correct under every injection mode. Do not "simplify" it back to a direct call.
//
//   * READ-ONLY, and narrowly so. DOM reads of the page the caller navigated to. Nothing else:
//     no writes, no form submits, no buy/checkout controls, no credential access, no network
//     requests of any kind, no background crawling.
//
//   * THERE IS NO FETCH PATH, and that is deliberate. v0.1.0 fetched sub-pages for offers and
//     critical reviews. Both were dead on arrival (see the `offers` section below): the AJAX
//     endpoints 404, the offers panel renders client-side, and Amazon ignores
//     filterByStar=critical over fetch AND over real navigation. The caller drives the browser,
//     so the caller navigates; these functions read whatever is in front of them and report a
//     `_needs` hint when the data requires a different URL.
//
//   * COMPACTNESS IS THE PRODUCT. The reason to exist is that the caller pays per token. Every
//     field is capped and trimmed and empty values are dropped. If you add a field, ask what
//     decision it changes — if the answer is "none", leave it out.
//
//   * ALL SELECTORS LIVE IN `SEL`. Amazon reshuffles its DOM constantly. Extraction logic reads
//     from that one registry via pick()/pickText(), which try candidates in order. When a field
//     breaks, add a candidate to SEL — never rewrite the logic. Order candidates most-specific
//     first; the last entry should be the most durable fallback.
//
//   * SILENT DEGRADATION IS THE ENEMY. A scraper that quietly returns null for `price` is worse
//     than one that throws, because the caller reasons confidently about missing data. That is
//     what `__amzx.health()` is for, and why every record carries `_missing`. Check it before
//     trusting a capture that looks thin.
//
'use strict';
(function () {
  function __amzxLib() {
  'use strict';
  const VERSION = '0.5.0';

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

  // Coupon text is prose, and the number buried in it is usually the largest single lever on the
  // page — 30% on a $21.85 item bought two at a time is a $13.11 swing. The trap is that the
  // qualifier shares a sentence with the number: "30% off coupon applied. First Subscribe & Save
  // orders only." is not a 30% discount, it is a 30% discount *if* you also take a subscription,
  // which is a decision rather than a price. A comparison table that prints the raw string wraps
  // or truncates exactly the half that decides the question, so split them here and let the
  // caller render the number and the condition on it separately.
  //
  // Captured live 2026-08-27 on a grocery listing carrying Subscribe & Save.
  const couponInfo = (s) => {
    const text = clean(s);
    if (!text) return null;
    const pctM = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    // Amount only when there is no percentage. "10% off, up to $20" carries both numbers and the
    // $20 is a CAP, not the discount — reporting it as the saving would be the same shape of
    // error as the unit-price traps elsewhere in this file: a plausible, wrong, silent number.
    const amtM = pctM ? null : text.match(/\$\s*\d[\d.,]*/);
    // "coupon applied" is already inside the price shown; "Apply $5 coupon" is not. That decides
    // whether subtracting this from price.current double-counts it.
    const applied = /\bapplied\b/i.test(text) ? true : null;
    const requires =
      /first\b[^.]*\bsubscribe\s*&?\s*save|subscribe\s*&?\s*save[^.]*\bfirst\b/i.test(text)
        ? 'first-subscribe-and-save-order'
      : /subscribe\s*&?\s*save|subscription/i.test(text) ? 'subscribe-and-save'
      // "when you reorder 5 qualifying items" is live Buy Again copy (2026-08-27). An earlier
      // `when you (buy|purchase|order)` missed it, because "reorder" does not start at the `o`.
      : /when you (re)?(buy|purchase|order)|on any \d|buy \d|qualifying items/i.test(text) ? 'multi-buy'
      : /when you spend|orders? over/i.test(text) ? 'minimum-spend'
      : /when you select|coupon available when/i.test(text) ? 'select-option'
      : null;
    return compact({
      pct: pctM ? parseFloat(pctM[1]) : null,
      amount: amtM ? money(amtM[0]) : null,
      applied,
      conditional: requires ? true : null,
      requires,
      text: clip(text, 120),
    });
  };

  // #aod-offer-heading is a HEADING slot, not a condition field, and on listings that carry a
  // Subscribe & Save toggle it holds the purchase mode instead. Verified 2026-08-27: a grocery
  // listing returned condition "One-time purchase" while a plain third-party listing the same
  // day correctly returned "New". There is no such condition as "One-time purchase", and a wrong
  // condition is worse than an absent one — it reads as real and nothing anywhere flags it.
  //
  // So match the vocabulary Amazon actually ships, and return null for everything else.
  // "Resale" is on the list deliberately: Amazon Resale offers carry "Resale - Like New", so the
  // tighter /^(new|used)/ that suggests itself first would have silently dropped a real offer.
  const CONDITION_RE =
    /^(new|used|renewed|refurbished|certified refurbished|collectible|resale|open box|pre[- ]?owned)\b/i;
  const condition = (s) => {
    const c = clean(s);
    return c && CONDITION_RE.test(c) ? c : null;
  };

  // The slot's other known tenant, kept rather than discarded: whether a price is the one-time
  // price or the subscription price is a real difference between two numbers in a table.
  const PURCHASE_MODE_RE = /^(one[- ]?time purchase|subscribe\s*&?\s*save|subscription)/i;
  const purchaseMode = (s) => {
    const c = clean(s);
    return c && PURCHASE_MODE_RE.test(c) ? c : null;
  };

  const asinFrom = (url) => {
    const m = String(url || '').match(/\/(?:dp|gp\/product|product-reviews)\/([A-Z0-9]{10})/i);
    return m ? m[1].toUpperCase() : null;
  };

  // Canonical /dp/ URL with all the tracking cruft removed.
  const dpUrl = (asin) => (asin ? 'https://www.amazon.com/dp/' + asin : null);

  /* ------------------------------------------------------- selector registry */
  // Most-specific first, most-durable last. Add candidates here when a field breaks.

  const SEL = {
    product: {
      title:      ['#productTitle', '#title span#productTitle', 'h1#title'],
      byline:     ['#bylineInfo', '#brand', 'a#bylineInfo'],
      // Verified 2026-08-20: the .priceToPay .a-offscreen node exists but is EMPTY, while
      // #corePrice_feature_div's first .a-offscreen carries "$9.99". Its second one is the
      // per-unit price, so first-match-wins is what we want. .priceToPay's own text is the
      // fallback because the offscreen span inside it can't be relied on.
      price:      ['#corePrice_feature_div .a-price .a-offscreen',
                   '#corePriceDisplay_desktop_feature_div .priceToPay',
                   '#apex_desktop .a-price .a-offscreen',
                   '#priceblock_ourprice', '#priceblock_dealprice', '#priceblock_saleprice',
                   '.a-price .a-offscreen'],
      wasPrice:   ['#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen',
                   'span[data-a-strike="true"] .a-offscreen',
                   '.basisPrice .a-offscreen'],
      unitPrice:  ['#corePriceDisplay_desktop_feature_div .pricePerUnit',
                   '.pricePerUnit', '#corePrice_feature_div .a-size-small.a-color-price'],
      rating:     ['#acrPopover .a-icon-alt', '#averageCustomerReviews .a-icon-alt',
                   'span[data-hook="rating-out-of-text"]'],
      ratingAttr: ['#acrPopover'],
      ratingCount:['#acrCustomerReviewText', '[data-hook="total-review-count"]'],
      availability:['#availability span', '#availability', '#outOfStock .a-color-price'],
      shipsFrom:  ['.tabular-buybox-text[tabular-attribute-name="Ships from"] .tabular-buybox-text-message',
                   '#fulfillerInfoFeature_feature_div .offer-display-feature-text-message',
                   '[tabular-attribute-name="Ships from"]'],
      soldBy:     ['.tabular-buybox-text[tabular-attribute-name="Sold by"] .tabular-buybox-text-message',
                   '#merchantInfoFeature_feature_div .offer-display-feature-text-message',
                   '#sellerProfileTriggerId', '#merchant-info',
                   '[tabular-attribute-name="Sold by"]'],
      delivery:   ['#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
                   '#deliveryBlockMessage', '#delivery-block-message',
                   '[data-csa-c-delivery-time]'],
      coupon:     ['#promoPriceBlockMessage .a-color-success', '[id^="couponText"]',
                   '.couponLabelText', '#vpcButton .a-color-success'],
      image:      ['#landingImage', '#imgTagWrapperId img', '#main-image-container img'],
      breadcrumb: ['#wayfinding-breadcrumbs_feature_div'],
      bullets:    ['#feature-bullets li span.a-list-item', '#featurebullets_feature_div li span'],
      // Anchor on the badge's own text node, not the wrapper div — the wrapper is present
      // (holding only CSS) even when the product has no badge. txtOf() strips the CSS, but
      // naming the text element keeps this honest if that helper is ever changed.
      badgeChoice:['#acBadge_feature_div .ac-badge-text-primary', '#acBadge_feature_div a',
                   '[data-feature-name="acBadge"] .a-badge-text'],
      badgeBest:  ['#zeitgeistBadge_feature_div .badge-text', '#zeitgeistBadge_feature_div a',
                   '.badge-wrapper .best-seller-badge'],
      brandRow:   ['#productOverview_feature_div tr'],
      specRows:   ['.prodDetTable tr',
                   '#productDetails_techSpec_section_1 tr',
                   '#productDetails_detailBullets_sections1 tr',
                   '#technicalSpecifications_section_1 tr'],
      detailList: ['#detailBullets_feature_div li', '#detailBulletsWrapper_feature_div li'],
      asinInput:  ['#ASIN', 'input[name="ASIN"]', '#asin'],
    },
    search: {
      results:    ['div.s-main-slot div[data-component-type="s-search-result"][data-asin]',
                   'div[data-component-type="s-search-result"][data-asin]',
                   'div.s-result-item[data-asin]'],
      title:      ['[data-cy="title-recipe"] h2 span', 'h2 a span', 'h2 span', 'h2'],
      link:       ['[data-cy="title-recipe"] a', 'h2 a', 'a.a-link-normal.s-no-outline'],
      price:      ['[data-cy="price-recipe"] .a-price .a-offscreen', '.a-price .a-offscreen'],
      // #1 is the only markup Amazon reliably reserves for a strike-through list price. The
      // fallback used to be a bare `.a-text-price .a-offscreen`, which also matched the PER-UNIT
      // block: Amazon nests `span.a-price.a-text-price` for "($0.83/feet)" inside
      // `span.a-size-base.a-color-secondary`, so on 2026-08-23 ("usb c cable") 7 of the 10 rows
      // carrying a `was` reported it BELOW their own price — $0.83 against $9.99. The `>` chain
      // cannot reach into that wrapper; it matched exactly the same 7 of 22 rows as #1 did, and
      // never a unit price. Same family of bug as the product-side note in CLAUDE.md: when a
      // price reads too low, suspect the unit price first.
      wasPrice:   ['[data-a-strike="true"] .a-offscreen',
                   ':not(.a-color-secondary) > .a-price.a-text-price > .a-offscreen'],
      unitPrice:  ['.a-price ~ span.a-size-base.a-color-secondary', '.a-size-base.a-color-secondary'],
      rating:     ['[data-cy="reviews-block"] .a-icon-alt', '.a-icon-star-small .a-icon-alt',
                   '.a-icon-star .a-icon-alt', 'i.a-icon-star-small span'],
      ratingCount:['a .s-underline-text', 'span.a-size-base.s-underline-text',
                   '[data-cy="reviews-block"] a .a-size-base'],
      prime:      ['.a-icon-prime', '[aria-label*="Prime"]'],
      badge:      ['.a-badge-text', 'span.a-badge-label-inner .a-badge-text'],
      thumb:      ['img.s-image'],
      // Any hit here marks the result as an ad and drops it from `results`.
      // Ordered most-reliable first. A FALSE POSITIVE is the expensive failure here: it
      // silently hides a genuine product the user might have wanted, and nothing in the
      // output says it happened. So the loose catch-all `.puis-label-popover-default` goes
      // LAST — it is a generic popover class, not a sponsorship marker, and only earns its
      // place because on 2026-08-20 it flagged exactly the same 6 of 22 results as the
      // specific classes did. Verified same day: `sp-sponsored-result` matched nothing.
      sponsored:  ['.puis-sponsored-label-text', '.s-sponsored-label-text',
                   '[data-component-type="sp-sponsored-result"]',
                   'a[aria-label*="Sponsored"]', 'span[aria-label*="Sponsored"]',
                   '.s-sponsored-label-info-icon', '.puis-label-popover-default'],
      resultCount:['[data-component-type="s-result-info-bar"] h1 span',
                   '.s-breadcrumb .sg-col-inner span', '#s-result-info-bar-content span'],
    },
    // Buy Again — /gp/buyagain. Everything here was probed live on 2026-08-27; the numbers in
    // these comments are that page's, and they are the reason each selector is shaped as it is.
    //
    // THE ANCHOR IS THE WHOLE PROBLEM. That page carried 392 valid-looking `[data-asin]` nodes
    // for 24 actual cards — Rufus pills, recommendation strips and promo blocks all stamp one.
    // Anchoring on `[data-asin]` therefore returns ~16x garbage, and the first hit is not a Buy
    // Again item. `[class*="_gridCell_"]` is no better: it matched 232 nodes, because it is the
    // grid LAYOUT class and most cells hold no product at all (24 of 232 had a price).
    //
    // `.almGridDesktopAsinInfoSummary` is the honest anchor: 24 nodes, all 24 carrying
    // `data-asin` directly on the element, and — the reason to prefer it — it is NOT a hashed
    // CSS-module name, so it survives a deploy. The `_YnV5L_*` classes around it are content
    // hashed and will rot; where one is unavoidable, match the middle segment (`_gridOfferRow_`)
    // rather than the full class, so only the suffix has to stay put.
    buyagain: {
      // The `:not()` guards are belt-and-braces for the fallback: with a non-empty cart Amazon
      // renders the `#ewc` cart sidebar, whose rows also carry `data-asin`, and a generic
      // anchor returns whatever is sitting in the cart as if it were a Buy Again item. The
      // cart was empty when this was probed, so that path is UNVERIFIED — it is a guard, not
      // a tested selector. The primary anchor cannot reach into #ewc regardless.
      row:        ['.almGridDesktopAsinInfoSummary[data-asin]',
                   '.alm-grid-desktop-grid-container [data-asin]:not(#ewc [data-asin]):not(.ewc-item)'],
      grid:       ['.alm-grid-desktop-grid-container'],
      // One per card on all 24. This is the price container, and scoping to it is what keeps
      // the offer pills below from being read as the item's price.
      offerRow:   ['[class*="_gridOfferRow_"]'],
      // .a-truncate-full is the untruncated title; .a-truncate-cut is the ellipsised one.
      bTitle:     ['.a-truncate-full', '.a-truncate-cut'],
      bPrice:     ['.a-price .a-offscreen'],
      // Subscribe & Save vs one-time. Labels verified verbatim: "One-time purchase" / "Subscribe
      // & Save" — the same string that leaks into offers().condition, hence purchaseMode().
      bPill:      ['[class*="_offerPill_"]'],
      bPromo:     ['[class*="_singlePromotion"]', '[class*="_promotionContent"]'],
    },
    reviews: {
      card:       ['div[data-hook="review"]', '.review'],
      rTitle:     ['[data-hook="review-title"] span:not(.a-icon-alt)', '[data-hook="review-title"]'],
      rStars:     ['[data-hook="review-star-rating"] .a-icon-alt', '[data-hook="cmps-review-star-rating"] .a-icon-alt'],
      rDate:      ['[data-hook="review-date"]'],
      rBody:      ['[data-hook="review-body"] span', '[data-hook="review-body"]'],
      rVerified:  ['[data-hook="avp-badge"]'],
      rHelpful:   ['[data-hook="helpful-vote-statement"]'],
      // The histogram stopped being a <table>; '#histogramTable tr' matched nothing for a while
      // and the distribution silently came back empty. Percentages now live in leaf spans, and
      // the page renders the whole set twice, so take the first five. Verified 2026-08-21:
      // 79/10/6/2/3 weights to a 4.60 average, which confirms they run 5-star first.
      histPct:    ['#histogramTable .histogram-column-space'],
      ratingsTotal: ['[data-hook="total-review-count"]', '#acrCustomerReviewText'],
    },
    offers: {
      // `div[id^="aod-offer"]` is WRONG and was the original bug: every child div inside an
      // offer is also id-prefixed "aod-offer" (aod-offer-price, aod-offer-soldBy, ...), so it
      // returned 39 "offers" for a product with 3. The real containers are the pinned buy-box
      // offer plus each div#aod-offer. Verified 2026-08-20.
      row:        ['#aod-pinned-offer', 'div#aod-offer'],
      // Same empty-.a-offscreen and CSS-in-container traps as the main price block; txtOf()
      // strips the <style> payload out of #aod-offer-price.
      oPrice:     ['[id^="aod-price-"] .a-offscreen', '#aod-offer-price .a-offscreen',
                   '[id^="aod-price-"]', '#aod-offer-price'],
      oSeller:    ['#aod-offer-soldBy .a-col-right a', '#aod-offer-soldBy .a-col-right span',
                   '[id^="aod-offer-soldBy"] .a-col-right'],
      oShip:      ['#aod-offer-shipsFrom .a-col-right span', '[id^="aod-offer-shipsFrom"] .a-col-right'],
      oCondition: ['#aod-offer-heading'],
    },
  };

  // Fields that are legitimately absent on plenty of perfectly healthy pages: most products
  // have no coupon, no strikethrough list price, no badge. health() reports these as `absent`
  // rather than `broken`, so a genuine selector break is not buried in expected noise.
  const OPTIONAL = new Set([
    'wasPrice', 'unitPrice', 'coupon', 'badgeChoice', 'badgeBest', 'delivery', 'byline',
    'detailList', 'brandRow', 'thumb', 'link', 'badge', 'histRow', 'rVerified', 'rHelpful',
    // Buy Again: a card carries a strikethrough list price, a Subscribe & Save pill and a promo
    // only sometimes — 13, 12 and 10 of 24 respectively on 2026-08-27. Their absence is normal.
    'bPill', 'bPromo',
    // shipsFrom is absent by design on Amazon-sold items: when soldBy is Amazon.com the page
    // collapses the separate "Ships from" row, because it would just say Amazon.com twice.
    // Third-party listings do render it (verified on an AnkerDirect listing, 2026-08-20).
    // Treating it as required made health() report BROKEN on a perfectly healthy page, which
    // is the cry-wolf failure that makes a health check worth ignoring.
    'shipsFrom',
  ]);

  /* ------------------------------------------------------------- page type */

  function pageType() {
    const p = location.pathname;
    // Before the others: /gp/buyagain is matched by none of them, so it fell through to
    // 'unknown' until v0.5.0 and the caller got no extractor on the page a reorder starts from.
    if (/\/buyagain|\/gp\/buy-again/.test(p)) return 'buyagain';
    if (/\/product-reviews\//.test(p)) return 'reviews';
    if (/\/(dp|gp\/product)\//.test(p)) return 'product';
    if (/^\/s\b/.test(p) || location.search.includes('k=')) return 'search';
    if (/order-history|your-orders/.test(p)) return 'orders';
    if (/\/gp\/cart|\/cart\//.test(p)) return 'cart';
    if (/\/hz\/wishlist|\/gp\/registry/.test(p)) return 'list';
    return 'unknown';
  }

  // Amazon renders behind a robot wall sometimes. Say so loudly rather than returning {}.
  function blocked() {
    if ($('#productTitle') || $('div.s-main-slot')) return null;
    const body = document.body ? document.body.innerText : '';
    if ($('form[action*="validateCaptcha"]') || /Enter the characters you see below/i.test(body)) return 'captcha';
    if (/Sorry! Something went wrong/i.test(body)) return 'error-page';
    return null;
  }

  function page() {
    return compact({
      type: pageType(),
      url: location.href.split('?')[0],
      asin: asinFrom(location.href),
      title: clip(document.title, 120),
      blocked: blocked(),
      capturedAt: new Date().toISOString(),
    }) || {};
  }

  /* --------------------------------------------------------------- product */

  function specs() {
    const out = {};
    for (const tr of $$(SEL.product.specRows.join(','))) {
      const k = txtOf($('th', tr));
      const v = txtOf($('td', tr));
      if (k && v && Object.keys(out).length < 30) out[k] = clip(v, 120);
    }
    // Older layout: "Key : Value" inside a bullet list with two nested spans.
    if (!Object.keys(out).length) {
      for (const li of $$(SEL.product.detailList.join(','))) {
        const spans = $$('span', li);
        if (spans.length >= 2) {
          const k = (clean(spans[0].textContent) || '').replace(/[\s:\u200E\u200F]+$/, '');
          const v = clean(spans[1].textContent);
          if (k && v && k.length < 60 && Object.keys(out).length < 30) out[k] = clip(v, 120);
        }
      }
    }
    return out;
  }

  function ratingValue() {
    // The alt text ("4.5 out of 5 stars") is the durable source; the title attr is a backup.
    const alt = pickText(SEL.product.rating);
    if (alt) {
      const m = alt.match(/([\d.]+)\s*out of/);
      if (m && Number.isFinite(parseFloat(m[1]))) return parseFloat(m[1]);
    }
    const t = pickAttr(SEL.product.ratingAttr, 'title');
    if (t) {
      const m = t.match(/([\d.]+)/);
      if (m && Number.isFinite(parseFloat(m[1]))) return parseFloat(m[1]);
    }
    return null;
  }

  // Brand moved out of #bylineInfo on current layouts — that id is simply gone, and
  // #bylineInfo_feature_div is present but empty. The reliable source is now the
  // product-overview table's "Brand" row. Verified 2026-08-20.
  function brandName() {
    const byline = pickText(SEL.product.byline);
    if (byline) return byline.replace(/^(Visit the |Brand: )/i, '').replace(/ Store$/i, '');
    for (const tr of $$(SEL.product.brandRow.join(','))) {
      const cells = $$('td,th', tr);
      if (cells.length >= 2 && /^brand$/i.test(txtOf(cells[0]) || '')) return txtOf(cells[1]);
    }
    return null;
  }

  function product() {
    const S = SEL.product;
    const asinEl = $(S.asinInput.join(','));
    const asin = clean(asinEl ? asinEl.value : null) || asinFrom(location.href);
    const priceRaw = pickText(S.price);
    const rec = {
      asin,
      url: dpUrl(asin) || location.href.split('?')[0],
      title: clip(pickText(S.title), 200),
      brand: clip(brandName(), 60),
      price: compact({
        current: money(priceRaw),
        currency: currency(priceRaw),
        was: money(pickText(S.wasPrice)),
        unit: clip(unitPrice(pickText(S.unitPrice)), 40),
      }),
      rating: compact({
        stars: ratingValue(),
        count: num(pickText(S.ratingCount)),
      }),
      availability: clip(pickText(S.availability), 80),
      shipsFrom: clip(pickText(S.shipsFrom), 60),
      soldBy: clip(pickText(S.soldBy), 60),
      delivery: clip(pickText(S.delivery), 80),
      coupon: couponInfo(pickText(S.coupon)),
      badges: compact([
        pickText(S.badgeChoice) ? 'Amazon Choice' : null,
        pickText(S.badgeBest) ? 'Best Seller' : null,
      ]),
      category: clip($$(S.breadcrumb[0] + ' a').map((a) => clean(a.textContent)).filter(Boolean).join(' > '), 120),
      bullets: $$(S.bullets.join(',')).map((e) => clip(e.textContent, 160)).filter(Boolean).slice(0, 8),
      specs: specs(),
      image: pickAttr(S.image, 'data-old-hires') || pickAttr(S.image, 'src'),
    };
    // Say what is missing rather than letting the caller assume absence means "not applicable".
    const want = ['title', 'price', 'rating', 'availability', 'soldBy'];
    const missing = want.filter((k) => {
      const v = rec[k];
      return !v || (typeof v === 'object' && !Object.keys(v).length);
    });
    const out = compact(rec) || {};
    if (missing.length) out._missing = missing;
    return out;
  }

  /* ---------------------------------------------------------------- search */

  function isSponsored(el) {
    if (SEL.search.sponsored.some((s) => $(s, el))) return true;
    // Belt and braces: the word can appear as a bare label node with no stable class.
    const lbl = $('.puis-label-popover, .a-color-secondary', el);
    return /^\s*Sponsored\b/i.test(clean(lbl ? lbl.textContent : null) || '');
  }

  function searchResults(opts) {
    opts = opts || {};
    const limit = opts.limit == null ? 24 : opts.limit;
    const S = SEL.search;
    const nodes = $$(S.results[0]).length ? $$(S.results[0]) : $$(S.results.join(','));
    let sponsored = 0;
    let pos = 0;
    const out = [];
    for (const el of nodes) {
      const asin = el.getAttribute('data-asin');
      if (!asin || asin.length !== 10) continue;
      if (isSponsored(el)) { sponsored++; continue; }
      pos++;
      if (out.length >= limit) continue;
      const priceRaw = pickText(S.price, el);
      const ratingAlt = pickText(S.rating, el);
      const starsM = ratingAlt ? ratingAlt.match(/([\d.]+)/) : null;
      // Amazon stamps the signed-in user's own history into the badge slot as
      // "Purchased Aug 2025". Split it out: it answers "do I already own this?" for free,
      // and it is personal data, so it must be legible to whatever stores the capture.
      const badgeTxt = clip(pickText(S.badge, el), 40);
      const ownedM = badgeTxt ? badgeTxt.match(/^Purchased\s+(.+)$/i) : null;
      out.push(compact({
        pos,
        asin,
        title: clip(pickText(S.title, el), 140),
        price: money(priceRaw),
        was: money(pickText(S.wasPrice, el)),
        stars: starsM ? parseFloat(starsM[1]) : null,
        ratings: num(pickText(S.ratingCount, el)),
        prime: pick(S.prime, el) ? true : null,
        badge: ownedM ? null : badgeTxt,
        ownedSince: ownedM ? ownedM[1] : null,
        url: dpUrl(asin),
      }));
    }
    const qs = new URLSearchParams(location.search);
    return {
      query: qs.get('k'),
      sortedBy: qs.get('s') || 'relevance',
      shown: out.length,
      organicTotal: pos,
      sponsoredRemoved: sponsored,
      resultCountText: clip(pickText(S.resultCount), 80),
      results: out,
    };
  }

  /* -------------------------------------------------------------- buyagain */
  //
  // The page a recurring order actually starts from, and until v0.5.0 it had no extractor at
  // all — `page()` returned type "unknown", so the caller's only option was to hand-roll a
  // scraper against a hashed class name and hope. See SEL.buyagain for why the anchor is what
  // it is; the short version is that `[data-asin]` over-matches by ~16x on this page.

  function buyAgain(opts) {
    opts = opts || {};
    const S = SEL.buyagain;
    const limit = opts.limit == null ? 40 : opts.limit;
    const rows = $$(S.row[0]).length ? $$(S.row[0]) : $$(S.row.join(','));
    if (!rows.length) {
      return { _needs: 'navigate to https://www.amazon.com/gp/buyagain — no Buy Again cards on '
        + 'this page. If you ARE on that URL, the anchor selector has rotted: run __amzx.health()' };
    }
    let wasDropped = 0;
    const out = [];
    for (const r of rows) {
      if (out.length >= limit) break;
      const asin = r.getAttribute('data-asin');
      if (!asin || asin.length !== 10) continue;
      // The card is the summary node's grid cell when there is one; fall back to the node
      // itself so a layout change degrades to a thinner record rather than to nothing.
      const cell = (r.closest && r.closest('[class*="_gridCell_"]')) || r;
      const offerRow = pick(S.offerRow, cell);
      const price = money(pickText(S.bPrice, offerRow || cell));

      // `was` MUST exceed `price`. CLAUDE.md records that this invariant is cheap and was never
      // checked, and it bit again here: a bare [data-a-strike="true"] over the whole card
      // reported was === price on 8 of 13 rows on 2026-08-27, because strike markup outside the
      // offer row re-renders the CURRENT price. Scoping to the offer row and excluding the
      // Subscribe & Save pills left 5 rows and zero violations. The check stays in anyway —
      // a selector that silently starts matching the wrong node is exactly what this catches,
      // and reporting a `was` below the price is worse than reporting none.
      let was = null;
      if (offerRow) {
        for (const s of $$('[data-a-strike="true"]', offerRow)) {
          if (s.closest && s.closest('[class*="_offerPill_"]')) continue;
          const v = money(txtOf($('.a-offscreen', s)) || txtOf(s));
          if (v != null) { was = v; break; }
        }
      }
      if (was != null && price != null && was <= price) { was = null; wasDropped++; }

      // Alternative purchase modes, as Amazon renders them: "One-time purchase $10.00" /
      // "Subscribe & Save $9.50". Reported as a list because the cheaper one is frequently
      // NOT the price on the card, which is the same shape of finding as offers() on a product.
      const offers = [];
      for (const p of $$(S.bPill.join(','), cell)) {
        const t = clean(p.innerText || p.textContent);
        if (!t) continue;
        const cut = t.indexOf('$');
        offers.push(compact({
          mode: clip(cut > 0 ? t.slice(0, cut) : null, 30),
          price: money(cut >= 0 ? t.slice(cut) : t),
        }));
      }

      out.push(compact({
        asin,
        title: clip(pickText(S.bTitle, cell), 140),
        price,
        was,
        // "($9.90/fluid ounce)" rides along in the offer row's text. Taken from the text rather
        // than a selector because the parenthesised form is the stable part, not its container.
        unit: (() => { const m = (txtOf(offerRow) || '').match(/\(([^)]*\/[^)]*)\)/); return m ? clip(m[1], 40) : null; })(),
        offers: offers.length ? offers : null,
        // Same parser as the product-page coupon: the percentage is worthless without the
        // condition attached to it, and Buy Again promos are almost all conditional.
        promo: couponInfo(pickText(S.bPromo, cell)),
        url: dpUrl(asin),
      }));
    }

    const res = {
      shown: out.length,
      // Amazon paginates this page behind a "Load more" button. The library does not click
      // anything (see the header), so say how many are visible and let the caller decide.
      hasMore: !!$$('button,a,span').filter((b) => /^load more$/i.test(clean(b.innerText) || ''))[0] || undefined,
      items: out,
    };
    if (wasDropped) {
      res._warn = wasDropped + ' row(s) reported a list price at or below their own price, so it '
        + 'was dropped. That is the unit-price family of bug — if this count is high, the `was` '
        + 'selector in SEL.buyagain has rotted.';
    }
    return compact(res) || {};
  }

  /* --------------------------------------------------------------- reviews */

  function reviewsOn(doc, opts) {
    doc = doc || document;
    opts = opts || {};
    const S = SEL.reviews;
    const limit = opts.limit == null ? 8 : opts.limit;
    const allCards = $$(S.card.join(','), doc);
    const cards = allCards.slice(0, limit);
    const dist = {};
    const pcts = $$(S.histPct.join(','), doc)
      .map((e) => txtOf(e))
      .filter((x) => /^\d{1,3}%$/.test(x || ''))
      .slice(0, 5);
    pcts.forEach((p, i) => { dist[(5 - i) + 'star'] = p; });
    const sample = cards.map((c) => {
        const sm = (pickText(S.rStars, c) || '').match(/([\d.]+)/);
        const dt = pickText(S.rDate, c);
        return compact({
          stars: sm ? parseFloat(sm[1]) : null,
          title: clip(pickText(S.rTitle, c), 100),
          date: clip(dt ? dt.replace(/^Reviewed in\s+/i, '') : null, 60),
          verified: pick(S.rVerified, c) ? true : null,
          helpful: num(pickText(S.rHelpful, c)),
          body: clip(pickText(S.rBody, c), 300),
        });
    });

    // THE REVIEW ENDPOINT IS CAPPED AND ITS PARAMETERS ARE INERT.
    //
    // Verified 2026-08-21 on B0BV9YJ7LS: `filterByStar=one_star` returned eight reviews rated
    // 5,5,5,5,4,5,5,5 — not one 1-star among them. Same eight for two_star, three_star,
    // critical, sortBy=helpful, sortBy=recent and pageNumber=2. No pagination control, no
    // "see more" link. This is not specific to one listing: B0BGKYF5VZ served 224 reviews
    // under its 1-star filter on 18 Aug and eight on 20 Aug. Something changed site-wide.
    //
    // So the sample is 8 of however many exist and cannot be steered. What IS still real is
    // the histogram — report the gap in the return value rather than in a footnote, because a
    // reader handed eight glowing reviews will otherwise treat them as the verdict.
    const shown = allCards.length;
    const total = num(pickText(S.ratingsTotal, doc));
    const paginated = !!$('.a-pagination, [data-hook="pagination-bar"]', doc);
    const capped = shown > 0 && !paginated && total != null && total > shown;

    const qs = new URLSearchParams(location.search);
    const ignored = [];
    const wanted = { one_star: [1, 1], two_star: [2, 2], three_star: [3, 3], four_star: [4, 4],
                     five_star: [5, 5], critical: [1, 3], positive: [4, 5] }[qs.get('filterByStar')];
    const rated = sample.map((r) => r.stars).filter((s) => s != null);
    if (wanted && rated.length && !rated.some((s) => s >= wanted[0] && s <= wanted[1])) {
      ignored.push('filterByStar=' + qs.get('filterByStar'));
    }
    if (+qs.get('pageNumber') > 1 && !paginated) ignored.push('pageNumber=' + qs.get('pageNumber'));
    if (ignored.length && qs.get('sortBy')) ignored.push('sortBy=' + qs.get('sortBy') + ' (assumed)');

    const out = compact({
      distribution: dist,
      sampling: compact({
        n: shown,
        ratingsTotal: total,
        coverage: (total && shown) ? (Math.round((shown / total) * 1000) / 10) + '%' : null,
        ceiling: capped || undefined,
        complete: capped ? false : undefined,
      }),
      sample: sample,
    }) || {};

    if (ignored.length) {
      out._warn = 'Amazon IGNORED these parameters: ' + ignored.join(', ')
        + '. The returned reviews do not match what was asked for — do not describe them as filtered or sorted.';
    } else if (capped) {
      out._warn = 'Only ' + shown + ' of ' + total + ' reviews are reachable and there is no way to page further. '
        + 'This sample is not representative. The star distribution is the only trustworthy figure here.';
    }
    return out;
  }

  /* ----------------------------------------------------------------- offers */
  //
  // These used to fetch sub-pages. That is dead — verified 2026-08-20:
  //
  //   * Every all-offers-display AJAX endpoint returns 404 (three URL shapes tried).
  //   * /dp/<ASIN>?aod=1 fetched over XHR returns the page WITHOUT the offers panel; it is
  //     rendered client-side.
  //   * /product-reviews/<ASIN>/?filterByStar=critical returns the same 4-5 star reviews as
  //     the product page, over both fetch AND real navigation. Amazon ignores the filter.
  //
  // So there is no fetch path. The caller navigates, and these read the live DOM — which is
  // fine, because the caller drives the browser anyway. Read `_needs` on the result: it says
  // where to navigate to make the data appear, instead of silently returning nothing.

  // All sellers for the product. Requires the caller to be on /dp/<ASIN>?aod=1 — the buy box
  // shows one seller and the cheapest is frequently not it.
  function offers() {
    const S = SEL.offers;
    const rows = $$(S.row.join(','));
    if (!rows.length) {
      return { _needs: 'navigate to https://www.amazon.com/dp/' + (asinFrom(location.href) || '<ASIN>') +
        '?aod=1 — the all-sellers panel renders client-side and is not on the plain product page' };
    }
    // The heading slot holds a condition on most listings and the Subscribe & Save purchase mode
    // on others, so route it through both validators rather than trusting whatever is in there.
    // When it is neither, keep the raw text under `_heading` instead of dropping it: an
    // unrecognised value is the signal that Amazon has put a third thing in that slot, and
    // silently discarding it is precisely how this went unnoticed the first time.
    return compact(rows.slice(0, 10).map((r) => {
      const heading = pickText(S.oCondition, r);
      const cond = condition(heading);
      const mode = purchaseMode(heading);
      return compact({
        price: money(pickText(S.oPrice, r)),
        seller: clip(pickText(S.oSeller, r), 50),
        shipsFrom: clip(pickText(S.oShip, r), 50),
        condition: clip(cond, 40),
        purchaseMode: clip(mode, 40),
        _heading: (heading && !cond && !mode) ? clip(heading, 40) : null,
      });
    }));
  }

  /* -------------------------------------------------------------- variants */
  //
  // WHY THIS EXISTS. With the review sample capped at 8 and unsteerable, reading reviews is
  // finished as an audit technique. What replaces it is the variant map: Amazon pools ONE star
  // rating across every SKU in a listing, so a 574-rating average can be spread over 45 rings
  // — or belong overwhelmingly to a colourway that is not the one being bought. A rating earned
  // by one product and a rating pooled across ninety are different numbers wearing the same
  // badge, and nothing on the rendered page tells you which you are looking at.
  //
  // It is all sitting in the twister payload. Verified 2026-08-21 on B0BV9YJ7LS:
  // dimensions ["color_name","ring_size"], 5 colours x 9 sizes, 45 entries in
  // dimensionToAsinMap, all draining into one average.
  //
  // Map keys are underscore-joined value INDICES, positionally matching `dimensions` —
  // "0_1" is dimensions[0]'s value 0 and dimensions[1]'s value 1. The decode is validated for
  // free: the current page's own ASIN must appear in the map, and `selected` is how it is
  // found. If `selected` comes back null on a variation page, the index convention has moved
  // and everything below it is suspect.

  function twisterData() {
    for (const s of $$('script')) {
      const t = s.textContent || '';
      if (!t.includes('dimensionToAsinMap')) continue;
      const one = (re) => { const m = t.match(re); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; } };
      const dims = one(/"dimensions"\s*:\s*(\[[\s\S]*?\])/);
      const values = one(/"variationValues"\s*:\s*(\{[\s\S]*?\})\s*,\s*"/);
      const map = one(/"dimensionToAsinMap"\s*:\s*(\{[\s\S]*?\})\s*,\s*"/);
      if (dims && values && map) return { dims, values, map };
    }
    return null;
  }

  function variants(opts) {
    opts = opts || {};
    const d = twisterData();
    if (!d) return null;                       // not a variation listing
    const dims = d.dims, values = d.values, map = d.map;
    const here = asinFrom(location.href);

    const decode = (key) => {
      const idx = key.split('_').map(Number);
      const combo = {};
      dims.forEach((dim, i) => {
        const list = values[dim] || [];
        combo[dim] = list[idx[i]] == null ? null : list[idx[i]];
      });
      return combo;
    };

    const entries = Object.entries(map);
    const available = entries.map((e) => Object.assign(decode(e[0]), { asin: e[1] }));
    const selected = available.find((c) => c.asin === here) || null;

    const axisSizes = dims.map((dim) => (values[dim] || []).length || 1);
    const totalCombos = axisSizes.reduce((a, b) => a * b, 1);

    // Combinations the listing advertises but does not stock — the case where a dropdown
    // offers "natural peridot" and no peridot exists in the size being bought.
    const unavailable = [];
    if (entries.length < totalCombos && totalCombos <= 4000) {
      const walk = (pos, acc) => {
        if (unavailable.length >= 20) return;
        if (pos === dims.length) { if (!map[acc.join('_')]) unavailable.push(decode(acc.join('_'))); return; }
        for (let i = 0; i < axisSizes[pos]; i++) walk(pos + 1, acc.concat(i));
      };
      walk(0, []);
    }

    const axes = {};
    for (const dim of dims) axes[dim] = values[dim] || [];

    const out = compact({
      axes,
      skuCount: entries.length,
      possibleCombos: totalCombos !== entries.length ? totalCombos : undefined,
      selected,
      unavailable: unavailable.length ? unavailable : undefined,
      unavailableTruncated: unavailable.length >= 20 ? true : undefined,
      // The raw list is big and rarely what you want; ask for it explicitly.
      available: opts.full ? available : undefined,
    }) || {};

    // WHY THIS IS HEDGED NOW. Through v0.4.1 this asserted flatly that the rating "is not a
    // rating for this variant alone", and it fired on every listing with more than one SKU
    // regardless of evidence. That is overstated. Verified 2026-08-27: a 7-SKU listing served
    // 4.3 / 662 ratings on one child and 4.4 / 531 on a sibling — different stars AND different
    // counts, so Amazon was splitting that pool rather than stamping one number across seven
    // SKUs. A warning that is always on and sometimes wrong is one the reader learns to skip,
    // and that costs us the listings where the pooling is total and the number really is a lie.
    //
    // There is deliberately NO confidence score. Nothing on this page separates a pooled rating
    // from a split one — the discriminator is a sibling's own rating.count, one navigation away.
    // So state the mechanism, state the doubt, and hand over the exact URL that settles it,
    // rather than inventing a number to stand in for the uncertainty.
    if (entries.length > 1) {
      const sibling = (available.find((c) => c.asin && c.asin !== here) || {}).asin;
      out._dilution = 'Amazon pools one star rating across a listing, and this listing has '
        + entries.length + ' SKUs (' + dims.map((dim, i) => axisSizes[i] + ' ' + dim).join(' x ')
        + '). The rating shown may therefore have been earned mostly by a variant other than '
        + 'this one. Some listings do serve per-SKU ratings, so treat this as a risk to check '
        + 'rather than as an established fact.';
      if (sibling) {
        out._dilutionCheck = 'Compare rating.count here against ' + dpUrl(sibling)
          + ' — the same count on both means one pooled rating; different counts mean Amazon is '
          + 'splitting it, and the number on this page belongs to this variant.';
      }
    }
    if (!selected && here) {
      out._warn = 'This page\'s ASIN (' + here + ') is not in dimensionToAsinMap. The key/index '
        + 'convention may have changed — treat the decoded combinations below as unverified.';
    }
    return out;
  }

  /* ------------------------------------------------------------------ full */

  async function full(opts) {
    opts = opts || {};
    const meta = page();
    if (meta.blocked) {
      return Object.assign({}, meta, {
        error: 'page is behind a ' + meta.blocked + ' wall — a human needs to clear it in this browser',
      });
    }
    const out = Object.assign({}, meta, { _v: VERSION });
    try {
      if (meta.type === 'product') {
        out.product = product();
        // The all-sellers panel exists only when the caller navigated with ?aod=1. Include it
        // when it is genuinely on the page; otherwise pass along where to go to get it.
        const o = offers();
        if (o && !o._needs) out.offers = o;
        else if (o && o._needs) out.offersHint = o._needs;
        // Always on product pages: a pooled rating is the single most misleading number on the
        // page, and it costs nothing to say so when it applies.
        const v = variants();
        if (v) out.variants = v;
      } else if (meta.type === 'search') {
        out.search = searchResults(opts);
      } else if (meta.type === 'buyagain') {
        out.buyAgain = buyAgain(opts);
      } else if (meta.type === 'reviews') {
        out.reviews = reviewsOn(document, opts);
      } else {
        out.note = 'no extractor for page type "' + meta.type + '"; use __amzx.text() for a rough read';
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  }

  /* ---------------------------------------------------------------- health */

  // Which selectors still resolve on THIS page. Run it when a capture looks thin —
  // it distinguishes "Amazon changed the DOM" from "this product genuinely has no coupon".
  function health() {
    const t = pageType();
    const groups = t === 'product' ? { product: SEL.product }
      : t === 'search' ? { search: SEL.search }
      : t === 'reviews' ? { reviews: SEL.reviews }
      : t === 'buyagain' ? { buyagain: SEL.buyagain }
      : { product: SEL.product, search: SEL.search };
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
    report.summary = report.ok.length + ' ok, ' + report.absent.length
      + ' absent-but-optional, ' + report.broken.length + ' BROKEN';
    return report;
  }

  // Escape hatch: rough visible text, for page types with no extractor yet.
  function text(max) {
    const el = document.querySelector('#dp-container, #search, #centerCol, main, body');
    return clip(el ? el.innerText : null, max == null ? 4000 : max);
  }

  /* ---------------------------------------------------------------- expose */

  const API = {
    version: VERSION,
    page: page,
    product: product,
    search: searchResults,
    reviews: reviewsOn,
    buyAgain: buyAgain,
    offers: offers,
    variants: variants,
    full: full,
    health: health,
    text: text,
    SEL: SEL,
    // Exposed for tests/parse.test.js, which runs this file under node with a stub window.
    // Not part of the caller-facing surface — do not build on it.
    _internals: { clean, clip, money, num, currency, compact, asinFrom, txtOf, unitPrice,
                  couponInfo, condition, purchaseMode },
  };
  Object.defineProperty(window, '__amzx', { value: API, writable: true, configurable: true });
  }

  /* --------------------------------------------------------------- publish */
  //
  // Inject the library as a <script> tag rather than just calling it.
  //
  // Whether a userscript's `window` IS the page's `window` depends on how the extension
  // injected it, which depends on browser settings the script cannot see. Under Manifest V3 a
  // manager may run even a `@grant none` script in an isolated world — and then everything
  // above executes perfectly, defines __amzx on a `window` nobody else can reach, and reports
  // no error at all. That is the exact failure this library is built to prevent, so it should
  // not ship with that failure in its own loader.
  //
  // The DOM is shared across worlds, so a <script> element always evaluates in the page's main
  // world. This is correct in both cases: injected from the main world it is a no-op detour,
  // injected from a sandbox it is the only way across. Verified on amazon.com 2026-08-20 —
  // inline script execution is not CSP-blocked there.
  try {
    const el = document.createElement('script');
    el.textContent = '(' + __amzxLib.toString() + ')();';
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  } catch (e) {
    // Strict CSP, or no DOM at all (the node test harness). Define it here and let the
    // caller find out from health() whether it can actually see the page.
    try { __amzxLib(); } catch (_) { /* nothing left to try */ }
  }
})();
