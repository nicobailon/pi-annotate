// Pi Annotate - Popup Script

const extId = chrome.runtime.id;
const installCmd = `./install.sh ${extId}`;

// Elements
const extIdInput = document.getElementById('ext-id');
const installCmdInput = document.getElementById('install-cmd');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const setupSection = document.getElementById('setup-section');
const readySection = document.getElementById('ready-section');
const troubleSection = document.getElementById('trouble-section');

// Populate fields
extIdInput.value = extId;
installCmdInput.value = installCmd;

// Platform-aware displays
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
const shortcutEl = document.getElementById('shortcut-key');
if (shortcutEl) {
  shortcutEl.textContent = isMac ? '⌘ Shift P' : 'Ctrl+Shift+P';
}
const quitTipEl = document.getElementById('quit-tip');
if (quitTipEl) {
  // Mac has ⌘Q, Windows/Linux don't have a universal quit shortcut
  quitTipEl.textContent = isMac 
    ? 'Fully quit Chrome (⌘Q) and reopen' 
    : 'Fully quit Chrome (menu → Exit) and reopen';
}

// Copy functionality
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1500);
  }).catch(() => {
    // Fallback: select the input text
    const input = btn.previousElementSibling;
    if (input?.select) {
      input.select();
      btn.textContent = 'Select All';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }
  });
}

document.getElementById('copy-id').addEventListener('click', (e) => {
  copyToClipboard(extId, e.target);
});

document.getElementById('copy-cmd').addEventListener('click', (e) => {
  copyToClipboard(installCmd, e.target);
});

// Start annotation button
document.getElementById('start-btn')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PICKER" });
    window.close();
  }
});

// Retry button
document.getElementById('retry-btn')?.addEventListener('click', () => {
  checkConnection();
});

// Update UI based on connection state
function setConnected() {
  statusDot.className = 'status-dot connected';
  statusText.textContent = 'Connected';
  setupSection.style.display = 'none';
  readySection.style.display = 'block';
  troubleSection.style.display = 'none';
}

function setNotInstalled(detail) {
  statusDot.className = 'status-dot';
  statusText.textContent = detail || 'Not installed';
  setupSection.style.display = 'block';
  readySection.style.display = 'none';
  troubleSection.style.display = 'none';
}

function setTrouble(error) {
  statusDot.className = 'status-dot trouble';
  statusText.textContent = 'Connection issue';
  setupSection.style.display = 'block';
  readySection.style.display = 'none';
  troubleSection.style.display = 'block';
  document.getElementById('trouble-detail').textContent = error || 'Unknown error';
}

function setChecking() {
  statusDot.className = 'status-dot checking';
  statusText.textContent = 'Checking...';
  // Reset sections to initial state (setup visible, others hidden)
  setupSection.style.display = 'block';
  readySection.style.display = 'none';
  troubleSection.style.display = 'none';
}

// Check connection using PING/PONG
function checkConnection() {
  setChecking();
  
  let resolved = false;
  let port = null;
  
  const cleanup = () => {
    try { if (port) port.disconnect(); } catch {}
  };
  
  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      cleanup();
      setTrouble('Timeout - native host not responding');
    }
  }, 3000);
  
  try {
    port = chrome.runtime.connectNative('com.pi.annotate');
    
    port.onDisconnect.addListener(() => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      
      const error = chrome.runtime.lastError?.message || '';
      if (error.includes('not found')) {
        setNotInstalled('Native host not found');
      } else if (error.includes('forbidden')) {
        setNotInstalled('Extension ID mismatch - reinstall native host');
      } else if (error) {
        setTrouble(error);
      } else {
        // Disconnected without error but no PONG received - host may have crashed
        setTrouble('Native host disconnected unexpectedly');
      }
    });
    
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'PONG') {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        setConnected();
        cleanup();
      }
    });
    
    // Send PING
    port.postMessage({ type: 'PING' });
    
  } catch (err) {
    if (resolved) return;
    resolved = true;
    clearTimeout(timeout);
    cleanup();
    setTrouble(err.message);
  }
}

// Check on load
checkConnection();
