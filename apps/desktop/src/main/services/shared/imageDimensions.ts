export type ImageDimensions = {
  width: number;
  height: number;
};

export function pngDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 24) return null;
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, pngSignature.length).equals(pngSignature)) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

export function jpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    const isStartOfFrame =
      marker >= 0xc0
      && marker <= 0xcf
      && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

export function imageDimensions(buffer: Buffer): ImageDimensions | null {
  return pngDimensions(buffer) ?? jpegDimensions(buffer);
}

/** Base64 characters decoded first: 3 KB of image, past a typical JPEG's frame header. */
const BASE64_DIMENSIONS_PREFIX_CHARS = 4096;

/**
 * The dimensions of a base64-encoded image, read from its header. A screencast
 * frame is ~300 KB of base64 arriving dozens of times a second; decoding all
 * of it to read four bytes made a 200 KB buffer per frame. The whole image is
 * decoded only when the header is not in the first few kilobytes.
 */
export function base64ImageDimensions(data: string): ImageDimensions | null {
  if (data.length > BASE64_DIMENSIONS_PREFIX_CHARS) {
    const head = imageDimensions(Buffer.from(data.slice(0, BASE64_DIMENSIONS_PREFIX_CHARS), "base64"));
    if (head) return head;
  }
  return imageDimensions(Buffer.from(data, "base64"));
}
