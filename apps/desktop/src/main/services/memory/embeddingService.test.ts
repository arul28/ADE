import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createEmbeddingService,
  DEFAULT_EMBEDDING_MODEL_ID,
  DEFAULT_EMBEDDING_TASK,
  EXPECTED_EMBEDDING_DIMENSIONS,
} from "./embeddingService";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function buildVector(seed: string): Float32Array {
  const chars = Array.from(seed).map((value) => value.charCodeAt(0));
  const base = chars.reduce((sum, value, index) => sum + value * (index + 1), 17);
  const vector = new Float32Array(EXPECTED_EMBEDDING_DIMENSIONS);

  for (let index = 0; index < vector.length; index += 1) {
    const raw = Math.sin(base + index / 13) + Math.cos(base / 7 + index / 17);
    vector[index] = raw / 2;
  }

  return vector;
}

function createTempCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-embedding-cache-"));
}

function writeInstalledModel(cacheDir: string) {
  const modelDir = path.join(cacheDir, "Xenova", "all-MiniLM-L6-v2");
  fs.mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
  fs.writeFileSync(path.join(modelDir, "config.json"), "{}");
  fs.writeFileSync(path.join(modelDir, "tokenizer.json"), "{}");
  fs.writeFileSync(path.join(modelDir, "tokenizer_config.json"), "{}");
  fs.writeFileSync(path.join(modelDir, "onnx", "model.onnx"), "model");
  return modelDir;
}

type ProgressCallback = (event: { file?: string; progress?: number; loaded?: number; total?: number }) => void;

describe("embeddingService", () => {
  it("loads the MiniLM pipeline on first use and returns a 384-d embedding", async () => {
    const logger = createLogger();
    const extractor = Object.assign(
      vi.fn(async (text: string) => ({ data: buildVector(text), dims: [1, EXPECTED_EMBEDDING_DIMENSIONS] })),
      { dispose: vi.fn(async () => {}) },
    );
    const env = {
      cacheDir: "",
      allowRemoteModels: false,
      allowLocalModels: false,
      useFSCache: false,
    };
    const pipeline = vi.fn(async () => extractor);
    const loadRuntime = vi.fn(async () => ({ env, pipeline }));

    const service = createEmbeddingService({
      logger,
      cacheDir: "/tmp/ade-embedding-cache",
      loadRuntime,
    });

    const embedding = await service.embed("Memory embeddings stay local.");

    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenNthCalledWith(
      1,
      "ADE embedding verification probe",
      expect.objectContaining({ pooling: "mean", normalize: true }),
    );
    expect(extractor).toHaveBeenNthCalledWith(
      2,
      "Memory embeddings stay local.",
      expect.objectContaining({ pooling: "mean", normalize: true }),
    );
    expect(pipeline).toHaveBeenCalledWith(
      DEFAULT_EMBEDDING_TASK,
      DEFAULT_EMBEDDING_MODEL_ID,
      expect.objectContaining({ progress_callback: expect.any(Function) }),
    );
    expect(env.cacheDir).toBe("/tmp/ade-embedding-cache");
    expect(env.allowLocalModels).toBe(true);
    expect(env.allowRemoteModels).toBe(true);
    expect(env.useFSCache).toBe(true);
    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding).toHaveLength(EXPECTED_EMBEDDING_DIMENSIONS);
    expect(Array.from(embedding).every(Number.isFinite)).toBe(true);
    expect(Array.from(embedding).some((value) => value !== 0)).toBe(true);
    expect(service.isAvailable()).toBe(true);
    expect(service.getStatus()).toEqual(
      expect.objectContaining({
        state: "ready",
        cacheDir: "/tmp/ade-embedding-cache",
        cacheEntries: 1,
        cacheHits: 0,
        cacheMisses: 1,
      }),
    );
  });

  it("reuses the sha256 content cache to avoid re-inference", async () => {
    const logger = createLogger();
    const extractor = Object.assign(
      vi.fn(async (text: string) => ({ data: buildVector(text), dims: [1, EXPECTED_EMBEDDING_DIMENSIONS] })),
      { dispose: vi.fn(async () => {}) },
    );
    const pipeline = vi.fn(async () => extractor);

    const service = createEmbeddingService({
      logger,
      cacheDir: "/tmp/ade-embedding-cache",
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline,
      }),
    });

    const first = await service.embed("same content");
    const second = await service.embed("same content");
    const third = await service.embed("different content");

    expect(extractor).toHaveBeenCalledTimes(3);
    expect(Array.from(second)).toEqual(Array.from(first));
    expect(Array.from(third)).not.toEqual(Array.from(first));
    expect(service.hashContent("same content")).toBe(service.hashContent("same content"));
    expect(service.hashContent("same content")).not.toBe(service.hashContent("different content"));
    expect(service.getStatus()).toEqual(
      expect.objectContaining({
        cacheEntries: 2,
        cacheHits: 1,
        cacheMisses: 2,
      }),
    );
  });

  it("marks the model unavailable and logs a warning when pipeline creation fails", async () => {
    const logger = createLogger();
    const service = createEmbeddingService({
      logger,
      cacheDir: "/tmp/ade-embedding-cache",
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline: vi.fn(async () => {
          throw new Error("transformers bootstrap failed");
        }),
      }),
    });

    await expect(service.embed("this should degrade gracefully")).rejects.toThrow(
      "transformers bootstrap failed",
    );

    expect(service.isAvailable()).toBe(false);
    expect(service.getStatus()).toEqual(
      expect.objectContaining({
        state: "unavailable",
        error: "transformers bootstrap failed",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "memory.embedding.load_failed",
      expect.objectContaining({ error: "transformers bootstrap failed" }),
    );
  });

  it("keeps the model unavailable when the smoke-test inference fails", async () => {
    const logger = createLogger();
    const cacheDir = createTempCacheDir();
    writeInstalledModel(cacheDir);
    const extractor = Object.assign(
      vi.fn(async () => ({ data: new Float32Array(EXPECTED_EMBEDDING_DIMENSIONS), dims: [1, EXPECTED_EMBEDDING_DIMENSIONS] })),
      { dispose: vi.fn(async () => {}) },
    );
    const service = createEmbeddingService({
      logger,
      cacheDir,
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline: vi.fn(async () => extractor),
      }),
    });

    await expect(service.preload({ forceRetry: true, localFilesOnly: true })).rejects.toThrow(
      "The installed local model files are incompatible or corrupted. Download the model again to repair the cache.",
    );

    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "unavailable",
      activity: "error",
      installState: "installed",
      error: "The installed local model files are incompatible or corrupted. Download the model again to repair the cache.",
    }));
  });

  it("reports an installed local model path and loads from local cache during probe", async () => {
    const logger = createLogger();
    const cacheDir = createTempCacheDir();
    const installPath = writeInstalledModel(cacheDir);
    const extractor = Object.assign(
      vi.fn(async (text: string) => ({ data: buildVector(text), dims: [1, EXPECTED_EMBEDDING_DIMENSIONS] })),
      { dispose: vi.fn(async () => {}) },
    );
    const pipeline = vi.fn(async (_task, _model, options?: { progress_callback?: (event: { file?: string; progress?: number }) => void }) => {
      options?.progress_callback?.({ file: "tokenizer.json", progress: 100 });
      return extractor;
    });

    const service = createEmbeddingService({
      logger,
      cacheDir,
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline,
      }),
    });

    expect(service.getStatus()).toEqual(expect.objectContaining({
      installState: "installed",
      installPath,
      activity: "idle",
      state: "idle",
    }));

    await service.probeCache();

    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(pipeline.mock.calls[0]?.[1]).toBe(installPath);
    expect(pipeline.mock.calls[0]?.[2]).toBeDefined();
    expect(service.getStatus()).toEqual(expect.objectContaining({
      installState: "installed",
      installPath,
      activity: "ready",
      state: "ready",
    }));
  });

  it("does not auto-download from a partial cache during startup probing", async () => {
    const logger = createLogger();
    const cacheDir = createTempCacheDir();
    const modelDir = path.join(cacheDir, "Xenova", "all-MiniLM-L6-v2");
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "tokenizer.json"), "{}");
    const pipeline = vi.fn(async () => {
      throw new Error("pipeline should not run for partial installs");
    });

    const service = createEmbeddingService({
      logger,
      cacheDir,
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline,
      }),
    });

    await service.probeCache();

    expect(pipeline).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual(expect.objectContaining({
      installState: "partial",
      installPath: modelDir,
      activity: "idle",
      state: "idle",
    }));
  });

  it("reports loading-local while a fully installed model is still initializing", async () => {
    const logger = createLogger();
    const cacheDir = createTempCacheDir();
    const installPath = writeInstalledModel(cacheDir);
    let releasePipeline: (() => void) | null = null;
    let resolvePipelineStarted: (() => void) | null = null;
    const pipelineStarted = new Promise<void>((resolve) => {
      resolvePipelineStarted = resolve;
    });
    const pipeline = vi.fn(async () => {
      resolvePipelineStarted?.();
      await new Promise<void>((resolve) => {
        releasePipeline = resolve;
      });
      return Object.assign(
        vi.fn(async (text: string) => ({ data: buildVector(text), dims: [1, EXPECTED_EMBEDDING_DIMENSIONS] })),
        { dispose: vi.fn(async () => {}) },
      );
    });

    const service = createEmbeddingService({
      logger,
      cacheDir,
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline,
      }),
    });

    const preloadPromise = service.preload({ forceRetry: true });
    await pipelineStarted;

    expect(service.getStatus()).toEqual(expect.objectContaining({
      installState: "installed",
      installPath,
      state: "loading",
      activity: "loading-local",
    }));

    expect(releasePipeline).toBeTypeOf("function");
    releasePipeline!();
    await preloadPromise;
  });

  it("does not revert back to loading when stale progress events arrive after a load failure", async () => {
    const logger = createLogger();
    let capturedProgress: ProgressCallback | null = null;
    const service = createEmbeddingService({
      logger,
      cacheDir: createTempCacheDir(),
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline: vi.fn(async (_task, _model, options) => {
          capturedProgress = options?.progress_callback ?? null;
          throw new Error("Protobuf parsing failed");
        }),
      }),
    });

    await expect(service.preload({ forceRetry: true })).rejects.toThrow("Protobuf parsing failed");

    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "unavailable",
      activity: "error",
      error: "Protobuf parsing failed",
    }));

    if (capturedProgress) {
      (capturedProgress as ProgressCallback)({ file: "tokenizer.json", progress: 100, loaded: 711661, total: 711661 });
    }

    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "unavailable",
      activity: "error",
      error: "Protobuf parsing failed",
    }));
  });

  it("ignores stale progress callbacks from an earlier load attempt after forceRetry", async () => {
    const logger = createLogger();
    let firstProgress: ProgressCallback | null = null;
    let secondProgress: ProgressCallback | null = null;
    let releaseSecondAttempt: (() => void) | null = null;
    let resolveSecondStarted: (() => void) | null = null;
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecondStarted = resolve;
    });
    const extractor = Object.assign(
      vi.fn(async (text: string) => ({ data: buildVector(text), dims: [1, EXPECTED_EMBEDDING_DIMENSIONS] })),
      { dispose: vi.fn(async () => {}) },
    );
    const loadRuntime = vi
      .fn()
      .mockResolvedValueOnce({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline: vi.fn(async (_task, _model, options) => {
          firstProgress = options?.progress_callback ?? null;
          throw new Error("first attempt failed");
        }),
      })
      .mockResolvedValueOnce({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline: vi.fn(async (_task, _model, options) => {
          secondProgress = options?.progress_callback ?? null;
          resolveSecondStarted?.();
          await new Promise<void>((resolve) => {
            releaseSecondAttempt = resolve;
          });
          return extractor;
        }),
      });

    const service = createEmbeddingService({
      logger,
      cacheDir: createTempCacheDir(),
      loadRuntime,
    });

    await expect(service.preload({ forceRetry: true })).rejects.toThrow("first attempt failed");

    const secondAttempt = service.preload({ forceRetry: true });
    await secondStarted;

    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "loading",
      activity: "downloading",
      progress: 0,
      file: null,
    }));

    expect(firstProgress).toBeTypeOf("function");
    const staleProgress = firstProgress as unknown as ProgressCallback;
    staleProgress({ file: "stale-tokenizer.json", progress: 97, loaded: 97, total: 100 });
    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "loading",
      activity: "downloading",
      progress: 0,
      file: null,
    }));

    expect(secondProgress).toBeTypeOf("function");
    const currentProgress = secondProgress as unknown as ProgressCallback;
    currentProgress({ file: "current-tokenizer.json", progress: 12, loaded: 12, total: 100 });
    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "loading",
      activity: "downloading",
      progress: 12,
      file: "current-tokenizer.json",
    }));

    expect(releaseSecondAttempt).toBeTypeOf("function");
    releaseSecondAttempt!();
    await secondAttempt;
  });

  it("rejects an in-flight load that finishes after dispose and keeps the service idle", async () => {
    const logger = createLogger();
    let releasePipeline: (() => void) | null = null;
    let resolvePipelineStarted: (() => void) | null = null;
    const pipelineStarted = new Promise<void>((resolve) => {
      resolvePipelineStarted = resolve;
    });
    const extractor = Object.assign(
      vi.fn(async (text: string) => ({ data: buildVector(text), dims: [1, EXPECTED_EMBEDDING_DIMENSIONS] })),
      { dispose: vi.fn(async () => {}) },
    );
    const service = createEmbeddingService({
      logger,
      cacheDir: createTempCacheDir(),
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline: vi.fn(async () => {
          resolvePipelineStarted?.();
          await new Promise<void>((resolve) => {
            releasePipeline = resolve;
          });
          return extractor;
        }),
      }),
    });

    const preloadPromise = service.preload({ forceRetry: true });
    await pipelineStarted;

    await service.dispose();

    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "idle",
      activity: "idle",
      progress: null,
      error: null,
    }));

    expect(releasePipeline).toBeTypeOf("function");
    releasePipeline!();
    await expect(preloadPromise).rejects.toThrow("Embedding extractor load became stale.");

    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    expect(service.isAvailable()).toBe(false);
    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "idle",
      activity: "idle",
      progress: null,
      error: null,
    }));
  });

  it("clears the installed cache after disposing an active extractor", async () => {
    const logger = createLogger();
    const cacheDir = createTempCacheDir();
    const installPath = writeInstalledModel(cacheDir);
    const extractor = Object.assign(
      vi.fn(async (text: string) => ({ data: buildVector(text), dims: [1, EXPECTED_EMBEDDING_DIMENSIONS] })),
      { dispose: vi.fn(async () => {}) },
    );
    const service = createEmbeddingService({
      logger,
      cacheDir,
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline: vi.fn(async () => extractor),
      }),
    });

    await service.preload({ forceRetry: true, localFilesOnly: true });
    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "ready",
      installState: "installed",
      installPath,
    }));

    await service.clearCache();

    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(installPath)).toBe(false);
    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "idle",
      activity: "idle",
      installState: "missing",
      error: null,
    }));
  });

  it("invalidates an in-flight load before removing cached model files", async () => {
    const logger = createLogger();
    const cacheDir = createTempCacheDir();
    const installPath = writeInstalledModel(cacheDir);
    let releasePipeline: (() => void) | null = null;
    let resolvePipelineStarted: (() => void) | null = null;
    const pipelineStarted = new Promise<void>((resolve) => {
      resolvePipelineStarted = resolve;
    });
    const extractor = Object.assign(
      vi.fn(async (text: string) => ({ data: buildVector(text), dims: [1, EXPECTED_EMBEDDING_DIMENSIONS] })),
      { dispose: vi.fn(async () => {}) },
    );
    const service = createEmbeddingService({
      logger,
      cacheDir,
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline: vi.fn(async () => {
          resolvePipelineStarted?.();
          await new Promise<void>((resolve) => {
            releasePipeline = resolve;
          });
          return extractor;
        }),
      }),
    });

    const preloadPromise = service.preload({ forceRetry: true, localFilesOnly: true });
    await pipelineStarted;

    await service.clearCache();

    expect(fs.existsSync(installPath)).toBe(false);
    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "idle",
      activity: "idle",
      installState: "missing",
      error: null,
    }));

    expect(releasePipeline).toBeTypeOf("function");
    releasePipeline!();
    await expect(preloadPromise).rejects.toThrow("Embedding extractor load became stale.");
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
  });

  it("re-checks the install state after a failed download before normalizing the error", async () => {
    const logger = createLogger();
    const cacheDir = createTempCacheDir();

    const service = createEmbeddingService({
      logger,
      cacheDir,
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline: vi.fn(async () => {
          writeInstalledModel(cacheDir);
          return Object.assign(
            vi.fn(async () => ({
              data: new Float32Array(EXPECTED_EMBEDDING_DIMENSIONS - 1),
              dims: [1, EXPECTED_EMBEDDING_DIMENSIONS - 1],
            })),
            {
              dispose: vi.fn(async () => {}),
            },
          );
        }),
      }),
    });

    await expect(service.preload({ forceRetry: true })).rejects.toThrow(
      "The installed local model files are incompatible or corrupted. Download the model again to repair the cache.",
    );

    expect(service.getStatus()).toEqual(expect.objectContaining({
      state: "unavailable",
      error: "The installed local model files are incompatible or corrupted. Download the model again to repair the cache.",
    }));
  });

  it("rejects model IDs that escape the cache directory", () => {
    expect(() => createEmbeddingService({
      logger: createLogger(),
      cacheDir: createTempCacheDir(),
      modelId: "../outside",
      loadRuntime: async () => ({
        env: {
          cacheDir: "",
          allowRemoteModels: true,
          allowLocalModels: true,
          useFSCache: true,
        },
        pipeline: vi.fn(),
      }),
    })).toThrow("Invalid embedding model ID segment: ..");
  });
});
