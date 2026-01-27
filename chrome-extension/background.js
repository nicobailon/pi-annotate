/**
 * Pi Annotate v2 - Background Service Worker
 * 
 * Connects to native messaging host and forwards messages between
 * the native host (Pi) and content scripts.
 */

let nativePort = null;

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
      
      const tabId = tabs[0].id;
      const currentUrl = tabs[0].url;
      
      if (msg.type === "START_ANNOTATION") {
        // If URL provided and different from current, navigate first
        if (msg.url && currentUrl !== msg.url) {
          console.log("[pi-annotate] Navigating to:", msg.url);
          chrome.tabs.update(tabId, { url: msg.url }, (tab) => {
            // Wait for page load
            const listener = (updatedTabId, info) => {
              if (updatedTabId === tab.id && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                setTimeout(() => {
                  sendToContentScript(tab.id, msg);
                }, 150);
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        } else {
          // No URL or same URL - just activate on current tab
          console.log("[pi-annotate] Activating on current tab:", currentUrl);
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
    if (nativePort) {
      console.log("[pi-annotate] Forwarding to native host:", msg.type);
      try {
        nativePort.postMessage(msg);
        console.log("[pi-annotate] Message sent to native host");
      } catch (err) {
        console.error("[pi-annotate] Failed to send to native host:", err);
      }
    } else {
      console.error("[pi-annotate] Cannot forward - native port not connected!");
    }
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

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PICKER" });
  }
});

// Connect on startup
connectNative();
console.log("[pi-annotate] Background script loaded");
