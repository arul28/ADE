import { describe, expect, it } from "vitest";
import { encodeClipboardImageWithinCap } from "./clipboardImageEncoding";

const MB = 1024 * 1024;

/** An encoded buffer of `byteLength` bytes; only its size matters here. */
const encodedOfSize = (byteLength: number) => ({ byteLength }) as unknown as Buffer;

/**
 * Stands in for Electron's `NativeImage` (the process boundary): encoded sizes
 * scale with the pixel count, the way a photo's do, so shrinking the long edge
 * shrinks the output.
 */
function fakeImage(width: number, height: number, bytesPerPixel: { png: number; jpeg: number }) {
  const image = {
    getSize: () => ({ width, height }),
    toPNG: () => encodedOfSize(Math.round(width * height * bytesPerPixel.png)),
    toJPEG: (_quality: number) => encodedOfSize(Math.round(width * height * bytesPerPixel.jpeg)),
    resize: (options: { width?: number; height?: number }) => {
      const scale = options.width != null ? options.width / width : (options.height ?? height) / height;
      return fakeImage(Math.round(width * scale), Math.round(height * scale), bytesPerPixel);
    },
  };
  return image;
}

describe("encodeClipboardImageWithinCap", () => {
  it.each([
    {
      name: "a screenshot that fits stays PNG at full size",
      image: fakeImage(2880, 1800, { png: 0.9, jpeg: 0.4 }),
      expected: { mimeType: "image/png", filename: "clipboard.png", maxBytes: 10 * MB },
    },
    {
      name: "a photo too big as PNG becomes a JPEG at full size",
      image: fakeImage(4032, 3024, { png: 1.5, jpeg: 0.6 }),
      expected: { mimeType: "image/jpeg", filename: "clipboard.jpg", maxBytes: 10 * MB },
    },
    {
      name: "a photo too big even as a full-size JPEG is shrunk until it fits",
      image: fakeImage(8000, 6000, { png: 1.5, jpeg: 0.6 }),
      expected: { mimeType: "image/jpeg", filename: "clipboard.jpg", maxBytes: 10 * MB },
    },
  ])("$name", ({ image, expected }) => {
    const encoded = encodeClipboardImageWithinCap(image, expected.maxBytes);
    expect(encoded).not.toBeNull();
    expect(encoded!.mimeType).toBe(expected.mimeType);
    expect(encoded!.filename).toBe(expected.filename);
    expect(encoded!.data.byteLength).toBeGreaterThan(0);
    expect(encoded!.data.byteLength).toBeLessThanOrEqual(expected.maxBytes);
  });

  it("gives up instead of shrinking to nothing when even the smallest JPEG is too big", () => {
    // 3 bytes per pixel as JPEG: a 768px edge is still ~1.3 MB, over a 1 MB cap.
    const image = fakeImage(4000, 3000, { png: 4, jpeg: 3 });
    const encoded = encodeClipboardImageWithinCap(image, 1 * MB);
    expect(encoded).toBeNull();
    // A cap the smallest attempt does fit still succeeds, so the floor is a
    // floor and not an off-by-one that refuses everything.
    const fits = encodeClipboardImageWithinCap(image, 2 * MB);
    expect(fits?.mimeType).toBe("image/jpeg");
    expect(fits!.data.byteLength).toBeLessThanOrEqual(2 * MB);
  });
});
