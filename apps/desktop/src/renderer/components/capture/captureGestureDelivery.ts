import type { CaptureGestureShot } from "../../../shared/types/captureGesture";
import { isVoiceCallLive } from "../../../shared/types/ctoVoice";

/**
 * Where a capture goes once it reaches the renderer, and how it gets there.
 *
 * Pure and injectable so the routing decision — call versus composer, which
 * attachments to stage, what to do when the CTO session cannot be resolved —
 * is testable without a live chat, a live call, or a main process.
 */

/**
 * A call a capture can actually be dropped into.
 *
 * The phase list itself lives in `shared/types/ctoVoice` and is not repeated
 * here — a second copy of it was exactly the drift that helper was written to
 * end. What this adds is the identifier: a call with no id is one the main
 * process cannot address, whatever its phase says.
 */
export function isCallJoinable(
  state: { phase?: unknown; callId?: unknown } | null | undefined,
): boolean {
  const phase = typeof state?.phase === "string" ? state.phase : null;
  if (!isVoiceCallLive(phase)) return false;
  return typeof state?.callId === "string" && state.callId.length > 0;
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

