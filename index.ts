import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as net from "node:net";
import { generateOutput } from "./generate-output.js";
import type { Annotation, AnnotationResult, AnnotationToolDetails, SocketMessage } from "./types.js";

const SOCKET_PATH = "/tmp/pi-annotate.sock";

export default function (pi: ExtensionAPI) {
  // Active socket connection to browser (if any)
  let browserSocket: net.Socket | null = null;
  let socketBuffer = "";
  
  // Pending tool request (waiting for annotations)
  let pendingToolResolve: ((result: AnnotationResult) => void) | null = null;
  let pendingToolReject: ((error: Error) => void) | null = null;
  
  // ─────────────────────────────────────────────────────────────────────
  // Socket connection management
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
        socketBuffer += data.toString();
        processSocketBuffer();
      });
      
      browserSocket.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("Pi Annotate Chrome extension not running. Install and enable the extension, then try again."));
        } else {
          reject(err);
        }
      });
      
      browserSocket.on("close", () => {
        console.log("[pi-annotate] Socket closed");
        browserSocket = null;
        socketBuffer = "";
        
        // Reject pending tool if connection lost
        // Note: wrapper handles cleanup (clearing timeout and nulling refs)
        if (pendingToolReject) {
          pendingToolReject(new Error("Connection to browser lost"));
        }
      });
    });
  }
  
  function processSocketBuffer() {
    const lines = socketBuffer.split("\n");
    socketBuffer = lines.pop() || "";
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as SocketMessage;
        handleBrowserMessage(msg);
      } catch (e) {
        console.error("[pi-annotate] Parse error:", e);
      }
    }
  }
  
  function sendToHost(msg: SocketMessage) {
    if (browserSocket && !browserSocket.destroyed) {
      browserSocket.write(JSON.stringify(msg) + "\n");
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Handle incoming messages from browser
  // ─────────────────────────────────────────────────────────────────────
  
  function handleBrowserMessage(msg: SocketMessage) {
    switch (msg.type) {
      case "ANNOTATIONS_COMPLETE":
        // Tool response - resolve pending promise
        // Note: wrapper handles cleanup (clearing timeout and nulling refs)
        if (pendingToolResolve) {
          pendingToolResolve(msg.result);
        }
        break;
        
      case "USER_MESSAGE":
        // Browser-initiated chat message
        handleUserMessage(msg.content, msg.url, msg.annotations);
        break;
        
      case "END_CHAT":
        // User closed chat panel
        console.log("[pi-annotate] Chat ended by user");
        break;
    }
  }
  
  function handleUserMessage(content: string, url?: string, annotations?: Annotation[]) {
    // Format message with browser prefix and optional annotations
    let message = "[via browser]\n";
    if (annotations && annotations.length > 0) {
      const annotationMarkdown = generateOutput(
        annotations, 
        url || "[browser]", 
        "standard"
      );
      message += annotationMarkdown + "\n\n";
    }
    message += content;
    
    // Inject as user message - this triggers the agent
    pi.sendUserMessage(message);
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Forward agent responses to browser
  // ─────────────────────────────────────────────────────────────────────
  
  pi.on("turn_end", (event, _ctx) => {
    // Only forward if we have an active browser connection
    if (!browserSocket || browserSocket.destroyed) return;
    
    // Extract text content from assistant message
    const message = event.message;
    
    // Type guard: ensure this is an assistant message with content
    if (!("role" in message) || message.role !== "assistant") return;
    if (!("content" in message) || !Array.isArray(message.content)) return;
    
    let text = "";
    for (const block of message.content) {
      if (block.type === "text") {
        text += block.text;
      }
    }
    
    if (text) {
      sendToHost({ type: "AGENT_RESPONSE", content: text });
    }
  });
  
  // ─────────────────────────────────────────────────────────────────────
  // Annotate tool (LLM-invoked)
  // ─────────────────────────────────────────────────────────────────────
  
  pi.registerTool({
    name: "annotate",
    label: "Annotate",
    description: "Open visual annotation mode in Chrome so the user can click/select elements and add comments. Only use when the user explicitly asks to annotate, visually point something out, or show you UI issues. Returns structured annotations with CSS selectors and element info.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ 
        description: "URL to annotate. If omitted, uses current Chrome tab." 
      })),
      timeout: Type.Optional(Type.Number({ 
        description: "Max seconds to wait for annotations. Default: 300 (5 min)" 
      }))
    }),

    async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
      const { url, timeout = 300 } = params as { url?: string; timeout?: number };
      
      if (ctx.hasUI) {
        ctx.ui.notify("Opening annotation mode in Chrome...", "info");
      }
      
      try {
        // Connect to native host
        await connectToHost();
        
        // Create promise for tool response
        const result = await new Promise<AnnotationResult>((resolve, reject) => {
          // Set timeout
          const timeoutId = setTimeout(() => {
            pendingToolResolve = null;
            pendingToolReject = null;
            reject(new Error("Annotation timeout - user did not complete annotations"));
          }, timeout * 1000);
          
          // Wrap resolve/reject to always clear timeout
          pendingToolResolve = (result) => {
            clearTimeout(timeoutId);
            pendingToolResolve = null;
            pendingToolReject = null;
            resolve(result);
          };
          
          pendingToolReject = (error) => {
            clearTimeout(timeoutId);
            pendingToolResolve = null;
            pendingToolReject = null;
            reject(error);
          };
          
          // Send request to Chrome
          sendToHost({
            type: "START_ANNOTATION",
            id: Date.now(),
            url
          });
        });
        
        // Check for cancellation or error
        if (!result.success || result.error) {
          throw new Error(result.error || "Annotation cancelled");
        }
        
        return {
          content: [{ 
            type: "text", 
            text: generateOutput(result.annotations, result.url, result.detailLevel, result.viewport)
          }],
          details: {
            annotations: result.annotations,
            url: result.url,
            viewport: result.viewport,
            detailLevel: result.detailLevel,
          } satisfies AnnotationToolDetails,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Annotation failed: ${message}` }],
          details: { error: message },
        };
      }
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as AnnotationToolDetails | undefined;
      
      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }
      
      const count = details?.annotations?.length ?? 0;
      let text = theme.fg("success", `✓ ${count} annotation${count !== 1 ? "s" : ""} received`);
      
      if (!expanded && count > 0) {
        text += theme.fg("dim", ` (${keyHint("expandTools", "to expand")})`);
      }
      
      if (expanded && details?.annotations) {
        for (const a of details.annotations) {
          text += "\n  " + theme.fg("accent", `• ${a.element}`) + ": " + theme.fg("text", a.comment);
        }
      }
      
      return new Text(text, 0, 0);
    },
  });
  
  // ─────────────────────────────────────────────────────────────────────
  // Cleanup on shutdown
  // ─────────────────────────────────────────────────────────────────────
  
  pi.on("session_shutdown", () => {
    if (browserSocket && !browserSocket.destroyed) {
      browserSocket.destroy();
    }
  });
}
