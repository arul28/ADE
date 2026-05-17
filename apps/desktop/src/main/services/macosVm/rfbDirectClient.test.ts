import { describe, expect, it } from "vitest";
import { isLikelyBlankRgbaFrame } from "./rfbDirectClient";

function rgbaFrame(width: number, height: number, fill: [number, number, number, number]): Buffer {
  const buffer = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < buffer.length; offset += 4) {
    buffer[offset] = fill[0];
    buffer[offset + 1] = fill[1];
    buffer[offset + 2] = fill[2];
    buffer[offset + 3] = fill[3];
  }
  return buffer;
}

describe("isLikelyBlankRgbaFrame", () => {
  it("treats all-black and transparent VNC frames as blank", () => {
    expect(isLikelyBlankRgbaFrame(64, 64, rgbaFrame(64, 64, [0, 0, 0, 255]))).toBe(true);
    expect(isLikelyBlankRgbaFrame(64, 64, rgbaFrame(64, 64, [0, 0, 0, 0]))).toBe(true);
  });

  it("still treats a black frame with only a tiny cursor-sized patch as blank", () => {
    const frame = rgbaFrame(320, 200, [0, 0, 0, 255]);
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        const offset = ((y * 320) + x) * 4;
        frame[offset] = 255;
        frame[offset + 1] = 255;
        frame[offset + 2] = 255;
        frame[offset + 3] = 255;
      }
    }

    expect(isLikelyBlankRgbaFrame(320, 200, frame)).toBe(true);
  });

  it("treats transparent black frames with only a noisy pixel as blank", () => {
    const frame = rgbaFrame(1440, 900, [0, 0, 0, 0]);
    frame[0] = 13;
    frame[1] = 14;
    frame[2] = 4;
    frame[3] = 255;

    expect(isLikelyBlankRgbaFrame(1440, 900, frame)).toBe(true);
  });

  it("keeps dark real content once enough non-black pixels are present", () => {
    const frame = rgbaFrame(320, 200, [0, 0, 0, 255]);
    for (let y = 20; y < 60; y += 1) {
      for (let x = 30; x < 220; x += 1) {
        const offset = ((y * 320) + x) * 4;
        frame[offset] = 18;
        frame[offset + 1] = 21;
        frame[offset + 2] = 27;
        frame[offset + 3] = 255;
      }
    }

    expect(isLikelyBlankRgbaFrame(320, 200, frame)).toBe(false);
  });
});
