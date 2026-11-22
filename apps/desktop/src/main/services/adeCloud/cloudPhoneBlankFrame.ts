import zlib from "node:zlib";

/*
 * A cloud iPhone screenshot taken while an app is still drawing its first
 * frame (a link opened on a new phone, a first launch) comes back all black.
 * The screenshot is taken again a moment later rather than filed as proof.
 *
 * This reads NoMac's PNGs only: 8-bit RGB or RGBA, not interlaced. Anything
 * else answers "not blank", so an unknown picture is always kept.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A pixel this dark in every channel counts as black. */
const DARK = 16;
/** Blank: this share of the sampled pixels is black. */
const BLANK_SHARE = 0.995;
/** Every 4th pixel of every 4th row is sampled; every row is still unfiltered (each depends on the one above). */
const SAMPLE = 4;
/** A phone screenshot is a few thousand pixels a side; anything larger isn't read. */
const MAX_SIDE = 10_000;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Whether a PNG is (almost) all black. False for anything it can't read. */
export function pngLooksBlank(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) return false;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      if (body.length < 13) return false;
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return false;
      if (width > MAX_SIDE || height > MAX_SIDE) return false;
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || !channels || !data.length) return false;
  const stride = width * channels;
  let raw: Buffer;
  try {
    // Never more than the picture's own rows: a compressed bomb throws here.
    raw = zlib.inflateSync(Buffer.concat(data), { maxOutputLength: height * (stride + 1) });
  } catch {
    return false;
  }
  if (raw.length < height * (stride + 1)) return false;
  let previous = Buffer.alloc(stride);
  let current = Buffer.alloc(stride);
  let sampled = 0;
  let dark = 0;
  // More light than a blank frame allows, counted against every sample it will take.
  const lightAllowed = Math.ceil(height / SAMPLE) * Math.ceil(width / SAMPLE) * (1 - BLANK_SHARE);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    if (filter! > 4) return false;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[start + 1 + x]!;
      const left = x >= channels ? current[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      switch (filter) {
        case 1: current[x] = value + left; break;
        case 2: current[x] = value + up; break;
        case 3: current[x] = value + ((left + up) >> 1); break;
        case 4: current[x] = value + paeth(left, up, upLeft); break;
        default: current[x] = value;
      }
    }
    if (y % SAMPLE === 0) {
      for (let x = 0; x < width; x += SAMPLE) {
        const at = x * channels;
        sampled += 1;
        if (current[at]! < DARK && current[at + 1]! < DARK && current[at + 2]! < DARK) dark += 1;
      }
      if (sampled - dark > lightAllowed) return false;
    }
    [previous, current] = [current, previous];
  }
  return sampled > 0 && dark / sampled >= BLANK_SHARE;
}
