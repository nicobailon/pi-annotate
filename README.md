<p>
  <img src="banner.png" alt="Pi Annotate" width="1100">
</p>

# Pi Annotate

**Visual annotation for AI. Click elements, capture screenshots, fix code.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=for-the-badge)]()

```bash
/annotate                        # Open picker on current tab
# Click elements, toggle 📷 per element
# Submit → Pi receives focused screenshots
```

A simplified, ground-up rewrite focused on reliability and per-element screenshots. DevTools-like element picker in vanilla JS (~800 lines).

## Highlights

- **Per-element screenshots** — Each selected element gets its own cropped image
- **📷 toggle per element** — Choose which elements to screenshot
- **Vanilla JS** — No build step, ~800 lines
- **Parent/Child navigation** — Scroll wheel or buttons to traverse DOM
- **Full page option** — Toggle for entire viewport capture

## Quick Start

### 1. Install Native Host

```bash
cd chrome-extension/native
chmod +x install.sh
./install.sh
```

### 2. Load Chrome Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder
5. Copy the **Extension ID** shown
6. Re-run install script with ID:

```bash
./install.sh <extension-id>
```

Restart Chrome after installation.

### 3. Enable Pi Extension

```bash
# Symlink (for development)
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-annotate
```

Restart Pi to load the extension.

## Usage

```bash
/annotate                  # Annotate current Chrome tab
/annotate https://x.com    # Navigate to URL first
/ann                       # Short alias
```

| Action | How |
|--------|-----|
| **Select element** | Click on page |
| **Cycle parents** | Scroll wheel or ▲/▼ buttons |
| **Multi-select** | Toggle "Multi" mode or Shift+click |
| **Expand/contract** | +/− buttons on chip, or Parent/Child |
| **Toggle screenshot** | 📷 button on each chip |
| **Full page screenshot** | Check "Full page instead" |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `ESC` | Close annotation UI |
| `Scroll` | Cycle through parent elements |
| `Shift+Click` | Add to selection (multi-select) |

## Features

**Element Picker**
- Hover highlights with element info tooltip
- Click to select, visual markers on selections
- Scroll wheel cycles through parent/child elements
- Parent/Child buttons modify selected element

**Smart Screenshots**
- 📷 **Per-element toggle** — Choose which elements get screenshots
- **Individual crops** — Each element gets its own focused screenshot
- **20px padding** — Clean cropping with breathing room
- **Full page option** — Override to capture entire viewport

**Selection Management**
- **+/−** buttons expand to parent or contract to first child
- Chips show element tag, ID, or first class
- Remove individual selections with × button

## Output Format

```markdown
## Page Annotation: https://example.com
**Viewport:** 1440×900

**User's request:** Fix the button styling

### Selected Elements (2)

1. **button**
   - Selector: `#submit-btn`
   - ID: `submit-btn`
   - Classes: `btn, btn-primary`
   - Text: "Submit"
   - Size: 120×40px

2. **div**
   - Selector: `.error-message`
   - Classes: `error-message, hidden`
   - Text: "Please fill required fields"
   - Size: 300×20px

### Screenshots

- Element 1: /tmp/pi-annotate-1234-el1.png
- Element 2: /tmp/pi-annotate-1234-el2.png
```

## Architecture

```
┌─────────────────┐                      ┌───────────────────┐
│  Pi Extension   │◄── Unix Socket ────►│   Native Host     │
│  (index.ts)     │ /tmp/pi-annotate.sock│   (host.cjs)      │
└─────────────────┘                      └─────────┬─────────┘
                                                   │
                                         Native Messaging
                                                   │
                                         ┌─────────▼─────────┐
                                         │ Chrome Extension  │
                                         │ (vanilla JS)      │
                                         └───────────────────┘
```

| Component | Purpose |
|-----------|---------|
| `index.ts` | Pi extension, `/annotate` command + tool |
| `types.ts` | TypeScript types |
| `chrome-extension/content.js` | Element picker UI (vanilla JS) |
| `chrome-extension/background.js` | Native messaging + screenshots |
| `chrome-extension/native/host.cjs` | Socket ↔ native messaging bridge |

### Message Flow

**Starting annotation:**
```
/annotate → Socket → Native Host → Background.js → Content.js → UI appears
```

**Submitting:**
```
Submit → Content.js → Background.js → Native Host → Socket → Pi → LLM
```

## Files

```
pi-annotate/
├── index.ts              # Pi extension (command + tool)
├── types.ts              # TypeScript types
├── package.json
└── chrome-extension/
    ├── manifest.json     # MV3 manifest
    ├── background.js     # Service worker
    ├── content.js        # Element picker (~800 lines)
    └── native/
        ├── host.cjs      # Native messaging host
        ├── host-wrapper.sh
        └── install.sh
```

## Development

### Chrome Extension

No build step — edit `content.js` or `background.js` directly.

After changes: Reload at `chrome://extensions`

### Pi Extension

TypeScript loaded via jiti (no build).

After changes: Restart Pi

### Logs

```bash
# Native host logs
tail -f /tmp/pi-annotate-host.log

# Browser console (content script)
# Open DevTools on any page

# Service worker console
# chrome://extensions → Pi Annotate → "Inspect views: service worker"
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| UI doesn't appear | Refresh page, or check service worker console |
| "Cannot access chrome:// URL" | Normal — navigate to a regular webpage |
| Screenshots not working | Check "Screenshots" checkbox is enabled |
| Native host not connecting | Run `./install.sh <extension-id>` and restart Chrome |
| Socket errors | Check if socket exists: `ls -la /tmp/pi-annotate.sock` |

### Reset Everything

```bash
# Re-install native host
cd chrome-extension/native
./install.sh <extension-id>

# Restart Chrome completely
# Restart Pi
```

### Verify Native Host

```bash
# Check manifest exists
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.pi.annotate.json

# Check host is executable
ls -la ~/.pi/agent/extensions/pi-annotate/chrome-extension/native/host.cjs
```

## Design Philosophy

This is a ground-up rewrite prioritizing simplicity:

- **No React** — Vanilla JS eliminates build complexity
- **Per-element screenshots** — No more giant bounding boxes
- **Simpler state** — No bidirectional chat, just submit
- **Faster iteration** — Edit JS directly, reload extension

## License

MIT
