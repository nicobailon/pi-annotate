import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AnnotationResult, ElementSelection } from "./types.js";

const SOCKET_PATH = "/tmp/pi-annotate.sock";

export default function (pi: ExtensionAPI) {
  let browserSocket: net.Socket | null = null;
  let pendingResolve: ((result: AnnotationResult) => void) | null = null;
  let dataBuffer = ""; // Buffer for incomplete JSON messages
  
  // ─────────────────────────────────────────────────────────────────────
  // /annotate Command
  // ─────────────────────────────────────────────────────────────────────
  
  pi.registerCommand("annotate", {
    description: "Start visual annotation mode in Chrome. Optionally provide a URL.",
    handler: async (args, ctx) => {
      const url = args.trim() || undefined;
      
      try {
        await connectToHost();
      } catch (err) {
        ctx.ui?.notify("Chrome extension not connected. Make sure Pi Annotate is installed.", "error");
        return;
      }
      
      // Send start message (no URL = use current tab)
      sendToHost({
        type: "START_ANNOTATION",
        id: Date.now(),
        url,
      });
      
      ctx.ui?.notify(url ? `Opening annotation mode on ${url}` : "Annotation mode started on current tab", "info");
    },
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
      
      browserSocket = net.createConnection(SOCKET_PATH);
      
      browserSocket.on("connect", () => {
        console.log("[pi-annotate] Connected to native host");
        resolve();
      });
      
      browserSocket.on("data", (data) => {
        // Buffer incoming data and split by newlines
        dataBuffer += data.toString();
        const lines = dataBuffer.split("\n");
        
        // Keep the last incomplete line in the buffer
        dataBuffer = lines.pop() || "";
        
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            handleMessage(msg);
          } catch (e) {
            console.error("[pi-annotate] Parse error:", e, "Line length:", line.length);
          }
        }
      });
      
      browserSocket.on("error", (err) => {
        console.error("[pi-annotate] Socket error:", err.message);
        reject(err);
      });
      
      browserSocket.on("close", () => {
        console.log("[pi-annotate] Socket closed");
        browserSocket = null;
        dataBuffer = ""; // Clear buffer on disconnect
      });
    });
  }
  
  function sendToHost(msg: object) {
    if (browserSocket && !browserSocket.destroyed) {
      browserSocket.write(JSON.stringify(msg) + "\n");
    }
  }
  
  function handleMessage(msg: any) {
    console.log("[pi-annotate] Received:", msg.type);
    
    if (msg.type === "ANNOTATIONS_COMPLETE") {
      if (pendingResolve) {
        // Tool flow - resolve the promise
        pendingResolve(msg.result);
        pendingResolve = null;
      } else {
        // Command flow - inject as user message
        const result = msg.result as AnnotationResult;
        const text = formatResult(result);
        console.log("[pi-annotate] Injecting annotation result as user message");
        pi.sendUserMessage(text);
      }
    } else if (msg.type === "CANCEL") {
      if (pendingResolve) {
        pendingResolve({
          success: false,
          cancelled: true,
          reason: msg.reason || "user",
          elements: [],
          url: "",
          viewport: { width: 0, height: 0 },
        });
        pendingResolve = null;
      }
      // For command flow, cancel is just ignored (UI already closed)
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Format Result
  // ─────────────────────────────────────────────────────────────────────
  
  function formatResult(result: AnnotationResult): string {
    if (!result.success) {
      return result.cancelled 
        ? "Annotation cancelled by user."
        : `Annotation failed: ${result.reason || "Unknown error"}`;
    }
    
    let output = `## Page Annotation: ${result.url}\n`;
    output += `**Viewport:** ${result.viewport.width}×${result.viewport.height}\n\n`;
    
    if (result.prompt) {
      output += `**User's request:** ${result.prompt}\n\n`;
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
        output += `   - Size: ${el.rect.width}×${el.rect.height}px\n\n`;
      });
    } else {
      output += "*No elements selected*\n\n";
    }
    
    // Handle screenshots
    const timestamp = Date.now();
    
    if (result.screenshot) {
      // Full page screenshot
      try {
        const screenshotPath = path.join(os.tmpdir(), `pi-annotate-${timestamp}-full.png`);
        const base64Data = result.screenshot.replace(/^data:image\/\w+;base64,/, "");
        fs.writeFileSync(screenshotPath, Buffer.from(base64Data, "base64"));
        output += `**Screenshot (full page):** ${screenshotPath}\n`;
      } catch (err) {
        output += `*Screenshot capture failed: ${err}*\n`;
      }
    }
    
    if (result.screenshots && result.screenshots.length > 0) {
      // Individual element screenshots
      output += `### Screenshots\n\n`;
      for (const shot of result.screenshots) {
        try {
          const screenshotPath = path.join(os.tmpdir(), `pi-annotate-${timestamp}-el${shot.index}.png`);
          const base64Data = shot.dataUrl.replace(/^data:image\/\w+;base64,/, "");
          fs.writeFileSync(screenshotPath, Buffer.from(base64Data, "base64"));
          output += `- Element ${shot.index}: ${screenshotPath}\n`;
        } catch (err) {
          output += `- Element ${shot.index}: *capture failed*\n`;
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

    async execute(_toolCallId, params, _onUpdate, ctx) {
      const { url, timeout = 300 } = params as { url?: string; timeout?: number };

      return new Promise(async (resolve) => {
        let timeoutId: NodeJS.Timeout | null = null;
        
        const cleanup = () => {
          if (timeoutId) clearTimeout(timeoutId);
          pendingResolve = null;
        };
        
        try {
          await connectToHost();
        } catch (err) {
          resolve({
            content: [{ type: "text", text: "Failed to connect to Chrome extension. Make sure the Pi Annotate extension is installed and the native host is running." }],
            details: { error: "Connection failed" },
          });
          return;
        }
        
        // Set up response handler
        pendingResolve = (result) => {
          cleanup();
          resolve({
            content: [{ type: "text", text: formatResult(result) }],
            details: result,
          });
        };
        
        // Set timeout
        timeoutId = setTimeout(() => {
          cleanup();
          resolve({
            content: [{ type: "text", text: `Annotation timed out after ${timeout}s` }],
            details: { timeout: true },
          });
        }, timeout * 1000);
        
        // Send start message
        sendToHost({
          type: "START_ANNOTATION",
          id: Date.now(),
          url: url || undefined,
        });
        
        if (ctx.hasUI) {
          ctx.ui.notify("Annotation mode started in Chrome", "info");
        }
      });
    },
  });
}
