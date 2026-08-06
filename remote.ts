import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REMOTE_SOCKET_PATH = "/tmp/pi-annotate.sock";
const REMOTE_TOKEN_PATH = "/tmp/pi-annotate.token";
const SSH_READY_TIMEOUT_MS = 5000;
const SSH_TUNNEL_TIMEOUT_MS = 7000;

type RemotePageTunnel = {
  browserPort: number;
  targetHost: string;
  targetPort: number;
};

export type RemoteAnnotationBridge = {
  browserHost: string;
  socketPath: string;
  token: string;
  url?: string;
  cleanup: () => void;
};

export type ParsedAnnotateArgs = {
  browserHost?: string;
  url?: string;
};

export type WslBridgeConfig = {
  host: string;
  port: number;
  token: string;
};

export class RemoteAnnotationError extends Error {
  code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteAnnotationError";
    this.code = code;
  }
}

export function parseAnnotateCommandArgs(args: string): ParsedAnnotateArgs {
  const trimmed = args.trim();
  if (!trimmed) return {};

  const [first, ...rest] = trimmed.split(/\s+/);
  if (isUrlLike(first)) return { url: trimmed };

  return {
    browserHost: first,
    url: rest.length > 0 ? rest.join(" ") : undefined,
  };
}

export function isUrlLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export function isRemoteLoopbackUrl(rawUrl: string | undefined): boolean {
  const hostname = getPageHostname(rawUrl);
  return !!hostname && isSupportedLoopbackHostname(hostname);
}

function isUnsupportedLoopbackUrl(rawUrl: string | undefined): boolean {
  const hostname = getPageHostname(rawUrl);
  return hostname === "::1";
}

function getPageHostname(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    return null;
  }
}

function isSupportedLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isWslBridgeLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function planRemotePageAccess(rawUrl: string | undefined, browserPort: number): { url?: string; tunnel?: RemotePageTunnel } {
  if (!rawUrl || !isRemoteLoopbackUrl(rawUrl)) return { url: rawUrl };

  const parsed = new URL(rawUrl);
  const targetPort = Number.parseInt(parsed.port || defaultPortForProtocol(parsed.protocol), 10);
  parsed.hostname = "127.0.0.1";
  parsed.port = String(browserPort);

  return {
    url: parsed.toString(),
    tunnel: {
      browserPort,
      targetHost: "127.0.0.1",
      targetPort,
    },
  };
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

export function parseWslBridgeEnv(env: NodeJS.ProcessEnv = process.env): WslBridgeConfig | null {
  const target = env.PI_ANNOTATE_WSL_BRIDGE?.trim();
  const token = env.PI_ANNOTATE_WSL_TOKEN?.trim();
  if (!target && !token) return null;
  if (!target || !token) {
    throw new RemoteAnnotationError(
      "WSL_BRIDGE_CONFIG_INCOMPLETE",
      "Set both PI_ANNOTATE_WSL_BRIDGE and PI_ANNOTATE_WSL_TOKEN in WSL before using the Windows Browser Host bridge."
    );
  }

  try {
    const parsed = target.includes("://") ? new URL(target) : new URL(`tcp://${target}`);
    const host = parsed.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    const port = Number.parseInt(parsed.port, 10);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid host or port");
    if (!isWslBridgeLoopbackHost(host)) throw new Error("bridge host must be loopback");
    return { host, port, token };
  } catch (err) {
    throw new RemoteAnnotationError(
      "WSL_BRIDGE_CONFIG_INVALID",
      "PI_ANNOTATE_WSL_BRIDGE must be a loopback host:port value such as 127.0.0.1:43173.",
      { cause: err }
    );
  }
}

function assertBrowserHost(browserHost: string) {
  if (!/^[A-Za-z0-9_.@:-]+$/.test(browserHost) || browserHost.startsWith("-")) {
    throw new RemoteAnnotationError(
      "BROWSER_HOST_INVALID",
      "Browser Host must be an SSH host alias, hostname, or user@host without spaces or shell metacharacters."
    );
  }
}

function classifySshFailure(detail: string): { code: string; message: string } | null {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(detail)) {
    return {
      code: "SSH_HOST_KEY_FAILED",
      message: "SSH host-key verification failed. Run ssh to the Browser Host once from the Pi Session Host, then retry.",
    };
  }
  if (/Permission denied/i.test(detail)) {
    return {
      code: "SSH_AUTH_FAILED",
      message: "SSH authentication failed. Configure non-interactive SSH so BatchMode works from the Pi Session Host.",
    };
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname provided/i.test(detail)) {
    return {
      code: "SSH_HOST_UNRESOLVED",
      message: "SSH could not resolve the Browser Host. Check the SSH alias from the Pi Session Host.",
    };
  }
  if (/Connection timed out|Connection refused|No route to host|Operation timed out/i.test(detail)) {
    return {
      code: "SSH_CONNECT_FAILED",
      message: "SSH could not connect to the Browser Host. Check that it is online and reachable.",
    };
  }
  return null;
}

function sshBaseArgs(browserHost: string): string[] {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", browserHost];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function remoteNodeEval(script: string): string {
  return `node -e ${shellQuote(script)}`;
}

function execFileText(file: string, args: string[], timeout = SSH_READY_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message, { cause: err }));
        return;
      }
      resolve(stdout);
    });
  });
}

async function readRemoteToken(browserHost: string): Promise<string> {
  try {
    const token = (await execFileText("ssh", [...sshBaseArgs(browserHost), "cat", REMOTE_TOKEN_PATH])).trim();
    if (!token) throw new Error("remote token file is empty");
    return token;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const sshFailure = classifySshFailure(detail);
    if (sshFailure) throw new RemoteAnnotationError(sshFailure.code, `${sshFailure.message} (${detail})`, { cause: err });
    throw new RemoteAnnotationError(
      "BROWSER_HOST_NOT_READY",
      `Browser Host '${browserHost}' is not ready. Open Chrome or Chromium there, click the Pi Annotate extension icon, then retry. (${detail})`,
      { cause: err }
    );
  }
}

async function pickBrowserHostPort(browserHost: string): Promise<number> {
  const script = "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});";
  const stdout = await execFileText("ssh", [...sshBaseArgs(browserHost), remoteNodeEval(script)]);
  const port = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RemoteAnnotationError("REMOTE_PORT_UNAVAILABLE", `Could not allocate a loopback port on Browser Host '${browserHost}'.`);
  }
  return port;
}

export function makeLocalSocketPath(_browserHost: string): string {
  const suffix = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join("/tmp", `pa-${suffix}.sock`);
}

function unlinkIfExists(filePath: string) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code !== "ENOENT") throw err;
  }
}

function waitForLocalSocket(proc: ChildProcessWithoutNullStreams, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const intervalId = setInterval(() => {
      if (fs.existsSync(socketPath)) finish(resolve);
    }, 50);
    const timeoutId = setTimeout(() => {
      finish(reject, new RemoteAnnotationError("SSH_TUNNEL_TIMEOUT", `Timed out waiting for SSH tunnel. ${stderr.trim()}`.trim()));
    }, SSH_TUNNEL_TIMEOUT_MS);

    function cleanup() {
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      proc.off("error", onError);
      proc.off("exit", onExit);
      proc.stderr.off("data", onStderr);
    }

    function finish<T>(fn: (value: T) => void, value?: T) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value as T);
    }

    function onStderr(chunk: Buffer) {
      stderr += chunk.toString();
    }

    function onError(err: Error) {
      finish(reject, new RemoteAnnotationError("SSH_TUNNEL_FAILED", `Failed to start SSH tunnel: ${err.message}`, { cause: err }));
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      finish(reject, new RemoteAnnotationError(
        "SSH_TUNNEL_FAILED",
        `SSH tunnel exited before it became ready (code=${code ?? "null"}, signal=${signal ?? "null"}). ${stderr.trim()}`.trim()
      ));
    }

    proc.stderr.on("data", onStderr);
    proc.once("error", onError);
    proc.once("exit", onExit);
  });
}

export async function createRemoteAnnotationBridge(options: { browserHost: string; url?: string }): Promise<RemoteAnnotationBridge> {
  const { browserHost, url } = options;
  assertBrowserHost(browserHost);
  if (isUnsupportedLoopbackUrl(url)) {
    throw new RemoteAnnotationError(
      "LOOPBACK_URL_UNSUPPORTED",
      "Remote annotation supports localhost and 127.0.0.1 loopback URLs. Use one of those instead of IPv6 loopback."
    );
  }

  const token = await readRemoteToken(browserHost);
  const browserPort = isRemoteLoopbackUrl(url) ? await pickBrowserHostPort(browserHost) : 0;
  const pageAccess = planRemotePageAccess(url, browserPort);
  const socketPath = makeLocalSocketPath(browserHost);
  unlinkIfExists(socketPath);

  const args = [
    ...sshBaseArgs(browserHost).slice(0, -1),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StreamLocalBindUnlink=yes",
    "-N",
    "-L",
    `${socketPath}:${REMOTE_SOCKET_PATH}`,
  ];

  if (pageAccess.tunnel) {
    args.push("-R", `127.0.0.1:${pageAccess.tunnel.browserPort}:${pageAccess.tunnel.targetHost}:${pageAccess.tunnel.targetPort}`);
  }

  args.push(browserHost);

  const proc = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
  try {
    await waitForLocalSocket(proc, socketPath);
  } catch (err) {
    proc.kill("SIGTERM");
    unlinkIfExists(socketPath);
    throw err;
  }

  let cleaned = false;
  return {
    browserHost,
    socketPath,
    token,
    url: pageAccess.url,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      proc.kill("SIGTERM");
      unlinkIfExists(socketPath);
    },
  };
}
