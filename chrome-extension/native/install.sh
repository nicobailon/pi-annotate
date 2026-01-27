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

# Find node path (Chrome may not have node in PATH when launched from Dock)
NODE_PATH=$(which node 2>/dev/null || echo "")
if [ -z "$NODE_PATH" ]; then
  # Try common locations
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
  MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
else
  MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi

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
echo "Restart Chrome for changes to take effect."
