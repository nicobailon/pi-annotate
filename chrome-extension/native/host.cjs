#!/usr/bin/env node
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPendingCaptureQueue } = require("./pending-captures.cjs");

const IS_WINDOWS = process.platform === "win32";
const RUNTIME_DIR = IS_WINDOWS ? os.tmpdir() : "/tmp";
const SOCKET_PATH = process.env.PI_ANNOTATE_SOCKET || (IS_WINDOWS ? "\\\\.\\pipe\\pi-annotate.sock" : "/tmp/pi-annotate.sock");
const TOKEN_PATH = process.env.PI_ANNOTATE_TOKEN || path.join(RUNTIME_DIR, "pi-annotate.token");
const PID_PATH = process.env.PI_ANNOTATE_PID || path.join(RUNTIME_DIR, "pi-annotate-host.pid");
const LOCK_PATH = process.env.PI_ANNOTATE_LOCK || `${PID_PATH}.lock`;
const LOG_FILE = process.env.PI_ANNOTATE_LOG || path.join(RUNTIME_DIR, "pi-annotate-host.log");
const CACHE_DIR = IS_WINDOWS
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), "pi-annotate")
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches", "pi-annotate")
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "pi-annotate");
const PENDING_CAPTURE_PATH = process.env.PI_ANNOTATE_PENDING_CAPTURES || path.join(CACHE_DIR, "pending-captures.json");
const WSL_BRIDGE_TOKEN = process.env.PI_ANNOTATE_WSL_TOKEN || "";
const WSL_BRIDGE_HOST = process.env.PI_ANNOTATE_WSL_HOST || "127.0.0.1";
const WSL_BRIDGE_PORT = Number.parseInt(process.env.PI_ANNOTATE_WSL_PORT || "", 10);
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

  if (!IS_WINDOWS) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch (err) {
      reportFsError(`Failed to remove stale socket ${SOCKET_PATH}`, err);
    }
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
const pendingCaptures = createPendingCaptureQueue({ filePath: PENDING_CAPTURE_PATH });

function sendPendingCaptures() {
  if (!piSocket || piSocket.destroyed) return;
  const captures = pendingCaptures.read();
  if (captures.length === 0) {
    piSocket.write(JSON.stringify({ type: "PENDING_ANNOTATIONS", captures: [] }) + "\n");
    return;
  }
  for (const capture of captures) {
    if (!piSocket || piSocket.destroyed) return;
    piSocket.write(JSON.stringify({
      type: "PENDING_ANNOTATIONS",
      captures: [capture],
    }) + "\n");
  }
}

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
    writeMessage({
      type: "PONG",
      timestamp: Date.now(),
      piConnected: Boolean(piSocket && !piSocket.destroyed && piAuthed),
      pendingCaptureCount: pendingCaptures.read().length,
    });
    return;
  }
  
  if (piSocket && !piSocket.destroyed && piAuthed) {
    piSocket.write(JSON.stringify(msg) + "\n");
  } else if (msg?.type === "ANNOTATIONS_COMPLETE") {
    const capture = pendingCaptures.enqueue(msg);
    log(`Queued annotation capture ${capture.id}; no Pi client connected`);
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
    if (!IS_WINDOWS) {
      try {
        fs.unlinkSync(SOCKET_PATH);
      } catch (err) {
        reportFsError(`Failed to remove socket ${SOCKET_PATH}`, err);
      }
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

// Local socket server for Pi extension.
function replaceActivePiSocket(socket, label) {
  if (piSocket && !piSocket.destroyed && piSocket !== socket) {
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
  piAuthed = true;
  log(`${label} authenticated`);
}

function startServer(options = {}) {
const server = net.createServer((socket) => {
  const label = options.label || "Pi client";
  log(`${label} connected`);
  let socketAuthed = false;
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
        if (!socketAuthed) {
          const expectedToken = options.token || AUTH_TOKEN;
          if (msg?.type === "AUTH" && expectedToken && msg.token === expectedToken) {
            socketAuthed = true;
            replaceActivePiSocket(socket, label);
          } else {
            log(`${label} authentication failed`);
            socket.destroy();
            return;
          }
        } else if (msg?.type === "RECOVER_PENDING_ANNOTATIONS") {
          log("Pi requested pending annotation recovery");
          sendPendingCaptures();
        } else if (msg?.type === "ACK_PENDING_ANNOTATIONS") {
          const remaining = pendingCaptures.acknowledge(msg.captureIds);
          log(`Pi acknowledged pending annotation captures; ${remaining.length} remain`);
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
  log(`${options.label || "Server"} error: ${err.message}`);
  if (!options.optional) cleanup(1);
});

const onListening = () => {
  const target = options.tcp ? `${options.host}:${options.port}` : SOCKET_PATH;
  log(`Listening on ${target}`);
  if (!options.tcp && !IS_WINDOWS) {
    try {
      fs.chmodSync(SOCKET_PATH, 0o600);
    } catch (err) {
      reportFsError(`Failed to chmod socket ${SOCKET_PATH}`, err);
    }
  }
  if (!options.optional) releaseHostLock();
};

if (options.tcp) {
  server.listen(options.port, options.host, onListening);
} else {
  server.listen(SOCKET_PATH, onListening);
}
}

function isLoopbackHost(host) {
  const normalized = String(host || "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function startWslBridge() {
  if (!IS_WINDOWS || !WSL_BRIDGE_TOKEN) return;
  if (!Number.isInteger(WSL_BRIDGE_PORT) || WSL_BRIDGE_PORT < 1 || WSL_BRIDGE_PORT > 65535) {
    log("WSL bridge disabled: PI_ANNOTATE_WSL_PORT must be 1-65535");
    return;
  }
  if (!isLoopbackHost(WSL_BRIDGE_HOST)) {
    log("WSL bridge disabled: PI_ANNOTATE_WSL_HOST must be a loopback address");
    return;
  }
  startServer({
    tcp: true,
    host: WSL_BRIDGE_HOST,
    port: WSL_BRIDGE_PORT,
    token: WSL_BRIDGE_TOKEN,
    label: "WSL bridge client",
    optional: true,
  });
}

(async () => {
  try {
    await acquireHostLock();
    await takeOverHost();
    AUTH_TOKEN = ensureToken();
    startServer();
    startWslBridge();
  } catch (err) {
    log(`Host startup failed: ${err.message}`);
    cleanup(1);
  }
})();
