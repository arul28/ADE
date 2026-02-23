import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileLogger } from "./logger";

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(25);
  }
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  delete process.env.ADE_LOG_LEVEL;
});

describe("createFileLogger", () => {
  it("defaults to info and still records warn/error", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-logger-level-"));
    const logFile = path.join(tmpDir, "main.jsonl");
    const logger = createFileLogger(logFile);

    logger.debug("debug.suppressed");
    logger.info("info.recorded");
    logger.warn("warn.recorded");
    logger.error("error.recorded");

    await waitFor(() => readJsonLines(logFile).length >= 3);
    const lines = readJsonLines(logFile);
    const events = lines.map((line) => String(line.event ?? ""));

    expect(events).toContain("info.recorded");
    expect(events).toContain("warn.recorded");
    expect(events).toContain("error.recorded");
    expect(events).not.toContain("debug.suppressed");
  });

  it("records debug when ADE_LOG_LEVEL=debug", async () => {
    process.env.ADE_LOG_LEVEL = "debug";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-logger-debug-"));
    const logFile = path.join(tmpDir, "main.jsonl");
    const logger = createFileLogger(logFile);

    logger.debug("debug.enabled");

    await waitFor(() => readJsonLines(logFile).length >= 1);
    const lines = readJsonLines(logFile);
    expect(lines.some((line) => String(line.event ?? "") === "debug.enabled")).toBe(true);
  });

  it("rotates to main.1.jsonl when the file exceeds 10MB", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-logger-rotation-"));
    const logFile = path.join(tmpDir, "main.jsonl");
    const rotatedFile = path.join(tmpDir, "main.1.jsonl");
    const logger = createFileLogger(logFile);
    const payload = "x".repeat(16 * 1024);

    for (let i = 0; i < 1300; i++) {
      logger.info("rotation.check", { i, payload });
    }

    await waitFor(() => fs.existsSync(rotatedFile));
    await delay(700);

    const currentSize = fs.statSync(logFile).size;
    const rotatedSize = fs.statSync(rotatedFile).size;

    expect(rotatedSize).toBeGreaterThan(0);
    expect(currentSize).toBeLessThan(MAX_LOG_FILE_BYTES);
  });
});
