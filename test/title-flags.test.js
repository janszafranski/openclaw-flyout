#!/usr/bin/env node
/*
 * Tests for the bridge's drawer title flags (loadTitleFlags / titleFor).
 *
 * This is the code that replaced a hardcoded regex of one person's private
 * legal-case tokens, so what is being pinned down is mostly "nothing personal
 * is in the repo, and nothing personal leaks into the log either":
 *
 *   - the SHIPPED state (no config file, and the committed .example) must flag
 *     nothing at all, so a fresh clone has no opinion about anybody's data;
 *   - the startup log must report a count and a path, never a token;
 *   - hostile/typo'd config must degrade, never throw — this file is hand-edited
 *     by a user, and the bridge is the panel's whole data layer.
 *
 * Unlike reconcile.test.js, the function under test is not duplicated here: the
 * real source text is lifted out of bin/openclaw-ai-bridge.js and evaluated with
 * its collaborators stubbed. The bridge starts listening on require, so it
 * cannot simply be imported — but slicing it keeps the tests honest, because
 * there is no second copy to drift.
 *
 *   node --test test/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BRIDGE = path.join(__dirname, '..', 'bin', 'openclaw-ai-bridge.js');
const EXAMPLE = path.join(__dirname, '..', 'config', 'title-flags.json.example');

// --- lift the real block out of the bridge ----------------------------------
function titleFlagSource() {
  const src = fs.readFileSync(BRIDGE, 'utf8');
  const start = src.indexOf('const TITLE_FLAGS_FILE =');
  const end = src.indexOf('// Resolve up to `width` promises');
  assert.ok(start > 0, 'could not find TITLE_FLAGS_FILE in the bridge');
  assert.ok(end > start, 'could not find the end of the title-flag block');
  const block = src.slice(start, end);
  assert.match(block, /function loadTitleFlags/, 'block is missing loadTitleFlags');
  assert.match(block, /function titleFor/, 'block is missing titleFor');
  return block;
}
const BLOCK = titleFlagSource();

// --- harness ----------------------------------------------------------------
// Each build() is a fresh "bridge startup": it re-reads the config file, which
// is what the real thing does once per process.
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-flags-'));
  const file = path.join(dir, 'title-flags.json');
  const logs = [];
  let raw = '';
  let stamp = 0; // a fresh updatedAt per call, so titleCache never masks a result

  return {
    logs,
    setTranscript(text) { raw = text; },
    write(obj) { fs.writeFileSync(file, JSON.stringify(obj)); },
    writeText(text) { fs.writeFileSync(file, text); },
    copyExample() { fs.copyFileSync(EXAMPLE, file); },
    remove() { try { fs.unlinkSync(file); } catch (e) { /* already absent */ } },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
    build() {
      // eslint-disable-next-line no-new-func
      const mod = new Function(
        'fs', 'CONFIG_DIR', 'firstLine', 'transcriptRead', 'parseTranscript', 'console', 'process',
        BLOCK + '\nreturn { titleFor, TITLE_FLAGS };'
      )(
        fs,
        dir,
        e => String((e && e.message) || e).split('\n')[0],
        async () => ({ raw }),
        // Enough of parseTranscript's contract for a title: line 1 is the first
        // human message. The real parser is exercised elsewhere.
        text => (text ? [{ role: 'user', content: text.split('\n')[0] }] : []),
        { log: m => logs.push(m), error: m => logs.push(m) },
        process
      );
      return { ...mod, title: () => mod.titleFor('session-under-test', ++stamp) };
    },
  };
}

// A flag entry that would match, if only it were configured.
const flag = (over = {}) => ({ prefix: '⚖', threshold: 1, tokens: ['widget'], ...over });

// --- the shipped state flags nothing ----------------------------------------

test('no config file at all loads zero flags and leaves the title alone', async () => {
  const h = harness();
  try {
    h.remove();
    const m = h.build();
    assert.deepStrictEqual(m.TITLE_FLAGS, []);
    h.setTranscript('a widget question');
    assert.strictEqual(await m.title(), 'a widget question');
  } finally { h.cleanup(); }
});

test('the committed .example enables nothing (a fresh clone flags no-one)', async () => {
  const h = harness();
  try {
    h.copyExample();
    const m = h.build();
    assert.deepStrictEqual(m.TITLE_FLAGS, [], 'the shipped example must ship zero live flags');
    h.setTranscript('a widget question');
    assert.strictEqual(await m.title(), 'a widget question');
  } finally { h.cleanup(); }
});

test('the committed .example is valid JSON and shaped as the loader expects', () => {
  const parsed = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  assert.ok(Array.isArray(parsed.flags), 'needs a `flags` array');
  assert.strictEqual(parsed.flags.length, 0, 'the shipped default must be empty');
  // _example documents the schema; it must not be read as a live flag.
  assert.ok(parsed._example && Array.isArray(parsed._example.tokens), '_example should show tokens');
});

// --- threshold semantics (the reason this is a count, not a boolean) ---------

test('a transcript below the threshold is not flagged', async () => {
  const h = harness();
  try {
    h.write({ flags: [flag({ threshold: 3, tokens: ['widget', 'gizmo co'] })] });
    h.setTranscript('a widget question\nwidget');  // 2 hits, needs 3
    assert.strictEqual(await h.build().title(), 'a widget question');
  } finally { h.cleanup(); }
});

test('a transcript at the threshold is flagged, counting every token and case', async () => {
  const h = harness();
  try {
    h.write({ flags: [flag({ threshold: 3, tokens: ['widget', 'gizmo co'] })] });
    h.setTranscript('a widget question\nWidget WIDGET gizmo CO');
    assert.strictEqual(await h.build().title(), '⚖ a widget question');
  } finally { h.cleanup(); }
});

test('the first flag that clears its threshold wins, in config order', async () => {
  const h = harness();
  try {
    h.write({ flags: [
      flag({ prefix: 'A', threshold: 99 }),   // matches, but not enough
      flag({ prefix: 'B', threshold: 1 }),
      flag({ prefix: 'C', threshold: 1 }),
    ] });
    h.setTranscript('widget here');
    assert.strictEqual(await h.build().title(), 'B widget here');
  } finally { h.cleanup(); }
});

// --- prefix handling --------------------------------------------------------

test('a bare prefix gains a separating space', async () => {
  const h = harness();
  try {
    h.write({ flags: [flag({ prefix: '⚖' })] });
    h.setTranscript('widget');
    assert.strictEqual(await h.build().title(), '⚖ widget');
  } finally { h.cleanup(); }
});

test('a prefix that already ends in whitespace is used verbatim', async () => {
  const h = harness();
  try {
    h.write({ flags: [flag({ prefix: '⚖ Matter — ' })] });
    h.setTranscript('widget');
    assert.strictEqual(await h.build().title(), '⚖ Matter — widget');
  } finally { h.cleanup(); }
});

// --- tokens are literal, not regexes ----------------------------------------

test('regex metacharacters in a token match themselves', async () => {
  const h = harness();
  try {
    h.write({ flags: [flag({ prefix: '#', tokens: ['a(b'] })] });
    const m = h.build();
    h.setTranscript('x a(b y');
    assert.strictEqual(await m.title(), '# x a(b y');
    h.setTranscript('x ab y');
    assert.strictEqual(await m.title(), 'x ab y', '`(` must not be read as a group');
  } finally { h.cleanup(); }
});

test('a token that would be an invalid regex is still loadable', async () => {
  const h = harness();
  try {
    h.write({ flags: [flag({ prefix: '#', tokens: ['a)b', '[unclosed'] })] });
    const m = h.build();
    assert.strictEqual(m.TITLE_FLAGS.length, 1, 'must not throw on an unescaped token');
    h.setTranscript('see [unclosed here');
    assert.strictEqual(await m.title(), '# see [unclosed here');
  } finally { h.cleanup(); }
});

// --- bad config degrades, it does not take the bridge down ------------------

test('invalid JSON is warned about and ignored', async () => {
  const h = harness();
  try {
    h.writeText('{ not json');
    const m = h.build();
    assert.deepStrictEqual(m.TITLE_FLAGS, []);
    assert.ok(h.logs.some(l => /not valid JSON/.test(l)), 'expected a warning');
    h.setTranscript('still fine');
    assert.strictEqual(await m.title(), 'still fine', 'titles must keep working');
  } finally { h.cleanup(); }
});

test('entries missing a prefix or tokens are skipped rather than fatal', () => {
  const h = harness();
  try {
    h.write({ flags: [
      { tokens: ['x'] },            // no prefix
      { prefix: '!' },              // no tokens
      { prefix: '!', tokens: [] },  // empty tokens
      { prefix: '!', tokens: ['', '  '] }, // blank tokens only
      { prefix: 7, tokens: ['x'] }, // wrong type
      'nope',
      null,
    ] });
    assert.deepStrictEqual(h.build().TITLE_FLAGS, []);
  } finally { h.cleanup(); }
});

test('a `flags` key of the wrong type is ignored', () => {
  for (const flags of ['not-an-array', 42, null, { a: 1 }]) {
    const h = harness();
    try {
      h.write({ flags });
      assert.deepStrictEqual(h.build().TITLE_FLAGS, [], `flags: ${JSON.stringify(flags)}`);
    } finally { h.cleanup(); }
  }
});

test('a missing, zero, negative or non-numeric threshold falls back to 1', () => {
  const h = harness();
  try {
    h.write({ flags: [
      { prefix: 'a', tokens: ['w'] },
      { prefix: 'b', tokens: ['w'], threshold: 0 },
      { prefix: 'c', tokens: ['w'], threshold: -5 },
      { prefix: 'd', tokens: ['w'], threshold: 'lots' },
      { prefix: 'e', tokens: ['w'], threshold: 2.7 },
    ] });
    assert.deepStrictEqual(
      h.build().TITLE_FLAGS.map(f => f.threshold),
      [1, 1, 1, 1, 2],
      'a fractional threshold floors; anything unusable becomes 1'
    );
  } finally { h.cleanup(); }
});

// --- nothing personal reaches the log --------------------------------------

test('the startup line reports a count and a path, never a token', () => {
  const h = harness();
  try {
    h.write({ flags: [flag({ threshold: 5, tokens: ['a-private-matter-ref', 'someone'] })] });
    const m = h.build();
    assert.strictEqual(m.TITLE_FLAGS.length, 1);
    assert.strictEqual(h.logs.length, 1, 'exactly one startup line');
    assert.match(h.logs[0], /title flags: 1 loaded/);
    for (const token of ['a-private-matter-ref', 'someone']) {
      assert.ok(!h.logs.join('|').includes(token), `token "${token}" leaked into the log`);
    }
  } finally { h.cleanup(); }
});

test('a skipped entry is reported by index, without echoing its contents', () => {
  const h = harness();
  try {
    h.write({ flags: [{ prefix: '', tokens: ['a-private-matter-ref'] }] });
    h.build();
    const joined = h.logs.join('|');
    assert.match(joined, /title-flags\[0\]/, 'should name the index');
    assert.ok(!joined.includes('a-private-matter-ref'), 'token leaked into the warning');
  } finally { h.cleanup(); }
});

// --- unchanged pre-existing behaviour --------------------------------------

test('a transcript with no human message still yields a null title', async () => {
  const h = harness();
  try {
    h.remove();
    h.setTranscript('');
    assert.strictEqual(await h.build().title(), null);
  } finally { h.cleanup(); }
});

// --- the tokens really are gone from the repo ------------------------------

// Every tracked file's text, keyed by path. Empty when this is not a checkout.
function trackedFiles() {
  const { execFileSync } = require('node:child_process');
  const root = path.join(__dirname, '..');
  let names;
  try {
    names = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
      .split('\0').filter(Boolean);
  } catch (e) {
    return null; // tarball install, no git — nothing to assert
  }
  const out = new Map();
  for (const rel of names) {
    try {
      out.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
    } catch (e) { /* binary asset or already removed */ }
  }
  return out;
}

// This guard reads the tokens from the user's own config rather than listing
// them, because a list of "words that must not appear in the repo" put *in* the
// repo is the original bug wearing a different hat. With no config present there
// is nothing to check and the test skips.
test('no tracked file contains any token from the local title-flags config', t => {
  const tracked = trackedFiles();
  if (!tracked) return t.skip('not a git checkout');

  const home = process.env.HOME || '';
  const live = process.env.OPENCLAW_FLYOUT_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'openclaw-flyout');
  let tokens;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(live, 'title-flags.json'), 'utf8'));
    tokens = (Array.isArray(cfg.flags) ? cfg.flags : [])
      .flatMap(f => (Array.isArray(f && f.tokens) ? f.tokens : []))
      .filter(s => typeof s === 'string' && s.trim().length >= 4); // skip trivially short
  } catch (e) {
    return t.skip('no local title-flags.json to check against');
  }
  if (!tokens.length) return t.skip('local title-flags.json configures no tokens');

  const offenders = [];
  for (const [rel, text] of tracked) {
    const hay = text.toLowerCase();
    for (const token of tokens) {
      // Report the file and token length only — never the token itself, or the
      // failure output becomes the leak.
      if (hay.includes(token.toLowerCase())) offenders.push(`${rel} (token of ${token.length} chars)`);
    }
  }
  assert.deepStrictEqual(offenders, [], 'a configured private token is in tracked source');
});

// A structural backstop that needs no config: a county-court claim number has a
// recognisable shape, and no source file has a reason to contain one.
test('no tracked file contains anything shaped like a claim number', t => {
  const tracked = trackedFiles();
  if (!tracked) return t.skip('not a git checkout');
  const claimNumber = /\b[A-Z]\d{2}[A-Z]{2}\d{3}\b/;
  const offenders = [];
  for (const [rel, text] of tracked) {
    if (claimNumber.test(text)) offenders.push(rel);
  }
  assert.deepStrictEqual(offenders, [], 'something shaped like a claim number is in tracked source');
});
