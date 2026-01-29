import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AnnotationResult, ElementSelection } from "./types.js";

const SOCKET_PATH = "/tmp/pi-annotate.sock";
const TOKEN_PATH = "/tmp/pi-annotate.token";
const MAX_SOCKET_BUFFER = 8 * 1024 * 1024; // 8MB
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024; // 15MB

export default function (pi: ExtensionAPI) {
  let browserSocket: net.Socket | null = null;
  let pendingRequests = new Map<number, (result: AnnotationResult) => void | Promise<void>>();
  let dataBuffer = ""; // Buffer for incomplete JSON messages
  let authToken: string | null = null;
  let currentCtx: any = null; // Store current context for status updates
  
  // Status helper that uses ctx.ui.setStatus when available
  function setStatus(message: string) {
    if (currentCtx?.ui?.setStatus) {
      currentCtx.ui.setStatus("pi-annotate", message);
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // /annotate Command
  // ─────────────────────────────────────────────────────────────────────
  
  const annotateHandler = async (args: string, ctx: any) => {
    currentCtx = ctx; // Store for status updates
    const url = args.trim() || undefined;
    
    try {
      await connectToHost();
    } catch (err) {
      ctx.ui?.notify("Chrome extension not connected. Make sure Pi Annotate is installed.", "error");
      return;
    }
    
    // Send start message (no URL = use current tab)
    const requestId = Date.now();
    sendToHost({
      type: "START_ANNOTATION",
      requestId,
      url,
    });
    
    ctx.ui?.notify(url ? `Opening annotation mode on ${url}` : "Annotation mode started on current tab", "info");
  };

  pi.registerCommand("annotate", {
    description: "Start visual annotation mode in Chrome. Optionally provide a URL.",
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

      if (!authToken) {
        try {
          authToken = fs.readFileSync(TOKEN_PATH, "utf8").trim();
        } catch (err) {
          reject(new Error("Missing auth token; is the native host running?"));
          return;
        }
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
            void handleMessage(msg);
          } catch (e) {
            setStatus("Error: Failed to parse message");
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
        dataBuffer = ""; // Clear buffer on disconnect
        for (const [, resolvePending] of pendingRequests) {
          resolvePending({
            success: false,
            cancelled: true,
            reason: "connection_lost",
            elements: [],
            url: "",
            viewport: { width: 0, height: 0 },
          });
        }
        pendingRequests.clear();
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

  async function handleMessage(msg: any) {
    if (!isRecord(msg) || typeof msg.type !== "string") return;
    
    setStatus(`Received: ${msg.type}`);

    const requestId = typeof msg.requestId === "number" ? msg.requestId : null;

    if (msg.type === "SESSION_REPLACED") {
      // Another terminal took over the annotation session
      setStatus("Session replaced by another terminal");
      const reason = typeof msg.reason === "string" ? msg.reason : "Session replaced by another terminal";
      
      // Resolve all pending requests with cancelled status
      for (const [, resolvePending] of pendingRequests) {
        await resolvePending({
          success: false,
          cancelled: true,
          reason,
          elements: [],
          url: "",
          viewport: { width: 0, height: 0 },
        });
      }
      pendingRequests.clear();
      
      // Connection will be destroyed by native host, so clean up
      browserSocket = null;
      dataBuffer = "";
      return;
    }

    if (msg.type === "ANNOTATIONS_COMPLETE") {
      if (!isAnnotationResult(msg.result)) return;
      if (requestId && pendingRequests.has(requestId)) {
        // Tool flow - resolve the promise
        const resolvePending = pendingRequests.get(requestId) as (r: AnnotationResult) => void | Promise<void>;
        pendingRequests.delete(requestId);
        await resolvePending(msg.result);
      } else {
        // Command flow - inject as user message
        const result = msg.result as AnnotationResult;
        const text = await formatResult(result);
        setStatus("Annotation complete");
        pi.sendUserMessage(text);
      }
    } else if (msg.type === "CANCEL") {
      if (requestId && pendingRequests.has(requestId)) {
        const resolvePending = pendingRequests.get(requestId) as (r: AnnotationResult) => void | Promise<void>;
        pendingRequests.delete(requestId);
        await resolvePending({
          success: false,
          cancelled: true,
          reason: msg.reason || "user",
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
  
  async function formatResult(result: AnnotationResult): Promise<string> {
    if (!result.success) {
      if (result.cancelled) {
        // Provide meaningful message based on reason
        if (result.reason?.includes("Another terminal")) {
          return `Annotation session ended: ${result.reason}`;
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
          output += `- Element ${shot?.index ?? i + 1}: *capture failed*\n`;
        }
      }
      output += "\n";
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
      "Open visual annotation mode in Chrome so the user can click/select elements and add comments. " +
      "Only use when the user explicitly asks to annotate, visually point something out, or show you UI issues. " +
      "Returns structured annotations with CSS selectors and element info. " +
      "If no URL is provided, uses the current active Chrome tab.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({
        description: "URL to annotate. If omitted, uses current Chrome tab.",
      })),
      timeout: Type.Optional(Type.Number({
        description: "Max seconds to wait for annotations. Default: 300 (5 min)",
      })),
    }),

    async execute(_toolCallId, params, _onUpdate, ctx, signal) {
      currentCtx = ctx; // Store for status updates
      const { url, timeout = 300 } = params as { url?: string; timeout?: number };
      const requestId = Date.now();

      // Try to connect first
      try {
        await connectToHost();
      } catch (err) {
        return {
          content: [{ type: "text", text: "Failed to connect to Chrome extension. Make sure the Pi Annotate extension is installed and the native host is running." }],
          details: { error: "Connection failed" },
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
          ctx.ui.notify("Annotation mode started in Chrome", "info");
        }
      });
    },
  });
}
