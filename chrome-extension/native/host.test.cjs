#!/usr/bin/env node
// Smoke test for chrome-extension/native/host.cjs
//
// Reproduces the "zombie host" scenario (race between an old instance and a
// new one started before stdin EOF propagates) and asserts:
//
//   - Only one host survives.
//   - /tmp/pi-annotate.sock (under the test-override path) exists and is
//     connectable after takeover.
//   - Killing the survivor leaves no leftover pid/socket/token files.
//
// Runs in isolation under /tmp/pi-annotate-test-<pid>/* so it cannot clobber
// a live install. No deps — plain node:test + child_process + net.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HOST = path.join(__dirname, "host.cjs");
const BASE = path.join("/tmp", `pi-annotate-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true });

const paths = {
  socket: path.join(BASE, "sock"),
  token:  path.join(BASE, "token"),
  pid:    path.join(BASE, "pid"),
  log:    path.join(BASE, "host.log"),
};

function startHost() {
  const child = spawn(process.execPath, [HOST], {
    env: {
      ...process.env,
      PI_ANNOTATE_SOCKET: paths.socket,
      PI_ANNOTATE_TOKEN:  paths.token,
      PI_ANNOTATE_PID:    paths.pid,
      PI_ANNOTATE_LOG:    paths.log,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (buf) => {
    process.stderr.write(`[host ${child.pid} stderr] ${buf}`);
  });
  return child;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForSocket(timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(paths.socket)) return;
    await sleep(25);
  }
  throw new Error(`Socket ${paths.socket} never appeared`);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForExit(child, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(25);
  }
  throw new Error(`Host ${child.pid} did not exit within ${timeoutMs}ms`);
}

function authHandshake() {
  // Read the token the host wrote and connect + AUTH. Returns the connected socket.
  const token = fs.readFileSync(paths.token, "utf8").trim();
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(paths.socket);
    sock.once("error", reject);
    sock.once("connect", () => {
      sock.write(JSON.stringify({ type: "AUTH", token }) + "\n");
      // If AUTH fails the host destroys the socket; give it a tick.
      setTimeout(() => {
        if (sock.destroyed) reject(new Error("AUTH rejected"));
        else resolve(sock);
      }, 100);
    });
  });
}

test.after(() => {
  // Best-effort cleanup of our sandbox.
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
});

test("single host: starts, creates socket+pid+token, accepts AUTH", async () => {
  const host = startHost();
  try {
    await waitForSocket();
    assert.ok(fs.existsSync(paths.socket), "socket exists");
    assert.ok(fs.existsSync(paths.token),  "token exists");
    assert.ok(fs.existsSync(paths.pid),    "pid file exists");
    const pidInFile = parseInt(fs.readFileSync(paths.pid, "utf8"), 10);
    assert.equal(pidInFile, host.pid, "pid file matches process");

    const sock = await authHandshake();
    assert.ok(!sock.destroyed, "AUTH accepted");
    sock.destroy();
  } finally {
    host.kill("SIGTERM");
    await waitForExit(host);
  }

  assert.ok(!fs.existsSync(paths.socket), "socket cleaned up");
  assert.ok(!fs.existsSync(paths.token),  "token cleaned up");
  assert.ok(!fs.existsSync(paths.pid),    "pid file cleaned up");
});

test("second host takes over from alive first host without zombies", async () => {
  const hostA = startHost();
  await waitForSocket();
  const pidA = hostA.pid;
  assert.ok(isAlive(pidA), "host A alive before takeover");

  // Kick off host B. It should SIGTERM A, wait for exit, bind the socket itself.
  const hostB = startHost();
  await waitForExit(hostA, 3000);             // A must die
  await waitForSocket();                      // socket available again

  assert.ok(!isAlive(pidA),  "host A exited");
  assert.ok( isAlive(hostB.pid), "host B alive");

  // pid file points at the survivor
  const pidInFile = parseInt(fs.readFileSync(paths.pid, "utf8"), 10);
  assert.equal(pidInFile, hostB.pid, "pid file points at host B");

  // AUTH works against the survivor (proves it owns the listening socket)
  const sock = await authHandshake();
  assert.ok(!sock.destroyed, "can auth against surviving host");
  sock.destroy();

  hostB.kill("SIGTERM");
  await waitForExit(hostB);

  assert.ok(!fs.existsSync(paths.pid),    "pid file cleaned up");
  assert.ok(!fs.existsSync(paths.socket), "socket cleaned up");
});

test("cleanup is PID-scoped: late exit of stale host does not delete survivor's files", async () => {
  // Reproduce the exact ordering that used to produce zombie state:
  //   1. host A starts, binds socket, writes pid file
  //   2. host B starts, signals A, takes over (writes its own pid file)
  //   3. host A's cleanup runs (via SIGTERM handler) AFTER B has already written
  //      its own pid/socket — A must NOT delete B's files.
  const hostA = startHost();
  await waitForSocket();
  const hostB = startHost();

  await waitForExit(hostA, 3000);
  await waitForSocket();

  // B still has everything; its pid file is its own.
  assert.ok(fs.existsSync(paths.socket), "B's socket survives A's death");
  assert.ok(fs.existsSync(paths.pid),    "B's pid file survives A's death");
  const pidInFile = parseInt(fs.readFileSync(paths.pid, "utf8"), 10);
  assert.equal(pidInFile, hostB.pid);

  hostB.kill("SIGTERM");
  await waitForExit(hostB);
});

test("external socket unlink makes host exit cleanly", async () => {
  const host = startHost();
  try {
    await waitForSocket();
    // Simulate a bad actor (or a legacy host) unlinking the socket file.
    fs.unlinkSync(paths.socket);
    await waitForExit(host, 2000);
    assert.ok(!isAlive(host.pid), "host exited after external unlink");
    assert.ok(!fs.existsSync(paths.pid), "pid file cleaned up on graceful exit");
  } catch (err) {
    host.kill("SIGKILL");
    throw err;
  }
});
