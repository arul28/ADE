/**
 * The `.aderaw` capture: framing for the Chromium-side recorders (writer) and
 * the checks the Chromium engine runs before it streams a file (reader).
 *
 * The layout is the contract's ({@link DEMO_RAW_FILE_MAGIC}): an 8-byte
 * header, then records of a 16-byte little-endian header (u8 kind, u8 flags,
 * u16 reserved, f64 source seconds, u32 payload length) and the payload.
 *
 * The reader is the hidden renderer's (plain script, in
 * `chromiumDemoEngine.ts`): it streams the file and never holds it whole.
 */

import fs from "node:fs";
import {
  DEMO_RAW_FILE_MAGIC,
  type DEMO_RAW_KIND_H264_ACCESS_UNIT,
  DEMO_RAW_KIND_H264_CONFIG,
  type DEMO_RAW_KIND_JPEG,
  DEMO_RAW_RECORD_HEADER_BYTES,
  RECORDING_MAX_RAW_BYTES,
} from "../../../shared/demoVideo/demoContract";

export const DEMO_RAW_MAGIC_BYTES = Buffer.from(DEMO_RAW_FILE_MAGIC, "ascii");

export type DemoRawRecordKind =
  | typeof DEMO_RAW_KIND_JPEG
  | typeof DEMO_RAW_KIND_H264_CONFIG
  | typeof DEMO_RAW_KIND_H264_ACCESS_UNIT;

/** A payload no recorder writes: a frame this large is a corrupt length field. */
export const DEMO_RAW_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

export function encodeDemoRawRecordHeader(kind: DemoRawRecordKind, flags: number, t: number, payloadLength: number): Buffer {
  if (!Number.isFinite(t) || t < 0) throw new Error(`A raw record's time must be a finite, non-negative number of seconds (got ${t}).`);
  if (!Number.isInteger(payloadLength) || payloadLength < 0 || payloadLength > DEMO_RAW_MAX_PAYLOAD_BYTES) {
    throw new Error(`A raw record's payload length is out of range (${payloadLength}).`);
  }
  const header = Buffer.alloc(DEMO_RAW_RECORD_HEADER_BYTES);
  header.writeUInt8(kind, 0);
  header.writeUInt8(flags & 0xff, 1);
  header.writeUInt16LE(0, 2);
  header.writeDoubleLE(t, 4);
  header.writeUInt32LE(payloadLength, 12);
  return header;
}

/** True when the file starts with the capture header. Reads 8 bytes. */
export async function hasDemoRawMagic(filePath: string): Promise<boolean> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(DEMO_RAW_MAGIC_BYTES.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length && buffer.equals(DEMO_RAW_MAGIC_BYTES);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export type DemoRawWriterSummary = {
  filePath: string;
  bytes: number;
  /** Picture records written (JPEG frames or H.264 access units). */
  frames: number;
  /** Source seconds of the newest record, 0 before any. */
  lastTime: number;
  /** True when the size cap stopped the writer taking records. */
  truncated: boolean;
};

/**
 * Appends records to a new capture file. Writes are serialised in call order,
 * so a caller may fire and forget; `close` waits for them. Times never go
 * backwards: a record older than the newest one takes the newest time.
 *
 * `maxBytes` (default {@link RECORDING_MAX_RAW_BYTES}) is a hard cap: a record
 * that would cross it is dropped, and so is every later one.
 */
export async function createDemoRawWriter(
  filePath: string,
  options: { maxBytes?: number } = {},
) {
  // "wx": the path is freshly reserved, so an existing file is never someone else's to overwrite.
  const handle = await fs.promises.open(filePath, "wx");
  const maxBytes = options.maxBytes ?? RECORDING_MAX_RAW_BYTES;
  let bytes = 0;
  let frames = 0;
  let lastTime = 0;
  let truncated = false;
  let closed = false;
  let failure: Error | null = null;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (buffers: Buffer[]): Promise<void> => {
    const run = queue.then(async () => {
      if (failure) return;
      try {
        for (const buffer of buffers) {
          let offset = 0;
          while (offset < buffer.length) {
            const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
            offset += bytesWritten;
          }
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    });
    queue = run;
    return run;
  };

  bytes += DEMO_RAW_MAGIC_BYTES.length;
  void enqueue([DEMO_RAW_MAGIC_BYTES]);

  return {
    filePath,
    /** Queues one record. False when it was dropped (closed, failed or over the cap). */
    append(kind: DemoRawRecordKind, t: number, payload: Uint8Array, flags = 0): boolean {
      if (closed || failure || truncated) return false;
      const size = DEMO_RAW_RECORD_HEADER_BYTES + payload.byteLength;
      if (bytes + size > maxBytes) {
        truncated = true;
        return false;
      }
      const time = Math.max(lastTime, Number.isFinite(t) ? Math.max(0, t) : lastTime);
      lastTime = time;
      bytes += size;
      if (kind !== DEMO_RAW_KIND_H264_CONFIG) frames += 1;
      const body = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
      void enqueue([encodeDemoRawRecordHeader(kind, flags, time, payload.byteLength), body]);
      return true;
    },
    get failed(): Error | null {
      return failure;
    },
    summary(): DemoRawWriterSummary {
      return { filePath, bytes, frames, lastTime, truncated };
    },
    /** Flushes and closes. Rejects with the first write error, if any. */
    async close(): Promise<DemoRawWriterSummary> {
      closed = true;
      await queue;
      await handle.close().catch(() => {});
      if (failure) throw failure;
      return { filePath, bytes, frames, lastTime, truncated };
    },
    /** Closes without waiting for the verdict and deletes the file. */
    async discard(): Promise<void> {
      closed = true;
      await queue.catch(() => {});
      await handle.close().catch(() => {});
      await fs.promises.rm(filePath, { force: true }).catch(() => {});
    },
  };
}

export type DemoRawWriter = Awaited<ReturnType<typeof createDemoRawWriter>>;
