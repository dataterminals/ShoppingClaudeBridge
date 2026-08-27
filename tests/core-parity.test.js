/**
 * Tests that the shared core block is byte-identical across every userscript in src/.
 *
 *     node tests/core-parity.test.js
 *
 * WHY THIS EXISTS. There are two userscripts — one per site — and each carries its own copy of
 * the ~110-line util block (clean/clip/money/num/currency/compact/pick*). They cannot share a
 * module: a userscript is a single file the extension injects, and `@match` already guarantees
 * the two never coexist on a page, so a build step buying a single source would only cost the
 * `src/*.user.js` paths that @downloadURL and @updateURL point at.
 *
 * The duplication is therefore deliberate, and this file is the price of it. Same doctrine as
 * `bin/vendor.js --check` and `bin/skill-drift.js`: a copy that can silently drift is worse than
 * no copy. `money()` alone carries two hard-won fixes — "$9.99$9.99" parsing as 9.999, and
 * "(22.2K)" parsing as 222 — and a repo where one of those is fixed in one file and not the
 * other is exactly the failure this repo keeps building machinery to prevent.
 *
 * Fixing a failure here means porting the change to EVERY userscript, never deleting the block
 * from one. The identity check below is paired with a content check for that reason: two empty
 * blocks are byte-identical too.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const START = '// --8<-- shared core: START.';
const END = '// --8<-- shared core: END.';

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) passed++;
  else failures.push(label + (detail ? '\n    ' + detail : ''));
}

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.user.js')).sort();

ok('at least two userscripts to compare', files.length >= 2,
   'found ' + files.length + ' in src/ — this test proves nothing with fewer');
if (files.length < 2) {
  console.error('FAIL: need >= 2 src/*.user.js');
  process.exit(1);
}

/** Everything from the START marker line's end to the END marker line's start. */
function coreBlock(text) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a === -1 || b === -1 || b < a) return null;
  // Skip the whole START comment paragraph: from the marker, advance past every following
  // line that is still a // comment, so the marker's own explanatory lines are not compared.
  const lines = text.slice(a).split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim().startsWith('//')) i++;
  const from = a + lines.slice(0, i).join('\n').length + 1;
  return text.slice(from, b);
}

const blocks = files.map((f) => {
  const text = fs.readFileSync(path.join(SRC, f), 'utf8');
  return { file: f, text: text, core: coreBlock(text) };
});

for (const b of blocks) {
  ok(b.file + ' has both core markers', b.core !== null,
     'expected ' + START + ' ... ' + END);
}
if (blocks.some((b) => b.core === null)) {
  console.error('FAIL: missing markers');
  process.exit(1);
}

// Two empty blocks are byte-identical, so identity alone is not enough. Pin the names that
// have to be in there; deleting one to make the diff go away should fail loudly.
const REQUIRED = ['const clean =', 'const clip =', 'const money =', 'const num =',
                  'const currency =', 'const compact =', 'const pick =', 'const pickText =',
                  'const pickAttr =', 'const txtOf ='];
for (const b of blocks) {
  const missing = REQUIRED.filter((r) => !b.core.includes(r));
  ok(b.file + ' core block still defines every shared util', missing.length === 0,
     'missing: ' + missing.join(', '));
}

const [first, ...rest] = blocks;
for (const b of rest) {
  const same = b.core === first.core;
  let detail = null;
  if (!same) {
    const a = first.core.split('\n');
    const c = b.core.split('\n');
    const at = a.findIndex((line, i) => line !== c[i]);
    detail = 'first difference at core line ' + (at + 1) + ':\n'
      + '      ' + first.file + ': ' + JSON.stringify(a[at]) + '\n'
      + '      ' + b.file + ': ' + JSON.stringify(c[at]) + '\n'
      + '    Port the change to BOTH files. Do not delete the block from one.';
  }
  ok('core block identical: ' + first.file + ' vs ' + b.file, same, detail);
}

// Identical text can still behave differently if a later line in one file shadows a util.
// Evaluate each script and compare the shared parsers on the inputs that have actually bitten.
const CASES = [
  ['money', '$18.29$18.29', 18.29],
  ['money', 'US $51.90', 51.9],
  ['money', '12,34 EUR', 12.34],
  ['num', '(22.2K)', 22200],
  ['num', '236 sold', 236],
  ['clip', 'abcdefghij', 'abcdefghij'],
  ['currency', 'US $51.90', 'USD'],
];

const apis = [];
for (const b of blocks) {
  const box = { window: {}, console: console, document: undefined };
  vm.createContext(box);
  let err = null;
  try { vm.runInContext(b.text, box, { filename: b.file }); } catch (e) { err = e; }
  ok(b.file + ' evaluates without throwing', !err, err && err.message);
  // getOwnPropertyNames, not Object.keys: both libraries publish themselves with
  // Object.defineProperty, which leaves the property non-enumerable, so Object.keys sees
  // nothing at all and every check below would vacuously pass.
  const key = Object.getOwnPropertyNames(box.window).find((k) => k.startsWith('__'));
  ok(b.file + ' publishes a window.__* API', !!key);
  if (key) apis.push({ file: b.file, api: box.window[key], name: key });
}

if (apis.length >= 2) {
  for (const [fn, input, expected] of CASES) {
    for (const a of apis) {
      const got = a.api._internals[fn](input);
      ok(a.name + '._internals.' + fn + '(' + JSON.stringify(input) + ')',
         got === expected, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(expected));
    }
  }
  // compact() is the one that shapes every record; check it structurally rather than by value.
  for (const a of apis) {
    const got = JSON.stringify(a.api._internals.compact({ a: 1, b: null, c: [], d: { e: null } }));
    ok(a.name + '._internals.compact drops empties', got === '{"a":1}', 'got ' + got);
  }
}

if (failures.length) {
  console.error('\n' + failures.length + ' FAILED, ' + passed + ' passed\n');
  for (const f of failures) console.error('  x ' + f + '\n');
  process.exit(1);
}
console.log('All ' + passed + ' core-parity tests passed across ' + files.length
  + ' userscripts (' + files.join(', ') + '); core block is '
  + first.core.split('\n').length + ' lines.');
