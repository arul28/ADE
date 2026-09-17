import { LEGACY_MAX_CHAT_ATTACHMENT_BYTES } from "../../../shared/chatAttachmentLimits";
import type { CaptureGestureShot } from "../../../shared/types/captureGesture";

/**
 * The two Electron image operations this needs, injected.
 *
 * `nativeImage` is the only reason the downscale loop would otherwise have to
 * live in `main.ts`; behind these two calls the arithmetic is ordinary and can
 * be tested with a fake that halves a number.
 */
export type CaptureShotImageOps = {
  fromBuffer: (bytes: Buffer) => CaptureShotImage;
};

export type CaptureShotImage = {
  getSize: () => { width: number; height: number };
  resize: (options: { width: number; quality?: "good" | "better" | "best" }) => CaptureShotImage;
  toPNG: () => Buffer;
};

/** How many halvings a shot gets before it is refused. */
export const MAX_CAPTURE_SHOT_HALVINGS = 4;

/**
 * Shrink a shot until it fits the base64 attachment ceiling.
 *
 * The capture helper's own cap is generous (a 6K display is ~10 MB of PNG and a
 * multi-monitor grab can be far more), but `saveTempAttachment` moves the bytes
 * as base64 inside a command payload and rejects anything over
 * {@link LEGACY_MAX_CHAT_ATTACHMENT_BYTES}. Left alone, a big display's capture
 * reached the composer and then failed to stage, so the gesture silently did
 * nothing. Downscaling keeps the shot — a half-size screenshot is still a
 * perfectly readable screenshot — and only a shot that will not fit after four
 * halvings fails, with a message that says why.
 *
 * Returns null when it cannot be made to fit.
 */
export function fitCaptureShotToAttachmentLimit(
  shot: CaptureGestureShot,
  ops: CaptureShotImageOps,
  maxBytes: number = LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
): CaptureGestureShot | null {
  let bytes: Buffer = Buffer.from(shot.pngBase64, "base64");
  if (bytes.byteLength <= maxBytes) return shot;
  let image = ops.fromBuffer(bytes);
  for (let attempt = 0; attempt < MAX_CAPTURE_SHOT_HALVINGS; attempt += 1) {
    const size = image.getSize();
    if (size.width < 2 || size.height < 2) break;
    // Width only: `resize` preserves the aspect ratio when just one dimension
    // is given, so the shot never stretches.
    image = image.resize({ width: Math.max(1, Math.floor(size.width / 2)), quality: "good" });
    bytes = image.toPNG();
    if (!bytes.byteLength) break;
    if (bytes.byteLength <= maxBytes) {
      return { ...shot, pngBase64: bytes.toString("base64") };
    }
  }
  return null;
}
