/**
 * Pi Annotate - Content Script (v0.3.4)
 * 
 * DevTools-like element picker with inline note cards:
 * - Hover to highlight elements
 * - Scroll to cycle through parent elements
 * - Click to select (shift+click for multi)
 * - Per-element floating note cards with comments
 * - Bottom panel for overall context
 */

(() => {
  // Prevent double-injection (use Symbol for unique key to avoid conflicts)
  const LOADED_KEY = "__piAnnotate_" + chrome.runtime.id;
  if (window[LOADED_KEY]) return;
  window[LOADED_KEY] = true;
  
  // ─────────────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────────────
  
  const SCREENSHOT_PADDING = 20;
  const TEXT_MAX_LENGTH = 500;
  const Z_INDEX_CONNECTORS = 2147483643;
  const Z_INDEX_MARKERS = 2147483644;
  const Z_INDEX_HIGHLIGHT = 2147483645;
  const Z_INDEX_PANEL = 2147483646;
  const Z_INDEX_TOOLTIP = 2147483647;
  
  // HTML escape to prevent XSS when inserting user-controlled content
  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  
  // Check if element is part of pi-annotate UI (by id or class)
  function isPiElement(el) {
    if (!el) return false;
    if (el.id?.startsWith("pi-")) return true;
    const cls = el.className;
    if (!cls) return false;
    // Handle both string className and SVGAnimatedString
    const clsStr = typeof cls === "string" ? cls : cls.baseVal || "";
    return clsStr.split(/\s+/).some(c => c.startsWith("pi-"));
  }
  
  // Update note card's displayed selector label
  function updateNoteCardLabel(index) {
    const sel = selectedElements[index];
    if (!sel) return;
    const card = notesContainer?.querySelector(`[data-index="${index}"]`);
    if (!card) return;
    const label = sel.id ? `#${sel.id}` : `${sel.tag}${sel.classes[0] ? "." + sel.classes[0] : ""}`;
    const selectorEl = card.querySelector(".pi-note-selector");
    if (selectorEl) {
      selectorEl.textContent = label;
      selectorEl.title = sel.selector;
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────
  
  let isActive = false;
  let requestId = null;
  let multiSelectMode = false;
  let screenshotMode = "each"; // "each" | "full" | "none"
  
  // Element picker state
  let elementStack = [];
  let stackIndex = 0;
  let selectedElements = [];
  let elementScreenshots = new Map(); // index → boolean
  
  // Note card state (v0.2.0)
  let notesContainer = null;
  let connectorsEl = null;
  let elementComments = new Map(); // index → comment string
  let openNotes = new Set();       // indices of currently open notes
  let notePositions = new Map();   // index → {x, y} manual position overrides
  let dragState = null;            // { card, startX, startY, startLeft, startTop }
  
  // Debug mode state (v0.3.0)
  let debugMode = false;
  let cachedCSSVarNames = null;    // Cache for CSS variable discovery
  
  // DOM elements
  let highlightEl = null;
  let tooltipEl = null;
  let panelEl = null;
  let markersContainer = null;
  let styleEl = null;
  
  // ─────────────────────────────────────────────────────────────────────
  // Styles
  // ─────────────────────────────────────────────────────────────────────
  
  const STYLES = `
    /* ═══════════════════════════════════════════════════════════════════
       CSS Custom Properties (aligned with pi interview theme)
       ═══════════════════════════════════════════════════════════════════ */
    :root {
      --pi-bg-body: #18181e;
      --pi-bg-card: #1e1e24;
      --pi-bg-elevated: #252530;
      --pi-bg-selected: #3a3a4a;
      --pi-bg-hover: #2b2b37;
      --pi-fg: #e0e0e0;
      --pi-fg-muted: #808080;
      --pi-fg-dim: #666666;
      --pi-accent: #8abeb7;
      --pi-accent-hover: #9dcec7;
      --pi-accent-muted: rgba(138, 190, 183, 0.15);
      --pi-border: #5f87ff;
      --pi-border-muted: #505050;
      --pi-border-focus: #7a7a8a;
      --pi-success: #b5bd68;
      --pi-warning: #f0c674;
      --pi-error: #cc6666;
      --pi-focus-ring: rgba(95, 135, 255, 0.2);
      --pi-shadow: rgba(0, 0, 0, 0.5);
      --pi-font-mono: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace;
      --pi-font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --pi-radius: 4px;
    }
    
    /* Light theme */
    @media (prefers-color-scheme: light) {
      :root {
        --pi-bg-body: #f8f8f8;
        --pi-bg-card: #ffffff;
        --pi-bg-elevated: #f0f0f0;
        --pi-bg-selected: #d0d0e0;
        --pi-bg-hover: #e8e8e8;
        --pi-fg: #1a1a1a;
        --pi-fg-muted: #6c6c6c;
        --pi-fg-dim: #8a8a8a;
        --pi-accent: #5f8787;
        --pi-accent-hover: #4a7272;
        --pi-accent-muted: rgba(95, 135, 135, 0.15);
        --pi-border: #5f87af;
        --pi-border-muted: #b0b0b0;
        --pi-border-focus: #8a8a9a;
        --pi-success: #87af87;
        --pi-warning: #d7af5f;
        --pi-error: #af5f5f;
        --pi-focus-ring: rgba(95, 135, 175, 0.2);
        --pi-shadow: rgba(0, 0, 0, 0.15);
      }
    }
    
    /* ═══════════════════════════════════════════════════════════════════
       Highlight & Tooltip
       ═══════════════════════════════════════════════════════════════════ */
    #pi-highlight {
      position: fixed;
      pointer-events: none;
      z-index: ${Z_INDEX_HIGHLIGHT};
      background: var(--pi-accent-muted);
      border: 2px solid var(--pi-accent);
      border-radius: var(--pi-radius);
      transition: all 0.05s ease-out;
    }
    
    #pi-tooltip {
      position: fixed;
      pointer-events: none;
      z-index: ${Z_INDEX_TOOLTIP};
      background: var(--pi-bg-card);
      color: var(--pi-fg);
      padding: 6px 10px;
      border-radius: var(--pi-radius);
      border: 1px solid var(--pi-border-muted);
      font: 12px/1.4 var(--pi-font-mono);
      box-shadow: 0 2px 8px var(--pi-shadow);
      max-width: 400px;
    }
    
    #pi-tooltip .tag { color: var(--pi-error); }
    #pi-tooltip .id { color: var(--pi-warning); }
    #pi-tooltip .class { color: var(--pi-border); }
    #pi-tooltip .size { color: var(--pi-fg-dim); margin-left: 8px; }
    #pi-tooltip .hint { color: var(--pi-accent); font-size: 11px; margin-top: 4px; display: block; }
    
    /* ═══════════════════════════════════════════════════════════════════
       Markers & Selection
       ═══════════════════════════════════════════════════════════════════ */
    #pi-markers {
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: ${Z_INDEX_MARKERS};
    }
    
    .pi-marker-outline {
      position: fixed;
      pointer-events: none;
      border: 2px solid var(--pi-accent);
      border-radius: var(--pi-radius);
      background: var(--pi-accent-muted);
    }
    
    .pi-marker-badge {
      position: fixed;
      pointer-events: auto;
      background: var(--pi-accent);
      color: var(--pi-bg-body);
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font: bold 13px var(--pi-font-ui);
      cursor: pointer;
      box-shadow: 0 2px 8px var(--pi-shadow);
      transition: transform 0.15s, box-shadow 0.15s;
    }
    
    .pi-marker-badge:hover {
      transform: scale(1.1);
      background: var(--pi-accent-hover);
    }
    
    .pi-marker-badge.open {
      background: var(--pi-success);
    }
    
    /* ═══════════════════════════════════════════════════════════════════
       Connectors
       ═══════════════════════════════════════════════════════════════════ */
    .pi-connectors {
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: ${Z_INDEX_CONNECTORS};
    }
    
    .pi-connector {
      fill: none;
      stroke: var(--pi-accent);
      stroke-opacity: 0.5;
      stroke-width: 2;
      stroke-dasharray: 6 4;
    }
    
    .pi-connector-dot {
      fill: var(--pi-accent);
    }
    
    /* ═══════════════════════════════════════════════════════════════════
       Note Cards
       ═══════════════════════════════════════════════════════════════════ */
    .pi-notes-container {
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: ${Z_INDEX_MARKERS};
    }
    
    .pi-note-card {
      position: fixed;
      width: 280px;
      background: var(--pi-bg-card);
      border: 1px solid var(--pi-border-muted);
      border-radius: 8px;
      box-shadow: 0 4px 24px var(--pi-shadow);
      pointer-events: auto;
      font-family: var(--pi-font-ui);
      overflow: hidden;
    }
    
    .pi-note-card * { box-sizing: border-box; }
    
    .pi-note-card:hover {
      border-color: var(--pi-border-focus);
    }
    
    .pi-note-card.dragging {
      opacity: 0.9;
      cursor: grabbing;
    }
    
    .pi-note-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: var(--pi-bg-elevated);
      border-bottom: 1px solid var(--pi-border-muted);
      cursor: grab;
    }
    
    .pi-note-badge {
      background: var(--pi-accent);
      color: var(--pi-bg-body);
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font: bold 11px var(--pi-font-ui);
      flex-shrink: 0;
    }
    
    .pi-note-selector {
      flex: 1;
      font: 12px var(--pi-font-mono);
      color: var(--pi-fg-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }
    
    .pi-note-selector:hover {
      color: var(--pi-accent);
      text-decoration: underline;
    }
    
    .pi-note-screenshot,
    .pi-note-close,
    .pi-note-expand,
    .pi-note-contract {
      background: none;
      border: none;
      color: var(--pi-fg-dim);
      font-size: 14px;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: var(--pi-radius);
      transition: all 0.15s;
    }
    
    .pi-note-expand,
    .pi-note-contract { font-size: 11px; }
    .pi-note-expand:hover,
    .pi-note-contract:hover { background: var(--pi-bg-elevated); color: var(--pi-fg-muted); }
    .pi-note-screenshot { opacity: 0.4; }
    .pi-note-screenshot:hover { background: var(--pi-bg-elevated); opacity: 0.7; }
    .pi-note-screenshot.active { opacity: 1; background: var(--pi-accent-muted); }
    .pi-note-close:hover { background: var(--pi-bg-elevated); color: var(--pi-error); }
    
    .pi-note-body {
      padding: 10px;
    }
    
    .pi-note-textarea {
      width: 100%;
      background: var(--pi-bg-body);
      border: 1px solid var(--pi-border-muted);
      border-radius: 6px;
      color: var(--pi-fg);
      font: 13px/1.5 var(--pi-font-ui);
      padding: 10px 12px;
      resize: none;
      min-height: 72px;
      max-height: 160px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    
    .pi-note-textarea:focus {
      outline: none;
      border-color: var(--pi-accent);
      box-shadow: 0 0 0 3px var(--pi-focus-ring);
    }
    
    .pi-note-textarea::placeholder {
      color: var(--pi-fg-dim);
    }
    
    /* ═══════════════════════════════════════════════════════════════════
       Bottom Panel
       ═══════════════════════════════════════════════════════════════════ */
    #pi-panel {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: var(--pi-bg-card);
      color: var(--pi-fg);
      font-family: var(--pi-font-ui);
      padding: 10px 16px;
      z-index: ${Z_INDEX_PANEL};
      box-shadow: 0 -4px 24px var(--pi-shadow);
      border-top: 1px solid var(--pi-border-muted);
    }
    
    #pi-panel * { box-sizing: border-box; }
    
    .pi-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--pi-bg-elevated);
    }
    
    .pi-logo { 
      font-size: 15px; 
      font-weight: 700; 
      color: var(--pi-accent);
    }
    .pi-hint { color: var(--pi-fg-dim); font-size: 11px; margin-left: auto; }
    
    .pi-close {
      background: none;
      border: none;
      color: var(--pi-fg-dim);
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .pi-close:hover { color: var(--pi-error); }
    
    .pi-toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    
    .pi-mode-toggle {
      display: flex;
      gap: 4px;
    }
    
    .pi-mode-btn {
      background: var(--pi-bg-elevated);
      border: 1px solid var(--pi-border-muted);
      border-radius: var(--pi-radius);
      padding: 5px 10px;
      font-size: 11px;
      color: var(--pi-fg-muted);
      cursor: pointer;
      transition: all 0.15s;
    }
    
    .pi-mode-btn:hover { background: var(--pi-bg-hover); }
    
    .pi-mode-btn.active {
      background: var(--pi-accent);
      border-color: var(--pi-accent);
      color: var(--pi-bg-body);
    }
    
    .pi-screenshot-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--pi-bg-body);
      padding: 2px 2px 2px 8px;
      border-radius: var(--pi-radius);
    }
    
    .pi-toggle-label {
      font-size: 11px;
      color: var(--pi-fg-dim);
    }
    
    .pi-ss-btn {
      background: transparent;
      border: none;
      border-radius: 3px;
      padding: 5px 10px;
      font-size: 11px;
      color: var(--pi-fg-dim);
      cursor: pointer;
      transition: all 0.15s;
    }
    
    .pi-ss-btn:hover { color: var(--pi-fg-muted); }
    
    .pi-ss-btn.active {
      background: var(--pi-accent);
      color: var(--pi-bg-body);
    }
    
    .pi-spacer { flex: 1; }
    
    .pi-count {
      font-size: 12px;
      color: var(--pi-fg-dim);
    }
    
    .pi-notes-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--pi-fg-muted);
      cursor: pointer;
      user-select: none;
    }
    
    .pi-notes-toggle input {
      width: 14px;
      height: 14px;
      accent-color: var(--pi-accent);
      cursor: pointer;
    }
    
    .pi-notes-toggle:hover { color: var(--pi-fg); }
    
    .pi-context-row {
      margin-bottom: 8px;
    }
    
    .pi-context-row input {
      width: 100%;
      background: var(--pi-bg-body);
      border: 1px solid var(--pi-border-muted);
      border-radius: var(--pi-radius);
      color: var(--pi-fg);
      font-family: inherit;
      font-size: 13px;
      padding: 8px 12px;
    }
    
    .pi-context-row input:focus {
      outline: none;
      border-color: var(--pi-accent);
      box-shadow: 0 0 0 3px var(--pi-focus-ring);
    }
    
    .pi-context-row input::placeholder { color: var(--pi-fg-dim); }
    
    .pi-actions {
      display: flex;
      justify-content: flex-end;
      padding-top: 8px;
      border-top: 1px solid var(--pi-bg-elevated);
    }
    
    .pi-buttons { display: flex; gap: 8px; }
    
    .pi-btn {
      padding: 6px 14px;
      border-radius: var(--pi-radius);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.15s;
    }
    
    .pi-btn-cancel {
      background: var(--pi-bg-elevated);
      color: var(--pi-fg-muted);
      border: 1px solid var(--pi-border-muted);
    }
    
    .pi-btn-cancel:hover { background: var(--pi-bg-hover); color: var(--pi-fg); }
    
    .pi-btn-submit {
      background: var(--pi-accent);
      color: var(--pi-bg-body);
    }
    
    .pi-btn-submit:hover { 
      background: var(--pi-accent-hover);
    }
  `;
  
  // ─────────────────────────────────────────────────────────────────────
  // Message Handling
  // ─────────────────────────────────────────────────────────────────────
  
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log("[pi-annotate] Received:", msg.type);
    
    if (msg.type === "START_ANNOTATION") {
      requestId = msg.requestId || msg.id || null;
      activate();
    } else if (msg.type === "TOGGLE_PICKER") {
      if (isActive) {
        deactivate();
      } else {
        activate();
      }
    } else if (msg.type === "CANCEL") {
      if (isActive) {
        deactivate();
      }
    }
  });
  
  // ─────────────────────────────────────────────────────────────────────
  // Activation
  // ─────────────────────────────────────────────────────────────────────
  
  function activate() {
    if (isActive) {
      console.log("[pi-annotate] Restarting session (new request)");
      resetState();
      return;
    }
    isActive = true;
    
    // Inject styles
    styleEl = document.createElement("style");
    styleEl.id = "pi-styles";
    styleEl.textContent = STYLES;
    (document.head || document.documentElement).appendChild(styleEl);
    
    // Create UI
    createHighlight();
    createTooltip();
    createMarkers();
    createNotesContainer();
    createPanel();
    
    // Add listeners
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    initDragHandlers();
    
    document.body.style.cursor = "crosshair";
    console.log("[pi-annotate] Activated");
  }
  
  function resetState() {
    elementStack = [];
    stackIndex = 0;
    selectedElements = [];
    elementScreenshots = new Map();
    elementComments = new Map();
    openNotes = new Set();
    notePositions = new Map();
    dragState = null;
    multiSelectMode = false;
    screenshotMode = "each";
    debugMode = false;
    resetCSSVarCache();
    
    // Reset UI elements
    if (markersContainer) markersContainer.innerHTML = "";
    if (notesContainer) notesContainer.innerHTML = "";
    if (connectorsEl) connectorsEl.innerHTML = "";
    hideHighlight();
    hideTooltip();
    
    // Reset mode toggle buttons
    const singleBtn = document.getElementById("pi-mode-single");
    const multiBtn = document.getElementById("pi-mode-multi");
    if (singleBtn && multiBtn) {
      singleBtn.classList.add("active");
      multiBtn.classList.remove("active");
    }
    
    // Reset screenshot mode buttons
    const eachBtn = document.getElementById("pi-ss-each");
    const fullBtn = document.getElementById("pi-ss-full");
    const noneBtn = document.getElementById("pi-ss-none");
    if (eachBtn && fullBtn && noneBtn) {
      eachBtn.classList.add("active");
      fullBtn.classList.remove("active");
      noneBtn.classList.remove("active");
    }
    
    // Clear context input
    const contextEl = document.getElementById("pi-context");
    if (contextEl) contextEl.value = "";
    
    // Reset debug mode checkbox
    const debugCheckbox = document.getElementById("pi-debug-mode");
    if (debugCheckbox) debugCheckbox.checked = false;
    
    // Update count
    const countEl = document.getElementById("pi-count");
    if (countEl) countEl.textContent = "0 selected";
    
    console.log("[pi-annotate] State reset for new session");
  }
  
  function deactivate() {
    if (!isActive) return;
    isActive = false;
    
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("wheel", onWheel, { capture: true });
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", handleScroll, true);
    window.removeEventListener("resize", handleResize);
    cleanupDragHandlers();
    
    document.body.style.cursor = "";
    
    styleEl?.remove();
    highlightEl?.remove();
    tooltipEl?.remove();
    panelEl?.remove();
    markersContainer?.remove();
    notesContainer?.remove();
    connectorsEl?.remove();
    
    styleEl = highlightEl = tooltipEl = panelEl = markersContainer = null;
    notesContainer = connectorsEl = null;
    elementStack = [];
    stackIndex = 0;
    selectedElements = [];
    elementScreenshots = new Map();
    elementComments = new Map();
    openNotes = new Set();
    notePositions = new Map();
    dragState = null;
    requestId = null;
    multiSelectMode = false;
    screenshotMode = "each";
    debugMode = false;
    resetCSSVarCache();
    
    console.log("[pi-annotate] Deactivated");
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // UI Creation
  // ─────────────────────────────────────────────────────────────────────
  
  function createHighlight() {
    highlightEl = document.createElement("div");
    highlightEl.id = "pi-highlight";
    highlightEl.style.display = "none";
    document.body.appendChild(highlightEl);
  }
  
  function createTooltip() {
    tooltipEl = document.createElement("div");
    tooltipEl.id = "pi-tooltip";
    tooltipEl.style.display = "none";
    document.body.appendChild(tooltipEl);
  }
  
  function createMarkers() {
    markersContainer = document.createElement("div");
    markersContainer.id = "pi-markers";
    document.body.appendChild(markersContainer);
  }
  
  function createNotesContainer() {
    notesContainer = document.createElement("div");
    notesContainer.className = "pi-notes-container";
    document.body.appendChild(notesContainer);
    
    connectorsEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    connectorsEl.setAttribute("class", "pi-connectors");
    document.body.appendChild(connectorsEl);
  }
  
  function createPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "pi-panel";
    panelEl.innerHTML = `
      <div class="pi-header">
        <span class="pi-logo">π Annotate</span>
        <span class="pi-hint">Click elements • ESC to close</span>
        <button class="pi-close" id="pi-close" title="Close (ESC)">×</button>
      </div>
      <div class="pi-toolbar">
        <div class="pi-mode-toggle">
          <button class="pi-mode-btn active" id="pi-mode-single" title="Click replaces selection">Single</button>
          <button class="pi-mode-btn" id="pi-mode-multi" title="Click adds to selection">Multi</button>
        </div>
        <div class="pi-screenshot-toggle">
          <span class="pi-toggle-label">Screenshot</span>
          <button class="pi-ss-btn active" id="pi-ss-each" title="Crop screenshot to each element">Crop</button>
          <button class="pi-ss-btn" id="pi-ss-full" title="Capture entire viewport">Full</button>
          <button class="pi-ss-btn" id="pi-ss-none" title="No screenshots">None</button>
        </div>
        <div class="pi-spacer"></div>
        <span class="pi-count" id="pi-count">0 selected</span>
        <label class="pi-notes-toggle" title="Show/hide all note cards">
          <input type="checkbox" id="pi-notes-visible" checked />
          <span>Notes</span>
        </label>
        <label class="pi-notes-toggle" title="Capture computed styles, layout, and CSS variables">
          <input type="checkbox" id="pi-debug-mode" />
          <span>Debug</span>
        </label>
      </div>
      <div class="pi-context-row">
        <input type="text" id="pi-context" placeholder="General context (optional)..." />
      </div>
      <div class="pi-actions">
        <div class="pi-buttons">
          <button class="pi-btn pi-btn-cancel" id="pi-cancel">Cancel</button>
          <button class="pi-btn pi-btn-submit" id="pi-submit">Submit</button>
        </div>
      </div>
    `;
    document.body.appendChild(panelEl);
    
    document.getElementById("pi-close").addEventListener("click", handleCancel);
    document.getElementById("pi-cancel").addEventListener("click", handleCancel);
    document.getElementById("pi-submit").addEventListener("click", handleSubmit);
    
    // Mode toggle
    document.getElementById("pi-mode-single").addEventListener("click", () => setMultiMode(false));
    document.getElementById("pi-mode-multi").addEventListener("click", () => setMultiMode(true));
    
    // Screenshot mode toggle
    document.getElementById("pi-ss-each").addEventListener("click", () => setScreenshotMode("each"));
    document.getElementById("pi-ss-full").addEventListener("click", () => setScreenshotMode("full"));
    document.getElementById("pi-ss-none").addEventListener("click", () => setScreenshotMode("none"));
    
    // Notes visibility toggle
    document.getElementById("pi-notes-visible").addEventListener("change", (e) => {
      if (e.target.checked) {
        expandAllNotes();
      } else {
        collapseAllNotes();
      }
    });
    
    // Debug mode toggle
    document.getElementById("pi-debug-mode").addEventListener("change", (e) => {
      debugMode = e.target.checked;
    });
    
    // Stop events from reaching the page
    panelEl.addEventListener("mousemove", e => e.stopPropagation(), true);
    panelEl.addEventListener("click", e => {
      const target = e.target;
      if (target.tagName === "BUTTON" || target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
        return;
      }
      e.stopPropagation();
    }, true);
  }
  
  function setMultiMode(isMulti) {
    multiSelectMode = isMulti;
    const singleBtn = document.getElementById("pi-mode-single");
    const multiBtn = document.getElementById("pi-mode-multi");
    if (singleBtn && multiBtn) {
      singleBtn.classList.toggle("active", !isMulti);
      multiBtn.classList.toggle("active", isMulti);
    }
  }
  
  function setScreenshotMode(mode) {
    screenshotMode = mode;
    const eachBtn = document.getElementById("pi-ss-each");
    const fullBtn = document.getElementById("pi-ss-full");
    const noneBtn = document.getElementById("pi-ss-none");
    if (eachBtn && fullBtn && noneBtn) {
      eachBtn.classList.toggle("active", mode === "each");
      fullBtn.classList.toggle("active", mode === "full");
      noneBtn.classList.toggle("active", mode === "none");
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Note Card Functions
  // ─────────────────────────────────────────────────────────────────────
  
  function calculateNotePosition(element, cardWidth = 280, cardHeight = 150) {
    const rect = element.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const panelHeight = document.getElementById("pi-panel")?.offsetHeight || 96;
    const margin = 16;
    
    // Try right side first
    if (rect.right + margin + cardWidth < vw) {
      return { x: rect.right + margin, y: Math.max(margin, rect.top) };
    }
    // Try left side
    if (rect.left - margin - cardWidth > 0) {
      return { x: rect.left - margin - cardWidth, y: Math.max(margin, rect.top) };
    }
    // Try below
    if (rect.bottom + margin + cardHeight < vh - panelHeight) {
      return { x: Math.max(margin, rect.left), y: rect.bottom + margin };
    }
    // Try above
    if (rect.top - margin - cardHeight > 0) {
      return { x: Math.max(margin, rect.left), y: rect.top - margin - cardHeight };
    }
    // Fallback: offset from element
    return { x: Math.min(rect.right + margin, vw - cardWidth - margin), y: Math.max(margin, rect.top) };
  }
  
  function hasOverlap(rect1, rect2, margin = 8) {
    return !(
      rect1.right + margin < rect2.left ||
      rect1.left > rect2.right + margin ||
      rect1.bottom + margin < rect2.top ||
      rect1.top > rect2.bottom + margin
    );
  }
  
  function adjustForCollisions(position, cardSize, existingCards) {
    const myRect = {
      left: position.x,
      top: position.y,
      right: position.x + cardSize.width,
      bottom: position.y + cardSize.height
    };
    
    let adjusted = { ...position };
    let attempts = 0;
    
    while (attempts < 10) {
      let collision = false;
      
      for (const card of existingCards) {
        const cardRect = card.getBoundingClientRect();
        if (hasOverlap(myRect, cardRect)) {
          adjusted.y = cardRect.bottom + 12;
          myRect.top = adjusted.y;
          myRect.bottom = adjusted.y + cardSize.height;
          collision = true;
          break;
        }
      }
      
      if (!collision) break;
      attempts++;
    }
    
    // Clamp to viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const panelHeight = document.getElementById("pi-panel")?.offsetHeight || 96;
    adjusted.x = Math.max(16, Math.min(adjusted.x, vw - cardSize.width - 16));
    adjusted.y = Math.max(16, Math.min(adjusted.y, vh - cardSize.height - panelHeight - 16));
    
    return adjusted;
  }
  
  function createNoteCard(index) {
    const sel = selectedElements[index];
    if (!sel || !sel.element || !document.contains(sel.element)) return null;
    
    // Guard against duplicate cards
    if (openNotes.has(index)) {
      return notesContainer.querySelector(`[data-index="${index}"]`);
    }
    
    // Use stored position if user previously dragged, otherwise calculate
    let adjustedPos;
    if (notePositions.has(index)) {
      adjustedPos = notePositions.get(index);
    } else {
      const position = calculateNotePosition(sel.element);
      adjustedPos = adjustForCollisions(
        position,
        { width: 280, height: 150 },
        notesContainer.querySelectorAll(".pi-note-card")
      );
    }
    
    const label = sel.id ? `#${sel.id}` : `${sel.tag}${sel.classes[0] ? "." + sel.classes[0] : ""}`;
    const hasScreenshot = elementScreenshots.get(index) !== false;
    const comment = elementComments.get(index) || "";
    
    const card = document.createElement("div");
    card.className = "pi-note-card";
    card.dataset.index = index;
    card.style.left = `${adjustedPos.x}px`;
    card.style.top = `${adjustedPos.y}px`;
    
    card.innerHTML = `
      <div class="pi-note-header">
        <span class="pi-note-badge">${index + 1}</span>
        <span class="pi-note-selector" title="${escapeHtml(sel.selector)}">${escapeHtml(label)}</span>
        <button class="pi-note-expand" title="Expand to parent">▲</button>
        <button class="pi-note-contract" title="Contract to child">▼</button>
        <button class="pi-note-screenshot ${hasScreenshot ? "active" : ""}" title="Toggle screenshot">📷</button>
        <button class="pi-note-close" title="Remove element">×</button>
      </div>
      <div class="pi-note-body">
        <textarea class="pi-note-textarea" placeholder="Describe changes for this element...">${escapeHtml(comment)}</textarea>
      </div>
    `;
    
    // Helper to get current index from DOM (survives reindexing)
    const getIndex = () => parseInt(card.dataset.index, 10);
    
    // Event listeners
    const textarea = card.querySelector(".pi-note-textarea");
    textarea.addEventListener("input", () => {
      elementComments.set(getIndex(), textarea.value);
      autoResizeTextarea(textarea);
    });
    
    const screenshotBtn = card.querySelector(".pi-note-screenshot");
    screenshotBtn.addEventListener("click", () => {
      const idx = getIndex();
      const current = elementScreenshots.get(idx) !== false;
      elementScreenshots.set(idx, !current);
      screenshotBtn.classList.toggle("active", !current);
    });
    
    const closeBtn = card.querySelector(".pi-note-close");
    closeBtn.addEventListener("click", () => removeElement(getIndex()));
    
    const expandBtn = card.querySelector(".pi-note-expand");
    expandBtn.addEventListener("click", () => expandElement(getIndex()));
    
    const contractBtn = card.querySelector(".pi-note-contract");
    contractBtn.addEventListener("click", () => contractElement(getIndex()));
    
    const selectorEl = card.querySelector(".pi-note-selector");
    selectorEl.addEventListener("click", () => {
      const idx = getIndex();
      const currentSel = selectedElements[idx];
      if (currentSel?.element) scrollToElement(currentSel.element);
    });
    
    // Drag to reposition
    setupDrag(card);
    
    notesContainer.appendChild(card);
    openNotes.add(index);
    
    // Focus textarea
    textarea.focus();
    
    return card;
  }
  
  function toggleNote(index) {
    if (openNotes.has(index)) {
      // Close note
      const card = notesContainer.querySelector(`[data-index="${index}"]`);
      if (card) card.remove();
      openNotes.delete(index);
    } else {
      // Open note
      createNoteCard(index);
    }
    updateBadges();
    updateConnectors();
  }
  
  function autoResizeTextarea(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(160, Math.max(72, textarea.scrollHeight)) + "px";
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Drag Handling
  // ─────────────────────────────────────────────────────────────────────
  
  function initDragHandlers() {
    document.addEventListener("mousemove", handleDragMove);
    document.addEventListener("mouseup", handleDragEnd);
  }
  
  function cleanupDragHandlers() {
    document.removeEventListener("mousemove", handleDragMove);
    document.removeEventListener("mouseup", handleDragEnd);
  }
  
  function handleDragMove(e) {
    if (!dragState) return;
    const { card, startX, startY, startLeft, startTop } = dragState;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const newX = startLeft + dx;
    const newY = startTop + dy;
    card.style.left = `${newX}px`;
    card.style.top = `${newY}px`;
    const index = parseInt(card.dataset.index, 10);
    notePositions.set(index, { x: newX, y: newY });
    updateConnectors();
  }
  
  function handleDragEnd() {
    if (dragState) {
      dragState.card.classList.remove("dragging");
      dragState = null;
    }
  }
  
  function setupDrag(card) {
    const header = card.querySelector(".pi-note-header");
    
    header.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON" || e.target.tagName === "SPAN") return;
      dragState = {
        card,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: card.offsetLeft,
        startTop: card.offsetTop
      };
      card.classList.add("dragging");
      e.preventDefault();
    });
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Element Management
  // ─────────────────────────────────────────────────────────────────────
  
  function removeElement(index) {
    selectedElements.splice(index, 1);
    
    // Close and remove the note card if open
    if (openNotes.has(index)) {
      const card = notesContainer.querySelector(`[data-index="${index}"]`);
      if (card) card.remove();
      openNotes.delete(index);
    }
    
    // Reindex all state Maps and Sets
    const reindexMap = (map) => {
      const newMap = new Map();
      map.forEach((v, k) => {
        if (k < index) newMap.set(k, v);
        else if (k > index) newMap.set(k - 1, v);
      });
      return newMap;
    };
    
    const reindexSet = (set) => {
      const newSet = new Set();
      set.forEach(k => {
        if (k < index) newSet.add(k);
        else if (k > index) newSet.add(k - 1);
      });
      return newSet;
    };
    
    elementScreenshots = reindexMap(elementScreenshots);
    elementComments = reindexMap(elementComments);
    notePositions = reindexMap(notePositions);
    openNotes = reindexSet(openNotes);
    
    // Update data-index attributes on remaining note cards
    notesContainer.querySelectorAll(".pi-note-card").forEach(card => {
      const cardIndex = parseInt(card.dataset.index, 10);
      if (cardIndex > index) {
        const newIndex = cardIndex - 1;
        card.dataset.index = newIndex;
        const badge = card.querySelector(".pi-note-badge");
        if (badge) badge.textContent = newIndex + 1;
      }
    });
    
    updateBadges();
    updateConnectors();
  }
  
  function expandElement(index) {
    const sel = selectedElements[index];
    if (!sel?.element || !document.contains(sel.element)) return;
    
    const parent = sel.element.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) {
      if (isPiElement(parent)) {
        console.log("[pi-annotate] Cannot expand to pi-annotate UI element");
        return;
      }
      
      console.log("[pi-annotate] Expanding to parent:", parent.tagName);
      selectedElements[index] = createSelectionData(parent);
      updateNoteCardLabel(index);
      updateBadges();
      updateConnectors();
    } else {
      console.log("[pi-annotate] Already at root - no valid parent");
    }
  }
  
  function contractElement(index) {
    const sel = selectedElements[index];
    if (!sel?.element || !document.contains(sel.element)) return;
    
    const children = Array.from(sel.element.children).filter(c => 
      c.nodeType === 1 && !isPiElement(c)
    );
    
    if (children.length > 0) {
      console.log("[pi-annotate] Contracting to child:", children[0].tagName);
      selectedElements[index] = createSelectionData(children[0]);
      updateNoteCardLabel(index);
      updateBadges();
      updateConnectors();
    } else {
      console.log("[pi-annotate] No children to contract to");
    }
  }
  
  function scrollToElement(element) {
    if (!element || !document.contains(element)) return;
    
    element.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "center"
    });
    
    // Flash highlight effect after scroll
    setTimeout(() => {
      if (!element || !document.contains(element)) return;
      
      const rect = element.getBoundingClientRect();
      highlightEl.style.display = "";
      highlightEl.style.left = rect.left + "px";
      highlightEl.style.top = rect.top + "px";
      highlightEl.style.width = rect.width + "px";
      highlightEl.style.height = rect.height + "px";
      highlightEl.style.transition = "opacity 0.3s";
      highlightEl.style.opacity = "1";
      
      setTimeout(() => {
        highlightEl.style.opacity = "0";
        setTimeout(() => {
          highlightEl.style.display = "none";
          highlightEl.style.transition = "";
          highlightEl.style.opacity = "";
        }, 300);
      }, 500);
    }, 400);
  }
  
  function expandAllNotes() {
    selectedElements.forEach((_, i) => {
      if (!openNotes.has(i)) {
        createNoteCard(i);
      }
    });
    updateBadges();
    updateConnectors();
  }
  
  function collapseAllNotes() {
    openNotes.forEach(i => {
      const card = notesContainer.querySelector(`[data-index="${i}"]`);
      if (card) card.remove();
    });
    openNotes.clear();
    updateBadges();
    updateConnectors();
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // UI Updates
  // ─────────────────────────────────────────────────────────────────────
  
  function updateBadges() {
    if (!markersContainer) return;
    markersContainer.innerHTML = "";
    
    selectedElements.forEach((sel, i) => {
      if (!sel.element || !document.contains(sel.element)) return;
      
      const rect = sel.element.getBoundingClientRect();
      
      // Create outline box around selected element
      const outline = document.createElement("div");
      outline.className = "pi-marker-outline";
      outline.style.left = `${rect.left}px`;
      outline.style.top = `${rect.top}px`;
      outline.style.width = `${rect.width}px`;
      outline.style.height = `${rect.height}px`;
      markersContainer.appendChild(outline);
      
      // Create numbered badge
      const badge = document.createElement("div");
      badge.className = `pi-marker-badge ${openNotes.has(i) ? "open" : ""}`;
      badge.dataset.index = i;
      badge.textContent = i + 1;
      badge.style.left = `${rect.right - 14}px`;
      badge.style.top = `${rect.top - 14}px`;
      
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleNote(i);
      });
      
      markersContainer.appendChild(badge);
    });
    
    // Update count
    const countEl = document.getElementById("pi-count");
    if (countEl) countEl.textContent = `${selectedElements.length} selected`;
  }
  
  function updateConnectors() {
    if (!connectorsEl) return;
    connectorsEl.innerHTML = "";
    
    selectedElements.forEach((sel, i) => {
      if (!openNotes.has(i)) return;
      
      const card = notesContainer.querySelector(`[data-index="${i}"]`);
      if (!card || !sel.element || !document.contains(sel.element)) return;
      
      const elemRect = sel.element.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      
      const elemCenter = {
        x: elemRect.left + elemRect.width / 2,
        y: elemRect.top + elemRect.height / 2
      };
      
      let cardAnchor;
      if (cardRect.left > elemRect.right) {
        cardAnchor = { x: cardRect.left, y: cardRect.top + 20 };
      } else if (cardRect.right < elemRect.left) {
        cardAnchor = { x: cardRect.right, y: cardRect.top + 20 };
      } else if (cardRect.top > elemRect.bottom) {
        cardAnchor = { x: cardRect.left + 20, y: cardRect.top };
      } else if (cardRect.bottom < elemRect.top) {
        cardAnchor = { x: cardRect.left + 20, y: cardRect.bottom };
      } else {
        return; // Card overlaps element
      }
      
      const midX = (elemCenter.x + cardAnchor.x) / 2;
      const midY = (elemCenter.y + cardAnchor.y) / 2;
      
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "pi-connector");
      path.setAttribute("d", `M ${elemCenter.x},${elemCenter.y} Q ${midX},${midY} ${cardAnchor.x},${cardAnchor.y}`);
      connectorsEl.appendChild(path);
      
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("class", "pi-connector-dot");
      dot.setAttribute("cx", elemCenter.x);
      dot.setAttribute("cy", elemCenter.y);
      dot.setAttribute("r", 4);
      connectorsEl.appendChild(dot);
    });
  }
  
  function updateHighlight() {
    const el = elementStack[stackIndex];
    if (!el) return hideHighlight();
    
    const rect = el.getBoundingClientRect();
    Object.assign(highlightEl.style, {
      display: "",
      left: rect.left + "px",
      top: rect.top + "px",
      width: rect.width + "px",
      height: rect.height + "px",
    });
  }
  
  function hideHighlight() {
    if (highlightEl) highlightEl.style.display = "none";
  }
  
  function updateTooltip(mx, my) {
    const el = elementStack[stackIndex];
    if (!el) return hideTooltip();
    
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const id = el.id;
    const classes = Array.from(el.classList).slice(0, 3);
    
    let html = `<span class="tag">${escapeHtml(tag)}</span>`;
    if (id) html += `<span class="id">#${escapeHtml(id)}</span>`;
    if (classes.length) html += `<span class="class">.${escapeHtml(classes.join("."))}</span>`;
    html += `<span class="size">${Math.round(rect.width)}×${Math.round(rect.height)}</span>`;
    if (elementStack.length > 1) {
      html += `<span class="hint">▲▼ ${stackIndex + 1}/${elementStack.length}</span>`;
    }
    
    tooltipEl.innerHTML = html;
    tooltipEl.style.display = "";
    
    let tx = mx + 15, ty = my + 15;
    const tr = tooltipEl.getBoundingClientRect();
    if (tx + tr.width > window.innerWidth - 10) tx = mx - tr.width - 10;
    if (ty + tr.height > window.innerHeight - 100) ty = my - tr.height - 10;
    
    tooltipEl.style.left = tx + "px";
    tooltipEl.style.top = ty + "px";
  }
  
  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────────────────────────────
  
  function onMouseMove(e) {
    if (!isActive || e.target.closest("#pi-panel") || e.target.closest(".pi-note-card")) {
      hideHighlight();
      hideTooltip();
      return;
    }
    
    highlightEl.style.display = "none";
    tooltipEl.style.display = "none";
    const el = document.elementFromPoint(e.clientX, e.clientY);
    highlightEl.style.display = "";
    
    if (!el || el === document.body || el === document.documentElement || isPiElement(el)) {
      hideHighlight();
      hideTooltip();
      return;
    }
    
    // Build parent chain
    elementStack = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      if (!isPiElement(current)) {
        elementStack.push(current);
      }
      current = current.parentElement;
    }
    stackIndex = 0;
    
    updateHighlight();
    updateTooltip(e.clientX, e.clientY);
  }
  
  function onWheel(e) {
    if (!isActive || !elementStack.length || e.target.closest("#pi-panel") || e.target.closest(".pi-note-card")) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    stackIndex = e.deltaY > 0 
      ? Math.min(stackIndex + 1, elementStack.length - 1)
      : Math.max(stackIndex - 1, 0);
    
    updateHighlight();
    updateTooltip(e.clientX, e.clientY);
  }
  
  function onClick(e) {
    if (!isActive || e.target.closest("#pi-panel") || e.target.closest(".pi-note-card")) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const el = elementStack[stackIndex];
    if (!el) return;
    
    const idx = selectedElements.findIndex(s => s.element === el);
    
    if (idx >= 0) {
      // Already selected - deselect it
      removeElement(idx);
      return;
    }
    
    // Not selected - add it
    const addToExisting = multiSelectMode || e.shiftKey;
    if (!addToExisting) {
      // Clear existing selections
      collapseAllNotes();
      selectedElements = [];
      elementScreenshots = new Map();
      elementComments = new Map();
      notePositions = new Map();
    }
    selectElement(el);
    
    // Auto-open note for the newly selected element
    const newIndex = selectedElements.length - 1;
    createNoteCard(newIndex);
    
    updateBadges();
    updateConnectors();
  }
  
  function onKeyDown(e) {
    if (!isActive) return;
    if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  }
  
  function handleScroll() {
    updateBadges();
    updateConnectors();
  }
  
  function handleResize() {
    updateBadges();
    const panelHeight = document.getElementById("pi-panel")?.offsetHeight || 96;
    
    openNotes.forEach(index => {
      const card = notesContainer.querySelector(`[data-index="${index}"]`);
      if (!card) return;
      
      const rect = card.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      
      let newX = card.offsetLeft;
      let newY = card.offsetTop;
      let moved = false;
      
      if (rect.right > vw - 16) {
        newX = vw - rect.width - 16;
        moved = true;
      }
      if (rect.bottom > vh - panelHeight - 16) {
        newY = vh - rect.height - panelHeight - 16;
        moved = true;
      }
      
      if (moved) {
        card.style.left = `${newX}px`;
        card.style.top = `${newY}px`;
        // Update stored position so rebuild uses correct location
        notePositions.set(index, { x: newX, y: newY });
      }
    });
    updateConnectors();
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Selection
  // ─────────────────────────────────────────────────────────────────────
  
  function selectElement(el) {
    selectedElements.push(createSelectionData(el));
  }
  
  function generateSelector(el) {
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${el.id}`;
    
    if (el.classList.length) {
      const classes = Array.from(el.classList).filter(c => /^[a-zA-Z][\w-]*$/.test(c));
      if (classes.length) {
        const sel = el.tagName.toLowerCase() + "." + classes.join(".");
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
      }
    }
    
    const path = [];
    let cur = el;
    while (cur && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && /^[a-zA-Z][\w-]*$/.test(cur.id)) {
        path.unshift(`#${cur.id}`);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      path.unshift(part);
      cur = parent;
    }
    return path.join(" > ");
  }
  
  /**
   * Get all HTML attributes for an element (except class/id which are captured separately)
   * @param {Element} el - Target element
   * @returns {Record<string, string>} Attribute name → value map
   */
  function getAttrs(el) {
    const attrs = {};
    for (const attr of el.attributes) {
      // Skip class and id (captured separately)
      if (attr.name === "class" || attr.name === "id") continue;
      // Skip style attribute (too verbose, use computedStyles instead)
      if (attr.name === "style") continue;
      // Truncate long values
      attrs[attr.name] = attr.value.length > 200 ? attr.value.slice(0, 200) + "…" : attr.value;
    }
    return attrs;
  }
  
  function createSelectionData(el) {
    const data = {
      element: el,
      selector: generateSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList),
      text: (el.textContent || "").slice(0, TEXT_MAX_LENGTH).trim().replace(/\s+/g, " "),
      rect: getRectData(el),
      attributes: getAttrs(el),
      boxModel: getBoxModel(el),
      accessibility: getAccessibilityInfo(el),
      keyStyles: getKeyStyles(el),
    };
    
    if (debugMode) {
      data.computedStyles = getComputedStyles(el);
      data.parentContext = getParentContext(el);
      data.cssVariables = getCSSVariables(el);
    }
    
    return data;
  }
  
  function getRectData(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x + window.scrollX),
      y: Math.round(rect.y + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // DevTools Context Helpers (v0.3.0)
  // ─────────────────────────────────────────────────────────────────────
  
  /**
   * Get box model breakdown (content, padding, border, margin)
   * @param {Element} el - Target element
   * @returns {{ content: {width: number, height: number}, padding: {...}, border: {...}, margin: {...} }}
   */
  function getBoxModel(el) {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    
    const paddingH = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const paddingV = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const borderH = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const borderV = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    
    return {
      content: {
        width: Math.max(0, Math.round(rect.width - paddingH - borderH)),
        height: Math.max(0, Math.round(rect.height - paddingV - borderV))
      },
      padding: {
        top: Math.round(parseFloat(style.paddingTop)),
        right: Math.round(parseFloat(style.paddingRight)),
        bottom: Math.round(parseFloat(style.paddingBottom)),
        left: Math.round(parseFloat(style.paddingLeft))
      },
      border: {
        top: Math.round(parseFloat(style.borderTopWidth)),
        right: Math.round(parseFloat(style.borderRightWidth)),
        bottom: Math.round(parseFloat(style.borderBottomWidth)),
        left: Math.round(parseFloat(style.borderLeftWidth))
      },
      margin: {
        top: Math.round(parseFloat(style.marginTop)),
        right: Math.round(parseFloat(style.marginRight)),
        bottom: Math.round(parseFloat(style.marginBottom)),
        left: Math.round(parseFloat(style.marginLeft))
      }
    };
  }
  
  // ARIA role mappings for getImplicitRole (defined once, not per-call)
  const INPUT_TYPE_ROLES = {
    button: "button",
    submit: "button",
    reset: "button",
    image: "button",
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    number: "spinbutton",
    search: "searchbox",
    email: "textbox",
    tel: "textbox",
    url: "textbox",
    text: "textbox",
    password: "textbox",
  };
  
  const TAG_ROLES = {
    article: "article",
    aside: "complementary",
    button: "button",
    datalist: "listbox",
    details: "group",
    dialog: "dialog",
    fieldset: "group",
    figure: "figure",
    footer: "contentinfo",
    form: "form",
    h1: "heading", h2: "heading", h3: "heading",
    h4: "heading", h5: "heading", h6: "heading",
    header: "banner",
    hr: "separator",
    li: "listitem",
    main: "main",
    math: "math",
    menu: "list",
    nav: "navigation",
    ol: "list",
    optgroup: "group",
    option: "option",
    output: "status",
    progress: "progressbar",
    section: "region",
    select: "combobox",
    summary: "button",
    table: "table",
    tbody: "rowgroup",
    td: "cell",
    textarea: "textbox",
    tfoot: "rowgroup",
    th: "columnheader",
    thead: "rowgroup",
    tr: "row",
    ul: "list",
  };
  
  /**
   * Get implicit ARIA role for an element based on tag and attributes
   * @param {Element} el - Target element
   * @returns {string|null} Implicit role or null
   */
  function getImplicitRole(el) {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type")?.toLowerCase();
    
    // Special cases
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "area") return el.hasAttribute("href") ? "link" : null;
    if (tag === "input") return type ? (INPUT_TYPE_ROLES[type] || "textbox") : "textbox";
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt === null) return "img";
      if (alt === "") return "presentation";
      return "img";
    }
    
    return TAG_ROLES[tag] || null;
  }
  
  /**
   * Check if element can receive keyboard focus
   * @param {Element} el - Target element
   * @returns {boolean}
   */
  function isFocusable(el) {
    if (el.hasAttribute("tabindex")) {
      return el.tabIndex >= 0;
    }
    if (el.disabled) return false;
    
    const tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "area") {
      return el.hasAttribute("href");
    }
    
    return ["button", "input", "select", "textarea"].includes(tag);
  }
  
  /**
   * Get computed accessible name for an element
   * @param {Element} el - Target element
   * @returns {string|null}
   */
  function getAccessibleName(el) {
    // Priority: aria-labelledby > aria-label > label[for] > title > text content
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const name = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean).join(" ");
      if (name) return name;
    }
    
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;
    
    // For labelable elements, check associated label
    const tag = el.tagName.toLowerCase();
    const labelable = ["input", "select", "textarea", "button", "meter", "progress", "output"];
    if (el.id && labelable.includes(tag)) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent?.trim() || null;
    }
    
    const title = el.getAttribute("title");
    if (title) return title;
    
    // Fallback to text content for interactive elements
    if (["button", "a", "label", "legend", "caption"].includes(tag)) {
      const text = el.textContent?.trim();
      return text ? text.slice(0, 100) : null;
    }
    
    // For img, use alt
    if (tag === "img") {
      return el.getAttribute("alt") || null;
    }
    
    return null;
  }
  
  /**
   * Get aria-describedby content
   * @param {Element} el - Target element
   * @returns {string|null}
   */
  function getAccessibleDescription(el) {
    const describedBy = el.getAttribute("aria-describedby");
    if (describedBy) {
      return describedBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean).join(" ") || null;
    }
    return null;
  }
  
  /**
   * Get accessibility information for an element
   * @param {Element} el - Target element
   * @returns {AccessibilityInfo}
   */
  function getAccessibilityInfo(el) {
    const role = el.getAttribute("role") || getImplicitRole(el);
    const ariaExpanded = el.getAttribute("aria-expanded");
    const ariaPressed = el.getAttribute("aria-pressed");
    const ariaChecked = el.getAttribute("aria-checked");
    const ariaSelected = el.getAttribute("aria-selected");
    
    const parseAriaBoolean = (val) => val === "true" ? true : val === "false" ? false : undefined;
    
    return {
      role,
      name: getAccessibleName(el),
      description: getAccessibleDescription(el),
      focusable: isFocusable(el),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      expanded: parseAriaBoolean(ariaExpanded),
      pressed: parseAriaBoolean(ariaPressed),
      checked: typeof el.checked === "boolean" ? el.checked : parseAriaBoolean(ariaChecked),
      selected: typeof el.selected === "boolean" ? el.selected : parseAriaBoolean(ariaSelected)
    };
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Key Styles (always captured)
  // ─────────────────────────────────────────────────────────────────────

  const KEY_STYLE_PROPERTIES = [
    "display", "position", "overflow", "zIndex", "opacity",
    "color", "backgroundColor", "fontSize", "fontWeight",
  ];

  const KEY_STYLE_DEFAULTS = new Set([
    "static", "visible", "1", "auto", "normal",
    "rgb(0, 0, 0)", "rgba(0, 0, 0, 0)", "transparent",
    "16px", "400",
  ]);

  /**
   * Get a small set of layout-critical CSS properties (always captured)
   * @param {Element} el - Target element
   * @returns {Record<string, string>}
   */
  function getKeyStyles(el) {
    const computed = window.getComputedStyle(el);
    const styles = {};
    for (const key of KEY_STYLE_PROPERTIES) {
      const value = computed[key];
      if (value && !KEY_STYLE_DEFAULTS.has(value)) {
        styles[key] = value;
      }
    }
    return styles;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Debug Mode Helpers (v0.3.0)
  // ─────────────────────────────────────────────────────────────────────

  const COMPUTED_STYLE_KEYS = [
    // Layout
    "display", "position", "top", "right", "bottom", "left",
    "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
    // Flexbox
    "flexDirection", "flexWrap", "justifyContent", "alignItems", "alignSelf", "flex", "gap",
    // Grid
    "gridTemplateColumns", "gridTemplateRows", "gridColumn", "gridRow",
    // Visual
    "overflow", "overflowX", "overflowY", "zIndex", "opacity", "visibility",
    // Typography
    "color", "fontSize", "fontWeight", "fontFamily", "lineHeight", "textAlign",
    // Background & Border
    "backgroundColor", "backgroundImage", "borderRadius", "boxShadow",
    // Transform
    "transform", "transformOrigin",
    // Interaction
    "cursor", "pointerEvents", "userSelect"
  ];
  
  const DEFAULT_STYLE_VALUES = new Set([
    "none", "auto", "normal", "visible", "static", "baseline",
    "0px", "0", "1", "start", "stretch", "row", "nowrap",
    "rgba(0, 0, 0, 0)", "rgb(0, 0, 0)", "transparent"
  ]);
  
  /**
   * Get computed styles (debug mode only)
   * @param {Element} el - Target element
   * @returns {Record<string, string>}
   */
  function getComputedStyles(el) {
    const computed = window.getComputedStyle(el);
    const styles = {};
    
    for (const key of COMPUTED_STYLE_KEYS) {
      const value = computed[key];
      if (value && !DEFAULT_STYLE_VALUES.has(value)) {
        styles[key] = value.length > 150 ? value.slice(0, 150) + "…" : value;
      }
    }
    
    return styles;
  }
  
  /**
   * Get parent element context (debug mode only)
   * @param {Element} el - Target element
   * @returns {ParentContext|null}
   */
  function getParentContext(el) {
    let parent = el.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) {
      return null;
    }
    
    // Skip pi-annotate UI elements
    while (parent && isPiElement(parent)) {
      parent = parent.parentElement;
    }
    if (!parent || parent === document.body || parent === document.documentElement) {
      return null;
    }
    
    const computed = window.getComputedStyle(parent);
    const styles = {};
    
    styles.display = computed.display;
    styles.position = computed.position;
    
    if (computed.display.includes("flex")) {
      styles.flexDirection = computed.flexDirection;
      styles.flexWrap = computed.flexWrap;
      styles.justifyContent = computed.justifyContent;
      styles.alignItems = computed.alignItems;
      if (computed.gap && computed.gap !== "normal") {
        styles.gap = computed.gap;
      }
    }
    
    if (computed.display.includes("grid")) {
      styles.gridTemplateColumns = computed.gridTemplateColumns;
      styles.gridTemplateRows = computed.gridTemplateRows;
      if (computed.gap && computed.gap !== "normal") {
        styles.gap = computed.gap;
      }
    }
    
    if (computed.overflow !== "visible") {
      styles.overflow = computed.overflow;
    }
    
    return {
      tag: parent.tagName.toLowerCase(),
      id: parent.id || undefined,
      classes: Array.from(parent.classList),
      styles
    };
  }
  
  /**
   * Discover all CSS variable names from stylesheets
   * @returns {Set<string>}
   */
  function discoverCSSVariables() {
    if (cachedCSSVarNames) return cachedCSSVarNames;
    
    const varNames = new Set();
    
    function extractFromRules(rules) {
      if (!rules) return;
      for (const rule of rules) {
        if (rule.style) {
          for (const prop of rule.style) {
            if (prop.startsWith("--")) {
              varNames.add(prop);
            }
          }
        }
        if (rule.cssRules) {
          extractFromRules(rule.cssRules);
        }
      }
    }
    
    for (const sheet of document.styleSheets) {
      try {
        extractFromRules(sheet.cssRules);
      } catch (e) {
        // CORS blocks access - skip this sheet
      }
    }
    
    cachedCSSVarNames = varNames;
    return varNames;
  }
  
  /**
   * Get CSS variables used by element (debug mode only)
   * @param {Element} el - Target element
   * @returns {Record<string, string>}
   */
  function getCSSVariables(el) {
    const style = window.getComputedStyle(el);
    const varNames = discoverCSSVariables();
    const variables = {};
    
    let count = 0;
    for (const name of varNames) {
      if (count >= 50) break;
      const value = style.getPropertyValue(name).trim();
      if (value) {
        variables[name] = value.length > 100 ? value.slice(0, 100) + "…" : value;
        count++;
      }
    }
    
    return variables;
  }
  
  /**
   * Reset CSS variable cache (call on deactivate)
   */
  function resetCSSVarCache() {
    cachedCSSVarNames = null;
  }
  
  function pruneStaleSelections() {
    if (!selectedElements.length) return;
    
    const nextSelections = [];
    const nextScreenshots = new Map();
    const nextComments = new Map();
    const nextPositions = new Map();
    const nextOpenNotes = new Set();
    
    selectedElements.forEach((sel, i) => {
      if (sel?.element && document.contains(sel.element)) {
        const nextIndex = nextSelections.length;
        nextSelections.push(sel);
        
        if (elementScreenshots.has(i)) {
          nextScreenshots.set(nextIndex, elementScreenshots.get(i));
        }
        if (elementComments.has(i)) {
          nextComments.set(nextIndex, elementComments.get(i));
        }
        if (notePositions.has(i)) {
          nextPositions.set(nextIndex, notePositions.get(i));
        }
        if (openNotes.has(i)) {
          nextOpenNotes.add(nextIndex);
        }
      } else if (openNotes.has(i)) {
        const card = notesContainer?.querySelector(`[data-index="${i}"]`);
        if (card) card.remove();
      }
    });
    
    if (nextSelections.length !== selectedElements.length) {
      selectedElements = nextSelections;
      elementScreenshots = nextScreenshots;
      elementComments = nextComments;
      notePositions = nextPositions;
      
      notesContainer.innerHTML = "";
      openNotes = new Set();
      nextOpenNotes.forEach(i => createNoteCard(i));
      
      updateBadges();
      updateConnectors();
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Screenshot Cropping
  // ─────────────────────────────────────────────────────────────────────
  
  async function cropToElement(dataUrl, element) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const dpr = window.devicePixelRatio || 1;
        
        const rect = element.getBoundingClientRect();
        
        let minX = Math.max(0, rect.left - SCREENSHOT_PADDING);
        let minY = Math.max(0, rect.top - SCREENSHOT_PADDING);
        let maxX = Math.min(window.innerWidth, rect.right + SCREENSHOT_PADDING);
        let maxY = Math.min(window.innerHeight, rect.bottom + SCREENSHOT_PADDING);
        
        const cropW = Math.max(1, (maxX - minX) * dpr);
        const cropH = Math.max(1, (maxY - minY) * dpr);
        
        if (maxX <= minX || maxY <= minY) {
          resolve(dataUrl);
          return;
        }
        
        const cropX = minX * dpr;
        const cropY = minY * dpr;
        
        const canvas = document.createElement("canvas");
        canvas.width = cropW;
        canvas.height = cropH;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        
        ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  
  /**
   * Add numbered badges to a full-page screenshot for selected elements
   * @param {string} dataUrl - Base64 screenshot data URL
   * @param {Array<{element: Element}>} elements - Selected elements with their DOM references
   * @returns {Promise<string>} Modified screenshot with badges
   */
  async function addBadgesToScreenshot(dataUrl, elements) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const dpr = window.devicePixelRatio || 1;
        
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        
        // Draw the original screenshot
        ctx.drawImage(img, 0, 0);
        
        // Badge styling (matches .pi-marker-badge)
        const badgeSize = 28 * dpr;
        const fontSize = 13 * dpr;
        const bgColor = "#8abeb7";     // --pi-accent (teal)
        const textColor = "#1d1f21";   // --pi-bg-body (dark)
        
        elements.forEach((sel, i) => {
          const element = sel.element;
          if (!element || !document.contains(element)) return;
          
          const rect = element.getBoundingClientRect();
          
          // Badge center should be at element's top-right corner (matching DOM badge positioning)
          // DOM: badge.style.left = rect.right - 14, badge.style.top = rect.top - 14
          // This puts the 28px badge's CENTER at (rect.right, rect.top)
          const centerX = rect.right * dpr;
          const centerY = rect.top * dpr;
          
          // Clamp to keep badge fully visible within canvas
          const badgeX = Math.max(badgeSize / 2, Math.min(centerX, canvas.width - badgeSize / 2));
          const badgeY = Math.max(badgeSize / 2, Math.min(centerY, canvas.height - badgeSize / 2));
          
          // Badge shadow (set before fill so it applies to the shape)
          ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
          ctx.shadowBlur = 4 * dpr;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 2 * dpr;
          
          // Badge background (circle)
          ctx.beginPath();
          ctx.arc(badgeX, badgeY, badgeSize / 2, 0, Math.PI * 2);
          ctx.fillStyle = bgColor;
          ctx.fill();
          
          // Reset shadow for text
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
          
          // Badge number
          ctx.fillStyle = textColor;
          ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(i + 1), badgeX, badgeY);
        });
        
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Submit / Cancel
  // ─────────────────────────────────────────────────────────────────────
  
  async function handleSubmit() {
    const context = document.getElementById("pi-context")?.value?.trim() || "";
    
    // Re-capture debug data for all elements if debug mode is on at submit time
    // (handles elements selected before debug was enabled)
    pruneStaleSelections();
    if (debugMode) {
      selectedElements.forEach(sel => {
        if (sel.element && document.contains(sel.element)) {
          sel.computedStyles = getComputedStyles(sel.element);
          sel.parentContext = getParentContext(sel.element);
          sel.cssVariables = getCSSVariables(sel.element);
        }
      });
    }

    const elements = selectedElements.map((sel, i) => {
      const { element, ...rest } = sel;
      return {
        ...rest,
        comment: elementComments.get(i) || ""
      };
    });
    
    // Hide UI for screenshot capture
    hideHighlight();
    hideTooltip();
    if (markersContainer) markersContainer.style.display = "none";
    if (notesContainer) notesContainer.style.display = "none";
    if (connectorsEl) connectorsEl.style.display = "none";
    if (panelEl) panelEl.style.display = "none";
    
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    
    let screenshot = null;
    let screenshots = [];
    
    if (screenshotMode !== "none") {
      try {
        const resp = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" });
        if (resp?.dataUrl) {
          const fullScreenshot = resp.dataUrl;
          
          if (screenshotMode === "full") {
            // Add numbered badges to the full screenshot so elements can be identified
            screenshot = await addBadgesToScreenshot(fullScreenshot, selectedElements);
          } else {
            for (let i = 0; i < selectedElements.length; i++) {
              const hasScreenshot = elementScreenshots.get(i) !== false;
              const element = selectedElements[i].element;
              if (hasScreenshot && element && document.contains(element)) {
                const cropped = await cropToElement(fullScreenshot, element);
                screenshots.push({ index: i + 1, dataUrl: cropped });
              }
            }
          }
        }
      } catch (err) {
        console.error("[pi-annotate] Screenshot failed:", err);
      }
    }
    
    chrome.runtime.sendMessage({
      type: "ANNOTATIONS_COMPLETE",
      requestId,
      result: {
        success: true,
        elements,
        screenshot,
        screenshots,
        prompt: context,
        url: window.location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      },
    });
    
    deactivate();
  }
  
  function handleCancel() {
    const id = requestId;
    deactivate();
    
    try {
      chrome.runtime.sendMessage({
        type: "CANCEL",
        requestId: id,
        reason: "user",
      });
    } catch (e) {
      console.log("[pi-annotate] Could not send cancel (no connection)");
    }
  }
  
  console.log("[pi-annotate] Content script ready (v0.3.4)");
})();
