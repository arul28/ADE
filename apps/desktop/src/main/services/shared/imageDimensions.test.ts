import { describe, expect, it } from "vitest";
import { imageDimensions, jpegDimensions, pngDimensions } from "./imageDimensions";

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

  it("reads JPEG dimensions", () => {
    const buffer = makeJpeg(640, 480);

    expect(jpegDimensions(buffer)).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(buffer)).toEqual({ width: 640, height: 480 });
  });

  it("returns null for unknown image data", () => {
    expect(imageDimensions(Buffer.from("not an image"))).toBeNull();
  });
});
