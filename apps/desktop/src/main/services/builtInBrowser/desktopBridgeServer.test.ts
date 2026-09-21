import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import type { BuiltInBrowserService } from "./builtInBrowserService";
import { startBuiltInBrowserDesktopBridgeServer } from "./desktopBridgeServer";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function shortSocketPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adb-"));
  tempDirs.push(dir);
  return path.join(dir, `${label}.sock`);
}

type LoggerHarness = {
  logger: Logger;
  waitForEvent: (event: string) => Promise<void>;
};

function createLoggerHarness(): LoggerHarness {
  const seen = new Set<string>();
  const waiters = new Map<string, () => void>();
  const resolveEvent = (event: string) => {
    seen.add(event);
    const waiter = waiters.get(event);
    if (waiter) {
      waiters.delete(event);
      waiter();
    }
  };
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn((event: string) => resolveEvent(event)),
    warn: vi.fn((event: string) => resolveEvent(event)),
    error: vi.fn((event: string) => resolveEvent(event)),
  };
  const waitForEvent = (event: string) =>
    seen.has(event)
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waiters.set(event, resolve);
        });
  return { logger, waitForEvent };
}

function connectOnce(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("built-in browser desktop bridge socket ownership", () => {
  it.skipIf(process.platform === "win32")(
    "yields to a live bridge that already owns the socket path",
    async () => {
      const socketPath = shortSocketPath("live");
      const owner = net.createServer();
      await new Promise<void>((resolve, reject) => {
        owner.once("error", reject);
        owner.listen(socketPath, resolve);
      });

      const { logger, waitForEvent } = createLoggerHarness();
      const bridge = startBuiltInBrowserDesktopBridgeServer({
        socketPath,
        service: {} as unknown as BuiltInBrowserService,
        logger,
      });
      try {
        await waitForEvent("built_in_browser_bridge.already_served");
        expect(fs.existsSync(socketPath)).toBe(true);
        await expect(connectOnce(socketPath)).resolves.toBeUndefined();
        expect(logger.error).not.toHaveBeenCalled();
      } finally {
        bridge.dispose();
        await closeServer(owner);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "unlinks a stale socket file and then listens",
    async () => {
      const socketPath = shortSocketPath("stale");
      // A closed server on this platform unlinks its own socket, so a regular
      // file is the deterministic stale artifact: bind() refuses it with
      // EADDRINUSE and the probe refuses it with ENOTSOCK.
      fs.writeFileSync(socketPath, "");

      const { logger, waitForEvent } = createLoggerHarness();
      const bridge = startBuiltInBrowserDesktopBridgeServer({
        socketPath,
        service: {} as unknown as BuiltInBrowserService,
        logger,
      });
      try {
        await waitForEvent("built_in_browser_bridge.listening");
        expect(logger.info).toHaveBeenCalledWith(
          "built_in_browser_bridge.stale_socket_replaced",
          { socketPath },
        );
        expect(fs.existsSync(socketPath)).toBe(true);
        await expect(connectOnce(socketPath)).resolves.toBeUndefined();
      } finally {
        bridge.dispose();
      }
    },
  );
});
