// ─────────────────────────────────────────────────────────────────────
// Annotation types (from agentation)
// ─────────────────────────────────────────────────────────────────────

export interface Annotation {
  id: string;
  element: string;           // "Button 'Submit'" - human-readable name
  elementPath: string;       // "div.container > form > button" - CSS-like path
  comment: string;           // User's feedback
  timestamp: number;         // When annotation was created
  
  // Position
  x: number;                 // Percentage from left (0-100)
  y: number;                 // Pixels from top (absolute if isFixed, else document)
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  
  // Element info (optional - populated based on detail level)
  fullPath?: string;         // Full DOM path for forensic mode
  cssClasses?: string;       // ".btn .btn-primary"
  computedStyles?: string;   // Key CSS properties
  accessibility?: string;    // ARIA role, label, etc.
  nearbyText?: string;       // Text content and context
  nearbyElements?: string;   // Sibling elements for context
  selectedText?: string;     // If user selected text before annotating
  
  // Metadata
  isFixed?: boolean;         // True if element has fixed/sticky positioning
  isMultiSelect?: boolean;   // True if created via drag selection
}

export type DetailLevel = "compact" | "standard" | "detailed" | "forensic";

// Toolbar settings (from agentation)
export interface ToolbarSettings {
  outputDetail: DetailLevel;     // Detail level for output
  autoClearAfterCopy: boolean;   // Clear annotations after send
  annotationColor: string;       // Hex color for markers (default: #3c82f7)
  blockInteractions: boolean;    // Block page interactions while annotating
}

export const DEFAULT_TOOLBAR_SETTINGS: ToolbarSettings = {
  outputDetail: "standard",
  autoClearAfterCopy: false,
  annotationColor: "#3c82f7",
  blockInteractions: false,
};

// For toolbar demo mode (preserved from agentation)
export interface DemoAnnotation {
  selector: string;          // CSS selector to find the element
  comment: string;           // Demo annotation comment
  selectedText?: string;     // Optional selected text
}

export interface AnnotationResult {
  success: boolean;
  url: string;
  viewport: { width: number; height: number };
  annotations: Annotation[];
  detailLevel: DetailLevel;
  error?: string;
}

export interface AnnotationToolDetails {
  annotations?: Annotation[];
  url?: string;
  viewport?: { width: number; height: number };
  detailLevel?: DetailLevel;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Socket protocol types
// ─────────────────────────────────────────────────────────────────────

export type SocketMessage =
  // Pi → Chrome
  | { type: "START_ANNOTATION"; id?: number; url?: string }  // id present = tool (expects ANNOTATIONS_COMPLETE), id absent = command (expects USER_MESSAGE)
  | { type: "AGENT_RESPONSE"; content: string }
  | { type: "ERROR"; message: string }
  // Chrome → Pi  
  | { type: "ANNOTATIONS_COMPLETE"; requestId: number; result: AnnotationResult }
  | { type: "USER_MESSAGE"; content: string; url?: string; annotations?: Annotation[] }
  | { type: "END_CHAT" }
  // Chrome internal (not sent to Pi)
  | { type: "TOGGLE_TOOLBAR" };
