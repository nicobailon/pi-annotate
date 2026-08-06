#!/bin/bash
set -euo pipefail

EXTENSION_ID="${1:-}"
if [ -z "$EXTENSION_ID" ]; then
  echo "Usage: $0 <extension-id>"
  echo "Get the extension ID from chrome://extensions after loading unpacked"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/host.cjs"

# Chrome does not inherit the shell PATH. Ask Node for its real executable path
# instead of saving a fnm/asdf/mise shim that can disappear after this shell exits.
NODE_PATH=""
NODE_COMMAND="$(command -v node 2>/dev/null || true)"
if [ -n "$NODE_COMMAND" ]; then
  NODE_PATH="$("$NODE_COMMAND" -p 'process.execPath' 2>/dev/null || true)"
fi

case "$NODE_PATH" in
  *fnm_multishells*|*/.asdf/shims/*|*/mise/shims/*)
    NODE_PATH=""
    ;;
esac

if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  for path in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$path" ]; then
      NODE_PATH="$path"
      break
    fi
  done
fi

if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  echo "Error: Could not find a stable Node.js executable. Install Node.js or configure a default fnm/asdf/mise version."
  exit 1
fi

echo "Using node at: $NODE_PATH"

# Create wrapper script with absolute node path (Chrome's PATH doesn't include homebrew)
HOST_PATH="$SCRIPT_DIR/host-wrapper.sh"
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
