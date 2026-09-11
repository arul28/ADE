/**
 * Reads the framed byte stream the simulator video server writes.
 *
 * A chunked HTTP body has no message boundaries, so the server prefixes every
 * record with a fixed 12-byte header. This parser is deliberately free of DOM
 * and of `fetch`: the component that owns the decoder passes it raw chunks, and
 * a test passes it hand-built ones.
 */

import {
  IOS_VIDEO_RECORD_FLAG_KEYFRAME,
  IOS_VIDEO_RECORD_HEADER_BYTES,
  IOS_VIDEO_RECORD_MAGIC,
  IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT,
  IOS_VIDEO_RECORD_TYPE_CONFIG,
} from "../../../shared/types/iosSimulator";

export type IosSimVideoConfigRecord = {
  kind: "config";
  codec: string;
  width: number | null;
  height: number | null;
  annexB: boolean;
};

export type IosSimVideoAccessUnitRecord = {
  kind: "access-unit";
  keyframe: boolean;
  bytes: Uint8Array;
};

export type IosSimVideoRecord = IosSimVideoConfigRecord | IosSimVideoAccessUnitRecord;

/**
 * A record larger than this is not something the server sends. Refusing it
 * stops a desynchronised reader from allocating on a length it misread.
 */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

export class IosSimVideoProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IosSimVideoProtocolError";
  }
}

export function createIosSimVideoRecordParser(): {
  push(chunk: Uint8Array): IosSimVideoRecord[];
  reset(): void;
  pendingBytes(): number;
} {
  let buffer = new Uint8Array(0);

  const append = (chunk: Uint8Array) => {
    if (buffer.byteLength === 0) {
      buffer = chunk.slice();
      return;
    }
    const next = new Uint8Array(buffer.byteLength + chunk.byteLength);
    next.set(buffer, 0);
    next.set(chunk, buffer.byteLength);
    buffer = next;
  };

  return {
    push(chunk: Uint8Array): IosSimVideoRecord[] {
      append(chunk);
      const records: IosSimVideoRecord[] = [];
      let offset = 0;
      while (buffer.byteLength - offset >= IOS_VIDEO_RECORD_HEADER_BYTES) {
        const view = new DataView(buffer.buffer, buffer.byteOffset + offset, IOS_VIDEO_RECORD_HEADER_BYTES);
        const magic = view.getUint32(0, false);
        if (magic !== IOS_VIDEO_RECORD_MAGIC) {
          throw new IosSimVideoProtocolError("The simulator video stream is not framed as expected.");
        }
        const type = view.getUint8(4);
        const flags = view.getUint8(5);
        const length = view.getUint32(8, false);
        if (length > MAX_RECORD_BYTES) {
          throw new IosSimVideoProtocolError(`The simulator video stream declared a ${length} byte record.`);
        }
        const end = offset + IOS_VIDEO_RECORD_HEADER_BYTES + length;
        if (buffer.byteLength < end) break;
        const payload = buffer.subarray(offset + IOS_VIDEO_RECORD_HEADER_BYTES, end);
        if (type === IOS_VIDEO_RECORD_TYPE_CONFIG) {
          const text = new TextDecoder().decode(payload);
          let parsed: { codec?: unknown; width?: unknown; height?: unknown; annexB?: unknown };
          try {
            parsed = JSON.parse(text) as typeof parsed;
          } catch {
            throw new IosSimVideoProtocolError("The simulator video stream sent an unreadable configuration.");
          }
          if (typeof parsed.codec !== "string" || !parsed.codec) {
            throw new IosSimVideoProtocolError("The simulator video stream sent no codec.");
          }
          records.push({
            kind: "config",
            codec: parsed.codec,
            width: typeof parsed.width === "number" ? parsed.width : null,
            height: typeof parsed.height === "number" ? parsed.height : null,
            annexB: parsed.annexB !== false,
          });
        } else if (type === IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT) {
          records.push({
            kind: "access-unit",
            keyframe: (flags & IOS_VIDEO_RECORD_FLAG_KEYFRAME) !== 0,
            // Copy: the buffer below is re-sliced, and a decoder keeps the view.
            bytes: payload.slice(),
          });
        }
        offset = end;
      }
      buffer = offset === 0 ? buffer : buffer.subarray(offset).slice();
      return records;
    },
    reset(): void {
      buffer = new Uint8Array(0);
    },
    pendingBytes(): number {
      return buffer.byteLength;
    },
  };
}
