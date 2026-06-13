#!/usr/bin/env node
const net = require("net");
const fs = require("fs");
const crypto = require("crypto");

const SOCKET_PATH = process.env.PI_ANNOTATE_SOCKET_PATH || "/tmp/pi-annotate.sock";
const TOKEN_PATH = process.env.PI_ANNOTATE_TOKEN_PATH || "/tmp/pi-annotate.token";
const LOG_FILE = process.env.PI_ANNOTATE_LOG_FILE || "/tmp/pi-annotate-host.log";
const MAX_NATIVE_MESSAGE_BYTES = 32 * 1024 * 1024; // 32MB (increased from 8MB for edit capture payloads)
const MAX_SOCKET_BUFFER = 32 * 1024 * 1024; // 32MB
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB
const AUTH_TIMEOUT_MS = 5000;

process.umask(0o077);

function reportFsError(action, err) {
  const code = err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : "";
  if (code === "ENOENT") return;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${new Date().toISOString()} ${action}: ${message}`);
}

function rotateLogIfNeeded() {
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch (err) {
    reportFsError(`Failed to rotate log ${LOG_FILE}`, err);
  }
}

const log = (msg) => {
  rotateLogIfNeeded();
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
};

log("Host starting...");

// Clean up old socket
try {
  fs.unlinkSync(SOCKET_PATH);
} catch (err) {
  reportFsError(`Failed to remove old socket ${SOCKET_PATH}`, err);
}

// Store connected authenticated pi client
let piSocket = null;

function ensureToken() {
  try {
    const token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
    return token;
  } catch (err) {
    log(`Failed to create token: ${err.message}`);
    return null;
  }
}

const AUTH_TOKEN = ensureToken();

function tokenMatches(value) {
  if (!AUTH_TOKEN || typeof value !== "string") return false;
  const expected = Buffer.from(AUTH_TOKEN, "utf8");
  const provided = Buffer.from(value, "utf8");
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

// Native messaging I/O
let inputBuffer = Buffer.alloc(0);

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length);
  process.stdout.write(len);
  process.stdout.write(json);
}

function processInput() {
  while (inputBuffer.length >= 4) {
    const len = inputBuffer.readUInt32LE(0);
    if (len > MAX_NATIVE_MESSAGE_BYTES) {
      log(`Native message too large: ${len}`);
      inputBuffer = Buffer.alloc(0);
      return;
    }
    if (inputBuffer.length < 4 + len) break;
    
    const json = inputBuffer.slice(4, 4 + len).toString();
    inputBuffer = inputBuffer.slice(4 + len);
    
    try {
      const msg = JSON.parse(json);
      handleExtensionMessage(msg);
    } catch (e) {
      log(`Parse error: ${e.message}`);
    }
  }
}

function redactForLog(msg) {
  return JSON.stringify(msg, (key, value) => {
    if (key === "screenshot" || key === "beforeScreenshot" || key === "afterScreenshot") return "[redacted]";
    if (key === "screenshots") return Array.isArray(value) ? `[${value.length} screenshots]` : "[redacted]";
    if (key === "dataUrl") return "[redacted]";
    return value;
  });
}

// Messages from Chrome extension → forward to Pi
function handleExtensionMessage(msg) {
  log(`From extension: ${redactForLog(msg)}`);
  
  // Health check - respond immediately without forwarding
  if (msg?.type === "PING") {
    writeMessage({ type: "PONG", timestamp: Date.now() });
    return;
  }
  
  if (piSocket && !piSocket.destroyed) {
    piSocket.write(JSON.stringify(msg) + "\n");
  } else {
    log("No pi client connected, message dropped");
  }
}

process.stdin.on("readable", () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    processInput();
  }
});

process.stdin.on("end", () => {
  log("Extension disconnected");
  cleanup();
});

function cleanup() {
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (err) {
    reportFsError(`Failed to remove socket ${SOCKET_PATH}`, err);
  }

  try {
    fs.unlinkSync(TOKEN_PATH);
  } catch (err) {
    reportFsError(`Failed to remove token ${TOKEN_PATH}`, err);
  }

  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`);
  cleanup();
});

// Unix socket server for Pi extension
const server = net.createServer((socket) => {
  log("Pi client connected");
  
  let buffer = "";
  let authed = false;
  const authTimeout = setTimeout(() => {
    if (!authed) {
      log("Pi client authentication timed out");
      socket.destroy();
    }
  }, AUTH_TIMEOUT_MS);

  const promoteAuthenticatedSocket = () => {
    clearTimeout(authTimeout);
    authed = true;

    if (piSocket && piSocket !== socket && !piSocket.destroyed) {
      log("Replacing existing authenticated Pi client");
      try {
        piSocket.write(JSON.stringify({ 
          type: "SESSION_REPLACED", 
          reason: "Another terminal started annotation" 
        }) + "\n");
      } catch (e) {
        log(`Error notifying old client: ${e.message}`);
      }
      piSocket.destroy();
    }

    piSocket = socket;
    log("Pi client authenticated");
  };
  
  socket.on("data", (data) => {
    buffer += data.toString();
    if (buffer.length > MAX_SOCKET_BUFFER) {
      log("Pi socket buffer overflow, closing connection");
      socket.destroy();
      buffer = "";
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (!authed) {
          if (msg?.type === "PING") {
            socket.write(JSON.stringify({ type: "PONG", timestamp: Date.now() }) + "\n");
          } else if (msg?.type === "AUTH" && tokenMatches(msg.token)) {
            promoteAuthenticatedSocket();
          } else {
            log("Pi client authentication failed");
            socket.destroy();
            return;
          }
        } else {
          // Forward to Chrome extension
          log(`From Pi: ${redactForLog(msg)}`);
          writeMessage(msg);
        }
      } catch (e) {
        log(`Pi parse error: ${e.message}`);
      }
    }
  });
  
  socket.on("close", () => {
    clearTimeout(authTimeout);
    log("Pi client disconnected");
    // Only clear if this is still the active socket (handles takeover race)
    if (piSocket === socket) {
      piSocket = null;
    }
  });
  
  socket.on("error", (e) => log(`Socket error: ${e.message}`));
});

server.listen(SOCKET_PATH, () => {
  log(`Listening on ${SOCKET_PATH}`);
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch (err) {
    reportFsError(`Failed to chmod socket ${SOCKET_PATH}`, err);
  }
});
