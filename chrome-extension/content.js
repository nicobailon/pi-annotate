/**
 * Pi Annotate - Content Script
 * 
 * DevTools-like element picker:
 * - Hover to highlight elements
 * - Scroll to cycle through parent elements
 * - Click to select (shift+click for multi)
 * - Bottom panel for prompt input
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
  let elementScreenshots = new Map(); // element index -> true/false for screenshot
  
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
    #pi-highlight {
      position: fixed;
      pointer-events: none;
      z-index: ${Z_INDEX_HIGHLIGHT};
      background: rgba(99, 102, 241, 0.1);
      border: 2px solid #6366f1;
      border-radius: 2px;
      transition: all 0.05s ease-out;
    }
    
    #pi-tooltip {
      position: fixed;
      pointer-events: none;
      z-index: ${Z_INDEX_TOOLTIP};
      background: #1a1a1a;
      color: #e5e5e5;
      padding: 6px 10px;
      border-radius: 4px;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      max-width: 400px;
    }
    
    #pi-tooltip .tag { color: #f472b6; }
    #pi-tooltip .id { color: #fbbf24; }
    #pi-tooltip .class { color: #60a5fa; }
    #pi-tooltip .size { color: #a3a3a3; margin-left: 8px; }
    #pi-tooltip .hint { color: #6366f1; font-size: 11px; margin-top: 4px; display: block; }
    
    #pi-markers {
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: ${Z_INDEX_MARKERS};
    }
    
    .pi-marker {
      position: fixed;
      pointer-events: none;
      border: 2px solid #22c55e;
      background: rgba(34, 197, 94, 0.1);
      border-radius: 2px;
    }
    
    .pi-marker-badge {
      position: absolute;
      top: -10px; left: -10px;
      background: #22c55e;
      color: white;
      min-width: 20px; height: 20px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font: bold 11px sans-serif;
      padding: 0 6px;
    }
    
    #pi-panel {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: linear-gradient(180deg, #1f1f23 0%, #18181b 100%);
      color: #e5e5e5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 10px 16px;
      z-index: ${Z_INDEX_PANEL};
      box-shadow: 0 -4px 24px rgba(0,0,0,0.5);
      border-top: 1px solid #3f3f46;
    }
    
    #pi-panel * { box-sizing: border-box; }
    
    .pi-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
      padding-bottom: 6px;
      border-bottom: 1px solid #27272a;
    }
    
    .pi-logo { 
      font-size: 15px; 
      font-weight: 700; 
      color: #a78bfa;
      background: linear-gradient(135deg, #a78bfa 0%, #6366f1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .pi-hint { color: #71717a; font-size: 11px; margin-left: auto; }
    
    .pi-close {
      background: none;
      border: none;
      color: #71717a;
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .pi-close:hover { color: #ef4444; }
    
    .pi-main {
      display: flex;
      gap: 12px;
      margin-bottom: 8px;
    }
    
    .pi-left { flex: 1; min-width: 0; }
    .pi-right { width: 160px; flex-shrink: 0; }
    
    .pi-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 6px;
      min-height: 26px;
    }
    
    .pi-chip {
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 4px;
      max-width: 200px;
    }
    
    .pi-chip-num {
      background: #22c55e;
      color: white;
      width: 14px; height: 14px;
      border-radius: 7px;
      font-size: 9px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    
    .pi-chip-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
      position: relative;
    }
    
    .pi-chip-text:hover {
      color: #e5e5e5;
    }
    
    .pi-chip-text.copied::after {
      content: "Copied!";
      position: absolute;
      top: -28px;
      left: 50%;
      transform: translateX(-50%);
      background: #22c55e;
      color: white;
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 4px;
      white-space: nowrap;
      z-index: 10;
    }
    
    .pi-chip-btns {
      display: flex;
      gap: 2px;
      margin-left: 2px;
    }
    
    .pi-chip-btn {
      color: #71717a;
      cursor: pointer;
      font-size: 12px;
      padding: 0 2px;
      line-height: 1;
      background: none;
      border: none;
    }
    
    .pi-chip-btn:hover { color: #a1a1aa; }
    .pi-chip-btn.remove:hover { color: #ef4444; }
    .pi-chip-btn.screenshot { font-size: 11px; opacity: 0.4; }
    .pi-chip-btn.screenshot.active { opacity: 1; }
    .pi-chip-btn.screenshot:hover { opacity: 0.8; }
    
    .pi-empty { color: #52525b; font-size: 11px; font-style: italic; padding: 4px 0; }
    
    .pi-mode-toggle {
      display: flex;
      gap: 4px;
      margin-bottom: 6px;
    }
    
    .pi-mode-btn {
      flex: 1;
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 10px;
      color: #a1a1aa;
      cursor: pointer;
      text-align: center;
    }
    
    .pi-mode-btn:hover { background: #3f3f46; }
    
    .pi-mode-btn.active {
      background: #6366f1;
      border-color: #6366f1;
      color: white;
    }
    
    .pi-controls-row {
      display: flex;
      gap: 4px;
      margin-top: 6px;
    }
    
    .pi-prompt textarea {
      width: 100%;
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 4px;
      color: #e5e5e5;
      font-family: inherit;
      font-size: 12px;
      padding: 8px 10px;
      resize: none;
      height: 52px;
    }
    
    .pi-prompt textarea:focus {
      outline: none;
      border-color: #6366f1;
    }
    
    .pi-prompt textarea::placeholder { color: #52525b; }
    
    .pi-options {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    
    .pi-options-label {
      font-size: 12px;
      color: #71717a;
    }
    
    .pi-screenshot-toggle {
      display: flex;
      gap: 2px;
      background: #1f1f23;
      padding: 2px;
      border-radius: 4px;
    }
    
    .pi-ss-btn {
      background: transparent;
      border: none;
      border-radius: 3px;
      padding: 4px 10px;
      font-size: 10px;
      color: #71717a;
      cursor: pointer;
      transition: all 0.15s;
    }
    
    .pi-ss-btn:hover { color: #a1a1aa; }
    
    .pi-ss-btn.active {
      background: #6366f1;
      color: white;
    }
    
    .pi-actions {
      display: flex;
      justify-content: flex-end;
      padding-top: 8px;
      border-top: 1px solid #27272a;
    }
    
    .pi-buttons { display: flex; gap: 8px; }
    
    .pi-btn {
      padding: 6px 14px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.15s;
    }
    
    .pi-btn-cancel {
      background: #27272a;
      color: #a1a1aa;
      border: 1px solid #3f3f46;
    }
    
    .pi-btn-cancel:hover { background: #3f3f46; color: #e5e5e5; }
    
    .pi-btn-submit {
      background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
      color: white;
    }
    
    .pi-btn-submit:hover { 
      background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%);
    }
    
    .pi-current-info {
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #a1a1aa;
      /* Fixed height - prevent layout shift from long selectors */
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      /* Click to copy */
      cursor: pointer;
      transition: border-color 0.15s;
      position: relative;
    }
    
    .pi-current-info:hover {
      border-color: #6366f1;
    }
    
    .pi-current-info.copied {
      border-color: #22c55e;
    }
    
    .pi-current-info.copied::after {
      content: "Copied!";
      position: absolute;
      top: -24px;
      left: 50%;
      transform: translateX(-50%);
      background: #22c55e;
      color: white;
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 4px;
      white-space: nowrap;
    }
    
    .pi-current-info .tag { color: #f472b6; }
    .pi-current-info .id { color: #fbbf24; }
    .pi-current-info .class { color: #60a5fa; }
    
    .pi-nav-btn {
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 13px;
      color: #a1a1aa;
      cursor: pointer;
      flex: 1;
      text-align: center;
    }
    
    .pi-nav-btn:hover { background: #3f3f46; color: #e5e5e5; }
    .pi-nav-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    
    .pi-nav-label {
      text-align: center;
      font-size: 9px;
      color: #52525b;
      margin-top: 2px;
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
    }
  });
  
  // ─────────────────────────────────────────────────────────────────────
  // Activation
  // ─────────────────────────────────────────────────────────────────────
  
  function activate() {
    if (isActive) return;
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
    createPanel();
    
    // Add listeners
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    document.addEventListener("keydown", onKeyDown, true);
    
    document.body.style.cursor = "crosshair";
    console.log("[pi-annotate] Activated");
  }
  
  function deactivate() {
    if (!isActive) return;
    isActive = false;
    
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("wheel", onWheel, { capture: true });
    document.removeEventListener("keydown", onKeyDown, true);
    
    document.body.style.cursor = "";
    
    styleEl?.remove();
    highlightEl?.remove();
    tooltipEl?.remove();
    panelEl?.remove();
    markersContainer?.remove();
    
    styleEl = highlightEl = tooltipEl = panelEl = markersContainer = null;
    elementStack = [];
    stackIndex = 0;
    selectedElements = [];
    elementScreenshots = new Map();
    requestId = null;
    multiSelectMode = false;
    screenshotMode = "each";
    
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
  
  function createPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "pi-panel";
    panelEl.innerHTML = `
      <div class="pi-header">
        <span class="pi-logo">π Annotate</span>
        <span class="pi-hint">Click to select • Scroll ancestors • Shift+click multi • ESC</span>
        <button class="pi-close" id="pi-close" title="Close (ESC)">×</button>
      </div>
      <div class="pi-main">
        <div class="pi-left">
          <div class="pi-chips" id="pi-chips">
            <span class="pi-empty">Click an element on the page to select it</span>
          </div>
          <div class="pi-options">
            <span class="pi-options-label">📷</span>
            <div class="pi-screenshot-toggle">
              <button class="pi-ss-btn active" id="pi-ss-each" title="Screenshot each selected element">Each</button>
              <button class="pi-ss-btn" id="pi-ss-full" title="Screenshot full viewport">Full page</button>
              <button class="pi-ss-btn" id="pi-ss-none" title="No screenshots">None</button>
            </div>
          </div>
          <div class="pi-prompt">
            <textarea id="pi-prompt" placeholder="Describe what should change..."></textarea>
          </div>
        </div>
        <div class="pi-right">
          <div class="pi-mode-toggle">
            <button class="pi-mode-btn active" id="pi-mode-single" title="Click replaces selection">Single</button>
            <button class="pi-mode-btn" id="pi-mode-multi" title="Click adds to selection">Multi</button>
          </div>
          <div class="pi-current-info" id="pi-current-info">
            <span style="color:#52525b">Hover over element</span>
          </div>
          <div class="pi-nav-label" id="pi-nav-label">-</div>
          <div class="pi-controls-row">
            <button class="pi-nav-btn" id="pi-nav-up" title="Expand to parent">▲</button>
            <button class="pi-nav-btn" id="pi-nav-down" title="Contract to child">▼</button>
          </div>
        </div>
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
    document.getElementById("pi-nav-up").addEventListener("click", () => navParent(1));
    document.getElementById("pi-nav-down").addEventListener("click", () => navParent(-1));
    
    // Mode toggle
    document.getElementById("pi-mode-single").addEventListener("click", () => setMultiMode(false));
    document.getElementById("pi-mode-multi").addEventListener("click", () => setMultiMode(true));
    
    // Screenshot mode toggle
    document.getElementById("pi-ss-each").addEventListener("click", () => setScreenshotMode("each"));
    document.getElementById("pi-ss-full").addEventListener("click", () => setScreenshotMode("full"));
    document.getElementById("pi-ss-none").addEventListener("click", () => setScreenshotMode("none"));
    
    // Click to copy selector
    document.getElementById("pi-current-info").addEventListener("click", copyCurrentSelector);
    
    // Stop events from reaching the page (but allow interactive elements to work)
    panelEl.addEventListener("mousemove", e => e.stopPropagation(), true);
    panelEl.addEventListener("click", e => {
      // Don't stop propagation for interactive elements - let them handle clicks
      const target = e.target;
      if (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return; // Let it through
      }
      // Allow click-to-copy on current info box
      if (target.closest('#pi-current-info')) {
        return;
      }
      e.stopPropagation();
    }, true);
  }
  
  function navParent(dir) {
    // Always operate on the last selected element
    if (!selectedElements.length) {
      console.log("[pi-annotate] No selected element - click an element first");
      return;
    }
    
    const lastIdx = selectedElements.length - 1;
    const sel = selectedElements[lastIdx];
    if (!sel?.element) return;
    
    if (dir > 0) {
      // Go to parent
      const parent = sel.element.parentElement;
      if (parent && parent !== document.body && parent !== document.documentElement && !parent.id?.startsWith("pi-")) {
        console.log("[pi-annotate] Expanding selection to parent:", parent.tagName);
        selectedElements[lastIdx] = createSelectionData(parent);
        updateMarkers();
        updateChips();
      } else {
        console.log("[pi-annotate] Already at root - no valid parent");
      }
    } else {
      // Go to first child
      const children = Array.from(sel.element.children).filter(c => 
        c.nodeType === 1 && !c.id?.startsWith("pi-")
      );
      if (children.length > 0) {
        console.log("[pi-annotate] Contracting selection to child:", children[0].tagName);
        selectedElements[lastIdx] = createSelectionData(children[0]);
        updateMarkers();
        updateChips();
      } else {
        console.log("[pi-annotate] No children to contract to");
      }
    }
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
  // Event Handlers
  // ─────────────────────────────────────────────────────────────────────
  
  function onMouseMove(e) {
    if (!isActive || e.target.closest("#pi-panel")) {
      hideHighlight();
      hideTooltip();
      return;
    }
    
    highlightEl.style.display = "none";
    tooltipEl.style.display = "none";
    const el = document.elementFromPoint(e.clientX, e.clientY);
    highlightEl.style.display = "";
    
    if (!el || el === document.body || el === document.documentElement || el.id?.startsWith("pi-")) {
      hideHighlight();
      hideTooltip();
      return;
    }
    
    // Build parent chain
    elementStack = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      if (!current.id?.startsWith("pi-")) {
        elementStack.push(current);
      }
      current = current.parentElement;
    }
    stackIndex = 0;
    
    updateHighlight();
    updateTooltip(e.clientX, e.clientY);
  }
  
  function onWheel(e) {
    if (!isActive || !elementStack.length || e.target.closest("#pi-panel")) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    stackIndex = e.deltaY > 0 
      ? Math.min(stackIndex + 1, elementStack.length - 1)
      : Math.max(stackIndex - 1, 0);
    
    updateHighlight();
    updateTooltip(e.clientX, e.clientY);
  }
  
  function onClick(e) {
    if (!isActive || e.target.closest("#pi-panel")) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const el = elementStack[stackIndex];
    if (!el) return;
    
    const idx = selectedElements.findIndex(s => s.element === el);
    
    if (idx >= 0) {
      // Already selected - deselect it
      selectedElements.splice(idx, 1);
      // Shift screenshot states for indices after removed element
      const newMap = new Map();
      elementScreenshots.forEach((v, k) => {
        if (k < idx) newMap.set(k, v);
        else if (k > idx) newMap.set(k - 1, v);
      });
      elementScreenshots = newMap;
    } else {
      // Not selected - add it
      const addToExisting = multiSelectMode || e.shiftKey;
      if (!addToExisting) {
        selectedElements = [];
        elementScreenshots = new Map(); // Clear screenshot states too
      }
      selectElement(el);
    }
    
    updateMarkers();
    updateChips();
  }
  
  function onKeyDown(e) {
    if (!isActive) return;
    if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
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
  
  function getAttrs(el) {
    const attrs = {};
    ["href", "src", "type", "name", "placeholder", "aria-label", "role", "data-testid"].forEach(name => {
      const val = el.getAttribute(name);
      if (val) attrs[name] = val.slice(0, 100);
    });
    return attrs;
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // UI Updates
  // ─────────────────────────────────────────────────────────────────────
  
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
    
    // Also update panel info
    updateCurrentInfo();
  }
  
  function updateCurrentInfo() {
    const infoEl = document.getElementById("pi-current-info");
    const labelEl = document.getElementById("pi-nav-label");
    if (!infoEl) return;
    
    const el = elementStack[stackIndex];
    if (!el) {
      infoEl.innerHTML = '<span style="color:#52525b">Hover over element</span>';
      infoEl.title = "";
      delete infoEl.dataset.selector;
      if (labelEl) labelEl.textContent = "-";
      return;
    }
    
    const tag = el.tagName.toLowerCase();
    const id = el.id;
    const classes = Array.from(el.classList).slice(0, 2);
    
    let html = `<span class="tag">${escapeHtml(tag)}</span>`;
    if (id) html += `<span class="id">#${escapeHtml(id)}</span>`;
    if (classes.length) html += `<span class="class">.${escapeHtml(classes.join("."))}</span>`;
    
    infoEl.innerHTML = html;
    
    // Build selector for copy and tooltip
    let selector = tag;
    if (id) selector += `#${id}`;
    else if (classes.length) selector += `.${classes.join(".")}`;
    infoEl.title = `${selector} (click to copy)`;
    infoEl.dataset.selector = selector;
    
    if (labelEl && elementStack.length > 1) {
      labelEl.textContent = `Level ${stackIndex + 1} of ${elementStack.length}`;
    } else if (labelEl) {
      labelEl.textContent = "1 element";
    }
  }
  
  function copyCurrentSelector() {
    const infoEl = document.getElementById("pi-current-info");
    const selector = infoEl?.dataset?.selector;
    if (!selector) return;
    
    navigator.clipboard.writeText(selector).then(() => {
      infoEl.classList.add("copied");
      setTimeout(() => infoEl.classList.remove("copied"), 1000);
    }).catch(() => {
      // Fallback - select text
      const range = document.createRange();
      range.selectNodeContents(infoEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
  }
  
  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }
  
  function updateMarkers() {
    if (!markersContainer) return;
    pruneStaleSelections();
    markersContainer.innerHTML = "";
    
    selectedElements.forEach((sel, i) => {
      // Check if element is still in the DOM
      if (!sel.element || !document.contains(sel.element)) {
        return;
      }
      
      const rect = sel.element.getBoundingClientRect();
      const marker = document.createElement("div");
      marker.className = "pi-marker";
      marker.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
      
      const badge = document.createElement("div");
      badge.className = "pi-marker-badge";
      badge.textContent = i + 1;
      marker.appendChild(badge);
      
      markersContainer.appendChild(marker);
    });
  }
  
  function updateChips() {
    const container = document.getElementById("pi-chips");
    if (!container) return;
    pruneStaleSelections();
    
    if (!selectedElements.length) {
      container.innerHTML = '<span class="pi-empty">Click an element on the page to select it</span>';
      return;
    }
    
    container.innerHTML = selectedElements.map((sel, i) => {
      const label = sel.id ? `#${sel.id}` : sel.tag + (sel.classes[0] ? `.${sel.classes[0]}` : "");
      const hasScreenshot = elementScreenshots.get(i) !== false; // Default true
      return `
        <div class="pi-chip">
          <span class="pi-chip-num">${i + 1}</span>
          <button class="pi-chip-btn screenshot ${hasScreenshot ? 'active' : ''}" data-i="${i}" title="Toggle screenshot for this element">📷</button>
          <span class="pi-chip-text" title="${escapeHtml(sel.selector)}">${escapeHtml(label)}</span>
          <span class="pi-chip-btns">
            <button class="pi-chip-btn expand" data-i="${i}" title="Expand to parent">+</button>
            <button class="pi-chip-btn contract" data-i="${i}" title="Contract to child">−</button>
            <button class="pi-chip-btn remove" data-i="${i}" title="Remove">×</button>
          </span>
        </div>
      `;
    }).join("");
    
    container.querySelectorAll(".pi-chip-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        
        const button = e.currentTarget;
        const i = parseInt(button.dataset.i, 10);
        const sel = selectedElements[i];
        
        console.log("[pi-annotate] Chip button clicked:", button.className, "index:", i);
        
        if (button.classList.contains("remove")) {
          selectedElements.splice(i, 1);
          // Shift screenshot states for indices after removed element
          const newMap = new Map();
          elementScreenshots.forEach((v, k) => {
            if (k < i) newMap.set(k, v);
            else if (k > i) newMap.set(k - 1, v);
          });
          elementScreenshots = newMap;
          updateMarkers();
          updateChips();
          return;
        }
        
        if (button.classList.contains("screenshot")) {
          const current = elementScreenshots.get(i) !== false;
          elementScreenshots.set(i, !current);
          updateChips();
          return;
        }
        
        if (!sel || !sel.element) {
          console.log("[pi-annotate] No element reference for index", i);
          return;
        }
        
        if (button.classList.contains("expand")) {
          // Expand to parent
          const parent = sel.element.parentElement;
          if (parent && parent !== document.body && parent !== document.documentElement && !parent.id?.startsWith("pi-")) {
            console.log("[pi-annotate] Expanding to parent:", parent.tagName);
            selectedElements[i] = createSelectionData(parent);
            updateMarkers();
            updateChips();
          } else {
            console.log("[pi-annotate] No valid parent");
          }
        }
        
        if (button.classList.contains("contract")) {
          // Contract to first child
          const children = Array.from(sel.element.children).filter(c => 
            c.nodeType === 1 && !c.id?.startsWith("pi-")
          );
          if (children.length > 0) {
            console.log("[pi-annotate] Contracting to child:", children[0].tagName);
            selectedElements[i] = createSelectionData(children[0]);
            updateMarkers();
            updateChips();
          } else {
            console.log("[pi-annotate] No valid children");
          }
        }
      });
    });
    
    // Click to copy selector on chip text
    container.querySelectorAll(".pi-chip-text").forEach(textEl => {
      textEl.addEventListener("click", e => {
        e.stopPropagation();
        const selector = textEl.title;
        if (!selector) return;
        
        navigator.clipboard.writeText(selector).then(() => {
          textEl.classList.add("copied");
          setTimeout(() => textEl.classList.remove("copied"), 1000);
        }).catch(() => {});
      });
    });
  }
  
  function createSelectionData(el) {
    return {
      element: el,
      selector: generateSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList),
      text: (el.textContent || "").slice(0, TEXT_MAX_LENGTH).trim().replace(/\s+/g, " "),
      rect: getRectData(el),
      attributes: getAttrs(el),
    };
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
  
  function pruneStaleSelections() {
    if (!selectedElements.length) return;
    const nextSelections = [];
    const nextScreenshots = new Map();
    selectedElements.forEach((sel, i) => {
      if (sel?.element && document.contains(sel.element)) {
        const nextIndex = nextSelections.length;
        nextSelections.push(sel);
        if (elementScreenshots.has(i)) {
          nextScreenshots.set(nextIndex, elementScreenshots.get(i));
        }
      }
    });
    if (nextSelections.length !== selectedElements.length) {
      selectedElements = nextSelections;
      elementScreenshots = nextScreenshots;
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
        
        // Add padding and clamp to viewport
        let minX = Math.max(0, rect.left - SCREENSHOT_PADDING);
        let minY = Math.max(0, rect.top - SCREENSHOT_PADDING);
        let maxX = Math.min(window.innerWidth, rect.right + SCREENSHOT_PADDING);
        let maxY = Math.min(window.innerHeight, rect.bottom + SCREENSHOT_PADDING);
        
        // Ensure valid dimensions (element may be off-screen)
        const cropW = Math.max(1, (maxX - minX) * dpr);
        const cropH = Math.max(1, (maxY - minY) * dpr);
        
        // If element is completely off-screen, return full screenshot
        if (maxX <= minX || maxY <= minY) {
          resolve(dataUrl);
          return;
        }
        
        // Scale for device pixel ratio
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
  
  // ─────────────────────────────────────────────────────────────────────
  // Submit / Cancel
  // ─────────────────────────────────────────────────────────────────────
  
  async function handleSubmit() {
    const prompt = document.getElementById("pi-prompt")?.value?.trim() || "";
    
    // Prepare data (without DOM refs)
    pruneStaleSelections();
    const elements = selectedElements.map(({ element, ...rest }) => rest);
    
    // Capture screenshots
    let screenshot = null; // Full page or null
    let screenshots = []; // Individual element screenshots [{index, dataUrl}]
    
    if (screenshotMode !== "none") {
      hideHighlight();
      hideTooltip();
      markersContainer.style.display = "none";
      panelEl.style.display = "none";
      
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      
      try {
        const resp = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" });
        if (resp?.dataUrl) {
          const fullScreenshot = resp.dataUrl;
          
          if (screenshotMode === "full") {
            // Full page mode - single screenshot
            screenshot = fullScreenshot;
          } else {
            // Individual crops for elements with screenshot enabled
            for (let i = 0; i < selectedElements.length; i++) {
              const hasScreenshot = elementScreenshots.get(i) !== false; // Default true
              const element = selectedElements[i].element;
              // Verify element exists and is still in the DOM
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
    
    // Send to background → native host → Pi
    chrome.runtime.sendMessage({
      type: "ANNOTATIONS_COMPLETE",
      requestId,
      result: {
        success: true,
        elements,
        screenshot, // Full page screenshot (if fullPage mode)
        screenshots, // Individual element screenshots [{index, dataUrl}]
        prompt,
        url: window.location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      },
    });
    
    deactivate();
  }
  
  function handleCancel() {
    // Always deactivate locally first
    deactivate();
    
    // Try to notify Pi (but don't wait or fail if it doesn't work)
    try {
      chrome.runtime.sendMessage({
        type: "CANCEL",
        requestId,
        reason: "user",
      });
    } catch (e) {
      console.log("[pi-annotate] Could not send cancel (no connection)");
    }
  }
  
  console.log("[pi-annotate] Content script ready");
})();
