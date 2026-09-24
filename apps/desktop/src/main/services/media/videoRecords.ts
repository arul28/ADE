/**
 * The record framing both loopback video servers speak.
 *
 * Layout, big-endian: u32 magic, u8 type, u8 flags, u16 reserved, u32 payload
 * length. The renderer's reader (`iosSimVideoRecords.ts`) is the only consumer,
 * and it is the same code for the simulator and for a lane's macOS display, so
 * the writer and the splitter live together here rather than once per server.
 *
 * The `config` payload is JSON — `{codec, width, height, annexB}` — not a bare
 * codec string. The Swift driver writes the bare string on its own socket, and
 * the Mac Desktop server rewrites it on the way out precisely because this is
 * the contract the renderer parses.
 */

import {
  IOS_VIDEO_RECORD_FLAG_KEYFRAME,
  IOS_VIDEO_RECORD_HEADER_BYTES,
  IOS_VIDEO_RECORD_MAGIC,
} from "../../../shared/types/iosSimulator";

/** A record larger than this is not something either server sends. */
export const MAX_VIDEO_RECORD_BYTES = 16 * 1024 * 1024;

export class VideoRecordFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoRecordFramingError";
  }
}

/**
 * Builds one framed record. The reader needs the length before the payload
 * because a chunked HTTP body has no message boundaries of its own.
 */
export function encodeVideoRecord(
  type: number,
  payload: Uint8Array,
  options: { keyframe?: boolean } = {},
): Uint8Array {
  const record = new Uint8Array(IOS_VIDEO_RECORD_HEADER_BYTES + payload.byteLength);
  const view = new DataView(record.buffer);
  view.setUint32(0, IOS_VIDEO_RECORD_MAGIC, false);
  view.setUint8(4, type);
  view.setUint8(5, options.keyframe ? IOS_VIDEO_RECORD_FLAG_KEYFRAME : 0);
  view.setUint16(6, 0, false);
  view.setUint32(8, payload.byteLength, false);
  record.set(payload, IOS_VIDEO_RECORD_HEADER_BYTES);
  return record;
}

export type VideoRecord = {
  type: number;
  flags: number;
  payload: Buffer;
  /** Header and payload together, for a server that forwards untouched. */
  raw: Buffer;
};

/**
 * Splits a byte stream into whole records, buffering a partial tail.
 *
 * Throws `VideoRecordFramingError` on a bad magic or an impossible length: a
 * desynchronised reader must stop rather than allocate on a number it misread.
 */
export function createVideoRecordSplitter(): {
  push(chunk: Buffer): VideoRecord[];
  pendingBytes(): number;
} {
  let pending: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): VideoRecord[] {
      pending = pending.byteLength === 0 ? chunk : (Buffer.concat([pending, chunk]) as Buffer);
      const records: VideoRecord[] = [];
      let offset = 0;
      while (pending.byteLength - offset >= IOS_VIDEO_RECORD_HEADER_BYTES) {
        const magic = pending.readUInt32BE(offset);
        if (magic !== IOS_VIDEO_RECORD_MAGIC) {
          throw new VideoRecordFramingError("The video stream is not framed as expected.");
        }
        const length = pending.readUInt32BE(offset + 8);
        if (length > MAX_VIDEO_RECORD_BYTES) {
          throw new VideoRecordFramingError(`The video stream declared a ${length} byte record.`);
        }
        const end = offset + IOS_VIDEO_RECORD_HEADER_BYTES + length;
        if (pending.byteLength < end) break;
        records.push({
          type: pending.readUInt8(offset + 4),
          flags: pending.readUInt8(offset + 5),
          payload: pending.subarray(offset + IOS_VIDEO_RECORD_HEADER_BYTES, end),
          raw: pending.subarray(offset, end),
        });
        offset = end;
      }
      // Copy the tail: the slices above are views into this buffer and the
      // caller keeps them until they have been written.
      pending = offset === 0 ? pending : Buffer.from(pending.subarray(offset));
      return records;
    },
    pendingBytes(): number {
      return pending.byteLength;
    },
  };
}
