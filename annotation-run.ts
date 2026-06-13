import type { AnnotationResult } from "./types.js";
import type { HostConnectionOptions } from "./host-connection.ts";
import type { RemoteAnnotationBridge } from "./remote.ts";
import { createRemoteAnnotationBridge as createDefaultRemoteAnnotationBridge, parseAnnotateCommandArgs } from "./remote.ts";

export type AnnotationContext = {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level: "info" | "error") => void;
    setStatus?: (source: string, message: string) => void;
  };
};

export interface AnnotationToolParams {
  url?: string;
  browserHost?: string;
  timeout?: number;
}

export interface AnnotationToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

export interface AnnotationRunManagerOptions {
  connectToHost: (options?: HostConnectionOptions) => Promise<void>;
  sendToHost: (message: object) => void;
  sendToHostAndFlush: (message: object) => Promise<void>;
  formatResult: (result: AnnotationResult) => Promise<string>;
  sendUserMessage: (message: string) => void;
  setStatus: (message: string) => void;
  createRemoteAnnotationBridge?: (options: { browserHost: string; url?: string }) => Promise<RemoteAnnotationBridge>;
  nextRequestId?: () => number;
}

export interface AnnotationRunManager {
  startCommand: (args: string, ctx: AnnotationContext) => Promise<void>;
  startTool: (params: AnnotationToolParams, signal: AbortSignal | undefined, ctx: AnnotationContext) => Promise<AnnotationToolResult>;
  handleHostMessage: (message: unknown) => Promise<void>;
  handleConnectionLost: () => void;
}

type PendingResolver = (result: AnnotationResult) => void | Promise<void>;

type PreparedAnnotation = {
  browserHost?: string;
  url?: string;
  remoteBridge: RemoteAnnotationBridge | null;
};

export function createAnnotationRunManager(options: AnnotationRunManagerOptions): AnnotationRunManager {
  const pendingRequests = new Map<number, PendingResolver>();
  const commandRequests = new Set<number>();
  const remoteSessions = new Map<number, RemoteAnnotationBridge>();
  const createRemoteAnnotationBridge = options.createRemoteAnnotationBridge ?? createDefaultRemoteAnnotationBridge;
  const nextRequestId = options.nextRequestId ?? Date.now;

  async function startCommand(args: string, ctx: AnnotationContext): Promise<void> {
    const parsed = parseAnnotateCommandArgs(args);
    let prepared: PreparedAnnotation;

    try {
      prepared = await prepareAnnotation({ browserHost: parsed.browserHost, url: parsed.url });
      await connectPreparedAnnotation(prepared);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fallback = parsed.browserHost
        ? `Remote annotation failed for '${parsed.browserHost}'. ${message}`
        : `Browser extension not connected. ${message}. Click the Pi Annotate icon in the browser to wake the service worker, then retry.`;
      ctx.ui?.notify?.(fallback, "error");
      return;
    }

    const requestId = nextRequestId();
    commandRequests.add(requestId);
    trackRemoteSession(requestId, prepared.remoteBridge);
    startAnnotation(requestId, prepared.url);
    notifyCommandStarted(ctx, prepared.browserHost, prepared.url);
  }

  async function startTool(params: AnnotationToolParams, signal: AbortSignal | undefined, ctx: AnnotationContext): Promise<AnnotationToolResult> {
    const browserHost = params.browserHost;
    let prepared: PreparedAnnotation;
    const requestId = nextRequestId();

    try {
      prepared = await prepareAnnotation({ browserHost, url: params.url });
      await connectPreparedAnnotation(prepared);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: browserHost ? `Remote annotation failed for '${browserHost}'. ${message}` : "Browser extension not connected. Click the Pi Annotate icon in the browser to wake the service worker, then retry." }],
        details: { error: message },
      };
    }

    trackRemoteSession(requestId, prepared.remoteBridge);

    return new Promise((resolve) => {
      let timeoutId: NodeJS.Timeout | null = null;
      let settled = false;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        pendingRequests.delete(requestId);
        cleanupRemoteSession(requestId);
        signal?.removeEventListener("abort", onAbort);
      };

      const settle = (result: AnnotationToolResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const cancelAndSettle = (reason: "aborted" | "timeout", result: AnnotationToolResult) => {
        void options.sendToHostAndFlush({ type: "CANCEL", requestId, reason }).finally(cleanup);
        settle(result);
      };

      const onAbort = () => {
        cancelAndSettle("aborted", {
          content: [{ type: "text", text: "Annotation was aborted." }],
          details: { aborted: true },
        });
      };

      if (signal?.aborted) {
        cleanup();
        settle({
          content: [{ type: "text", text: "Annotation was aborted." }],
          details: { aborted: true },
        });
        return;
      }
      signal?.addEventListener("abort", onAbort);

      pendingRequests.set(requestId, async (result) => {
        cleanup();
        settle({
          content: [{ type: "text", text: await options.formatResult(result) }],
          details: result,
        });
      });

      timeoutId = setTimeout(() => {
        cancelAndSettle("timeout", {
          content: [{ type: "text", text: `Annotation timed out after ${params.timeout ?? 300}s` }],
          details: { timeout: true },
        });
      }, (params.timeout ?? 300) * 1000);

      startAnnotation(requestId, prepared.url);

      if (ctx.hasUI) {
        ctx.ui?.notify?.(browserHost ? `Annotation mode started in ${browserHost}'s browser` : "Annotation mode started in the browser", "info");
      }
    });
  }

  async function handleHostMessage(msg: unknown): Promise<void> {
    if (!isRecord(msg) || typeof msg.type !== "string") return;

    options.setStatus(`Received: ${msg.type}`);

    const requestId = typeof msg.requestId === "number" ? msg.requestId : null;

    if (msg.type === "SESSION_REPLACED") {
      options.setStatus("Session replaced by another terminal");
      const reason = typeof msg.reason === "string" ? msg.reason : "Session replaced by another terminal";
      for (const [, resolvePending] of pendingRequests) {
        await resolvePending(cancelledResult(reason));
      }
      pendingRequests.clear();
      commandRequests.clear();
      cleanupAllRemoteSessions();
      return;
    }

    if (msg.type === "ANNOTATIONS_COMPLETE") {
      if (!isAnnotationResult(msg.result)) return;
      if (requestId && pendingRequests.has(requestId)) {
        const resolvePending = pendingRequests.get(requestId);
        if (!resolvePending) return;
        pendingRequests.delete(requestId);
        cleanupRemoteSession(requestId);
        await resolvePending(msg.result);
      } else if (requestId && commandRequests.has(requestId)) {
        commandRequests.delete(requestId);
        cleanupRemoteSession(requestId);
        const text = await options.formatResult(msg.result);
        options.setStatus("Annotation complete");
        options.sendUserMessage(text);
      }
    } else if (msg.type === "CANCEL") {
      cleanupRemoteSession(requestId);
      if (requestId && pendingRequests.has(requestId)) {
        const resolvePending = pendingRequests.get(requestId);
        if (!resolvePending) return;
        pendingRequests.delete(requestId);
        await resolvePending(cancelledResult(typeof msg.reason === "string" ? msg.reason : "user"));
      } else if (requestId && commandRequests.has(requestId)) {
        commandRequests.delete(requestId);
      }
    }
  }

  function handleConnectionLost(): void {
    cleanupAllRemoteSessions();
    for (const [, resolvePending] of pendingRequests) {
      resolvePending(cancelledResult("connection_lost"));
    }
    pendingRequests.clear();
    commandRequests.clear();
  }

  async function prepareAnnotation(input: { browserHost?: string; url?: string }): Promise<PreparedAnnotation> {
    if (!input.browserHost) return { browserHost: undefined, url: input.url, remoteBridge: null };

    options.setStatus(`Preparing remote annotation on ${input.browserHost}`);
    const remoteBridge = await createRemoteAnnotationBridge({ browserHost: input.browserHost, url: input.url });
    return {
      browserHost: input.browserHost,
      url: remoteBridge.url,
      remoteBridge,
    };
  }

  async function connectPreparedAnnotation(prepared: PreparedAnnotation): Promise<void> {
    try {
      await options.connectToHost(prepared.remoteBridge ? {
        endpoint: prepared.remoteBridge.endpoint,
        token: prepared.remoteBridge.token,
        label: `Browser Host ${prepared.browserHost}`,
      } : undefined);
    } catch (err) {
      prepared.remoteBridge?.cleanup();
      throw err;
    }
  }

  function startAnnotation(requestId: number, url: string | undefined): void {
    options.sendToHost({
      type: "START_ANNOTATION",
      requestId,
      url,
    });
  }

  function trackRemoteSession(requestId: number, remoteBridge: RemoteAnnotationBridge | null): void {
    if (remoteBridge) remoteSessions.set(requestId, remoteBridge);
  }

  function cleanupRemoteSession(requestId: number | null): void {
    if (!requestId) return;
    const session = remoteSessions.get(requestId);
    if (!session) return;
    remoteSessions.delete(requestId);
    session.cleanup();
  }

  function cleanupAllRemoteSessions(): void {
    for (const [, session] of remoteSessions) {
      session.cleanup();
    }
    remoteSessions.clear();
  }

  return { startCommand, startTool, handleHostMessage, handleConnectionLost };
}

function notifyCommandStarted(ctx: AnnotationContext, browserHost: string | undefined, url: string | undefined): void {
  if (browserHost) {
    ctx.ui?.notify?.(url ? `Opening annotation mode on ${browserHost}: ${url}` : `Annotation mode started on ${browserHost}'s current browser tab`, "info");
    return;
  }
  ctx.ui?.notify?.(url ? `Opening annotation mode on ${url}` : "Annotation mode started on current browser tab", "info");
}

function cancelledResult(reason: string): AnnotationResult {
  return {
    success: false,
    cancelled: true,
    reason,
    elements: [],
    url: "",
    viewport: { width: 0, height: 0 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAnnotationResult(value: unknown): value is AnnotationResult {
  if (!isRecord(value)) return false;
  if (typeof value.success !== "boolean") return false;
  return true;
}
