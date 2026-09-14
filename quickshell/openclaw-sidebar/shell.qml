//@ pragma UseQApplication
// OpenClaw flyout — a standalone, pinnable left-docked chat panel that talks to
// the OpenClaw agent via the local bridge (127.0.0.1:8787).
// Shell-agnostic: runs as its own Quickshell instance (`qs -c openclaw-sidebar`),
// so it survives your compositor's package updates. Toggle over IPC:
//   qs -c openclaw-sidebar ipc call sidebar toggle
//
// Features: live-polling history, recent-chats drawer (☰), per-session history,
// new chat, session-scoped sends, streaming replies, CLI hand-off (↗), and a
// customisable launcher bar — backed by bridge endpoints /sessions and /history.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import Quickshell.Io

ShellRoot {
    id: root

    // --- state ---
    property bool shown: true
    property bool pinned: true            // pinned = reserve screen space (windows tile beside it)
    property int  panelWidth: 480         // fits 8 launcher buttons + `+` on one row; widen via IPC `widen`
    property int  caeBar: 60              // Caelestia's left vertical bar width. The flyout now sits
                                          // BELOW Caelestia's drawer surface (so its pop-outs paint in
                                          // FRONT of us), which means that bar shows through on the left.
                                          // We inset our content right by caeBar so the bar tucks into
                                          // that strip instead of eating the flyout's left edge.
    property int  scallop: 18             // concave corner radius = Hyprland decoration:rounding
    property int  edgeGap: 10             // = Hyprland general:gaps_out; the negative win.margins
                                          // that cancel the gap make win 2*edgeGap taller than the
                                          // screen, so bg.top sits edgeGap ABOVE the visible top and
                                          // bg.bottom edgeGap BELOW the visible bottom.
    property int  scallopInset: 10        // fillet offset from bg's top/bottom edge. 10 (== edgeGap)
                                          // lands the curves symmetrically: top strip 0-9px, bottom
                                          // strip 1430-1439px, both exactly edgeGap from the true
                                          // corners (confirmed good). LARGER = inward (top down /
                                          // bottom up), smaller = outward. 18 sat top-low/bottom-high.
    property bool remapping: false        // startup restack: unmap→remap to jump above the bar
    property int  restackCount: 0
    property bool busy: false
    property int  elapsed: 0              // seconds the current turn has been running
    readonly property string base: "http://127.0.0.1:8787"
    property string currentSession: "agent:main:ai-flyout"   // active chat
    property bool   sessionsOpen: false                       // recent-chats drawer open
    property string activity: ""                              // live tool/thinking status for the in-flight turn

    // --- claudebar usage strip (bottom) -------------------------------------
    // Polls `claudebar --json` (pure-bash CLI in ~/.local/bin, reads the logged-in
    // `claude` OAuth token) and shows Claude plan usage. Data-only JSON; we paint
    // it in our own palette using the gauge stops the CLI hands back.
    property string cbPlan:    ""      // e.g. "Max 5x"
    property string cbModel:   ""      // background AI model, short form e.g. "Opus 4.8"
    property int    cbSession: -1      // session (5h) used %  (-1 = unknown/not loaded)
    property int    cbWeekly:  -1      // weekly (7d) used %
    property string cbErr:     ""      // non-empty when the CLI reported an error
    property var    cbStops:   []      // [{pct,color}] ramp from the CLI palette
    property var    cbWindows: []      // full windows[] (session, weekly, per-model) for the panel
    property var    cbExtra:   null    // extra_usage object (spend/balance) or null
    property bool   cbExpanded: false  // detail panel open?
    // "2026-09-13T17:10:00Z" -> "resets in 2h 51m" (or "resets in 3d 4h")
    function cbUntil(iso) {
        if (!iso) return "";
        var t = Date.parse(iso);
        if (isNaN(t)) return "";
        var s = Math.max(0, Math.floor((t - Date.now()) / 1000));
        var d = Math.floor(s / 86400); s -= d * 86400;
        var h = Math.floor(s / 3600);  s -= h * 3600;
        var m = Math.floor(s / 60);
        if (d > 0) return "resets in " + d + "d " + h + "h";
        if (h > 0) return "resets in " + h + "h " + m + "m";
        return "resets in " + m + "m";
    }
    // Map a used-% to a colour along the CLI's own gauge ramp.
    function cbColor(pct) {
        if (pct < 0 || !cbStops || cbStops.length === 0) return root.colSubtle;
        var c = cbStops[0].color;
        for (var i = 0; i < cbStops.length; i++) {
            if (pct >= cbStops[i].pct) c = cbStops[i].color; else break;
        }
        return c;
    }

    // --- voice input (dictation) --------------------------------------------
    // The mic button (between the text box and Send) toggles this. When armed we
    // run ~/.local/bin/flyout-dictate, which records from the default source,
    // transcribes locally (whisper.cpp), and prints the text to stdout. We append
    // that text into the input box. Toggling off kills the helper.
    property bool voiceOn: false
    function toggleVoice() {
        if (root.voiceOn) {
            // stop: killing the process fires onExited, which flips voiceOn off
            voiceProc.running = false;
        } else {
            voiceBuf = "";
            root.voiceOn = true;
            voiceProc.running = true;
        }
    }
    property string voiceBuf: ""
    Process {
        id: voiceProc
        command: ["sh", "-lc", "flyout-dictate 2>/dev/null"]
        stdout: SplitParser {
            splitMarker: "\n"
            onRead: function(seg) {
                // each line the helper emits is transcribed text -> append to input
                var t = seg.trim();
                if (t.length === 0) return;
                if (input.text.length > 0 && !input.text.endsWith(" ")) input.text += " ";
                input.text += t;
            }
        }
        onExited: function(exitCode, exitStatus) {
            root.voiceOn = false;
            root.voiceBuf = "";
        }
    }

    Timer {
        interval: 1000; repeat: true; running: root.busy
        onTriggered: root.elapsed += 1
    }

    // --- palette (Caelestia-ish: AMOLED black + catppuccin accents) ---
    readonly property color colBg:      "#cc000000"   // black @ ~80% — transparent, blur stays off (perf); tune AA in #AArrggbb
    readonly property color colHeader:  "#cc000000"   // match bg alpha
    // scallop fillets must be FULLY opaque — their job is to be a solid black
    // corner-filler. If they inherit colBg's 80% alpha, the desktop behind bleeds
    // through and the concave wedge looks like "a pale curve behind a normal one".
    readonly property color colScallop: "#ff000000"   // solid black, always
    readonly property color colUserBub: "#ff141414"   // near-black so user bubbles stay faintly visible (was navy #cb1e1e2e)
    readonly property color colAsstBub: "#00000000"
    readonly property color colAccent:  "#cba6f7"     // mauve
    readonly property color colText:    "#cdd6f4"
    readonly property color colSubtle:  "#9399b2"
    readonly property color colBorder:  "#ff222222"   // neutral dark grey separators (was navy #2a2a3c)
    readonly property color colInputBg: "#ff000000"   // true black (was navy #b316161f)

    ListModel { id: chatModel }
    ListModel { id: sessionsModel }

    // Persist the last-selected session to DISK so a full relaunch (process death, login,
    // caelestia restart) restores the chat you were on instead of resetting to the
    // hardcoded default above. An in-memory property can't survive process restart, which
    // is why the flyout kept reopening on the previous chat. (JsonAdapter <-> small file.)
    FileView {
        id: stateFile
        path: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/quickshell/openclaw-sidebar.json"
        watchChanges: false
        JsonAdapter {
            id: stateAdapter
            property string lastSession: "agent:main:ai-flyout"
        }
        onLoaded: {
            // Only restore a REAL chat session. A cron/run/hook/probe key (which can
            // leak into lastSession) has no visible history → the flyout would open
            // blank on a session you can't even see in the drawer. Fall back to the
            // default flyout session in that case.
            var s = stateAdapter.lastSession;
            if (!s || !s.length || !root.isChatKey(s)) s = "agent:main:ai-flyout";
            root.currentSession = s;
            root.loadHistory(root.currentSession);
        }
        Component.onCompleted: reload()
    }

    // --- launcher shortcuts (buttons under the input; right-click → Preferences) ---
    property var  shortcuts: []           // [{label, cmd}]  cmd runs via `sh -lc`
    property bool prefsOpen: false

    // Human-editable JSON on disk so shortcuts survive relaunch and can be hand-tweaked.
    FileView {
        id: scFile
        path: (Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config")) + "/quickshell/openclaw-sidebar/shortcuts.json"
        watchChanges: false
        onLoaded: {
            try {
                var o = JSON.parse(scFile.text());
                root.shortcuts = (o && o.shortcuts && o.shortcuts.length) ? o.shortcuts : null;
                if (!root.shortcuts) root.seedShortcuts();
            } catch (e) { root.seedShortcuts(); }
        }
        onLoadFailed: root.seedShortcuts()
        Component.onCompleted: reload()
    }

    // icons live next to this config; terminal:true draws the icon in a "console" box
    readonly property string iconDir: (Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config")) + "/quickshell/openclaw-sidebar/icons/"
    function seedShortcuts() {
        // No native Linux Claude desktop app or `askgpt` binary exist → web app via xdg-open
        // (respects the Floorp default) and tgpt (free, no key) for the GPT CLI.
        root.shortcuts = [
            // GUIs first, then CLIs
            { "label": "Claude GUI",  "cmd": "xdg-open https://claude.ai",   "icon": iconDir + "claude.svg", "terminal": false },
            { "label": "ChatGPT GUI", "cmd": "xdg-open https://chatgpt.com", "icon": iconDir + "openai.svg", "terminal": false },
            { "label": "Jan GUI",     "cmd": "jan",                          "icon": iconDir + "jan.png",    "terminal": false },
            { "label": "NotebookLM",  "cmd": "xdg-open https://notebooklm.google.com", "icon": iconDir + "gemini.svg", "terminal": false },
            // `claude+` = Jan's fish alias; expand it here since the launcher runs via sh, not fish.
            { "label": "Claude CLI",  "cmd": "kitty claude --allow-dangerously-skip-permissions --permission-mode bypassPermissions", "icon": iconDir + "claude.svg", "terminal": true },
            { "label": "AskGPT CLI",  "cmd": "kitty tgpt -i",                "icon": iconDir + "openai.svg", "terminal": true },
            { "label": "Jan CLI",     "cmd": "kitty fish -C 'jan-cli --help'", "icon": iconDir + "jan.png",  "terminal": true }
        ];
        root.saveShortcuts();
    }
    function saveShortcuts() {
        scFile.setText(JSON.stringify({ "shortcuts": root.shortcuts }, null, 2));
    }
    function launch(cmd) {
        if (cmd && cmd.trim().length) Quickshell.execDetached(["sh", "-lc", cmd]);
    }
    function addShortcut(label, cmd) {
        if (!label.trim().length || !cmd.trim().length) return;
        root.shortcuts = root.shortcuts.concat([{ "label": label.trim(), "cmd": cmd.trim() }]);
        root.saveShortcuts();
    }
    function removeShortcut(i) {
        var a = root.shortcuts.slice();
        a.splice(i, 1);
        root.shortcuts = a;
        root.saveShortcuts();
    }

    // --- streaming chat turn ---
    // QML's XMLHttpRequest buffers the whole response and won't expose partial
    // text during LOADING, so SSE deltas can't render token-by-token through it.
    // Instead we run `curl -N` via a Process and parse stdout line-by-line as it
    // arrives (SplitParser), updating the message live.
    property string streamBuf: ""
    property int    curIdx: -1

    Process {
        id: chatProc
        stdout: SplitParser {
            splitMarker: "\n"
            // A segment may hold several lines or a stray leading blank line, so scan
            // every line for a `data:` payload rather than assuming one clean line.
            onRead: function(seg) {
                var lines = seg.split("\n");
                var changed = false;
                for (var i = 0; i < lines.length; i++) {
                    var ln = lines[i];
                    if (ln.indexOf("data:") !== 0) continue;
                    var data = ln.replace(/^data:\s*/, "");
                    if (data === "" || data === "[DONE]") continue;
                    try {
                        var j = JSON.parse(data);
                        var d = j.choices && j.choices[0] ? j.choices[0].delta : null;
                        if (!d) continue;
                        // Real assistant text: append to the bubble and clear the activity line.
                        if (typeof d.content === "string" && d.content.length) {
                            root.streamBuf += d.content;
                            root.activity = "";
                            changed = true;
                        // Tool/thinking activity (bridge-only field): show live, don't persist.
                        } else if (typeof d.status === "string") {
                            root.activity = d.status;
                        }
                    } catch (e) { /* partial line — completes on next read */ }
                }
                if (changed)
                    chatModel.set(root.curIdx, { "role": "assistant", "content": root.streamBuf });
            }
        }
        onExited: function(exitCode, exitStatus) {
            root.busy = false;
            root.activity = "";
            if (root.curIdx >= 0 && root.streamBuf.length === 0)
                chatModel.set(root.curIdx, { "role": "assistant",
                    "content": exitCode === 0 ? "(no reply)"
                        : "**Can't reach the bridge.** Is `openclaw-ai-bridge.service` running? (curl exit " + exitCode + ")" });
            root.loadSessions();   // refresh recent-chats
            settleTimer.restart(); // hold the history poll off until the turn flushes
            root.pumpQueue();      // send next queued message, if any
        }
    }

    // --- claudebar poller: one-shot `claudebar --json`, parsed on exit ---
    // A one-shot command (not a stream), so we buffer stdout and parse in onExited.
    property string cbBuf: ""
    property bool cbForceRefresh: false
    Process {
        id: cbProc
        command: ["sh", "-lc", root.cbForceRefresh ? "claudebar --json --refresh 2>/dev/null" : "claudebar --json 2>/dev/null"]
        stdout: SplitParser {
            splitMarker: "\n"          // accumulate all lines; reassemble in onExited
            onRead: function(seg) { root.cbBuf += seg + "\n"; }
        }
        onExited: function(exitCode, exitStatus) {
            try {
                var j = JSON.parse(root.cbBuf);
                root.cbErr = j.error ? String(j.error) : "";
                root.cbPlan = j.plan || "";
                root.cbStops = (j.palette && j.palette.stops) ? j.palette.stops : [];
                root.cbWindows = j.windows || [];
                root.cbExtra = j.extra_usage || null;
                for (var i = 0; i < (j.windows ? j.windows.length : 0); i++) {
                    var w = j.windows[i];
                    if (w.group) continue;                 // skip per-model rows in the strip
                    if (w.id === "session") root.cbSession = w.used_pct;
                    else if (w.id === "weekly") root.cbWeekly = w.used_pct;
                }
            } catch (e) {
                root.cbErr = "parse";
            }
            root.cbBuf = "";
            root.cbForceRefresh = false;   // one-shot: revert to cached poll after a manual refresh
        }
    }
    Timer {
        id: cbTimer
        interval: 90000; repeat: true; running: true    // refresh every 90s while open
        triggeredOnStart: true
        onTriggered: { root.cbBuf = ""; cbProc.running = true; }
    }

    // --- background AI model reader (shown on the usage strip before the plan) ---
    // The flyout talks to the main OpenClaw agent, whose model is the config default
    // at agents.defaults.model.primary in ~/.openclaw/openclaw.json (e.g.
    // "anthropic/claude-opus-4-8"). We read it once at startup and shorten it to a
    // human label like "Opus 4.8". One-shot; re-run only if the file changes matter.
    Process {
        id: cbModelProc
        running: true
        command: ["sh", "-lc",
            "python3 - <<'PY'\n" +
            "import json,os,re\n" +
            "p=os.path.expanduser('~/.openclaw/openclaw.json')\n" +
            "m=''\n" +
            "try:\n" +
            "  d=json.load(open(p))\n" +
            "  m=(((d.get('agents') or {}).get('defaults') or {}).get('model') or {}).get('primary') or ''\n" +
            "except Exception: m=''\n" +
            "s=m.split('/')[-1]                    # drop provider prefix\n" +
            "s=re.sub(r'^claude-','',s)            # drop 'claude-'\n" +
            "s=re.sub(r'-\\\\d{6,}$','',s)           # drop trailing date id\n" +
            "parts=[w.capitalize() if w.isalpha() else w for w in s.split('-')]\n" +
            "# join a bare version like ['4','8'] with a dot: Opus 4 8 -> Opus 4.8\n" +
            "out=[]\n" +
            "for w in parts:\n" +
            "  if out and out[-1].isdigit() and w.isdigit(): out[-1]=out[-1]+'.'+w\n" +
            "  else: out.append(w)\n" +
            "print(' '.join(out))\n" +
            "PY"]
        stdout: SplitParser {
            splitMarker: "\n"
            onRead: function(seg) { var t = seg.trim(); if (t.length) root.cbModel = t; }
        }
    }

    // On startup fetch history + recent chats. The bridge (systemd) may not be up
    // yet at login, so retry a few times until data arrives, then stop.
    property int bootTries: 0
    Timer {
        id: bootTimer
        interval: 1200; repeat: true; running: true
        onTriggered: {
            root.bootTries += 1;
            root.loadHistory(root.currentSession);
            root.loadSessions();
            if (sessionsModel.count > 0 || chatModel.count > 0 || root.bootTries >= 6)
                bootTimer.running = false;
        }
    }

    // LIVE POLL while the panel is open. The gateway writes a turn to SQLite only
    // when the turn COMPLETES — and replies routinely take ~2 MINUTES. A short
    // burst after open therefore gave up long before the reply landed, so the
    // flyout showed the user's message but never the response. Instead, keep
    // reloading every few seconds for as long as the panel is shown: a reply that
    // finishes 2 min later appears within one poll interval. `loadHistory` diffs
    // against the model and no-ops when unchanged, so this never flashes and is
    // cheap (one small SQLite read). The poll only runs while `root.shown`.
    function reloadSoon() { root.loadHistory(root.currentSession); }
    Timer {
        id: refreshTimer
        interval: 3000; repeat: true
        running: root.shown && !root.busy && !settleTimer.running
                                            // pause while a turn streams: the poll
                                            // reads SQLite, which lacks the in-progress
                                            // reply (written only on completion), so a
                                            // mid-turn poll would clear()+refill and
                                            // wipe the streamed text — the flicker.
                                            // settleTimer holds the poll off briefly
                                            // after a turn so the just-finished reply
                                            // has flushed to SQLite before we diff.
        triggeredOnStart: true         // reload immediately on show, then every 3s
        onTriggered: root.loadHistory(root.currentSession)
    }
    // After a streamed turn ends, wait for the gateway to flush it to SQLite before
    // re-enabling the poll — otherwise the first post-turn diff wipes the reply that
    // the stream just rendered. Started from chatProc.onExited.
    Timer {
        id: settleTimer
        interval: 4000; repeat: false; running: false
    }

    IpcHandler {
        target: "sidebar"
        function toggle(): void { root.shown = !root.shown }
        function show(): void   { root.shown = true; if (!root.busy) root.reloadSoon() }  // always reopen on the current chat, catching a just-flushed turn
        function hide(): void   { root.shown = false }
        function pin(): void    { root.pinned = !root.pinned }
        // show + pin (CLI hand-off return). The ↗ terminal ALWAYS runs on
        // `agent:main:ai-flyout` (`openclaw tui --session ai-flyout`), so on return
        // we must (a) switch the flyout to that canonical session — the flyout may
        // have been on an ephemeral `flyout-<ts>` "new chat" key — and (b) reload
        // history from the store, since the terminal's turns are not in the flyout's
        // in-memory chatModel. Without this the flyout reopens stale, missing
        // everything typed in the terminal.
        function lock(): void {
            root.shown = true;
            root.pinned = true;
            root.currentSession = "agent:main:ai-flyout";
            root.reloadSoon();   // burst-reload: the terminal's last turn may still be flushing to SQLite
        }
        function widen(): void  { root.panelWidth = (root.panelWidth >= 620 ? 480 : 620) }
        function clear(): void  { chatModel.clear() }
        function reload(): void { root.loadHistory(root.currentSession); root.loadSessions() }  // re-sync after CLI edits
    }

    // ---- data layer (bridge /sessions, /history) --------------------------

    // A restorable/persistable chat key: not a cron/run/hook/node/probe/test
    // session. Mirrors the bridge's isChatSession() so the flyout never restores
    // or saves a session that isn't a real conversation. The throwaway
    // flyout-<ts> keys ARE valid (the bridge pins them back to the default).
    function isChatKey(key) {
        if (!key || !key.length) return false;
        if (/:cron:|:run:|:hook:|:node:/.test(key)) return false;
        var name = key.replace(/^agent:[^:]+:/, "");
        if (/test|diag|probe|selftest|healthprobe|flytest|empty/i.test(name)) return false;
        return true;
    }

    function loadSessions() {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", root.base + "/sessions");
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE || xhr.status !== 200) return;
            try {
                var d = JSON.parse(xhr.responseText);
                sessionsModel.clear();
                for (var i = 0; i < d.sessions.length; i++) {
                    var s = d.sessions[i];
                    sessionsModel.append({ "key": s.key, "title": s.title || s.key });
                }
            } catch (e) { /* ignore */ }
        };
        xhr.send();
    }

    // The bridge already returns display-ready messages: the "[Working directory: …]"
    // banner is stripped and pure-machinery rows (NO_REPLY, harness preamble) are
    // dropped server-side in parseTranscript(). So this is a thin loader — no
    // client-side cleaning to keep in sync with the bridge.

    function loadHistory(key) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", root.base + "/history?session=" + encodeURIComponent(key));
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE || xhr.status !== 200) return;
            try {
                var d = JSON.parse(xhr.responseText);
                // Build the list first, then diff against what's already shown —
                // only rebuild the model if it actually changed. The live poll
                // fires loadHistory every few seconds; without this diff every
                // call would clear()+refill and the panel would FLASH.
                var next = [];
                for (var i = 0; i < d.messages.length; i++) {
                    var m = d.messages[i];
                    next.push({ "role": m.role, "content": m.content });
                }
                // RESTORE-AFTER-RELOAD must win over the busy/shrink guards. If
                // Quickshell hot-reloads mid-turn, a fresh empty model gets only the
                // in-flight turn appended (~1-2 rows) while the store holds the WHOLE
                // transcript. That's not the clobber case — it's the opposite — so we
                // MUST adopt the store here even while busy. Detect it: the store has
                // many MORE messages than we're showing. (Threshold 4 leaves headroom
                // for a normal streaming turn's own rows.)
                var restoring = (next.length >= chatModel.count + 4);
                // NEVER clobber optimistic local state with a lagging store. The
                // gateway writes a turn to SQLite only on completion, so between
                // "user hits send" and "reply flushed" the store has FEWER messages
                // than we're showing (the just-typed prompt + streaming reply live
                // only in chatModel). Applying that snapshot would clear() them —
                // that's why the question AND the prior reply vanished. So bail while
                // a turn is in flight, and never shrink: only adopt the store when it
                // has caught up (>= what we show). A genuine session SWITCH clears the
                // model first, so count 0 there still loads fine. EXCEPT when we're
                // restoring the full transcript after a reload (see above).
                if (root.busy && !restoring) return;
                if (next.length < chatModel.count) return;
                var changed = (next.length !== chatModel.count);
                if (!changed) {
                    for (var j = 0; j < next.length; j++) {
                        if (chatModel.get(j).role !== next[j].role ||
                            chatModel.get(j).content !== next[j].content) { changed = true; break; }
                    }
                }
                if (!changed) return;   // identical → no repaint, no flash
                // APPEND-ONLY when the store is an unchanged PREFIX of what we show
                // plus new rows at the end (the common poll case: a turn completed,
                // a few rows added). A full clear()+refill of a ~1500-row model
                // resets the viewport every poll — that's the "repeated chunks /
                // can't scroll up" bug: scroll up, next poll rebuilds + snaps you
                // back. So only clear() when the prefix genuinely diverged (session
                // switch / an edit rewrote history); otherwise just append the tail,
                // which leaves scroll position untouched.
                var prefixMatches = (next.length > chatModel.count);
                if (prefixMatches) {
                    for (var p = 0; p < chatModel.count; p++) {
                        if (chatModel.get(p).role !== next[p].role ||
                            chatModel.get(p).content !== next[p].content) { prefixMatches = false; break; }
                    }
                }
                if (prefixMatches) {
                    for (var a = chatModel.count; a < next.length; a++) chatModel.append(next[a]);
                } else {
                    chatModel.clear();
                    for (var k = 0; k < next.length; k++) chatModel.append(next[k]);
                }
                // Pin to newest ONLY if the user is already parked at the bottom
                // (stickToBottom). If they scrolled up to read history, leave their
                // viewport alone — a background poll must not drag them to the end.
                // A session switch / new-message send sets stickToBottom=true first,
                // so those still scroll down correctly.
                if (typeof list !== "undefined" && list.stickToBottom) list.toBottom();
            } catch (e) { /* ignore */ }
        };
        xhr.send();
    }

    function switchSession(key) {
        root.currentSession = key;
        root.sessionsOpen = false;
        // A deliberate switch should land on the newest message.
        if (typeof list !== "undefined") list.stickToBottom = true;
        root.loadHistory(key);
        // Only persist real chat keys — never a cron/probe key that would reopen blank.
        if (root.isChatKey(key)) {
            stateAdapter.lastSession = key;   // persist so a relaunch reopens THIS chat
            stateFile.writeAdapter();
        }
    }

    function newChat() {
        root.currentSession = "agent:main:flyout-" + Date.now();
        chatModel.clear();
        root.sessionsOpen = false;
        stateAdapter.lastSession = root.currentSession;
        stateFile.writeAdapter();
    }

    // ---- send queue (input never blocks; sends run sequentially) -----------
    property var pending: []

    function sendMessage(text) {
        var t = (text || "").trim();
        if (t.length === 0) return;
        // The user just sent — always follow to the bottom, even if they'd
        // scrolled up to read history (which would have cleared stickToBottom).
        if (typeof list !== "undefined") list.stickToBottom = true;
        chatModel.append({ "role": "user", "content": t });
        root.pending.push(t);
        root.pumpQueue();
    }

    function pumpQueue() {
        if (root.busy || root.pending.length === 0) return;
        var t = root.pending.shift();
        root.busy = true;
        root.elapsed = 0;
        chatModel.append({ "role": "assistant", "content": "…" });
        root.curIdx = chatModel.count - 1;
        root.streamBuf = "";
        root.activity = "";

        var payload = JSON.stringify({
            "model": "openclaw",
            "session": root.currentSession,
            "messages": [{ "role": "user", "content": t }],
            "stream": true
        });
        // curl -N = unbuffered; payload passed as a single argv (no shell, no quoting issues)
        chatProc.command = ["curl", "-N", "-s", "-X", "POST",
            root.base + "/v1/chat/completions",
            "-H", "Content-Type: application/json",
            "-d", payload];
        chatProc.running = true;
    }

    PanelWindow {
        id: win
        visible: root.shown && !root.remapping
        color: "transparent"
        // extra `scallop` px on the right so the concave corner fillets can overhang the
        // desktop and give IT rounded corners. exclusiveZone still reserves only panelWidth.
        implicitWidth: root.caeBar + root.panelWidth + root.scallop

        anchors { left: true; top: true; bottom: true }
        // Cancel Hyprland's gaps_out (10px). Hyprland insets anchored layer-shell
        // surfaces by general:gaps_out, so the panel was placed at x=60 y=10 h=1420 —
        // leaving a 10px wallpaper strip ABOVE, BELOW, and to the LEFT of the dark
        // boxes (the "transparent layer showing past the boxes"). Negative margins on
        // the three anchored edges pull the surface back flush to the screen edges.
        // If gaps_out changes, match it here.
        margins { top: -10; bottom: -10; left: -10 }
        exclusiveZone: root.pinned ? root.caeBar + root.panelWidth : 0
        // input only over the real panel; the caeBar strip on the left stays click-through so
        // Caelestia's bar underneath keeps receiving clicks, and the overhang strip on the right
        // stays click-through to the desktop.
        mask: Region { x: root.caeBar; y: 0; width: root.panelWidth; height: win.height }

        WlrLayershell.namespace: "openclaw-sidebar"
        WlrLayershell.layer: WlrLayer.Top
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.OnDemand

        // Startup restack DISABLED (was: jump above Caelestia's bar). Caelestia's bar and its
        // pop-out drawers are ONE full-screen surface on the `top` layer, so restacking above the
        // bar also put us above the pop-outs — which then appeared BEHIND the flyout. We now
        // deliberately sit BELOW Caelestia's surface: the flyout autostarts before Caelestia, so
        // with no restack Caelestia's surface maps last and stays above us → its pop-outs paint in
        // FRONT of the flyout (what we want). The trade-off (Caelestia's 60px left bar showing over
        // our left edge) is handled by the caeBar inset above. Left here, disabled, for easy revert.
        Timer {
            id: restackTimer
            interval: 2500; running: false; repeat: true
            onTriggered: {
                root.remapping = true;
                unmapTimer.restart();
                root.restackCount++;
                if (root.restackCount >= 2) running = false;   // fires at ~2.5s and ~5s
            }
        }
        Timer {
            id: unmapTimer
            interval: 150; running: false; repeat: false
            onTriggered: root.remapping = false
        }

        // --- panel body: square right edge; the two right corners are drawn as concave
        //     fillets below so the adjacent desktop appears to have 18px rounded corners ---
        Rectangle {
            id: bg
            anchors { left: parent.left; leftMargin: root.caeBar; top: parent.top; bottom: parent.bottom }
            width: root.panelWidth
            color: root.colBg
            // no border: the 1px grey edge showed as a pale line along the bottom/right
            // against the desktop. Shape is defined by the solid bars + scallop fillets.
            border.width: 0

            // top-right concave fillet (rounds the desktop's top-left corner).
            // Runs from the panel's TOP edge (y:0) down through the scallopInset strip
            // to the curve, so no wallpaper shows between the top strip and the arc.
            // Top `scallopInset` px = solid black filler; bottom `scallop` px = the arc.
            Canvas {
                width: root.scallop; height: root.scallopInset + root.scallop
                x: bg.width; y: 0
                onPaint: {
                    var c = getContext("2d");
                    c.clearRect(0, 0, width, height);
                    c.fillStyle = root.colScallop;
                    c.fillRect(0, 0, width, height);
                    c.globalCompositeOperation = "destination-out";
                    // arc centred at the fillet's bottom-right → carves the concave corner
                    c.beginPath(); c.arc(width, height, root.scallop, 0, 2 * Math.PI); c.fill();
                }
            }
            // bottom-right concave fillet (rounds the desktop's bottom-left corner).
            // Runs up to the panel's BOTTOM edge; top `scallop` px = arc, bottom
            // `scallopInset` px = solid filler covering the strip to the edge.
            Canvas {
                width: root.scallop; height: root.scallopInset + root.scallop
                x: bg.width; y: bg.height - (root.scallopInset + root.scallop)
                onPaint: {
                    var c = getContext("2d");
                    c.clearRect(0, 0, width, height);
                    c.fillStyle = root.colScallop;
                    c.fillRect(0, 0, width, height);
                    c.globalCompositeOperation = "destination-out";
                    c.beginPath(); c.arc(width, 0, root.scallop, 0, 2 * Math.PI); c.fill();
                }
            }

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 0
                spacing: 0

                // ---------- header ----------
                // Solid black (not 80% colHeader): the header is the top strip against the
                // screen edge; at 80% the window/desktop behind bled through as grey.
                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: 48
                    color: root.colScallop
                    // NO topRightRadius: the header sits inside `bg` whose right edge is
                    // square; the visible rounded corner is drawn by the external scallop
                    // Canvas. A radius here punched an 18px quarter-circle notch out of the
                    // header's own corner, exposing bg's 80%-alpha fill behind it = the grey
                    // line "at the top, curving to the left". Keep the strip a full square.
                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 10
                        anchors.rightMargin: 8
                        spacing: 6
                        // recent chats toggle
                        ToolButton {
                            text: "☰"
                            onClicked: { root.sessionsOpen = !root.sessionsOpen; if (root.sessionsOpen) root.loadSessions(); }
                            ToolTip.text: "Recent chats"; ToolTip.visible: hovered
                            contentItem: Label { text: parent.text; color: root.sessionsOpen ? root.colAccent : root.colSubtle; font.pixelSize: 16; horizontalAlignment: Text.AlignHCenter }
                            background: Rectangle { color: parent.hovered ? root.colBorder : "transparent"; radius: 6 }
                        }
                        // close: fully QUIT the flyout process — not just hide it.
                        // (Placed next to the hamburger by request. Qt.quit() tears the
                        //  qs -c openclaw-sidebar process down cleanly; a stuck panel used
                        //  to need a PC reboot to clear.)
                        ToolButton {
                            text: "✕"
                            onClicked: Qt.quit()
                            ToolTip.text: "Quit flyout (fully close the process)"; ToolTip.visible: hovered
                            contentItem: Label { text: parent.text; color: root.colSubtle; font.pixelSize: 15; horizontalAlignment: Text.AlignHCenter }
                            background: Rectangle { color: parent.hovered ? root.colBorder : "transparent"; radius: 6 }
                        }
                        Rectangle { width: 8; height: 8; radius: 4; color: root.colAccent }
                        Label {
                            text: "OpenClaw"
                            color: root.colText
                            font.pixelSize: 15
                            font.bold: true
                            Layout.fillWidth: true
                        }
                        Label {
                            visible: root.busy
                            text: "thinking… " + root.elapsed + "s" + (root.pending.length > 0 ? " · " + root.pending.length + " queued" : "")
                            color: root.colSubtle
                            font.pixelSize: 12
                        }
                        // new chat
                        ToolButton {
                            text: "✚"
                            onClicked: root.newChat()
                            ToolTip.text: "New chat"; ToolTip.visible: hovered
                            contentItem: Label { text: parent.text; color: root.colSubtle; font.pixelSize: 15; horizontalAlignment: Text.AlignHCenter }
                            background: Rectangle { color: parent.hovered ? root.colBorder : "transparent"; radius: 6 }
                        }
                        // collapse: tuck the flyout away (reopens on the same chat; stays pinned so re-show reserves space)
                        // ❮ (U+276E) renders visually chunkier than the ↗ arrow at the same
                        // pixelSize, so use 13 (not 16) to make the chevron LOOK the same size.
                        ToolButton {
                            text: "❮"
                            onClicked: root.shown = false
                            ToolTip.text: "Collapse (reopen with the toggle)"; ToolTip.visible: hovered
                            contentItem: Label { text: parent.text; color: root.colSubtle; font.pixelSize: 13; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                            background: Rectangle { color: parent.hovered ? root.colBorder : "transparent"; radius: 6 }
                        }
                        // pop the same conversation out to a terminal (CLI), then hide the flyout
                        // ❯ (U+276F) matches the ❮ collapse chevron; pixelSize 13 keeps them the same visual size.
                        ToolButton {
                            text: "❯"
                            onClicked: {
                                Quickshell.execDetached(["alacritty", "--title", "OpenClaw", "-e",
                                                         (Quickshell.env("HOME") || "") + "/.local/bin/openclaw-cli-chat.sh"]);
                                root.shown = false;
                            }
                            ToolTip.text: "Continue in terminal (CLI)"; ToolTip.visible: hovered
                            contentItem: Label { text: parent.text; color: root.colSubtle; font.pixelSize: 13; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                            background: Rectangle { color: parent.hovered ? root.colBorder : "transparent"; radius: 6 }
                        }
                        // pin
                        ToolButton {
                            text: root.pinned ? "📌" : "📍"
                            onClicked: root.pinned = !root.pinned
                            ToolTip.text: root.pinned ? "Pinned (reserving space)" : "Floating (overlay)"; ToolTip.visible: hovered
                            contentItem: Label { text: parent.text; color: root.pinned ? root.colAccent : root.colSubtle; font.pixelSize: 15; horizontalAlignment: Text.AlignHCenter }
                            background: Rectangle { color: parent.hovered ? root.colBorder : "transparent"; radius: 6 }
                        }
                    }
                }
                // separator under the header — colScallop (solid black) not colBorder:
                // against the black header the grey #222 line read as "a light grey line
                // at the top". Keep the 1px so layout height is unchanged, just invisible.
                Rectangle { Layout.fillWidth: true; height: 1; color: root.colScallop }

                // ---------- recent-chats drawer ----------
                Rectangle {
                    Layout.fillWidth: true
                    visible: root.sessionsOpen
                    color: root.colHeader
                    Layout.preferredHeight: root.sessionsOpen ? Math.min(sessionsList.contentHeight + 46, 300) : 0
                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: 8
                        spacing: 6
                        RowLayout {
                            Layout.fillWidth: true
                            Label { text: "Recent chats"; color: root.colSubtle; font.pixelSize: 12; font.bold: true; Layout.fillWidth: true }
                            ToolButton {
                                text: "✚ New chat"
                                onClicked: root.newChat()
                                contentItem: Label { text: parent.text; color: root.colAccent; font.pixelSize: 12 }
                                background: Rectangle { color: parent.hovered ? root.colBorder : "transparent"; radius: 6 }
                            }
                        }
                        ListView {
                            id: sessionsList
                            Layout.fillWidth: true
                            Layout.fillHeight: true
                            clip: true
                            model: sessionsModel
                            spacing: 2
                            boundsBehavior: Flickable.StopAtBounds
                            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
                            delegate: Rectangle {
                                width: ListView.view ? ListView.view.width : 0
                                implicitHeight: 34
                                radius: 8
                                color: model.key === root.currentSession ? root.colBorder : (sma.containsMouse ? "#1affffff" : "transparent")
                                Label {
                                    anchors.fill: parent
                                    anchors.leftMargin: 10; anchors.rightMargin: 10
                                    verticalAlignment: Text.AlignVCenter
                                    text: model.title
                                    color: model.key === root.currentSession ? root.colAccent : root.colText
                                    font.pixelSize: 13
                                    elide: Text.ElideRight
                                }
                                MouseArea {
                                    id: sma
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    onClicked: root.switchSession(model.key)
                                }
                            }
                        }
                    }
                }
                Rectangle { Layout.fillWidth: true; height: 1; color: root.colBorder; visible: root.sessionsOpen }

                // ---------- message list ----------
                ListView {
                    id: list
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    model: chatModel
                    spacing: 10
                    topMargin: 12
                    bottomMargin: 12
                    leftMargin: 12
                    rightMargin: 12
                    boundsBehavior: Flickable.StopAtBounds
                    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

                    // Pin to the newest message. loadHistory() appends the whole
                    // transcript in a tight loop, so a single positionViewAtEnd on
                    // countChanged runs BEFORE the variable-height text bubbles have
                    // computed their final heights → it lands near the top. Set a
                    // "stick to bottom" flag while loading and re-assert the position
                    // whenever contentHeight grows (delegates finishing layout) until
                    // we're actually at the end. Also honour a user who scrolls up.
                    property bool stickToBottom: true
                    function toBottom() { stickToBottom = true; Qt.callLater(function(){ list.positionViewAtEnd() }) }
                    // Only follow new rows to the bottom if the user is ALREADY at the
                    // bottom. If they scrolled up to read history, a background poll
                    // that appends rows must NOT re-arm stick-to-bottom and yank them
                    // down. toBottom() (called explicitly on send / session switch)
                    // still forces stickToBottom=true when we DO want to follow.
                    onCountChanged: if (stickToBottom) Qt.callLater(function(){ list.positionViewAtEnd() })
                    onContentHeightChanged: if (stickToBottom) Qt.callLater(function(){ list.positionViewAtEnd() })
                    onMovementEnded: stickToBottom = (contentY >= originY + contentHeight - height - 40)

                    delegate: Item {
                        width: ListView.view ? ListView.view.width - 24 : 0
                        implicitHeight: bubble.implicitHeight
                        property bool isUser: model.role === "user"

                        Rectangle {
                            id: bubble
                            width: Math.min(parent.width, parent.width * 0.92)
                            x: isUser ? parent.width - width : 0
                            implicitHeight: msg.implicitHeight + 18
                            radius: 12
                            color: isUser ? root.colUserBub : root.colAsstBub
                            border.color: isUser ? "transparent" : root.colBorder
                            border.width: isUser ? 0 : 1

                            TextEdit {
                                id: msg
                                anchors.fill: parent
                                anchors.margins: 9
                                text: model.content
                                textFormat: TextEdit.MarkdownText
                                color: root.colText
                                font.pixelSize: 14
                                wrapMode: TextEdit.Wrap
                                readOnly: true
                                selectByMouse: true
                                selectionColor: root.colAccent
                            }
                        }
                    }
                }
                // ---------- live activity (tool/thinking) ----------
                Rectangle {
                    Layout.fillWidth: true
                    visible: root.busy && root.activity.length > 0
                    color: root.colHeader
                    implicitHeight: visible ? actLabel.implicitHeight + 12 : 0
                    Label {
                        id: actLabel
                        anchors.fill: parent
                        anchors.leftMargin: 14; anchors.rightMargin: 14
                        anchors.topMargin: 6;  anchors.bottomMargin: 6
                        text: root.activity
                        color: root.colSubtle
                        font.pixelSize: 12
                        font.italic: true
                        // Show up to 3 wrapped lines (was 1 elided line) so long
                        // bash commands / status text are actually readable.
                        wrapMode: Text.Wrap
                        maximumLineCount: 3
                        elide: Text.ElideRight
                        verticalAlignment: Text.AlignVCenter
                    }
                }
                // ---------- claudebar detail panel (click strip to expand) ----------
                // Full breakdown: every window (session, weekly, per-model) as a row
                // with a bar, used%, pace indicator and reset countdown; plus the
                // extra_usage (spend / balance) block when the API reports it.
                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: root.cbExpanded ? (cbDetailCol.implicitHeight + 12) : 0
                    visible: root.cbExpanded && root.cbErr.length === 0
                    clip: true
                    color: root.colHeader
                    ColumnLayout {
                        id: cbDetailCol
                        width: parent.width - 28
                        x: 14
                        y: 6
                        spacing: 6
                        Repeater {
                            model: root.cbWindows
                            delegate: ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 1
                                required property var modelData
                                RowLayout {
                                    Layout.fillWidth: true
                                    spacing: 6
                                    Label {
                                        // "Session", "Weekly", or "Weekly · Fable" for model rows
                                        text: modelData.group ? (modelData.label + " · " + modelData.group) : modelData.label
                                        color: root.colText; font.pixelSize: 11; font.bold: true
                                    }
                                    Item { Layout.fillWidth: true }
                                    Label {
                                        // pace: e.g. "↓ 81% under" (green) or "↑ over" (amber/red)
                                        text: modelData.pace ? (modelData.pace.indicator + " " + modelData.pace.ratio_label) : ""
                                        color: (modelData.pace && modelData.pace.state === "over") ? root.cbColor(90) : root.colSubtle
                                        font.pixelSize: 10
                                    }
                                }
                                RowLayout {
                                    Layout.fillWidth: true
                                    spacing: 6
                                    Rectangle {   // track
                                        Layout.fillWidth: true; Layout.preferredHeight: 6
                                        radius: 3; color: root.colBorder
                                        Rectangle {   // used fill
                                            height: parent.height; radius: 3
                                            width: parent.width * Math.max(0, Math.min(100, modelData.used_pct)) / 100
                                            color: root.cbColor(modelData.used_pct)
                                        }
                                        Rectangle {   // elapsed-time marker (thin line = how far through the window)
                                            width: 1; height: parent.height
                                            x: parent.width * Math.max(0, Math.min(100, modelData.elapsed_pct)) / 100
                                            color: root.colText; opacity: 0.5
                                        }
                                    }
                                    Label {
                                        text: modelData.used_pct + "%"
                                        color: root.colText; font.pixelSize: 11
                                        Layout.preferredWidth: 30; horizontalAlignment: Text.AlignRight
                                    }
                                }
                                Label {
                                    text: root.cbUntil(modelData.reset_at)
                                    color: root.colSubtle; font.pixelSize: 10
                                }
                            }
                        }
                        // extra_usage: spend this month / prepaid balance / monthly limit
                        Rectangle {
                            Layout.fillWidth: true; height: 1; color: root.colBorder
                            visible: root.cbExtra !== null
                        }
                        Label {
                            visible: root.cbExtra !== null
                            Layout.fillWidth: true
                            text: {
                                if (!root.cbExtra) return "";
                                var e = root.cbExtra; var parts = [];
                                if (e.spent_label)   parts.push("spent " + e.spent_label);
                                if (e.balance_label) parts.push("balance " + e.balance_label);
                                if (e.limit_label)   parts.push("limit " + e.limit_label);
                                return parts.join("  ·  ");
                            }
                            color: root.colSubtle; font.pixelSize: 10; wrapMode: Text.Wrap
                        }
                    }
                }

                // ---------- claudebar usage strip ----------
                // Glanceable Claude plan usage: session (5h) + weekly (7d), each a
                // mini bar coloured along the CLI's own gauge ramp. Hidden until first
                // successful poll. Click to expand the full breakdown.
                Rectangle {
                    Layout.fillWidth: true
                    visible: root.cbSession >= 0 || root.cbErr.length > 0
                    color: root.colHeader
                    implicitHeight: 28
                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 14; anchors.rightMargin: 30
                        spacing: 10
                        // one gauge = label + track + used% text
                        component Gauge: RowLayout {
                            property string tag: ""
                            property int pct: -1
                            spacing: 5
                            Label { text: tag; color: root.colSubtle; font.pixelSize: 11 }
                            Rectangle {   // track
                                Layout.preferredWidth: 46; Layout.preferredHeight: 6
                                radius: 3; color: root.colBorder
                                Rectangle {   // fill
                                    height: parent.height; radius: 3
                                    width: parent.width * Math.max(0, Math.min(100, pct)) / 100
                                    color: root.cbColor(pct)
                                }
                            }
                            Label { text: (pct >= 0 ? pct + "%" : "—"); color: root.colText; font.pixelSize: 11 }
                        }
                        // background AI model, shown just before the plan/subscription.
                        Label {
                            visible: root.cbModel.length > 0
                            text: root.cbModel
                            color: root.colText; font.pixelSize: 11
                        }
                        Label {
                            text: root.cbPlan.length ? root.cbPlan : "Claude"
                            color: root.colAccent; font.pixelSize: 11; font.bold: true
                        }
                        Item { Layout.fillWidth: true }
                        Gauge { tag: "5h";  pct: root.cbSession; visible: root.cbErr.length === 0 }
                        Gauge { tag: "wk";  pct: root.cbWeekly;  visible: root.cbErr.length === 0 }
                        Label {
                            visible: root.cbErr.length > 0
                            text: "usage: " + root.cbErr
                            color: root.colSubtle; font.pixelSize: 11; font.italic: true
                        }
                    }
                    // chevron toggle that expands the full breakdown — enlarged so it's
                    // an easy tap target (below the MouseArea; z keeps it painted).
                    Label {
                        anchors.right: parent.right; anchors.rightMargin: 12
                        anchors.verticalCenter: parent.verticalCenter
                        // closed = up (▴, "click to open upward"); open = down (▾, "click to
                        // collapse") — mirrors the real motion of the panel opening/closing.
                        text: root.cbExpanded ? "▾" : "▴"
                        color: root.colAccent; font.pixelSize: 18; font.bold: true
                        z: 1
                    }
                    // MouseArea declared LAST so it sits above the RowLayout + chevron and
                    // actually receives clicks (layout children were eating them before).
                    MouseArea {
                        anchors.fill: parent
                        z: 2
                        cursorShape: Qt.PointingHandCursor
                        // Click toggles the detail panel; opening it also forces a refresh.
                        onClicked: {
                            root.cbExpanded = !root.cbExpanded;
                            if (root.cbExpanded) { root.cbBuf = ""; root.cbForceRefresh = true; cbProc.running = true; }
                        }
                    }
                }

                // separator above the input — colScallop (solid black) not colBorder:
                // the grey #222 line read as "a light grey line at the bottom".
                Rectangle { Layout.fillWidth: true; height: 1; color: root.colScallop }

                // ---------- input ----------
                Rectangle {
                    Layout.fillWidth: true
                    color: root.colHeader
                    implicitHeight: inputRow.implicitHeight + 16
                    RowLayout {
                        id: inputRow
                        anchors.fill: parent
                        anchors.margins: 8
                        spacing: 8

                        Rectangle {
                            Layout.fillWidth: true
                            radius: 10
                            color: root.colInputBg
                            border.color: input.activeFocus ? root.colAccent : root.colBorder
                            border.width: 1
                            implicitHeight: Math.min(Math.max(input.implicitHeight + 14, 40), 160)

                            ScrollView {
                                anchors.fill: parent
                                anchors.margins: 6
                                TextArea {
                                    id: input
                                    placeholderText: "Message OpenClaw…"
                                    placeholderTextColor: root.colSubtle
                                    color: root.colText
                                    font.pixelSize: 14
                                    wrapMode: TextArea.Wrap
                                    background: null
                                    selectByMouse: true
                                    selectionColor: root.colAccent
                                    // input stays live even while a turn is in flight; sends queue
                                    // Enter sends, Shift+Enter = newline
                                    Keys.onPressed: function(ev) {
                                        if ((ev.key === Qt.Key_Return || ev.key === Qt.Key_Enter) && !(ev.modifiers & Qt.ShiftModifier)) {
                                            root.sendMessage(input.text);
                                            input.clear();
                                            ev.accepted = true;
                                        } else if (ev.key === Qt.Key_Escape) {
                                            if (!root.pinned) root.shown = false;
                                            ev.accepted = true;
                                        }
                                    }
                                }
                            }
                        }

                        Button {
                            text: "Send"
                            enabled: input.text.trim().length > 0
                            onClicked: { root.sendMessage(input.text); input.clear(); }
                            contentItem: Label {
                                text: parent.text
                                color: parent.enabled ? "#11111b" : root.colSubtle
                                font.pixelSize: 13; font.bold: true
                                horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
                            }
                            background: Rectangle {
                                radius: 10
                                color: parent.enabled ? (parent.down ? Qt.darker(root.colAccent, 1.2) : root.colAccent) : root.colBorder
                            }
                            Layout.preferredHeight: 40
                        }

                        // ---------- mic / voice-input toggle ----------
                        // Rightmost control (after Send). Toggles root.voiceOn;
                        // starts/stops the dictation helper (records -> transcribes ->
                        // appends the text into the input box). Mauve + pulsing while armed.
                        Rectangle {
                            id: micBtn
                            Layout.preferredWidth: 40
                            Layout.preferredHeight: 40
                            radius: 10
                            // armed = solid mauve; idle = subtle grey fill so it's
                            // clearly visible against the black panel (the emoji glyph
                            // renders monochrome here, so the BUTTON must carry the look).
                            color: root.voiceOn ? root.colAccent
                                   : (micMouse.containsMouse ? "#33cba6f7" : "#22ffffff")
                            border.color: root.voiceOn ? root.colAccent : root.colAccent
                            border.width: root.voiceOn ? 0 : 1
                            // Drawn mic glyph (no emoji dependency): a capsule + stand.
                            Item {
                                anchors.centerIn: parent
                                width: 18; height: 22
                                property color mc: root.voiceOn ? "#11111b" : root.colAccent
                                Rectangle {   // capsule (the mic body)
                                    anchors.horizontalCenter: parent.horizontalCenter
                                    y: 0; width: 8; height: 12; radius: 4
                                    color: parent.mc
                                }
                                Rectangle {   // arc/stand under the capsule
                                    anchors.horizontalCenter: parent.horizontalCenter
                                    y: 9; width: 14; height: 8; radius: 6
                                    color: "transparent"
                                    border.color: parent.mc; border.width: 2
                                }
                                Rectangle {   // stem
                                    anchors.horizontalCenter: parent.horizontalCenter
                                    y: 16; width: 2; height: 5; color: parent.mc
                                }
                                Rectangle {   // base
                                    anchors.horizontalCenter: parent.horizontalCenter
                                    y: 20; width: 10; height: 2; radius: 1; color: parent.mc
                                }
                            }
                            // pulsing while listening
                            SequentialAnimation on opacity {
                                running: root.voiceOn
                                loops: Animation.Infinite
                                NumberAnimation { to: 0.55; duration: 650; easing.type: Easing.InOutQuad }
                                NumberAnimation { to: 1.0;  duration: 650; easing.type: Easing.InOutQuad }
                            }
                            onVisibleChanged: if (!visible) opacity = 1.0
                            MouseArea {
                                id: micMouse
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: root.toggleVoice()
                            }
                        }
                    }
                }

                // ---------- launcher bar (icons launch; the + on the right edits shortcuts) ----------
                // Bottom bar must be SOLID black (not 80% colHeader): it's the last strip
                // before the screen edge, so any transparency lets the desktop show through
                // as a pale band that curves up around the + — reads as a light border.
                Rectangle {
                    Layout.fillWidth: true
                    color: root.colScallop
                    // NO bottomRightRadius: same reason as the header — a radius here notches
                    // the corner and exposes bg's 80%-alpha fill as the grey line at the
                    // bottom. The external scallop Canvas already rounds the visible corner.
                    implicitHeight: Math.max(launchFlow.implicitHeight, 38) + 12

                    Flow {
                        id: launchFlow
                        anchors { left: parent.left; right: addBtn.left; verticalCenter: parent.verticalCenter }
                        anchors.leftMargin: 8; anchors.rightMargin: 6
                        spacing: 6

                        Repeater {
                            model: root.shortcuts
                            delegate: Button {
                                id: scBtn
                                required property var modelData
                                required property int index
                                readonly property bool hasIcon: modelData.icon !== undefined && ("" + modelData.icon).length > 0
                                readonly property bool isTerm: modelData.terminal === true
                                onClicked: root.launch(modelData.cmd)
                                ToolTip.text: modelData.label + " — " + modelData.cmd; ToolTip.visible: hovered; ToolTip.delay: 500
                                padding: 0
                                implicitWidth: 46; implicitHeight: 38
                                contentItem: Item {
                                    // text fallback for custom shortcuts that have no icon set
                                    Label {
                                        anchors.centerIn: parent
                                        visible: !scBtn.hasIcon
                                        text: modelData.label; color: root.colText; font.pixelSize: 12
                                    }
                                    // plain GUI icon
                                    Image {
                                        anchors.centerIn: parent
                                        visible: scBtn.hasIcon && !scBtn.isTerm
                                        source: scBtn.hasIcon ? "file://" + modelData.icon : ""
                                        sourceSize.width: 22; sourceSize.height: 22
                                        width: 22; height: 22; smooth: true; mipmap: true
                                    }
                                    // CLI: same icon inside a bordered box that reads as a console
                                    Rectangle {
                                        anchors.centerIn: parent
                                        visible: scBtn.hasIcon && scBtn.isTerm
                                        width: 30; height: 26; radius: 4
                                        color: "transparent"
                                        border.color: root.colSubtle; border.width: 1
                                        Image {
                                            anchors.centerIn: parent
                                            source: scBtn.hasIcon ? "file://" + modelData.icon : ""
                                            sourceSize.width: 15; sourceSize.height: 15
                                            width: 15; height: 15; smooth: true; mipmap: true
                                        }
                                        // tiny prompt glyph in the corner to sell the "terminal" read
                                        Text {
                                            anchors { left: parent.left; bottom: parent.bottom; leftMargin: 2 }
                                            text: "›"; color: root.colSubtle; font.pixelSize: 10; font.bold: true
                                        }
                                    }
                                }
                                background: Rectangle {
                                    radius: 8
                                    color: scBtn.down ? Qt.darker(root.colAccent, 1.3)
                                         : scBtn.hovered ? root.colBorder : "#ff141414"
                                    border.color: root.colBorder; border.width: 1
                                }
                            }
                        }
                    }

                    // add/edit shortcuts — pinned to the right edge of the bar
                    Button {
                        id: addBtn
                        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                        anchors.rightMargin: 8
                        implicitWidth: 34; implicitHeight: 34
                        padding: 0
                        onClicked: root.prefsOpen = true
                        ToolTip.text: "Add / edit shortcuts"; ToolTip.visible: hovered; ToolTip.delay: 500
                        contentItem: Label {
                            text: "+"; color: root.colAccent
                            font.pixelSize: 20; font.bold: true
                            horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
                        }
                        background: Rectangle {
                            radius: 8
                            color: addBtn.down ? Qt.darker(root.colAccent, 1.3)
                                 : addBtn.hovered ? root.colBorder : "#ff141414"
                            border.color: root.colBorder; border.width: 1
                        }
                    }
                }
            }

            // ---------- preferences overlay (manage launcher shortcuts) ----------
            Rectangle {
                anchors.fill: parent
                visible: root.prefsOpen
                z: 100
                color: "#cc000000"          // scrim
                MouseArea { anchors.fill: parent; onClicked: {} }   // swallow clicks to the scrim

                Rectangle {
                    anchors.centerIn: parent
                    width: Math.min(parent.width - 32, root.panelWidth - 24)
                    implicitHeight: prefsCol.implicitHeight + 28
                    radius: 14
                    color: root.colBg
                    border.color: root.colBorder; border.width: 1

                    ColumnLayout {
                        id: prefsCol
                        anchors.fill: parent
                        anchors.margins: 14
                        spacing: 10

                        Label { text: "Launcher shortcuts"; color: root.colText; font.pixelSize: 15; font.bold: true }
                        Label {
                            text: "Left-click a button to launch. Command runs via sh -lc."
                            color: root.colSubtle; font.pixelSize: 11
                            Layout.fillWidth: true; wrapMode: Text.Wrap
                        }

                        Repeater {
                            model: root.shortcuts
                            delegate: RowLayout {
                                required property var modelData
                                required property int index
                                Layout.fillWidth: true
                                spacing: 8

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 0
                                    Label { text: modelData.label; color: root.colText; font.pixelSize: 13; font.bold: true }
                                    Label {
                                        text: modelData.cmd; color: root.colSubtle; font.pixelSize: 11
                                        elide: Text.ElideRight; Layout.fillWidth: true
                                    }
                                }
                                Button {
                                    text: "✕"
                                    onClicked: root.removeShortcut(index)
                                    implicitWidth: 30; implicitHeight: 30
                                    contentItem: Label { text: parent.text; color: root.colSubtle; font.pixelSize: 14; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                                    background: Rectangle { radius: 6; color: parent.hovered ? "#ff3a1420" : "transparent"; border.color: root.colBorder; border.width: 1 }
                                }
                            }
                        }

                        Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: root.colBorder }

                        // add form
                        TextField {
                            id: newLabel
                            Layout.fillWidth: true
                            placeholderText: "Label (e.g. Btop)"
                            placeholderTextColor: root.colSubtle
                            color: root.colText; font.pixelSize: 13
                            background: Rectangle { radius: 8; color: root.colInputBg; border.color: newLabel.activeFocus ? root.colAccent : root.colBorder; border.width: 1 }
                        }
                        TextField {
                            id: newCmd
                            Layout.fillWidth: true
                            placeholderText: "Command (e.g. kitty btop)"
                            placeholderTextColor: root.colSubtle
                            color: root.colText; font.pixelSize: 13
                            background: Rectangle { radius: 8; color: root.colInputBg; border.color: newCmd.activeFocus ? root.colAccent : root.colBorder; border.width: 1 }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 8
                            Button {
                                text: "Add"
                                enabled: newLabel.text.trim().length > 0 && newCmd.text.trim().length > 0
                                onClicked: { root.addShortcut(newLabel.text, newCmd.text); newLabel.clear(); newCmd.clear(); }
                                contentItem: Label { text: parent.text; color: parent.enabled ? "#11111b" : root.colSubtle; font.pixelSize: 13; font.bold: true; horizontalAlignment: Text.AlignHCenter }
                                background: Rectangle { radius: 8; color: parent.enabled ? root.colAccent : root.colBorder }
                                leftPadding: 16; rightPadding: 16; topPadding: 7; bottomPadding: 7
                            }
                            Item { Layout.fillWidth: true }
                            Button {
                                text: "Close"
                                onClicked: root.prefsOpen = false
                                contentItem: Label { text: parent.text; color: root.colText; font.pixelSize: 13; horizontalAlignment: Text.AlignHCenter }
                                background: Rectangle { radius: 8; color: parent.hovered ? root.colBorder : "transparent"; border.color: root.colBorder; border.width: 1 }
                                leftPadding: 16; rightPadding: 16; topPadding: 7; bottomPadding: 7
                            }
                        }
                    }
                }
            }
        }
    }
}
