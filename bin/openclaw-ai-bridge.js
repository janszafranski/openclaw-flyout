#!/usr/bin/env node
/*
 * openclaw-ai-bridge — loopback data layer for the OpenClaw flyout panel.
 *
 * A tiny OpenAI-compatible HTTP service on 127.0.0.1 that lets the Quickshell
 * side panel (and any generic OpenAI client) talk to a local OpenClaw agent.
 *
 * Endpoints (127.0.0.1):
 *   POST /v1/chat/completions  OpenAI-compatible. Streams the agent's reply as
 *                              SSE deltas. Body may include "session": "<key>"
 *                              to target a session (default OPENCLAW_BRIDGE_SESSION).
 *   GET  /sessions             Recent real chats, newest first (for the drawer).
 *   GET  /history?session=<k>[&limit=N]
 *                              Normalized, already-cleaned transcript for one
 *                              session — the NEWEST N messages (default 200,
 *                              `limit=0`/`all` for the whole thing). Also
 *                              returns `version`, the session's max transcript
 *                              seq, paired with the messages it returned.
 *   GET  /history/version?session=<k>
 *                              Just `{session, version}` — one indexed query,
 *                              no body. Poll this and fetch /history only when
 *                              the number moves.
 *   GET  /v1/models            OpenAI model list (single synthetic model).
 *
 * Streaming: token-by-token via the supported ACP bridge (`openclaw acp`), with
 * an automatic fallback to the one-shot `openclaw agent` path if ACP yields nothing.
 *
 * Loopback-only by design: anything local that can POST here can run agent turns.
 */
'use strict';

const http = require('http');
// execFile only, never execFileSync: this process also carries in-flight SSE
// streams, and a synchronous transcript read blocks the event loop (and so the
// stream) for as long as it takes.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.OPENCLAW_BRIDGE_PORT || '8787', 10);

// Loopback-only guard. This bridge runs unauthenticated agent turns with tool
// permissions auto-approved, so the only thing between a web page and shell
// access on this machine is that a browser must not be able to reach it.
// `Access-Control-Allow-Origin: *` used to hand that away: a POST to
// /v1/chat/completions with the default `text/plain` content type is a CORS
// *simple* request, so no preflight is sent, any page you visited could start a
// turn, and ACAO let it read the streamed reply back. Two rules close it, and
// no CORS header is sent anywhere any more:
//   - a request carrying `Origin` is browser-initiated -> refuse it;
//   - `Host` must name this loopback listener -> blocks DNS rebinding, where a
//     hostile name resolves to 127.0.0.1 for clients CORS never covered.
// The real client is curl/XMLHttpRequest from the QML panel: no `Origin`, and a
// literal `127.0.0.1:<port>` Host. It is unaffected. A browser client would
// need a shared bearer token (OPENCLAW_BRIDGE_TOKEN), not CORS.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const DEFAULT_SESSION = process.env.OPENCLAW_BRIDGE_SESSION || 'agent:main:ai-flyout';
const AGENT_TIMEOUT = process.env.OPENCLAW_BRIDGE_TIMEOUT || '600';
const MODEL_ID = 'openclaw';

// Retry a turn that failed for a transient reason (gateway restart / OOM kill /
// provider failover mid-turn). The gateway auto-clears the session after such a
// failure, so a fresh retry almost always succeeds.
// Retries default high + a moderate delay because the #1 transient here is a
// TURN-CLAIM COLLISION: the flyout shares its gateway session with the main
// agent, so while the main agent is mid-turn the gateway rejects a flyout turn
// with "already has an active turn claim". That is NOT a failure — the claim
// frees the instant the main turn ends — so we must WAIT IT OUT and retry,
// not surface "(no reply)". 8 retries x 2s ≈ 16s of patience covers a normal
// turn; a very long main turn just needs a resend.
const AGENT_RETRIES = parseInt(process.env.OPENCLAW_BRIDGE_RETRIES || '8', 10);
const RETRY_DELAY_MS = parseInt(process.env.OPENCLAW_BRIDGE_RETRY_DELAY_MS || '2000', 10);
const TRANSIENT_RE = /FailoverError|Claude CLI failed|gateway (restart|shutdown|restarting)|UNAVAILABLE|ECONNREFUSED|ECONNRESET|socket hang up|EPIPE|active run|active turn claim|turn claim|already has an active|Command failed|exited before reply|non-?zero exit|timed? ?out/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const firstLine = e => String((e && e.message) || e || '').split('\n')[0];

// Token-by-token streaming via `openclaw acp`, unless disabled (falls back to one-shot).
const STREAM_ENABLED = (process.env.OPENCLAW_BRIDGE_STREAM || '1') !== '0';
// Auto-approve tool-permission prompts during a turn, matching the one-shot
// `openclaw agent` path (the flyout session is already tool-capable and loopback-only).
const ACP_AUTO_APPROVE = (process.env.OPENCLAW_BRIDGE_ACP_APPROVE || '1') !== '0';
const ACP_WORKSPACE =
  process.env.OPENCLAW_BRIDGE_CWD || `${process.env.HOME || '/root'}/.openclaw/workspace`;

// Session transcripts live in a single SQLite store (OpenClaw 2026.8.x+).
// `openclaw sessions list --json` emits a `sessionId`; read transcript rows by it.
const SESSION_DB =
  process.env.OPENCLAW_BRIDGE_SESSION_DB ||
  `${process.env.HOME || '/root'}/.openclaw/agents/main/agent/openclaw-agent.sqlite`;

// Per-user config the repo must never contain. See loadTitleFlags() below and
// config/title-flags.json.example for the one file that lives here.
const CONFIG_DIR =
  process.env.OPENCLAW_FLYOUT_CONFIG_DIR ||
  `${process.env.XDG_CONFIG_HOME || `${process.env.HOME || '/root'}/.config`}/openclaw-flyout`;

// ---- OpenClaw gateway auto-start -------------------------------------------
// If a turn arrives while the gateway is down, start it (systemd --user unit
// first, then `openclaw gateway start`) and wait for its port. So the flyout can
// bring OpenClaw up on its own. Disable with OPENCLAW_BRIDGE_AUTOSTART_GATEWAY=0.
const GATEWAY_HOST = process.env.OPENCLAW_GATEWAY_HOST || '127.0.0.1';
const GATEWAY_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10);
const GATEWAY_WAIT_MS = parseInt(process.env.OPENCLAW_BRIDGE_GATEWAY_WAIT || '30000', 10);
const AUTOSTART_GATEWAY = (process.env.OPENCLAW_BRIDGE_AUTOSTART_GATEWAY || '1') !== '0';
let gatewayStarting = null; // de-dupes concurrent starts

function portOpen(host, port, timeoutMs = 800) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let settled = false;
    const done = v => { if (!settled) { settled = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

function startGateway() {
  return new Promise(res => {
    execFile('systemctl', ['--user', 'start', 'openclaw-gateway.service'], { timeout: 30000 }, err => {
      if (err) execFile('openclaw', ['gateway', 'start'], { timeout: 30000 }, () => res());
      else res();
    });
  }).then(async () => {
    const deadline = Date.now() + GATEWAY_WAIT_MS;
    while (Date.now() < deadline) {
      if (await portOpen(GATEWAY_HOST, GATEWAY_PORT)) { console.log('[bridge] gateway is up'); return true; }
      await sleep(700);
    }
    console.log('[bridge] gateway did not come up within ' + GATEWAY_WAIT_MS + 'ms');
    return false;
  });
}

// Ensure the gateway is up before a turn. onStarting() fires once if we boot it
// (so the flyout can show a status line). Resolves true when reachable.
async function ensureGatewayUp(onStarting) {
  if (await portOpen(GATEWAY_HOST, GATEWAY_PORT)) return true;
  if (onStarting) { try { onStarting(); } catch (_) {} }
  console.log('[bridge] gateway down — starting it');
  if (!gatewayStarting) gatewayStarting = startGateway().finally(() => { gatewayStarting = null; });
  return gatewayStarting;
}

// ---- transcript cleaning (single source of truth) --------------------------
// The CLI prepends a "[Working directory: …]" banner to user turns, and the
// harness injects pure-machinery rows ("reply with exact …", NO_REPLY, etc.).
// Clean both HERE so /history returns display-ready text and the QML client can
// stay a thin append — there's no second filter to keep in sync.

// Strip the leading working-directory banner but KEEP the user's real text.
function cleanContent(s) {
  return String(s || '').replace(/^\s*\[Working directory:[^\]]*\]\s*/, '');
}

// True if a (cleaned) message is pure harness machinery with nothing to show.
function isPureMachinery(s) {
  const t = String(s || '').trim();
  if (!t.length) return true;
  if (/^reply with (only|exact)/i.test(t)) return true;
  if (/^Output only the token/i.test(t)) return true;
  if (t === 'NO_REPLY' || t === 'no_reply') return true;
  return false;
}

// ---- turn execution --------------------------------------------------------

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map(p => (typeof p === 'string' ? p : p.text || '')).join('');
      }
    }
  }
  return '';
}

// One-shot turn via `openclaw agent --json`.
function runAgent(message, sessionKey) {
  return new Promise((resolve, reject) => {
    execFile(
      'openclaw',
      ['agent', '--json', '--session-key', sessionKey, '--timeout', AGENT_TIMEOUT, '--message', message],
      { maxBuffer: 64 * 1024 * 1024, timeout: (parseInt(AGENT_TIMEOUT, 10) + 30) * 1000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        try {
          const d = JSON.parse(stdout);
          const text =
            d?.result?.meta?.finalAssistantVisibleText ||
            (Array.isArray(d?.result?.payloads)
              ? d.result.payloads.map(p => p.text || '').join('')
              : '') ||
            d?.summary ||
            '(no reply)';
          resolve(text);
        } catch (e) {
          reject(new Error('Could not parse openclaw output: ' + e.message + '\n' + stdout));
        }
      }
    );
  });
}

// One-shot turn with a retry on transient failures. The gateway clears the
// session after a failed reused turn, so the retry starts clean.
async function runAgentResilient(message, sessionKey) {
  let lastErr;
  for (let attempt = 0; attempt <= AGENT_RETRIES; attempt++) {
    try {
      return await runAgent(message, sessionKey);
    } catch (e) {
      lastErr = e;
      const transient = TRANSIENT_RE.test(e && e.message ? e.message : '');
      if (!transient || attempt === AGENT_RETRIES) break;
      console.log(
        `[bridge] transient turn failure (attempt ${attempt + 1}/${AGENT_RETRIES + 1}), retrying in ${RETRY_DELAY_MS}ms: ${firstLine(e)}`
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

// Stream a turn through the ACP bridge, invoking onEvent({kind,text}) per update:
//   kind 'content' — visible assistant text (counts toward the streamed total, so
//                    the one-shot fallback only fires on a genuinely empty turn).
//   kind 'status'  — transient tool/thinking activity (shown live, never persisted).
// Resolves with the number of content chars streamed; rejects on spawn/protocol
// failure so the caller can fall back to one-shot.
function runAgentStreaming(message, sessionKey, onEvent) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch (_) {}
      try { child.kill(); } catch (_) {}
      fn(arg);
    };

    const child = spawn('openclaw', ['acp', '--session', sessionKey], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.on('error', e => finish(reject, new Error('acp spawn failed: ' + e.message)));

    const timer = setTimeout(
      () => finish(reject, new Error('acp turn timeout')),
      (parseInt(AGENT_TIMEOUT, 10) + 30) * 1000
    );

    let streamed = 0;
    let nextId = 1;
    const pending = new Map();
    const send = obj => {
      try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch (_) {}
    };
    const rpc = (method, params) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        send({ jsonrpc: '2.0', id, method, params });
      });

    let buf = '';
    child.stdout.on('data', d => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch (_) { continue; }
        // response to one of our requests
        if (o.id != null && pending.has(o.id)) {
          const p = pending.get(o.id);
          pending.delete(o.id);
          if (o.error) p.rej(new Error(JSON.stringify(o.error)));
          else p.res(o.result);
          continue;
        }
        // streaming notification
        if (o.method === 'session/update' && o.params && o.params.update) {
          const u = o.params.update;
          const su = u.sessionUpdate;
          const emit = ev => { try { onEvent(ev); } catch (_) {} };
          if (su === 'agent_message_chunk' && u.content && typeof u.content.text === 'string') {
            streamed += u.content.text.length;
            emit({ kind: 'content', text: u.content.text });
          } else if (su === 'agent_thought_chunk' && u.content && typeof u.content.text === 'string') {
            const t = u.content.text.replace(/\s+/g, ' ').trim();
            if (t) emit({ kind: 'status', text: '\u{1F4AD} ' + t.slice(0, 160) });
          } else if (su === 'tool_call') {
            const label = (u.title || u.kind || u.toolCallId || 'tool')
              .toString().replace(/\s+/g, ' ').trim().slice(0, 120);
            emit({ kind: 'status', text: '\u{2699} ' + label });
          }
          // tool_call_update (completed/failed) intentionally not surfaced — the
          // next tool_call or the assistant text replaces the activity line.
          continue;
        }
        // server -> client request (e.g. permission prompt): keep the turn moving
        if (o.method && o.id != null) {
          if (o.method === 'session/request_permission') {
            const opts = (o.params && o.params.options) || [];
            let pick = null;
            if (ACP_AUTO_APPROVE) {
              pick =
                opts.find(x => /allow.*once|allow$|allow_once/i.test(x.optionId || '')) ||
                opts.find(x => (x.kind || '').includes('allow')) ||
                opts[0];
            }
            if (pick) send({ jsonrpc: '2.0', id: o.id, result: { outcome: { outcome: 'selected', optionId: pick.optionId } } });
            else send({ jsonrpc: '2.0', id: o.id, result: { outcome: { outcome: 'cancelled' } } });
          } else {
            send({ jsonrpc: '2.0', id: o.id, error: { code: -32601, message: 'not supported' } });
          }
          continue;
        }
      }
    });

    child.on('exit', () => {
      finish(streamed > 0 ? resolve : reject, streamed > 0 ? streamed : new Error('acp exited before reply'));
    });

    (async () => {
      try {
        await rpc('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        });
        const sess = await rpc('session/new', { cwd: ACP_WORKSPACE, mcpServers: [] });
        await rpc('session/prompt', {
          sessionId: sess.sessionId,
          prompt: [{ type: 'text', text: message }],
        });
        finish(resolve, streamed);
      } catch (e) {
        finish(streamed > 0 ? resolve : reject, streamed > 0 ? streamed : e);
      }
    })();
  });
}

// ---- session listing + transcript reading ----------------------------------

// `openclaw sessions list --json` is the ONLY way to map a session key to the
// sessionId the transcript table is keyed by — and it costs ~2.1 s, because it
// boots a whole CLI. Calling it per request is what made /history ~2.3 s and
// /sessions ~2.6 s, and the panel polls /history every 3 s.
//
// It is cached STALE-WHILE-REVALIDATE rather than with a plain TTL: a plain TTL
// would still hand one poll tick in every TTL the full 2.1 s bill, which is not
// "near zero", it is "near zero on average". So a caller gets whatever is
// cached, immediately, and a stale cache schedules a refresh in the background
// for the next caller. The only request that ever waits is the first one after
// startup, when there is nothing to serve.
const SESSION_INDEX_TTL_MS = parseInt(process.env.OPENCLAW_BRIDGE_INDEX_TTL_MS || '30000', 10);
// A key the cache has never seen (a chat that was just created) must not be
// invisible until the background refresh lands, so a lookup miss DOES wait for
// one — but no more often than this, or an unknown key costs a spawn per poll.
const SESSION_INDEX_MISS_MS = parseInt(process.env.OPENCLAW_BRIDGE_INDEX_MISS_MS || '3000', 10);

let indexCache = [];      // last successful `sessions list` result
let indexCachedAt = 0;    // 0 = nothing cached yet
let indexInflight = null; // de-dupes concurrent refreshes onto one spawn
let indexLastMiss = 0;

function fetchSessionIndex() {
  return new Promise(resolve => {
    execFile(
      'openclaw',
      ['sessions', 'list', '--json', '--limit', '200'],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const d = JSON.parse(stdout);
          resolve(Array.isArray(d.sessions) ? d.sessions : null);
        } catch (e) {
          resolve(null);
        }
      }
    );
  });
}

// Start (or join) a refresh. A failed one keeps serving the previous answer
// rather than blanking the drawer, and doesn't move `indexCachedAt`, so the next
// caller retries.
function refreshSessionIndex() {
  if (!indexInflight) {
    indexInflight = fetchSessionIndex()
      .then(list => {
        if (list) {
          indexCache = list;
          indexCachedAt = Date.now();
        }
        return indexCache;
      })
      .finally(() => {
        indexInflight = null;
      });
  }
  return indexInflight;
}

// The sessions array. Never waits on the CLI once anything is cached; a stale
// cache is served now and refreshed behind the caller's back.
function sessionIndex(maxAgeMs = SESSION_INDEX_TTL_MS) {
  if (indexCachedAt && Date.now() - indexCachedAt <= maxAgeMs) return Promise.resolve(indexCache);
  const refreshing = refreshSessionIndex();
  return indexCachedAt ? Promise.resolve(indexCache) : refreshing;
}

// Look up one session by key. Unlike sessionIndex() this DOES wait for a
// refresh when the key is absent, so a chat created seconds ago resolves now
// instead of after the next background refresh — rate-limited, because an
// always-absent key would otherwise re-spawn the CLI on every poll.
async function sessionByKey(key) {
  let s = (await sessionIndex()).find(x => x.key === key);
  if (!s && Date.now() - indexLastMiss >= SESSION_INDEX_MISS_MS) {
    indexLastMiss = Date.now();
    s = (await refreshSessionIndex()).find(x => x.key === key);
  }
  return s || null;
}

// Run one `sqlite3 -readonly` query, off the event loop. -readonly so a
// concurrent gateway write never blocks/corrupts the read. Returns '' on any
// failure — a transcript we can't read is an empty transcript, not a 500.
function sqliteQuery(sql) {
  return new Promise(resolve => {
    execFile(
      'sqlite3',
      ['-readonly', SESSION_DB, sql],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(err ? '' : stdout)
    );
  });
}

// sessionId comes from OpenClaw's own output, but quote it properly regardless.
const sqlStr = s => `'${String(s).replace(/'/g, "''")}'`;

// Fetch raw newline-joined event_json rows for one sessionId, oldest-first.
// `rows > 0` reads only the NEWEST `rows` of them (`ORDER BY seq DESC LIMIT`,
// re-sorted ascending) — the transcript table is keyed (session_id, seq), so
// that's an index range scan, not a table scan. `head` reads the OLDEST `rows`
// instead, which is all a title needs.
// Resolves {version, raw}: `version` is the session's max seq, read in the same
// sqlite3 invocation so it can never disagree with the rows returned.
// sqlite3 emits one line per row (JSON escapes any newline inside the value),
// so the leading line is unambiguously the version.
async function transcriptRead(sessionId, { rows = 0, head = false } = {}) {
  if (!sessionId) return { version: -1, raw: '' };
  const id = sqlStr(sessionId);
  const select =
    rows > 0 && !head
      ? `SELECT event_json FROM (SELECT seq, event_json FROM transcript_events WHERE session_id=${id} ORDER BY seq DESC LIMIT ${rows}) ORDER BY seq;`
      : `SELECT event_json FROM transcript_events WHERE session_id=${id} ORDER BY seq${rows > 0 ? ` LIMIT ${rows}` : ''};`;
  const out = await sqliteQuery(
    `SELECT COALESCE(MAX(seq), -1) FROM transcript_events WHERE session_id=${id};\n${select}`
  );
  const nl = out.indexOf('\n');
  if (nl < 0) return { version: -1, raw: '' };
  const version = parseInt(out.slice(0, nl), 10);
  return { version: Number.isFinite(version) ? version : -1, raw: out.slice(nl + 1) };
}

// The session's max transcript seq, or -1. One indexed query, no body — this is
// what makes the panel's poll conditional.
async function transcriptVersion(sessionId) {
  if (!sessionId) return -1;
  const out = await sqliteQuery(
    `SELECT COALESCE(MAX(seq), -1) FROM transcript_events WHERE session_id=${sqlStr(sessionId)};`
  );
  const v = parseInt(String(out).trim(), 10);
  return Number.isFinite(v) ? v : -1;
}

// Parse a transcript (raw newline-delimited event JSON) into display-ready
// [{role, content}] (user/assistant only), banner stripped + machinery dropped.
function parseTranscript(raw) {
  const out = [];
  if (!raw) return out;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch (e) {
      continue;
    }
    if (o.type !== 'message' || !o.message) continue;
    const m = o.message;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    let text = '';
    const c = m.content;
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
    text = cleanContent(text).trim();
    if (isPureMachinery(text)) continue;
    out.push({ role: m.role, content: text });
  }
  return out;
}

// ---- drawer title flags ----------------------------------------------------
// A drawer title can carry a prefix when one topic *dominates* a transcript, so
// the chat about that topic is findable at a glance. The tokens that identify
// the topic are personal — a matter reference, a firm, a person's name — so they
// live in a file this repo never ships and git never sees:
//
//   ~/.config/openclaw-flyout/title-flags.json       (OPENCLAW_FLYOUT_CONFIG_DIR
//                                                     or XDG_CONFIG_HOME to move it)
//   { "flags": [ { "prefix": "⚖", "threshold": 100, "tokens": ["…", "…"] } ] }
//
// The shipped default is no flags at all; see config/title-flags.json.example.
// Tokens are matched literally and case-insensitively, NOT as regexes, so
// nothing needs escaping and a stray `(` in your config cannot kill the bridge.
// `threshold` is how many matches the whole transcript must contain before the
// prefix applies (default 1) — the point being that one passing mention in an
// unrelated chat must not brand that whole session. For scale: on a real store,
// transcripts genuinely *about* a topic scored 300-1100+ hits while incidental
// mentions stayed under ~170, so a threshold around 100 separates them.
const TITLE_FLAGS_FILE = `${CONFIG_DIR}/title-flags.json`;

const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Parse title-flags.json into [{prefix, threshold, re}]. Never throws: bad
// config degrades to fewer flags, because an unreadable preference is not a
// reason to take the panel's data layer down.
function loadTitleFlags() {
  let text = null;
  try {
    text = fs.readFileSync(TITLE_FLAGS_FILE, 'utf8');
  } catch (e) {
    // Absent is the shipped default, not a problem worth a warning.
    if (e.code !== 'ENOENT') console.error('[bridge] title-flags unreadable:', firstLine(e));
  }
  let parsed = null;
  if (text !== null) {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('[bridge] title-flags is not valid JSON, ignoring it:', firstLine(e));
    }
  }
  const entries = Array.isArray(parsed && parsed.flags) ? parsed.flags : [];
  const flags = [];
  entries.forEach((f, i) => {
    const tokens = Array.isArray(f && f.tokens)
      ? f.tokens.filter(t => typeof t === 'string' && t.trim() !== '')
      : [];
    let prefix = f && typeof f.prefix === 'string' ? f.prefix : '';
    if (!tokens.length || !prefix) {
      console.error(`[bridge] title-flags[${i}] needs a prefix and at least one token — skipped`);
      return;
    }
    // "⚖" and "⚖ Matter — " should both read correctly once prepended.
    if (!/\s$/.test(prefix)) prefix += ' ';
    const threshold =
      typeof f.threshold === 'number' && f.threshold >= 1 ? Math.floor(f.threshold) : 1;
    flags.push({ prefix, threshold, re: new RegExp(tokens.map(reEscape).join('|'), 'gi') });
  });
  // Count only. Logging the tokens would put them back in journald, which is
  // the same mistake as having them in the source.
  console.log(
    flags.length
      ? `[bridge] title flags: ${flags.length} loaded from ${TITLE_FLAGS_FILE}`
      : `[bridge] title flags: none (${TITLE_FLAGS_FILE})`
  );
  return flags;
}

// Read once at startup; restart the bridge to pick up an edit.
const TITLE_FLAGS = loadTitleFlags();

// A title comes from the FIRST human message, so with no flags configured there
// is no reason to read past the first handful of rows — the old full-transcript
// read was 4.3 MB per session per /sessions call, done synchronously. A flag,
// though, is a whole-transcript property (it asks whether a topic *dominates*),
// so a configured flag still costs one full read — but only on a cache miss.
const TITLE_HEAD_ROWS = parseInt(process.env.OPENCLAW_BRIDGE_TITLE_HEAD_ROWS || '40', 10);

// sessionId -> {updatedAt, title}. A transcript is append-only, and `updatedAt`
// moves whenever it grows, so a hit is exact rather than merely fresh.
const titleCache = new Map();
const TITLE_CACHE_MAX = 500;

// Derive a drawer title from the first genuinely human user message, prefixed by
// the first configured flag whose tokens dominate the transcript.
async function titleFor(sessionId, updatedAt) {
  if (!sessionId) return null;
  const hit = titleCache.get(sessionId);
  if (hit && hit.updatedAt === updatedAt) return hit.title;

  // No flags: the oldest few rows are all a title needs. Flags: the count is
  // over the whole transcript, so read it all (once, then cached).
  const { raw } = TITLE_FLAGS.length
    ? await transcriptRead(sessionId)
    : await transcriptRead(sessionId, { rows: TITLE_HEAD_ROWS, head: true });
  const firstUser = parseTranscript(raw).find(m => m.role === 'user');
  let title = null;
  if (firstUser) {
    title = firstUser.content.replace(/\s+/g, ' ').slice(0, 60);
    const flag = TITLE_FLAGS.find(f => (raw.match(f.re) || []).length >= f.threshold);
    if (flag) title = flag.prefix + title;
  }
  // A null title on a HEAD read can mean "no human message in the first N rows"
  // rather than "no human message at all" — cache it anyway: /sessions treats
  // null as "not a real chat", and a session whose first 40 rows are all
  // machinery is exactly the throwaway probe that filter is there to drop.
  if (titleCache.size >= TITLE_CACHE_MAX) titleCache.clear();
  titleCache.set(sessionId, { updatedAt, title });
  return title;
}

// Resolve up to `width` promises at a time. /sessions maps over every chat
// session, and each one is a process spawn; unbounded Promise.all would fork
// the whole drawer at once.
async function mapPool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return out;
}

// Which session keys are real, user-facing chats worth listing in the drawer.
// Internal/derived sessions (cron jobs + their runs, throwaway probe/test keys)
// are noise that "does nothing" when clicked.
function isChatSession(key) {
  if (!key) return false;
  if (/:cron:|:run:|:hook:|:node:|:subagent:/.test(key)) return false;
  const name = key.replace(/^agent:[^:]+:/, '');
  if (/test|diag|probe|selftest|healthprobe|flytest|\bempty\b/i.test(name)) return false;
  if (/^flyout-\d/i.test(name)) return false;
  return true;
}

// ---- HTTP helpers ----------------------------------------------------------

// How many messages /history returns when the caller doesn't say. 200 is a few
// hundred KB at most and far more than the panel can show at once; the whole
// transcript (2601 messages / 3.45 MB on a real store) is for an archive tool,
// not a 3-second poll.
const HISTORY_LIMIT_DEFAULT = parseInt(process.env.OPENCLAW_BRIDGE_HISTORY_LIMIT || '200', 10);
const HISTORY_LIMIT_MAX = 5000;
// Raw transcript rows read per message asked for. Non-message and machinery
// rows are dropped after the read, so we need slack; on a real store ~99.9% of
// rows survive, making 3x generous.
const HISTORY_ROW_OVERFETCH = 3;
// /sessions is opened by hand, so it asks for a much fresher index than the
// poll does — but still never waits for one (see sessionIndex): a drawer that
// opens instantly and is a few seconds behind beats one that stalls 2 s every
// time. `?fresh=1` waits, for a caller that would rather be certain.
const SESSIONS_INDEX_MAX_AGE_MS = 5000;
// Concurrent titleFor() reads (each is a sqlite3 spawn).
const TITLE_POOL = 4;

// ?limit=: a positive count, or 0/"all" for the whole transcript.
function parseLimit(raw) {
  if (raw === null || raw === undefined || raw === '') return HISTORY_LIMIT_DEFAULT;
  if (/^all$/i.test(raw)) return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return HISTORY_LIMIT_DEFAULT;
  return Math.min(n, HISTORY_LIMIT_MAX);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

// Reason string when a request must be refused (see ALLOWED_HOSTS), else null.
function loopbackViolation(req) {
  if (req.headers.origin) return 'cross-origin denied';
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return 'bad host';
  return null;
}

// Header values are attacker-controlled; keep them out of the log verbatim.
function logSafe(v) {
  return String(v || '-').replace(/[^\x20-\x7e]/g, '?').slice(0, 100);
}

function sseChunk(res, content) {
  res.write('data: ' + JSON.stringify({
    id: 'chatcmpl-openclaw',
    object: 'chat.completion.chunk',
    model: MODEL_ID,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }) + '\n\n');
}

// Transient tool/thinking activity in a non-standard `delta.status` field.
// Generic OpenAI clients ignore it harmlessly; the sidebar renders it live.
function sseStatus(res, status) {
  res.write('data: ' + JSON.stringify({
    id: 'chatcmpl-openclaw',
    object: 'chat.completion.chunk',
    model: MODEL_ID,
    choices: [{ index: 0, delta: { status }, finish_reason: null }],
  }) + '\n\n');
}

// ---- server ----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const denied = loopbackViolation(req);
  if (denied) {
    console.error(
      `[bridge] refused ${logSafe(req.method)} (${denied}; ` +
        `origin=${logSafe(req.headers.origin)} host=${logSafe(req.headers.host)})`
    );
    return sendJson(res, 403, { error: { message: denied } });
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && path.startsWith('/v1/models')) {
    return sendJson(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'openclaw' }] });
  }

  // --- recent-chats list ---
  if (req.method === 'GET' && path === '/sessions') {
    (async () => {
      const index = url.searchParams.get('fresh')
        ? await refreshSessionIndex()
        : await sessionIndex(SESSIONS_INDEX_MAX_AGE_MS);
      const sessions = index.filter(s => isChatSession(s.key));
      const list = (
        await mapPool(sessions, TITLE_POOL, async s => ({
          key: s.key,
          updatedAt: s.updatedAt || 0,
          sessionId: s.sessionId,
          title: await titleFor(s.sessionId, s.updatedAt || 0),
        }))
      )
        // A real chat has a human-authored title. title === null means the
        // session held only bootstrap/harness preamble — a throwaway probe;
        // drop it. The always-real default session is kept even if empty.
        .filter(s => s.title || s.key === DEFAULT_SESSION)
        .map(s => ({ ...s, title: s.title || s.key }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      sendJson(res, 200, { sessions: list });
    })().catch(e => sendJson(res, 500, { error: { message: firstLine(e) } }));
    return;
  }

  // --- cheap change check: max transcript seq, no body ---
  // The panel polls this every few seconds and only fetches /history when the
  // number moves, which is what takes the at-rest poll cost to ~nothing.
  if (req.method === 'GET' && path === '/history/version') {
    const key = url.searchParams.get('session') || DEFAULT_SESSION;
    (async () => {
      const s = await sessionByKey(key);
      // An unknown key is a chat with no transcript yet, not an error: -1 is a
      // real version that a later first turn will move off.
      sendJson(res, 200, { session: key, version: s ? await transcriptVersion(s.sessionId) : -1 });
    })().catch(e => sendJson(res, 500, { error: { message: firstLine(e) } }));
    return;
  }

  // --- transcript for one session ---
  // ?limit=N returns the NEWEST N messages (default HISTORY_LIMIT_DEFAULT);
  // limit=0 returns everything. Unbounded was the default, which meant a 3.45 MB
  // body every 3 s on a long-lived chat.
  if (req.method === 'GET' && path === '/history') {
    const key = url.searchParams.get('session') || DEFAULT_SESSION;
    const limit = parseLimit(url.searchParams.get('limit'));
    (async () => {
      const s = await sessionByKey(key);
      if (!s) return sendJson(res, 200, { session: key, version: -1, limit, messages: [] });
      // parseTranscript drops non-message and pure-machinery rows, so reading
      // exactly `limit` rows could return fewer than `limit` messages. Overfetch
      // rows, then trim to the newest `limit` messages.
      const { version, raw } = await transcriptRead(s.sessionId, {
        rows: limit ? limit * HISTORY_ROW_OVERFETCH : 0,
      });
      const msgs = parseTranscript(raw);
      sendJson(res, 200, {
        session: key,
        version,
        limit,
        messages: limit && msgs.length > limit ? msgs.slice(-limit) : msgs,
      });
    })().catch(e => sendJson(res, 500, { error: { message: firstLine(e) } }));
    return;
  }

  // --- chat turn ---
  if (req.method === 'POST' && path.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 16 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      let msg = '';
      let sessionKey = DEFAULT_SESSION;
      try {
        const parsed = JSON.parse(body);
        msg = lastUserMessage(parsed.messages);
        if (parsed.session && typeof parsed.session === 'string') sessionKey = parsed.session;
        // Continuity pin: the client mints a throwaway `agent:main:flyout-<ts>`
        // session on (re)launch, which would orphan the running conversation onto
        // a fresh key with no history. Coerce those ephemeral keys back to the
        // stable default so the flyout is one continuous brain. Deliberate drawer
        // switches to *named* sessions are still honoured.
        if (/^agent:main:flyout-\d+$/.test(sessionKey)) {
          if (sessionKey !== DEFAULT_SESSION)
            console.error(`[bridge] pinned ephemeral ${sessionKey} -> ${DEFAULT_SESSION}`);
          sessionKey = DEFAULT_SESSION;
        }
      } catch (_) {
        /* fall through */
      }
      if (!msg) return sendJson(res, 400, { error: { message: 'No user message' } });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let streamedAny = false;
      // bring OpenClaw up before attempting a turn, if needed
      if (AUTOSTART_GATEWAY) {
        const up = await ensureGatewayUp(() => sseStatus(res, '⚙ starting OpenClaw…'));
        if (!up) {
          sseChunk(res, "**Bridge**: the OpenClaw gateway isn't running and could not be started automatically. Start it with `systemctl --user start openclaw-gateway` and try again.");
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      }
      try {
        if (STREAM_ENABLED) {
          const n = await runAgentStreaming(msg, sessionKey, ev => {
            if (ev.kind === 'content') {
              streamedAny = true;
              sseChunk(res, ev.text);
            } else {
              sseStatus(res, ev.text);
            }
          });
          if (!n) throw new Error('acp produced no output'); // fall back to one-shot
        } else {
          throw new Error('streaming disabled'); // jump straight to one-shot
        }
      } catch (streamErr) {
        if (streamedAny) {
          // Partial stream then failure — can't safely restart without duplicating
          // text. End the turn; the reply so far is already delivered.
          console.error('[bridge] stream failed after partial output:', firstLine(streamErr));
          if (TRANSIENT_RE.test(streamErr && streamErr.message ? streamErr.message : ''))
            sseChunk(res, '\n\n_(connection interrupted — reply may be incomplete)_');
        } else {
          // Nothing streamed yet: fall back to the one-shot path (with retry).
          console.error('[bridge] streaming path yielded nothing, falling back to one-shot:', firstLine(streamErr));
          try {
            const reply = await runAgentResilient(msg, sessionKey);
            const parts = reply.match(/\S+\s*/g) || [reply];
            for (const p of parts) sseChunk(res, p);
          } catch (e) {
            console.error('[bridge] one-shot turn failed:', firstLine(e));
            const emsg = e && e.message ? e.message : '';
            const claim = /turn claim|active run|already has an active/i.test(emsg);
            const transient = TRANSIENT_RE.test(emsg);
            sseChunk(res, claim
              ? '**Bridge**: the main agent is still finishing its previous turn, so this message could not start yet. Please send it again in a moment.'
              : transient
                ? '**Bridge**: the gateway was busy or restarting and the turn was interrupted — try again in a moment.'
                : '**Bridge error**: ' + e.message);
          }
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }

  sendJson(res, 404, { error: { message: 'Not found' } });
});

server.listen(PORT, HOST, () => {
  console.log(
    `openclaw-ai-bridge listening on http://${HOST}:${PORT} ` +
      `(chat -> default session ${DEFAULT_SESSION}; +/sessions +/history)`
  );
});
