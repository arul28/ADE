import { Buffer } from "node:buffer";
import { safeJsonParse } from "../../../../desktop/src/main/services/shared/utils";

/**
 * Binary envelope container.
 *
 * A compressed envelope used to travel as JSON text with the compressed bytes
 * base64'd into the `payload` string — a flat +33% re-inflation of exactly the
 * bytes compression had just removed. This container carries the same envelope
 * metadata as a JSON header and the compressed bytes as raw binary, measured at
 * -25% wire bytes on real changeset traffic.
 *
 *   [0..4)      magic "ADE1"
 *   [4..8)      uint32 big-endian header length
 *   [8..8+h)    header JSON (utf8) — the envelope minus `payload`
 *   [8+h..)     payload bytes (compressed, codec named by the header)
 *
 * The magic prefix is what lets a receiver tell a binary envelope apart from a
 * text frame that merely arrived as binary data: `wsDataToText` has always
 * decoded Buffer frames as utf8, and some transports (the relay hop, ws with
 * `binaryType`) can deliver text that way. Sniffing the first four bytes is
 * therefore load-bearing, not decoration.
 */
export const SYNC_BINARY_FRAME_MAGIC = "ADE1";
const MAGIC_BYTES = Buffer.from(SYNC_BINARY_FRAME_MAGIC, "ascii");
const HEADER_LENGTH_OFFSET = MAGIC_BYTES.byteLength;
const BODY_OFFSET = HEADER_LENGTH_OFFSET + 4;

/** A header larger than this is malformed; the real ones are ~150 bytes. */
export const MAX_SYNC_BINARY_FRAME_HEADER_BYTES = 64 * 1024;

export type SyncBinaryFrameHeader = Record<string, unknown>;

export type DecodedSyncBinaryFrame = {
  header: SyncBinaryFrameHeader;
  body: Buffer;
};

/** True when `data` carries the binary-envelope magic prefix. */
export function isSyncBinaryFrame(data: unknown): data is Buffer {
  return Buffer.isBuffer(data)
    && data.byteLength >= BODY_OFFSET
    && data.subarray(0, MAGIC_BYTES.byteLength).equals(MAGIC_BYTES);
}

export function encodeSyncBinaryFrame(header: SyncBinaryFrameHeader, body: Buffer): Buffer {
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  if (headerJson.byteLength > MAX_SYNC_BINARY_FRAME_HEADER_BYTES) {
    throw new Error("Sync binary frame header exceeds the maximum header size.");
  }
  const frame = Buffer.allocUnsafe(BODY_OFFSET + headerJson.byteLength + body.byteLength);
  MAGIC_BYTES.copy(frame, 0);
  frame.writeUInt32BE(headerJson.byteLength, HEADER_LENGTH_OFFSET);
  headerJson.copy(frame, BODY_OFFSET);
  body.copy(frame, BODY_OFFSET + headerJson.byteLength);
  return frame;
}

/**
 * Returns null rather than throwing for any frame that is not a well-formed
 * binary envelope, so a caller can fall back to the text path on garbage
 * instead of tearing the connection down.
 */
export function decodeSyncBinaryFrame(data: Buffer): DecodedSyncBinaryFrame | null {
  if (!isSyncBinaryFrame(data)) return null;
  const headerBytes = data.readUInt32BE(HEADER_LENGTH_OFFSET);
  if (headerBytes > MAX_SYNC_BINARY_FRAME_HEADER_BYTES) return null;
  const bodyStart = BODY_OFFSET + headerBytes;
  if (bodyStart > data.byteLength) return null;
  const header = safeJsonParse<SyncBinaryFrameHeader | null>(
    data.subarray(BODY_OFFSET, bodyStart).toString("utf8"),
    null,
  );
  if (!header || typeof header !== "object" || Array.isArray(header)) return null;
  return { header, body: data.subarray(bodyStart) };
}

/** Wire size of a frame that may be either a text or a binary envelope. */
export function syncFrameByteLength(frame: string | Buffer): number {
  return typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : frame.byteLength;
}
