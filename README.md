<p>
  <img src="banner.png" alt="Pi Annotate" width="1100">
</p>

# Pi Annotate

**Visual annotation for AI. Click elements, capture screenshots, fix code.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=for-the-badge)]()

```
/annotate
```

Figma-like annotation experience with floating inline note cards. DevTools-like element picker in vanilla JS.

Click elements, add comments, submit. The agent gets selectors, box model, accessibility, screenshots — everything it needs to fix your UI.

https://github.com/user-attachments/assets/d95396a9-bd11-4632-8456-69fd991959f8

## Quick Start

### 1. Install Pi Extension

```bash
pi install npm:pi-annotate
```

Restart pi to load the extension.

### 2. Load Chrome Extension

1. Open `chrome://extensions`, enable **Developer mode**
2. Click **Load unpacked** → select the `chrome-extension/` folder inside the installed package
3. Click the **Pi Annotate icon** in the toolbar

### 3. Install Native Host

The popup shows your extension ID. Click **Copy** next to the install command, then run it from `chrome-extension/native/` in the installed package:

```bash
./install.sh <extension-id>
```

Restart Chrome. The popup will show **Connected** when ready.

## Usage

```bash
/annotate                  # Current Chrome tab
/annotate https://x.com    # Opens URL first
```

| Action | How |
|--------|-----|
| Select element | Click on page |
| Cycle ancestors | Scroll wheel while hovering |
| Multi-select | Toggle "Multi" or Shift+click |
| Add comment | Type in note card textarea |
| Toggle screenshot | 📷 button in note card header |
| Reposition note | Drag by header |
| Scroll to element | Click selector in note card |
| Toggle note | Click numbered badge |
| Expand/collapse all | ▼/▲ buttons in toolbar |
| Toggle annotation UI | `⌘/Ctrl+Shift+P` |
| Close | `ESC` |

## Features

**Context Capture** — Each element automatically gets box model breakdown (padding, border, margin), accessibility info (role, name, focusable, ARIA states), all HTML attributes, and key CSS styles (display, position, overflow, colors, typography). Enable **Debug mode** for computed styles (40+ properties), parent context, and CSS variables.

**Inline Note Cards** — Draggable floating cards with per-element comments, SVG connectors linking notes to elements, click-to-scroll, and per-element screenshot toggles.

**Screenshots** — Individual crops per element (20px padding) or full-page mode with numbered badges drawn on the screenshot to identify elements. Toggle per element with the 📷 button.

**Restricted Tabs** — If the current tab is `chrome://` or other restricted URLs, providing a URL opens a new tab automatically. Popup button and keyboard shortcut auto-inject the content script on fresh tabs.

## Output

```markdown
## Page Annotation: https://example.com
**Viewport:** 1440×900

**Context:** Fix the styling issues

### Selected Elements (2)

1. **button**
   - Selector: `#submit-btn`
   - ID: `submit-btn`
   - Classes: `btn, btn-primary`
   - Text: "Submit"
   - **Box Model:** 120×40 (content: 96×24, padding: 8 16, border: 1, margin: 0 8)
   - **Attributes:** type="submit", data-testid="submit"
   - **Styles:** display: flex, backgroundColor: rgb(59, 130, 246)
   - **Accessibility:** role=button, name="Submit", focusable=true, disabled=false
   - **Comment:** Make this blue with rounded corners

2. **div**
   - Selector: `.error-message`
   - Classes: `error-message, hidden`
   - Text: "Please fill required fields"
   - **Box Model:** 300×20 (content: 300×20, padding: 0, border: 0, margin: 0 0 8)
   - **Accessibility:** focusable=false, disabled=false
   - **Comment:** This should appear in red, not hidden

### Screenshots

- Element 1: /var/folders/.../pi-annotate-...-el1.png
- Element 2: /var/folders/.../pi-annotate-...-el2.png
```

Debug mode adds computed styles, parent context, and CSS variables per element.

## Architecture

```
Pi Extension (index.ts)
    ↕ Unix Socket (/tmp/pi-annotate.sock)
Native Host (host.cjs)
    ↕ Chrome Native Messaging
Chrome Extension (background.js → content.js)
```

| File | Purpose |
|------|---------|
| `index.ts` | Pi extension — `/annotate` command + tool |
| `types.ts` | TypeScript interfaces |
| `chrome-extension/content.js` | Element picker UI (vanilla JS) |
| `chrome-extension/background.js` | Native messaging, screenshots, tab routing |
| `chrome-extension/native/host.cjs` | Socket ↔ native messaging bridge |
| `chrome-extension/popup.html` | Connection status + setup |

Auth token generated per-run at `/tmp/pi-annotate.token`. Socket and token files use 0600 permissions.

## Development

No build step. Edit `content.js` or `background.js` directly, reload at `chrome://extensions`. Pi extension (TypeScript) loads via jiti — restart pi after changes.

```bash
tail -f /tmp/pi-annotate-host.log                    # Native host logs
# chrome://extensions → Pi Annotate → service worker  # Background logs
# DevTools on target page                              # Content script logs
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| UI doesn't appear | Refresh page, check service worker console |
| "restricted URL" error | Provide a URL: `/annotate https://example.com` |
| Native host not connecting | Click extension icon → check status, re-run install |
| "Extension ID mismatch" | Copy install command from popup, re-run |
| Socket errors | `ls -la /tmp/pi-annotate.sock` |

**Verify native host:** `cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.pi.annotate.json`

## License

MIT
