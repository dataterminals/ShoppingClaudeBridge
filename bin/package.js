#!/usr/bin/env node
'use strict';
/**
 * package.js — build the installable plugin bundle from plugin/.
 *
 *   node bin/package.js              # write <name>.plugin into the repo root
 *   node bin/package.js --list       # show what would go in; write nothing
 *   node bin/package.js --out PATH   # write somewhere else
 *
 * WHAT A `.plugin` IS. A zip, renamed, with `.claude-plugin/plugin.json` at the ARCHIVE root —
 * not inside a folder. Hand it to Cowork and it renders as a card you can browse and accept.
 *
 * WHY THIS EXISTS RATHER THAN `zip -r`. Two reasons, both learned by doing it by hand:
 *
 *   1. Windows has no `zip`, and both stock substitutes are wrong. `Compress-Archive` and
 *      `ZipFile.CreateFromDirectory` on .NET Framework write entry paths with BACKSLASHES, which
 *      is off-spec — the ZIP appnote says forward slashes — and a strict extractor either refuses
 *      them or produces one file named `skills\amazon-shopping\SKILL.md`. The archive looks fine
 *      in Explorer, which is the trap. So the container is written here, by hand: node ships
 *      deflate but no zip, and the framing is about sixty lines.
 *
 *   2. Packaging is the step where a stale asset ships. `bin/vendor.js` regenerates the repo's
 *      copy of the library but knows nothing about `plugin/`, so the bundled copy is maintained
 *      by hand and is the one that silently falls behind. This refuses to build unless the two
 *      are byte-identical and both `--check` gates pass; see the preflight below.
 *
 * DETERMINISM. Every entry gets a fixed 1980 DOS timestamp, so the same tree always produces the
 * same bytes. That is what makes `sha256` of a bundle a meaningful answer to "is this the build I
 * already handed over?" — with real mtimes, a rebuild that changed nothing still looks different.
 *
 * PRIVACY. The tree it packs is the operator's personal variant — machine names, purchase-history
 * workflow. That is why `plugin/` and `*.plugin` are both gitignored (see CLAUDE.md). The bundle
 * is for handing to Cowork, never for committing here.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'plugin');
const MANIFEST = path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
const REPO_ASSET = path.join(ROOT, '.claude', 'skills', 'amazon-shopping', 'assets', 'amzx.min.js');
const PLUGIN_ASSET = path.join(PLUGIN_DIR, 'skills', 'amazon-shopping', 'assets', 'amzx.min.js');

// Repo plumbing that has no business inside a distributed bundle. `*.plugin` is here because the
// archive is written to the repo root, and a second run would otherwise pack the first one.
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SKIP_FILES = new Set(['.gitattributes', '.gitignore', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const skipFile = (name) => SKIP_FILES.has(name) || name.endsWith('.plugin');

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Files to pack, as {name, data}, sorted by archive name so the output is stable. */
function collect(dir) {
  const out = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && !skipFile(entry.name)) {
        out.push({ name: path.relative(dir, full).replace(/\\/g, '/'), data: fs.readFileSync(full) });
      }
    }
  })(dir);
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

const DOS_TIME = 0;   // 00:00:00
const DOS_DATE = 33;  // 1980-01-01, the conventional zero for a reproducible build
const METHOD_DEFLATE = 8;
const MADE_BY_UNIX = 0x0314;          // so external attrs below are read as unix modes
const EXTERNAL_ATTR = 0o100644 << 16; // regular file, rw-r--r--, for extraction on posix

/** Write a spec-shaped zip: forward-slash names, no extra fields, fixed timestamps. */
function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);

    const common = Buffer.concat([
      u16(20), u16(0), u16(METHOD_DEFLATE), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(deflated.length), u32(data.length), u16(name.length),
    ]);

    const local = Buffer.concat([u32(0x04034b50), common, u16(0), name, deflated]);
    locals.push(local);

    central.push(Buffer.concat([
      u32(0x02014b50), u16(MADE_BY_UNIX), common,
      u16(0), u16(0), u16(0), u16(0), u32(EXTERNAL_ATTR), u32(offset), name,
    ]));

    offset += local.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(directory.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, directory, end]);
}

/** Everything that must hold before a bundle is allowed to exist. Returns a list of complaints. */
function preflight() {
  const problems = [];

  if (!fs.existsSync(MANIFEST)) {
    problems.push('no ' + rel(MANIFEST) + ' — the plugin tree is the private sibling repo; see CLAUDE.md');
    return problems; // nothing below can be judged without it
  }

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (e) {
    problems.push(rel(MANIFEST) + ' is not valid JSON: ' + e.message);
    return problems;
  }
  if (!manifest.name) problems.push(rel(MANIFEST) + ' has no "name" — it names the bundle');
  if (!manifest.version) problems.push(rel(MANIFEST) + ' has no "version" — installs replace by version');

  for (const [label, args] of [['vendored asset', ['bin/vendor.js', '--check']], ['skills', ['bin/skill-drift.js', '--check']]]) {
    try {
      execFileSync(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const said = Buffer.concat([e.stdout || Buffer.alloc(0), e.stderr || Buffer.alloc(0)]).toString().trim();
      problems.push(label + ' gate failed (node ' + args.join(' ') + '):\n    ' + said.replace(/\n/g, '\n    '));
    }
  }

  // The gate this file exists for: vendor.js cannot see plugin/, so this copy is the one that
  // goes stale, and a stale copy is invisible — Tier 2 just quietly injects last month's library.
  if (!fs.existsSync(PLUGIN_ASSET)) {
    problems.push('no ' + rel(PLUGIN_ASSET) + ' — the bundle has no library to inject');
  } else if (sha256(fs.readFileSync(PLUGIN_ASSET)) !== sha256(fs.readFileSync(REPO_ASSET))) {
    problems.push('bundled asset differs from the vendored one. It is a mechanical copy:\n'
      + '    cp ' + rel(REPO_ASSET) + ' ' + rel(PLUGIN_ASSET));
  }

  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes('--list');
  const outFlag = argv.indexOf('--out');

  const problems = preflight();
  if (problems.length) {
    console.error('refusing to package:');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const entries = collect(PLUGIN_DIR);
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';

  if (!entries.some((e) => e.name === '.claude-plugin/plugin.json')) {
    console.error('refusing to package: .claude-plugin/plugin.json is not at the archive root');
    process.exit(1);
  }

  for (const e of entries) console.log('  ' + String(e.data.length).padStart(6) + '  ' + e.name);

  if (listOnly) {
    console.log(entries.length + ' files, ' + kb(entries.reduce((n, e) => n + e.data.length, 0)) + ' uncompressed (nothing written)');
    return;
  }

  const out = outFlag !== -1 && argv[outFlag + 1]
    ? path.resolve(argv[outFlag + 1])
    : path.join(ROOT, manifest.name + '.plugin');

  const zip = buildZip(entries);
  fs.writeFileSync(out, zip);

  console.log('wrote ' + out);
  console.log('  ' + manifest.name + ' ' + manifest.version + ' — ' + entries.length + ' files, ' + kb(zip.length));
  console.log('  library ' + sha256(fs.readFileSync(PLUGIN_ASSET)).slice(0, 16) + ' (matches ' + rel(REPO_ASSET) + ')');
  console.log('  sha256 ' + sha256(zip).slice(0, 16) + ' — deterministic; an identical tree rebuilds to this exactly.');
  console.log('  personal build: it names real machines. Hand it to Cowork, never to a public repo.');
}

if (require.main === module) main();

module.exports = { buildZip, collect, preflight, PLUGIN_DIR, ROOT };
