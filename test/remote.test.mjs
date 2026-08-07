import test from 'node:test';
import assert from 'node:assert/strict';

import * as remoteNamespace from '../remote.ts';

const {
  makeLocalSocketPath,
  parseAnnotateCommandArgs,
  parseWslBridgeEnv,
  planRemotePageAccess,
} = remoteNamespace.default ?? remoteNamespace;

test('parseAnnotateCommandArgs preserves same-machine URL forms', () => {
  assert.deepEqual(parseAnnotateCommandArgs(''), { mode: 'same-machine' });
  assert.deepEqual(parseAnnotateCommandArgs('https://example.com/a b'), { mode: 'same-machine', url: 'https://example.com/a b' });
  assert.deepEqual(parseAnnotateCommandArgs('http://localhost:3000'), { mode: 'same-machine', url: 'http://localhost:3000' });
});

test('parseAnnotateCommandArgs treats first non-URL token as Browser Host', () => {
  assert.deepEqual(parseAnnotateCommandArgs('laptop'), { mode: 'browser-host', browserHost: 'laptop' });
  assert.deepEqual(parseAnnotateCommandArgs('laptop http://localhost:3000'), { mode: 'browser-host', browserHost: 'laptop', url: 'http://localhost:3000' });
});

test('planRemotePageAccess rewrites supported loopback URLs to Browser Host loopback port', () => {
  assert.deepEqual(planRemotePageAccess('http://localhost:3000/path?q=1#hash', 49152), {
    url: 'http://127.0.0.1:49152/path?q=1#hash',
    tunnel: { browserPort: 49152, targetHost: '127.0.0.1', targetPort: 3000 },
  });
  assert.deepEqual(planRemotePageAccess('https://127.0.0.1/settings', 49152), {
    url: 'https://127.0.0.1:49152/settings',
    tunnel: { browserPort: 49152, targetHost: '127.0.0.1', targetPort: 443 },
  });
  assert.deepEqual(planRemotePageAccess('http://[::1]:3000', 49152), { url: 'http://[::1]:3000' });
  assert.deepEqual(planRemotePageAccess('https://example.com', 49152), { url: 'https://example.com' });
});

test('makeLocalSocketPath stays short for long SSH aliases', () => {
  const socketPath = makeLocalSocketPath('a'.repeat(120));
  assert.equal(socketPath.startsWith('/tmp/pa-'), true);
  assert.equal(socketPath.endsWith('.sock'), true);
  assert.equal(Buffer.byteLength(socketPath), socketPath.length);
  assert.ok(socketPath.length < 104);
});


test('parseWslBridgeEnv requires explicit bridge and token', () => {
  assert.equal(parseWslBridgeEnv({}), null);
  assert.deepEqual(parseWslBridgeEnv({
    PI_ANNOTATE_WSL_BRIDGE: '127.0.0.1:43173',
    PI_ANNOTATE_WSL_TOKEN: 'secret',
  }), { host: '127.0.0.1', port: 43173, token: 'secret' });
  assert.throws(() => parseWslBridgeEnv({ PI_ANNOTATE_WSL_BRIDGE: '127.0.0.1:43173' }), /Set both PI_ANNOTATE_WSL_BRIDGE/);
  assert.throws(() => parseWslBridgeEnv({ PI_ANNOTATE_WSL_BRIDGE: '127.0.0.1:notaport', PI_ANNOTATE_WSL_TOKEN: 'secret' }), /host:port/);
  assert.throws(() => parseWslBridgeEnv({ PI_ANNOTATE_WSL_BRIDGE: '0.0.0.0:43173', PI_ANNOTATE_WSL_TOKEN: 'secret' }), /loopback host:port/);
});
