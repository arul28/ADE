/**
 * Turns a page action's CSS-pixel target into what a demo track event carries:
 * a point and a rect normalized to the recorded viewport, and a short label.
 *
 * Shared by the built-in browser and App Control, whose recordings are the
 * page's viewport (tab capture, CDP screencast), so CSS pixels over the
 * viewport's CSS size is the position in the recorded frame at any zoom or
 * device pixel ratio.
 */

import type { DemoRect, DemoTrackEvent, DemoTrackEventKind } from "../../../shared/demoVideo/demoContract";
import type { AgentElementSnapshot } from "../../../shared/types/agentObservation";
import { demoTrackRegistry } from "./demoTrackRegistry";

export type DemoViewportSize = { width: number; height: number };

/** Typed text shown in a video is cut to this; the registry caps labels further. */
const TYPED_LABEL_MAX = 40;

/**
 * Reads the viewport in an isolated world, so a page that redefines
 * `innerWidth` cannot move the overlays. Only asked while a recording runs.
 */
export const DEMO_VIEWPORT_ISOLATED_WORLD_ID = 1_071_117;
export const DEMO_VIEWPORT_SOURCE = "[window.innerWidth, window.innerHeight]";

export function parseDemoViewport(value: unknown): DemoViewportSize | null {
  if (!Array.isArray(value)) return null;
  const [width, height] = value;
  return typeof width === "number" && typeof height === "number" && width > 0 && height > 0
    ? { width, height }
    : null;
}

export function demoTrackTarget(
  viewport: DemoViewportSize | null,
  point: { x: number; y: number } | null,
  element: Pick<AgentElementSnapshot, "frame" | "center"> | null = null,
): Pick<DemoTrackEvent, "x" | "y" | "rect"> {
  if (!viewport) return {};
  const at = point ?? element?.center ?? null;
  const frame = element?.frame ?? null;
  const rect: DemoRect | null = frame && frame.width > 0 && frame.height > 0
    ? [frame.x / viewport.width, frame.y / viewport.height, frame.width / viewport.width, frame.height / viewport.height]
    : null;
  return {
    ...(at ? { x: at.x / viewport.width, y: at.y / viewport.height } : {}),
    ...(rect ? { rect } : {}),
  };
}

export type DemoPageActionTarget = {
  point?: { x: number; y: number } | null;
  element?: Pick<AgentElementSnapshot, "frame" | "center"> | null;
  label?: string;
  /** A drag's end, CSS pixels. */
  to?: { x: number; y: number } | null;
  /** How long the action will run on the screen (paced typing, a paced drag). */
  seconds?: number;
};

/**
 * A page action on a surface that is recording (the browser's tab, App
 * Control's page), for its demo track. Costs nothing when the surface is not
 * recording and never fails the action. The time is taken before the
 * viewport read, so it is when the action happened. True when the surface is
 * recording, so the caller can pace the action for the video.
 */
export async function noteDemoPageAction(args: {
  key: string;
  kind: DemoTrackEventKind;
  by: DemoTrackEvent["by"];
  target: DemoPageActionTarget;
  readViewport: () => Promise<DemoViewportSize | null>;
}): Promise<boolean> {
  if (!demoTrackRegistry.isRecording(args.key)) return false;
  const atMs = Date.now();
  const { target } = args;
  const viewport = target.point || target.element || target.to ? await args.readViewport().catch(() => null) : null;
  demoTrackRegistry.note(args.key, {
    kind: args.kind,
    by: args.by,
    atMs,
    ...demoTrackTarget(viewport, target.point ?? null, target.element ?? null),
    ...(viewport && target.to ? { to: [target.to.x / viewport.width, target.to.y / viewport.height] as [number, number] } : {}),
    ...(target.label ? { label: target.label } : {}),
    ...(target.seconds ? { seconds: target.seconds } : {}),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Pacing: what a viewer can follow
// ---------------------------------------------------------------------------

/** One keystroke's worth of time while a recording runs. */
const TYPING_STEP_MS = 45;
/** Long text goes in larger pieces, so no typing runs longer than about this. */
const TYPING_MAX_STEPS = 60;

/**
 * Text a recording will show as typed: the pieces to insert one after another
 * (single characters, or a few at a time for long text) and how long that
 * takes. Instant typing reads as a paste in a video.
 */
export function demoTypingPlan(text: string): { pieces: string[]; stepMs: number; seconds: number } {
  const characters = Array.from(text);
  const size = Math.max(1, Math.ceil(characters.length / TYPING_MAX_STEPS));
  const pieces: string[] = [];
  for (let index = 0; index < characters.length; index += size) pieces.push(characters.slice(index, index + size).join(""));
  return { pieces, stepMs: TYPING_STEP_MS, seconds: (pieces.length * TYPING_STEP_MS) / 1000 };
}

/**
 * The same pace for a surface whose driver types one character at a time
 * (Mac Desktop, Linux, Windows, the simulator): the pause between characters
 * while it records, and how long the text takes.
 */
export function demoTypingPace(text: string): { paceMs: number; seconds: number } {
  const length = Math.max(1, Array.from(text).length);
  const paceMs = Math.max(1, Math.min(TYPING_STEP_MS, Math.floor((TYPING_STEP_MS * TYPING_MAX_STEPS) / length)));
  return { paceMs, seconds: (length * paceMs) / 1000 };
}

/** Inserts the plan's pieces with its pauses between them. */
export async function typeDemoPieces(
  plan: { pieces: string[]; stepMs: number },
  insert: (piece: string) => Promise<unknown>,
): Promise<void> {
  for (const [index, piece] of plan.pieces.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, plan.stepMs));
    await insert(piece);
  }
}

/** A drag a viewer can follow: this many moves, this far apart. */
export const DEMO_DRAG_STEPS = 24;
export const DEMO_DRAG_STEP_MS = 25;
/** The pause after pressing, before moving: drag libraries wait for it too. */
export const DEMO_DRAG_PRESS_MS = 150;
export const DEMO_DRAG_SECONDS = (DEMO_DRAG_PRESS_MS + DEMO_DRAG_STEPS * DEMO_DRAG_STEP_MS) / 1000;

/** The element's name as a viewer would say it: "Save", "Email". */
export function demoElementLabel(element: Pick<AgentElementSnapshot, "label" | "text" | "placeholder" | "testId"> | null): string | undefined {
  const label = element?.label ?? element?.text ?? element?.placeholder ?? element?.testId ?? null;
  return label?.trim() ? label.trim() : undefined;
}

/** A field whose name says it holds a secret. Its typed text never reaches a video. */
const SENSITIVE_FIELD = /pass|secret|token|api.?key|otp|one.?time|2fa|mfa|pin\b|cvv|cvc|card|ssn/i;

/**
 * The typed text a video may show for a `type` event, or nothing. Only for a
 * field the action named and whose name does not suggest a secret: text typed
 * into whatever had focus, or into a password-like field, is left out, since
 * a demo is posted to a pull request.
 */
export function demoTypedLabel(
  text: string,
  element: Pick<AgentElementSnapshot, "label" | "text" | "placeholder" | "testId" | "selector"> | null,
): string | undefined {
  if (!element) return undefined;
  return demoTypedLabelForField(text, [element.label, element.placeholder, element.testId, element.selector, element.text]);
}

/**
 * The same rule for any surface: `fieldNames` are what the target field is
 * called (label, title, id, placeholder). No name, or a name that suggests a
 * secret, shows nothing.
 */
export function demoTypedLabelForField(text: string, fieldNames: ReadonlyArray<string | null | undefined>): string | undefined {
  const names = fieldNames.filter(Boolean).join(" ");
  if (!names.trim() || SENSITIVE_FIELD.test(names)) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > TYPED_LABEL_MAX ? `${flat.slice(0, TYPED_LABEL_MAX - 1)}…` : flat;
}

export function demoUrlHost(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}
