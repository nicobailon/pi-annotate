const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, readFile, rm, stat } = require("node:fs/promises");
const net = require("node:net");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const hostPath = join(__dirname, "../chrome-extension/native/host.cjs");

function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch {
        // The host has not created this resource yet.
      }
      if (Date.now() >= deadline) return reject(new Error("Timed out waiting for host"));
      setTimeout(attempt, 20);
    };
    attempt();
  });
}

function writeNativeMessage(stream, message) {
  const json = Buffer.from(JSON.stringify(message));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  stream.write(Buffer.concat([length, json]));
}

function readSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for Pi socket message")), 3_000);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.removeAllListeners("data");
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("native host recovers pending capture only after Pi requests it and removes it after ACK", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-annotate-host-test-"));
  const paths = {
    socket: join(directory, "host.sock"),
    token: join(directory, "token"),
    pid: join(directory, "host.pid"),
    lock: join(directory, "host.lock"),
    log: join(directory, "host.log"),
    queue: join(directory, "queue.json"),
  };
  const host = spawn(process.execPath, [hostPath], {
    env: {
      ...process.env,
      PI_ANNOTATE_SOCKET: paths.socket,
      PI_ANNOTATE_TOKEN: paths.token,
      PI_ANNOTATE_PID: paths.pid,
      PI_ANNOTATE_LOCK: paths.lock,
      PI_ANNOTATE_LOG: paths.log,
      PI_ANNOTATE_PENDING_CAPTURES: paths.queue,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  host.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    host.kill("SIGTERM");
    await new Promise((resolve) => host.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  });

  await waitFor(async () => {
    await stat(paths.socket);
    return true;
  });
  writeNativeMessage(host.stdin, {
    type: "ANNOTATIONS_COMPLETE",
    result: {
      success: true,
      url: "https://example.test",
      elements: [],
      screenshot: "data:image/png;base64,c2NyZWVuc2hvdA==",
    },
  });
  await waitFor(async () => JSON.parse(await readFile(paths.queue, "utf8")).length === 1);

  const token = (await readFile(paths.token, "utf8")).trim();
  const pi = net.createConnection(paths.socket);
  await new Promise((resolve, reject) => {
    pi.once("connect", resolve);
    pi.once("error", reject);
  });
  pi.write(`${JSON.stringify({ type: "AUTH", token })}\n`);
  pi.write(`${JSON.stringify({ type: "RECOVER_PENDING_ANNOTATIONS" })}\n`);
  const recovered = await readSocketMessage(pi);
  assert.equal(recovered.type, "PENDING_ANNOTATIONS");
  assert.equal(recovered.captures.length, 1);
  assert.equal(recovered.captures[0].message.result.screenshot, "data:image/png;base64,c2NyZWVuc2hvdA==");

  pi.write(`${JSON.stringify({ type: "ACK_PENDING_ANNOTATIONS", captureIds: [recovered.captures[0].id] })}\n`);
  await waitFor(async () => JSON.parse(await readFile(paths.queue, "utf8")).length === 0);
  pi.destroy();
  assert.equal(stderr, "");
});
