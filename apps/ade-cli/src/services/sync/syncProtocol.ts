import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { SyncCompressionCodec, SyncEnvelope, SyncEnvelopeChunkPayload, SyncPeerPlatform, SyncProtocolVersion } from "../../../../desktop/src/shared/types";
import { safeJsonParse } from "../../../../desktop/src/main/services/shared/utils";

export const SYNC_PROTOCOL_VERSION: SyncProtocolVersion = 1;
export const DEFAULT_SYNC_HOST_PORT = 8787;
export const DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES = 4 * 1024;
export const MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES = 25 * 1024 * 1024;
export const RPC_DATA_CHUNK_BYTES = 256 * 1024;
export const FORWARD_DATA_CHUNK_BYTES = 64 * 1024;
export const PEER_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
export const BACKPRESSURE_POLL_MS = 25;
export const MAX_CHANNEL_ID_CHARS = 128;

/** Hello capability a client declares when it can reassemble envelope_chunk frames. */
export const SYNC_CHUNKED_ENVELOPES_CAPABILITY = "chunkedEnvelopes";

// URLSessionWebSocketTask buffers at most ~1 MiB per message by default and
// kills the whole connection ("Message too long") past that. Keep every frame
// comfortably under that even after the base64 + wrapper overhead of a chunk.
export const DEFAULT_SYNC_MAX_FRAME_BYTES = 720 * 1024;

export function decodeStrictBase64(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return null;
  }
  return Buffer.from(value, "base64");
}

export function normalizeChannelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > MAX_CHANNEL_ID_CHARS) return null;
  return /^[A-Za-z0-9._:-]+$/.test(id) ? id : null;
}

export function mapPlatform(platform: NodeJS.Platform): SyncPeerPlatform {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
}

export function wsDataToText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return String(data);
}

export type ParsedSyncEnvelope = {
  version: SyncProtocolVersion;
  type: SyncEnvelope["type"];
  projectId: string | null;
  requestId: string | null;
  compression: SyncCompressionCodec;
  payload: unknown;
  raw: SyncEnvelope;
};

type EncodeEnvelopeArgs = {
  type: SyncEnvelope["type"];
  projectId?: string | null;
  requestId?: string | null;
  payload: unknown;
  compressionThresholdBytes?: number;
};

function asSyncEnvelope(value: unknown): SyncEnvelope {
  return value as SyncEnvelope;
}

export function encodeSyncEnvelope(args: EncodeEnvelopeArgs): string {
  const payloadJson = JSON.stringify(args.payload ?? null);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const requestId = typeof args.requestId === "string" && args.requestId.trim().length > 0
    ? args.requestId.trim()
    : null;
  const projectId = typeof args.projectId === "string" && args.projectId.trim().length > 0
    ? args.projectId.trim()
    : null;
  const threshold = Math.max(0, Math.floor(args.compressionThresholdBytes ?? DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES));

  if (payloadBytes >= threshold) {
    const compressed = gzipSync(Buffer.from(payloadJson, "utf8"));
    return JSON.stringify(asSyncEnvelope({
      version: SYNC_PROTOCOL_VERSION,
      type: args.type,
      ...(projectId ? { projectId } : {}),
      requestId,
      compression: "gzip",
      payloadEncoding: "base64",
      payload: compressed.toString("base64"),
      uncompressedBytes: payloadBytes,
    }));
  }

  return JSON.stringify(asSyncEnvelope({
    version: SYNC_PROTOCOL_VERSION,
    type: args.type,
    ...(projectId ? { projectId } : {}),
    requestId,
    compression: "none",
    payloadEncoding: "json",
    payload: args.payload ?? null,
  }));
}

/**
 * Encode an envelope into one or more websocket frames. When the encoded
 * envelope exceeds `maxFrameBytes`, it is sliced into `envelope_chunk` frames
 * the client reassembles by concatenating base64 `part`s in `index` order.
 * Pass a null/undefined `maxFrameBytes` for peers that did not declare the
 * chunkedEnvelopes capability — they get the single full frame, same as today.
 */
export function encodeSyncEnvelopeFrames(
  args: EncodeEnvelopeArgs & { maxFrameBytes?: number | null },
): string[] {
  const encoded = encodeSyncEnvelope(args);
  const maxFrameBytes = args.maxFrameBytes ?? null;
  if (!maxFrameBytes || Buffer.byteLength(encoded, "utf8") <= maxFrameBytes) {
    return [encoded];
  }
  const raw = Buffer.from(encoded, "utf8");
  // Each part is base64 (4/3 expansion) inside a small JSON wrapper; budget
  // the decoded slice so the wrapped chunk frame stays under maxFrameBytes.
  const partBytes = Math.max(16 * 1024, Math.floor(((maxFrameBytes - 1024) * 3) / 4));
  const total = Math.ceil(raw.byteLength / partBytes);
  const chunkId = randomUUID();
  const frames: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const payload: SyncEnvelopeChunkPayload = {
      chunkId,
      index,
      total,
      part: raw.subarray(index * partBytes, Math.min(raw.byteLength, (index + 1) * partBytes)).toString("base64"),
    };
    frames.push(encodeSyncEnvelope({
      type: "envelope_chunk",
      requestId: args.requestId,
      payload,
      // base64 of (usually gzipped) data does not compress again.
      compressionThresholdBytes: Number.POSITIVE_INFINITY,
    }));
  }
  return frames;
}

export function parseSyncEnvelopeChunkPayload(payload: unknown): SyncEnvelopeChunkPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const chunkId = typeof record.chunkId === "string" && record.chunkId.trim() ? record.chunkId : null;
  const index = typeof record.index === "number" && Number.isInteger(record.index) && record.index >= 0 ? record.index : null;
  const total = typeof record.total === "number" && Number.isInteger(record.total) && record.total > 0 ? record.total : null;
  const part = typeof record.part === "string" ? record.part : null;
  if (chunkId == null || index == null || total == null || part == null || index >= total) return null;
  return { chunkId, index, total, part };
}

/**
 * Client-side reassembly helper: collects envelope_chunk payloads by chunkId
 * and returns the full encoded envelope text once every part has arrived.
 * Keeps only a handful of in-flight chunk ids so a malicious or broken host
 * cannot grow the buffer unboundedly.
 */
export function createSyncEnvelopeChunkAssembler(options: { maxConcurrentChunks?: number; maxTotalParts?: number } = {}) {
  const maxConcurrentChunks = options.maxConcurrentChunks ?? 8;
  const maxTotalParts = options.maxTotalParts ?? 512;
  const buffers = new Map<string, { total: number; parts: Map<number, string> }>();
  return {
    add(payload: SyncEnvelopeChunkPayload): string | null {
      if (payload.total > maxTotalParts) return null;
      let buffer = buffers.get(payload.chunkId);
      if (!buffer) {
        while (buffers.size >= maxConcurrentChunks) {
          const oldest = buffers.keys().next().value;
          if (oldest == null) break;
          buffers.delete(oldest);
        }
        buffer = { total: payload.total, parts: new Map() };
        buffers.set(payload.chunkId, buffer);
      }
      if (buffer.total !== payload.total) {
        buffers.delete(payload.chunkId);
        return null;
      }
      buffer.parts.set(payload.index, payload.part);
      if (buffer.parts.size < buffer.total) return null;
      buffers.delete(payload.chunkId);
      const segments: Buffer[] = [];
      for (let index = 0; index < buffer.total; index += 1) {
        const part = buffer.parts.get(index);
        if (part == null) return null;
        segments.push(Buffer.from(part, "base64"));
      }
      return Buffer.concat(segments).toString("utf8");
    },
    reset(): void {
      buffers.clear();
    },
  };
}

export function parseSyncEnvelope(rawText: string): ParsedSyncEnvelope {
  const decoded = safeJsonParse<SyncEnvelope | null>(rawText, null);
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid sync envelope JSON.");
  }
  if (decoded.version !== SYNC_PROTOCOL_VERSION) {
    throw new Error(`Unsupported sync protocol version: ${String((decoded as { version?: unknown }).version ?? "unknown")}`);
  }

  const requestId = typeof decoded.requestId === "string" && decoded.requestId.trim().length > 0
    ? decoded.requestId.trim()
    : null;
  const projectId = typeof decoded.projectId === "string" && decoded.projectId.trim().length > 0
    ? decoded.projectId.trim()
    : null;

  if (decoded.compression === "gzip") {
    if (decoded.payloadEncoding !== "base64" || typeof decoded.payload !== "string") {
      throw new Error("Compressed sync envelopes must use base64 payload encoding.");
    }
    if (
      typeof decoded.uncompressedBytes === "number"
      && decoded.uncompressedBytes > MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES
    ) {
      throw new Error(`Decoded sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`);
    }
    let uncompressedBuffer: Buffer;
    try {
      uncompressedBuffer = gunzipSync(Buffer.from(decoded.payload, "base64"), {
        maxOutputLength: MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES,
      });
    } catch (error) {
      throw new Error(`Failed to decode gzip sync envelope${requestId ? ` ${requestId}` : ""}${projectId ? ` for project ${projectId}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (uncompressedBuffer.byteLength > MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES) {
      throw new Error(`Decoded sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`);
    }
    if (
      typeof decoded.uncompressedBytes === "number"
      && decoded.uncompressedBytes !== uncompressedBuffer.byteLength
    ) {
      throw new Error("Decoded sync envelope size does not match declared uncompressedBytes.");
    }
    const uncompressed = uncompressedBuffer.toString("utf8");
    return {
      version: decoded.version,
      type: decoded.type,
      projectId,
      requestId,
      compression: "gzip",
      payload: safeJsonParse(uncompressed, null),
      raw: decoded,
    };
  }

  if (decoded.payloadEncoding !== "json") {
    throw new Error("Uncompressed sync envelopes must use JSON payload encoding.");
  }

  return {
    version: decoded.version,
    type: decoded.type,
    projectId,
    requestId,
    compression: "none",
    payload: decoded.payload,
    raw: decoded,
  };
}
