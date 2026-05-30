import { afterEach, describe, expect, it, vi } from "vitest";
import { streamFileBytes } from "./streamBytes";

/**
 * Simulate the backend readFileRange: each byte range is base64-encoded
 * INDEPENDENTLY. The chunk length is deliberately NOT a multiple of 3, which is
 * exactly the case where naively joining base64 strings and decoding once
 * corrupts the stream. streamFileBytes must reassemble the original bytes.
 */
function installReadFileRange(bytes: Uint8Array) {
  const readFileRange = vi.fn(async ({ offset, length }: { offset: number; length: number }) => {
    const start = Math.max(0, offset);
    const end = Math.min(bytes.length, start + length);
    const slice = bytes.subarray(start, end);
    let binary = "";
    for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]!);
    const content = btoa(binary);
    const nextOffset = end < bytes.length ? end : null;
    return { path: "x", encoding: "base64" as const, content, rangeStart: start, rangeEnd: end, totalSize: bytes.length, nextOffset, eof: nextOffset == null };
  });
  (globalThis as any).window = { ade: { files: { readFileRange } } };
  return readFileRange;
}

describe("streamFileBytes", () => {
  afterEach(() => {
    delete (globalThis as any).window;
    vi.restoreAllMocks();
  });

  it("reassembles bytes across non-3-aligned chunk boundaries (base64 padding case)", async () => {
    // 0..255 repeated — covers all byte values; length 256 is not a multiple of 3.
    const original = new Uint8Array(256 * 3);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;
    const readFileRange = installReadFileRange(original);

    // chunkLength 5 is NOT divisible by 3 → each non-final chunk's base64 is padded.
    const result = await streamFileBytes("ws", "x", { chunkLength: 5 });

    expect(result.length).toBe(original.length);
    expect(Array.from(result)).toEqual(Array.from(original));
    // Sanity: it actually streamed in many chunks (not one big read).
    expect(readFileRange.mock.calls.length).toBeGreaterThan(10);
  });

  it("handles an empty file", async () => {
    installReadFileRange(new Uint8Array());
    const result = await streamFileBytes("ws", "x", { chunkLength: 5 });
    expect(result.length).toBe(0);
  });

  it("handles a single full chunk", async () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    installReadFileRange(original);
    const result = await streamFileBytes("ws", "x", { chunkLength: 1024 });
    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
  });

  it("stops early when cancelled", async () => {
    const original = new Uint8Array(100);
    installReadFileRange(original);
    const result = await streamFileBytes("ws", "x", { chunkLength: 5, isCancelled: () => true });
    expect(result.length).toBe(0);
  });
});
