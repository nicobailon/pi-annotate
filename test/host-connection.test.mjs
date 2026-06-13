import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createHostConnectionManager } from "../host-connection.ts";

test("createHostConnectionManager keeps the active Browser Host connection when an old socket closes", async () => {
  // Arrange
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  const sockets = [firstSocket, secondSocket];
  const statuses = [];
  const disconnects = [];
  const manager = createHostConnectionManager({
    defaultSocketPath: "/tmp/pi-annotate.sock",
    defaultTokenPath: "/tmp/pi-annotate.token",
    maxSocketBuffer: 1024,
    createConnection: () => nextSocket(sockets),
    onStatus: (message) => statuses.push(message),
    onMessage: () => {},
    onConnectionLost: () => disconnects.push("lost"),
  });

  // Act
  const firstConnect = manager.connect({ socketPath: "/tmp/browser-a.sock", token: "token-a", label: "Browser Host a" });
  firstSocket.emit("connect");
  await firstConnect;

  const secondConnect = manager.connect({ socketPath: "/tmp/browser-b.sock", token: "token-b", label: "Browser Host b" });
  secondSocket.emit("connect");
  await secondConnect;

  firstSocket.emit("close");
  manager.send({ type: "PING" });

  // Assert
  assert.equal(disconnects.length, 0);
  assert.equal(firstSocket.destroyed, true);
  assert.deepEqual(firstSocket.writes, [{ type: "AUTH", token: "token-a" }]);
  assert.deepEqual(secondSocket.writes, [
    { type: "AUTH", token: "token-b" },
    { type: "PING" },
  ]);
  assert.deepEqual(statuses, ["Connected to Browser Host a", "Connected to Browser Host b"]);

  // Act
  secondSocket.emit("close");

  // Assert
  assert.deepEqual(disconnects, ["lost"]);
});

test("createHostConnectionManager ignores stale data from a previous socket after switching", async () => {
  // Arrange
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  const sockets = [firstSocket, secondSocket];
  const messages = [];
  const manager = createHostConnectionManager({
    defaultSocketPath: "/tmp/pi-annotate.sock",
    defaultTokenPath: "/tmp/pi-annotate.token",
    maxSocketBuffer: 1024,
    createConnection: () => nextSocket(sockets),
    onMessage: (message) => messages.push(message),
    onConnectionLost: () => {},
  });

  // Act
  const firstConnect = manager.connect({ socketPath: "/tmp/browser-a.sock", token: "token-a" });
  firstSocket.emit("connect");
  await firstConnect;

  const secondConnect = manager.connect({ socketPath: "/tmp/browser-b.sock", token: "token-b" });
  secondSocket.emit("connect");
  await secondConnect;

  firstSocket.emit("data", Buffer.from('{"type":"STALE"}\n'));
  secondSocket.emit("data", Buffer.from('{"type":"CURRENT"}\n'));

  // Assert
  assert.deepEqual(messages, [{ type: "CURRENT" }]);
});

// Helpers

function nextSocket(sockets) {
  const socket = sockets.shift();
  if (!socket) throw new Error("No fake socket queued");
  return socket;
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes = [];

  write(value) {
    this.writes.push(JSON.parse(value));
  }

  destroy() {
    this.destroyed = true;
  }
}
