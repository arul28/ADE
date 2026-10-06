import { SCENE_FALLBACK_THEME, SCENE_LIMITS, type SceneTheme } from "./chatScene";

/**
 * `ade scene preview`: render a scene the way a chat will, before it goes in a
 * reply, and see what broke.
 *
 * The agent writes the scene to a file, previews it, reads the screenshot and
 * the problems, fixes, and only then puts the fence in its answer. The render
 * is the chat's own: the same document builder, SDK, policy and sandbox, in a
 * hidden desktop window with an in-memory profile, so nothing the agent wrote
 * can reach the user's sessions.
 */

export type ScenePreviewTheme = "dark" | "light";

export type ScenePreviewRequest = {
  /** The scene: a fence body, a whole ```scene fence, or a bare HTML document. */
  source: string;
  /** Frame width in CSS px. A chat's reply column is about 720. */
  width?: number;
  theme?: ScenePreviewTheme;
  /**
   * The live-data snapshot for a scene that asked for `data=` (built by the
   * brain with `sceneDataProjection.ts`, as the chat would send it), posted
   * into the frame once it is up. Absent: the scene previews with no data.
   */
  data?: unknown;
};

export type ScenePreviewProblem = {
  kind: "error" | "console" | "policy" | "lint" | "timeout";
  message: string;
};

export type ScenePreviewResult = {
  title: string | null;
  /** The frame width the scene was drawn at. */
  width: number;
  /** The height the scene asked for; the chat clamps it to 120–960. */
  height: number;
  /** ms from load to `ready`, null when it never said so. */
  readyMs: number | null;
  /** ms from load to settled (its entrance played out), null when it never settled. */
  settledMs: number | null;
  /** PNG of the drawn scene, base64. Null when nothing could be captured. */
  screenshotBase64: string | null;
  problems: ScenePreviewProblem[];
};

export const SCENE_PREVIEW_WIDTH = { default: 720, min: 320, max: 1600 } as const;

/**
 * The most source a preview accepts. Room for a whole fence pasted around a
 * scene at the chat's own cap (`SCENE_LIMITS.maxSourceBytes`), so an over-cap
 * scene is still previewed and reported as over the cap rather than refused.
 */
export const SCENE_PREVIEW_MAX_SOURCE_BYTES = 400_000;

/** ADE's light palette (`[data-theme="light"]` in index.css), for previews only. */
export const SCENE_PREVIEW_LIGHT_THEME: SceneTheme = {
  bg: "#f5f3f0",
  surface: "color-mix(in srgb, #1a1a1e 4%, transparent)",
  border: "#d6d3ce",
  fg: "#1a1a1e",
  fgMuted: "#636370",
  accent: "#049068",
  success: "#16a34a",
  warning: "#d97706",
  danger: "#dc2626",
  fontSans: SCENE_FALLBACK_THEME.fontSans,
  fontMono: SCENE_FALLBACK_THEME.fontMono,
  scheme: "light",
  fontSize: SCENE_FALLBACK_THEME.fontSize,
};

export function scenePreviewTheme(theme: ScenePreviewTheme | undefined): SceneTheme {
  return theme === "light" ? SCENE_PREVIEW_LIGHT_THEME : SCENE_FALLBACK_THEME;
}

/**
 * The fence body out of whatever the agent handed over: a bare body, or a
 * whole ```scene fence copied from a draft reply.
 */
export function sceneSourceFromInput(input: string): string {
  const text = String(input ?? "");
  const fenced = /^\s*(`{3,}|~{3,})\s*scene\b[^\n]*\n([\s\S]*?)\n\s*\1\s*$/i.exec(text);
  return fenced ? fenced[2]! : text;
}

/**
 * Mistakes a scene makes that its policy turns into silent blanks, found by
 * reading the source. Each line says what to do instead.
 */
export function lintSceneSource(source: string): ScenePreviewProblem[] {
  const problems: ScenePreviewProblem[] = [];
  const add = (message: string) => problems.push({ kind: "lint", message });
  if (/<script\b[^>]*\bsrc\s*=/i.test(source)) {
    add("A <script src> never loads: a scene has no network. Inline the code.");
  }
  if (/\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(source) || /url\(\s*["']?\s*(?:https?:)?\/\//i.test(source)) {
    add("Remote URLs (images, fonts, stylesheets) are blocked. Inline images as data: URLs.");
  }
  if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bEventSource\b/.test(source)) {
    add("fetch / XHR / WebSocket are blocked in a scene. Put the data in the markup, or ask for live ADE data with data=\"lanes,sessions,prs\" on the marker line.");
  }
  if (/\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie/.test(source)) {
    add("Storage and cookies throw in a sandboxed scene. Keep state in variables.");
  }
  if (/\b(?:alert|confirm|prompt)\s*\(/.test(source)) {
    add("alert/confirm/prompt are blocked. A scene shows; it never asks (use a mosaic card to ask).");
  }
  // `var` anywhere in a top-level script is global; let/const only at the top.
  const shadow = /\bvar\s+(top|parent|opener|frames|self)\b/.exec(source)
    ?? /^\s*(?:let|const)\s+(top|parent|opener|frames|self)\b/m.exec(source);
  if (shadow) {
    add(`A global named "${shadow[1]}" is the window's own ${shadow[1]} in a scene, and touching it throws in the sandbox. Rename the variable.`);
  }
  if (/<(?:iframe|object|embed)\b/i.test(source)) {
    add("Nested frames and plugins are blocked.");
  }
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > SCENE_LIMITS.maxSourceBytes) {
    add(`The scene is ${bytes} bytes; over ${SCENE_LIMITS.maxSourceBytes} the chat shows it as code, not a view.`);
  } else if (bytes > SCENE_LIMITS.maxSourceBytes * 0.8) {
    add(`The scene is ${bytes} bytes, near the ${SCENE_LIMITS.maxSourceBytes}-byte cap.`);
  }
  return problems;
}
