#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
ROOT=$(dirname -- "$SCRIPT_DIR")
if [ -r "$ROOT/.local/runtime/node-path" ]; then
  NODE_PATH=$(/bin/cat "$ROOT/.local/runtime/node-path" 2>/dev/null || true)
  case "$NODE_PATH" in
    /*) exec "$NODE_PATH" "$SCRIPT_DIR/tunnel.mjs" toggle ;;
  esac
fi
export TESTFLIGHT_MCP_TUNNEL_MANAGER="$SCRIPT_DIR/tunnel.mjs"
exec /bin/zsh -lic 'exec node "$TESTFLIGHT_MCP_TUNNEL_MANAGER" toggle'
