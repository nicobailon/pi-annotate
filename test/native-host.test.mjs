import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const HOST_SCRIPT = path.resolve("chrome-extension/native/host.cjs");

test("native host keeps authenticated Pi client when an unauthenticated socket connects", async () => {
  if (process.platform === "win32") {
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-annotate-host-test-"));
  const socketPath = path.join(dir, "host.sock");
  const tokenPath = path.join(dir, "token");
  const logPath = path.join(dir, "host.log");
  const proc = spawn(process.execPath, [HOST_SCRIPT], {
    stdio: ["pipe", "ignore", "pipe"],
    env: {
      ...process.env,
      PI_ANNOTATE_SOCKET_PATH: socketPath,
      PI_ANNOTATE_TOKEN_PATH: tokenPath,
      PI_ANNOTATE_LOG_FILE: logPath,
    },
  });

  try {
    await waitForFile(socketPath);
    await waitForFile(tokenPath);
    const token = fs.readFileSync(tokenPath, "utf8").trim();

    const first = await connectAndAuth(socketPath, token);
    const firstMessages = collectJsonLines(first);
    let firstClosed = false;
    first.once("close", () => {
      firstClosed = true;
    });

    const bad = await connectSocket(socketPath);
    bad.write(JSON.stringify({ type: "AUTH", token: "wrong" }) + "\n");
    await onceEvent(bad, "close");
    await delay(50);

    assert.equal(firstClosed, false, "bad auth must not replace the authenticated client");

    const second = await connectAndAuth(socketPath, token);
    await waitUntil(() => firstClosed, "first authenticated client to close after replacement");
    assert.deepEqual(firstMessages, [
      { type: "SESSION_REPLACED", reason: "Another terminal started annotation" },
    ]);
    second.destroy();
  } finally {
    proc.kill("SIGTERM");
    await Promise.race([onceEvent(proc, "exit"), delay(1000)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function connectAndAuth(socketPath, token) {
  const socket = await connectSocket(socketPath);
  socket.write(JSON.stringify({ type: "AUTH", token }) + "\n");
  await delay(50);
  return socket;
}

function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function collectJsonLines(socket) {
  const messages = [];
  let buffer = "";
  socket.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  return messages;
}

async function waitForFile(filePath) {
  await waitUntil(() => fs.existsSync(filePath), filePath);
}

async function waitUntil(predicate, description) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function onceEvent(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}
