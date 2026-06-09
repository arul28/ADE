import { describe, expect, it } from "vitest";
import {
  createSyncEnvelopeChunkAssembler,
  DEFAULT_SYNC_MAX_FRAME_BYTES,
  encodeSyncEnvelope,
  encodeSyncEnvelopeFrames,
  parseSyncEnvelope,
  parseSyncEnvelopeChunkPayload,
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

function reassemble(frames: string[], options: { shuffle?: boolean } = {}): unknown {
  const assembler = createSyncEnvelopeChunkAssembler();
  const order = options.shuffle ? [...frames].reverse() : frames;
  let reassembled: string | null = null;
  for (const frame of order) {
    const envelope = parseSyncEnvelope(frame);
    expect(envelope.type).toBe("envelope_chunk");
    const chunk = parseSyncEnvelopeChunkPayload(envelope.payload);
    expect(chunk).not.toBeNull();
    const result = assembler.add(chunk!);
    if (result != null) reassembled = result;
  }
  expect(reassembled).not.toBeNull();
  return parseSyncEnvelope(reassembled!);
}

describe("encodeSyncEnvelopeFrames", () => {
  it("returns a single frame when the envelope fits the budget", () => {
    const frames = encodeSyncEnvelopeFrames({
      type: "chat_event",
      payload: { small: true },
      maxFrameBytes: DEFAULT_SYNC_MAX_FRAME_BYTES,
    });
    expect(frames).toHaveLength(1);
    expect(parseSyncEnvelope(frames[0]).type).toBe("chat_event");
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
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(DEFAULT_SYNC_MAX_FRAME_BYTES);
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
});

describe("parseSyncEnvelopeChunkPayload", () => {
  it("validates shape strictly", () => {
    expect(parseSyncEnvelopeChunkPayload(null)).toBeNull();
    expect(parseSyncEnvelopeChunkPayload({ chunkId: "a", index: 2, total: 2, part: "" })).toBeNull();
    expect(parseSyncEnvelopeChunkPayload({ chunkId: "", index: 0, total: 1, part: "" })).toBeNull();
    expect(parseSyncEnvelopeChunkPayload({ chunkId: "a", index: 0, total: 1, part: "abc" })).toEqual({
      chunkId: "a",
      index: 0,
      total: 1,
      part: "abc",
    });
  });
});
