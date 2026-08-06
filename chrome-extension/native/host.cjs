#!/usr/bin/env node
const net = require("net");
const fs = require("fs");

const SOCKET_PATH = process.env.PI_ANNOTATE_SOCKET || "/tmp/pi-annotate.sock";
const TOKEN_PATH = process.env.PI_ANNOTATE_TOKEN || "/tmp/pi-annotate.token";
const PID_PATH = process.env.PI_ANNOTATE_PID || "/tmp/pi-annotate-host.pid";
const LOCK_PATH = process.env.PI_ANNOTATE_LOCK || `${PID_PATH}.lock`;
const LOG_FILE = process.env.PI_ANNOTATE_LOG || "/tmp/pi-annotate-host.log";
const MAX_NATIVE_MESSAGE_BYTES = 32 * 1024 * 1024; // 32MB (increased from 8MB for edit capture payloads)
const MAX_SOCKET_BUFFER = 32 * 1024 * 1024; // 32MB
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB

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

function readPidFile(path) {
  try {
    const pid = Number.parseInt(fs.readFileSync(path, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readPid() {
  return readPidFile(PID_PATH);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function socketIsLive() {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

let ownsLock = false;

async function stopProcess(pid, label) {
  if (!pid || pid === process.pid || !isAlive(pid)) return;
  log(`Stopping ${label} ${pid}`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    throw new Error(`Failed to stop ${label} ${pid}: ${err.message}`);
  }

  for (let i = 0; i < 20; i++) {
    await wait(50);
    if (!isAlive(pid)) return;
  }
  throw new Error(`${label} ${pid} did not exit`);
}

function tryCreateHostLock() {
  const tempPath = `${LOCK_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, String(process.pid), { mode: 0o600 });
  try {
    fs.linkSync(tempPath, LOCK_PATH);
    ownsLock = true;
    return true;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code !== "EEXIST") throw err;
    return false;
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (err) {
      reportFsError(`Failed to remove temp lock ${tempPath}`, err);
    }
  }
}

async function acquireHostLock() {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (tryCreateHostLock()) return;

    const lockPid = readPidFile(LOCK_PATH);
    if (!lockPid) {
      await wait(50);
      continue;
    }

    if (lockPid !== process.pid && isAlive(lockPid)) {
      await wait(50);
      continue;
    }

    if (readPidFile(LOCK_PATH) === lockPid) {
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch (err) {
        reportFsError(`Failed to remove stale lock ${LOCK_PATH}`, err);
        await wait(50);
      }
    } else {
      await wait(50);
    }
  }
  throw new Error(`Failed to acquire native host lock ${LOCK_PATH}`);
}

async function takeOverHost() {
  const previousPid = readPid();
  await stopProcess(previousPid, "previous host");

  const recordedPid = readPid();
  if (recordedPid && recordedPid !== process.pid) {
    if (isAlive(recordedPid)) {
      throw new Error(`Native host ${recordedPid} is still running`);
    }
    fs.unlinkSync(PID_PATH);
  }

  if (await socketIsLive()) {
    throw new Error(`Native host socket ${SOCKET_PATH} is already live without an owned pid file`);
  }

  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (err) {
    reportFsError(`Failed to remove stale socket ${SOCKET_PATH}`, err);
  }

  fs.writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });
}

function ownsPidFile() {
  return readPid() === process.pid;
}

function ownsLockFile() {
  return readPidFile(LOCK_PATH) === process.pid;
}

function releaseHostLock() {
  if (!ownsLock || !ownsLockFile()) return;
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch (err) {
    reportFsError(`Failed to remove lock ${LOCK_PATH}`, err);
  } finally {
    ownsLock = false;
  }
}

// Store connected pi client
let piSocket = null;
let piAuthed = false;

function ensureToken() {
  try {
    const token = require("crypto").randomBytes(32).toString("hex");
    fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
    return token;
  } catch (err) {
    log(`Failed to create token: ${err.message}`);
    return null;
  }
}

let AUTH_TOKEN = null;

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

let cleanupRan = false;
function cleanup(code = 0) {
  if (cleanupRan) return;
  cleanupRan = true;

  if (ownsPidFile()) {
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

    try {
      fs.unlinkSync(PID_PATH);
    } catch (err) {
      reportFsError(`Failed to remove pid file ${PID_PATH}`, err);
    }
  } else {
    log("Skipping cleanup because this host no longer owns the pid file");
  }

  releaseHostLock();

  process.exit(code);
}

process.on("SIGINT", () => cleanup());
process.on("SIGTERM", () => cleanup());
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`);
  cleanup(1);
});

// Unix socket server for Pi extension
function startServer() {
const server = net.createServer((socket) => {
  log("Pi client connected");
  
  // If another Pi client is already connected, replace it
  if (piSocket && !piSocket.destroyed) {
    if (piAuthed) {
      log("Replacing existing authenticated Pi client");
      try {
        piSocket.write(JSON.stringify({ 
          type: "SESSION_REPLACED", 
          reason: "Another terminal started annotation" 
        }) + "\n");
      } catch (e) {
        log(`Error notifying old client: ${e.message}`);
      }
    } else {
      log("Replacing existing unauthenticated Pi client");
    }
    piSocket.destroy();
  }
  
  piSocket = socket;
  piAuthed = false;
  
  let buffer = "";
  
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
        if (!piAuthed) {
          if (msg?.type === "AUTH" && AUTH_TOKEN && msg.token === AUTH_TOKEN) {
            piAuthed = true;
            log("Pi client authenticated");
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
    log("Pi client disconnected");
    // Only clear if this is still the active socket (handles takeover race)
    if (piSocket === socket) {
      piSocket = null;
      piAuthed = false;
    }
  });
  
  socket.on("error", (e) => log(`Socket error: ${e.message}`));
});

server.on("error", (err) => {
  log(`Server error: ${err.message}`);
  cleanup(1);
});

server.listen(SOCKET_PATH, () => {
  log(`Listening on ${SOCKET_PATH}`);
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch (err) {
    reportFsError(`Failed to chmod socket ${SOCKET_PATH}`, err);
  }
  releaseHostLock();
});
}

(async () => {
  try {
    await acquireHostLock();
    await takeOverHost();
    AUTH_TOKEN = ensureToken();
    startServer();
  } catch (err) {
    log(`Host startup failed: ${err.message}`);
    cleanup(1);
  }
})();
