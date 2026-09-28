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

/**
 * A page action on a surface that is recording (the browser's tab, App
 * Control's page), for its demo track. Costs nothing when the surface is not
 * recording and never fails the action. The time is taken before the
 * viewport read, so it is when the action happened.
 */
export async function noteDemoPageAction(args: {
  key: string;
  kind: DemoTrackEventKind;
  by: DemoTrackEvent["by"];
  target: { point?: { x: number; y: number } | null; element?: Pick<AgentElementSnapshot, "frame" | "center"> | null; label?: string };
  readViewport: () => Promise<DemoViewportSize | null>;
}): Promise<void> {
  if (!demoTrackRegistry.isRecording(args.key)) return;
  const atMs = Date.now();
  const { target } = args;
  const viewport = target.point || target.element ? await args.readViewport().catch(() => null) : null;
  demoTrackRegistry.note(args.key, {
    kind: args.kind,
    by: args.by,
    atMs,
    ...demoTrackTarget(viewport, target.point ?? null, target.element ?? null),
    ...(target.label ? { label: target.label } : {}),
  });
}

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
