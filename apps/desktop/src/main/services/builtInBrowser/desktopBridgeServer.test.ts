import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import type { BuiltInBrowserService } from "./builtInBrowserService";
import { startBuiltInBrowserDesktopBridgeServer } from "./desktopBridgeServer";
import { requestDesktopAppUpdate } from "../../../../../ade-cli/src/services/runtime/desktopAppUpdateBridge";
import type { RemoteUpdateInstaller } from "../updates/remoteUpdateInstall";

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

describe("app update over the desktop bridge", () => {
  let pipeCounter = 0;
  function bridgePath(label: string): string {
    pipeCounter += 1;
    return process.platform === "win32"
      ? `\\\\.\\pipe\\ade-bridge-test-${label}-${process.pid}-${pipeCounter}`
      : shortSocketPath(label);
  }

  async function startBridge(installer: RemoteUpdateInstaller | null) {
    const socketPath = bridgePath("update");
    const { logger, waitForEvent } = createLoggerHarness();
    const bridge = startBuiltInBrowserDesktopBridgeServer({
      socketPath,
      service: {} as unknown as BuiltInBrowserService,
      logger,
      getAppUpdateInstaller: () => installer,
    });
    await waitForEvent("built_in_browser_bridge.listening");
    return { bridge, socketPath };
  }

  const installingInstaller = (): RemoteUpdateInstaller => ({
    install: async ({ targetVersion }) => ({
      outcome: "installing",
      currentVersion: "1.2.90",
      version: targetVersion,
      message: "Installing.",
    }),
    dispose: () => {},
  });

  it("asks this app to install its update and hands back its answer", async () => {
    const { bridge, socketPath } = await startBridge(installingInstaller());
    try {
      const routing = await requestDesktopAppUpdate({
        socketPath,
        authToken: bridge.authToken,
        targetVersion: "1.2.91",
      });
      expect(routing).toEqual({
        attached: true,
        result: { outcome: "installing", currentVersion: "1.2.90", version: "1.2.91", message: "Installing." },
      });
    } finally {
      bridge.dispose();
    }
  });

  it.each([
    // Each is "no capable app": the brain must fall back to its standalone
    // update rather than report a failure the user cannot act on.
    ["a stale token", "wrong-token", true],
    ["an app with no updater to offer", null, false],
    ["no token at all", "", true],
  ])("treats %s as no app attached", async (_label, token, withInstaller) => {
    const { bridge, socketPath } = await startBridge(withInstaller ? installingInstaller() : null);
    try {
      const routing = await requestDesktopAppUpdate({
        socketPath,
        authToken: token === null ? bridge.authToken : token,
        targetVersion: "1.2.91",
      });
      expect(routing.attached).toBe(false);
    } finally {
      bridge.dispose();
    }
  });

  it("treats a bridge nobody listens on as no app attached", async () => {
    const routing = await requestDesktopAppUpdate({
      socketPath: bridgePath("absent"),
      authToken: "token",
      targetVersion: "1.2.91",
      connectTimeoutMs: 1_000,
    });
    expect(routing.attached).toBe(false);
  });
});
