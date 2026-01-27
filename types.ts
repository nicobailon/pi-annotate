export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementSelection {
  selector: string;
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  rect: ElementRect;
  attributes: Record<string, string>;
}

export interface ElementScreenshot {
  index: number;
  dataUrl: string;
}

export interface AnnotationResult {
  success: boolean;
  elements?: ElementSelection[];
  screenshot?: string; // Full page screenshot (if fullPage mode)
  screenshots?: ElementScreenshot[]; // Individual element screenshots
  prompt?: string;
  url?: string;
  viewport?: { width: number; height: number };
  cancelled?: boolean;
  timeout?: boolean;
  reason?: string;
}
