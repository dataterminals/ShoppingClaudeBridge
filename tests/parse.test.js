/**
 * Parser tests for amazon-claude-bridge.user.js — zero dependencies, plain node.
 *
 *     node tests/parse.test.js
 *
 * These cover the pure string/number parsers, not the selectors. Selectors can only be
 * checked against the live site (see docs/API.md — `__amzx.health()`); everything here is
 * DOM-free and therefore worth pinning, because every case below is a real defect that was
 * caught by running the extractor against amazon.com on 2026-08-20 rather than by reading it.
 *
 * The userscript is an IIFE that publishes onto `window`, so we stub a bare window, eval the
 * file, and reach in through the documented `_internals` handle.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'amazon-claude-bridge.user.js');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

const amzx = sandbox.window.__amzx;
if (!amzx) {
  console.error('FAIL: the script did not publish window.__amzx at all.');
  process.exit(1);
}
const { clean, clip, money, num, currency, compact, asinFrom, txtOf, unitPrice,
        couponInfo, condition, purchaseMode } = amzx._internals;

let passed = 0;
const failures = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

/* ---------------------------------------------------------------- num() ---
 * The one that mattered. Search results render review counts abbreviated, so a
 * strip-the-non-digits reading of "(22.2K)" yields 222 — wrong by ~100x, and wrong
 * *silently*, which is the dangerous part. Live values, captured 2026-08-20.
 */
eq('num abbreviated thousands', num('(22.2K)'), 22200);
eq('num abbreviated, big', num('(147.1K)'), 147100);
eq('num abbreviated millions', num('1.4M'), 1400000);
eq('num lowercase suffix', num('22.2k'), 22200);
eq('num comma-grouped (product page form)', num('(147,109)'), 147109);
eq('num with trailing words', num('1,234 ratings'), 1234);
eq('num plain', num('12 people found this helpful'), 12);
eq('num no digits', num('One person found this helpful'), null);
eq('num empty', num(''), null);
eq('num null', num(null), null);

/* -------------------------------------------------------------- money() --- */
eq('money simple', money('$9.99'), 9.99);
eq('money grouped', money('$1,234.56'), 1234.56);
eq('money with prefix', money('US$12.34'), 12.34);
eq('money decimal comma', money('12,34 EUR'), 12.34);
eq('money grouped decimal comma', money('1.234,56'), 1234.56);
eq('money no number', money('Currently unavailable'), null);
eq('money null', money(null), null);
// Doubled renders, seen live in the all-sellers panel. Stripping separators across the whole
// string turned "$18.29$18.29" into 18.2918 — wrong, but plausible enough to go unnoticed.
eq('money doubled render', money('$9.99$9.99'), 9.99);
eq('money doubled render, larger', money('$18.29$18.29'), 18.29);
eq('money doubled with thousands', money('$1,234.56$1,234.56'), 1234.56);
eq('money space separated repeat', money('$9.89 $9.89'), 9.89);
eq('money leading label', money('Price: $7.50'), 7.5);

/* ----------------------------------------------------------- currency() --- */
eq('currency usd', currency('$9.99'), 'USD');
eq('currency gbp', currency('£9.99'), 'GBP');
eq('currency eur', currency('9,99€'), 'EUR');
eq('currency unknown', currency('9.99'), null);

/* --------------------------------------------------------- unitPrice() ---
 * "($0.83$0.83 / feet)" — the offscreen span and the visible span both land in
 * textContent, so the figure arrives doubled. Verified live on B07DC5PPFV.
 */
eq('unit price de-duplicated', unitPrice('($0.83$0.83 / feet)'), '$0.83 / feet');
eq('unit price already clean', unitPrice('($0.83 / feet)'), '$0.83 / feet');
eq('unit price count units', unitPrice('($4.50$4.50 / Count)'), '$4.50 / Count');
eq('unit price empty', unitPrice(''), null);
eq('unit price null', unitPrice(null), null);

/* ------------------------------------------------------------- clean() --- */
eq('clean collapses whitespace', clean('  a\n\t  b  '), 'a b');
eq('clean strips zero-width', clean('An​ker­'), 'Anker');
eq('clean empty becomes null', clean('   '), null);
eq('clean null', clean(null), null);

/* -------------------------------------------------------------- clip() --- */
eq('clip truncates with ellipsis', clip('abcdefghij', 5), 'abcd…');
eq('clip leaves short strings', clip('abc', 5), 'abc');

/* ----------------------------------------------------------- asinFrom() --- */
eq('asin from /dp/ with query', asinFrom('https://www.amazon.com/dp/B07DC5PPFV?th=1'), 'B07DC5PPFV');
eq('asin from /gp/product/', asinFrom('/gp/product/B07SMNZK8H'), 'B07SMNZK8H');
eq('asin from /product-reviews/', asinFrom('/product-reviews/B0H5RJBPFR/?sortBy=recent'), 'B0H5RJBPFR');
eq('asin from long slug url', asinFrom('https://www.amazon.com/Anker-USB-Cable/dp/B07DC5PPFV/ref=sr_1_3'), 'B07DC5PPFV');
eq('asin absent on search page', asinFrom('https://www.amazon.com/s?k=usb+c+cable'), null);
eq('asin null input', asinFrom(null), null);

/* ----------------------------------------------------------- compact() ---
 * Compactness is the whole reason this library exists, so prove the pruning is recursive.
 */
eq('compact drops nulls', compact({ a: 1, b: null }), { a: 1 });
eq('compact drops empty objects', compact({ a: 1, b: {} }), { a: 1 });
eq('compact drops empty arrays', compact({ a: 1, b: [] }), { a: 1 });
eq('compact prunes recursively', compact({ a: { b: { c: null } }, d: 2 }), { d: 2 });
eq('compact keeps false', compact({ a: false }), { a: false });
eq('compact keeps zero', compact({ a: 0 }), { a: 0 });
eq('compact filters array holes', compact([1, null, 2]), [1, 2]);
eq('compact all-empty becomes null', compact({ a: null, b: [] }), null);

/* -------------------------------------------------------------- txtOf() ---
 * #acBadge_feature_div contains a <style> block on products with no badge, so raw
 * textContent returns CSS — which reads as a present value and fabricates a badge.
 */
const withStyle = {
  textContent: 'REAL .mvt-ac-badge-rectangle { border-radius:4px }',
  querySelector: () => ({}),
  cloneNode: () => ({ textContent: 'REAL', querySelectorAll: () => [] }),
};
eq('txtOf strips style payloads', txtOf(withStyle), 'REAL');

const plain = { textContent: '  Anker  ', querySelector: () => null };
eq('txtOf passes plain nodes through', txtOf(plain), 'Anker');
eq('txtOf null element', txtOf(null), null);

/* --------------------------------------------------------- couponInfo() ---
 * The live string, captured 2026-08-27 on a grocery listing. It is 78 characters, so the old
 * clip(…, 80) was NOT truncating it — the failure was never length. The failure is that the
 * discount and the condition attached to it arrive as one run of prose, and a reader (or a
 * comparison table) takes "30% off" as the price and drops "only if you start a subscription".
 */
const SNS = '30% off coupon applied. First Subscribe & Save orders only. Shop items | Terms';
eq('coupon pct', couponInfo(SNS).pct, 30);
eq('coupon is conditional', couponInfo(SNS).conditional, true);
eq('coupon names the condition', couponInfo(SNS).requires, 'first-subscribe-and-save-order');
eq('coupon already applied', couponInfo(SNS).applied, true);
eq('coupon keeps the original text', couponInfo(SNS).text, SNS);
eq('coupon reports no dollar amount when it is a percentage', couponInfo(SNS).amount, undefined);

eq('coupon plain percentage is unconditional',
   couponInfo('Save 5%'), { pct: 5, text: 'Save 5%' });
eq('coupon dollar amount', couponInfo('Apply $5.00 coupon').amount, 5);
eq('coupon not-yet-applied has no applied flag', couponInfo('Apply $5.00 coupon').applied, undefined);
// A cap is not a saving. "up to $20" must never be reported as the discount — same shape of
// error as reading a unit price as the price.
eq('coupon ignores a dollar cap when a percentage is present',
   couponInfo('Save 10% when you buy 2, up to $20'),
   { pct: 10, conditional: true, requires: 'multi-buy', text: 'Save 10% when you buy 2, up to $20' });
eq('coupon multi-buy detected', couponInfo('Save 15% when you purchase 3').requires, 'multi-buy');
eq('coupon plain subscribe & save', couponInfo('Save 5% with Subscribe & Save').requires,
   'subscribe-and-save');
eq('coupon empty', couponInfo(''), null);
eq('coupon null', couponInfo(null), null);

/* ---------------------------------------------------------- condition() ---
 * #aod-offer-heading is a heading slot, not a condition field. On a Subscribe & Save listing it
 * served "One-time purchase" straight into `condition` (2026-08-27) — which is not a condition,
 * reads exactly like one, and nothing flagged it.
 */
eq('condition new', condition('New'), 'New');
eq('condition used grade', condition('Used - Very Good'), 'Used - Very Good');
// Amazon Resale is a real seller and its offers carry this. An over-tight /^(new|used)/ would
// have silently dropped a genuine offer, which is the expensive direction.
eq('condition resale grade', condition('Resale - Like New'), 'Resale - Like New');
eq('condition renewed', condition('Renewed'), 'Renewed');
eq('condition open box', condition('Open Box - Like New'), 'Open Box - Like New');
eq('condition REJECTS the purchase-mode toggle', condition('One-time purchase'), null);
eq('condition REJECTS subscribe & save', condition('Subscribe & Save'), null);
eq('condition rejects arbitrary prose', condition('Other Sellers on Amazon'), null);
eq('condition empty', condition(''), null);

eq('purchaseMode one-time', purchaseMode('One-time purchase'), 'One-time purchase');
eq('purchaseMode hyphenless', purchaseMode('One time purchase'), 'One time purchase');
eq('purchaseMode subscribe', purchaseMode('Subscribe & Save'), 'Subscribe & Save');
eq('purchaseMode REJECTS a real condition', purchaseMode('New'), null);
// The two validators must not both claim the same string, or the caller sees one value twice.
for (const s of ['New', 'Used - Good', 'Resale - Like New', 'One-time purchase', 'Subscribe & Save']) {
  eq(`"${s}" is claimed by exactly one validator`,
     [condition(s), purchaseMode(s)].filter(Boolean).length, 1);
}

/* ------------------------------------------------- buyagain promo text ---
 * Live promo strings from /gp/buyagain, 2026-08-27. All 18 promos on that page parsed to a
 * percentage; these are the four distinct shapes. "reorder" is the one that caught an earlier
 * `when you (buy|purchase|order)` out — "reorder" does not start at the `o`.
 */
eq('promo brand, unconditional',
   couponInfo('Save 10% with brand promotion'), { pct: 10, text: 'Save 10% with brand promotion' });
eq('promo reorder N qualifying items is multi-buy',
   couponInfo('Save 10% when you reorder 5 qualifying items').requires, 'multi-buy');
eq('promo subscribe & save', couponInfo('Coupon: Save 5% with Subscribe & Save').requires,
   'subscribe-and-save');
eq('promo select-option', couponInfo('Coupon available when you select this option').requires,
   'select-option');
// Every live promo on that page yielded a number. A promo that parses to no number at all is the
// signal that the copy has changed shape, so pin the one that would regress first.
eq('promo always yields a percentage when one is present',
   couponInfo('Save 10%  when you reorder 5 qualifying items with brand promotion').pct, 10);

/* ------------------------------------------------------- surface check --- */
for (const fn of ['page', 'product', 'search', 'reviews', 'offers', 'buyAgain',
                  'full', 'health', 'text']) {
  eq(`API exposes ${fn}()`, typeof amzx[fn], 'function');
}
eq('API reports a version', typeof amzx.version, 'string');
eq('SEL registry is published for maintenance', typeof amzx.SEL.product.title, 'object');
eq('SEL carries a buyagain group', Array.isArray(amzx.SEL.buyagain.row), true);
// The anchor must stay specific. `[data-asin]` alone over-matched 392-to-24 on the live page, so
// a change that relaxes the primary selector to a bare attribute is a regression, not a cleanup.
eq('buyagain anchors on the un-hashed summary class, not a bare [data-asin]',
   /almGridDesktopAsinInfoSummary/.test(amzx.SEL.buyagain.row[0]), true);
// The fallback is the one that could reach the cart sidebar; it must carry the guard.
eq('buyagain fallback excludes the cart sidebar',
   /ewc/.test(amzx.SEL.buyagain.row[1]), true);

/* --------------------------------------------------------------- report --- */
if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`All ${passed} parser tests passed.`);
