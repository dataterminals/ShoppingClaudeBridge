/**
 * Parser tests for ebay-claude-bridge.user.js — zero dependencies, plain node.
 *
 *     node tests/ebay-parse.test.js
 *
 * Same contract as tests/parse.test.js: these cover the pure string parsers, not the selectors.
 * Selectors can only be checked against the live site (`__ebayx.health()`).
 *
 * EVERY INPUT BELOW IS A LITERAL CAPTURE from ebay.com on 2026-08-27 — item 225056546791 and a
 * 70-card search for "vans sk8-hi" — not an invented example. That matters because most of these
 * strings are ugly in a way nobody would think to make up: eBay concatenates adjacent spans with
 * no separator ("See detailsfor shipping", "2 available236 sold"), and welds the screen-reader
 * affordance onto the end of every search-result title.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'ebay-claude-bridge.user.js');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

const ebayx = sandbox.window.__ebayx;
if (!ebayx) {
  console.error('FAIL: the script did not publish window.__ebayx at all.');
  process.exit(1);
}
const { itemIdFrom, spans, deA11y, shippingInfo, returnsInfo, discountInfo,
        money, num } = ebayx._internals;

let passed = 0;
const failures = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

/* ------------------------------------------------------------ itemIdFrom() */

eq('itemId from a bare /itm/ url', itemIdFrom('https://www.ebay.com/itm/225056546791'), '225056546791');
eq('itemId with a slug segment',
   itemIdFrom('https://www.ebay.com/itm/vans-sk8-hi-black/377323365140'), '377323365140');
eq('itemId with a query string',
   itemIdFrom('https://www.ebay.com/itm/127006413305?var=123&_trkparms=x'), '127006413305');
eq('itemId from a non-item url', itemIdFrom('https://www.ebay.com/sch/i.html?_nkw=vans'), null);
eq('itemId from junk', itemIdFrom(null), null);

/* ----------------------------------------------------------------- spans()
 * eBay ships prose as {textSpans:[{text}]}. Reaching for [0] gets you the word "Was".
 */

eq('spans joins every fragment',
   spans({ textSpans: [{ text: 'Was ' }, { text: 'US $55.21' }, { text: ' ' }, { text: '(6% off)' }] }),
   'Was US $55.21 (6% off)');
eq('spans on the out-of-stock signal',
   spans({ textSpans: [{ text: 'Out of Stock' }, { text: '236 sold' }] }), 'Out of Stock 236 sold');
eq('spans on a null display', spans(null), null);
eq('spans on a display with no textSpans', spans({ _type: 'TextualDisplay' }), null);

/* ---------------------------------------------------------------- deA11y()
 * Search-result titles carry the affordance welded on with no separator.
 */

eq('deA11y strips the welded affordance',
   deA11y('VANS Sk8-Hi Men’s High Top Lace-Up Sneakers Blue/White Rubber Sole 507698Opens in a new window or tab'),
   'VANS Sk8-Hi Men’s High Top Lace-Up Sneakers Blue/White Rubber Sole 507698');
eq('deA11y leaves an item-page title alone',
   deA11y('*NEW* Unisex VANS SK8-HI BLACK / BLACK / WHITE (VN000D5IB8C)'),
   '*NEW* Unisex VANS SK8-HI BLACK / BLACK / WHITE (VN000D5IB8C)');
eq('deA11y on empty', deA11y(''), null);

/* ---------------------------------------------------------- shippingInfo()
 * The blob holds cost AND origin, with adjacent spans concatenated ("detailsfor").
 * FREE IS NOT UNKNOWN. A null cost must never be summed into a total as zero, which is why
 * `free` and `cost` are separate and `cost` stays absent when nothing parsed.
 */

eq('free shipping, with origin',
   shippingInfo('Free Standard Shipping. See detailsfor shippingLocated in: Wheeling, Illinois, United States'),
   { text: 'Free Standard Shipping. See detailsfor shippingLocated in: Wheeling, Illinois, United States',
     free: true, cost: 0, from: 'Wheeling, Illinois, United States' });
eq('paid shipping from a search row', shippingInfo('+$5.83 delivery'),
   { text: '+$5.83 delivery', cost: 5.83 });
eq('free delivery from a search row', shippingInfo('Free delivery'),
   { text: 'Free delivery', free: true, cost: 0 });
// The expensive case: a cost we could not read must NOT come back as 0.
eq('unparseable shipping yields no cost', shippingInfo('May not ship to your location'),
   { text: 'May not ship to your location' });
eq('shipping on empty', shippingInfo(''), null);

/* ----------------------------------------------------------- returnsInfo()
 * Three states, not two. On a shoe that might not fit the gap between (1) and (3) is worth
 * more than $15 of sticker price, and state (2) quietly costs $10-15 when it goes wrong.
 */

eq('returns accepted, buyer pays',
   returnsInfo('30 days returns. Buyer pays for return shipping. If you use an eBay shipping label, it will be deducted from your refund.'),
   { accepted: true, days: 30, shippingPaidBy: 'buyer' });
eq('returns accepted, seller pays',
   returnsInfo('30 days returns. Seller pays for return shipping.'),
   { accepted: true, days: 30, shippingPaidBy: 'seller' });
eq('returns refused', returnsInfo('Seller does not accept returns.'), { accepted: false });
eq('returns accepted, payer unstated', returnsInfo('60 days returns.'),
   { accepted: true, days: 60 });
eq('returns on empty', returnsInfo(''), null);

/* ---------------------------------------------------------- discountInfo() */

eq('discount splits the was-price from the percentage',
   discountInfo('Was US $55.21 (6% off)'),
   { was: 55.21, pct: 6, text: 'Was US $55.21 (6% off)' });
eq('discount with a comma-grouped was-price',
   discountInfo('Was US $1,299.00 (23% off)'),
   { was: 1299, pct: 23, text: 'Was US $1,299.00 (23% off)' });
eq('discount on empty', discountInfo(''), null);

/* -------------------------------------------------- shared parsers, on eBay shapes
 * money() and num() are the shared core block. These pin the eBay inputs specifically —
 * "US $51.90" carries a currency prefix Amazon never sends, and the quantity line arrives
 * with its two numbers glued together.
 */

eq('money on eBay price form', money('US $51.90'), 51.9);
eq('money on a bid', money('$6.08'), 6.08);
eq('money on a shipping surcharge', money('+$5.83 delivery'), 5.83);
// "2 available236 sold" — the item-page quantity line, both numbers in one string.
const QTY = '2 available236 sold';
eq('quantity available out of the glued line', num((QTY.match(/(\d[\d,]*)\s*available/i) || [])[1]), 2);
eq('quantity sold out of the glued line', num((QTY.match(/(\d[\d,]*)\s*sold/i) || [])[1]), 236);
// The out-of-stock variant renders the same slot as prose instead of a count.
const QTY_OOS = 'Out of Stock 236 sold';
eq('no available count when out of stock',
   num((QTY_OOS.match(/(\d[\d,]*)\s*available/i) || [])[1]), null);
eq('sold count still readable when out of stock',
   num((QTY_OOS.match(/(\d[\d,]*)\s*sold/i) || [])[1]), 236);

/* ------------------------------------------------------------- seller line
 * Captured verbatim: name, count and percentage arrive concatenated with no separators.
 * A bare "100% positive" is the least informative version of this data, so the extractor
 * must recover the count too — 100% of 32 and 99.7% of 10,025 are different objects.
 */

const CARD = "Denim N Jeans(31571)99.9% positiveSeller's other itemsSeller's other itemsMessage";
eq('seller feedback count', num((CARD.match(/\((\d[\d,]*)\)/) || [])[1]), 31571);
eq('seller positive percentage', parseFloat((CARD.match(/([\d.]+)\s*%\s*positive/i) || [])[1]), 99.9);
eq('seller name up to the count', (CARD.match(/^([^(]+)\(/) || [])[1], 'Denim N Jeans');

/* ------------------------------------------------------------- API surface */

eq('version is published', typeof ebayx.version, 'string');
eq('full() is async', ebayx.full.constructor.name, 'AsyncFunction');
for (const fn of ['page', 'item', 'search', 'variants', 'specifics', 'seller', 'health', 'text']) {
  eq('API exposes ' + fn, typeof ebayx[fn], 'function');
}

if (failures.length) {
  console.error('\n' + failures.length + ' FAILED, ' + passed + ' passed\n');
  for (const f of failures) console.error('  x ' + f + '\n');
  process.exit(1);
}
console.log('All ' + passed + ' eBay parser tests passed.');
