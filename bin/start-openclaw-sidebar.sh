#!/usr/bin/env bash
# Launch guard for the OpenClaw flyout: start it only if not already running.
# hyprland.start can fire more than once on boot; this makes repeats a no-op.
# Runs as a plain script path from hl.exec_cmd (no shell operators in the config).
pgrep -f 'qs -c openclaw-sidebar' >/dev/null && exit 0
exec qs -c openclaw-sidebar
