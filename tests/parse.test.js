/**
 * Parser tests for amazon-claude-bridge.user.js — zero dependencies, plain node.
 *
 *     node tests/parse.test.js
 *
 * These cover the pure string/number parsers, not the selectors. Selectors can only be
 * checked against the live site (see docs/AMAZON-API.md — `__amzx.health()`); everything here is
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
        couponInfo, condition, purchaseMode, chartFromGrid, chartDiff, cellVal,
        fullImage, specKey, specCollector, SPEC_CAP } = amzx._internals;

// The extractor's own text, for the two assertions below that pin a defect rather than a value.
const SRC_TEXT = fs.readFileSync(SRC, 'utf8');

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

/* ------------------------------------------------------- chartFromGrid() ---
 * Two live grids from 2026-09-03. The first is Amazon's size-chart widget on a full-length
 * legging listing — sizes DOWN the first column — and its label reads "US CAPRI LEGGINGS": the
 * inseam row (19.7-21.3") belongs to a different garment than the one on the page, whose A+
 * image reads 27.2-27.6". The parser's job is to keep that row legible so the disagreement is
 * visible, not to decide which chart is right.
 */
const WIDGET = [
  ['Brand Size', 'US Size', 'Waist (in)', 'Hip (in)', 'Inseam (in)'],
  ['XS', '0-2', '24 - 26', '34 - 36', '19.7'],
  ['S', '4-6', '26 - 28', '36 - 38', '19.7'],
  ['M', '8-10', '28 - 30', '38 - 40', '19.7'],
  ['L', '12-14', '30 - 32', '40 - 42.5', '20.1'],
  ['XL', '16-18', '32 - 34', '42.5 - 45', '20.5'],
  ['XXL', '20-22', '35 - 37', '45 - 48', '21.3'],
];
const widget = chartFromGrid(WIDGET);
eq('widget grid: sizes read down the first column', widget.sizes, ['XS', 'S', 'M', 'L', 'XL', 'XXL']);
eq('widget grid: inseam row aligned to sizes', widget.measures['Inseam (in)'], [19.7, 19.7, 19.7, 20.1, 20.5, 21.3]);
eq('widget grid: ranges stay strings', widget.measures['Waist (in)'][3], '30 - 32');
eq('widget grid: US size row kept', widget.measures['US Size'][0], '0-2');

// Seller-written tables usually run sizes ACROSS the header instead.
const ACROSS = [['Size', 'S', 'M', 'L'], ['Waist', '26-28', '28-30', '30-32'], ['Inseam', '28', '28', '28']];
eq('across grid: sizes from the header', chartFromGrid(ACROSS).sizes, ['S', 'M', 'L']);
eq('across grid: inseam row', chartFromGrid(ACROSS).measures.Inseam, [28, 28, 28]);

// Key/value spec tables and comparison tables are not size charts and must not be reported as one.
eq('spec table is not a chart', chartFromGrid([['Color', 'Black'], ['Fit Type', 'Regular']]), null);
eq('empty grid', chartFromGrid([]), null);
eq('single row', chartFromGrid([['Size', 'S', 'M']]), null);
eq('sizes without a measurement row', chartFromGrid([['Size', 'S', 'M'], ['Colour', 'Black', 'Black']]), null);

/* ---------------------------------------------------------- chartDiff() ---
 * Two of the three widget charts on a three-fit listing (25" and 28" inseam). The first in DOM
 * order was the 25" one — on the 28" variant's own page.
 */
const FIT25 = chartFromGrid([
  ['Brand Size', 'Waist (in)', 'Hip (in)', 'Inseam (in)', 'Length (in)'],
  ['S', '25.2 - 27.2', '36 - 38', '25.8', '35'],
  ['M', '27.2 - 29.2', '38.1 - 40.1', '26.2', '35.8'],
  ['L', '29.1 - 31.1', '40.1 - 42.1', '26.6', '36.6'],
]);
const FIT28 = chartFromGrid([
  ['Brand Size', 'Waist (in)', 'Hip (in)', 'Inseam (in)', 'Length (in)'],
  ['S', '25.2 - 27.2', '36 - 38', '28', '37.8'],
  ['M', '27.2 - 29.2', '38.1 - 40.1', '28.3', '38.6'],
  ['L', '29.1 - 31.1', '40.1 - 42.1', '28.7', '39.4'],
]);
const diffs = chartDiff(FIT25, FIT28);
eq('chartDiff finds the inseam disagreement', diffs.some((x) => /Inseam \(in\) at L: 26\.6 vs 28\.7/.test(x)), true);
eq('chartDiff does not flag identical waist rows', diffs.some((x) => /Waist/.test(x)), false);
eq('chartDiff caps at four', diffs.length <= 4, true);
eq('chartDiff on identical charts', chartDiff(FIT28, FIT28), []);
eq('chartDiff tolerates null', chartDiff(null, FIT28), []);
// A range cell against a range cell compares both ends. (Two size columns: a grid with one size
// token is not accepted as a chart, and should not be — a key/value table has one value column.)
eq('chartDiff compares ranges', chartDiff(
  chartFromGrid([['Size', 'S', 'M'], ['Waist', '26 - 28', '28 - 30']]),
  chartFromGrid([['Size', 'S', 'M'], ['Waist', '26 - 30', '28 - 30']])), ['Waist at S: 26-28 vs 26-30']);

/* ------------------------------------------------------------ cellVal() --- */
eq('cellVal lone figure', cellVal('19.7'), 19.7);
eq('cellVal range stays a string', cellVal('40 - 42.5'), '40 - 42.5');
eq('cellVal empty', cellVal(''), null);

/* ---------------------------------------------------------- fullImage() ---
 * A+ image URLs carry a crop suffix that trims the upload to the module's aspect ratio.
 */
eq('fullImage strips the crop suffix',
   fullImage('https://m.media-amazon.com/images/S/aplus-media-library-service-media/dd95d962-a2c9.__CR0,0,1464,600_PT0_SX1464_V1___.jpg'),
   'https://m.media-amazon.com/images/S/aplus-media-library-service-media/dd95d962-a2c9.jpg');
eq('fullImage leaves a plain url alone', fullImage('https://m.media-amazon.com/images/I/abc.jpg'),
   'https://m.media-amazon.com/images/I/abc.jpg');
eq('fullImage null', fullImage(null), null);


/* --------------------------------------------------------------- specs() ---
 * The 0.7.0 defect these pin, measured live on B094RJ41WY (a VIZIO D24f-J09) on 2026-09-04:
 * the page carried 74 unique spec rows, specs() returned 30 of them in DOM order, and NOTHING
 * said so — _missing absent, _warn absent, health() printing "0 BROKEN" because it only asked
 * whether specRows resolved. It resolved 74 times. "Video Encoding: H.264, H.265 (HEVC), or
 * VP9" sat at row 39 and was thrown away, which is the row that decides whether the panel can
 * play the file you have.
 *
 * The DOM walk needs a browser and is verified live (rule 5). The accounting does not, and the
 * accounting is what turns a silent cap into a loud one, so it is pinned here.
 */

/* specKey() — shared core, so the same cases run in tests/ebay-parse.test.js. */
eq('specKey plain', specKey('Screen Size'), 'Screen Size');
eq('specKey trailing colon', specKey('Screen Size:'), 'Screen Size');
eq('specKey spaced colon', specKey('Screen Size :'), 'Screen Size');
// Amazon's real detail-bullet label: RLM, colon, LRM. Through 0.7.0 only the bullet path
// stripped these, so the table's "Screen Size" and the bullet's could not collide.
eq('specKey bidi-wrapped label', specKey('Date First Available \u200F : \u200E'), 'Date First Available');
eq('specKey leading mark', specKey('\u200EBrand'), 'Brand');
eq('specKey arabic letter mark', specKey('Brand\u061C:'), 'Brand');
eq('specKey collapses the table and bullet forms into ONE key',
   specKey('Screen Size') === specKey('Screen Size \u200F : \u200E'), true);
eq('specKey leaves an interior colon alone', specKey('Aspect Ratio: 16:9'), 'Aspect Ratio: 16:9');
eq('specKey null', specKey(null), '');

/* specCollector() — one bucket per row, and the cap announces itself. */
{
  const c = specCollector();
  c.add('Screen Size', '24 Inches', 'table');
  c.add('Brand', 'VIZIO', 'overview');
  eq('collector keeps distinct keys', c.out, { 'Screen Size': '24 Inches', Brand: 'VIZIO' });
  eq('collector counts rows and keeps', [c.meta.rowsSeen, c.meta.kept], [2, 2]);
  eq('collector tallies which source paid for what', c.meta.sources, { table: 1, overview: 1 });
}
{
  const c = specCollector();
  c.add('Brand', 'VIZIO', 'table');
  c.add('Brand', 'Vizio Inc', 'overview');
  eq('first writer wins', c.out.Brand, 'VIZIO');
  eq('the duplicate is counted, not silently gone', [c.meta.kept, c.meta.dupes], [1, 1]);
}
{
  const c = specCollector();
  c.add(null, null, 'table');            // a row with fewer than two cells
  c.add('Key', null, 'table');           // a cell that held no text
  c.add('x'.repeat(61), 'v', 'table');   // prose that is not an attribute name
  eq('rows that yield no pair are counted as unparsed', c.meta.unparsed, 3);
  eq('and none of them reach the map', c.meta.kept, 0);
}
{
  // THE defect. A cap may exist; a cap may not be silent.
  const c = specCollector(2);
  for (const k of ['A', 'B', 'C', 'D']) c.add(k, k.toLowerCase(), 'table');
  eq('the cap stops at its limit', Object.keys(c.out), ['A', 'B']);
  eq('and SAYS that it fired', c.meta.truncated, true);
  eq('and counts what it cost', c.meta.overCap, 2);
}
{
  const c = specCollector();
  c.add('A', 'a', 'table');
  eq('an untriggered cap leaves no flag to read', c.meta.truncated, undefined);
  eq('and nothing over it', c.meta.overCap, 0);
}
{
  const c = specCollector();
  c.add('Customer Reviews', '4.5 4.5 out of 5 stars 1,234 ratings', 'table');
  eq('the row that is literally rating.stars + rating.count is skipped', c.meta.skipped, 1);
  eq('and does not reach the map', c.out['Customer Reviews'], undefined);
}
{
  // Deliberately NOT skipped. Nothing else in the product record carries a sales rank, so
  // dropping this would delete a real attribute — the failure specs() exists to stop committing.
  const c = specCollector();
  c.add('Best Sellers Rank', '#1,234 in Electronics', 'table');
  eq('Best Sellers Rank survives', c.out['Best Sellers Rank'], '#1,234 in Electronics');
}
{
  // The invariant health() leans on: every row is accounted for exactly once, which is what
  // lets the coverage probe say "74 seen, 74 kept" and mean it.
  const c = specCollector(2);
  c.add('A', '1', 'table');
  c.add('A', '1', 'overview');                       // dupe
  c.add('Customer Reviews', 'x', 'table');           // skipped
  c.add(null, null, 'table');                        // unparsed
  c.add('B', '2', 'table');                          // kept
  c.add('C', '3', 'table');                          // over cap
  const m = c.meta;
  eq('every row lands in exactly one bucket',
     m.kept + m.dupes + m.skipped + m.unparsed + m.overCap, m.rowsSeen);
}
{
  const c = specCollector();
  c.add('A', 'x'.repeat(400), 'table');
  eq('values are clipped', c.out.A.length, 160);
}

/* The cap itself, and the two shapes of the old bug, pinned in the source text. */
eq('SPEC_CAP is a bound, not a budget', SPEC_CAP >= 200, true);
eq('no 30-key cap survives in the extractor',
   /Object\.keys\(out\)\.length < 30/.test(SRC_TEXT), false);
// Amazon nests detail bullets: <li><span class="a-list-item"><span class="a-text-bold">Key</span>
// <span>Value</span></span></li>. A flat sweep returns the WRAPPER at [0], so reading [0]/[1]
// off it yields the key "ASIN : B07DC5PPFV" mapped to the value "ASIN :" — wrong in both
// halves. It never fired only because that path ran solely when the table path returned nothing.
// Match the assignment, not the bare call: the comment in specs() that explains why the flat
// sweep is wrong quotes the pattern, and a guard that trips on its own documentation is noise.
eq('detail bullets are not read with a flat span sweep',
   /const spans = \$\$\('span', li\)/.test(SRC_TEXT), false);
eq('and the direct-children reader that replaced it is in place',
   /bulletCells/.test(SRC_TEXT), true);

/* The registry entries the merge depends on. */
eq('the overview grid is its own source, not a brand-only row',
   Array.isArray(amzx.SEL.product.overviewRows), true);
eq('the div-based product-facts accordion has a source',
   Array.isArray(amzx.SEL.product.factsRows), true);
eq('the facts row class is primary, ahead of the generic grid',
   /product-facts-detail/.test(amzx.SEL.product.factsRows[0]), true);
// pickAll returns the first candidate that matches ANYTHING, so a single list holding both
// would read the tables and never reach the overview grid.
eq('the overview grid is NOT concatenated into specRows',
   amzx.SEL.product.specRows.some((c) => /productOverview/.test(c)), false);

/* ------------------------------------------------------- surface check --- */
for (const fn of ['page', 'product', 'search', 'reviews', 'offers', 'buyAgain',
                  'charts', 'histogram', 'full', 'health', 'text']) {
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
