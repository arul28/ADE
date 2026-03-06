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
});
