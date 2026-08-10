import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  decodeSyncBinaryFrame,
  encodeSyncBinaryFrame,
  isSyncBinaryFrame,
  MAX_SYNC_BINARY_FRAME_HEADER_BYTES,
  syncFrameByteLength,
} from "./syncBinaryFrame";
import {
  createSyncEnvelopeChunkAssembler,
  DEFAULT_SYNC_MAX_FRAME_BYTES,
  encodeSyncEnvelope,
  encodeSyncEnvelopeFrames,
  parseSyncBinaryChunkHeader,
  parseSyncEnvelopeFrame,
  SYNC_BINARY_ENVELOPES_CAPABILITY,
  shouldSkipApplicationCompression,
  type SyncWireFrame,
} from "./syncProtocol";

/**
 * Deterministic incompressible bytes, so compression cannot mask a sizing bug.
 * xorshift, not an LCG: an LCG's low byte is periodic enough that deflate eats
 * it, which silently turns an "oversized envelope" case into a one-frame case.
 */
function pseudoRandomBytes(length: number, seed = 0x9e3779b9): Buffer {
  const out = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[index] = state & 0xff;
  }
  return out;
}

function reassembleBinary(frames: SyncWireFrame[]): unknown {
  const assembler = createSyncEnvelopeChunkAssembler();
  let reassembled: Buffer | null = null;
  for (const frame of frames) {
    const envelope = parseSyncEnvelopeFrame(frame);
    expect(envelope.type).toBe("envelope_chunk");
    expect(envelope.binaryChunk).toBeDefined();
    const chunk = envelope.binaryChunk!;
    const result = assembler.addBinary(chunk, chunk.body);
    if (result != null) reassembled = result;
  }
  expect(reassembled).not.toBeNull();
  return parseSyncEnvelopeFrame(reassembled!);
}

describe("syncBinaryFrame container", () => {
  it("round-trips a header and body", () => {
    const frame = encodeSyncBinaryFrame({ type: "chat_event", n: 7 }, Buffer.from("payload-bytes"));
    expect(isSyncBinaryFrame(frame)).toBe(true);
    const decoded = decodeSyncBinaryFrame(frame);
    expect(decoded?.header).toEqual({ type: "chat_event", n: 7 });
    expect(decoded?.body.toString()).toBe("payload-bytes");
  });

  it("round-trips an empty body", () => {
    const decoded = decodeSyncBinaryFrame(encodeSyncBinaryFrame({ type: "ping" }, Buffer.alloc(0)));
    expect(decoded?.body.byteLength).toBe(0);
  });

  it("does not mistake JSON text delivered as binary for a binary frame", () => {
    // wsDataToText has always decoded Buffer frames as utf8; the magic prefix
    // is what keeps a text frame arriving as data on the text path.
    const text = Buffer.from(encodeSyncEnvelope({ type: "chat_event", payload: { a: 1 } }), "utf8");
    expect(isSyncBinaryFrame(text)).toBe(false);
    expect(parseSyncEnvelopeFrame(text).type).toBe("chat_event");
  });

  it("rejects a truncated frame rather than reading past the end", () => {
    const frame = encodeSyncBinaryFrame({ type: "chat_event" }, Buffer.from("body"));
    expect(decodeSyncBinaryFrame(frame.subarray(0, 6))).toBeNull();
    const lying = Buffer.from(frame);
    lying.writeUInt32BE(frame.byteLength * 4, 4);
    expect(decodeSyncBinaryFrame(lying)).toBeNull();
  });

  it("rejects a header length past the cap without allocating for it", () => {
    const frame = encodeSyncBinaryFrame({ type: "chat_event" }, Buffer.from("body"));
    const oversized = Buffer.from(frame);
    oversized.writeUInt32BE(MAX_SYNC_BINARY_FRAME_HEADER_BYTES + 1, 4);
    expect(decodeSyncBinaryFrame(oversized)).toBeNull();
  });

  it("rejects a non-object header", () => {
    const body = Buffer.from("body");
    const header = Buffer.from("[1,2,3]", "utf8");
    const frame = Buffer.concat([
      Buffer.from("ADE1", "ascii"),
      (() => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(header.byteLength); return b; })(),
      header,
      body,
    ]);
    expect(decodeSyncBinaryFrame(frame)).toBeNull();
  });

  it("reassembles a fragmented binary frame before sniffing the magic", () => {
    // `ws` delivers RawData as Buffer[] in fragments mode; the magic sniff must
    // see the concatenated bytes, not the first fragment alone.
    const frame = encodeSyncEnvelopeFrames({
      type: "changeset_batch",
      payload: { changes: Array.from({ length: 300 }, (_, i) => ({ table: "operations", seq: i })) },
      compressionThresholdBytes: 512,
      compressionCodec: "deflate",
      binaryFrames: true,
    })[0] as Buffer;
    const fragments = [frame.subarray(0, 2), frame.subarray(2, 9), frame.subarray(9)];
    expect(parseSyncEnvelopeFrame(fragments)).toMatchObject({ type: "changeset_batch", compression: "deflate" });
  });

  it("measures text frames in utf8 bytes and binary frames in raw bytes", () => {
    expect(syncFrameByteLength("héllo")).toBe(6);
    expect(syncFrameByteLength(Buffer.alloc(11))).toBe(11);
  });
});

describe("binary envelope frames", () => {
  const payload = { changes: Array.from({ length: 400 }, (_, i) => ({ table: "operations", seq: i, note: "repeated".repeat(4) })) };

  it("carries the same payload as the base64 wire, and fewer bytes", () => {
    const args = { type: "changeset_batch" as const, payload, compressionThresholdBytes: 512, compressionCodec: "deflate" as const };
    const [textFrame] = encodeSyncEnvelopeFrames({ ...args });
    const [binaryFrame] = encodeSyncEnvelopeFrames({ ...args, binaryFrames: true });

    expect(typeof textFrame).toBe("string");
    expect(Buffer.isBuffer(binaryFrame)).toBe(true);
    expect(parseSyncEnvelopeFrame(binaryFrame)).toMatchObject({
      type: "changeset_batch",
      compression: "deflate",
      payload,
    });
    expect(parseSyncEnvelopeFrame(binaryFrame).payload)
      .toEqual(parseSyncEnvelopeFrame(textFrame).payload);
    // base64 costs 4 bytes per 3; dropping it is worth at least a fifth.
    expect(syncFrameByteLength(binaryFrame)).toBeLessThan(syncFrameByteLength(textFrame) * 0.8);
  });

  it("keeps an uncompressed payload as JSON text even for a binary peer", () => {
    const [frame] = encodeSyncEnvelopeFrames({
      type: "chat_event",
      payload: { tiny: true },
      compressionThresholdBytes: 512,
      compressionCodec: "deflate",
      binaryFrames: true,
    });
    expect(typeof frame).toBe("string");
    expect(parseSyncEnvelopeFrame(frame).payload).toEqual({ tiny: true });
  });

  it("preserves projectId and requestId through the binary header", () => {
    const [frame] = encodeSyncEnvelopeFrames({
      type: "changeset_batch",
      projectId: "project-9",
      requestId: "req-9",
      payload,
      compressionThresholdBytes: 512,
      compressionCodec: "deflate",
      binaryFrames: true,
    });
    expect(parseSyncEnvelopeFrame(frame)).toMatchObject({ projectId: "project-9", requestId: "req-9" });
  });

  it("round-trips gzip as well as deflate", () => {
    const [frame] = encodeSyncEnvelopeFrames({
      type: "changeset_batch",
      payload,
      compressionThresholdBytes: 512,
      compressionCodec: "gzip",
      binaryFrames: true,
    });
    expect(parseSyncEnvelopeFrame(frame)).toMatchObject({ compression: "gzip", payload });
  });

  it("chunks an oversized binary envelope without reintroducing base64", () => {
    const data = pseudoRandomBytes(3 * 1024 * 1024).toString("base64");
    const frames = encodeSyncEnvelopeFrames({
      type: "file_response",
      requestId: "req-1",
      payload: { data },
      compressionThresholdBytes: 512,
      compressionCodec: "deflate",
      maxFrameBytes: DEFAULT_SYNC_MAX_FRAME_BYTES,
      binaryFrames: true,
    });
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(Buffer.isBuffer(frame)).toBe(true);
      expect(syncFrameByteLength(frame)).toBeLessThanOrEqual(DEFAULT_SYNC_MAX_FRAME_BYTES);
    }
    // A text chunk budgets its slice down to 3/4 to pay for base64; a binary
    // chunk does not, so the same envelope needs strictly fewer frames.
    const textFrames = encodeSyncEnvelopeFrames({
      type: "file_response",
      requestId: "req-1",
      payload: { data },
      compressionThresholdBytes: 512,
      compressionCodec: "deflate",
      maxFrameBytes: DEFAULT_SYNC_MAX_FRAME_BYTES,
    });
    expect(frames.length).toBeLessThan(textFrames.length);
    expect(reassembleBinary(frames)).toMatchObject({ type: "file_response", requestId: "req-1", payload: { data } });
  });

  it("reassembles binary chunks that arrive out of order", () => {
    const data = pseudoRandomBytes(2 * 1024 * 1024, 0x1234abcd).toString("base64");
    const frames = encodeSyncEnvelopeFrames({
      type: "command_result",
      payload: { data },
      compressionThresholdBytes: 512,
      compressionCodec: "deflate",
      maxFrameBytes: DEFAULT_SYNC_MAX_FRAME_BYTES,
      binaryFrames: true,
    });
    expect(frames.length).toBeGreaterThan(1);
    expect(reassembleBinary([...frames].reverse())).toMatchObject({ payload: { data } });
  });

  it("rejects a chunk header missing its ordering fields", () => {
    expect(parseSyncBinaryChunkHeader({ chunkId: "c", index: 0 })).toBeNull();
    expect(parseSyncBinaryChunkHeader({ chunkId: "c", index: 2, total: 2 })).toBeNull();
    expect(parseSyncBinaryChunkHeader({ chunkId: "", index: 0, total: 2 })).toBeNull();
    expect(parseSyncBinaryChunkHeader({ chunkId: "c", index: 0, total: 2 }))
      .toEqual({ chunkId: "c", index: 0, total: 2 });
  });
});

describe("permessage-deflate interaction", () => {
  it("skips the application codec only when the transport already deflates", () => {
    expect(shouldSkipApplicationCompression("permessage-deflate")).toBe(true);
    expect(shouldSkipApplicationCompression("permessage-deflate; client_max_window_bits=15")).toBe(true);
    expect(shouldSkipApplicationCompression("")).toBe(false);
    expect(shouldSkipApplicationCompression(undefined)).toBe(false);
    expect(shouldSkipApplicationCompression({ "permessage-deflate": {} })).toBe(false);
  });

  it("names the capability old builds will not declare", () => {
    expect(SYNC_BINARY_ENVELOPES_CAPABILITY).toBe("binaryEnvelopes");
  });
});
