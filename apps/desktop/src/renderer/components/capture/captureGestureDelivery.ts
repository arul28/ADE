import type { CaptureGestureShot } from "../../../shared/types/captureGesture";

/**
 * Where a capture goes once it reaches the renderer, and how it gets there.
 *
 * Pure and injectable so the decision of which attachments to stage is
 * testable without a live chat or a main process.
 */

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
