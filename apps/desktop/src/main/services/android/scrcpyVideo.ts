/**
 * scrcpy's video socket, turned into ADE's video records.
 *
 * The pinned server (`scrcpyServer.ts`, v5.0.1) writes, after the forward
 * tunnel's dummy byte:
 *
 * 1. the device name, a 64-byte NUL-padded UTF-8 field;
 * 2. the codec id, a u32 (`"h264"`; 0 or 1 when the device refuses);
 * 3. 12-byte headers, each one of two kinds, told apart by the top bit:
 *    - a **session packet** (top bit 1) at the start of every capture
 *      session (start, rotation, reset): a u32 of flags, then the video width
 *      and height as u32;
 *    - a **media packet** header (top bit 0): a u64 whose bit 62 marks a
 *      config packet (SPS + PPS) and bit 61 a keyframe, with the PTS in the
 *      low 61 bits, then a u32 size and that many bytes of `MediaCodec` output.
 *
 * Source of truth: `server/.../device/Streamer.java`, `app/src/demuxer.c` and
 * `doc/develop.md` at tag v5.0.1 (the session packet is new in v4.0). The
 * protocol is internal to scrcpy and changes between versions, which is why
 * the server version is pinned with this file.
 *
 * Both halves here are pure: no sockets, no timers. The demuxer turns bytes
 * into packets; the record builder turns packets into the records the
 * renderer's reader (`videoRecordParser.ts`) and the relay already play.
 */

import { encodeVideoRecord, MAX_VIDEO_RECORD_BYTES } from "../media/videoRecords";
import { createH264AnnexBParser } from "../media/h264AnnexB";
import {
  VIDEO_RECORD_TYPE_ACCESS_UNIT,
  VIDEO_RECORD_TYPE_CONFIG,
} from "../../../shared/types/videoRecords";

/** `"h264"` in ASCII: the only codec ADE asks the server for. */
export const SCRCPY_CODEC_ID_H264 = 0x68323634;

const DEVICE_NAME_FIELD_BYTES = 64;
const CODEC_ID_BYTES = 4;
const PACKET_HEADER_BYTES = 12;
/** Flags in the top bits of a header's high word. */
const PACKET_FLAG_SESSION = 0x80000000;
const PACKET_FLAG_CONFIG = 0x40000000;
const PACKET_FLAG_KEY_FRAME = 0x20000000;
const PTS_HIGH_MASK = 0x1fffffff;
/**
 * A codec id of 0 means the device turned the stream off; 1 means its
 * configuration failed. Both come in the codec id's place.
 */
const CODEC_ID_STREAM_DISABLED = 0;
const CODEC_ID_CONFIGURATION_ERROR = 1;

const START_CODE = Uint8Array.from([0x00, 0x00, 0x00, 0x01]);
const SPS_NAL_TYPE = 7;

export class ScrcpyProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrcpyProtocolError";
  }
}

export type ScrcpyVideoHeader = {
  kind: "header";
  deviceName: string;
  codecId: number;
};

/** One capture session: the encoder (re)started at this size. */
export type ScrcpyVideoSession = {
  kind: "session";
  width: number;
  height: number;
};

export type ScrcpyVideoPacket = {
  kind: "packet";
  /** SPS and PPS, sent before the first frame and after every encoder restart. */
  config: boolean;
  keyframe: boolean;
  /** Microseconds; null on a config packet, which carries no time. */
  ptsUs: number | null;
  data: Buffer;
};

export type ScrcpyVideoEvent = ScrcpyVideoHeader | ScrcpyVideoSession | ScrcpyVideoPacket;

/**
 * Splits the video socket's bytes into the header, sessions and whole packets.
 *
 * Feed it everything after the dummy byte. Throws `ScrcpyProtocolError` when
 * the device disables the stream, names another codec, or declares a packet
 * no encoder would write: a reader that lost its place must stop rather than
 * allocate on a misread length.
 */
export function createScrcpyVideoDemuxer(): {
  push(chunk: Buffer): ScrcpyVideoEvent[];
  pendingBytes(): number;
} {
  let pending: Buffer = Buffer.alloc(0);
  let headerRead = false;

  return {
    push(chunk: Buffer): ScrcpyVideoEvent[] {
      pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
      const events: ScrcpyVideoEvent[] = [];
      let offset = 0;

      if (!headerRead) {
        if (pending.byteLength < DEVICE_NAME_FIELD_BYTES + CODEC_ID_BYTES) return events;
        const codecId = pending.readUInt32BE(DEVICE_NAME_FIELD_BYTES);
        if (codecId === CODEC_ID_STREAM_DISABLED) {
          throw new ScrcpyProtocolError("The device turned the video stream off.");
        }
        if (codecId === CODEC_ID_CONFIGURATION_ERROR) {
          throw new ScrcpyProtocolError("The device could not configure the video encoder.");
        }
        if (codecId !== SCRCPY_CODEC_ID_H264) {
          throw new ScrcpyProtocolError(`The device sent codec 0x${codecId.toString(16)}, not H.264.`);
        }
        const nameField = pending.subarray(0, DEVICE_NAME_FIELD_BYTES);
        const nul = nameField.indexOf(0);
        events.push({
          kind: "header",
          deviceName: nameField.subarray(0, nul === -1 ? nameField.byteLength : nul).toString("utf8"),
          codecId,
        });
        headerRead = true;
        offset = DEVICE_NAME_FIELD_BYTES + CODEC_ID_BYTES;
      }

      while (pending.byteLength - offset >= PACKET_HEADER_BYTES) {
        const high = pending.readUInt32BE(offset);
        const low = pending.readUInt32BE(offset + 4);
        const size = pending.readUInt32BE(offset + 8);
        if ((high & PACKET_FLAG_SESSION) !== 0) {
          // Width and height take the PTS and size slots.
          if (!low || !size) throw new ScrcpyProtocolError(`The device sent a ${low}x${size} capture session.`);
          events.push({ kind: "session", width: low, height: size });
          offset += PACKET_HEADER_BYTES;
          continue;
        }
        if (size > MAX_VIDEO_RECORD_BYTES) {
          throw new ScrcpyProtocolError(`The device declared a ${size} byte video packet.`);
        }
        const end = offset + PACKET_HEADER_BYTES + size;
        if (pending.byteLength < end) break;
        const config = (high & PACKET_FLAG_CONFIG) !== 0;
        events.push({
          kind: "packet",
          config,
          keyframe: !config && (high & PACKET_FLAG_KEY_FRAME) !== 0,
          ptsUs: config ? null : (high & PTS_HIGH_MASK) * 0x1_0000_0000 + low,
          // Copied: the tail below is re-sliced and the caller keeps packets.
          data: Buffer.from(pending.subarray(offset + PACKET_HEADER_BYTES, end)),
        });
        offset = end;
      }

      pending = offset === 0 ? pending : Buffer.from(pending.subarray(offset));
      return events;
    },
    pendingBytes(): number {
      return pending.byteLength;
    },
  };
}

export type ScrcpyVideoConfig = {
  codec: string;
  width: number;
  height: number;
};

export type ScrcpyRecordOutput =
  | ({ kind: "config"; record: Uint8Array } & ScrcpyVideoConfig)
  | { kind: "access-unit"; record: Uint8Array; keyframe: boolean };

/** NAL type of the first NAL in an Annex-B buffer, or null when there is none. */
function firstNalType(data: Uint8Array): number | null {
  for (let i = 0; i + 3 < data.length; i += 1) {
    if (data[i] !== 0x00 || data[i + 1] !== 0x00) continue;
    if (data[i + 2] === 0x01) return data[i + 3] & 0x1f;
    if (data[i + 2] === 0x00 && i + 4 < data.length && data[i + 3] === 0x01) return data[i + 4] & 0x1f;
  }
  return null;
}

/**
 * Turns scrcpy packets into ADE video records.
 *
 * Two rules make a reader that joins late, or a decoder that resets, able to
 * start from any keyframe:
 *
 * - **Every keyframe carries its parameter sets.** `MediaCodec` sends SPS and
 *   PPS once, as a config packet, and its later IDRs come bare. The record
 *   for a keyframe is therefore the last SPS + PPS followed by the frame. A
 *   reader that missed the config packet decodes it anyway. (t3code's
 *   "Connecting video" loop came from keyframes that lacked them.)
 * - **A config record only on a change.** The renderer rebuilds its decoder on
 *   every config record and then waits for a keyframe, so a config packet that
 *   names the same codec and size (an encoder reset, a keyframe request) does
 *   not produce one. A rotation changes the size and does.
 */
export function createScrcpyRecordBuilder(): {
  push(packet: Pick<ScrcpyVideoPacket, "config" | "keyframe" | "data">): ScrcpyRecordOutput[];
  /** The config the last config record announced, or null before the first. */
  currentConfig(): ScrcpyVideoConfig | null;
} {
  let parameterSets: Uint8Array | null = null;
  let current: ScrcpyVideoConfig | null = null;

  const readConfigPacket = (data: Uint8Array): ScrcpyRecordOutput[] => {
    const parser = createH264AnnexBParser();
    parser.push(data);
    parser.flush();
    const sets = parser.parameterSets();
    if (!sets.sps || !sets.pps || !sets.codec || !sets.width || !sets.height) {
      throw new ScrcpyProtocolError("The device sent a video configuration without a readable SPS and PPS.");
    }
    // Rebuilt from the parsed NALs, so the bytes in front of every keyframe
    // are exactly one SPS and one PPS with 4-byte start codes.
    const merged = new Uint8Array(START_CODE.length * 2 + sets.sps.length + sets.pps.length);
    merged.set(START_CODE, 0);
    merged.set(sets.sps, START_CODE.length);
    merged.set(START_CODE, START_CODE.length + sets.sps.length);
    merged.set(sets.pps, START_CODE.length * 2 + sets.sps.length);
    parameterSets = merged;

    const next: ScrcpyVideoConfig = { codec: sets.codec, width: sets.width, height: sets.height };
    if (current && current.codec === next.codec && current.width === next.width && current.height === next.height) {
      return [];
    }
    current = next;
    const payload = Buffer.from(JSON.stringify({ ...next, annexB: true }));
    return [{ kind: "config", record: encodeVideoRecord(VIDEO_RECORD_TYPE_CONFIG, payload), ...next }];
  };

  return {
    push(packet): ScrcpyRecordOutput[] {
      if (packet.config) return readConfigPacket(packet.data);
      // A frame before any config cannot be decoded by anyone.
      if (!parameterSets || !current) return [];
      // `MediaCodec` flags its sync frames, and the server copies the flag.
      const keyframe = packet.keyframe;
      let payload: Uint8Array = packet.data;
      if (keyframe && firstNalType(packet.data) !== SPS_NAL_TYPE) {
        const merged = new Uint8Array(parameterSets.length + packet.data.length);
        merged.set(parameterSets, 0);
        merged.set(packet.data, parameterSets.length);
        payload = merged;
      }
      return [{
        kind: "access-unit",
        record: encodeVideoRecord(VIDEO_RECORD_TYPE_ACCESS_UNIT, payload, { keyframe }),
        keyframe,
      }];
    },
    currentConfig(): ScrcpyVideoConfig | null {
      return current;
    },
  };
}
