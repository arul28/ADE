import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcClient } from "../../../../../ade-cli/src/tuiClient/jsonRpcClient";
import { BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM } from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";
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
      });
      await waitForPath(socketPath);
      await waitForMode(socketPath, 0o600);

      expect(fs.statSync(socketDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    } finally {
      server?.dispose();
    }
  });

  it("rejects raw callers and requires an authenticated runtime scope", async () => {
    if (process.platform === "win32") return;

    const socketPath = path.join(tempDir, "desktop-bridge.sock");
    const navigate = vi.fn(async (input: unknown) => input);
    const server = startBuiltInBrowserDesktopBridgeServer({
      socketPath,
      service: { navigate } as unknown as BuiltInBrowserService,
      logger: createLogger(),
    });
    let client: JsonRpcClient | null = null;
    try {
      await waitForPath(socketPath);
      client = await JsonRpcClient.connect(socketPath);
      await expect(client.request("built_in_browser.navigate", {
        url: "https://example.test",
      })).rejects.toThrow(/bridge authentication failed/);

      await expect(client.request("built_in_browser.authenticate", {
        [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: server.authToken,
      })).resolves.toEqual({ authenticated: true });
      await expect(client.request("built_in_browser.navigate", {
        url: "https://example.test",
        laneId: "lane-trusted",
        chatSessionId: "chat-trusted",
        projectRoot: "/trusted/project",
        force: true,
        [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: server.authToken,
      })).resolves.toMatchObject({
        url: "https://example.test",
        laneId: "lane-trusted",
        chatSessionId: "chat-trusted",
        projectRoot: "/trusted/project",
        force: false,
      });
      expect(navigate).toHaveBeenCalledTimes(1);
    } finally {
      client?.close();
      server.dispose();
    }
  });
});
