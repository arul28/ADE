import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  parseUsageLedgerWorkerResult,
  scanUsageLedgersInWorker,
} from "./usageLedgerWorkerClient";

function resultJson(): string {
  return JSON.stringify({
    costs: [{ provider: "codex", todayCostUsd: 1, last30dCostUsd: 2, tokenBreakdown: {} }],
    projectCosts: [],
    daily7d: { codex: [0, 0, 0, 0, 0, 0, 10] },
    entryCounts: { codex: 1 },
    providerErrors: {},
  });
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  child.pid = 1234;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

describe("usage ledger worker client", () => {
  it("validates compact worker results", () => {
    expect(parseUsageLedgerWorkerResult(resultJson())).toMatchObject({
      entryCounts: { codex: 1 },
      daily7d: { codex: [0, 0, 0, 0, 0, 0, 10] },
    });
    expect(() => parseUsageLedgerWorkerResult(JSON.stringify({ costs: "invalid" }))).toThrow(
      "invalid result",
    );
  });

  it("streams input and resolves a successful worker result", async () => {
    const child = fakeChild();
    let input = "";
    child.stdin.on("data", (chunk) => { input += chunk.toString(); });
    const spawnWorker = vi.fn(() => child);
    const promise = scanUsageLedgersInWorker("/repo", {
      workerPath: __filename,
      spawnWorker: spawnWorker as never,
    });
    child.stdout.end(resultJson());
    child.emit("close", 0, null);

    await expect(promise).resolves.toMatchObject({ entryCounts: { codex: 1 } });
    expect(JSON.parse(input)).toEqual({ projectRoot: "/repo" });
    expect(spawnWorker).toHaveBeenCalledWith(
      process.execPath,
      [__filename],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  it("cancels the worker without waiting for its timeout", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const promise = scanUsageLedgersInWorker(null, {
      signal: controller.signal,
      workerPath: __filename,
      spawnWorker: (() => child) as never,
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects non-zero exits with bounded stderr context", async () => {
    const child = fakeChild();
    const promise = scanUsageLedgersInWorker(null, {
      workerPath: __filename,
      spawnWorker: (() => child) as never,
    });
    child.stderr.end("scanner failed");
    child.emit("close", 1, null);

    await expect(promise).rejects.toThrow("scanner failed");
  });
});
