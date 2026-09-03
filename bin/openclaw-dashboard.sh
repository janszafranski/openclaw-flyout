#!/usr/bin/env bash
# Open the OpenClaw Control UI (web dashboard) with a valid auth token.
#
# Why this exists: the bare URL http://127.0.0.1:18789/ can't authenticate —
# the token lives in the URL fragment (/#<token>). `openclaw dashboard --no-open`
# puts the tokenized URL on the clipboard; we grab it, open it in Floorp (the
# system default here is Brave, which isn't what we want), then restore the
# previous clipboard contents.
set -euo pipefail

notify() { command -v notify-send >/dev/null 2>&1 && notify-send "OpenClaw" "$1" || true; }

prev="$(wl-paste 2>/dev/null || true)"

if ! openclaw dashboard --no-open >/dev/null 2>&1; then
  notify "Dashboard: gateway not reachable (is it running?)"
  exit 1
fi

url="$(wl-paste 2>/dev/null || true)"
case "$url" in
  http*127.0.0.1:18789*) ;;
  *) notify "Dashboard: could not read tokenized URL"; exit 1 ;;
esac

if command -v floorp >/dev/null 2>&1; then
  floorp --new-window "$url" >/dev/null 2>&1 &
else
  xdg-open "$url" >/dev/null 2>&1 &
fi

# Restore the user's previous clipboard (the browser already has the URL as an arg)
[ -n "$prev" ] && printf '%s' "$prev" | wl-copy >/dev/null 2>&1 || true
