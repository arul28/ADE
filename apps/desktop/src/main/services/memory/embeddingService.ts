import { createHash } from "node:crypto";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";

export const DEFAULT_EMBEDDING_TASK = "feature-extraction" as const;
export const DEFAULT_EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EXPECTED_EMBEDDING_DIMENSIONS = 384;

type EmbeddingProgressEvent = {
  status?: string;
  file?: string;
  name?: string;
  progress?: number;
  loaded?: number;
  total?: number;
};

type EmbeddingTensorLike = {
  data?: ArrayLike<number>;
  dims?: number[];
};

type EmbeddingExtractor = ((input: string, options?: { pooling?: "mean"; normalize?: boolean }) => Promise<EmbeddingTensorLike | ArrayLike<number>>) & {
  dispose?: () => Promise<void>;
};

type TransformersRuntime = {
  env: {
    cacheDir: string;
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    useFSCache: boolean;
  };
  pipeline: (
    task: typeof DEFAULT_EMBEDDING_TASK,
    model: string,
    options?: { progress_callback?: (event: EmbeddingProgressEvent) => void },
  ) => Promise<EmbeddingExtractor>;
};

export type EmbeddingServiceStatus = {
  modelId: string;
  cacheDir: string;
  state: "idle" | "loading" | "ready" | "unavailable";
  progress: number | null;
  loaded: number | null;
  total: number | null;
  file: string | null;
  error: string | null;
  cacheEntries: number;
  cacheHits: number;
  cacheMisses: number;
};

type CreateEmbeddingServiceOpts = {
  logger: Pick<Logger, "info" | "warn" | "error">;
  cacheDir?: string;
  modelId?: string;
  loadRuntime?: () => Promise<TransformersRuntime>;
  onStatus?: (status: EmbeddingServiceStatus) => void;
};

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

function resolveCacheDir(cacheDir?: string): string {
  if (cacheDir) return path.resolve(cacheDir);
  return path.resolve(path.join(app.getPath("userData"), "transformers-cache"));
}

function cloneVector(vector: Float32Array): Float32Array {
  return new Float32Array(vector);
}

function toFloat32Array(value: ArrayLike<number>): Float32Array {
  if (value instanceof Float32Array) return cloneVector(value);
  if (ArrayBuffer.isView(value)) {
    return cloneVector(new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
  }

  const vector = Float32Array.from(value);
  return cloneVector(vector);
}

function validateVector(vector: Float32Array, dims?: readonly number[]): Float32Array {
  const lastDim = dims?.[dims.length - 1];
  if (typeof lastDim === "number" && lastDim !== EXPECTED_EMBEDDING_DIMENSIONS) {
    throw new Error(`expected ${EXPECTED_EMBEDDING_DIMENSIONS} embedding dimensions, received ${lastDim}`);
  }
  if (vector.length !== EXPECTED_EMBEDDING_DIMENSIONS) {
    throw new Error(`expected ${EXPECTED_EMBEDDING_DIMENSIONS} embedding values, received ${vector.length}`);
  }

  let hasNonZero = false;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error("embedding output contained non-finite values");
    }
    if (value !== 0) hasNonZero = true;
  }

  if (!hasNonZero) {
    throw new Error("embedding output was all zeros");
  }

  return vector;
}

async function loadTransformersRuntime(): Promise<TransformersRuntime> {
  return await import("@huggingface/transformers") as unknown as TransformersRuntime;
}

export function hashEmbeddingContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export type EmbeddingService = ReturnType<typeof createEmbeddingService>;

export function createEmbeddingService(opts: CreateEmbeddingServiceOpts) {
  const logger = opts.logger;
  const modelId = opts.modelId ?? DEFAULT_EMBEDDING_MODEL_ID;
  const cacheDir = resolveCacheDir(opts.cacheDir);
  const loadRuntime = opts.loadRuntime ?? loadTransformersRuntime;

  fs.mkdirSync(cacheDir, { recursive: true });

  const cache = new Map<string, Float32Array>();
  let cacheHits = 0;
  let cacheMisses = 0;
  let extractor: EmbeddingExtractor | null = null;
  let extractorPromise: Promise<EmbeddingExtractor> | null = null;
  let lastError: string | null = null;
  let state: EmbeddingServiceStatus["state"] = "idle";
  let progress: number | null = null;
  let loaded: number | null = null;
  let total: number | null = null;
  let file: string | null = null;

  function getStatus(): EmbeddingServiceStatus {
    return {
      modelId,
      cacheDir,
      state,
      progress,
      loaded,
      total,
      file,
      error: lastError,
      cacheEntries: cache.size,
      cacheHits,
      cacheMisses,
    };
  }

  function emitStatus() {
    try {
      opts.onStatus?.(getStatus());
    } catch (error) {
      logger.warn("memory.embedding.status_emit_failed", {
        modelId,
        cacheDir,
        error: getErrorMessage(error),
      });
    }
  }

  function handleProgress(event: EmbeddingProgressEvent) {
    progress = typeof event.progress === "number" && Number.isFinite(event.progress) ? event.progress : progress;
    loaded = typeof event.loaded === "number" && Number.isFinite(event.loaded) ? event.loaded : loaded;
    total = typeof event.total === "number" && Number.isFinite(event.total) ? event.total : total;
    file = typeof event.file === "string" && event.file.trim().length > 0
      ? event.file.trim()
      : typeof event.name === "string" && event.name.trim().length > 0
        ? event.name.trim()
        : file;

    if (state !== "ready") {
      state = "loading";
    }
    emitStatus();
  }

  async function ensureExtractor(forceRetry = false): Promise<EmbeddingExtractor> {
    if (extractor) return extractor;
    if (extractorPromise) return extractorPromise;
    if (forceRetry) {
      state = "idle";
      lastError = null;
      progress = null;
      loaded = null;
      total = null;
      file = null;
    }
    if (state === "unavailable" && lastError) {
      throw new EmbeddingUnavailableError(lastError);
    }

    state = "loading";
    progress = 0;
    loaded = null;
    total = null;
    file = null;
    lastError = null;
    emitStatus();
    const loadStartMs = Date.now();

    extractorPromise = (async () => {
      const runtime = await loadRuntime();
      runtime.env.cacheDir = cacheDir;
      runtime.env.allowLocalModels = true;
      runtime.env.allowRemoteModels = true;
      runtime.env.useFSCache = true;

      const nextExtractor = await runtime.pipeline(DEFAULT_EMBEDDING_TASK, modelId, {
        progress_callback: handleProgress,
      });

      extractor = nextExtractor;
      state = "ready";
      progress = 100;
      emitStatus();

      logger.info("memory.embedding.ready", {
        modelId,
        cacheDir,
        dimensions: EXPECTED_EMBEDDING_DIMENSIONS,
        loadTimeMs: Date.now() - loadStartMs,
      });

      return nextExtractor;
    })().catch((error) => {
      extractorPromise = null;
      extractor = null;
      state = "unavailable";
      lastError = getErrorMessage(error);
      progress = null;
      loaded = null;
      total = null;
      file = null;
      logger.warn("memory.embedding.load_failed", {
        modelId,
        cacheDir,
        error: lastError,
      });
      emitStatus();
      throw new EmbeddingUnavailableError(lastError);
    });

    return extractorPromise;
  }

  async function embed(text: string): Promise<Float32Array> {
    const content = String(text ?? "");
    const contentHash = hashEmbeddingContent(content);
    const cached = cache.get(contentHash);
    if (cached) {
      cacheHits += 1;
      emitStatus();
      return cloneVector(cached);
    }

    cacheMisses += 1;
    const activeExtractor = await ensureExtractor();
    const output = await activeExtractor(content, {
      pooling: "mean",
      normalize: true,
    });
    const vector = validateVector(
      toFloat32Array((output as EmbeddingTensorLike)?.data ?? (output as ArrayLike<number>)),
      (output as EmbeddingTensorLike)?.dims,
    );

    cache.set(contentHash, cloneVector(vector));
    emitStatus();
    return vector;
  }

  async function dispose() {
    const activeExtractor = extractor;
    extractor = null;
    extractorPromise = null;
    if (activeExtractor?.dispose) {
      await activeExtractor.dispose();
    }
  }

  async function preload(opts: { forceRetry?: boolean } = {}): Promise<void> {
    await ensureExtractor(opts.forceRetry === true);
  }

  let embeddingsProcessed = 0;
  const originalEmbed = embed;
  async function trackedEmbed(text: string): Promise<Float32Array> {
    const result = await originalEmbed(text);
    embeddingsProcessed += 1;
    return result;
  }

  let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  function startHealthCheck(intervalMs = 300_000) {
    if (healthCheckTimer) return;
    healthCheckTimer = setInterval(() => {
      const totalRequests = cacheHits + cacheMisses;
      const hitRate = totalRequests > 0 ? ((cacheHits / totalRequests) * 100).toFixed(1) : "0.0";
      logger.info("memory.embedding.health", {
        state,
        modelId,
        cacheEntries: cache.size,
        cacheHits,
        cacheMisses,
        cacheHitRate: `${hitRate}%`,
        embeddingsProcessed,
        error: lastError,
      });
    }, intervalMs);
  }

  function stopHealthCheck() {
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer);
      healthCheckTimer = null;
    }
  }

  return {
    embed: trackedEmbed,
    dispose,
    preload,
    getModelId: () => modelId,
    getStatus,
    hashContent: hashEmbeddingContent,
    isAvailable: () => state === "ready",
    startHealthCheck,
    stopHealthCheck,
  };
}
