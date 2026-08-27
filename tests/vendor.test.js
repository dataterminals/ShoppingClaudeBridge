/**
 * Tests for the vendored Tier-2 assets — zero dependencies, plain node.
 *
 *     node tests/vendor.test.js
 *
 * The skill injects `assets/<name>.min.js` into a live page when the userscript is absent. Two
 * things can go wrong and neither announces itself: an asset drifts out of sync with `src/`, so a
 * fixed bug quietly comes back; or the comment-stripping transform mangles the file, so it fails
 * inside a page rather than here. Both are checked below, for every target.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { build, TARGETS, ROOT } = require('../bin/vendor.js');

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) passed++;
  else failures.push(label + (detail ? '\n    ' + detail : ''));
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

ok('there is more than one vendored target', TARGETS.length >= 2,
   'found ' + TARGETS.length + ' — the loop below proves little with one');

const sizes = [];

for (const t of TARGETS) {
  const tag = t.name + ': ';

  ok(tag + 'source exists', fs.existsSync(t.src), rel(t.src));
  ok(tag + 'vendored asset exists', fs.existsSync(t.out),
     rel(t.out) + ' — run: node bin/vendor.js');
  if (!fs.existsSync(t.src) || !fs.existsSync(t.out)) continue;

  const source = fs.readFileSync(t.src, 'utf8');
  const vendored = fs.readFileSync(t.out, 'utf8');
  sizes.push({ name: t.name, bytes: Buffer.byteLength(vendored) });

  ok(tag + 'asset is in sync with src/', vendored === build(source, path.basename(t.src)),
     rel(t.src) + ' changed without rebuilding. Run: node bin/vendor.js');

  // The transform must not break the file. Evaluating it is the only test that proves that.
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  let evalError = null;
  try { vm.runInContext(vendored, sandbox, { filename: t.out }); } catch (e) { evalError = e; }
  ok(tag + 'asset evaluates without throwing', !evalError, evalError && evalError.message);

  // Both libraries publish with Object.defineProperty, which is non-enumerable — reach for the
  // documented global by name rather than enumerating, or this passes vacuously.
  const api = sandbox.window[t.global];
  ok(tag + 'asset publishes window.' + t.global, !!api);
  if (!api) continue;

  const srcBox = { window: {}, console };
  vm.createContext(srcBox);
  vm.runInContext(source, srcBox, { filename: t.src });
  const srcApi = srcBox.window[t.global];

  ok(tag + 'version matches src', api.version === srcApi.version,
     'vendored ' + api.version + ' vs src ' + srcApi.version);

  const a = Object.keys(api).sort().join(',');
  const b = Object.keys(srcApi).sort().join(',');
  ok(tag + 'API surface matches src', a === b, a + '\n    vs\n    ' + b);

  // Spot-check that stripping did not eat a parser. These are the two that silently corrupted
  // real numbers before they were pinned, and they live in the shared core block, so they are
  // worth re-checking in every target rather than only the one they were found in.
  const i = api._internals;
  ok(tag + 'num() survives stripping', i.num('(22.2K)') === 22200);
  ok(tag + 'money() survives stripping', i.money('$18.29$18.29') === 18.29);

  // The point of vendoring is a smaller injection payload; if it ever grows past the source,
  // the transform has broken rather than helped.
  ok(tag + 'asset is smaller than source',
     Buffer.byteLength(vendored) < Buffer.byteLength(source),
     Buffer.byteLength(vendored) + ' vs ' + Buffer.byteLength(source));
}

// Two targets writing the same path would silently leave one library unshipped.
const outs = TARGETS.map((t) => t.out);
ok('every target writes a distinct asset', new Set(outs).size === outs.length, outs.join('\n    '));
const globals = TARGETS.map((t) => t.global);
ok('every target publishes a distinct global', new Set(globals).size === globals.length,
   globals.join(', '));

if (failures.length) {
  console.error('\n' + failures.length + ' FAILED, ' + passed + ' passed\n');
  for (const f of failures) console.error('  x ' + f + '\n');
  process.exit(1);
}
console.log('All ' + passed + ' vendor tests passed across ' + TARGETS.length + ' targets ('
  + sizes.map((s) => s.name + ' ' + (s.bytes / 1024).toFixed(1) + ' KB').join(', ') + ').');
