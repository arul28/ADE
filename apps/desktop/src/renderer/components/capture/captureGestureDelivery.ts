import type { CaptureGestureShot } from "../../../shared/types/captureGesture";

/**
 * Where a capture goes once it reaches the renderer, and how it gets there.
 *
 * Pure and injectable so the routing decision — call versus composer, which
 * attachments to stage, what to do when the CTO session cannot be resolved —
 * is testable without a live chat, a live call, or a main process.
 */

/**
 * A CTO voice call that is *actually* on air.
 *
 * `phase` is the only honest signal: `callId` is set during `connecting` and
 * survives into `ended`, so keying off it would route a capture into a call
 * that has hung up. The three terminal/absent phases are excluded by name so a
 * phase added later defaults to "live" rather than silently dropping captures.
 */
export function isVoiceCallLive(
  state: { phase?: unknown; callId?: unknown } | null | undefined,
): boolean {
  const phase = typeof state?.phase === "string" ? state.phase : "idle";
  if (phase === "idle" || phase === "ended" || phase === "failed") return false;
  return typeof state?.callId === "string" && state.callId.length > 0;
}

export type CaptureDeliveryTarget =
  /** A call is live: the shot is spoken about, not filed. */
  | { kind: "voice-call" }
  /** No call: stage attachments on the CTO composer. */
  | { kind: "composer" };

export function resolveCaptureDeliveryTarget(input: {
  voiceBridgePresent: boolean;
  voiceCallLive: boolean;
}): CaptureDeliveryTarget {
  // A live call requires the bridge, so the second condition is not redundant
  // defence — it is what makes the browser preview (no bridge at all) resolve
  // to the composer instead of asking a bridge that does not exist.
  return input.voiceBridgePresent && input.voiceCallLive
    ? { kind: "voice-call" }
    : { kind: "composer" };
}

export type CaptureAttachmentPlan = {
  /** Base64 PNG plus the name it is staged under. */
  image: { data: string; filename: string };
  /**
   * The structured view-state note, present only for captures of ADE's own
   * window. Over another app's window ADE knows nothing to say.
   */
  context: { data: string; filename: string } | null;
};

/**
 * What to stage for one shot.
 *
 * `contextMarkdown` is base64-encoded here rather than by the caller because
 * `saveTempAttachment` takes base64 for both attachments and mixing "one is
 * text, one is base64" across two call sites is how the note ends up on disk
 * double-encoded.
 */
export function planCaptureAttachments(
  shot: CaptureGestureShot,
  contextMarkdown: string | null,
  encodeBase64: (value: string) => string,
): CaptureAttachmentPlan {
  const stem = shot.filename.replace(/\.png$/i, "");
  return {
    image: { data: shot.pngBase64, filename: shot.filename },
    context: shot.isAdeWindow && contextMarkdown
      ? { data: encodeBase64(contextMarkdown), filename: `${stem}-context.md` }
      : null,
  };
}

/**
 * The one-line note that travels with the image into the composer.
 *
 * Names the app by title when the OS gave us one, because "a screenshot" with
 * no provenance is the single least useful thing to hand an agent.
 */
export function describeShot(shot: CaptureGestureShot): string {
  const app = shot.appName?.trim();
  const title = shot.windowTitle?.trim();
  if (shot.isAdeWindow) return "Screenshot of ADE";
  if (app && title) return `Screenshot of ${app} — ${title}`;
  if (app) return `Screenshot of ${app}`;
  if (title) return `Screenshot of ${title}`;
  return "Screenshot of the window in front";
}

/** UTF-8 safe base64 for the markdown note. `btoa` alone throws above U+00FF. */
export function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
