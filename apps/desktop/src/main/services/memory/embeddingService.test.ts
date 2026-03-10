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

    expect(extractor).toHaveBeenCalledTimes(2);
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
});
