import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRemoteNodeEvalCommand,
  classifySshFailure,
  isLoopbackPageUrl,
  parseAnnotateCommandArgs,
  planRemotePageAccess,
} from "../remote.js";

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

test("isLoopbackPageUrl detects only loopback page URLs", () => {
  assert.equal(isLoopbackPageUrl("http://localhost:3000"), true);
  assert.equal(isLoopbackPageUrl("https://127.0.0.1:5173"), true);
  assert.equal(isLoopbackPageUrl("http://[::1]:8080"), true);
  assert.equal(isLoopbackPageUrl("http://desktop:3000"), false);
  assert.equal(isLoopbackPageUrl("https://example.com"), false);
  assert.equal(isLoopbackPageUrl(undefined), false);
});

test("planRemotePageAccess tunnels loopback URLs and rewrites only the browser-facing port", () => {
  assert.deepEqual(planRemotePageAccess("http://localhost:3000/path?q=1#hash", 49152), {
    url: "http://localhost:49152/path?q=1#hash",
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

test("buildRemoteNodeEvalCommand shell-quotes node scripts for ssh remote execution", () => {
  const script = "const net=require('node:net');s.listen(0,'127.0.0.1',()=>{});";
  assert.equal(
    buildRemoteNodeEvalCommand(script),
    String.raw`node -e 'const net=require('\''node:net'\'');s.listen(0,'\''127.0.0.1'\'',()=>{});'`
  );
});
