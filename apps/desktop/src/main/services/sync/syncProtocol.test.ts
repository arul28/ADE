import { describe, expect, it } from "vitest";
import { encodeSyncEnvelope, parseSyncEnvelope } from "./syncProtocol";

describe("syncProtocol", () => {
  it("preserves request ids and leaves small payloads uncompressed", () => {
    const encoded = encodeSyncEnvelope({
      type: "heartbeat",
      requestId: "req-1",
      payload: {
        kind: "ping",
        sentAt: "2026-03-15T00:00:00.000Z",
        dbVersion: 4,
      },
      compressionThresholdBytes: 10_000,
    });

    const parsed = parseSyncEnvelope(encoded);
    expect(parsed.type).toBe("heartbeat");
    expect(parsed.requestId).toBe("req-1");
    expect(parsed.compression).toBe("none");
    expect(parsed.payload).toEqual({
      kind: "ping",
      sentAt: "2026-03-15T00:00:00.000Z",
      dbVersion: 4,
    });
  });

  it("compresses large payloads and restores them transparently", () => {
    const payload = {
      reason: "broadcast",
      fromDbVersion: 1,
      toDbVersion: 2,
      changes: Array.from({ length: 40 }, (_, index) => ({
        table: "kv",
        pk: `key-${index}`,
        cid: "value",
        val: "x".repeat(300),
        col_version: index + 1,
        db_version: index + 1,
        site_id: "abcdef0123456789abcdef0123456789",
        cl: index + 1,
        seq: 0,
      })),
    };

    const encoded = encodeSyncEnvelope({
      type: "changeset_batch",
      requestId: "req-large",
      payload,
      compressionThresholdBytes: 256,
    });

    const wire = JSON.parse(encoded) as { compression: string; payloadEncoding: string };
    expect(wire.compression).toBe("gzip");
    expect(wire.payloadEncoding).toBe("base64");

    const parsed = parseSyncEnvelope(encoded);
    expect(parsed.requestId).toBe("req-large");
    expect(parsed.compression).toBe("gzip");
    expect(parsed.payload).toEqual(payload);
  });
});
