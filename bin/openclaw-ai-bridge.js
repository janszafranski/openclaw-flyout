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
 *   GET  /history?session=<k>  Normalized, already-cleaned transcript for one session.
 *   GET  /v1/models            OpenAI model list (single synthetic model).
 *
 * Streaming: token-by-token via the supported ACP bridge (`openclaw acp`), with
 * an automatic fallback to the one-shot `openclaw agent` path if ACP yields nothing.
 *
 * Loopback-only by design: anything local that can POST here can run agent turns.
 */
'use strict';

const http = require('http');
const { execFile, execFileSync, spawn } = require('child_process');
const net = require('net');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.OPENCLAW_BRIDGE_PORT || '8787', 10);
const DEFAULT_SESSION = process.env.OPENCLAW_BRIDGE_SESSION || 'agent:main:ai-flyout';
const AGENT_TIMEOUT = process.env.OPENCLAW_BRIDGE_TIMEOUT || '600';
const MODEL_ID = 'openclaw';

// Retry a turn that failed for a transient reason (gateway restart / OOM kill /
// provider failover mid-turn). The gateway auto-clears the session after such a
// failure, so a fresh retry almost always succeeds.
const AGENT_RETRIES = parseInt(process.env.OPENCLAW_BRIDGE_RETRIES || '1', 10);
const RETRY_DELAY_MS = parseInt(process.env.OPENCLAW_BRIDGE_RETRY_DELAY_MS || '1500', 10);
const TRANSIENT_RE = /FailoverError|Claude CLI failed|gateway (restart|shutdown|restarting)|UNAVAILABLE|ECONNREFUSED|ECONNRESET|socket hang up|EPIPE|active run|Command failed|exited before reply|non-?zero exit|timed? ?out/i;

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

// Read `openclaw sessions list --json` once; returns the raw sessions array.
function sessionIndex() {
  return new Promise(resolve => {
    execFile(
      'openclaw',
      ['sessions', 'list', '--json', '--limit', '50'],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        try {
          const d = JSON.parse(stdout);
          resolve(Array.isArray(d.sessions) ? d.sessions : []);
        } catch (e) {
          resolve([]);
        }
      }
    );
  });
}

// Fetch the raw newline-joined event_json rows for one sessionId, in order.
// -readonly so a concurrent gateway write never blocks/corrupts the read.
function transcriptRaw(sessionId) {
  if (!sessionId) return '';
  try {
    return execFileSync(
      'sqlite3',
      [
        '-readonly',
        SESSION_DB,
        `SELECT event_json FROM transcript_events WHERE session_id='${String(sessionId).replace(/'/g, "''")}' ORDER BY seq;`,
      ],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }
    );
  } catch (e) {
    return '';
  }
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

// Derive a drawer title from the first genuinely human user message.
function titleFor(sessionId) {
  const msgs = parseTranscript(transcriptRaw(sessionId));
  const firstUser = msgs.find(m => m.role === 'user');
  if (firstUser) return firstUser.content.replace(/\s+/g, ' ').slice(0, 60);
  return null;
}

// Which session keys are real, user-facing chats worth listing in the drawer.
// Internal/derived sessions (cron jobs + their runs, throwaway probe/test keys)
// are noise that "does nothing" when clicked.
function isChatSession(key) {
  if (!key) return false;
  if (/:cron:|:run:|:hook:|:node:/.test(key)) return false;
  const name = key.replace(/^agent:[^:]+:/, '');
  if (/test|diag|probe|selftest|healthprobe|flytest|\bempty\b/i.test(name)) return false;
  if (/^flyout-\d/i.test(name)) return false;
  return true;
}

// ---- HTTP helpers ----------------------------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
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
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && path.startsWith('/v1/models')) {
    return sendJson(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'openclaw' }] });
  }

  // --- recent-chats list ---
  if (req.method === 'GET' && path === '/sessions') {
    sessionIndex().then(sessions => {
      const list = sessions
        .filter(s => isChatSession(s.key))
        .map(s => ({
          key: s.key,
          updatedAt: s.updatedAt || 0,
          sessionId: s.sessionId,
          title: titleFor(s.sessionId),
        }))
        // A real chat has a human-authored title. title === null means the
        // session held only bootstrap/harness preamble — a throwaway probe;
        // drop it. The always-real default session is kept even if empty.
        .filter(s => s.title || s.key === DEFAULT_SESSION)
        .map(s => ({ ...s, title: s.title || s.key }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      sendJson(res, 200, { sessions: list });
    });
    return;
  }

  // --- transcript for one session ---
  if (req.method === 'GET' && path === '/history') {
    const key = url.searchParams.get('session') || DEFAULT_SESSION;
    sessionIndex().then(sessions => {
      const s = sessions.find(x => x.key === key);
      if (!s) return sendJson(res, 200, { session: key, messages: [] });
      sendJson(res, 200, { session: key, messages: parseTranscript(transcriptRaw(s.sessionId)) });
    });
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
        'Access-Control-Allow-Origin': '*',
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
            const transient = TRANSIENT_RE.test(e && e.message ? e.message : '');
            sseChunk(res, transient
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
