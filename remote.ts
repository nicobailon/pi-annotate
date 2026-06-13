import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const REMOTE_SOCKET_PATH = "/tmp/pi-annotate.sock";
export const REMOTE_TOKEN_PATH = "/tmp/pi-annotate.token";

const SSH_READY_TIMEOUT_MS = 5000;
const SSH_TUNNEL_TIMEOUT_MS = 7000;

export type RemoteAnnotationErrorCode =
  | "SSH_HOST_KEY_FAILED"
  | "SSH_AUTH_FAILED"
  | "SSH_HOST_UNRESOLVED"
  | "SSH_INVALID_HOST_ALIAS"
  | "SSH_CONNECT_FAILED"
  | "BROWSER_HOST_NOT_READY"
  | "REMOTE_IPV6_LOOPBACK_UNSUPPORTED"
  | "REMOTE_PORT_UNAVAILABLE"
  | "SSH_TUNNEL_FAILED"
  | "SSH_TUNNEL_TIMEOUT";

export interface ParsedAnnotateCommandArgs {
  browserHost?: string;
  url?: string;
}

export interface SshFailureClassification {
  code: Extract<RemoteAnnotationErrorCode,
    | "SSH_HOST_KEY_FAILED"
    | "SSH_AUTH_FAILED"
    | "SSH_HOST_UNRESOLVED"
    | "SSH_CONNECT_FAILED">;
  message: string;
}

export interface RemotePageAccessTunnel {
  targetHost: "127.0.0.1";
  targetPort: number;
  browserPort: number;
}

export interface RemotePageAccessPlan {
  url?: string;
  tunnel: RemotePageAccessTunnel | null;
}

export interface RemoteAnnotationBridge {
  browserHost: string;
  socketPath: string;
  token: string;
  url?: string;
  pageTunnel: RemotePageAccessTunnel | null;
  cleanup: () => void;
}

export class RemoteAnnotationError extends Error {
  code: RemoteAnnotationErrorCode;

  constructor(code: RemoteAnnotationErrorCode, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RemoteAnnotationError";
    this.code = code;
  }
}

export function parseAnnotateCommandArgs(args: string | undefined): ParsedAnnotateCommandArgs {
  const trimmed = (args || "").trim();
  if (!trimmed) return { browserHost: undefined, url: undefined };

  const [first, ...rest] = trimmed.split(/\s+/);
  if (isUrlLike(first)) {
    return { browserHost: undefined, url: trimmed };
  }

  return {
    browserHost: first,
    url: rest.length > 0 ? rest.join(" ") : undefined,
  };
}

export function isUrlLike(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export function validateBrowserHostAlias(browserHost: unknown): string {
  const alias = typeof browserHost === "string" ? browserHost.trim() : "";
  if (!alias || alias.startsWith("-") || /\s|[\x00-\x1f\x7f]/.test(alias)) {
    throw new RemoteAnnotationError(
      "SSH_INVALID_HOST_ALIAS",
      "Browser Host alias must be a non-empty SSH host alias and cannot start with '-' or contain whitespace/control characters."
    );
  }
  return alias;
}

export function isLoopbackPageUrl(rawUrl: unknown): rawUrl is string {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return isLoopbackHostname(parsed.hostname);
}

export function isLoopbackHostname(hostname: unknown): hostname is string {
  if (typeof hostname !== "string" || !hostname) return false;
  const h = normalizeHostname(hostname);
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

export function isIpv6LoopbackPageUrl(rawUrl: unknown): rawUrl is string {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return normalizeHostname(parsed.hostname) === "::1";
}

export function planRemotePageAccess(rawUrl: string | undefined, browserPort: number): RemotePageAccessPlan {
  if (!isLoopbackPageUrl(rawUrl)) {
    return { url: rawUrl, tunnel: null };
  }

  if (isIpv6LoopbackPageUrl(rawUrl)) {
    throw unsupportedRemoteIpv6LoopbackError();
  }

  const parsed = new URL(rawUrl);
  const targetPort = Number.parseInt(parsed.port || defaultPortForProtocol(parsed.protocol), 10);
  parsed.hostname = "127.0.0.1";
  parsed.port = String(browserPort);

  return {
    url: parsed.toString(),
    tunnel: {
      targetHost: "127.0.0.1",
      targetPort,
      browserPort,
    },
  };
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function unsupportedRemoteIpv6LoopbackError(): RemoteAnnotationError {
  return new RemoteAnnotationError(
    "REMOTE_IPV6_LOOPBACK_UNSUPPORTED",
    "Remote annotation does not support IPv6 loopback page URLs such as http://[::1]:3000. Use localhost or 127.0.0.1 from the Pi Session Host, or omit the URL to annotate the Browser Host's current tab."
  );
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function execFileText(file: string, args: string[], options: { timeout?: number; maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: options.timeout ?? SSH_READY_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr?.trim() || err.message;
        reject(new Error(message, { cause: err }));
        return;
      }
      resolve(String(stdout));
    });
  });
}

function sshBaseArgs(): string[] {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
}

function shellQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function buildRemoteNodeEvalCommand(script: string): string {
  return `node -e ${shellQuote(script)}`;
}

export function classifySshFailure(detail: unknown): SshFailureClassification | null {
  const text = String(detail || "");
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(text)) {
    return {
      code: "SSH_HOST_KEY_FAILED",
      message: "SSH host-key verification failed. Run 'ssh <browser-host>' from the Pi Session Host and resolve the host-key prompt, then retry.",
    };
  }
  if (/Permission denied/i.test(text)) {
    return {
      code: "SSH_AUTH_FAILED",
      message: "SSH authentication failed. Configure non-interactive SSH authentication so 'ssh -o BatchMode=yes <browser-host> true' succeeds.",
    };
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname provided/i.test(text)) {
    return {
      code: "SSH_HOST_UNRESOLVED",
      message: "SSH could not resolve the Browser Host alias. Check that the alias exists in SSH config or DNS from the Pi Session Host.",
    };
  }
  if (/Connection timed out|Connection refused|No route to host|Operation timed out/i.test(text)) {
    return {
      code: "SSH_CONNECT_FAILED",
      message: "SSH could not connect to the Browser Host. Check that the host is online and reachable from the Pi Session Host.",
    };
  }
  return null;
}

async function readRemoteToken(browserHost: string): Promise<string> {
  try {
    const token = await execFileText("ssh", [
      ...sshBaseArgs(),
      browserHost,
      "cat",
      REMOTE_TOKEN_PATH,
    ]);
    const trimmed = token.trim();
    if (!trimmed) throw new Error("token file was empty");
    return trimmed;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const sshFailure = classifySshFailure(detail);
    if (sshFailure) {
      throw new RemoteAnnotationError(
        sshFailure.code,
        `${sshFailure.message.replaceAll("<browser-host>", browserHost)} (${detail})`,
        { cause: err }
      );
    }
    throw new RemoteAnnotationError(
      "BROWSER_HOST_NOT_READY",
      `Browser Host '${browserHost}' is not ready. Open Chrome on '${browserHost}', click the Pi Annotate extension icon, then retry. (${detail})`,
      { cause: err }
    );
  }
}

async function pickRemoteBrowserPort(browserHost: string): Promise<number> {
  const script = "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});";
  const stdout = await execFileText("ssh", [
    ...sshBaseArgs(),
    browserHost,
    buildRemoteNodeEvalCommand(script),
  ]);
  const port = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RemoteAnnotationError("REMOTE_PORT_UNAVAILABLE", `Could not allocate a Browser Host port on '${browserHost}'.`);
  }
  return port;
}

function safeHostPart(host: string): string {
  return String(host).replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 60) || "host";
}

function makeLocalSocketPath(browserHost: string): string {
  return path.join(os.tmpdir(), `pi-annotate-${process.pid}-${Date.now()}-${safeHostPart(browserHost)}.sock`);
}

function unlinkIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return;
    throw err;
  }
}

function waitForLocalSocket(proc: ChildProcess, socketPath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let intervalId: NodeJS.Timeout | undefined;
    let timeoutId: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
      proc.off("error", onError);
      proc.off("exit", onExit);
      proc.stderr?.off("data", onStderr);
    };

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };

    const onError = (err: Error) => {
      finishReject(new RemoteAnnotationError(
        "SSH_TUNNEL_FAILED",
        `Failed to start SSH tunnel: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      ));
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finishReject(new RemoteAnnotationError(
        "SSH_TUNNEL_FAILED",
        `SSH tunnel exited before it became ready (code=${code ?? "null"}, signal=${signal ?? "null"}). ${stderr.trim()}`.trim()
      ));
    };

    proc.stderr?.on("data", onStderr);
    proc.once("error", onError);
    proc.once("exit", onExit);

    intervalId = setInterval(() => {
      if (fs.existsSync(socketPath)) {
        finishResolve();
      }
    }, 50);

    timeoutId = setTimeout(() => {
      finishReject(new RemoteAnnotationError(
        "SSH_TUNNEL_TIMEOUT",
        `Timed out waiting for SSH tunnel socket '${socketPath}'. ${stderr.trim()}`.trim()
      ));
    }, timeoutMs);
  });
}

export async function createRemoteAnnotationBridge({ browserHost, url }: { browserHost: string; url?: string }): Promise<RemoteAnnotationBridge> {
  browserHost = validateBrowserHostAlias(browserHost);
  if (isIpv6LoopbackPageUrl(url)) {
    throw unsupportedRemoteIpv6LoopbackError();
  }

  const token = await readRemoteToken(browserHost);
  let browserUrl = url;
  let pageAccess: RemotePageAccessPlan = { url, tunnel: null };

  if (isLoopbackPageUrl(url)) {
    const browserPort = await pickRemoteBrowserPort(browserHost);
    pageAccess = planRemotePageAccess(url, browserPort);
    browserUrl = pageAccess.url;
  }

  const socketPath = makeLocalSocketPath(browserHost);
  unlinkIfExists(socketPath);

  const args = [
    ...sshBaseArgs(),
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StreamLocalBindUnlink=yes",
    "-N",
    "-L", `${socketPath}:${REMOTE_SOCKET_PATH}`,
  ];

  if (pageAccess.tunnel) {
    args.push(
      "-R",
      `127.0.0.1:${pageAccess.tunnel.browserPort}:${pageAccess.tunnel.targetHost}:${pageAccess.tunnel.targetPort}`
    );
  }

  args.push(browserHost);

  const proc = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });

  try {
    await waitForLocalSocket(proc, socketPath, SSH_TUNNEL_TIMEOUT_MS);
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
    url: browserUrl,
    pageTunnel: pageAccess.tunnel,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      proc.kill("SIGTERM");
      unlinkIfExists(socketPath);
    },
  };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}
