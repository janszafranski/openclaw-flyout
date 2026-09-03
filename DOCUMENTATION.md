# OpenClaw flyout — architecture & design notes

This is the "why", not just the "what". The flyout is small but several parts are
counter-intuitive because they work around real behaviour of the OpenClaw gateway,
the SQLite session store, and Quickshell's layer-shell. Those notes are recorded
here so they survive.

---

## 1. Shape

Two processes, one clean HTTP contract between them:

```
┌─────────────────────────┐        HTTP (127.0.0.1:8787)        ┌──────────────────────┐
│  Quickshell panel        │  ── GET  /history?session=…  ────▶ │  openclaw-ai-bridge  │
│  (shell.qml)             │  ── GET  /sessions           ────▶ │  (Node)              │
│  view + input + IPC      │  ── POST /v1/chat/completions ───▶ │  data + turn exec    │
└─────────────────────────┘  ◀──  SSE stream  ────────────────  └──────────┬───────────┘
                                                                            │
                                              openclaw acp / openclaw agent │  sqlite3 -readonly
                                              openclaw sessions list --json │
                                                                            ▼
                                                              OpenClaw gateway + session DB
```

- **The bridge is the only thing that knows about OpenClaw.** It shells out to the
  `openclaw` CLI for turns and session listing, and reads the transcript store
  directly. The panel knows *nothing* about OpenClaw internals — only the three
  endpoints. That boundary is deliberate: the panel is replaceable (any
  OpenAI-compatible client works), and the OpenClaw-specific quirks live in one file.
- **Content cleaning is done once, in the bridge.** `parseTranscript()` strips the
  `[Working directory: …]` banner and drops pure-machinery rows (`NO_REPLY`,
  harness preamble) *server-side*, so `/history` returns display-ready messages and
  the panel's `loadHistory()` is a thin append. There is intentionally **no** second
  filter in the QML to drift out of sync. (An earlier version cleaned in both places;
  consolidating to the bridge removed that duplication.)

## 2. The bridge API

### `POST /v1/chat/completions`  (OpenAI-compatible, streaming)
Body: standard OpenAI chat payload, plus an optional `"session": "<key>"`.
Response: `text/event-stream` of `chat.completion.chunk` deltas.

Two delta shapes are emitted:
- `delta.content` — real assistant text. Standard; every OpenAI client renders it.
- `delta.status` — **non-standard**: transient tool/thinking activity (e.g.
  "⚙ Read", "💭 considering…"). Generic clients ignore the unknown field
  harmlessly; the flyout shows it on a live activity line and never persists it.

Turn execution tries **`openclaw acp`** first (true token-by-token streaming over
JSON-RPC on stdio). If ACP produces nothing or fails *before any text streamed*, it
falls back to the one-shot **`openclaw agent --json`** path (with one retry on
transient errors). If text already streamed and *then* the connection broke, the
turn ends where it is — restarting would duplicate text.

### `GET /sessions`
Returns real, user-facing chats (newest first) for the recent-chats drawer.
Internal/derived sessions (cron jobs + their runs, `flyout-<ts>` throwaways,
probe/test keys) are filtered out by `isChatSession()`. A session whose only
content is bootstrap/harness preamble has a `null` title and is dropped too — the
default flyout session is the one exception (always kept).

### `GET /history?session=<key>`
Returns `{ session, messages: [{role, content}, …] }`, already cleaned (see §1).

## 3. Session continuity — the "it forgot what we were talking about" fix

The panel mints a throwaway `agent:main:flyout-<timestamp>` key when you start a
"new chat" or on some (re)launch paths. If the bridge honoured that key verbatim,
each relaunch would strand the running conversation on a fresh, empty session.

So the bridge **pins** any `agent:main:flyout-<digits>` key back to the stable
default (`agent:main:ai-flyout`) for chat turns. Deliberate switches to *named*
sessions from the drawer are still honoured — only the ephemeral pattern is coerced.
The panel mirrors the same "is this a real chat key?" test in `isChatKey()` so it
never *persists* a throwaway/probe key as the last-open session (which would reopen blank).

## 4. History is polled, not pushed — the "my replies never showed up" fix

**The gateway writes a completed turn to the SQLite store only when the turn
finishes — and replies routinely take a minute or two.** The store has no change
notification. So the flyout **polls** `/history` every few seconds while the panel
is shown (`refreshTimer`, `running: root.shown`). A reply that lands two minutes
after you sent it appears within one poll interval.

`loadHistory()` diffs the fetched list against the current model and **no-ops when
nothing changed**, so polling never causes a flash and costs only one small
`sqlite3 -readonly` read per tick. The read is `-readonly` so it can never block or
corrupt a concurrent gateway write.

## 5. Scroll-to-bottom — the "it opened at the top" fix

`loadHistory()` appends the whole transcript in a tight loop, so a single
`positionViewAtEnd()` on `onCountChanged` runs *before* the variable-height Markdown
bubbles have computed their final heights → it lands near the top. The list keeps a
`stickToBottom` flag and re-asserts the position on every `onContentHeightChanged`
(as delegates finish laying out) until it's genuinely at the end. `onMovementEnded`
clears the flag if you've scrolled up, so it respects manual scrolling.

## 6. IPC

```sh
qs -c openclaw-sidebar ipc call sidebar <cmd>
```

| cmd | effect |
|-----|--------|
| `toggle` | show/hide |
| `show` | show (and reload the current chat, catching a just-flushed turn) |
| `hide` | hide |
| `pin` | toggle reserving screen space vs floating overlay |
| `lock` | show + pin + switch to the default session + reload — used by the CLI hand-off return |
| `widen` | toggle a wider panel |
| `reload` | re-sync history + sessions (after external edits) |

> **Gotcha:** `qs ipc call` matches instances **by `WAYLAND_DISPLAY`**. If it's
> unset, the call reports "No running instances … on display 'unk'" and silently
> no-ops (rc still 0). Anything invoking IPC outside a normal Wayland client (a
> script, a cron job) must `export WAYLAND_DISPLAY=wayland-1` first.
> `openclaw-cli-chat.sh` pins it defensively for exactly this reason.

## 7. The ↗ CLI hand-off

The **↗** button opens the *same* session in a terminal (`openclaw tui --session
ai-flyout`) via `openclaw-cli-chat.sh`, then hides the flyout. However the terminal
exits — `/exit`, Ctrl-D, Ctrl-C, or the window being killed (e.g. a compositor
`close` bind sends SIGTERM → the child bash gets SIGHUP) — the script reopens the
flyout, shown + pinned, on that session. It traps `EXIT` **and** `HUP/INT/TERM`
explicitly, because a killed terminal does **not** run a plain `EXIT` trap.

Note: `openclaw tui` connects to the running gateway over `ws://`; do **not** pass
`--local`, which refuses to start when a gateway is already up.

## 8. Gateway auto-start

If a turn arrives while the OpenClaw gateway is down, the bridge starts it
(`systemctl --user start openclaw-gateway.service`, falling back to `openclaw
gateway start`) and waits for its port before running the turn, emitting a
"⚙ starting OpenClaw…" status line meanwhile. Concurrent turns share one start
(`gatewayStarting` promise). Disable with `OPENCLAW_BRIDGE_AUTOSTART_GATEWAY=0`.

## 9. Panel cosmetics (the scallop / gap notes)

The panel cancels Hyprland's `gaps_out` with negative window margins so the dark
body sits flush to the screen edges (otherwise a wallpaper strip shows above/below/
left of it). The two right-hand corners are drawn as concave "scallop" fillets with
a `Canvas` + `destination-out` arc, so the desktop *beside* the panel appears to
have rounded corners. Header/footer strips and the scallop fillets are **fully
opaque black** on purpose — at the body's ~80% alpha the desktop behind bled through
as grey lines/curves. If you change `gaps_out`, match `edgeGap` in `shell.qml`.

---

## File map

```
bin/openclaw-ai-bridge.js        the bridge (Node)
bin/openclaw-cli-chat.sh         ↗ CLI hand-off + reopen-on-exit
bin/openclaw-dashboard.sh        open the Control UI with a token
systemd/openclaw-ai-bridge.service  user service for the bridge
quickshell/openclaw-sidebar/
  shell.qml                      the panel
  icons/                         launcher icons
  shortcuts.json.example         starter launcher set (copied to shortcuts.json on install)
install.sh / uninstall.sh        per-user deploy / remove
Makefile                         thin wrapper: make install / uninstall / check
```
