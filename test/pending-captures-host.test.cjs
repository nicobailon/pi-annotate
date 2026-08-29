const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { mkdtemp, readFile, rm, stat, writeFile } = require("node:fs/promises");
const net = require("node:net");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const hostPath = join(__dirname, "../chrome-extension/native/host.cjs");
const indexPath = join(__dirname, "../index.ts");

function readMegabyteConstant(filePath, name) {
  const source = readFileSync(filePath, "utf8");
  const match = source.match(new RegExp(`const ${name} = (\\d+) \\* 1024 \\* 1024`));
  assert.ok(match, `Could not find ${name} in ${filePath}`);
  return Number(match[1]) * 1024 * 1024;
}

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

function readSocketMessages(socket, count) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const messages = [];
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for Pi socket messages")), 3_000);
    const onData = (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        messages.push(JSON.parse(line));
        if (messages.length === count) {
          clearTimeout(timeout);
          socket.removeListener("data", onData);
          resolve(messages);
          return;
        }
      }
    };
    socket.on("data", onData);
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
  const [recovered] = await readSocketMessages(pi, 1);
  assert.equal(recovered.type, "PENDING_ANNOTATIONS");
  assert.equal(recovered.captures.length, 1);
  assert.equal(recovered.captures[0].message.result.screenshot, "data:image/png;base64,c2NyZWVuc2hvdA==");

  pi.write(`${JSON.stringify({ type: "ACK_PENDING_ANNOTATIONS", captureIds: [recovered.captures[0].id] })}\n`);
  await waitFor(async () => JSON.parse(await readFile(paths.queue, "utf8")).length === 0);
  pi.destroy();
  assert.equal(stderr, "");
});

test("native host recovers multiple queued captures in individually bounded messages", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-annotate-host-test-"));
  const paths = {
    socket: join(directory, "host.sock"),
    token: join(directory, "token"),
    pid: join(directory, "host.pid"),
    lock: join(directory, "host.lock"),
    log: join(directory, "host.log"),
    queue: join(directory, "queue.json"),
  };
  const captures = Array.from({ length: 3 }, (_, index) => ({
    id: `capture-${index}`,
    message: {
      type: "ANNOTATIONS_COMPLETE",
      requestId: index + 1,
      result: {
        success: true,
        url: `https://example.test/${index}`,
        elements: [],
        screenshot: `data:image/png;base64,${"x".repeat(700)}`,
      },
    },
  }));
  await writeFile(paths.queue, JSON.stringify(captures));

  const socketMessageLimit = 2 * 1024;
  const aggregateMessage = JSON.stringify({ type: "PENDING_ANNOTATIONS", captures }) + "\n";
  assert.ok(Buffer.byteLength(aggregateMessage) > socketMessageLimit);
  for (const capture of captures) {
    const individualMessage = JSON.stringify({ type: "PENDING_ANNOTATIONS", captures: [capture] }) + "\n";
    assert.ok(Buffer.byteLength(individualMessage) < socketMessageLimit);
  }

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
  const token = (await readFile(paths.token, "utf8")).trim();
  const pi = net.createConnection(paths.socket);
  await new Promise((resolve, reject) => {
    pi.once("connect", resolve);
    pi.once("error", reject);
  });
  pi.write(`${JSON.stringify({ type: "AUTH", token })}\n`);
  pi.write(`${JSON.stringify({ type: "RECOVER_PENDING_ANNOTATIONS" })}\n`);

  const recovered = await readSocketMessages(pi, captures.length);
  assert.deepEqual(recovered.map((message) => message.type), captures.map(() => "PENDING_ANNOTATIONS"));
  assert.deepEqual(recovered.map((message) => message.captures.map((capture) => capture.id)), captures.map((capture) => [capture.id]));
  assert.deepEqual(recovered.map((message) => message.captures[0].message.result.screenshot), captures.map((capture) => capture.message.result.screenshot));
  assert.ok(recovered.every((message) => Buffer.byteLength(JSON.stringify(message) + "\n") < socketMessageLimit));
  assert.equal(JSON.parse(await readFile(paths.queue, "utf8")).length, captures.length);

  pi.write(`${JSON.stringify({ type: "ACK_PENDING_ANNOTATIONS", captureIds: captures.map((capture) => capture.id) })}\n`);
  await waitFor(async () => JSON.parse(await readFile(paths.queue, "utf8")).length === 0);
  pi.destroy();
  assert.equal(stderr, "");
});

test("socket receiver leaves room for a max-size native capture recovery envelope", () => {
  const maxNativeMessageBytes = readMegabyteConstant(hostPath, "MAX_NATIVE_MESSAGE_BYTES");
  const maxSocketBuffer = readMegabyteConstant(indexPath, "MAX_SOCKET_BUFFER");
  const nativeMessage = {
    type: "ANNOTATIONS_COMPLETE",
    result: {
      success: true,
      url: "https://example.test",
      elements: [],
      screenshot: "data:image/png;base64,",
    },
  };
  const nativeMessageWithoutPayload = JSON.stringify(nativeMessage);
  nativeMessage.result.screenshot += "x".repeat(maxNativeMessageBytes - Buffer.byteLength(nativeMessageWithoutPayload));

  const nativeMessageBytes = Buffer.byteLength(JSON.stringify(nativeMessage));
  const recoveryFrame = JSON.stringify({
    type: "PENDING_ANNOTATIONS",
    captures: [{
      id: "00000000-0000-0000-0000-000000000000",
      message: nativeMessage,
    }],
  }) + "\n";
  const recoveryFrameBytes = Buffer.byteLength(recoveryFrame);

  assert.equal(nativeMessageBytes, maxNativeMessageBytes);
  assert.ok(recoveryFrameBytes > nativeMessageBytes);
  assert.ok(recoveryFrameBytes <= maxSocketBuffer, `${recoveryFrameBytes} > ${maxSocketBuffer}`);
});
