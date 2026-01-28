<p>
  <img src="banner.png" alt="Pi Annotate" width="1100">
</p>

# Pi Annotate

**Visual annotation for AI. Click elements, capture screenshots, fix code.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=for-the-badge)]()

```bash
/annotate                        # Open picker on current tab
# Click elements → Note cards appear inline
# Add per-element comments → Submit
```

Figma-like annotation experience with floating inline note cards. DevTools-like element picker in vanilla JS.

## Highlights

- **Inline note cards** — Each selected element gets a draggable floating note card
- **Per-element comments** — Add specific instructions for each element
- **Per-element screenshots** — Each selected element gets its own cropped image
- **📷 toggle per element** — Choose which elements to screenshot
- **Vanilla JS** — No build step, no framework
- **SVG connectors** — Curved lines connect notes to elements

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
5. **Click the Pi Annotate extension icon** in toolbar
6. Click **Copy** next to the install command
7. Run the copied command in `chrome-extension/native/`

```bash
./install.sh <extension-id>
```

Restart Chrome after installation. The popup will show **Connected** when ready.

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
```

| Action | How |
|--------|-----|
| **Select element** | Click on page → Note card auto-opens |
| **Cycle ancestors** | Scroll wheel while hovering |
| **Multi-select** | Toggle "Multi" mode or Shift+click |
| **Add comment** | Type in note card textarea |
| **Toggle screenshot** | 📷 button in note card header |
| **Reposition note** | Drag note card by header |
| **Scroll to element** | Click selector in note card |
| **Toggle note** | Click numbered badge on element |
| **Expand/collapse all** | ▼/▲ buttons in toolbar |
| **Full page screenshot** | Click "Full" in screenshot toggle |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘/Ctrl+Shift+P` | Toggle annotation UI |
| `ESC` | Close annotation UI |
| `Scroll` | Cycle through ancestor elements |
| `Shift+Click` | Add to selection (multi-select) |
| `Click hover preview` | Copy selector to clipboard |

## Features

**Element Picker**
- Hover highlights with element info tooltip
- Click to select → Note card auto-opens
- Scroll wheel cycles through ancestor elements
- Clickable badges toggle notes open/closed

**Inline Note Cards**
- **Draggable** — Reposition anywhere by dragging header
- **Per-element comments** — Dedicated textarea for each element
- **SVG connectors** — Curved dashed lines link notes to elements
- **Scroll to element** — Click selector to bring element into view
- **Screenshot toggle** — 📷 button per note card

**Smart Screenshots**
- **Individual crops** — Each element gets its own focused screenshot
- **20px padding** — Clean cropping with breathing room
- **Full page option** — Override to capture entire viewport
- **Per-element toggle** — Disable screenshots on specific elements

**Simplified Panel**
- Mode toggles (Single/Multi) for selection behavior
- Screenshot mode (Each/Full/None)
- Context input for overall description
- Expand/collapse all notes buttons

## Output Format

```markdown
## Page Annotation: https://example.com
**Viewport:** 1440×900

**Context:** Fix the styling issues on this page

### Selected Elements (2)

1. **button**
   - Selector: `#submit-btn`
   - ID: `submit-btn`
   - Classes: `btn, btn-primary`
   - Text: "Submit"
   - Size: 120×40px
   - **Comment:** Make this blue with rounded corners

2. **div**
   - Selector: `.error-message`
   - Classes: `error-message, hidden`
   - Text: "Please fill required fields"
   - Size: 300×20px
   - **Comment:** This should appear in red, not hidden

### Screenshots

- Element 1: /var/folders/.../pi-annotate-1706012345678-el1.png
- Element 2: /var/folders/.../pi-annotate-1706012345678-el2.png
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

### Security

- **Auth token** — Native host generates a per-run token at `/tmp/pi-annotate.token`
- **Socket permissions** — Socket and token files created with 0600 permissions
- **Message validation** — Schema checks drop malformed messages

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
    ├── content.js        # Element picker UI
    ├── popup.html        # Extension popup (status + setup)
    ├── popup.js          # Popup logic + connection check
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
| Native host not connecting | Click extension icon to check status; re-run install command |
| "Extension ID mismatch" | Copy install command from popup and re-run |
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
