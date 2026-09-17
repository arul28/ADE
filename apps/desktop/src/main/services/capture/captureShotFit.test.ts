import { describe, expect, it } from "vitest";

import {
  fitCaptureShotToAttachmentLimit,
  MAX_CAPTURE_SHOT_HALVINGS,
  type CaptureShotImage,
} from "./captureShotFit";
import type { CaptureGestureShot } from "../../../shared/types/captureGesture";

/**
 * A fake image whose PNG size is proportional to its area, which is the only
 * property the loop reasons about. `resize` halves the width and the fake
 * halves the height with it, exactly as Electron's aspect-preserving resize
 * does — so one halving is a quarter of the bytes.
 */
function fakeImage(width: number, height: number, bytesPerPixel = 1): CaptureShotImage {
  return {
    getSize: () => ({ width, height }),
    resize: ({ width: nextWidth }) =>
      fakeImage(nextWidth, Math.max(1, Math.floor((height * nextWidth) / width)), bytesPerPixel),
    toPNG: () => Buffer.alloc(width * height * bytesPerPixel, 1),
  };
}

function shotOf(bytes: number): CaptureGestureShot {
  return {
    pngBase64: Buffer.alloc(bytes, 1).toString("base64"),
    source: "chord",
  } as CaptureGestureShot;
}

describe("fitCaptureShotToAttachmentLimit", () => {
  it("passes a shot that already fits through untouched", () => {
    const shot = shotOf(100);
    expect(fitCaptureShotToAttachmentLimit(shot, { fromBuffer: () => fakeImage(10, 10) }, 1_000)).toBe(shot);
  });

  it("halves until it fits and keeps the rest of the shot", () => {
    // 64×64 = 4096 bytes against a 1000-byte ceiling: two halvings (1024, 256).
    const shot = shotOf(4096);
    const fitted = fitCaptureShotToAttachmentLimit(
      shot,
      { fromBuffer: () => fakeImage(64, 64) },
      1_000,
    );
    expect(fitted).not.toBeNull();
    expect(Buffer.from(fitted!.pngBase64, "base64").byteLength).toBe(256);
    expect(fitted!.source).toBe("chord");
  });

  /**
   * The refusal is the point: a shot that reached the composer and then failed
   * to stage made the gesture silently do nothing, so the loop has to end in a
   * `too_large` the user can be told about rather than in a bad attachment.
   */
  it("gives up after MAX_CAPTURE_SHOT_HALVINGS halvings rather than shrinking forever", () => {
    let resizes = 0;
    const image = (width: number, height: number): CaptureShotImage => ({
      getSize: () => ({ width, height }),
      resize: ({ width: nextWidth }) => {
        resizes += 1;
        return image(nextWidth, Math.max(1, Math.floor((height * nextWidth) / width)));
      },
      toPNG: () => Buffer.alloc(width * height, 1),
    });
    // 4096×4096 against 1000 bytes never fits inside the allowed halvings.
    expect(
      fitCaptureShotToAttachmentLimit(shotOf(4096 * 4096), { fromBuffer: () => image(4096, 4096) }, 1_000),
    ).toBeNull();
    expect(resizes).toBe(MAX_CAPTURE_SHOT_HALVINGS);
  });

  it("stops rather than dividing a one-pixel image", () => {
    expect(
      fitCaptureShotToAttachmentLimit(shotOf(50), { fromBuffer: () => fakeImage(1, 1, 50) }, 10),
    ).toBeNull();
  });
});
