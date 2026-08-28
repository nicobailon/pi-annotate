<p>
  <img src="banner.png" alt="Pi Annotate" width="1100">
</p>

# Pi Annotate

**Visual annotation for AI. Click elements, capture screenshots, fix code.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Browser](https://img.shields.io/badge/Browser-Chrome%20%7C%20Chromium-blue?style=for-the-badge)]()

```
/annotate
```

Figma-like annotation experience with floating inline note cards. DevTools-like element picker in vanilla JS.

Click elements, add comments, submit. The agent gets selectors, box model, accessibility, screenshots — everything it needs to fix your UI.

https://github.com/user-attachments/assets/115b10ca-86e8-4b1c-b8a4-492c68759c58

## Quick Start

### 1. Install Pi Extension

```bash
pi install npm:pi-annotate
```

Restart pi to load the extension.

### 2. Load Supported Browser Extension

1. Open the extensions page in Google Chrome, Google Chrome for Testing, or Chromium, and enable **Developer mode**
2. Click **Load unpacked** → select the `chrome-extension/` folder inside the installed package
3. Click the **Pi Annotate icon** in the toolbar

### 3. Install Native Host

The popup shows your extension ID. Click **Copy** next to the install command, then run it from `chrome-extension/native/` in the installed package.

macOS/Linux:

```bash
./install.sh <extension-id>
```

Windows:

```bat
.\install-windows.cmd <extension-id>
```

Windows Browser Host for WSL Pi Session Host:

```bat
.\install-windows.cmd <extension-id> -EnableWslBridge
```

The macOS/Linux installer writes native messaging manifests. The Windows installer registers a native messaging manifest under the current user for Google Chrome, Google Chrome for Testing, and Chromium. With `-EnableWslBridge`, it also generates a token-authenticated Windows loopback bridge and prints the `PI_ANNOTATE_WSL_BRIDGE` and `PI_ANNOTATE_WSL_TOKEN` exports to run inside WSL before starting pi. Fully quit and reopen that browser. The popup will show **Connected** when ready.

## Usage

```bash
/annotate                              # Current same-machine browser tab
/annotate https://x.com                # Opens URL in the same-machine browser
/annotate laptop                       # Current tab in the browser on SSH host alias "laptop"
/annotate laptop http://localhost:3000 # Browser Host loads a page served by this Pi Session Host
```

Remote annotation uses your SSH config from the Pi Session Host. The Browser Host must be a macOS or Linux machine that can run Chrome or Chromium, the Pi Annotate browser extension, and the native host.

WSL annotation is explicit. Windows owns the Browser Host, Chrome or Chromium, and the native host. Run the Windows installer with `-EnableWslBridge`, copy the printed `PI_ANNOTATE_WSL_BRIDGE` and `PI_ANNOTATE_WSL_TOKEN` exports into WSL, then start pi in that WSL shell. This keeps normal Linux local annotation on `/tmp/pi-annotate.sock` unless those WSL bridge variables are set in a WSL session. The bridge binds to Windows `127.0.0.1` and requires WSL mirrored networking or another Windows-local localhost forwarding setup that makes Windows loopback reachable from WSL.

Before using `/annotate laptop`, verify SSH works without prompts:

```bash
ssh -o BatchMode=yes laptop true
```

Open Chrome or Chromium on the Browser Host, click the Pi Annotate extension icon, and keep it connected. Pi Annotate creates a temporary SSH tunnel to the Browser Host native socket. If the URL is `localhost` or `127.0.0.1`, it also creates a temporary reverse loopback tunnel so the Browser Host can load the page from the Pi Session Host. IPv6 loopback URLs such as `http://[::1]:3000` are not supported for remote annotation. Non-loopback URLs are passed to the Browser Host unchanged.

| Action | How |
|--------|-----|
| Select element | Click on page |
| Cycle ancestors | Alt/⌥+scroll while hovering |
| Multi-select | Toggle "Multi" or Shift+click |
| Add comment | Type in note card textarea |
| Toggle screenshot | 📷 button in note card header |
| Reposition note | Drag by header |
| Scroll to element | Click selector in note card |
| Toggle note | Click numbered badge |
| Expand/collapse all | ▼/▲ buttons in toolbar |
| Toggle edit capture | "Etch" toggle in toolbar |
| Toggle annotation UI | `⌘/Ctrl+Shift+P` |
| Close | `ESC` |

## Features

**Context Capture** — Each element automatically gets box model breakdown (padding, border, margin), accessibility info (role, name, focusable, ARIA states), all HTML attributes, and key CSS styles (display, position, overflow, colors, typography). Enable **Debug mode** for computed styles (40+ properties), parent context, and CSS variables.

**Inline Note Cards** — Draggable floating cards with per-element comments, SVG connectors linking notes to elements, click-to-scroll, and per-element screenshot toggles.

**Screenshots** — Individual crops per element (20px padding) or full-page mode with numbered badges drawn on the screenshot to identify elements. Toggle per element with the 📷 button.

**Edit Capture** — Toggle "Etch" in the toolbar to record DevTools edits. Change inline styles, modify CSS rules, add/remove classes, edit text — everything is tracked via MutationObserver. A pulsing red dot and badge counter show recording status. At submit, the extension takes before/after screenshots by briefly undoing visual changes, and produces structured property-level diffs the agent can map to source code. Works alongside element selection or standalone.

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

## Edit Capture (2 changes, 35s)

### Inline Style Changes

**`#submit-btn`**
- `background-color`: `rgb(59, 130, 246)` → `rgb(37, 99, 235)`
- `border-radius`: added `8px`

### CSS Rule Changes

**`.btn-primary:hover`** (styles.css)
- `background-color`: `rgb(37, 99, 235)` → `rgb(29, 78, 216)`

### Before/After Screenshots

- Before: /var/folders/.../pi-annotate-...-before.png
- After: /var/folders/.../pi-annotate-...-after.png
```

Debug mode adds computed styles, parent context, and CSS variables per element. Edit capture appears when the Etch toggle is enabled and changes are detected.

## Architecture

```
Pi Extension (index.ts)
    ↕ Unix socket (`/tmp/pi-annotate.sock`) or Windows named pipe (`\\.\pipe\pi-annotate.sock`)
Native Host (host.cjs)
    ↕ Browser Native Messaging
Browser Extension (background.js → content.js)
```

| File | Purpose |
|------|---------|
| `index.ts` | Pi extension — `/annotate` command + tool |
| `remote.ts` | SSH Browser Host bridge for remote annotation |
| `types.ts` | TypeScript interfaces |
| `chrome-extension/content.js` | Element picker UI (vanilla JS) |
| `chrome-extension/background.js` | Native messaging, screenshots, tab routing |
| `chrome-extension/native/host.cjs` | Socket ↔ native messaging bridge |
| `chrome-extension/popup.html` | Connection status + setup |

Auth token generated per-run at `/tmp/pi-annotate.token` on macOS/Linux or `%TEMP%\pi-annotate.token` on Windows. Unix socket and token files use 0600 permissions where supported.

### Pending captures

If you submit an annotation after the browser/native host has started but before a Pi session is attached, Pi Annotate stores the completed capture in a private cache file instead of dropping it. The queued record retains its screenshot data where captured. On the next `/annotate` invocation from a connected Pi session, queued captures are injected as **Recovered Pending Annotation** messages before the new annotation starts and are removed only after that session acknowledges them.

The popup distinguishes the browser host from Pi-session connection: it shows **Connected to Pi** when a session is attached and **Waiting for Pi · N pending capture(s)** when completed captures await recovery. Cache location defaults to `~/Library/Caches/pi-annotate` on macOS, `$XDG_CACHE_HOME/pi-annotate` (or `~/.cache/pi-annotate`) on Linux, and `%LOCALAPPDATA%/pi-annotate` on Windows. Set `PI_ANNOTATE_PENDING_CAPTURES` to override the queue file path.

## Development

No build step. Edit `content.js` or `background.js` directly, reload at `chrome://extensions`. Pi extension (TypeScript) loads via jiti — restart pi after changes.

```bash
tail -f /tmp/pi-annotate-host.log                    # Native host logs on macOS/Linux
# Windows log: %TEMP%\pi-annotate-host.log
# chrome://extensions → Pi Annotate → service worker  # Background logs
# DevTools on target page                              # Content script logs
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| UI doesn't appear | Refresh page, check service worker console |
| "restricted URL" error | Provide a URL: `/annotate https://example.com` |
| Native host not connecting | Click extension icon → check status, re-run install, fully restart the supported browser |
| "Extension ID mismatch" | Copy install command from popup, re-run |
| Socket errors | macOS/Linux: `ls -la /tmp/pi-annotate.sock`; Windows: check `%TEMP%\pi-annotate-host.log`; WSL: verify `PI_ANNOTATE_WSL_BRIDGE`, `PI_ANNOTATE_WSL_TOKEN`, and Windows localhost reachability |

**Verify native host:**
- macOS Google Chrome: `cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.pi.annotate.json`
- macOS Google Chrome for Testing: `cat ~/Library/Application\ Support/Google/ChromeForTesting/NativeMessagingHosts/com.pi.annotate.json`
- macOS Chromium: `cat ~/Library/Application\ Support/Chromium/NativeMessagingHosts/com.pi.annotate.json`
- Linux Google Chrome (default path): `cat ~/.config/google-chrome/NativeMessagingHosts/com.pi.annotate.json`
- Linux Google Chrome for Testing (default path): `cat ~/.config/google-chrome-for-testing/NativeMessagingHosts/com.pi.annotate.json`
- Linux Chromium (default path): `cat ~/.config/chromium/NativeMessagingHosts/com.pi.annotate.json`
- Linux with custom config home: `echo "${CHROME_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}"`
- Windows Google Chrome: `reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pi.annotate /ve`
- Windows Google Chrome for Testing: `reg query "HKCU\Software\Google\Chrome for Testing\NativeMessagingHosts\com.pi.annotate" /ve`
- Windows Chromium: `reg query HKCU\Software\Chromium\NativeMessagingHosts\com.pi.annotate /ve`

If your Linux browser uses a different XDG config root, export `CHROME_CONFIG_HOME` or `XDG_CONFIG_HOME` before running `./install.sh <extension-id>`. Custom `--user-data-dir` layouts are not handled by this installer.

## License

MIT
