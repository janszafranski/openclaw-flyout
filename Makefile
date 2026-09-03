# OpenClaw flyout — convenience wrapper around the per-user install scripts.
# This is a user-level app (it installs into $HOME/.local and $HOME/.config,
# and enables a `systemctl --user` service), so there is no system PREFIX to
# stage into — `make install` simply runs the same install.sh a user would.

.PHONY: all install uninstall check help

all: help

help:
	@echo "OpenClaw flyout"
	@echo "  make install     deploy panel + bridge + service into your \$$HOME, wire Super+O"
	@echo "  make uninstall   remove everything this installed"
	@echo "  make check       syntax-check the bridge (node) and panel (qs)"

install:
	./install.sh

uninstall:
	./uninstall.sh

# Best-effort static checks — skipped silently if the tool isn't present.
check:
	@command -v node >/dev/null 2>&1 && node --check bin/openclaw-ai-bridge.js && echo "bridge: OK" || echo "bridge: node not found, skipped"
	@command -v bash >/dev/null 2>&1 && bash -n install.sh && bash -n uninstall.sh && bash -n bin/openclaw-cli-chat.sh && echo "scripts: OK" || echo "scripts: bash not found, skipped"
