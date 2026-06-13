import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { createAnnotationRunManager } from "../annotation-run.ts";

test("createAnnotationRunManager starts Same-Host Annotation from command args", async () => {
  // Arrange
  const host = createHostHarness();
  const manager = createAnnotationRunManager(host.options({ requestIds: [101] }));
  const ctx = createCtx();

  // Act
  await manager.startCommand("http://localhost:3000", ctx);

  // Assert
  assert.deepEqual(host.connections, [undefined]);
  assert.deepEqual(host.sent, [{ type: "START_ANNOTATION", requestId: 101, url: "http://localhost:3000" }]);
  assert.deepEqual(ctx.notifications, [
    { message: "Opening annotation mode on http://localhost:3000", level: "info" },
  ]);
});

test("createAnnotationRunManager sends command results as user messages", async () => {
  // Arrange
  const host = createHostHarness();
  const manager = createAnnotationRunManager(host.options({ requestIds: [151] }));
  const ctx = createCtx();
  await manager.startCommand("", ctx);

  // Act
  await manager.handleHostMessage({
    type: "ANNOTATIONS_COMPLETE",
    requestId: 151,
    result: { success: true, url: "http://same-host.example" },
  });

  // Assert
  assert.deepEqual(host.userMessages, ["formatted:http://same-host.example"]);
  assert.deepEqual(host.statuses.at(-1), "Annotation complete");
});

test("createAnnotationRunManager starts Remote Annotation from tool params and cleans up on completion", async () => {
  // Arrange
  const host = createHostHarness();
  const manager = createAnnotationRunManager(host.options({ requestIds: [202] }));
  const ctx = createCtx();

  // Act
  const resultPromise = manager.startTool({ browserHost: "laptop", url: "http://localhost:3000", timeout: 60 }, undefined, ctx);
  await waitUntil(() => host.sent.length === 1);
  await manager.handleHostMessage({
    type: "ANNOTATIONS_COMPLETE",
    requestId: 202,
    result: { success: true, url: "http://127.0.0.1:49154" },
  });
  const result = await resultPromise;

  // Assert
  assert.deepEqual(host.connections, [{
    endpoint: { type: "tcp", host: "127.0.0.1", port: 49152 },
    token: "token-laptop",
    label: "Browser Host laptop",
  }]);
  assert.deepEqual(host.sent, [{ type: "START_ANNOTATION", requestId: 202, url: "http://localhost:3000?via=laptop" }]);
  assert.deepEqual(host.remoteBridgeCleanups, ["laptop"]);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "formatted:http://127.0.0.1:49154" }],
    details: { success: true, url: "http://127.0.0.1:49154" },
  });
});

test("createAnnotationRunManager sends cancel before cleaning up an aborted Remote Annotation tool run", async () => {
  // Arrange
  const host = createHostHarness();
  const manager = createAnnotationRunManager(host.options({ requestIds: [252] }));
  const ctx = createCtx();
  const controller = new AbortController();
  const resultPromise = manager.startTool({ browserHost: "laptop", timeout: 60 }, controller.signal, ctx);
  await waitUntil(() => host.sent.length === 1);

  // Act
  controller.abort();
  const result = await resultPromise;
  await Promise.resolve();

  // Assert
  assert.deepEqual(host.flushed, [{ type: "CANCEL", requestId: 252, reason: "aborted" }]);
  assert.deepEqual(host.remoteBridgeCleanups, ["laptop"]);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "Annotation was aborted." }],
    details: { aborted: true },
  });
});

test("createAnnotationRunManager should ignore stale terminal messages after a Remote Annotation tool run ends", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("complete", "cancel", "connectionLost", "sessionReplaced", "abort"),
      fc.array(fc.constantFrom("complete", "cancel", "connectionLost", "sessionReplaced")),
      async (firstEvent, staleEvents) => {
        // Arrange
        const host = createHostHarness();
        const manager = createAnnotationRunManager(host.options({ requestIds: [303] }));
        const ctx = createCtx();
        const controller = new AbortController();
        const resultPromise = manager.startTool({ browserHost: "laptop", timeout: 60 }, controller.signal, ctx);
        await waitUntil(() => host.sent.length === 1);

        // Act
        await applyLifecycleEvent(manager, controller, firstEvent, 303);
        const result = await resultPromise;
        for (const event of staleEvents) {
          await applyLifecycleEvent(manager, controller, event, 303);
        }
        await Promise.resolve();

        // Assert
        assert.equal(host.remoteBridgeCleanups.length, 1);
        assert.equal(host.userMessages.length, 0);
        assert.ok(result.details);
      }
    )
  );
});

// Helpers

function createCtx() {
  const notifications = [];
  const statuses = [];
  return {
    hasUI: true,
    notifications,
    statuses,
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (_source, message) => statuses.push(message),
    },
  };
}

function createHostHarness() {
  const connections = [];
  const sent = [];
  const flushed = [];
  const userMessages = [];
  const statuses = [];
  const remoteBridgeCleanups = [];
  let requestIds = [];

  return {
    connections,
    sent,
    flushed,
    userMessages,
    statuses,
    remoteBridgeCleanups,
    options({ requestIds: ids = [] } = {}) {
      requestIds = [...ids];
      return {
        connectToHost: async (options) => {
          connections.push(options);
        },
        sendToHost: (message) => {
          sent.push(message);
        },
        sendToHostAndFlush: async (message) => {
          flushed.push(message);
        },
        createRemoteAnnotationBridge: async ({ browserHost, url }) => ({
          browserHost,
          endpoint: { type: "tcp", host: "127.0.0.1", port: 49152 },
          token: `token-${browserHost}`,
          url: url ? `${url}?via=${browserHost}` : undefined,
          pageTunnel: null,
          cleanup: () => remoteBridgeCleanups.push(browserHost),
        }),
        formatResult: async (result) => `formatted:${result.url || "unknown"}`,
        sendUserMessage: (message) => {
          userMessages.push(message);
        },
        setStatus: (message) => {
          statuses.push(message);
        },
        nextRequestId: () => requestIds.shift() ?? 1,
      };
    },
  };
}

async function applyLifecycleEvent(manager, controller, event, requestId) {
  if (event === "complete") {
    await manager.handleHostMessage({
      type: "ANNOTATIONS_COMPLETE",
      requestId,
      result: { success: true, url: "http://annotated.example" },
    });
    return;
  }

  if (event === "cancel") {
    await manager.handleHostMessage({ type: "CANCEL", requestId, reason: "user" });
    return;
  }

  if (event === "connectionLost") {
    manager.handleConnectionLost();
    return;
  }

  if (event === "sessionReplaced") {
    await manager.handleHostMessage({ type: "SESSION_REPLACED", reason: "Another terminal started annotation" });
    return;
  }

  controller.abort();
  await Promise.resolve();
}

async function waitUntil(predicate) {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for condition");
}
