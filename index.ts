import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AnnotationResult, ElementSelection, EditCapture } from "./types.ts";

const SOCKET_PATH = "/tmp/pi-annotate.sock";
const TOKEN_PATH = "/tmp/pi-annotate.token";
const MAX_SOCKET_BUFFER = 32 * 1024 * 1024; // 32MB (increased from 8MB for edit capture payloads)
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024; // 15MB

type AnnotationContext = {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level: "info" | "error") => void;
    setStatus?: (source: string, message: string) => void;
  };
};

export default function (pi: ExtensionAPI) {
  let browserSocket: net.Socket | null = null;
  const pendingRequests = new Map<number, (result: AnnotationResult) => void | Promise<void>>();
  let dataBuffer = ""; // Buffer for incomplete JSON messages
  let authToken: string | null = null;
  let currentCtx: AnnotationContext | null = null;
  let active = true;

  function setStatus(message: string) {
    if (active && currentCtx?.ui?.setStatus) {
      currentCtx.ui.setStatus("pi-annotate", message);
    }
  }

  async function cancelPendingRequests(reason: string) {
    const result: AnnotationResult = {
      success: false,
      cancelled: true,
      reason,
      elements: [],
      url: "",
      viewport: { width: 0, height: 0 },
    };
    const requests = [...pendingRequests.values()];
    pendingRequests.clear();
    await Promise.allSettled(requests.map((resolvePending) => resolvePending(result)));
  }

  pi.on("session_shutdown", async () => {
    active = false;
    currentCtx = null;
    authToken = null;
    dataBuffer = "";
    const socket = browserSocket;
    browserSocket = null;
    socket?.removeAllListeners();
    socket?.destroy();
    await cancelPendingRequests("session_shutdown");
  });
  
  // ─────────────────────────────────────────────────────────────────────
  // /annotate Command
  // ─────────────────────────────────────────────────────────────────────
  
  const annotateHandler = async (args: string, ctx: AnnotationContext) => {
    currentCtx = ctx;
    const url = args.trim() || undefined;
    
    try {
      await connectToHost();
    } catch (err) {
      if (!active) return;
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui?.notify(`Browser extension not connected. ${message}. Click the Pi Annotate icon in the browser to wake the service worker, then retry.`, "error");
      return;
    }

    if (!active) return;
    
    const requestId = Date.now();
    sendToHost({
      type: "START_ANNOTATION",
      requestId,
      url,
    });
    
    ctx.ui?.notify(url ? `Opening annotation mode on ${url}` : "Annotation mode started on current browser tab", "info");
  };

  pi.registerCommand("annotate", {
    description: "Start visual annotation mode in the browser. Optionally provide a URL.",
    handler: annotateHandler,
  });
  
  // ─────────────────────────────────────────────────────────────────────
  // Socket Connection
  // ─────────────────────────────────────────────────────────────────────
  
  function connectToHost(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (browserSocket && !browserSocket.destroyed) {
        resolve();
        return;
      }

      try {
        authToken = fs.readFileSync(TOKEN_PATH, "utf8").trim();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to read auth token at ${TOKEN_PATH}: ${message}`, { cause: err }));
        return;
      }

      browserSocket = net.createConnection(SOCKET_PATH);
      
      browserSocket.on("connect", () => {
        setStatus("Connected to native host");
        sendToHost({ type: "AUTH", token: authToken });
        resolve();
      });
      
      browserSocket.on("data", (data) => {
        // Buffer incoming data and split by newlines
        dataBuffer += data.toString();
        if (dataBuffer.length > MAX_SOCKET_BUFFER) {
          setStatus("Error: Socket buffer overflow");
          browserSocket?.destroy();
          dataBuffer = "";
          return;
        }
        const lines = dataBuffer.split("\n");
        
        // Keep the last incomplete line in the buffer
        dataBuffer = lines.pop() || "";
        
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            void handleMessage(msg).catch(() => {});
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setStatus(`Error: Failed to parse message: ${message}`);
          }
        }
      });
      
      browserSocket.on("error", (err) => {
        setStatus(`Error: ${err.message}`);
        reject(err);
      });
      
      browserSocket.on("close", () => {
        setStatus("Disconnected from native host");
        browserSocket = null;
        authToken = null;
        dataBuffer = "";
        void cancelPendingRequests("connection_lost");
      });
    });
  }
  
  function sendToHost(msg: object) {
    if (browserSocket && !browserSocket.destroyed) {
      browserSocket.write(JSON.stringify(msg) + "\n");
    }
  }
  
  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function isAnnotationResult(value: unknown): value is AnnotationResult {
    if (!isRecord(value)) return false;
    if (typeof value.success !== "boolean") return false;
    return true;
  }

  async function handleMessage(msg: unknown) {
    if (!active || !isRecord(msg) || typeof msg.type !== "string") return;
    
    setStatus(`Received: ${msg.type}`);

    const requestId = typeof msg.requestId === "number" ? msg.requestId : null;

    if (msg.type === "SESSION_REPLACED") {
      // Another terminal took over the annotation session
      setStatus("Session replaced by another terminal");
      const reason = typeof msg.reason === "string" ? msg.reason : "Session replaced by another terminal";
      
      // Resolve all pending requests with cancelled status
      await cancelPendingRequests(reason);
      
      // Connection will be destroyed by native host, so clean up
      browserSocket = null;
      dataBuffer = "";
      return;
    }

    if (msg.type === "ANNOTATIONS_COMPLETE") {
      if (!isAnnotationResult(msg.result)) return;
      if (requestId && pendingRequests.has(requestId)) {
        // Tool flow - resolve the promise
        const resolvePending = pendingRequests.get(requestId);
        if (!resolvePending) return;
        pendingRequests.delete(requestId);
        await resolvePending(msg.result);
      } else {
        // Command flow - inject as user message
        const result = msg.result;
        const text = await formatResult(result);
        if (!active) return;
        setStatus("Annotation complete");
        pi.sendUserMessage(text);
      }
    } else if (msg.type === "CANCEL") {
      if (requestId && pendingRequests.has(requestId)) {
        const resolvePending = pendingRequests.get(requestId);
        if (!resolvePending) return;
        pendingRequests.delete(requestId);
        await resolvePending({
          success: false,
          cancelled: true,
          reason: typeof msg.reason === "string" ? msg.reason : "user",
          elements: [],
          url: "",
          viewport: { width: 0, height: 0 },
        });
      }
      // For command flow, cancel is just ignored (UI already closed)
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Format Result
  // ─────────────────────────────────────────────────────────────────────

  function formatEditCapture(capture: EditCapture): string {
    let output = "";

    if (capture.warnings?.length) {
      for (const w of capture.warnings) {
        output += `> **Note:** ${w}\n`;
      }
      output += "\n";
    }

    // Inline style changes
    if (capture.inlineStyles.length > 0) {
      output += `### Inline Style Changes\n\n`;
      for (const change of capture.inlineStyles) {
        output += `**\`${change.selector}\`**\n`;
        for (const c of change.changed) {
          output += `- \`${c.property}\`: \`${c.from}\` → \`${c.to}\`\n`;
        }
        for (const [prop, value] of Object.entries(change.added)) {
          output += `- \`${prop}\`: added \`${value}\`\n`;
        }
        for (const prop of change.removed) {
          output += `- \`${prop}\`: removed\n`;
        }
        output += "\n";
      }
    }

    // Stylesheet rule changes
    if (capture.rules.length > 0) {
      output += `### CSS Rule Changes\n\n`;
      for (const change of capture.rules) {
        output += `**\`${change.ruleSelector}\`** (${change.sheet})\n`;
        for (const c of change.changed) {
          output += `- \`${c.property}\`: \`${c.from}\` → \`${c.to}\`\n`;
        }
        for (const [prop, value] of Object.entries(change.added)) {
          output += `- \`${prop}\`: added \`${value}\`\n`;
        }
        for (const prop of change.removed) {
          output += `- \`${prop}\`: removed\n`;
        }
        output += "\n";
      }
    }

    // DOM changes
    if (capture.dom.length > 0) {
      output += `### DOM Changes\n\n`;
      for (const change of capture.dom) {
        output += `- **\`${change.selector}\`** — ${change.detail}\n`;
      }
      output += "\n";
    }

    return output;
  }
  
  async function formatResult(result: AnnotationResult): Promise<string> {
    if (!result.success) {
      if (result.cancelled) {
        if (result.reason?.includes("Another terminal")) {
          return `Annotation session ended: ${result.reason}`;
        }
        if (result.reason && result.reason !== "user") {
          return `Annotation cancelled: ${result.reason}`;
        }
        return "Annotation cancelled by user.";
      }
      return `Annotation failed: ${result.reason || "Unknown error"}`;
    }
    
    let output = `## Page Annotation: ${result.url || "Unknown"}\n`;
    if (result.viewport) {
      output += `**Viewport:** ${result.viewport.width}×${result.viewport.height}\n\n`;
    }
    
    // Show overall context if provided (uses existing 'prompt' field for backwards compat)
    if (result.prompt) {
      output += `**Context:** ${result.prompt}\n\n`;
    }
    
    // Check if any element has debug data (to show header)
    const hasDebugData = result.elements?.some(el => el.computedStyles || el.parentContext || el.cssVariables);
    if (hasDebugData) {
      output += `**Debug Mode:** Enabled\n\n`;
    }
    
    if (result.elements && result.elements.length > 0) {
      output += `### Selected Elements (${result.elements.length})\n\n`;
      result.elements.forEach((el: ElementSelection, i: number) => {
        output += `${i + 1}. **${el.tag}**\n`;
        output += `   - Selector: \`${el.selector}\`\n`;
        if (el.id) output += `   - ID: \`${el.id}\`\n`;
        if (el.classes?.length) output += `   - Classes: \`${el.classes.join(", ")}\`\n`;
        if (el.text) {
          output += `   - Text: "${el.text}"\n`;
        }
        
        // Box model (v0.3.0) - compact format
        if (el.boxModel) {
          const bm = el.boxModel;
          const padStr = `${bm.padding.top} ${bm.padding.right} ${bm.padding.bottom} ${bm.padding.left}`;
          const borderStr = bm.border.top || bm.border.right || bm.border.bottom || bm.border.left
            ? `${bm.border.top} ${bm.border.right} ${bm.border.bottom} ${bm.border.left}` : "0";
          const marginStr = `${bm.margin.top} ${bm.margin.right} ${bm.margin.bottom} ${bm.margin.left}`;
          output += `   - **Box Model:** ${el.rect.width}×${el.rect.height} (content: ${bm.content.width}×${bm.content.height}, padding: ${padStr}, border: ${borderStr}, margin: ${marginStr})\n`;
        } else {
          output += `   - Size: ${el.rect.width}×${el.rect.height}px\n`;
        }
        
        // Attributes (v0.3.0) - fix: was captured but never output
        if (el.attributes && Object.keys(el.attributes).length > 0) {
          const attrStr = Object.entries(el.attributes)
            .map(([k, v]) => `${k}="${v}"`)
            .join(", ");
          output += `   - **Attributes:** ${attrStr}\n`;
        }
        
        // Accessibility (v0.3.0) - compact format, omit undefined booleans
        if (el.accessibility) {
          const a11y = el.accessibility;
          const parts: string[] = [];
          if (a11y.role) parts.push(`role=${a11y.role}`);
          if (a11y.name) parts.push(`name="${a11y.name}"`);
          parts.push(`focusable=${a11y.focusable}`);
          parts.push(`disabled=${a11y.disabled}`);
          if (a11y.expanded !== undefined) parts.push(`expanded=${a11y.expanded}`);
          if (a11y.pressed !== undefined) parts.push(`pressed=${a11y.pressed}`);
          if (a11y.checked !== undefined) parts.push(`checked=${a11y.checked}`);
          if (a11y.selected !== undefined) parts.push(`selected=${a11y.selected}`);
          if (a11y.description) parts.push(`description="${a11y.description}"`);
          output += `   - **Accessibility:** ${parts.join(", ")}\n`;
        }
        
        // Key styles - compact format (suppressed when full computedStyles is present)
        const hasComputedStyles = el.computedStyles && Object.keys(el.computedStyles).length > 0;
        if (!hasComputedStyles && el.keyStyles && Object.keys(el.keyStyles).length > 0) {
          const styleStr = Object.entries(el.keyStyles).map(([k, v]) => `${k}: ${v}`).join(", ");
          output += `   - **Styles:** ${styleStr}\n`;
        }
        
        // Comment
        if (el.comment) {
          output += `   - **Comment:** ${el.comment}\n`;
        }
        
        // Debug mode data (v0.3.0) - verbose format
        if (el.computedStyles && Object.keys(el.computedStyles).length > 0) {
          output += `   - **Computed Styles:**\n`;
          for (const [key, value] of Object.entries(el.computedStyles)) {
            output += `     - ${key}: ${value}\n`;
          }
        }
        
        if (el.parentContext) {
          const pc = el.parentContext;
          const pcLabel = pc.id ? `${pc.tag}#${pc.id}` : `${pc.tag}${pc.classes[0] ? "." + pc.classes[0] : ""}`;
          const pcStyles = Object.entries(pc.styles).map(([k, v]) => `${k}: ${v}`).join(", ");
          output += `   - **Parent Context:** ${pcLabel} (${pcStyles})\n`;
        }
        
        if (el.cssVariables && Object.keys(el.cssVariables).length > 0) {
          output += `   - **CSS Variables:**\n`;
          for (const [name, value] of Object.entries(el.cssVariables)) {
            output += `     - ${name}: ${value}\n`;
          }
        }
        
        output += `\n`;
      });
    } else {
      output += "*No elements selected*\n\n";
    }
    
    // Handle screenshots
    const timestamp = Date.now();
    
    if (result.screenshot) {
      // Full page screenshot
      try {
        if (!result.screenshot.startsWith("data:image/")) throw new Error("Invalid screenshot data");
        const screenshotPath = path.join(os.tmpdir(), `pi-annotate-${timestamp}-full.png`);
        const base64Data = result.screenshot.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
        await fs.promises.writeFile(screenshotPath, buffer);
        output += `**Screenshot (full page):** ${screenshotPath}\n`;
      } catch (err) {
        output += `*Screenshot capture failed: ${err}*\n`;
      }
    }
    
    if (result.screenshots && result.screenshots.length > 0) {
      // Individual element screenshots
      output += `### Screenshots\n\n`;
      for (let i = 0; i < result.screenshots.length; i++) {
        const shot = result.screenshots[i];
        try {
          if (!shot?.dataUrl?.startsWith("data:image/")) throw new Error("Invalid screenshot data");
          const safeIndex = Number.isFinite(shot.index) ? Math.max(1, Math.floor(shot.index)) : i + 1;
          const screenshotPath = path.join(os.tmpdir(), `pi-annotate-${timestamp}-el${safeIndex}.png`);
          const base64Data = shot.dataUrl.replace(/^data:image\/\w+;base64,/, "");
          const buffer = Buffer.from(base64Data, "base64");
          if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
          await fs.promises.writeFile(screenshotPath, buffer);
          output += `- Element ${safeIndex}: ${screenshotPath}\n`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output += `- Element ${shot?.index ?? i + 1}: *capture failed (${message})*\n`;
        }
      }
      output += "\n";
    }

    if (result.editCapture && result.editCapture.changeCount > 0) {
      const ec = result.editCapture;
      output += `## Edit Capture (${ec.changeCount} changes, ${Math.round(ec.duration / 1000)}s)\n\n`;
      output += formatEditCapture(ec);

      // Before/after screenshots
      if (ec.beforeScreenshot || ec.afterScreenshot) {
        output += `### Before/After Screenshots\n\n`;
        if (ec.beforeScreenshot) {
          try {
            const p = path.join(os.tmpdir(), `pi-annotate-${timestamp}-before.png`);
            const buf = Buffer.from(ec.beforeScreenshot.replace(/^data:image\/\w+;base64,/, ""), "base64");
            if (buf.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
            await fs.promises.writeFile(p, buf);
            output += `- Before: ${p}\n`;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            output += `- Before: *capture failed (${message})*\n`;
          }
        }
        if (ec.afterScreenshot) {
          try {
            const p = path.join(os.tmpdir(), `pi-annotate-${timestamp}-after.png`);
            const buf = Buffer.from(ec.afterScreenshot.replace(/^data:image\/\w+;base64,/, ""), "base64");
            if (buf.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
            await fs.promises.writeFile(p, buf);
            output += `- After: ${p}\n`;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            output += `- After: *capture failed (${message})*\n`;
          }
        }
        output += "\n";
      }
    }
    
    return output;
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Tool Registration
  // ─────────────────────────────────────────────────────────────────────
  
  pi.registerTool({
    name: "annotate",
    label: "Annotate",
    description:
      "Open visual annotation mode in the browser so the user can click/select elements and add comments. " +
      "Only use when the user explicitly asks to annotate, visually point something out, or show you UI issues. " +
      "Returns structured annotations with CSS selectors and element info. " +
      "If no URL is provided, uses the current active browser tab.",
    promptSnippet:
      "Use only when the user explicitly asks for visual annotation or UI pointing. Call with {url?} and return selected element annotations.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({
        description: "URL to annotate. If omitted, uses the current browser tab.",
      })),
      timeout: Type.Optional(Type.Number({
        description: "Max seconds to wait for annotations. Default: 300 (5 min)",
      })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      currentCtx = ctx;
      const { url, timeout = 300 } = params as { url?: string; timeout?: number };
      const requestId = Date.now();

      // Try to connect first
      try {
        await connectToHost();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: "Browser extension not connected. Click the Pi Annotate icon in the browser to wake the service worker, then retry." }],
          details: { error: message },
        };
      }

      return new Promise((resolve) => {
        let timeoutId: NodeJS.Timeout | null = null;
        
        const cleanup = () => {
          if (timeoutId) clearTimeout(timeoutId);
          pendingRequests.delete(requestId);
          signal?.removeEventListener("abort", onAbort);
        };

        const onAbort = () => {
          cleanup();
          sendToHost({ type: "CANCEL", requestId, reason: "aborted" });
          resolve({
            content: [{ type: "text", text: "Annotation was aborted." }],
            details: { aborted: true },
          });
        };
        
        // Handle abort signal
        if (signal?.aborted) {
          return resolve({
            content: [{ type: "text", text: "Annotation was aborted." }],
            details: { aborted: true },
          });
        }
        signal?.addEventListener("abort", onAbort);
        
        // Set up response handler
        pendingRequests.set(requestId, async (result) => {
          cleanup();
          resolve({
            content: [{ type: "text", text: await formatResult(result) }],
            details: result,
          });
        });
        
        // Set timeout
        timeoutId = setTimeout(() => {
          cleanup();
          sendToHost({ type: "CANCEL", requestId, reason: "timeout" });
          resolve({
            content: [{ type: "text", text: `Annotation timed out after ${timeout}s` }],
            details: { timeout: true },
          });
        }, timeout * 1000);
        
        // Send start message
        sendToHost({
          type: "START_ANNOTATION",
          requestId,
          url,
        });
        
        if (ctx.hasUI) {
          ctx.ui.notify("Annotation mode started in the browser", "info");
        }
      });
    },
  });
}
