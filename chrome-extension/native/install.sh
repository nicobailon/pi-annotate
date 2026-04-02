#!/bin/bash
set -e

print_help() {
  cat <<'EOF'
Pi Annotate Native Host Installer

Usage: ./install.sh <extension-id> [options]

Arguments:
  extension-id             Browser extension ID (32 lowercase letters a-p)

Options:
  -b, --browser <list>     Browser(s) to install for. Default: chrome
                           Values: chrome, brave, all
                           Multiple: --browser chrome,brave
  -h, --help               Show this help

Examples:
  ./install.sh abcdefghijklmnopabcdefghijklmnop
  ./install.sh abcdefghijklmnopabcdefghijklmnop --browser brave
  ./install.sh abcdefghijklmnopabcdefghijklmnop --browser all
EOF
}

EXTENSION_ID=""
BROWSER_ARG="chrome"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -b|--browser)
      shift
      if [[ -z "$1" ]]; then
        echo "Error: Missing value for --browser"
        print_help
        exit 1
      fi
      BROWSER_ARG="${1,,}"
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    -*)
      echo "Error: Unknown option: $1"
      print_help
      exit 1
      ;;
    *)
      if [[ -z "$EXTENSION_ID" ]]; then
        EXTENSION_ID="$1"
      else
        echo "Error: Unexpected extra argument: $1"
        print_help
        exit 1
      fi
      ;;
  esac
  shift
done

if [[ -z "$EXTENSION_ID" ]]; then
  print_help
  echo "Get the extension ID from chrome://extensions or brave://extensions after loading unpacked"
  exit 1
fi

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Error: Invalid extension ID format"
  echo "Expected 32 lowercase letters (a-p)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/host.cjs"

# Find node path (GUI-launched browsers may not have node in PATH)
NODE_PATH=$(which node 2>/dev/null || echo "")
if [[ -z "$NODE_PATH" ]]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -x "$p" ]]; then
      NODE_PATH="$p"
      break
    fi
  done
fi

if [[ -z "$NODE_PATH" ]]; then
  echo "Error: Could not find node. Please install Node.js."
  exit 1
fi

echo "Using node at: $NODE_PATH"

# Create wrapper script with absolute node path
HOST_PATH="$SCRIPT_DIR/host-wrapper.sh"
cat > "$HOST_PATH" << EOF
#!/bin/bash
exec "$NODE_PATH" "$HOST_SCRIPT" "\$@"
EOF

chmod +x "$HOST_PATH"
chmod +x "$HOST_SCRIPT"

get_manifest_dir() {
  local browser="$1"

  case "$browser" in
    chrome)
      if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      else
        echo "$HOME/.config/google-chrome/NativeMessagingHosts"
      fi
      ;;
    brave)
      if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      else
        echo "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      fi
      ;;
    *)
      return 1
      ;;
  esac
}

BROWSERS=()
if [[ "$BROWSER_ARG" == "all" ]]; then
  BROWSERS=(chrome brave)
else
  IFS=',' read -r -a BROWSERS <<< "$BROWSER_ARG"
fi

INSTALLED=()
for browser in "${BROWSERS[@]}"; do
  browser="${browser// /}"
  if [[ -z "$browser" ]]; then
    continue
  fi

  MANIFEST_DIR=$(get_manifest_dir "$browser") || {
    echo "Error: Unsupported browser: $browser"
    echo "Supported values: chrome, brave, all"
    exit 1
  }

  mkdir -p "$MANIFEST_DIR"
  MANIFEST_PATH="$MANIFEST_DIR/com.pi.annotate.json"

  cat > "$MANIFEST_PATH" << EOF
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

  INSTALLED+=("$browser:$MANIFEST_PATH")
done

echo "Installed native host manifest(s):"
for entry in "${INSTALLED[@]}"; do
  echo "  $entry"
done

echo "Restart your browser for changes to take effect."
