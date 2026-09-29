#!/usr/bin/env node
/*
 * Tests for the flyout's history reconcile, ported verbatim from
 * quickshell/openclaw-sidebar/shell.qml `reconcileHistory()`.
 *
 * It is the one piece of the panel with real algorithmic content, it is the
 * piece the flash / scroll-snap-back / "the question vanished" bugs all lived
 * in, and it got harder when /history became a WINDOW on the newest messages
 * rather than the whole transcript. QML has no test runner, so the function is
 * duplicated here; keep the two in sync (they are ~25 lines).
 *
 *   node --test test/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// --- fake ListModel, same surface as the QML one uses -----------------------
function makeModel(rows = []) {
  const items = rows.map(r => ({ ...r }));
  return {
    get count() { return items.length; },
    get: i => items[i],
    append: r => items.push({ role: r.role, content: r.content }),
    clear: () => { items.length = 0; },
    rows: () => items.map(r => ({ role: r.role, content: r.content })),
  };
}

// --- the function under test (mirror of shell.qml) --------------------------
function reconcileHistory(chatModel, next) {
  var c = chatModel.count;
  var n = next.length;
  if (c === 0) {
    for (var f = 0; f < n; f++) chatModel.append(next[f]);
    return n > 0;
  }
  var cur = [];
  for (var s = 0; s < c; s++) { var r = chatModel.get(s); cur.push(r.role); cur.push(r.content); }
  for (var o = 0; o < c; o++) {
    var overlap = Math.min(n, c - o);
    var ok = true;
    for (var i = 0; i < overlap; i++) {
      if (cur[2 * (o + i)] !== next[i].role || cur[2 * (o + i) + 1] !== next[i].content) { ok = false; break; }
    }
    if (!ok) continue;
    if (n <= overlap) return false;
    for (var a = overlap; a < n; a++) chatModel.append(next[a]);
    return true;
  }
  chatModel.clear();
  for (var k = 0; k < n; k++) chatModel.append(next[k]);
  return true;
}

// --- helpers ----------------------------------------------------------------
// msgs(3) -> [u0, a0, u1] : alternating user/assistant, content is the index.
const msgs = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    role: (from + i) % 2 ? 'assistant' : 'user',
    content: 'm' + (from + i),
  }));

test('empty model adopts the whole window', () => {
  const m = makeModel();
  assert.equal(reconcileHistory(m, msgs(5)), true);
  assert.deepEqual(m.rows(), msgs(5));
});

test('empty model + empty window reports no change', () => {
  const m = makeModel();
  assert.equal(reconcileHistory(m, []), false);
  assert.equal(m.count, 0);
});

test('identical window is a no-op (no repaint, no flash)', () => {
  const m = makeModel(msgs(5));
  assert.equal(reconcileHistory(m, msgs(5)), false);
  assert.deepEqual(m.rows(), msgs(5));
});

test('a completed turn appends only the new tail', () => {
  const m = makeModel(msgs(5));
  assert.equal(reconcileHistory(m, msgs(7)), true);
  assert.deepEqual(m.rows(), msgs(7));
});

test('a lagging store never clobbers optimistic local rows', () => {
  // The user hit send: the prompt and the streamed reply are in the model, but
  // the gateway only writes a turn to SQLite on completion, so the store is two
  // messages behind. This is the "my question disappeared" case.
  const m = makeModel(msgs(7));
  assert.equal(reconcileHistory(m, msgs(5)), false);
  assert.deepEqual(m.rows(), msgs(7));
});

test('a windowed store that is a suffix of the model is a no-op', () => {
  // /history?limit=200 on a 202-message chat: the window starts 2 messages into
  // what we show. Prefix-anchored diffing got this wrong and stopped updating.
  const m = makeModel(msgs(202));
  assert.equal(reconcileHistory(m, msgs(200, 2)), false);
  assert.equal(m.count, 202);
});

test('a windowed store that has moved on appends only the tail', () => {
  const m = makeModel(msgs(202));            // showing m0..m201
  assert.equal(reconcileHistory(m, msgs(200, 4)), true); // store window m4..m203
  assert.deepEqual(m.rows(), msgs(204));     // m202, m203 appended; m0.. kept
});

test('genuinely diverged history rebuilds', () => {
  const m = makeModel(msgs(5));
  const other = [{ role: 'user', content: 'different chat' }];
  assert.equal(reconcileHistory(m, other), true);
  assert.deepEqual(m.rows(), other);
});

test('an edited message rebuilds rather than appending a duplicate', () => {
  const m = makeModel(msgs(5));
  const edited = msgs(5);
  edited[2] = { role: 'user', content: 'edited' };
  assert.equal(reconcileHistory(m, edited), true);
  assert.deepEqual(m.rows(), edited);
});

test('restore after a hot reload adopts the window', () => {
  // Quickshell reloaded mid-turn: the model holds only the in-flight turn while
  // the store holds the window. Not the clobber case — the opposite.
  const m = makeModel(msgs(2, 200));
  assert.equal(reconcileHistory(m, msgs(200)), true);
  assert.deepEqual(m.rows(), msgs(200));
});

test('role is compared, not just content', () => {
  const m = makeModel([{ role: 'user', content: 'x' }]);
  assert.equal(reconcileHistory(m, [{ role: 'assistant', content: 'x' }]), true);
  assert.deepEqual(m.rows(), [{ role: 'assistant', content: 'x' }]);
});

test('an empty window leaves a populated model alone', () => {
  // The bridge answers {messages: []} for a session it cannot resolve yet (a
  // brand-new chat key, or a store it could not read). Treating that as "the
  // conversation is now empty" would blank the panel on a transient failure, so
  // an empty window is a no-op — the same instinct as the old shrink guard.
  const m = makeModel(msgs(3));
  assert.equal(reconcileHistory(m, []), false);
  assert.deepEqual(m.rows(), msgs(3));
});

test('the longest overlap wins when content repeats', () => {
  // Three identical "ok" rows: aligning at the first of them (longest overlap)
  // appends one row; aligning later would duplicate.
  const rep = c => ({ role: 'user', content: c });
  const m = makeModel([rep('ok'), rep('ok'), rep('ok')]);
  assert.equal(reconcileHistory(m, [rep('ok'), rep('ok'), rep('ok'), rep('new')]), true);
  assert.equal(m.count, 4);
  assert.deepEqual(m.rows()[3], rep('new'));
});

test('a full window on a full model is bounded work', () => {
  // Worst case for the alignment search: no offset matches, 200x200.
  const m = makeModel(msgs(200));
  const t = Date.now();
  assert.equal(reconcileHistory(m, msgs(200, 1000)), true);
  assert.ok(Date.now() - t < 500, 'reconcile should be well under a poll interval');
  assert.deepEqual(m.rows(), msgs(200, 1000));
});
