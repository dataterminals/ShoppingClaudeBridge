/**
 * Tests for the plugin bundler — zero dependencies, plain node.
 *
 *     node tests/package.test.js
 *
 * bin/package.js writes a zip container by hand, because the stock Windows zippers emit
 * backslash-separated entry names and node ships deflate without zip. Hand-written framing is
 * exactly the kind of code that "works" against the writer that produced it and fails in a real
 * extractor, so everything below reads the archive back with an independent parser — central
 * directory first, the way a real unzipper does — rather than trusting the builder's own output.
 *
 * These build from synthetic entries, never from `plugin/`: that tree is the operator's private
 * checkout and is absent on a fresh clone and in CI. The one test that needs it skips instead.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildZip, collect, PLUGIN_DIR } = require('../bin/package.js');

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) passed++;
  else failures.push(label + (detail ? '\n    ' + detail : ''));
}

/** A deliberately independent reader: walk the central directory, not the local headers. */
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(end + 10);
  const size = buf.readUInt32LE(end + 12);
  const start = buf.readUInt32LE(end + 16);

  const files = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header at entry ' + i);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // Follow the offset into the local header and inflate what is actually there.
    if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error('bad local header for ' + name);
    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    const dataAt = offset + 30 + localNameLen + localExtraLen;
    const raw = buf.slice(dataAt, dataAt + csize);

    files.push({ name, method, crc, usize, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p - start !== size) throw new Error('central directory size disagrees with its entries');
  return files;
}

const FIXTURE = [
  { name: '.claude-plugin/plugin.json', data: Buffer.from('{"name":"t","version":"1.0.0"}\n') },
  { name: 'README.md', data: Buffer.from('# t\n') },
  { name: 'skills/demo/SKILL.md', data: Buffer.from('---\nname: demo\n---\n\n' + 'body '.repeat(500)) },
];

const zip = buildZip(FIXTURE);
let files = null;
let readError = null;
try { files = readZip(zip); } catch (e) { readError = e; }

ok('archive parses as a zip', !readError, readError && readError.message);

if (files) {
  ok('every entry survives the round trip', files.length === FIXTURE.length,
     files.length + ' of ' + FIXTURE.length);

  for (const original of FIXTURE) {
    const found = files.find((f) => f.name === original.name);
    ok('round-trips ' + original.name, found && found.data.equals(original.data),
       found ? 'content differs' : 'entry missing');
  }

  // The bug this bundler exists to avoid. Explorer hides it; a strict extractor does not.
  ok('entry names use forward slashes only',
     files.every((f) => !f.name.includes('\\')),
     files.map((f) => f.name).filter((n) => n.includes('\\')).join(', '));

  ok('no entry name is absolute or escapes the archive root',
     files.every((f) => !f.name.startsWith('/') && !f.name.split('/').includes('..')));

  ok('the manifest sits at the archive root, not in a folder',
     files.some((f) => f.name === '.claude-plugin/plugin.json'));

  ok('stored CRCs match the data', files.every((f) => zlib.crc32(f.data) === f.crc));

  ok('stored sizes match the data', files.every((f) => f.usize === f.data.length));

  ok('content is deflated, not stored', files.every((f) => f.method === 8));

  // Compression has to actually happen, or "bundle" is a misnomer.
  const uncompressed = FIXTURE.reduce((n, f) => n + f.data.length, 0);
  ok('a compressible tree gets smaller', zip.length < uncompressed,
     zip.length + ' vs ' + uncompressed);
}

// Determinism is what makes sha256(bundle) mean "same build" rather than "same second".
ok('the same tree rebuilds to identical bytes', buildZip(FIXTURE).equals(zip));

// buildZip writes the order it is handed — sorting is collect()'s job, tested below. Pinning
// that split matters: if buildZip ever sorted too, a caller packing a deliberate order would
// silently lose it.
ok('buildZip preserves the caller\'s order',
   JSON.stringify(readZip(buildZip([...FIXTURE].reverse())).map((f) => f.name))
   === JSON.stringify([...FIXTURE].reverse().map((f) => f.name)));

// An empty archive is still a valid archive — worth pinning, since the EOCD is written whether
// or not any entry precedes it.
let emptyError = null;
try { readZip(buildZip([])); } catch (e) { emptyError = e; }
ok('an empty archive still parses', !emptyError, emptyError && emptyError.message);

if (fs.existsSync(PLUGIN_DIR)) {
  const entries = collect(PLUGIN_DIR);
  ok('collect() finds the manifest at the root',
     entries.some((e) => e.name === '.claude-plugin/plugin.json'));
  ok('collect() leaves repo plumbing out of the bundle',
     entries.every((e) => !e.name.startsWith('.git') && !e.name.endsWith('.plugin')),
     entries.map((e) => e.name).filter((n) => n.startsWith('.git') || n.endsWith('.plugin')).join(', '));
  ok('collect() returns names in a stable order',
     JSON.stringify(entries.map((e) => e.name))
     === JSON.stringify([...entries.map((e) => e.name)].sort()));
} else {
  console.log('(plugin/ absent — skipping the three tests that read it. Normal outside the operator\'s machine.)');
}

if (failures.length) {
  console.error('\n' + failures.length + ' FAILED, ' + passed + ' passed\n');
  for (const f of failures) console.error('  x ' + f + '\n');
  process.exit(1);
}
console.log('All ' + passed + ' package tests passed. Fixture archive ' + zip.length + ' bytes.');
