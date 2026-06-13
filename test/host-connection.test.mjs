import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createHostConnectionManager } from "../host-connection.ts";

test("createHostConnectionManager cleans up a replaced Browser Host connection without losing the new one", async () => {
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
  assert.deepEqual(disconnects, ["lost"]);
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
  assert.deepEqual(disconnects, ["lost", "lost"]);
});

test("createHostConnectionManager connects to TCP endpoints for remote Browser Hosts", async () => {
  // Arrange
  const socket = new FakeSocket();
  const endpoints = [];
  const manager = createHostConnectionManager({
    defaultSocketPath: "/tmp/pi-annotate.sock",
    defaultTokenPath: "/tmp/pi-annotate.token",
    maxSocketBuffer: 1024,
    createConnection: (endpoint) => {
      endpoints.push(endpoint);
      return socket;
    },
    onMessage: () => {},
    onConnectionLost: () => {},
  });

  // Act
  const connect = manager.connect({
    endpoint: { type: "tcp", host: "127.0.0.1", port: 49152 },
    token: "remote-token",
    label: "Browser Host laptop",
  });
  socket.emit("connect");
  await connect;

  // Assert
  assert.deepEqual(endpoints, [{ type: "tcp", host: "127.0.0.1", port: 49152 }]);
  assert.deepEqual(socket.writes, [{ type: "AUTH", token: "remote-token" }]);
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
