import { createHash } from "node:crypto";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";

export const DEFAULT_EMBEDDING_TASK = "feature-extraction" as const;
export const DEFAULT_EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EXPECTED_EMBEDDING_DIMENSIONS = 384;
const EMBEDDING_SMOKE_TEST_INPUT = "ADE embedding verification probe";
const REQUIRED_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  path.join("onnx", "model.onnx"),
] as const;

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
    options?: { progress_callback?: (event: EmbeddingProgressEvent) => void; local_files_only?: boolean },
  ) => Promise<EmbeddingExtractor>;
};

export type EmbeddingServiceStatus = {
  modelId: string;
  cacheDir: string;
  installPath: string;
  installState: "missing" | "partial" | "installed";
  state: "idle" | "loading" | "ready" | "unavailable";
  activity: "idle" | "loading-local" | "downloading" | "ready" | "error";
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

function resolveInstallPath(cacheDir: string, modelId: string): string {
  const resolvedCacheDir = path.resolve(cacheDir);
  const segments = modelId.split(/[\\/]/);
  const safeSegments: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || path.isAbsolute(segment)) {
      throw new Error(`Invalid embedding model ID segment: ${segment || "(empty)"}`);
    }
    safeSegments.push(segment);
  }

  const installPath = path.resolve(resolvedCacheDir, ...safeSegments);
  const cacheDirPrefix = resolvedCacheDir.endsWith(path.sep)
    ? resolvedCacheDir
    : `${resolvedCacheDir}${path.sep}`;
  if (installPath !== resolvedCacheDir && !installPath.startsWith(cacheDirPrefix)) {
    throw new Error(`Embedding model install path escaped the cache dir: ${modelId}`);
  }
  return installPath;
}

function inspectInstallPath(installPath: string): {
  installState: EmbeddingServiceStatus["installState"];
} {
  if (!fs.existsSync(installPath)) {
    return { installState: "missing" };
  }

  const presentRequiredFiles = REQUIRED_MODEL_FILES.filter((relativePath) =>
    fs.existsSync(path.join(installPath, relativePath)),
  );

  if (presentRequiredFiles.length === REQUIRED_MODEL_FILES.length) {
    return { installState: "installed" };
  }

  return { installState: "partial" };
}

function deriveReportedActivity(args: {
  state: EmbeddingServiceStatus["state"];
  activity: EmbeddingServiceStatus["activity"];
  installState: EmbeddingServiceStatus["installState"];
}): EmbeddingServiceStatus["activity"] {
  if (args.state === "ready") return "ready";
  if (args.state === "unavailable") return "error";
  if (args.state !== "loading") return "idle";
  if (args.installState === "installed") return "loading-local";
  if (args.activity === "loading-local" || args.activity === "downloading") return args.activity;
  return "downloading";
}

function normalizeLoadError(args: {
  message: string;
  installState: EmbeddingServiceStatus["installState"];
  localFilesOnly: boolean;
}): string {
  const message = args.message.trim();
  if ((args.localFilesOnly || args.installState === "installed") && /protobuf parsing failed/i.test(message)) {
    return "The installed local model files are corrupted. Download the model again to repair the cache.";
  }
  if (
    (args.localFilesOnly || args.installState === "installed")
    && (/expected 384 embedding/i.test(message) || /embedding output/i.test(message))
  ) {
    return "The installed local model files are incompatible or corrupted. Download the model again to repair the cache.";
  }
  return message;
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

async function runExtractorSmokeTest(activeExtractor: EmbeddingExtractor): Promise<void> {
  const output = await activeExtractor(EMBEDDING_SMOKE_TEST_INPUT, {
    pooling: "mean",
    normalize: true,
  });
  validateVector(
    toFloat32Array((output as EmbeddingTensorLike)?.data ?? (output as ArrayLike<number>)),
    (output as EmbeddingTensorLike)?.dims,
  );
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
  const installPath = resolveInstallPath(cacheDir, modelId);
  const loadRuntime = opts.loadRuntime ?? loadTransformersRuntime;

  fs.mkdirSync(cacheDir, { recursive: true });

  const cache = new Map<string, Float32Array>();
  let cacheHits = 0;
  let cacheMisses = 0;
  let extractor: EmbeddingExtractor | null = null;
  let extractorPromise: Promise<EmbeddingExtractor> | null = null;
  let lastError: string | null = null;
  let state: EmbeddingServiceStatus["state"] = "idle";
  let activity: EmbeddingServiceStatus["activity"] = "idle";
  let progress: number | null = null;
  let loaded: number | null = null;
  let total: number | null = null;
  let file: string | null = null;
  let cachedInstall = inspectInstallPath(installPath);
  let loadAttemptId = 0;

  function refreshCachedInstall() {
    cachedInstall = inspectInstallPath(installPath);
    return cachedInstall;
  }

  function getStatus(): EmbeddingServiceStatus {
    return {
      modelId,
      cacheDir,
      installPath,
      installState: cachedInstall.installState,
      state,
      activity: deriveReportedActivity({
        state,
        activity,
        installState: cachedInstall.installState,
      }),
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

  function finiteOrKeep(value: number | undefined, current: number | null): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : current;
  }

  function isCurrentLoadAttempt(attemptId: number): boolean {
    return attemptId === loadAttemptId;
  }

  function handleProgress(event: EmbeddingProgressEvent, attemptId: number) {
    if (!isCurrentLoadAttempt(attemptId)) {
      return;
    }
    // Transformers.js may emit late file progress events even after the model
    // session creation has already failed. Do not let those stale events revive
    // the service back into a loading state.
    if (state === "unavailable" || activity === "error") {
      return;
    }

    progress = finiteOrKeep(event.progress, progress);
    loaded = finiteOrKeep(event.loaded, loaded);
    total = finiteOrKeep(event.total, total);

    const eventFile = event.file?.trim() || event.name?.trim() || null;
    if (eventFile) file = eventFile;

    if (state !== "ready") {
      state = "loading";
    }
    emitStatus();
  }

  function createStaleLoadError(): Error {
    return new Error("Embedding extractor load became stale.");
  }

  async function disposeExtractorSafely(
    candidate: EmbeddingExtractor | null,
    logEvent: "memory.embedding.dispose_failed_after_smoke_test" | "memory.embedding.dispose_failed_after_stale_load",
  ) {
    if (!candidate?.dispose) return;
    try {
      await candidate.dispose();
    } catch (disposeError) {
      logger.warn(logEvent, {
        modelId,
        cacheDir,
        error: getErrorMessage(disposeError),
      });
    }
  }

  async function ensureExtractor(opts: {
    forceRetry?: boolean;
    localFilesOnly?: boolean;
    installInspection?: ReturnType<typeof inspectInstallPath>;
  } = {}): Promise<EmbeddingExtractor> {
    const forceRetry = opts.forceRetry === true;
    const localFilesOnly = opts.localFilesOnly === true;
    if (extractor) return extractor;
    if (extractorPromise) return extractorPromise;
    if (forceRetry) {
      loadAttemptId += 1;
      state = "idle";
      activity = "idle";
      lastError = null;
      progress = null;
      loaded = null;
      total = null;
      file = null;
    }
    if (state === "unavailable" && lastError) {
      throw new EmbeddingUnavailableError(lastError);
    }

    if (!forceRetry) {
      loadAttemptId += 1;
    }
    const attemptId = loadAttemptId;
    const install = opts.installInspection ?? refreshCachedInstall();
    state = "loading";
    activity = localFilesOnly || install.installState === "installed" ? "loading-local" : "downloading";
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
      runtime.env.allowRemoteModels = !localFilesOnly;
      runtime.env.useFSCache = true;

      let nextExtractor: EmbeddingExtractor | null = null;
      try {
        const loadedExtractor = await runtime.pipeline(
          DEFAULT_EMBEDDING_TASK,
          localFilesOnly ? installPath : modelId,
          {
          progress_callback: (event) => handleProgress(event, attemptId),
          local_files_only: localFilesOnly,
          },
        );
        nextExtractor = loadedExtractor;

        await runExtractorSmokeTest(loadedExtractor);
        cachedInstall = localFilesOnly ? install : refreshCachedInstall();
        if (!isCurrentLoadAttempt(attemptId)) {
          await disposeExtractorSafely(loadedExtractor, "memory.embedding.dispose_failed_after_stale_load");
          nextExtractor = null;
          throw createStaleLoadError();
        }
        extractor = loadedExtractor;
      } catch (error) {
        await disposeExtractorSafely(nextExtractor, "memory.embedding.dispose_failed_after_smoke_test");
        throw error;
      }
      if (!isCurrentLoadAttempt(attemptId)) {
        if (extractor === nextExtractor) {
          extractor = null;
        }
        await disposeExtractorSafely(nextExtractor, "memory.embedding.dispose_failed_after_stale_load");
        throw createStaleLoadError();
      }
      state = "ready";
      activity = "ready";
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
      if (!isCurrentLoadAttempt(attemptId)) {
        throw error;
      }
      extractorPromise = null;
      extractor = null;
      state = "unavailable";
      activity = "error";
      const freshInstall = refreshCachedInstall();
      lastError = normalizeLoadError({
        message: getErrorMessage(error),
        installState: freshInstall.installState,
        localFilesOnly,
      });
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
    loadAttemptId += 1;
    const activeExtractor = extractor;
    extractor = null;
    extractorPromise = null;
    state = "idle";
    activity = "idle";
    lastError = null;
    progress = null;
    loaded = null;
    total = null;
    file = null;
    emitStatus();
    if (activeExtractor?.dispose) {
      await activeExtractor.dispose();
    }
  }

  async function preload(opts: { forceRetry?: boolean; localFilesOnly?: boolean } = {}): Promise<void> {
    await ensureExtractor({ forceRetry: opts.forceRetry === true, localFilesOnly: opts.localFilesOnly === true });
  }

  /**
   * Check if the model files exist in the cache dir and auto-load if so.
   * Call this at startup so that previously-downloaded models are recognized
   * without requiring the user to click "Download Model" again.
   */
  async function probeCache(): Promise<void> {
    if (state === "ready" || state === "loading") return;
    try {
      const install = refreshCachedInstall();
      if (install.installState !== "installed") {
        logger.info("memory.embedding.probe_cache_skipped", {
          modelId,
          cacheDir,
          installPath,
          installState: install.installState,
        });
        return;
      }
      logger.info("memory.embedding.probe_cache", { modelId, cacheDir, installPath });
      await ensureExtractor({ localFilesOnly: true, installInspection: install });
    } catch (error) {
      // Probe is best-effort — don't block startup
      logger.warn("memory.embedding.probe_cache_failed", {
        modelId,
        error: getErrorMessage(error),
      });
    }
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
    probeCache,
    getModelId: () => modelId,
    getStatus,
    hashContent: hashEmbeddingContent,
    isAvailable: () => state === "ready",
    startHealthCheck,
    stopHealthCheck,
  };
}
