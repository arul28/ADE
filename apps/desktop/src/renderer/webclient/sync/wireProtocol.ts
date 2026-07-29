import type {
  SyncApplicationCompressionCodec,
  SyncEnvelope,
  SyncEnvelopeChunkPayload,
  SyncMobileProjectSummary,
  SyncProjectCatalogChunkPayload,
  SyncProjectCatalogPayload,
} from "../../../shared/types/sync";

export const SYNC_PROTOCOL_VERSION = 1;
export const MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES = 25 * 1024 * 1024;

export type EncodeEnvelopeInput = {
  type: SyncEnvelope["type"];
  projectId?: string | null;
  requestId?: string | null;
  payload?: unknown;
};

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  throw new Error("No base64 decoder is available.");
}

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    const chunkBytes = 32 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkBytes));
    }
    return btoa(binary);
  }
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  throw new Error("No base64 encoder is available.");
}

async function decompressWithCap(
  compressed: Uint8Array,
  codec: SyncApplicationCompressionCodec | "gzip",
): Promise<Uint8Array> {
  if (compressed.byteLength > MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES) {
    throw new Error(`Compressed sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`);
  }
  if (typeof DecompressionStream !== "function") {
    throw new Error(`This browser does not support ${codec} sync envelopes.`);
  }
  const transform = new DecompressionStream(codec) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  }).pipeThrough(transform);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // ignore cancellation failures from already-failed streams
      }
      throw new Error(`Decoded sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`);
    }
    chunks.push(value);
  }
  return concatBytes(chunks, total);
}

async function compress(
  uncompressed: Uint8Array,
  codec: SyncApplicationCompressionCodec,
): Promise<Uint8Array> {
  if (typeof CompressionStream !== "function") {
    throw new Error(`This browser does not support ${codec} sync envelopes.`);
  }
  const transform = new CompressionStream(codec) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const compressed = await new Response(
    new Blob([uncompressed]).stream().pipeThrough(transform),
  ).arrayBuffer();
  return new Uint8Array(compressed);
}

export function encodeEnvelopeText(envelope: EncodeEnvelopeInput): string {
  const requestId = normalizeOptionalString(envelope.requestId);
  const projectId = normalizeOptionalString(envelope.projectId);
  return JSON.stringify({
    version: SYNC_PROTOCOL_VERSION,
    type: envelope.type,
    ...(projectId ? { projectId } : {}),
    requestId,
    compression: "none",
    payloadEncoding: "json",
    payload: envelope.payload ?? null,
  } as SyncEnvelope);
}

export async function encodeEnvelopeTextWithCompression(
  envelope: EncodeEnvelopeInput,
  negotiation: {
    codec: SyncApplicationCompressionCodec;
    thresholdBytes: number;
  } | null,
): Promise<string> {
  if (!negotiation) return encodeEnvelopeText(envelope);
  const payloadJson = JSON.stringify(envelope.payload ?? null);
  const payloadBytes = new TextEncoder().encode(payloadJson);
  if (payloadBytes.byteLength < negotiation.thresholdBytes) {
    return encodeEnvelopeText(envelope);
  }
  const requestId = normalizeOptionalString(envelope.requestId);
  const projectId = normalizeOptionalString(envelope.projectId);
  const compressed = await compress(payloadBytes, negotiation.codec);
  return JSON.stringify({
    version: SYNC_PROTOCOL_VERSION,
    type: envelope.type,
    ...(projectId ? { projectId } : {}),
    requestId,
    compression: negotiation.codec,
    payloadEncoding: "base64",
    payload: bytesToBase64(compressed),
    uncompressedBytes: payloadBytes.byteLength,
  } as SyncEnvelope);
}

export async function decodeEnvelopeText(text: string): Promise<SyncEnvelope> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid sync envelope JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Invalid sync envelope JSON.");
  }
  const envelope = decoded as SyncEnvelope;
  if (envelope.version !== SYNC_PROTOCOL_VERSION) {
    throw new Error(`Unsupported sync protocol version: ${String((decoded as { version?: unknown }).version ?? "unknown")}`);
  }
  if (envelope.compression === "gzip" || envelope.compression === "deflate") {
    if (envelope.payloadEncoding !== "base64" || typeof envelope.payload !== "string") {
      throw new Error("Compressed sync envelopes must use base64 payload encoding.");
    }
    if (
      typeof envelope.uncompressedBytes === "number"
      && envelope.uncompressedBytes > MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES
    ) {
      throw new Error(`Decoded sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`);
    }
    const uncompressed = await decompressWithCap(
      base64ToBytes(envelope.payload),
      envelope.compression,
    );
    if (
      typeof envelope.uncompressedBytes === "number"
      && envelope.uncompressedBytes !== uncompressed.byteLength
    ) {
      throw new Error("Decoded sync envelope size does not match declared uncompressedBytes.");
    }
    const payloadText = new TextDecoder().decode(uncompressed);
    return {
      ...envelope,
      compression: "none",
      payloadEncoding: "json",
      payload: JSON.parse(payloadText),
    } as SyncEnvelope;
  }
  if (envelope.compression !== "none") {
    throw new Error(`Unsupported sync envelope compression: ${String((envelope as { compression?: unknown }).compression)}`);
  }
  if (envelope.payloadEncoding !== "json") {
    throw new Error("Uncompressed sync envelopes must use JSON payload encoding.");
  }
  return envelope;
}

export function parseEnvelopeChunkPayload(payload: unknown): SyncEnvelopeChunkPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Partial<SyncEnvelopeChunkPayload>;
  const chunkId = typeof value.chunkId === "string" && value.chunkId.trim() ? value.chunkId : null;
  const index = typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0 ? value.index : null;
  const total = typeof value.total === "number" && Number.isInteger(value.total) && value.total > 0 ? value.total : null;
  const part = typeof value.part === "string" ? value.part : null;
  if (!chunkId || index == null || total == null || !part || index >= total) return null;
  return { chunkId, index, total, part };
}

export function createEnvelopeChunkAssembler(options: { maxConcurrentChunks?: number; maxTotalParts?: number } = {}) {
  const maxConcurrentChunks = options.maxConcurrentChunks ?? 8;
  const maxTotalParts = options.maxTotalParts ?? 512;
  const chunks = new Map<string, { total: number; parts: Map<number, string> }>();
  return {
    add(payload: SyncEnvelopeChunkPayload): string | null {
      if (payload.total > maxTotalParts) return null;
      let entry = chunks.get(payload.chunkId);
      if (!entry) {
        while (chunks.size >= maxConcurrentChunks) {
          const oldest = chunks.keys().next().value;
          if (oldest == null) break;
          chunks.delete(oldest);
        }
        entry = { total: payload.total, parts: new Map() };
        chunks.set(payload.chunkId, entry);
      }
      if (entry.total !== payload.total) {
        chunks.delete(payload.chunkId);
        return null;
      }
      entry.parts.set(payload.index, payload.part);
      if (entry.parts.size < entry.total) return null;
      chunks.delete(payload.chunkId);
      const bytes: Uint8Array[] = [];
      let totalBytes = 0;
      for (let index = 0; index < entry.total; index += 1) {
        const part = entry.parts.get(index);
        if (!part) return null;
        const decoded = base64ToBytes(part);
        bytes.push(decoded);
        totalBytes += decoded.byteLength;
      }
      return new TextDecoder().decode(concatBytes(bytes, totalBytes));
    },
    reset(): void {
      chunks.clear();
    },
  };
}

export function assembleProjectCatalogChunks(chunks: SyncProjectCatalogChunkPayload[]): SyncProjectCatalogPayload | null {
  if (chunks.length === 0) return null;
  const catalogId = chunks[0].catalogId;
  const total = chunks[0].total;
  if (!catalogId || !Number.isInteger(total) || total <= 0) return null;
  const byIndex = new Map<number, SyncProjectCatalogChunkPayload>();
  for (const chunk of chunks) {
    if (chunk.catalogId !== catalogId || chunk.total !== total || chunk.index < 0 || chunk.index >= total) return null;
    byIndex.set(chunk.index, chunk);
  }
  if (byIndex.size !== total) return null;
  const projects: SyncMobileProjectSummary[] = [];
  for (let index = 0; index < total; index += 1) {
    const chunk = byIndex.get(index);
    if (!chunk) return null;
    projects.push(...chunk.projects);
  }
  return { projects };
}

export function createProjectCatalogChunkAssembler(options: { maxCatalogs?: number } = {}) {
  const maxCatalogs = options.maxCatalogs ?? 4;
  const catalogs = new Map<string, Map<number, SyncProjectCatalogChunkPayload>>();
  return {
    add(chunk: SyncProjectCatalogChunkPayload): SyncProjectCatalogPayload | null {
      if (!chunk.catalogId || chunk.total <= 0 || chunk.index < 0 || chunk.index >= chunk.total) return null;
      let catalog = catalogs.get(chunk.catalogId);
      if (!catalog) {
        while (catalogs.size >= maxCatalogs) {
          const oldest = catalogs.keys().next().value;
          if (oldest == null) break;
          catalogs.delete(oldest);
        }
        catalog = new Map();
        catalogs.set(chunk.catalogId, catalog);
      }
      catalog.set(chunk.index, chunk);
      if (catalog.size < chunk.total && !chunk.done) return null;
      const assembled = assembleProjectCatalogChunks(Array.from(catalog.values()));
      if (assembled) catalogs.delete(chunk.catalogId);
      return assembled;
    },
    reset(): void {
      catalogs.clear();
    },
  };
}
