import { randomBytes, randomFillSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import {
  MAX_PROVIDER_INLINE_IMAGE_BYTES,
  PROVIDER_INLINE_IMAGE_TARGET_EDGE_PX,
} from "../../../shared/chatAttachmentLimits";
import { fitImageForProviderInline } from "./providerInlineImage";

function noisePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  randomFillSync(png.data);
  // Opaque pixels keep the source RGB, so the re-encode is not forced into RGBA.
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  return PNG.sync.write(png, { deflateLevel: 1 });
}

function solidPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 40;
    png.data[i + 1] = 90;
    png.data[i + 2] = 160;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function gradientJpeg(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      data[o] = Math.round((x / width) * 255);
      data[o + 1] = Math.round((y / height) * 255);
      data[o + 2] = 128;
      data[o + 3] = 255;
    }
  }
  return encodeJpeg({ width, height, data }, 90).data;
}

/** Inserts an APP1 Exif segment holding one Orientation tag right after SOI. */
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

function gifHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "latin1");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function vp8xWebp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8X", 12, "latin1");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

/** Random bytes that start with no image signature, so no codec recognises them. */
function undecodableBytes(size: number): Buffer {
  const bytes = randomBytes(size);
  bytes[0] = 0x00;
  return bytes;
}

/** Decodes the returned bytes with the codec their mediaType names. */
function decodedSize(fit: { data: Buffer; mediaType: string }): { width: number; height: number } {
  if (fit.mediaType === "image/png") {
    const png = PNG.sync.read(fit.data);
    return { width: png.width, height: png.height };
  }
  const jpeg = decodeJpeg(fit.data, { useTArray: true });
  return { width: jpeg.width, height: jpeg.height };
}

describe("fitImageForProviderInline", () => {
  it("re-encodes an oversized noisy PNG within the inline byte and edge limits and reports the resize", async () => {
    const source = noisePng(3000, 1900);
    expect(source.byteLength).toBeGreaterThan(MAX_PROVIDER_INLINE_IMAGE_BYTES);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const fit = await fitImageForProviderInline(source, "image/png", { provider: "claude", logger });

    expect(fit.kind).toBe("inline");
    if (fit.kind !== "inline") return;
    expect(fit.data.byteLength).toBeLessThanOrEqual(MAX_PROVIDER_INLINE_IMAGE_BYTES);
    expect(fit.data.toString("base64").length).toBeLessThanOrEqual(5_000_000);
    const decoded = decodedSize(fit);
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(PROVIDER_INLINE_IMAGE_TARGET_EDGE_PX);
    expect(fit.resized).toEqual({
      from: { bytes: source.byteLength, width: 3000, height: 1900 },
      to: { bytes: fit.data.byteLength, width: decoded.width, height: decoded.height },
    });
    expect(logger.info).toHaveBeenCalledWith("agent_chat.inline_image_resized", expect.objectContaining({ provider: "claude" }));
  });

  it.each([
    { label: "PNG", bytes: solidPng(64, 64), mediaType: "image/png" },
    { label: "WebP", bytes: vp8xWebp(100, 100), mediaType: "image/webp" },
  ])("passes a $label within the limits through as the same bytes, without a resize", async ({ bytes, mediaType }) => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    const fit = await fitImageForProviderInline(bytes, mediaType, { provider: "claude", logger });

    expect(fit.kind).toBe("inline");
    if (fit.kind !== "inline") return;
    expect(fit.data.equals(bytes)).toBe(true);
    expect(fit.mediaType).toBe(mediaType);
    expect(fit.resized).toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("downscales a small PNG whose long edge exceeds the 2000 px limit", async () => {
    const source = solidPng(2600, 100);
    expect(source.byteLength).toBeLessThan(MAX_PROVIDER_INLINE_IMAGE_BYTES);

    const fit = await fitImageForProviderInline(source, "image/png");

    expect(fit.kind).toBe("inline");
    if (fit.kind !== "inline") return;
    expect(fit.resized?.from).toEqual({ bytes: source.byteLength, width: 2600, height: 100 });
    const decoded = decodedSize(fit);
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(PROVIDER_INLINE_IMAGE_TARGET_EDGE_PX);
    expect(decoded.width).toBeGreaterThan(decoded.height);
  });

  it.each([
    { label: "GIF claiming 3000×3000", bytes: gifHeader(3000, 3000), mediaType: "image/gif" },
    { label: "WebP claiming 3000×3000", bytes: vp8xWebp(3000, 3000), mediaType: "image/webp" },
    { label: "undecodable bytes labelled PNG over the byte limit", bytes: undecodableBytes(MAX_PROVIDER_INLINE_IMAGE_BYTES + 1), mediaType: "image/png" },
  ])("omits $label with a reason and warns instead of throwing", async ({ bytes, mediaType }) => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    const fit = await fitImageForProviderInline(bytes, mediaType, { provider: "claude", logger });

    expect(fit.kind).toBe("omit");
    if (fit.kind !== "omit") return;
    expect(fit.reason).toMatch(/\S/);
    expect(logger.warn).toHaveBeenCalledWith("agent_chat.inline_image_omitted", expect.objectContaining({
      provider: "claude",
      bytes: bytes.byteLength,
    }));
  });

  it("decodes an oversized PNG labelled image/jpeg by its bytes, not its declared type", async () => {
    const source = solidPng(2400, 1200);

    const fit = await fitImageForProviderInline(source, "image/jpeg");

    expect(fit.kind).toBe("inline");
    if (fit.kind !== "inline") return;
    expect(fit.mediaType).toBe("image/png");
    expect(fit.resized).toBeDefined();
  });

  it("bakes an EXIF orientation of 6 into the pixels so a landscape JPEG comes out portrait", async () => {
    const source = withExifOrientation(gradientJpeg(2400, 1200), 6);

    const fit = await fitImageForProviderInline(source, "image/jpeg");

    expect(fit.kind).toBe("inline");
    if (fit.kind !== "inline") return;
    const decoded = decodedSize(fit);
    expect(decoded.height).toBeGreaterThan(decoded.width);
  });
});
