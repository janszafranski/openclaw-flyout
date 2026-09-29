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
│  Quickshell panel        │  ── GET  /history/version?…  ────▶ │  openclaw-ai-bridge  │
│  (shell.qml)             │  ── GET  /history?session=…  ────▶ │  (Node)              │
│  view + input + IPC      │  ── GET  /sessions           ────▶ │  data + turn exec    │
│                          │  ── POST /v1/chat/completions ───▶ │                      │
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

**Drawer title flags.** A title can carry a prefix when one topic dominates the
transcript, so the chat about that topic stays findable in a long drawer. The
tokens that identify it are personal — a matter reference, a firm, a person's
name — so they are **config, not source**, and this repo ships none:

```
~/.config/openclaw-flyout/title-flags.json     # private; OPENCLAW_FLYOUT_CONFIG_DIR
                                               # or XDG_CONFIG_HOME relocates it
{ "flags": [ { "prefix": "⚖", "threshold": 100, "tokens": ["…", "…"] } ] }
```

`config/title-flags.json.example` documents every field and is the empty default
`install.sh` seeds. `loadTitleFlags()` reads the file **once at startup** — restart
the bridge after editing it. `titleFor()` applies the first flag whose tokens hit
`threshold` times across the whole transcript; that count is what stops a single
passing mention in an unrelated chat from branding the whole session. Tokens are
matched **literally** and case-insensitively, not as regexes, so nothing needs
escaping and a malformed entry is skipped with a warning rather than taking the
bridge down. The startup line reports a count and the path only: logging the
tokens would put them straight back into journald, which is the same mistake as
having them in the source.

`titleFor()` is **cached on `(sessionId, updatedAt)`** and reads only the first
`OPENCLAW_BRIDGE_TITLE_HEAD_ROWS` (40) transcript rows — a title comes from the
first human message, so reading past it is waste. A *configured flag* is the one
exception: "does this topic dominate?" is a whole-transcript question, so a flag
costs one full read — on a cache miss only, and never on the `/history` path.

### `GET /history?session=<key>[&limit=N]`
Returns `{ session, version, limit, messages: [{role, content}, …] }`, already
cleaned (see §1).

`limit` is the number of **newest** messages to return, default 200 (`limit=0` or
`limit=all` for the whole transcript, capped at 5000). It is a window, not a page:
there is no offset, because the panel only ever shows the recent end. On a real
store this is the difference between a 3.45 MB response and a ~300 KB one.

`version` is the session's highest transcript `seq`, read in the *same* `sqlite3`
invocation as the rows, so it can never disagree with the messages beside it.

### `GET /history/version?session=<key>`
Returns `{ session, version }` and nothing else — 49 bytes, one indexed query
(`MAX(seq)` over the `(session_id, seq)` primary key), no CLI spawn. This is what
makes the panel's poll conditional; see §4. An unresolvable key is `version: -1`,
not an error: a chat with no transcript yet is a normal state.

### Caching

`openclaw sessions list --json` is the only way to map a session *key* to the
`sessionId` the transcript table is keyed by, and it costs **~2.1 s** because it
boots a whole CLI. Calling it per request is what made `/history` and `/sessions`
cost ~2.3–2.6 s each.

It is cached **stale-while-revalidate**, not with a plain TTL: a plain TTL still
hands one poll tick in every TTL the full 2.1 s bill. A caller gets whatever is
cached, immediately; a stale cache schedules a refresh in the background for the
next caller. Only two things ever wait for the CLI — the first request after
startup (nothing to serve yet), and a lookup for a key that is *not in* the cache
(a chat created seconds ago), which is rate-limited to one spawn per
`OPENCLAW_BRIDGE_INDEX_MISS_MS` so an always-absent key can't re-spawn it per
poll. `GET /sessions?fresh=1` opts into waiting.

| env var | default | what |
|---|---|---|
| `OPENCLAW_BRIDGE_HISTORY_LIMIT` | `200` | `/history` messages when `limit` is unset |
| `OPENCLAW_BRIDGE_INDEX_TTL_MS` | `30000` | age at which the session index refreshes behind you |
| `OPENCLAW_BRIDGE_INDEX_MISS_MS` | `3000` | min gap between CLI spawns for an unknown key |
| `OPENCLAW_BRIDGE_TITLE_HEAD_ROWS` | `40` | transcript rows read for a drawer title |

Every transcript read is `execFile`, never `execFileSync`. The bridge carries
in-flight SSE streams; a synchronous read blocks the event loop, and therefore the
stream, for as long as it takes.

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
notification. So the flyout **polls** every few seconds while the panel is shown
(`refreshTimer`, `running: root.shown`). A reply that lands two minutes after you
sent it appears within one poll interval.

### What a tick costs

A tick is **conditional**. `pollHistory()` asks `/history/version` first and only
fetches a transcript body when that number moved. At rest, that 49-byte probe is
the entire cost of a tick.

This used to be an unbounded `GET /history` every 3 s. Measured on a real store
(2601 messages), each tick was **3.45 MB and ~2.3 s**, spawning both the
`openclaw` CLI and `sqlite3`, with the whole 3.4 MB re-parsed in the QML render
thread and diffed against a 2601-row `ListModel` — while a 2.3 s response raced a
3 s timer. An earlier version of this section claimed a tick cost "one small
`sqlite3 -readonly` read"; it did not, and the flash / scroll-snap-back /
"repeated chunks" work-arounds in `loadHistory()` were mostly fighting that.

| | before | after |
|---|---|---|
| tick at rest | 3.45 MB, ~2.3 s | 49 B, ~10 ms |
| tick with a new turn | 3.45 MB, ~2.3 s | ~300 KB, ~30 ms |
| `GET /sessions` | 2.3–2.6 s | ~1 ms warm |
| process spawns per tick | 2 | 1 (`sqlite3`), 0 CLI |

The read is still `-readonly`, so it can never block or corrupt a concurrent
gateway write.

### Guards

- **In-flight guard.** `loadHistory()` and the version probe each refuse to start
  while their own request is outstanding. At 2.3 s per request against a 3 s timer
  the old code already nearly overlapped itself. A request that never completes
  goes stale after 20 s so a killed bridge can't wedge the poll permanently.
- **`root.busy`.** The poll pauses while a turn streams: the store lacks the
  in-progress reply (written only on completion), and the version must *not* be
  recorded from a body fetched mid-turn, or the poll would stop looking for the
  very turn it's waiting on. `settleTimer` holds it off for a few seconds
  afterwards so the finished reply has flushed before the next diff.
- **Version is per session.** `switchSession()`, `newChat()`, the `lock` and
  `clear` IPC calls all reset it, so the next tick always fetches a body rather
  than trusting a number that belonged to a different chat.

### Reconciling a *window*

Because `/history` now returns the newest 200 messages rather than everything,
`reconcileHistory()` is **tail-anchored**, not prefix-anchored: once a chat is
longer than the window, the window no longer starts where the model does, and
prefix diffing would simply stop updating. It finds the offset at which the window
lines up with the model's tail (longest overlap wins) and then:

- window sits inside the model, nothing past it → **no change**. This is what
  protects your just-typed prompt and the streamed reply from being cleared while
  the store is still behind.
- window lines up and extends past it → **append the tail only**, which leaves
  scroll position untouched. A `clear()`+refill on every poll is what used to snap
  you back to the bottom when you scrolled up.
- nothing lines up → history genuinely diverged (session switch, an edit rewrote
  it) → **rebuild**.
- an empty window is a **no-op**, so a transient bridge failure can't blank a
  conversation.

`test/reconcile.test.js` covers these; it mirrors the QML function, so keep the
two in sync. Run them with `make check`.

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

## 10. The keyboard claim — the "typing in the flyout opened the app launcher" fix

The panel takes keyboard focus **on demand** (`WlrKeyboardFocus.OnDemand`): it gets the
keyboard when you click into it, and never steals it just by being open. That is the correct
setting, and it is still what the panel does.

What it collides with is a desktop feature that assumes "no windows on this workspace" means
"nobody is typing anywhere": the omarchy-launcher's *type-to-open* binds, which arm `a`–`z` and
`0`–`9` while the workspace is bare so a plain letter opens the app launcher. A layer-shell
panel is not a window, so the workspace still counted **zero** with this flyout open over it —
and every character typed into the chat box also fired a bind, opening the launcher, which then
took the keyboard and the rest of the sentence.

Neither side could fix this alone. Hyprland's Lua API can report a layer's interactivity
(`none` / `exclusive` / `on_demand`) but offers no way to ask *which* surface currently holds
the keyboard, so the gate cannot tell an on-demand panel that has been clicked into from one
sitting idle — and treating every on-demand panel as "busy" would have disabled type-to-open
permanently, since this flyout is pinned open all day.

So the panel that holds the keyboard says so, in a file:

```
$XDG_RUNTIME_DIR/omarchy-launcher.kb-claim    our layer namespace, or empty
```

`kbClaimProbe` in `shell.qml` watches `Window.active` — true exactly while the compositor has
handed this surface the keyboard, driven by `wl_keyboard.enter`/`leave` — and writes or blanks
the claim through `kbClaimFile`. The gate honours a claim only while a layer with that namespace
is actually mapped, so dying while focused cannot leave type-to-open switched off for the rest
of the session.

The other end lives in `~/.config/hypr/hyprland.lua`, in the `>>> type-to-open >>>` block. The
flyout has no dependency on it: with no launcher installed, the claim file is simply written and
never read.

---

## File map

```
bin/openclaw-ai-bridge.js        the bridge (Node)
bin/openclaw-cli-chat.sh         ↗ CLI hand-off + reopen-on-exit
bin/openclaw-dashboard.sh        open the Control UI with a token
config/title-flags.json.example  drawer title-flag schema + empty default
                                 (live copy: ~/.config/openclaw-flyout/title-flags.json)
systemd/openclaw-ai-bridge.service  user service for the bridge
quickshell/openclaw-sidebar/
  shell.qml                      the panel
  icons/                         launcher icons
  shortcuts.json.example         starter launcher set (copied to shortcuts.json on install)
install.sh / uninstall.sh        per-user deploy / remove
Makefile                         thin wrapper: make install / uninstall / check
```
