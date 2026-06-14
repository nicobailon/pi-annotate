#!/bin/bash
set -e

EXTENSION_ID="$1"
if [ -z "$EXTENSION_ID" ]; then
  echo "Usage: $0 <extension-id>"
  echo "Get the extension ID from chrome://extensions after loading unpacked"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/host.cjs"

# Resolve the real Node executable. Chrome may not inherit the user's shell PATH,
# and version-manager shims can disappear after the install shell exits.
NODE_PATH=$(node -p 'process.execPath' 2>/dev/null || echo "")
if [ -z "$NODE_PATH" ]; then
  # Try common locations when node is not on PATH.
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$p" ]; then
      NODE_PATH="$p"
      break
    fi
  done
fi

if [ -z "$NODE_PATH" ]; then
  echo "Error: Could not find node. Please install Node.js."
  exit 1
fi

case "$NODE_PATH" in
  *fnm_multishells*|*/.nvm/alias/*)
    echo "Error: Node resolved to a temporary version-manager path: $NODE_PATH"
    echo "Configure a stable default Node version, then rerun this installer."
    exit 1
    ;;
esac

echo "Using node at: $NODE_PATH"

# Create a machine-local wrapper with absolute paths. This file is generated and
# intentionally not tracked or published.
HOST_PATH="$SCRIPT_DIR/host-wrapper.local.sh"
cat > "$HOST_PATH" << EOF
#!/bin/bash
exec "$NODE_PATH" "$HOST_SCRIPT" "\$@"
EOF

chmod +x "$HOST_PATH"
chmod +x "$HOST_SCRIPT"

if [[ "$OSTYPE" == "darwin"* ]]; then
  MANIFEST_DIRS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  )
else
  CONFIG_HOME="${CHROME_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}"
  MANIFEST_DIRS=(
    "$CONFIG_HOME/google-chrome/NativeMessagingHosts"
    "$CONFIG_HOME/google-chrome-for-testing/NativeMessagingHosts"
    "$CONFIG_HOME/chromium/NativeMessagingHosts"
  )
fi

for MANIFEST_DIR in "${MANIFEST_DIRS[@]}"; do
  mkdir -p "$MANIFEST_DIR"

  cat > "$MANIFEST_DIR/com.pi.annotate.json" << EOF
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

  echo "Installed native host manifest to: $MANIFEST_DIR/com.pi.annotate.json"
done

echo "Fully quit and reopen the browser you loaded the extension in."
