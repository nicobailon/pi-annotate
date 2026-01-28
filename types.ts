/** Element bounding rectangle in page coordinates */
export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
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
