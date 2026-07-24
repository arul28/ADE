import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiskPressureMonitor, DiskPressureState } from "./diskPressure";
import {
  createHistoryCompressor,
  readHistoryFileRange,
  reinflateHistoryFile,
  type CompressionCandidate,
} from "./historyCompression";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function pressure(state: DiskPressureState = "normal"): DiskPressureMonitor {
  return {
    getSnapshot: () => ({
      state,
      freeBytes: 100 * 1024 ** 3,
      totalBytes: 200 * 1024 ** 3,
      freeFraction: 0.5,
      perRoot: [],
      sampledAt: new Date().toISOString(),
    }),
    canPerform: () => state === "critical" || state === "exhausted"
      ? { allowed: false, state, code: "disk_full", message: "full" }
      : { allowed: true, state },
    subscribe: () => () => {},
  };
}

describe("historyCompression", () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-history-compression-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function candidate(contents = "old history\n"): CompressionCandidate {
    const filePath = path.join(root, "history.jsonl");
    fs.writeFileSync(filePath, contents);
    return { path: filePath, bytes: Buffer.byteLength(contents), kind: "chat_transcript" };
  }

  it("compresses, verifies, and only then removes the identical original", async () => {
    const item = candidate("one\ntwo\nthree\n");
    const compressor = createHistoryCompressor({ logger, diskPressure: pressure(), isPathActive: () => false });

    const result = await compressor.compressOne(item);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(item.path)).toBe(false);
    expect(gunzipSync(fs.readFileSync(`${item.path}.gz`)).toString()).toBe("one\ntwo\nthree\n");
    expect(logger.info).toHaveBeenCalledWith("storage.history_compressed", expect.objectContaining({ path: item.path }));
  });

  it("keeps the original and removes the partial when verification detects mutated gzip input", async () => {
    const item = candidate("immutable history\n");
    const compressor = createHistoryCompressor({
      logger,
      diskPressure: pressure(),
      isPathActive: () => false,
      createGzipStream: () => new Transform({
        transform(chunk, _encoding, callback) {
          const changed = Buffer.from(chunk);
          changed[0] = changed[0]! ^ 0xff;
          callback(null, changed);
        },
      }),
    });

    expect((await compressor.compressOne(item)).reason).toBe("verification_failed");
    expect(fs.readFileSync(item.path, "utf8")).toBe("immutable history\n");
    expect(fs.existsSync(`${item.path}.gz.partial`)).toBe(false);
    expect(fs.existsSync(`${item.path}.gz`)).toBe(false);
  });

  it("refuses active paths, pressure, and low headroom", async () => {
    const active = candidate();
    expect((await createHistoryCompressor({ logger, isPathActive: () => true }).compressOne(active)).reason)
      .toBe("path_active");

    const pressured = candidate("pressure\n");
    expect((await createHistoryCompressor({ logger, diskPressure: pressure("critical"), isPathActive: () => false }).compressOne(pressured)).reason)
      .toBe("disk_pressure");

    const low = candidate("headroom\n");
    vi.spyOn(fs, "statfsSync").mockReturnValue({ bavail: 0n, bsize: 4096n } as unknown as ReturnType<typeof fs.statfsSync>);
    expect((await createHistoryCompressor({ logger, isPathActive: () => false }).compressOne(low)).reason)
      .toBe("insufficient_headroom");
  });

  it("removes the gzip and keeps the original if the path resumes before unlink", async () => {
    const item = candidate("resume race\n");
    let checks = 0;
    const compressor = createHistoryCompressor({
      logger,
      isPathActive: () => ++checks >= 2,
    });

    expect((await compressor.compressOne(item)).reason).toBe("path_resumed");
    expect(fs.readFileSync(item.path, "utf8")).toBe("resume race\n");
    expect(fs.existsSync(`${item.path}.gz`)).toBe(false);
  });

  it("bounds a sweep to 25 candidates in oldest-first order and skips critical pressure", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    for (let index = 0; index < 100; index += 1) {
      const filePath = path.join(root, `${String(index).padStart(3, "0")}.jsonl`);
      fs.writeFileSync(filePath, `${index}\n`);
      const timestamp = new Date(old.getTime() + index * 1_000);
      fs.utimesSync(filePath, timestamp, timestamp);
    }
    const compressor = createHistoryCompressor({
      logger,
      diskPressure: pressure(),
      isPathActive: () => false,
      betweenFilesDelayMs: 0,
    });

    const result = await compressor.runIdleSweep([{ path: root, kind: "chat_transcript" }]);

    expect(result.filesCompressed).toBe(25);
    expect(fs.existsSync(path.join(root, "000.jsonl.gz"))).toBe(true);
    expect(fs.existsSync(path.join(root, "024.jsonl.gz"))).toBe(true);
    expect(fs.existsSync(path.join(root, "025.jsonl"))).toBe(true);

    const blocked = createHistoryCompressor({ logger, diskPressure: pressure("critical"), isPathActive: () => false });
    expect(await blocked.runIdleSweep([{ path: root, kind: "chat_transcript" }])).toMatchObject({
      filesCompressed: 0,
      filesConsidered: 0,
    });
  });

  it("still compresses at warning-level pressure, where reclaiming space matters most", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    const filePath = path.join(root, "warn.jsonl");
    fs.writeFileSync(filePath, "reclaim me\n");
    fs.utimesSync(filePath, old, old);
    const compressor = createHistoryCompressor({
      logger,
      diskPressure: pressure("warning"),
      isPathActive: () => false,
      betweenFilesDelayMs: 0,
    });

    const result = await compressor.runIdleSweep([{ path: root, kind: "chat_transcript" }]);
    expect(result.filesCompressed).toBe(1);
    expect(fs.existsSync(`${filePath}.gz`)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("streams reinflation asynchronously before append", async () => {
    const plainPath = path.join(root, "resumed-async.jsonl");
    fs.writeFileSync(`${plainPath}.gz`, gzipSync("old\n"));

    await expect(reinflateHistoryFile(plainPath)).resolves.toBe(true);
    await fs.promises.appendFile(plainPath, "new\n");

    expect(fs.readFileSync(plainPath, "utf8")).toBe("old\nnew\n");
    expect(fs.existsSync(`${plainPath}.gz`)).toBe(false);
  });

  it("admits at most one gzip inflation and lets the newest delayed request win", async () => {
    const firstPath = path.join(root, "first.jsonl.gz");
    const secondPath = path.join(root, "second.jsonl.gz");
    fs.writeFileSync(firstPath, gzipSync("first\n".repeat(10_000)));
    fs.writeFileSync(secondPath, gzipSync("second\n".repeat(10_000)));
    const originalCreateReadStream = fs.createReadStream.bind(fs);
    let activeGzipStreams = 0;
    let maxActiveGzipStreams = 0;
    const readStreamSpy = vi.spyOn(fs, "createReadStream").mockImplementation(((...args: Parameters<typeof fs.createReadStream>) => {
      const stream = originalCreateReadStream(...args);
      if (!String(args[0]).endsWith(".gz")) return stream;
      activeGzipStreams += 1;
      maxActiveGzipStreams = Math.max(maxActiveGzipStreams, activeGzipStreams);
      stream.once("close", () => {
        activeGzipStreams -= 1;
      });
      return stream;
    }) as typeof fs.createReadStream);

    try {
      const [first, second] = await Promise.allSettled([
        readHistoryFileRange(firstPath, 0, 64),
        readHistoryFileRange(secondPath, 0, 64),
      ]);
      expect(second.status).toBe("fulfilled");
      if (second.status === "fulfilled") {
        expect(second.value.toString("utf8")).toContain("second");
      }
      if (first.status === "rejected") {
        expect(first.reason).toMatchObject({ message: "compressed_history_read_superseded" });
      } else {
        expect(first.value.toString("utf8")).toContain("first");
      }
      expect(maxActiveGzipStreams).toBe(1);
    } finally {
      readStreamSpy.mockRestore();
    }
  });

  it("retains only the requested window for a high-compression-ratio archive", async () => {
    const logical = Buffer.alloc(8 * 1024 * 1024, 0x78);
    const compressedPath = path.join(root, "large.jsonl.gz");
    fs.writeFileSync(compressedPath, gzipSync(logical));
    const readFileSpy = vi.spyOn(fs.promises, "readFile");
    const length = 64 * 1024;

    const range = await readHistoryFileRange(
      compressedPath,
      logical.length - length,
      length,
    );

    expect(range).toHaveLength(length);
    expect(range.equals(logical.subarray(logical.length - length))).toBe(true);
    expect(readFileSpy.mock.calls.some(([filePath]) => filePath === compressedPath)).toBe(false);
  });

  it("inflates a large archive once and serves later ranges from the bounded disk cache", async () => {
    const logical = Buffer.alloc(8 * 1024 * 1024, 0x7a);
    const compressedPath = path.join(root, "paged-large.jsonl.gz");
    fs.writeFileSync(compressedPath, gzipSync(logical));
    const readStreamSpy = vi.spyOn(fs, "createReadStream");

    for (let page = 0; page < 8; page += 1) {
      const range = await readHistoryFileRange(
        compressedPath,
        page * 64 * 1024,
        64 * 1024,
      );
      expect(range).toHaveLength(64 * 1024);
    }

    expect(
      readStreamSpy.mock.calls.filter(([filePath]) => filePath === compressedPath),
    ).toHaveLength(1);
  });

  it("serves a validated small-cache hit while an unrelated large inflate is admitted", async () => {
    const cachedPath = path.join(root, "cached.jsonl.gz");
    const largePath = path.join(root, "blocked-large.jsonl.gz");
    fs.writeFileSync(cachedPath, gzipSync("cached\n".repeat(1_000)));
    const largeCompressed = gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x79));
    fs.writeFileSync(largePath, largeCompressed);
    await readHistoryFileRange(cachedPath, 0, 64);

    const originalCreateReadStream = fs.createReadStream.bind(fs);
    const blockedStream = new PassThrough();
    let markLargeStreamStarted: (() => void) | null = null;
    const largeStreamStarted = new Promise<void>((resolve) => {
      markLargeStreamStarted = resolve;
    });
    const readStreamSpy = vi.spyOn(fs, "createReadStream").mockImplementation(((...args: Parameters<typeof fs.createReadStream>) => {
      if (String(args[0]) === largePath) {
        markLargeStreamStarted?.();
        return blockedStream as unknown as fs.ReadStream;
      }
      return originalCreateReadStream(...args);
    }) as typeof fs.createReadStream);

    try {
      const largeRead = readHistoryFileRange(largePath, 0, 64);
      await largeStreamStarted;
      await expect(readHistoryFileRange(cachedPath, 0, 64))
        .resolves.toEqual(Buffer.from("cached\n".repeat(1_000)).subarray(0, 64));
      blockedStream.end(largeCompressed);
      await expect(largeRead).resolves.toHaveLength(64);
    } finally {
      blockedStream.destroy();
      readStreamSpy.mockRestore();
    }
  });

  it("aborts obsolete large materialization so the next archive can enter", async () => {
    const obsoletePath = path.join(root, "obsolete-large.jsonl.gz");
    const nextPath = path.join(root, "next-large.jsonl.gz");
    const logical = Buffer.alloc(5 * 1024 * 1024, 0x71);
    fs.writeFileSync(obsoletePath, gzipSync(logical));
    fs.writeFileSync(nextPath, gzipSync(logical));
    const originalCreateReadStream = fs.createReadStream.bind(fs);
    const blockedStream = new PassThrough();
    let markObsoleteStarted: (() => void) | null = null;
    const obsoleteStarted = new Promise<void>((resolve) => {
      markObsoleteStarted = resolve;
    });
    const readStreamSpy = vi.spyOn(fs, "createReadStream").mockImplementation(((...args: Parameters<typeof fs.createReadStream>) => {
      if (String(args[0]) === obsoletePath) {
        markObsoleteStarted?.();
        return blockedStream as unknown as fs.ReadStream;
      }
      return originalCreateReadStream(...args);
    }) as typeof fs.createReadStream);
    const controller = new AbortController();

    try {
      const obsoleteRead = readHistoryFileRange(obsoletePath, 0, 64, controller.signal);
      await obsoleteStarted;
      const nextRead = readHistoryFileRange(nextPath, 0, 64);
      controller.abort();
      await expect(obsoleteRead).rejects.toMatchObject({ name: "AbortError" });
      await expect(nextRead).resolves.toHaveLength(64);
    } finally {
      blockedStream.destroy();
      readStreamSpy.mockRestore();
    }
  });

  it("drops superseded queued inflations and materializes only the newest destination", async () => {
    const activePath = path.join(root, "active-large.jsonl.gz");
    const supersededPath = path.join(root, "superseded-large.jsonl.gz");
    const currentPath = path.join(root, "current-large.jsonl.gz");
    const logical = Buffer.alloc(5 * 1024 * 1024, 0x72);
    const compressed = gzipSync(logical);
    fs.writeFileSync(activePath, compressed);
    fs.writeFileSync(supersededPath, compressed);
    fs.writeFileSync(currentPath, compressed);
    const originalCreateReadStream = fs.createReadStream.bind(fs);
    const blockedStream = new PassThrough();
    let markActiveStarted = () => {};
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });
    const openedPaths: string[] = [];
    const readStreamSpy = vi.spyOn(fs, "createReadStream").mockImplementation(((...args: Parameters<typeof fs.createReadStream>) => {
      const filePath = String(args[0]);
      if (filePath.endsWith(".gz")) openedPaths.push(filePath);
      if (filePath === activePath) {
        markActiveStarted();
        return blockedStream as unknown as fs.ReadStream;
      }
      return originalCreateReadStream(...args);
    }) as typeof fs.createReadStream);

    try {
      const activeRead = readHistoryFileRange(activePath, 0, 64);
      await activeStarted;
      const supersededRead = readHistoryFileRange(supersededPath, 0, 64);
      const supersededOutcome = supersededRead.catch((error) => error);
      const currentRead = readHistoryFileRange(currentPath, 0, 64);
      await expect(supersededOutcome).resolves.toMatchObject({
        message: "compressed_history_read_superseded",
      });
      blockedStream.end(compressed);
      await expect(activeRead).resolves.toHaveLength(64);
      await expect(currentRead).resolves.toHaveLength(64);
      expect(openedPaths).toEqual([activePath, currentPath]);
    } finally {
      blockedStream.destroy();
      readStreamSpy.mockRestore();
    }
  });

  it("fills a requested range across short FileHandle reads", async () => {
    const source = Buffer.from("abcdefgh", "utf8");
    const close = vi.fn(async () => {});
    const read = vi.fn(async (
      target: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      const bytesRead = Math.min(2, length, source.length - position);
      if (bytesRead > 0) source.copy(target, offset, position, position + bytesRead);
      return { bytesRead, buffer: target };
    });
    const openSpy = vi.spyOn(fs.promises, "open").mockResolvedValue({
      read,
      close,
    } as unknown as Awaited<ReturnType<typeof fs.promises.open>>);

    try {
      await expect(readHistoryFileRange("/virtual/history.jsonl", 1, 6))
        .resolves.toEqual(Buffer.from("bcdefg", "utf8"));
      expect(read).toHaveBeenCalledTimes(3);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      openSpy.mockRestore();
    }
  });
});
