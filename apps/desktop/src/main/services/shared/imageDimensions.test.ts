import { describe, expect, it } from "vitest";
import { base64ImageDimensions, imageDimensions, jpegDimensions, pngDimensions } from "./imageDimensions";

function makePng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.write("\x89PNG\r\n\x1a\n", 0, "binary");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function makeJpeg(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(21);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

describe("imageDimensions", () => {
  it("reads PNG dimensions", () => {
    const buffer = makePng(1200, 800);

    expect(pngDimensions(buffer)).toEqual({ width: 1200, height: 800 });
    expect(imageDimensions(buffer)).toEqual({ width: 1200, height: 800 });
  });

  it("rejects incomplete PNG signatures", () => {
    const buffer = makePng(1200, 800);
    buffer[0] = 0x00;

    expect(pngDimensions(buffer)).toBeNull();
  });

  it("reads JPEG dimensions", () => {
    const buffer = makeJpeg(640, 480);

    expect(jpegDimensions(buffer)).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(buffer)).toEqual({ width: 640, height: 480 });
  });

  it("returns null for unknown image data", () => {
    expect(imageDimensions(Buffer.from("not an image"))).toBeNull();
  });

  /** A JPEG whose frame header sits after an APP1 segment of `appBytes` bytes. */
  function jpegAfterAppSegment(width: number, height: number, appBytes: number): Buffer {
    const app = Buffer.alloc(4 + appBytes);
    app[0] = 0xff;
    app[1] = 0xe1;
    app.writeUInt16BE(appBytes + 2, 2);
    const jpeg = makeJpeg(width, height);
    return Buffer.concat([jpeg.subarray(0, 2), app, jpeg.subarray(2)]);
  }

  it.each([
    ["a JPEG with a large body", Buffer.concat([makeJpeg(1600, 913), Buffer.alloc(200_000, 7)]), { width: 1600, height: 913 }],
    ["a JPEG whose header lies past the first few kilobytes", jpegAfterAppSegment(1280, 720, 8_000), { width: 1280, height: 720 }],
    ["a PNG", Buffer.concat([makePng(390, 844), Buffer.alloc(50_000, 1)]), { width: 390, height: 844 }],
  ])("reads base64 dimensions of %s the same as a full decode", (_label, image, expected) => {
    const encoded = image.toString("base64");
    expect(base64ImageDimensions(encoded)).toEqual(expected);
    expect(base64ImageDimensions(encoded)).toEqual(imageDimensions(image));
    expect(encoded.length).toBeGreaterThan(4096);
  });
});

