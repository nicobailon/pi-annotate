/** Element bounding rectangle in page coordinates */
export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Box model breakdown (content, padding, border, margin) */
export interface BoxModel {
  content: { width: number; height: number };
  padding: { top: number; right: number; bottom: number; left: number };
  border: { top: number; right: number; bottom: number; left: number };
  margin: { top: number; right: number; bottom: number; left: number };
}

/** Accessibility information for an element */
export interface AccessibilityInfo {
  /** ARIA role (explicit or implicit) */
  role: string | null;
  /** Computed accessible name */
  name: string | null;
  /** aria-describedby content */
  description: string | null;
  /** Whether element can receive focus */
  focusable: boolean;
  /** Whether element is disabled */
  disabled: boolean;
  /** aria-expanded state */
  expanded?: boolean;
  /** aria-pressed state */
  pressed?: boolean;
  /** Checked state (native or aria-checked) */
  checked?: boolean;
  /** Selected state (native or aria-selected) */
  selected?: boolean;
}

/** Parent element context for debugging layout issues */
export interface ParentContext {
  /** Parent tag name */
  tag: string;
  /** Parent ID if present */
  id?: string;
  /** Parent CSS classes */
  classes: string[];
  /** Layout-relevant computed styles */
  styles: Record<string, string>;
}

/** Information about a selected DOM element */
export interface ElementSelection {
  /** CSS selector that uniquely identifies this element */
  selector: string;
  /** HTML tag name (lowercase) */
  tag: string;
  /** Element ID if present */
  id: string | null;
  /** Array of CSS class names */
  classes: string[];
  /** Truncated text content */
  text: string;
  /** Bounding rectangle */
  rect: ElementRect;
  /** Selected HTML attributes */
  attributes: Record<string, string>;
  /** Per-element annotation comment */
  comment?: string;
  /** Box model breakdown (always captured) */
  boxModel?: BoxModel;
  /** Accessibility info (always captured) */
  accessibility?: AccessibilityInfo;
  /** Computed styles (debug mode only) */
  computedStyles?: Record<string, string>;
  /** Parent context (debug mode only) */
  parentContext?: ParentContext;
  /** CSS custom properties (debug mode only) */
  cssVariables?: Record<string, string>;
}

/** Screenshot cropped to a specific element */
export interface ElementScreenshot {
  /** 1-based index matching the element number */
  index: number;
  /** Base64 data URL of the cropped screenshot */
  dataUrl: string;
}

/** Viewport dimensions */
export interface Viewport {
  width: number;
  height: number;
}

/** Result returned from annotation session */
export interface AnnotationResult {
  /** Whether the annotation completed successfully */
  success: boolean;
  /** Selected elements with their metadata */
  elements?: ElementSelection[];
  /** Full page screenshot (when fullPage mode is enabled) */
  screenshot?: string;
  /** Individual element screenshots (default mode) */
  screenshots?: ElementScreenshot[];
  /** User's description of what should change */
  prompt?: string;
  /** URL of the annotated page */
  url?: string;
  /** Viewport dimensions at time of capture */
  viewport?: Viewport;
  /** True if user cancelled the annotation */
  cancelled?: boolean;
  /** True if annotation timed out */
  timeout?: boolean;
  /** Error or cancellation reason */
  reason?: string;
}
