#!/bin/bash
# Pi Annotate native messaging host installer.
#
#   ./install.sh <extension-id>            # full install: wrapper + manifest
#   ./install.sh --heal                    # regenerate wrapper only (keeps existing manifest)
#
# Chrome spawns the native host by absolute path, so we bake a wrapper script
# that `exec`s the real node binary with host.cjs. This script resolves node
# via `process.execPath` so it picks the concrete installation, not an
# ephemeral fnm/nvm shim that disappears with the shell session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/host.cjs"
HOST_PATH="$SCRIPT_DIR/host-wrapper.sh"

if [[ "$OSTYPE" == "darwin"* ]]; then
  MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
else
  MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi
MANIFEST_PATH="$MANIFEST_DIR/com.pi.annotate.json"

# ──────────────────────────────────────────────────────────────────────
# Mode parsing
# ──────────────────────────────────────────────────────────────────────
MODE="install"
EXTENSION_ID=""
case "${1:-}" in
  "")
    echo "Usage: $0 <extension-id>"
    echo "       $0 --heal"
    echo ""
    echo "Get the extension ID from chrome://extensions after loading unpacked."
    exit 1
    ;;
  --heal)
    MODE="heal"
    if [ ! -f "$MANIFEST_PATH" ]; then
      echo "error: no existing manifest at $MANIFEST_PATH — run with <extension-id> first" >&2
      exit 1
    fi
    ;;
  *)
    EXTENSION_ID="$1"
    ;;
esac

# ──────────────────────────────────────────────────────────────────────
# Resolve a stable node executable.
#
# The shell's `node` command on fnm/nvm/volta is a shim that lives under an
# ephemeral per-session directory (fnm_multishells/<pid>_<ts>/bin/node,
# .nvm/versions/node/.../alias/...). Chrome runs outside that session and
# the path is gone by the time it spawns the host. `process.execPath` on
# node itself is always the concrete installation path, so we use that.
# ──────────────────────────────────────────────────────────────────────
NODE_SHIM=$(command -v node 2>/dev/null || echo "")
NODE_PATH=""
if [ -n "$NODE_SHIM" ]; then
  NODE_PATH=$("$NODE_SHIM" -e "console.log(process.execPath)" 2>/dev/null || true)
fi

# Fallback to common system paths if the shim trick fails.
if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$p" ]; then
      NODE_PATH="$p"
      break
    fi
  done
fi

if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  echo "error: could not find a usable node binary. Install Node.js and retry." >&2
  exit 1
fi

# Refuse ephemeral paths that would break the moment the current shell exits.
case "$NODE_PATH" in
  *fnm_multishells*)
    echo "error: resolved node path is an ephemeral fnm shim: $NODE_PATH" >&2
    echo "hint : set a default fnm version (e.g. 'fnm default 22 && fnm use default')" >&2
    echo "       and re-run this installer from a fresh shell." >&2
    exit 1
    ;;
  */.nvm/alias/*)
    echo "error: resolved node path is an nvm alias shim: $NODE_PATH" >&2
    echo "hint : use the concrete installation path, e.g. ~/.nvm/versions/node/vXX.Y.Z/bin/node" >&2
    exit 1
    ;;
esac

echo "Using node at: $NODE_PATH"

# ──────────────────────────────────────────────────────────────────────
# Wrapper
# ──────────────────────────────────────────────────────────────────────
cat > "$HOST_PATH" <<EOF
#!/bin/bash
exec "$NODE_PATH" "$HOST_SCRIPT" "\$@"
EOF
chmod +x "$HOST_PATH" "$HOST_SCRIPT"
echo "Wrote wrapper:    $HOST_PATH"

if [ "$MODE" = "heal" ]; then
  # Verify the existing manifest still points at our wrapper; if not, warn.
  if ! grep -q "\"path\": \"$HOST_PATH\"" "$MANIFEST_PATH"; then
    echo "warning: manifest at $MANIFEST_PATH does not point at $HOST_PATH" >&2
    echo "         run '$0 <extension-id>' to regenerate it" >&2
  else
    echo "Manifest OK:      $MANIFEST_PATH"
  fi
  exit 0
fi

# ──────────────────────────────────────────────────────────────────────
# Manifest
# ──────────────────────────────────────────────────────────────────────
mkdir -p "$MANIFEST_DIR"
cat > "$MANIFEST_PATH" <<EOF
{
  "name": "com.pi.annotate",
  "description": "Pi Annotate native messaging host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
echo "Wrote manifest:   $MANIFEST_PATH"
echo ""
echo "Restart Chrome for changes to take effect."
echo "Tip: rerun '$0 --heal' after any 'npm i -g pi-annotate' to regenerate the wrapper."
