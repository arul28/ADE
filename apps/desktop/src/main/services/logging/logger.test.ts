import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileLogger } from "./logger";

const ORIGINAL_VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const ORIGINAL_ADE_STDIO_TRANSPORT = process.env.ADE_STDIO_TRANSPORT;
const ORIGINAL_IS_TTY_DESCRIPTOR = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function restoreStdoutIsTty() {
  if (ORIGINAL_IS_TTY_DESCRIPTOR) {
    Object.defineProperty(process.stdout, "isTTY", ORIGINAL_IS_TTY_DESCRIPTOR);
    return;
  }
  delete (process.stdout as { isTTY?: boolean }).isTTY;
}

function setStdoutIsTty(value: boolean) {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    enumerable: ORIGINAL_IS_TTY_DESCRIPTOR?.enumerable ?? true,
    writable: true,
    value,
  });
}

describe("createFileLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_VITE_DEV_SERVER_URL === undefined) {
      delete process.env.VITE_DEV_SERVER_URL;
    } else {
      process.env.VITE_DEV_SERVER_URL = ORIGINAL_VITE_DEV_SERVER_URL;
    }
    if (ORIGINAL_ADE_STDIO_TRANSPORT === undefined) {
      delete process.env.ADE_STDIO_TRANSPORT;
    } else {
      process.env.ADE_STDIO_TRANSPORT = ORIGINAL_ADE_STDIO_TRANSPORT;
    }
    restoreStdoutIsTty();
  });

  it("does not mirror info logs to stdout when stdio transport is active", () => {
    process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";
    process.env.ADE_STDIO_TRANSPORT = "1";
    setStdoutIsTty(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-logger-")), "test.log");

    createFileLogger(logPath).info("coordinator.spawn_worker", { workerId: "worker-1" });

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("does not mirror info logs to stdout when stdout is not a tty", () => {
    process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";
    delete process.env.ADE_STDIO_TRANSPORT;
    setStdoutIsTty(false);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-logger-")), "test.log");

    createFileLogger(logPath).info("coordinator.spawn_worker", { workerId: "worker-1" });

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  // Callers on their way to app.exit() rely on this: the normal batched write
  // never lands, so without a synchronous drain the records that explain the
  // exit are lost.
  it("writes queued lines to disk synchronously on flushSync", () => {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-logger-")), "test.log");
    const logger = createFileLogger(logPath);

    logger.error("autoUpdate.quit_escalated", { blockedMs: 300_000 });
    logger.flushSync?.();

    const written = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0])).toMatchObject({
      level: "error",
      event: "autoUpdate.quit_escalated",
      meta: { blockedMs: 300_000 },
    });
  });

  // Regression: a line landing exactly on the batch limit makes scheduleFlush
  // call flush() synchronously, which splices the batch out before its first
  // await. Draining only the queue would then write nothing and the app.exit()
  // that follows would lose the record flushSync exists to preserve.
  it("drains a batch already handed to an in-flight flush", () => {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-logger-")), "test.log");
    const logger = createFileLogger(logPath, { flushBatchSize: 2 });

    logger.info("first.event");
    // Hits flushBatchSize, so flush() runs synchronously up to its first await
    // and the batch is no longer in queuedLines.
    logger.error("autoUpdate.quit_escalated", { blockedMs: 300_000 });
    logger.flushSync?.();

    const written = fs.readFileSync(logPath, "utf8");
    expect(written).toContain("autoUpdate.quit_escalated");
    expect(written).toContain("first.event");
  });

  it("is a no-op on flushSync with nothing queued", () => {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-logger-")), "test.log");
    const logger = createFileLogger(logPath);

    logger.flushSync?.();
    logger.flushSync?.();

    expect(fs.existsSync(logPath)).toBe(false);
  });
});
