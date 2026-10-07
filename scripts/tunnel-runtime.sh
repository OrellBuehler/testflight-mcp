#!/bin/sh
set -eu
umask 077
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
ROOT=$(dirname -- "$SCRIPT_DIR")
NODE_PATH=$(/bin/cat "$ROOT/.local/runtime/node-path" 2>/dev/null || true)
case "$NODE_PATH" in
  /*) exec "$NODE_PATH" "$SCRIPT_DIR/tunnel-runtime.mjs" ;;
  *) exit 78 ;;
esac
