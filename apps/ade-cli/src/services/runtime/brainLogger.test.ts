import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrainLogger } from "./brainLogger";

const tempDirs: string[] = [];

async function waitForFile(filePath: string): Promise<void> {
  await vi.waitFor(() => {
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).size).toBeGreaterThan(0);
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("createBrainLogger", () => {
  it("writes timestamped JSONL, rotates at the configured cap, and prefixes stderr mirrors", async () => {
    vi.stubEnv("ADE_LOG_LEVEL", "info");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-brain-logger-"));
    tempDirs.push(tempDir);
    const logPath = path.join(tempDir, "brain.jsonl");
    const rotatedPath = path.join(tempDir, "brain.1.jsonl");
    const stderrWrite = vi.fn(() => true);
    const logger = createBrainLogger(logPath, {
      maxFileBytes: 180,
      flushBatchSize: 1,
      flushIntervalMs: 5,
      rotationCheckWriteInterval: 1,
      now: () => new Date("2026-07-23T16:00:00.000Z"),
      stderr: {
        write: stderrWrite,
      } as unknown as Pick<NodeJS.WriteStream, "write">,
    });

    logger.info("brain.started", { detail: "x".repeat(160) });
    await waitForFile(logPath);
    logger.warn("account.machine_publish_failed", { code: "token_timeout" });
    await waitForFile(rotatedPath);
    await vi.waitFor(() => {
      expect(fs.readFileSync(logPath, "utf8")).toContain(
        "account.machine_publish_failed",
      );
    });

    const current = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    const rotated = JSON.parse(fs.readFileSync(rotatedPath, "utf8").trim());
    expect(current).toMatchObject({
      level: "warn",
      event: "account.machine_publish_failed",
      meta: { code: "token_timeout" },
    });
    expect(Date.parse(current.ts)).not.toBeNaN();
    expect(rotated).toMatchObject({
      level: "info",
      event: "brain.started",
    });
    expect(stderrWrite).toHaveBeenCalledWith(
      "[2026-07-23T16:00:00.000Z] WARN account.machine_publish_failed {\"code\":\"token_timeout\"}\n",
    );
  });
});
