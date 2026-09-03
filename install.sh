#!/usr/bin/env bash
# install.sh — install the OpenClaw flyout: a pinnable Quickshell side panel
# (qs -c openclaw-sidebar, Super+O) that chats with your OpenClaw agent via a
# local OpenAI-compatible bridge (127.0.0.1:8787). Run as your normal user.
#
# Layout consumed (this repo):
#   bin/openclaw-ai-bridge.js  bin/openclaw-cli-chat.sh  bin/openclaw-dashboard.sh
#   quickshell/openclaw-sidebar/   (shell.qml + icons/ + shortcuts.json.example)
#   systemd/openclaw-ai-bridge.service
set -euo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log()  { printf '\033[1;36m::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] && die "Run as your normal user, not root."

detect_de() {
  local d="${XDG_CURRENT_DESKTOP:-}:${DESKTOP_SESSION:-}"
  if [[ "$d" == *[Hh]yprland* ]] || pgrep -x Hyprland >/dev/null 2>&1; then echo hyprland
  elif [[ "$d" == *KDE* || "$d" == *plasma* ]] || [[ -n "${KDE_FULL_SESSION:-}" ]] \
       || pgrep -x plasmashell >/dev/null 2>&1; then echo kde
  else echo other; fi
}

# --- prerequisites (warn, don't fail) ----------------------------------------
command -v node     >/dev/null 2>&1 || warn "Node.js not found — needed for the bridge (install 'nodejs')."
command -v qs       >/dev/null 2>&1 || warn "Quickshell (qs) not found — needed for the panel (install 'quickshell')."
command -v sqlite3  >/dev/null 2>&1 || warn "sqlite3 not found — needed to read chat history (install 'sqlite')."
command -v openclaw >/dev/null 2>&1 || warn "The 'openclaw' CLI is not on PATH — the flyout needs OpenClaw installed to answer."

# --- deploy ------------------------------------------------------------------
log "Deploying bridge, panel and helper scripts"
install -Dm755 "$SELF/bin/openclaw-ai-bridge.js" "$HOME/.local/bin/openclaw-ai-bridge.js"
for f in openclaw-cli-chat.sh openclaw-dashboard.sh; do
  [[ -f "$SELF/bin/$f" ]] && install -Dm755 "$SELF/bin/$f" "$HOME/.local/bin/$f"
done
mkdir -p "$HOME/.config/quickshell/openclaw-sidebar"
cp -r "$SELF/quickshell/openclaw-sidebar/." "$HOME/.config/quickshell/openclaw-sidebar/"
# seed shortcuts.json from the example only if the user has none yet (never clobber)
if [[ ! -f "$HOME/.config/quickshell/openclaw-sidebar/shortcuts.json" \
      && -f "$HOME/.config/quickshell/openclaw-sidebar/shortcuts.json.example" ]]; then
  cp "$HOME/.config/quickshell/openclaw-sidebar/shortcuts.json.example" \
     "$HOME/.config/quickshell/openclaw-sidebar/shortcuts.json"
fi

# --- bridge service ----------------------------------------------------------
log "Installing + enabling the bridge service"
install -Dm644 "$SELF/systemd/openclaw-ai-bridge.service" "$HOME/.config/systemd/user/openclaw-ai-bridge.service"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  systemctl --user enable --now openclaw-ai-bridge.service 2>/dev/null \
    || warn "Could not enable the bridge service (no user systemd session?). Start it later with: systemctl --user enable --now openclaw-ai-bridge"
fi

# --- desktop integration -----------------------------------------------------
# The panel is a Quickshell layer-shell surface → needs a WAYLAND session
# (Hyprland or KDE-Wayland; it won't map on X11).
DE="$(detect_de)"; log "Desktop environment: $DE"
[[ "${XDG_SESSION_TYPE:-}" == x11 ]] && warn "X11 session — the panel needs Wayland; it may not appear."
if [[ "$DE" == hyprland ]]; then
  LUA="$HOME/.config/hypr/hyprland.lua"
  MARK_A="-- >>> openclaw-flyout >>>"
  MARK_B="-- <<< openclaw-flyout <<<"
  if [[ -f "$LUA" ]] && grep -q "hl\." "$LUA" && ! grep -qF "$MARK_A" "$LUA"; then
    log "Adding Super+O toggle, autostart and blur rule to hyprland.lua"
    cat >> "$LUA" <<EOF

$MARK_A
hl.exec_cmd("qs -c openclaw-sidebar")
hl.bind(mod .. " + O", hl.dsp.exec_cmd("qs -c openclaw-sidebar ipc call sidebar toggle"), { description = "OpenClaw flyout" })
hl.layer_rule({ name = "openclaw-flyout-noblur", match = { namespace = "openclaw-sidebar" }, blur = false })
$MARK_B
EOF
    command -v hyprctl >/dev/null && hyprctl reload >/dev/null 2>&1 || true
  else
    log "Hyprland rules already present or no Lua config — skipping"
    warn "If you use a plain hyprland.conf, bind manually:"
    warn "  exec-once = qs -c openclaw-sidebar"
    warn "  bind = SUPER, O, exec, qs -c openclaw-sidebar ipc call sidebar toggle"
  fi
else
  # KDE / other: XDG autostart for the panel + a note for the toggle shortcut
  install -Dm644 /dev/stdin "$HOME/.config/autostart/openclaw-sidebar.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=OpenClaw flyout
Exec=qs -c openclaw-sidebar
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
  log "Added XDG autostart for the panel"
  warn "To bind Super+O: System Settings → Shortcuts → Add Command:"
  warn "  qs -c openclaw-sidebar ipc call sidebar toggle"
fi

command -v qs >/dev/null 2>&1 && { log "Launching the panel"; setsid -f qs -c openclaw-sidebar >/dev/null 2>&1 || true; }
cat <<'DONE'

OpenClaw flyout installed.
  • Toggle: Super+O   • Bridge: 127.0.0.1:8787 (systemd --user service)
  • It answers via your OpenClaw agent — make sure OpenClaw is installed and running.
DONE
