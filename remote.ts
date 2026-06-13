import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as net from "node:net";
import { randomInt } from "node:crypto";
import type { HostEndpoint } from "./host-connection.ts";

export const REMOTE_SOCKET_PATH = "/tmp/pi-annotate.sock";
export const REMOTE_TOKEN_PATH = "/tmp/pi-annotate.token";

const SSH_READY_TIMEOUT_MS = 5000;
const SSH_TUNNEL_TIMEOUT_MS = 7000;
const SSH_TUNNEL_ATTEMPTS = 20;
const LOOPBACK_HOST = "127.0.0.1" as const;
const EPHEMERAL_PORT_MIN = 49152;
const EPHEMERAL_PORT_MAX_EXCLUSIVE = 65536;

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

export interface SshTunnelArgsOptions {
  browserHost: string;
  localPort: number;
  pageTunnel: RemotePageAccessTunnel | null;
}

export interface RemoteAnnotationBridge {
  browserHost: string;
  endpoint: HostEndpoint;
  /** @deprecated Remote bridges now use endpoint. Present only for older internal callers. */
  socketPath?: string;
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
  parsed.hostname = LOOPBACK_HOST;
  parsed.port = String(browserPort);

  return {
    url: parsed.toString(),
    tunnel: {
      targetHost: LOOPBACK_HOST,
      targetPort,
      browserPort,
    },
  };
}

export function buildSshTunnelArgs({ browserHost, localPort, pageTunnel }: SshTunnelArgsOptions): string[] {
  const args = [
    ...sshBaseArgs(),
    "-o", "ExitOnForwardFailure=yes",
    "-N",
    "-L", `${LOOPBACK_HOST}:${localPort}:${REMOTE_SOCKET_PATH}`,
  ];

  if (pageTunnel) {
    args.push(
      "-R",
      `${LOOPBACK_HOST}:${pageTunnel.browserPort}:${pageTunnel.targetHost}:${pageTunnel.targetPort}`
    );
  }

  args.push(browserHost);
  return args;
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

function randomEphemeralPort(): number {
  return randomInt(EPHEMERAL_PORT_MIN, EPHEMERAL_PORT_MAX_EXCLUSIVE);
}

export function waitForPiAnnotateEndpoint(proc: ChildProcess, endpoint: Extract<HostEndpoint, { type: "tcp" }>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let intervalId: NodeJS.Timeout | undefined;
    let timeoutId: NodeJS.Timeout | undefined;
    const probes = new Set<net.Socket>();

    const cleanup = () => {
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
      proc.off("error", onError);
      proc.off("exit", onExit);
      proc.stderr?.off("data", onStderr);
      for (const probe of probes) probe.destroy();
      probes.clear();
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

    const probe = () => {
      if (settled) return;
      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
      probes.add(socket);
      let probeSettled = false;
      let probeBuffer = "";
      let probeTimeoutId: NodeJS.Timeout | undefined;

      const cleanupProbe = () => {
        if (probeSettled) return;
        probeSettled = true;
        if (probeTimeoutId) clearTimeout(probeTimeoutId);
        probes.delete(socket);
        socket.destroy();
      };

      socket.once("connect", () => {
        socket.write(JSON.stringify({ type: "PING" }) + "\n");
      });

      socket.on("data", (data) => {
        probeBuffer += data.toString();
        if (probeBuffer.length > 64 * 1024) {
          cleanupProbe();
          return;
        }

        const lines = probeBuffer.split("\n");
        probeBuffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg?.type === "PONG") {
              cleanupProbe();
              finishResolve();
              return;
            }
          } catch {
            cleanupProbe();
            return;
          }
        }
      });

      socket.once("error", cleanupProbe);
      socket.once("close", cleanupProbe);
      probeTimeoutId = setTimeout(cleanupProbe, 500);
    };

    proc.stderr?.on("data", onStderr);
    proc.once("error", onError);
    proc.once("exit", onExit);

    intervalId = setInterval(probe, 50);
    probe();

    timeoutId = setTimeout(() => {
      finishReject(new RemoteAnnotationError(
        "SSH_TUNNEL_TIMEOUT",
        `Timed out waiting for Pi Annotate endpoint '${endpoint.host}:${endpoint.port}'. ${stderr.trim()}`.trim()
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
  let lastError: unknown;

  for (let attempt = 1; attempt <= SSH_TUNNEL_ATTEMPTS; attempt += 1) {
    const localPort = randomEphemeralPort();
    const endpoint: Extract<HostEndpoint, { type: "tcp" }> = { type: "tcp", host: LOOPBACK_HOST, port: localPort };
    let browserUrl = url;
    let pageAccess: RemotePageAccessPlan = { url, tunnel: null };

    if (isLoopbackPageUrl(url)) {
      const browserPort = randomEphemeralPort();
      pageAccess = planRemotePageAccess(url, browserPort);
      browserUrl = pageAccess.url;
    }

    const proc = spawn("ssh", buildSshTunnelArgs({ browserHost, localPort, pageTunnel: pageAccess.tunnel }), {
      stdio: ["ignore", "ignore", "pipe"],
    });

    try {
      await waitForPiAnnotateEndpoint(proc, endpoint, SSH_TUNNEL_TIMEOUT_MS);
      let cleaned = false;
      return {
        browserHost,
        endpoint,
        token,
        url: browserUrl,
        pageTunnel: pageAccess.tunnel,
        cleanup() {
          if (cleaned) return;
          cleaned = true;
          proc.kill("SIGTERM");
        },
      };
    } catch (err) {
      proc.kill("SIGTERM");
      lastError = err;
      if (attempt < SSH_TUNNEL_ATTEMPTS && isRetryableTunnelStartupError(err)) {
        continue;
      }
      throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new RemoteAnnotationError("REMOTE_PORT_UNAVAILABLE", `Could not allocate tunnel ports for '${browserHost}'.`);
}

function isRetryableTunnelStartupError(err: unknown): boolean {
  if (!(err instanceof RemoteAnnotationError)) return false;
  if (err.code !== "SSH_TUNNEL_FAILED" && err.code !== "SSH_TUNNEL_TIMEOUT") return false;
  return /Address already in use|bind|cannot listen|port forwarding failed|remote port forwarding failed|Timed out/i.test(err.message);
}
