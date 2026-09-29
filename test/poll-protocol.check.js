#!/usr/bin/env node
/*
 * Manual integration check for the conditional history poll. NOT part of
 * `make check` — it needs a running bridge with a real session store, which CI
 * cannot have.
 *
 *   node test/poll-protocol.check.js http://127.0.0.1:8787 agent:main:ai-flyout
 *
 * It mimics what shell.qml's refreshTimer does for ten ticks and reports what
 * each tick actually cost, which is the number this whole change is about.
 */
'use strict';

const base = process.argv[2] || 'http://127.0.0.1:8787';
const key = process.argv[3] || 'agent:main:ai-flyout';
const LIMIT = 200;
const TICKS = 10;

async function timed(url) {
  const t = Date.now();
  const r = await fetch(url);
  const body = await r.text();
  return { ms: Date.now() - t, bytes: Buffer.byteLength(body), json: JSON.parse(body) };
}

(async () => {
  let version = null;
  let bytes = 0;
  let ms = 0;
  let bodies = 0;

  for (let i = 1; i <= TICKS; i++) {
    let line;
    if (version === null) {
      const r = await timed(`${base}/history?session=${encodeURIComponent(key)}&limit=${LIMIT}`);
      version = r.json.version;
      bytes += r.bytes; ms += r.ms; bodies++;
      line = `body   ${r.bytes} B  ${r.ms} ms  (${r.json.messages.length} msgs, v${version})`;
    } else {
      const v = await timed(`${base}/history/version?session=${encodeURIComponent(key)}`);
      bytes += v.bytes; ms += v.ms;
      if (v.json.version === version) {
        line = `probe  ${v.bytes} B  ${v.ms} ms  (v${v.json.version} unchanged, no body)`;
      } else {
        const r = await timed(`${base}/history?session=${encodeURIComponent(key)}&limit=${LIMIT}`);
        version = r.json.version;
        bytes += r.bytes; ms += r.ms; bodies++;
        line = `probe+body  ${v.bytes + r.bytes} B  ${v.ms + r.ms} ms  (v${version})`;
      }
    }
    console.log(`tick ${String(i).padStart(2)}  ${line}`);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n${TICKS} ticks: ${(bytes / 1024).toFixed(1)} KB, ${ms} ms total, ${bodies} body fetch(es)`);
  console.log(`unbounded equivalent: ${TICKS} x full /history`);
  const full = await timed(`${base}/history?session=${encodeURIComponent(key)}&limit=0`);
  console.log(`  one full body = ${(full.bytes / 1048576).toFixed(2)} MB, ${full.ms} ms` +
    `  ->  ${TICKS} ticks would be ${((full.bytes * TICKS) / 1048576).toFixed(1)} MB, ${full.ms * TICKS} ms`);
})();
