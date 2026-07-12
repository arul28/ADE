import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiskPressureMonitor, DiskPressureState } from "./diskPressure";
import {
  createHistoryCompressor,
  reinflateHistoryFileSync,
  type CompressionCandidate,
} from "./historyCompression";
import { writeFileAtomic } from "../state/durableFile";

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

  it("re-inflates atomically before append and removes the compressed copy", () => {
    const plainPath = path.join(root, "resumed.jsonl");
    fs.writeFileSync(`${plainPath}.gz`, gzipSync("old\n"));

    expect(reinflateHistoryFileSync(plainPath, (targetPath, data) => writeFileAtomic(targetPath, data, { fsync: true }))).toBe(true);
    fs.appendFileSync(plainPath, "new\n");

    expect(fs.readFileSync(plainPath, "utf8")).toBe("old\nnew\n");
    expect(fs.existsSync(`${plainPath}.gz`)).toBe(false);
  });
});
