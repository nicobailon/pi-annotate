# Changelog

All notable changes to Pi Annotate.

## [0.1.0] - 2026-01-27 (Complete Rewrite)

### Added
- **Per-element screenshots** — Each selected element gets its own cropped screenshot
- **📷 toggle button** — Enable/disable screenshot per element on chips
- **Parent/Child navigation** — Modify selected elements with ▲/▼ buttons
- **+/− buttons** — Expand to parent or contract to child on each chip
- **`/annotate` command** — Works on current tab without requiring URL
- **`/ann` alias** — Quick shortcut for annotation command
- **Full page option** — Toggle to capture entire viewport instead
- **ESC to close** — Keyboard shortcut to dismiss UI
- **× close button** — Visual close button in header

### Changed
- **Vanilla JS** — Complete rewrite from React (~800 lines vs 2000+)
- **Native messaging** — Replaced HTTP polling with native messaging for reliability
- **Text capture** — Increased from 100 to 500 characters
- **Screenshot paths** — Saved to temp files with paths returned for LLM reading
- **UI layout** — Reorganized with "Hover Preview" and "Modify Selection" sections

### Fixed
- Socket data buffering for large screenshot payloads
- Click events being blocked by panel overlay
- Cancel button working without active connection
- Content script injection on pages loaded before extension

### Architecture
```
Pi Extension ← Unix Socket → Native Host ← Native Messaging → Chrome Extension
```

## Architecture

| Aspect | This Version |
|--------|--------------|
| UI Framework | Vanilla JS |
| Lines of code | ~800 |
| Screenshots | Per-element crops |
| Communication | Native messaging |
| Chat | One-way submit |
| Build step | None |
