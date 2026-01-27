/**
 * Pi Annotate - Background Service Worker
 * 
 * Connects to native messaging host and forwards messages between
 * the native host (Pi) and content scripts.
 */

let nativePort = null;
const requestTabs = new Map();

function getRequestId(msg) {
  return typeof msg.requestId === "number" ? msg.requestId : (typeof msg.id === "number" ? msg.id : null);
}

function sendToNative(msg) {
  if (!nativePort) {
    console.error("[pi-annotate] Cannot send to native host - not connected");
    return;
  }
  try {
    nativePort.postMessage(msg);
  } catch (err) {
    console.error("[pi-annotate] Failed to send to native host:", err);
  }
}

// Send message to content script, injecting it first if needed
async function sendToContentScript(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    // Content script not loaded - try to inject it
    console.log("[pi-annotate] Content script not found, injecting...");
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      // Wait a moment for script to initialize
      await new Promise(r => setTimeout(r, 100));
      await chrome.tabs.sendMessage(tabId, msg);
    } catch (injectErr) {
      console.error("[pi-annotate] Failed to inject content script:", injectErr.message);
    }
  }
}

function connectNative() {
  console.log("[pi-annotate] Connecting to native host...");
  nativePort = chrome.runtime.connectNative("com.pi.annotate");
  
  nativePort.onMessage.addListener((msg) => {
    console.log("[pi-annotate] From native host:", msg);
    
    // Forward to active tab's content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) {
        console.log("[pi-annotate] No active tab found");
        return;
      }
      
      const requestId = getRequestId(msg);
      const tabId = requestId && requestTabs.has(requestId) ? requestTabs.get(requestId) : tabs[0].id;
      const currentUrl = tabs[0].url;
      
      if (msg.type === "START_ANNOTATION") {
        // If URL provided and different from current, navigate first
        if (msg.url && currentUrl !== msg.url) {
          console.log("[pi-annotate] Navigating to:", msg.url);
          chrome.tabs.update(tabId, { url: msg.url }, (tab) => {
            if (chrome.runtime.lastError) {
              console.error("[pi-annotate] Failed to navigate:", chrome.runtime.lastError.message);
              return;
            }
            
            // Wait for page load with timeout
            let timeoutId = null;
            const listener = (updatedTabId, info) => {
              if (updatedTabId === tab.id && info.status === "complete") {
                if (timeoutId) clearTimeout(timeoutId);
                chrome.tabs.onUpdated.removeListener(listener);
                setTimeout(() => {
                  if (requestId) requestTabs.set(requestId, tab.id);
                  sendToContentScript(tab.id, msg);
                }, 150);
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            
            // Cleanup listener after 30s timeout
            timeoutId = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              console.log("[pi-annotate] Navigation timeout - listener removed");
              if (requestId) {
                sendToNative({ type: "CANCEL", requestId, reason: "navigation_timeout" });
              }
            }, 30000);
          });
        } else {
          // No URL or same URL - just activate on current tab
          console.log("[pi-annotate] Activating on current tab:", currentUrl);
          if (requestId) requestTabs.set(requestId, tabId);
          sendToContentScript(tabId, msg);
        }
      } else {
        sendToContentScript(tabId, msg);
      }
    });
  });
  
  nativePort.onDisconnect.addListener(() => {
    console.log("[pi-annotate] Native host disconnected");
    nativePort = null;
    // Reconnect after delay
    setTimeout(connectNative, 2000);
  });
}

// Handle messages from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[pi-annotate] From content:", msg.type);
  const requestId = getRequestId(msg);
  
  // Handle screenshot capture
  if (msg.type === "CAPTURE_SCREENSHOT") {
    if (!sender.tab?.windowId) {
      console.log("[pi-annotate] Screenshot failed: No window ID");
      sendResponse({ error: "No window ID" });
      return true;
    }
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.log("[pi-annotate] Screenshot error:", chrome.runtime.lastError.message);
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        console.log("[pi-annotate] Screenshot captured, size:", dataUrl?.length || 0);
        sendResponse({ dataUrl });
      }
    });
    return true;
  }
  
  // Forward to native host
  if (["ANNOTATIONS_COMPLETE", "CANCEL"].includes(msg.type)) {
    if (requestId) requestTabs.delete(requestId);
    console.log("[pi-annotate] Forwarding to native host:", msg.type);
    sendToNative(msg);
  }
});

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-picker") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_PICKER" });
      }
    });
  }
});

// Note: Extension icon click now shows popup (popup.html)
// Use keyboard shortcut (Cmd+Shift+P) or /annotate command to toggle picker

// Connect on startup
connectNative();
console.log("[pi-annotate] Background script loaded");
