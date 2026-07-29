import { randomUUID } from "node:crypto";
import { deflateSync, gunzipSync, gzipSync, inflateSync } from "node:zlib";
import {
  SYNC_CHUNKED_ENVELOPES_CAPABILITY,
  type SyncCompressionCodec,
  type SyncEnvelope,
  type SyncEnvelopeChunkPayload,
  type SyncHelloErrorPayload,
  type SyncPeerPlatform,
  type SyncProtocolVersion,
} from "../../../../desktop/src/shared/types";
import { safeJsonParse } from "../../../../desktop/src/main/services/shared/utils";

export const SYNC_PROTOCOL_VERSION: SyncProtocolVersion = 1;
export const SYNC_PROTOCOL_MIN_SUPPORTED = 1;
export const SYNC_PROTOCOL_VERSION_MISMATCH_CLOSE_CODE = 4406;
export const DEFAULT_SYNC_HOST_PORT = 8787;
export const SYNC_HOST_MAX_PORT = 8999;
export const DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES = 4 * 1024;
export const MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES = 25 * 1024 * 1024;
export const RPC_DATA_CHUNK_BYTES = 256 * 1024;
export const FORWARD_DATA_CHUNK_BYTES = 64 * 1024;
export const PEER_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
export const BACKPRESSURE_POLL_MS = 25;
export const MAX_CHANNEL_ID_CHARS = 128;

/** Hello capability a client declares when it can reassemble envelope_chunk frames. */
export { SYNC_CHUNKED_ENVELOPES_CAPABILITY };

/** Hello capability for paired desktop clients that consume only rpc/fwd envelopes. */
export const SYNC_RUNTIME_ONLY_CAPABILITY = "runtimeOnly";

// URLSessionWebSocketTask buffers at most ~1 MiB per message by default and
// kills the whole connection ("Message too long") past that. Keep every frame
// comfortably under that even after the base64 + wrapper overhead of a chunk.
export const DEFAULT_SYNC_MAX_FRAME_BYTES = 720 * 1024;
export const SYNC_ENVELOPE_CHUNK_REASSEMBLY_TIMEOUT_MS = 30_000;

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

export class SyncProtocolVersionMismatchError extends Error {
  readonly code = "protocol_version_mismatch";
  readonly updateTarget: "client" | "host";

  constructor(
    readonly receivedVersion: number,
    readonly requestId: string | null,
  ) {
    const updateTarget = receivedVersion < SYNC_PROTOCOL_MIN_SUPPORTED ? "client" : "host";
    const supported = SYNC_PROTOCOL_MIN_SUPPORTED === SYNC_PROTOCOL_VERSION
      ? String(SYNC_PROTOCOL_VERSION)
      : `${SYNC_PROTOCOL_MIN_SUPPORTED}-${SYNC_PROTOCOL_VERSION}`;
    super(
      `Sync protocol version ${receivedVersion} is incompatible with this ADE host (supported: ${supported}).`,
    );
    this.name = "SyncProtocolVersionMismatchError";
    this.updateTarget = updateTarget;
  }

  toHelloErrorPayload(): SyncHelloErrorPayload {
    return {
      code: this.code,
      message: this.message,
      receivedVersion: this.receivedVersion,
      currentVersion: SYNC_PROTOCOL_VERSION,
      minSupportedVersion: SYNC_PROTOCOL_MIN_SUPPORTED,
      updateTarget: this.updateTarget,
    };
  }
}

type EncodeEnvelopeArgs = {
  type: SyncEnvelope["type"];
  projectId?: string | null;
  requestId?: string | null;
  payload: unknown;
  compressionThresholdBytes?: number;
  /**
   * Defaults to legacy gzip so existing callers and non-negotiating peers
   * retain byte-for-byte wire behavior.
   */
  compressionCodec?: Exclude<SyncCompressionCodec, "none"> | "none";
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
  const compressionCodec = args.compressionCodec ?? "gzip";

  if (compressionCodec !== "none" && payloadBytes >= threshold) {
    const compressed = compressionCodec === "deflate"
      ? deflateSync(Buffer.from(payloadJson, "utf8"))
      : gzipSync(Buffer.from(payloadJson, "utf8"));
    return JSON.stringify(asSyncEnvelope({
      version: SYNC_PROTOCOL_VERSION,
      type: args.type,
      ...(projectId ? { projectId } : {}),
      requestId,
      compression: compressionCodec,
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
      compressionCodec: "none",
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
export function createSyncEnvelopeChunkAssembler(options: {
  maxConcurrentChunks?: number;
  maxTotalParts?: number;
  maxEnvelopeBytes?: number;
  timeoutMs?: number;
} = {}) {
  const maxConcurrentChunks = options.maxConcurrentChunks ?? 8;
  const maxTotalParts = options.maxTotalParts ?? 512;
  const maxEnvelopeBytes = options.maxEnvelopeBytes ?? 32 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? SYNC_ENVELOPE_CHUNK_REASSEMBLY_TIMEOUT_MS;
  const buffers = new Map<string, {
    total: number;
    parts: Map<number, Buffer>;
    bytes: number;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  const remove = (chunkId: string): void => {
    const buffer = buffers.get(chunkId);
    if (!buffer) return;
    clearTimeout(buffer.timeout);
    buffers.delete(chunkId);
  };

  return {
    add(payload: SyncEnvelopeChunkPayload): string | null {
      if (payload.total > maxTotalParts) return null;
      const decodedPart = decodeStrictBase64(payload.part);
      if (!decodedPart || decodedPart.byteLength > maxEnvelopeBytes) {
        remove(payload.chunkId);
        return null;
      }
      let buffer = buffers.get(payload.chunkId);
      if (!buffer) {
        while (buffers.size >= maxConcurrentChunks) {
          const oldest = buffers.keys().next().value;
          if (oldest == null) break;
          remove(oldest);
        }
        const timeout = setTimeout(() => remove(payload.chunkId), timeoutMs);
        timeout.unref?.();
        buffer = { total: payload.total, parts: new Map(), bytes: 0, timeout };
        buffers.set(payload.chunkId, buffer);
      }
      if (buffer.total !== payload.total) {
        remove(payload.chunkId);
        return null;
      }
      const previous = buffer.parts.get(payload.index);
      const nextBytes = buffer.bytes - (previous?.byteLength ?? 0) + decodedPart.byteLength;
      if (nextBytes > maxEnvelopeBytes) {
        remove(payload.chunkId);
        return null;
      }
      buffer.parts.set(payload.index, decodedPart);
      buffer.bytes = nextBytes;
      if (buffer.parts.size < buffer.total) return null;
      remove(payload.chunkId);
      const segments: Buffer[] = [];
      for (let index = 0; index < buffer.total; index += 1) {
        const part = buffer.parts.get(index);
        if (part == null) return null;
        segments.push(part);
      }
      return Buffer.concat(segments).toString("utf8");
    },
    reset(): void {
      for (const chunkId of buffers.keys()) remove(chunkId);
    },
    pendingCount(): number {
      return buffers.size;
    },
  };
}

export function parseSyncEnvelope(rawText: string): ParsedSyncEnvelope {
  const decoded = safeJsonParse<SyncEnvelope | null>(rawText, null);
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid sync envelope JSON.");
  }
  const receivedVersion = (decoded as { version?: unknown }).version;
  if (
    typeof receivedVersion === "number"
    && Number.isInteger(receivedVersion)
    && (
      receivedVersion < SYNC_PROTOCOL_MIN_SUPPORTED
      || receivedVersion > SYNC_PROTOCOL_VERSION
    )
  ) {
    const rawRequestId = (decoded as { requestId?: unknown }).requestId;
    throw new SyncProtocolVersionMismatchError(
      receivedVersion,
      typeof rawRequestId === "string" && rawRequestId.trim() ? rawRequestId.trim() : null,
    );
  }
  if (receivedVersion !== SYNC_PROTOCOL_VERSION) {
    throw new Error(`Invalid sync protocol version: ${String(receivedVersion ?? "unknown")}`);
  }

  const requestId = typeof decoded.requestId === "string" && decoded.requestId.trim().length > 0
    ? decoded.requestId.trim()
    : null;
  const projectId = typeof decoded.projectId === "string" && decoded.projectId.trim().length > 0
    ? decoded.projectId.trim()
    : null;

  if (decoded.compression === "gzip" || decoded.compression === "deflate") {
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
      const compressed = Buffer.from(decoded.payload, "base64");
      uncompressedBuffer = decoded.compression === "deflate"
        ? inflateSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES })
        : gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES });
    } catch (error) {
      throw new Error(`Failed to decode ${decoded.compression} sync envelope${requestId ? ` ${requestId}` : ""}${projectId ? ` for project ${projectId}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
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
      compression: decoded.compression,
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
