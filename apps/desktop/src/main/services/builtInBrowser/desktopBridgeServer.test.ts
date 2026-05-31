import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBuiltInBrowserDesktopBridgeServer } from "./desktopBridgeServer";
import type { Logger } from "../logging/logger";
import type { BuiltInBrowserService } from "./builtInBrowserService";

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-bridge-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForMode(filePath: string, expectedMode: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && (fs.statSync(filePath).mode & 0o777) === expectedMode) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const actual = fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : null;
  throw new Error(`Timed out waiting for ${filePath} mode ${expectedMode.toString(8)}; got ${actual?.toString(8) ?? "missing"}`);
}

describe("startBuiltInBrowserDesktopBridgeServer", () => {
  it("creates private Unix socket directories and socket files", async () => {
    if (process.platform === "win32") return;

    let currentUmask = 0o000;
    const umaskCalls: number[] = [];
    const umask = (mask?: number): number => {
      const previous = currentUmask;
      if (mask != null) {
        umaskCalls.push(mask);
        currentUmask = mask;
      }
      return previous;
    };
    const socketDir = path.join(tempDir, "sock");
    fs.mkdirSync(socketDir, { mode: 0o755 });
    fs.chmodSync(socketDir, 0o755);
    const socketPath = path.join(socketDir, "desktop-bridge.sock");
    let server: ReturnType<typeof startBuiltInBrowserDesktopBridgeServer> | null = null;
    try {
      server = startBuiltInBrowserDesktopBridgeServer({
        socketPath,
        service: { getStatus: async () => ({ ok: true }) } as unknown as BuiltInBrowserService,
        logger: createLogger(),
        umask,
      });
      await waitForPath(socketPath);
      await waitForMode(socketPath, 0o600);

      expect(umaskCalls).toEqual([0o177, 0o000]);
      expect(currentUmask).toBe(0o000);
      expect(fs.statSync(socketDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    } finally {
      server?.dispose();
    }
  });
});
