import fs from "node:fs";

/**
 * The creation time an MP4 or QuickTime file carries in its own header.
 *
 * `moov/mvhd` holds `creation_time` as seconds since 1904-01-01 UTC: 32 bits in
 * a version 0 box, 64 bits in a version 1 box. The walk reads box headers only
 * and seeks by their sizes, so it never loads the file. That matters because
 * `moov` often sits at the END of a recording, after hundreds of megabytes of
 * `mdat`.
 */

/** Reads `length` bytes at `position`. Returns fewer at end of file. */
export type MediaByteReader = (position: number, length: number) => Buffer;

/** Seconds between 1904-01-01 and 1970-01-01, both UTC. */
const MAC_EPOCH_OFFSET_SECONDS = 2_082_844_800;

/** A corrupt file must not spin the walk forever. */
const MAX_BOXES_PER_LEVEL = 4_096;

type BoxHeader = { start: number; headerSize: number; size: number };

function findBox(
  read: MediaByteReader,
  from: number,
  end: number,
  type: string,
): BoxHeader | null {
  let position = from;
  for (let count = 0; count < MAX_BOXES_PER_LEVEL && position + 8 <= end; count += 1) {
    const header = read(position, 16);
    if (header.length < 8) return null;
    const size32 = header.readUInt32BE(0);
    const boxType = header.toString("latin1", 4, 8);
    let headerSize = 8;
    let size: number;
    if (size32 === 1) {
      // 64-bit "largesize" follows the type.
      if (header.length < 16) return null;
      const large = header.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      headerSize = 16;
    } else if (size32 === 0) {
      // Size 0 means the box runs to the end of its container.
      size = end - position;
    } else {
      size = size32;
    }
    if (size < headerSize) return null;
    if (boxType === type) {
      return { start: position, headerSize, size: Math.min(size, end - position) };
    }
    position += size;
  }
  return null;
}

/**
 * `creation_time` from `moov/mvhd`, as a Date, or null when the file has none.
 *
 * Zero (the 1904 epoch itself) is what many encoders write when they do not
 * know, so it reads as unknown. So does anything that lands before 1970.
 */
export function readMp4CreationTime(read: MediaByteReader, fileSize: number): Date | null {
  if (!Number.isFinite(fileSize) || fileSize < 8) return null;
  const moov = findBox(read, 0, fileSize, "moov");
  if (!moov) return null;
  const moovEnd = moov.start + moov.size;
  const mvhd = findBox(read, moov.start + moov.headerSize, moovEnd, "mvhd");
  if (!mvhd) return null;
  const payloadStart = mvhd.start + mvhd.headerSize;
  const payloadLength = mvhd.start + mvhd.size - payloadStart;
  const payload = read(payloadStart, Math.min(12, Math.max(0, payloadLength)));
  if (payload.length < 1) return null;
  const version = payload.readUInt8(0);
  let seconds: number;
  if (version === 1) {
    if (payload.length < 12) return null;
    const raw = payload.readBigUInt64BE(4);
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    seconds = Number(raw);
  } else if (version === 0) {
    if (payload.length < 8) return null;
    seconds = payload.readUInt32BE(4);
  } else {
    return null;
  }
  if (seconds <= MAC_EPOCH_OFFSET_SECONDS) return null;
  const date = new Date((seconds - MAC_EPOCH_OFFSET_SECONDS) * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Extensions whose container is ISO base media (MP4 / QuickTime). */
const ISO_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(["mp4", "m4v", "mov"]);

export function isIsoMediaExtension(extension: string): boolean {
  return ISO_MEDIA_EXTENSIONS.has(extension.replace(/^\./, "").toLowerCase());
}

/**
 * The file form of {@link readMp4CreationTime}. Any read error is "unknown":
 * a missing creation time must never fail an attach.
 */
export function readMp4CreationTimeFromFile(filePath: string): Date | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const handle = fd;
    return readMp4CreationTime((position, length) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - position)));
      if (buffer.length === 0) return buffer;
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, position);
      return bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
    }, size);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing to do; the read is already over.
      }
    }
  }
}
