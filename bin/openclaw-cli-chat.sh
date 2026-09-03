#!/usr/bin/env bash
# openclaw-cli-chat.sh — flyout ↗ hand-off.
#
# Launched by the OpenClaw sidebar's ↗ button. Runs the CLI chat on the same
# session as the flyout, and — however the chat exits (type /exit, Ctrl+D, or
# Ctrl+C) — brings the flyout back, shown + pinned ("locked"), with the same
# conversation.
#
# NOTE (2026-09-01, OpenClaw 2026.8.1): `openclaw chat` was renamed/aliased to
# `openclaw tui` and now DEFAULTS TO --local (embedded runtime), which refuses to
# start when a Gateway is already running for this state dir — it printed
# "A Gateway is running ... Run without --local" and exited instantly, so the ↗
# terminal flashed open and closed (trap fired → flyout re-locked). Use `tui`
# explicitly (no --local) so it CONNECTS to the running Gateway over ws:// and
# stays open on the shared ai-flyout session.
#
# NOTE (2026-09-03): trap EXIT alone was NOT enough. Super+Q is bound in
# hyprland.lua to `window.close()`, which SIGTERMs alacritty; the child bash then
# gets SIGHUP and terminates WITHOUT running its EXIT trap — so the flyout never
# reopened. Trapping HUP/INT/TERM explicitly (calling the same reopen, then
# re-raising) makes the return fire however the terminal dies: /exit, Ctrl+C,
# Ctrl+D, OR super+Q closing the window.
set -u
# quickshell `ipc call` matches instances BY WAYLAND DISPLAY: with WAYLAND_DISPLAY
# unset the CLI reports "No running instances ... on the current display 'unk'"
# and the reopen SILENTLY no-ops (rc still 0). The flyout→alacritty→here chain
# normally inherits WAYLAND_DISPLAY, but pin it defensively so the reopen can
# never miss if a future launch path strips the env. (2026-09-03)
: "${WAYLAND_DISPLAY:=wayland-1}"
export WAYLAND_DISPLAY
reopen() { qs -c openclaw-sidebar ipc call sidebar lock >/dev/null 2>&1; }
# On a killing signal: reopen, disarm both traps (avoid a double reopen), then
# re-raise that signal so the shell dies with the conventional status.
on_sig() { local s="$1"; reopen; trap - EXIT HUP INT TERM; kill -s "$s" $$; }
trap reopen EXIT
trap 'on_sig HUP' HUP
trap 'on_sig INT' INT
trap 'on_sig TERM' TERM
openclaw tui --session ai-flyout "$@"
