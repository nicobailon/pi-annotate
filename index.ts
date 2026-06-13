import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AnnotationResult, ElementSelection, EditCapture } from "./types.js";
import type { HostConnectionOptions } from "./host-connection.ts";
import { createHostConnectionManager } from "./host-connection.ts";
import type { AnnotationContext } from "./annotation-run.ts";
import { createAnnotationRunManager } from "./annotation-run.ts";

const SOCKET_PATH = "/tmp/pi-annotate.sock";
const TOKEN_PATH = "/tmp/pi-annotate.token";
const MAX_SOCKET_BUFFER = 32 * 1024 * 1024; // 32MB (increased from 8MB for edit capture payloads)
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024; // 15MB

export default function (pi: ExtensionAPI) {
  let currentCtx: AnnotationContext | null = null;
  
  function setStatus(message: string) {
    if (currentCtx?.ui?.setStatus) {
      currentCtx.ui.setStatus("pi-annotate", message);
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────
  // Socket Connection
  // ─────────────────────────────────────────────────────────────────────
  
  const hostConnection = createHostConnectionManager({
    defaultSocketPath: SOCKET_PATH,
    defaultTokenPath: TOKEN_PATH,
    maxSocketBuffer: MAX_SOCKET_BUFFER,
    onStatus: setStatus,
    onMessage: (message) => annotationRuns.handleHostMessage(message),
    onConnectionLost: () => annotationRuns.handleConnectionLost(),
  });

  function connectToHost(options: HostConnectionOptions = {}): Promise<void> {
    return hostConnection.connect(options);
  }
  
  function sendToHost(msg: object) {
    hostConnection.send(msg);
  }

  function sendToHostAndFlush(msg: object): Promise<void> {
    return hostConnection.sendAndFlush(msg);
  }

  const annotationRuns = createAnnotationRunManager({
    connectToHost,
    sendToHost,
    sendToHostAndFlush,
    formatResult,
    sendUserMessage: (message) => pi.sendUserMessage(message),
    setStatus,
  });

  // ─────────────────────────────────────────────────────────────────────
  // /annotate Command
  // ─────────────────────────────────────────────────────────────────────
  
  const annotateHandler = async (args: string, ctx: AnnotationContext) => {
    currentCtx = ctx;
    await annotationRuns.startCommand(args, ctx);
  };

  pi.registerCommand("annotate", {
    description: "Start visual annotation mode in the browser. Optionally provide a URL.",
    handler: annotateHandler,
  });
  
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
      "Use only when the user explicitly asks for visual annotation or UI pointing. Call with {url?, browserHost?} and return selected element annotations.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({
        description: "URL to annotate. If omitted, uses the current browser tab.",
      })),
      browserHost: Type.Optional(Type.String({
        description: "SSH host alias for the Browser Host. If omitted, uses the same-machine browser.",
      })),
      timeout: Type.Optional(Type.Number({
        description: "Max seconds to wait for annotations. Default: 300 (5 min)",
      })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      currentCtx = ctx;
      return annotationRuns.startTool(params as { url?: string; browserHost?: string; timeout?: number }, signal, ctx);
    },
  });
}
