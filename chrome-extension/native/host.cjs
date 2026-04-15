#!/usr/bin/env node
const net = require("net");
const fs = require("fs");

// Paths are env-overridable so tests (and side-by-side installs) can run in isolation.
const SOCKET_PATH = process.env.PI_ANNOTATE_SOCKET || "/tmp/pi-annotate.sock";
const TOKEN_PATH  = process.env.PI_ANNOTATE_TOKEN  || "/tmp/pi-annotate.token";
const PID_PATH    = process.env.PI_ANNOTATE_PID    || "/tmp/pi-annotate-host.pid";
const LOG_FILE    = process.env.PI_ANNOTATE_LOG    || "/tmp/pi-annotate-host.log";

const MAX_NATIVE_MESSAGE_BYTES = 32 * 1024 * 1024; // 32MB (edit capture payloads)
const MAX_SOCKET_BUFFER        = 32 * 1024 * 1024; // 32MB
const MAX_LOG_BYTES            = 5 * 1024 * 1024;  // 5MB

// 0600 on anything we create
process.umask(0o077);

// ──────────────────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────────────────

function rotateLogIfNeeded() {
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch {}
}

const log = (msg) => {
  rotateLogIfNeeded();
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${msg}\n`); } catch {}
};

log("Host starting...");

// ──────────────────────────────────────────────────────────────────────
// Single-instance guard (prevents zombie hosts holding dangling sockets).
//
// Failure mode we are defending against:
//   1. Host instance A is running and listening on SOCKET_PATH.
//   2. Chrome re-wakes the service worker (e.g. after the user reloads the
//      extension) before A's stdin receives EOF; Chrome spawns instance B.
//   3. B's legacy startup blindly `fs.unlinkSync(SOCKET_PATH)` and then
//      `server.listen(SOCKET_PATH)` — now *two* processes believe they own
//      the socket, and the filesystem entry keeps getting swapped.
//   4. A's kernel-level unix socket stays bound under the now-unlinked name,
//      so A is reachable only via `lsof` — pi clients connecting by path
//      never find it and the error "Chrome extension not connected" appears
//      until someone manually kills A.
//
// Fix: cooperatively take over from any previous live instance, and only
// clean up files we still own at shutdown.
// ──────────────────────────────────────────────────────────────────────

function readPidFile() {
  try {
    const raw = fs.readFileSync(PID_PATH, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function takeOverFromStaleInstance() {
  const oldPid = readPidFile();
  if (!oldPid || oldPid === process.pid) return;

  if (!isAlive(oldPid)) {
    log(`Stale pid file for ${oldPid} (not running) — clearing`);
    try { fs.unlinkSync(PID_PATH); } catch {}
    return;
  }

  log(`Previous host alive (pid=${oldPid}); sending SIGTERM`);
  try { process.kill(oldPid, "SIGTERM"); } catch (e) {
    log(`Could not SIGTERM ${oldPid}: ${e.message}`);
  }

  // Poll up to ~1s for it to exit. 20 * 50ms.
  for (let i = 0; i < 20; i++) {
    await sleep(50);
    if (!isAlive(oldPid)) {
      log(`Previous host ${oldPid} exited`);
      try { fs.unlinkSync(PID_PATH); } catch {}
      return;
    }
  }

  log(`Previous host ${oldPid} did not exit within 1s — aborting to avoid double-bind`);
  process.exit(1);
}

function writePidFile() {
  fs.writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });
}

function ownsFile(path) {
  try { return parseInt(fs.readFileSync(path, "utf8").trim(), 10) === process.pid; }
  catch { return false; }
}

// ──────────────────────────────────────────────────────────────────────
// Cleanup
// ──────────────────────────────────────────────────────────────────────

let cleanupRan = false;
function cleanup(code = 0) {
  if (cleanupRan) return;
  cleanupRan = true;

  // Only unlink files that still belong to us. Protects a later instance
  // from having its fresh socket/token yanked by our late cleanup.
  if (ownsFile(PID_PATH)) {
    try { fs.unlinkSync(PID_PATH); }   catch {}
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    try { fs.unlinkSync(TOKEN_PATH); }  catch {}
  } else {
    log("Shutdown: pid file no longer mine, leaving socket/token alone");
  }

  process.exit(code);
}

process.on("SIGINT",  () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err && err.stack || err}`);
  cleanup(1);
});
process.on("unhandledRejection", (err) => {
  log(`Unhandled rejection: ${err && err.stack || err}`);
  cleanup(1);
});

// ──────────────────────────────────────────────────────────────────────
// Native messaging I/O (Chrome extension <-> this process over stdio)
// ──────────────────────────────────────────────────────────────────────

let piSocket = null;
let piAuthed = false;
let AUTH_TOKEN = null;

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

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length);
  try {
    process.stdout.write(len);
    process.stdout.write(json);
  } catch (e) {
    log(`stdout write failed: ${e.message}`);
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

function handleExtensionMessage(msg) {
  log(`From extension: ${redactForLog(msg)}`);

  // Health check - respond immediately without forwarding
  if (msg && msg.type === "PING") {
    writeMessage({ type: "PONG", timestamp: Date.now() });
    return;
  }

  if (piSocket && !piSocket.destroyed) {
    piSocket.write(JSON.stringify(msg) + "\n");
  } else {
    log("No pi client connected, message dropped");
  }
}

let inputBuffer = Buffer.alloc(0);

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
      const parsed = JSON.parse(json);
      handleExtensionMessage(parsed);
    } catch (e) {
      log(`Parse error: ${e.message}`);
    }
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
  log("Extension disconnected (stdin EOF)");
  cleanup(0);
});

// Chrome sometimes closes the native-messaging pipe without a clean EOF;
// `disconnect` fires on the parent IPC channel in that case.
if (process.send) process.on("disconnect", () => {
  log("Extension disconnected (parent IPC gone)");
  cleanup(0);
});

// ──────────────────────────────────────────────────────────────────────
// Unix-socket server for pi extension
// ──────────────────────────────────────────────────────────────────────

function startServer() {
  const server = net.createServer((socket) => {
    log("Pi client connected");

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
            if (msg && msg.type === "AUTH" && AUTH_TOKEN && msg.token === AUTH_TOKEN) {
              piAuthed = true;
              log("Pi client authenticated");
            } else {
              log("Pi client authentication failed");
              socket.destroy();
              return;
            }
          } else {
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
      if (piSocket === socket) {
        piSocket = null;
        piAuthed = false;
      }
    });

    socket.on("error", (e) => log(`Socket error: ${e.message}`));
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      // Another host claimed the path between our takeover and listen().
      // Exit 0 so Chrome respawns — the winning instance will serve.
      log(`Socket path already in use (${err.message}) — yielding`);
      cleanup(0);
      return;
    }
    log(`Server error: ${err.message}`);
    cleanup(1);
  });

  // Only unlink the socket file if there's no live host owning it.
  // Empty check: if PID_PATH is ours (we won takeOverFromStaleInstance),
  // stale socket files are safe to remove.
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  server.listen(SOCKET_PATH, () => {
    log(`Listening on ${SOCKET_PATH}`);
    try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}

    // Self-defense: if someone unlinks the socket file out from under us
    // (stale legacy host, manual `rm`, etc.), exit so Chrome respawns a
    // fresh host and pi clients can connect by path again.
    //
    // fs.watchFile polls — it's the only reliable option on macOS for unix
    // sockets (fs.watch / FSEvents does not consistently fire `rename`).
    // Polling interval is small because the window where we're the hidden
    // listener is a correctness problem, not a perf one.
    try {
      fs.watchFile(SOCKET_PATH, { interval: 250, persistent: false }, (curr) => {
        if (curr.ino === 0 || !fs.existsSync(SOCKET_PATH)) {
          log("Socket file was removed externally — exiting so Chrome respawns");
          try { fs.unwatchFile(SOCKET_PATH); } catch {}
          cleanup(0);
        }
      });
    } catch (e) {
      log(`fs.watchFile(SOCKET_PATH) failed: ${e.message}`);
    }
  });
}

// ──────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await takeOverFromStaleInstance();
    writePidFile();
    AUTH_TOKEN = ensureToken();
    startServer();
  } catch (err) {
    log(`Boot failed: ${err && err.stack || err}`);
    cleanup(1);
  }
})();
