import { deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  BACKPRESSURE_POLL_MS,
  createSyncEnvelopeChunkAssembler,
  decodeStrictBase64,
  DEFAULT_SYNC_MAX_FRAME_BYTES,
  encodeSyncEnvelope,
  encodeSyncEnvelopeFrames,
  FORWARD_DATA_CHUNK_BYTES,
  isSyncProtocolVersionSupported,
  MAX_CHANNEL_ID_CHARS,
  MAX_ENVELOPE_CHUNK_ID_BYTES,
  MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES,
  normalizeChannelId,
  parseSyncBinaryChunkHeader,
  parseSyncEnvelope,
  parseSyncEnvelopeFrame,
  syncFrameByteLength,
  type SyncWireFrame,
  parseSyncEnvelopeChunkPayload,
  PEER_BACKPRESSURE_BYTES,
  RPC_DATA_CHUNK_BYTES,
  SyncProtocolVersionMismatchError,
  SYNC_PROTOCOL_MIN_SUPPORTED,
  SYNC_PROTOCOL_VERSION,
} from "./syncProtocol";

// Deterministic xorshift PRNG — gzip cannot compress its output, so payloads
// built from it reliably exceed the frame budget after compression.
function pseudoRandomBytes(length: number, seed = 0x9e3779b9): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function reassemble(frames: SyncWireFrame[], options: { shuffle?: boolean } = {}): unknown {
  const assembler = createSyncEnvelopeChunkAssembler();
  const order = options.shuffle ? [...frames].reverse() : frames;
  let reassembled: SyncWireFrame | null = null;
  for (const frame of order) {
    const envelope = parseSyncEnvelopeFrame(frame);
    expect(envelope.type).toBe("envelope_chunk");
    if (envelope.binaryChunk) {
      const result = assembler.addBinary(envelope.binaryChunk, envelope.binaryChunk.body);
      if (result != null) reassembled = result;
      continue;
    }
    const chunk = parseSyncEnvelopeChunkPayload(envelope.payload);
    expect(chunk).not.toBeNull();
    const result = assembler.add(chunk!);
    if (result != null) reassembled = result;
  }
  expect(reassembled).not.toBeNull();
  return parseSyncEnvelopeFrame(reassembled!);
}

describe("paired runtime wire framing", () => {
  it("exports the canonical framing and backpressure constants", () => {
    expect(RPC_DATA_CHUNK_BYTES).toBe(256 * 1024);
    expect(FORWARD_DATA_CHUNK_BYTES).toBe(64 * 1024);
    expect(PEER_BACKPRESSURE_BYTES).toBe(4 * 1024 * 1024);
    expect(BACKPRESSURE_POLL_MS).toBe(25);
    expect(MAX_CHANNEL_ID_CHARS).toBe(128);
  });

  it("strictly decodes base64 and normalizes channel ids", () => {
    expect(decodeStrictBase64(Buffer.from("hello").toString("base64"))?.toString("utf8")).toBe("hello");
    expect(decodeStrictBase64("")).toEqual(Buffer.alloc(0));
    expect(decodeStrictBase64("abc")).toBeNull();
    expect(decodeStrictBase64("ab=c")).toBeNull();
    expect(decodeStrictBase64(null)).toBeNull();

    expect(normalizeChannelId(" rpc:desktop-1 ")).toBe("rpc:desktop-1");
    expect(normalizeChannelId("bad channel")).toBeNull();
    expect(normalizeChannelId("x".repeat(MAX_CHANNEL_ID_CHARS + 1))).toBeNull();
    expect(normalizeChannelId(null)).toBeNull();
  });
});

describe("encodeSyncEnvelopeFrames", () => {
  it("returns a single frame when the envelope fits the budget", () => {
    const frames = encodeSyncEnvelopeFrames({
      type: "chat_event",
      payload: { small: true },
      maxFrameBytes: DEFAULT_SYNC_MAX_FRAME_BYTES,
    });
    expect(frames).toHaveLength(1);
    expect(parseSyncEnvelopeFrame(frames[0]).type).toBe("chat_event");
  });

  it("returns a single frame when no budget is set, regardless of size", () => {
    const frames = encodeSyncEnvelopeFrames({
      type: "file_response",
      payload: { data: "x".repeat(3 * 1024 * 1024) },
      maxFrameBytes: null,
    });
    expect(frames).toHaveLength(1);
  });

  it("splits an oversized envelope and every frame respects the budget", () => {
    // Incompressible payload so gzip cannot squeeze it under the budget.
    const data = pseudoRandomBytes(3 * 1024 * 1024).toString("base64");
    const frames = encodeSyncEnvelopeFrames({
      type: "file_response",
      requestId: "req-1",
      payload: { data },
      maxFrameBytes: DEFAULT_SYNC_MAX_FRAME_BYTES,
    });
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(syncFrameByteLength(frame)).toBeLessThanOrEqual(DEFAULT_SYNC_MAX_FRAME_BYTES);
    }
    const envelope = reassemble(frames) as { type: string; requestId: string | null; payload: { data?: string } };
    expect(envelope.type).toBe("file_response");
    expect(envelope.requestId).toBe("req-1");
    expect(envelope.payload.data).toBe(data);
  });

  it("reassembles correctly when parts arrive out of order", () => {
    const data = pseudoRandomBytes(2 * 1024 * 1024, 0x1234abcd).toString("base64");
    const frames = encodeSyncEnvelopeFrames({
      type: "command_result",
      payload: { data },
      maxFrameBytes: DEFAULT_SYNC_MAX_FRAME_BYTES,
    });
    expect(frames.length).toBeGreaterThan(1);
    const envelope = reassemble(frames, { shuffle: true }) as { payload: { data?: string } };
    expect(envelope.payload.data).toBe(data);
  });

  it("preserves multi-byte unicode payloads across byte-boundary slicing", () => {
    const entropy = pseudoRandomBytes(192 * 1024, 0x51f15eed);
    const text = Array.from(entropy, (byte, index) => `变${byte.toString(16)}🚀ü${(byte ^ (index & 0xff)).toString(36)}`).join("");
    const frames = encodeSyncEnvelopeFrames({
      type: "command_result",
      payload: { text },
      maxFrameBytes: 64 * 1024,
    });
    expect(frames.length).toBeGreaterThan(1);
    const envelope = reassemble(frames) as { payload: { text?: string } };
    expect(envelope.payload.text).toBe(text);
  });
});

describe("createSyncEnvelopeChunkAssembler", () => {
  it("ignores chunk sets with inconsistent totals", () => {
    const assembler = createSyncEnvelopeChunkAssembler();
    expect(assembler.add({ chunkId: "a", index: 0, total: 2, part: Buffer.from("x").toString("base64") })).toBeNull();
    expect(assembler.add({ chunkId: "a", index: 1, total: 3, part: Buffer.from("y").toString("base64") })).toBeNull();
    // The mismatch dropped the buffer; completing the original set restarts from scratch.
    expect(assembler.add({ chunkId: "a", index: 1, total: 2, part: Buffer.from("y").toString("base64") })).toBeNull();
  });

  it("rejects oversized chunk counts and evicts stale partial chunks", () => {
    const assembler = createSyncEnvelopeChunkAssembler({ maxConcurrentChunks: 2, maxTotalParts: 4 });
    expect(assembler.add({ chunkId: "huge", index: 0, total: 5, part: "" })).toBeNull();
    expect(assembler.add({ chunkId: "one", index: 0, total: 2, part: Buffer.from("1").toString("base64") })).toBeNull();
    expect(assembler.add({ chunkId: "two", index: 0, total: 2, part: Buffer.from("2").toString("base64") })).toBeNull();
    // Third concurrent chunk evicts "one"; completing "one" later restarts it.
    expect(assembler.add({ chunkId: "three", index: 0, total: 2, part: Buffer.from("3").toString("base64") })).toBeNull();
    expect(assembler.add({ chunkId: "one", index: 1, total: 2, part: Buffer.from("!").toString("base64") })).toBeNull();
  });

  it("round-trips a small two-part chunk", () => {
    const encoded = encodeSyncEnvelope({ type: "heartbeat", payload: { at: 1 } });
    const raw = Buffer.from(encoded, "utf8");
    const half = Math.ceil(raw.byteLength / 2);
    const assembler = createSyncEnvelopeChunkAssembler();
    expect(assembler.add({ chunkId: "hb", index: 0, total: 2, part: raw.subarray(0, half).toString("base64") })).toBeNull();
    const result = assembler.add({ chunkId: "hb", index: 1, total: 2, part: raw.subarray(half).toString("base64") });
    expect(result).toBe(encoded);
  });

  it("expires an incomplete chunk set after 30 seconds", () => {
    vi.useFakeTimers();
    try {
      const assembler = createSyncEnvelopeChunkAssembler();
      expect(assembler.add({
        chunkId: "timed-out",
        index: 0,
        total: 2,
        part: Buffer.from("first").toString("base64"),
      })).toBeNull();
      expect(assembler.pendingCount()).toBe(1);
      vi.advanceTimersByTime(29_999);
      expect(assembler.pendingCount()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(assembler.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps aggregate buffered bytes across concurrent chunk sets", () => {
    const assembler = createSyncEnvelopeChunkAssembler({
      maxEnvelopeBytes: 8,
      maxBufferedBytes: 8,
    });
    expect(assembler.add({
      chunkId: "one",
      index: 0,
      total: 2,
      part: Buffer.from("12345").toString("base64"),
    })).toBeNull();
    expect(assembler.add({
      chunkId: "two",
      index: 0,
      total: 2,
      part: Buffer.from("6789").toString("base64"),
    })).toBeNull();
    expect(assembler.pendingCount()).toBe(1);
  });
});

describe("parseSyncEnvelopeChunkPayload", () => {
  it("validates shape strictly", () => {
    expect(parseSyncEnvelopeChunkPayload(null)).toBeNull();
    expect(parseSyncEnvelopeChunkPayload({ chunkId: "a", index: 2, total: 2, part: "" })).toBeNull();
    expect(parseSyncEnvelopeChunkPayload({ chunkId: "", index: 0, total: 1, part: "" })).toBeNull();
    expect(parseSyncEnvelopeChunkPayload({
      chunkId: "x".repeat(MAX_ENVELOPE_CHUNK_ID_BYTES + 1),
      index: 0,
      total: 1,
      part: "",
    })).toBeNull();
    expect(parseSyncEnvelopeChunkPayload({ chunkId: "a", index: 0, total: 1, part: "abc" })).toEqual({
      chunkId: "a",
      index: 0,
      total: 1,
      part: "abc",
    });
  });
});

describe("parseSyncEnvelope", () => {
  it("accepts every integer inside a supported version interval", () => {
    expect(isSyncProtocolVersionSupported(1, 1, 2)).toBe(true);
    expect(isSyncProtocolVersionSupported(2, 1, 2)).toBe(true);
    expect(isSyncProtocolVersionSupported(0, 1, 2)).toBe(false);
    expect(isSyncProtocolVersionSupported(3, 1, 2)).toBe(false);
    expect(isSyncProtocolVersionSupported(1.5, 1, 2)).toBe(false);
  });

  it.each([
    [0, "client"],
    [2, "host"],
  ] as const)("throws a typed version mismatch for protocol %i", (version, updateTarget) => {
    let caught: unknown;
    try {
      parseSyncEnvelope(JSON.stringify({
        version,
        type: "hello",
        requestId: `version-${version}`,
        compression: "none",
        payloadEncoding: "json",
        payload: {},
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SyncProtocolVersionMismatchError);
    const mismatch = caught as SyncProtocolVersionMismatchError;
    expect(mismatch.toHelloErrorPayload()).toEqual({
      code: "protocol_version_mismatch",
      message: mismatch.message,
      receivedVersion: version,
      currentVersion: SYNC_PROTOCOL_VERSION,
      minSupportedVersion: SYNC_PROTOCOL_MIN_SUPPORTED,
      updateTarget,
    });
  });

  it("preserves the legacy gzip wire frame unless a codec is explicitly selected", () => {
    const args = {
      type: "chat_event" as const,
      requestId: "legacy",
      payload: { text: "compress me ".repeat(600) },
      compressionThresholdBytes: 512,
    };
    expect(encodeSyncEnvelope(args)).toBe(encodeSyncEnvelope({
      ...args,
      compressionCodec: "gzip",
    }));
    expect(parseSyncEnvelope(encodeSyncEnvelope({
      ...args,
      compressionCodec: "deflate",
    })).compression).toBe("deflate");
  });

  it("decodes zlib-wrapped deflate with the same output cap as legacy gzip", () => {
    const payload = { text: "cross implementation ".repeat(300) };
    const payloadJson = JSON.stringify(payload);
    const encoded = JSON.stringify({
      version: 1,
      type: "chat_event",
      requestId: "deflate-fixture",
      compression: "deflate",
      payloadEncoding: "base64",
      payload: deflateSync(Buffer.from(payloadJson, "utf8")).toString("base64"),
      uncompressedBytes: Buffer.byteLength(payloadJson, "utf8"),
    });

    expect(parseSyncEnvelope(encoded).payload).toEqual(payload);
  });

  it("decodes an envelope compressed by the shipped iOS zlib implementation", () => {
    // Captured from SyncService.swift's deflateZlib implementation using the
    // shipped SDK's zlib module, not generated by Node in this test.
    const compressedPayload =
      "eJyrVipJrShRslLKzC9WyC8tScovzUtRSC7KLy5WyMwtyEnNTc0rSSzJzM9TGFUxqmLgVSjVAgCWBg1r";
    const encoded = JSON.stringify({
      version: 1,
      type: "chat_event",
      requestId: "ios-deflate-fixture",
      compression: "deflate",
      payloadEncoding: "base64",
      payload: compressedPayload,
      uncompressedBytes: 691,
    });

    expect(parseSyncEnvelope(encoded).payload).toEqual({
      text: "ios outbound cross implementation ".repeat(20),
    });
  });

  it("round-trips every paired runtime channel envelope", () => {
    const cases = [
      ["rpc_open", { channelId: "rpc-1" }],
      ["rpc_data", { channelId: "rpc-1", data: Buffer.from("{}\n").toString("base64") }],
      ["rpc_close", { channelId: "rpc-1", reason: "done" }],
      ["fwd_open", { forwardId: "fwd-1", host: "127.0.0.1", port: 4173 }],
      ["fwd_data", { forwardId: "fwd-1", data: Buffer.from("hello").toString("base64") }],
      ["fwd_close", { forwardId: "fwd-1", reason: "remote closed" }],
    ] as const;

    for (const [type, payload] of cases) {
      const decoded = parseSyncEnvelope(encodeSyncEnvelope({
        type,
        requestId: `${type}-request`,
        payload,
        compressionThresholdBytes: Number.POSITIVE_INFINITY,
      }));
      expect(decoded.type).toBe(type);
      expect(decoded.requestId).toBe(`${type}-request`);
      expect(decoded.payload).toEqual(payload);
    }
  });

  it("rejects declared oversized compressed payloads before inflating", () => {
    const encoded = JSON.stringify({
      version: 1,
      type: "hello",
      requestId: "oversized-declared",
      compression: "gzip",
      payloadEncoding: "base64",
      payload: gzipSync(Buffer.from("{}", "utf8")).toString("base64"),
      uncompressedBytes: MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES + 1,
    });

    expect(() => parseSyncEnvelope(encoded)).toThrow(
      `Decoded sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`,
    );
  });

  it("caps gzip output while inflating compressed payloads", () => {
    const compressed = gzipSync(Buffer.alloc(MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES + 1, 0x61));
    const encoded = JSON.stringify({
      version: 1,
      type: "hello",
      requestId: "oversized-inflate",
      compression: "gzip",
      payloadEncoding: "base64",
      payload: compressed.toString("base64"),
    });

    expect(() => parseSyncEnvelope(encoded)).toThrow(/Failed to decode gzip sync envelope oversized-inflate/);
  });
});
