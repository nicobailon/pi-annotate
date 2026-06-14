import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import fc from "fast-check";

import {
  RemoteAnnotationError,
  buildSshTunnelArgs,
  classifySshFailure,
  isLoopbackPageUrl,
  parseAnnotateCommandArgs,
  planRemotePageAccess,
  validateBrowserHostAlias,
  waitForPiAnnotateEndpoint,
  isRetryableTunnelStartupError,
  toBrowserHostReadinessError,
} from "../remote.ts";

test("parseAnnotateCommandArgs preserves same-host annotate forms", () => {
  assert.deepEqual(parseAnnotateCommandArgs(""), { browserHost: undefined, url: undefined });
  assert.deepEqual(parseAnnotateCommandArgs("http://localhost:3000"), {
    browserHost: undefined,
    url: "http://localhost:3000",
  });
  assert.deepEqual(parseAnnotateCommandArgs("https://example.com/a?b=c"), {
    browserHost: undefined,
    url: "https://example.com/a?b=c",
  });
});

test("parseAnnotateCommandArgs treats first non-url token as Browser Host Alias", () => {
  assert.deepEqual(parseAnnotateCommandArgs("laptop"), {
    browserHost: "laptop",
    url: undefined,
  });
  assert.deepEqual(parseAnnotateCommandArgs("laptop http://localhost:3000"), {
    browserHost: "laptop",
    url: "http://localhost:3000",
  });
});

test("parseAnnotateCommandArgs should never throw for arbitrary command text", () => {
  fc.assert(
    fc.property(fc.string(), (args) => {
      // Act
      const parsed = parseAnnotateCommandArgs(args);

      // Assert
      assert.equal(typeof parsed, "object");
      assert.ok(parsed.browserHost === undefined || typeof parsed.browserHost === "string");
      assert.ok(parsed.url === undefined || typeof parsed.url === "string");
    })
  );
});

test("parseAnnotateCommandArgs should preserve URL-like first tokens as same-host URLs", () => {
  fc.assert(
    fc.property(urlLikeCommand(), (args) => {
      // Act
      const parsed = parseAnnotateCommandArgs(args);

      // Assert
      assert.equal(parsed.browserHost, undefined);
      assert.equal(parsed.url, args.trim());
    })
  );
});

test("parseAnnotateCommandArgs should use only the first non-url token as Browser Host Alias", () => {
  fc.assert(
    fc.property(nonUrlToken(), fc.array(nonEmptyToken(), { maxLength: 6 }), (host, rest) => {
      // Arrange
      const args = [host, ...rest].join(" ");

      // Act
      const parsed = parseAnnotateCommandArgs(args);

      // Assert
      assert.equal(parsed.browserHost, host);
      assert.equal(parsed.url, rest.length > 0 ? rest.join(" ") : undefined);
    })
  );
});

test("validateBrowserHostAlias rejects values that ssh could interpret as options", () => {
  assert.equal(validateBrowserHostAlias("laptop"), "laptop");
  assert.equal(validateBrowserHostAlias("user@laptop.local"), "user@laptop.local");

  for (const alias of ["-oProxyCommand=touch /tmp/pwned", " -l root", "laptop\nother", ""] ) {
    assert.throws(
      () => validateBrowserHostAlias(alias),
      (err) => err instanceof RemoteAnnotationError && err.code === "SSH_INVALID_HOST_ALIAS"
    );
  }
});

test("isLoopbackPageUrl detects only loopback page URLs", () => {
  assert.equal(isLoopbackPageUrl("http://localhost:3000"), true);
  assert.equal(isLoopbackPageUrl("https://127.0.0.1:5173"), true);
  assert.equal(isLoopbackPageUrl("http://[::1]:8080"), true);
  assert.equal(isLoopbackPageUrl("http://desktop:3000"), false);
  assert.equal(isLoopbackPageUrl("https://example.com"), false);
  assert.equal(isLoopbackPageUrl(undefined), false);
});

test("planRemotePageAccess tunnels IPv4 loopback URLs and rewrites the browser-facing host and port", () => {
  assert.deepEqual(planRemotePageAccess("http://localhost:3000/path?q=1#hash", 49152), {
    url: "http://127.0.0.1:49152/path?q=1#hash",
    tunnel: {
      targetHost: "127.0.0.1",
      targetPort: 3000,
      browserPort: 49152,
    },
  });

  assert.deepEqual(planRemotePageAccess("https://127.0.0.1/settings", 49153), {
    url: "https://127.0.0.1:49153/settings",
    tunnel: {
      targetHost: "127.0.0.1",
      targetPort: 443,
      browserPort: 49153,
    },
  });
});

test("planRemotePageAccess sends every IPv4 loopback URL to the reverse-tunnel bind address", () => {
  assert.deepEqual(planRemotePageAccess("http://127.1.2.3:3000/path", 49154), {
    url: "http://127.0.0.1:49154/path",
    tunnel: {
      targetHost: "127.0.0.1",
      targetPort: 3000,
      browserPort: 49154,
    },
  });
});

test("planRemotePageAccess should preserve IPv4 loopback URL path, query, and hash", () => {
  fc.assert(
    fc.property(ipv4LoopbackUrl(), fc.integer({ min: 1, max: 65535 }), ({ rawUrl, targetPort }, browserPort) => {
      // Arrange
      const originalUrl = new URL(rawUrl);

      // Act
      const plan = planRemotePageAccess(rawUrl, browserPort);
      const browserUrl = new URL(plan.url);

      // Assert
      assert.equal(browserUrl.protocol, originalUrl.protocol);
      assert.equal(browserUrl.pathname, originalUrl.pathname);
      assert.equal(browserUrl.search, originalUrl.search);
      assert.equal(browserUrl.hash, originalUrl.hash);
      assert.equal(browserUrl.hostname, "127.0.0.1");
      assert.equal(Number(browserUrl.port || (originalUrl.protocol === "https:" ? 443 : 80)), browserPort);
      assert.deepEqual(plan.tunnel, {
        targetHost: "127.0.0.1",
        targetPort,
        browserPort,
      });
    })
  );
});

test("planRemotePageAccess rejects IPv6 loopback URLs in remote annotation", () => {
  assert.throws(
    () => planRemotePageAccess("http://[::1]:3000", 49152),
    (err) => err instanceof RemoteAnnotationError && err.code === "REMOTE_IPV6_LOOPBACK_UNSUPPORTED"
  );
});

test("planRemotePageAccess passes non-loopback URLs through unchanged", () => {
  assert.deepEqual(planRemotePageAccess("http://desktop:3000", 49152), {
    url: "http://desktop:3000",
    tunnel: null,
  });
});

test("classifySshFailure separates SSH failures from Browser Host readiness", () => {
  assert.deepEqual(classifySshFailure("Host key verification failed."), {
    code: "SSH_HOST_KEY_FAILED",
    message: "SSH host-key verification failed. Run 'ssh <browser-host>' from the Pi Session Host and resolve the host-key prompt, then retry.",
  });

  assert.deepEqual(classifySshFailure("will@laptop: Permission denied (publickey,password)."), {
    code: "SSH_AUTH_FAILED",
    message: "SSH authentication failed. Configure non-interactive SSH authentication so 'ssh -o BatchMode=yes <browser-host> true' succeeds.",
  });

  assert.equal(classifySshFailure("cat: /tmp/pi-annotate.token: No such file or directory"), null);
});

test("buildSshTunnelArgs uses a local TCP forward to the Browser Host Unix socket", () => {
  assert.deepEqual(buildSshTunnelArgs({ browserHost: "laptop", localPort: 49152, pageTunnel: null }), [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ExitOnForwardFailure=yes",
    "-N",
    "-L", "127.0.0.1:49152:/tmp/pi-annotate.sock",
    "laptop",
  ]);
});

test("buildSshTunnelArgs adds explicit loopback reverse forwards without remote node commands", () => {
  const args = buildSshTunnelArgs({
    browserHost: "laptop",
    localPort: 49153,
    pageTunnel: { targetHost: "127.0.0.1", targetPort: 3000, browserPort: 49154 },
  });

  assert.deepEqual(args, [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ExitOnForwardFailure=yes",
    "-N",
    "-L", "127.0.0.1:49153:/tmp/pi-annotate.sock",
    "-R", "127.0.0.1:49154:127.0.0.1:3000",
    "laptop",
  ]);
  assert.equal(args.some((arg) => /node|-e|StreamLocalBindUnlink/.test(arg)), false);
});

test("isRetryableTunnelStartupError does not retry Browser Host readiness timeouts", () => {
  assert.equal(
    isRetryableTunnelStartupError(new RemoteAnnotationError(
      "SSH_TUNNEL_TIMEOUT",
      "Timed out waiting for Pi Annotate endpoint '127.0.0.1:61462'."
    )),
    false
  );

  assert.equal(
    isRetryableTunnelStartupError(new RemoteAnnotationError(
      "SSH_TUNNEL_FAILED",
      "SSH tunnel exited before it became ready. bind: Address already in use"
    )),
    true
  );
});

test("toBrowserHostReadinessError explains readiness timeout without confusing it for the page URL", () => {
  const err = toBrowserHostReadinessError(
    "laptop",
    new RemoteAnnotationError("SSH_TUNNEL_TIMEOUT", "Timed out waiting for Pi Annotate endpoint '127.0.0.1:61462'.")
  );

  assert.equal(err.code, "BROWSER_HOST_NOT_READY");
  assert.match(err.message, /Browser Host 'laptop' did not answer Pi Annotate readiness PING/);
  assert.match(err.message, /native host is installed from the same pi-annotate branch/);
  assert.match(err.message, /annotation tunnel endpoint, not the page URL/);
});

test("waitForPiAnnotateEndpoint rejects unrelated TCP listeners", async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    trackSocket(sockets, socket);
    socket.write(JSON.stringify({ type: "NOT_PI_ANNOTATE" }) + "\n");
  });
  await listen(server);
  const { port } = server.address();

  try {
    await assert.rejects(
      waitForPiAnnotateEndpoint(new FakeProcess(), { type: "tcp", host: "127.0.0.1", port }, 150),
      (err) => err instanceof RemoteAnnotationError && err.code === "SSH_TUNNEL_TIMEOUT"
    );
  } finally {
    destroySockets(sockets);
    await closeServer(server);
  }
});

test("waitForPiAnnotateEndpoint resolves only after Pi Annotate PONG", async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    trackSocket(sockets, socket);
    socket.on("data", (data) => {
      if (data.toString().includes('"type":"PING"')) {
        socket.write(JSON.stringify({ type: "PONG" }) + "\n");
      }
    });
  });
  await listen(server);
  const { port } = server.address();

  try {
    await waitForPiAnnotateEndpoint(new FakeProcess(), { type: "tcp", host: "127.0.0.1", port }, 500);
  } finally {
    destroySockets(sockets);
    await closeServer(server);
  }
});

// Helpers

class FakeProcess extends EventEmitter {
  stderr = new EventEmitter();
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function trackSocket(sockets, socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

function destroySockets(sockets) {
  for (const socket of sockets) socket.destroy();
}

function urlLikeCommand() {
  return fc.record({
    scheme: fc.constantFrom("http", "https", "foo+bar", "x.y"),
    host: nonEmptyToken(),
    path: fc.array(nonEmptyToken(), { maxLength: 4 }),
  }).map(({ scheme, host, path }) => `${scheme}://${host}${path.length ? "/" + path.join("/") : ""}`);
}

function nonUrlToken() {
  return nonEmptyToken().filter((value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value));
}

function nonEmptyToken() {
  return fc.string({ minLength: 1 }).filter((value) => value.trim() === value && !/\s/.test(value));
}

function ipv4LoopbackUrl() {
  return fc.record({
    protocol: fc.constantFrom("http:", "https:"),
    host: fc.constantFrom("localhost", "127.0.0.1", "127.1.2.3"),
    targetPort: fc.integer({ min: 1, max: 65535 }),
    pathSegments: fc.array(fc.webSegment(), { maxLength: 4 }),
    query: fc.option(fc.webQueryParameters(), { nil: "" }),
    fragment: fc.option(fc.webFragments(), { nil: "" }),
  }).map(({ protocol, host, targetPort, pathSegments, query, fragment }) => {
    const pathname = `/${pathSegments.join("/")}`;
    const search = query ? `?${query}` : "";
    const hash = fragment ? `#${fragment}` : "";
    return {
      rawUrl: `${protocol}//${host}:${targetPort}${pathname}${search}${hash}`,
      targetPort,
      protocol,
    };
  });
}
