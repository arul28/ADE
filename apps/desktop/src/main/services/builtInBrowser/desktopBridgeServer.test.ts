import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonRpcClient } from "../../../../../ade-cli/src/lib/jsonRpcClient";
import { SCENE_PREVIEW_MAX_SOURCE_BYTES, type ScenePreviewResult } from "../../../shared/scenePreview";
import {
  BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILES,
  type BuiltInBrowserRemoteCallFile,
} from "../../../shared/types/builtInBrowserRemote";
import type { Logger } from "../logging/logger";
import type { BuiltInBrowserService } from "./builtInBrowserService";
import { startBuiltInBrowserDesktopBridgeServer, bridgeListenFailureOutcome } from "./desktopBridgeServer";
import { packRemoteCallFiles, runRemoteAgentBrowserCall } from "./builtInBrowserRemoteCalls";
import { requestDesktopAppUpdate } from "../../../../../ade-cli/src/services/runtime/desktopAppUpdateBridge";
import type { RemoteUpdateInstaller } from "../updates/remoteUpdateInstall";
import { BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS } from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";

const tempDirs: string[] = [];

it("keeps renderer-only tab attachment out of the desktop bridge allowlist", () => {
  expect(BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS).not.toContain("handTabToChat");
});

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

/**
 * `EADDRINUSE` is the one bind failure the bridge answers benignly, and which
 * reading it gets decides between a Sentry issue and a searchable log line.
 * The Windows rows cannot be reached from this machine's socket, so the
 * decision they turn on is pinned here rather than through a listening server.
 */
describe("bridgeListenFailureOutcome", () => {
  it.each([
    [
      "a Windows pipe another desktop already owns",
      { code: "EADDRINUSE", isNamedPipe: true, retriedAfterStaleUnlink: false },
      "already-served",
    ],
    [
      "a Windows pipe that is still taken, which has no stale-file retry",
      { code: "EADDRINUSE", isNamedPipe: true, retriedAfterStaleUnlink: true },
      "already-served",
    ],
    [
      "the first Unix collision, which may be a socket a crashed desktop left",
      { code: "EADDRINUSE", isNamedPipe: false, retriedAfterStaleUnlink: false },
      "retry-stale-socket",
    ],
    [
      "a Unix collision after the stale socket was replaced, so a live owner took it",
      { code: "EADDRINUSE", isNamedPipe: false, retriedAfterStaleUnlink: true },
      "already-served",
    ],
    [
      "a socket directory this user may not write to",
      { code: "EACCES", isNamedPipe: false, retriedAfterStaleUnlink: false },
      "server-error",
    ],
    [
      "a socket path longer than the platform allows",
      { code: "ENAMETOOLONG", isNamedPipe: false, retriedAfterStaleUnlink: true },
      "server-error",
    ],
    [
      "an error that carries no code at all",
      { code: undefined, isNamedPipe: true, retriedAfterStaleUnlink: false },
      "server-error",
    ],
  ])("reads %s", (_label, input, expected) => {
    expect(bridgeListenFailureOutcome(input)).toBe(expected);
  });
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

  it("treats an app with no updater to offer as no app attached", async () => {
    const { bridge, socketPath } = await startBridge(null);
    try {
      const routing = await requestDesktopAppUpdate({
        socketPath,
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
      targetVersion: "1.2.91",
      connectTimeoutMs: 1_000,
    });
    expect(routing.attached).toBe(false);
  });
});

/**
 * `ade scene preview` reaches the desktop over this socket: the runtime daemon
 * sends the agent's scene source and gets back the screenshot and the problems.
 * The source is the only input, and a scene over the preview cap is refused
 * before it reaches Chromium.
 */
describe("scene preview over the desktop bridge", () => {
  const bridges: Array<{ dispose: () => void }> = [];

  afterEach(() => {
    for (const bridge of bridges.splice(0)) bridge.dispose();
  });

  async function startSceneBridge(scenePreview: ((request: unknown) => Promise<ScenePreviewResult>) | null) {
    const { logger, waitForEvent } = createLoggerHarness();
    const bridge = startBuiltInBrowserDesktopBridgeServer({
      socketPath: shortSocketPath("scene"),
      service: {} as unknown as BuiltInBrowserService,
      logger,
      scenePreview,
    });
    bridges.push(bridge);
    await waitForEvent("built_in_browser_bridge.listening");
    return bridge;
  }

  async function callRender(
    bridge: { socketPath: string },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const client = await JsonRpcClient.connect(bridge.socketPath);
    try {
      return await client.request("scene_preview.render", {
        ...params,
      }, { timeoutMs: 5_000 });
    } finally {
      client.close();
    }
  }

  const RESULT: ScenePreviewResult = {
    title: "Chart",
    width: 720,
    height: 240,
    readyMs: 12,
    settledMs: 300,
    screenshotBase64: "AAAA",
    problems: [],
  };

  it("renders a scene handed to it and answers with the result", async () => {
    const seen: unknown[] = [];
    const bridge = await startSceneBridge(async (request) => {
      seen.push(request);
      return RESULT;
    });

    const result = await callRender(bridge, { request: { source: '<p>x</p>', theme: "light" } });
    expect(result).toEqual(RESULT);
    expect(seen).toEqual([{ source: '<p>x</p>', theme: "light" }]);
  });

  it("refuses a source over the preview size cap before rendering", async () => {
    const preview = vi.fn(async () => RESULT);
    const bridge = await startSceneBridge(preview);
    await expect(callRender(bridge, {
      request: { source: "x".repeat(SCENE_PREVIEW_MAX_SOURCE_BYTES + 1) },
    })).rejects.toThrow(/too large/i);
    expect(preview).not.toHaveBeenCalled();
  });

  it("reports the method as not exposed when no previewer is attached", async () => {
    const bridge = await startSceneBridge(null);
    await expect(callRender(bridge, { request: { source: "<p>x</p>" } }))
      .rejects.toThrow(/not exposed/i);
  });
});

/**
 * The files a result points at travel with a remote command's reply. The result
 * is the page's own data, so a `filePath` in it must be able to name only a real
 * observation file on this machine — never any other file on the user's
 * computer, and never through a symlink.
 */
describe("packRemoteCallFiles", () => {
  type PackFixture = {
    observations: string;
    inside: string;
    insideBytes: Buffer;
    outside: string;
    empty: string;
  };

  function makePackFixture(): PackFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-"));
    tempDirs.push(root);
    const observations = path.join(root, "browser-observations");
    fs.mkdirSync(observations);
    const inside = path.join(observations, "shot.png");
    const insideBytes = Buffer.from("inside-observation-bytes");
    fs.writeFileSync(inside, insideBytes);
    const outside = path.join(root, "outside.png");
    fs.writeFileSync(outside, Buffer.from("outside-bytes"));
    const empty = path.join(observations, "empty.png");
    fs.writeFileSync(empty, "");
    return { observations, inside, insideBytes, outside, empty };
  }

  const rows: Array<{
    label: string;
    build: (fixture: PackFixture) => unknown;
    expected: (fixture: PackFixture) => BuiltInBrowserRemoteCallFile[];
  }> = [
    {
      label: "a real file inside browser-observations",
      build: (f) => ({ observation: { filePath: f.inside } }),
      expected: (f) => [{
        pointer: ["observation", "filePath"],
        fileName: "shot.png",
        base64: f.insideBytes.toString("base64"),
      }],
    },
    {
      label: "a file outside browser-observations",
      build: (f) => ({ observation: { filePath: f.outside } }),
      expected: () => [],
    },
    {
      label: "a relative path that resolves to a real observation file",
      build: (f) => ({ observation: { filePath: path.relative(process.cwd(), f.inside) } }),
      expected: () => [],
    },
    {
      label: "an empty observation file",
      build: (f) => ({ observation: { filePath: f.empty } }),
      expected: () => [],
    },
    {
      label: "more files than one reply may carry",
      build: (f) => Object.fromEntries(
        Array.from(
          { length: BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILES + 1 },
          (_value, index) => [`observation${index}`, { filePath: f.inside }],
        ),
      ),
      expected: (f) => Array.from(
        { length: BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILES },
        (_value, index) => ({
          pointer: [`observation${index}`, "filePath"],
          fileName: "shot.png",
          base64: f.insideBytes.toString("base64"),
        }),
      ),
    },
  ];

  it.each(rows)("packs only $label", ({ build, expected }) => {
    const fixture = makePackFixture();
    expect(packRemoteCallFiles(build(fixture))).toEqual(expected(fixture));
  });

  it.skipIf(process.platform === "win32")(
    "does not pack a symlink inside browser-observations that points outside it",
    () => {
      const fixture = makePackFixture();
      const link = path.join(fixture.observations, "link.png");
      fs.symlinkSync(fixture.outside, link);
      expect(packRemoteCallFiles({ observation: { filePath: link } })).toEqual([]);
    },
  );
});

/**
 * One command an agent on another machine sends to this desktop. A refusal and a
 * failure are both outcomes with `ok: false`, never a rejection, so the reply
 * the requester waits on always arrives.
 */
describe("runRemoteAgentBrowserCall", () => {
  it("refuses a method an agent elsewhere may not run, without touching the service", async () => {
    const uploadFile = vi.fn();
    const observe = vi.fn();
    const service = { uploadFile, observe } as unknown as BuiltInBrowserService;

    const outcome = await runRemoteAgentBrowserCall({ service, method: "uploadFile", input: {} });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toMatch(/cannot be run/i);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("turns a service failure into a failed outcome instead of a rejection", async () => {
    const service = {
      observe: async () => {
        throw new Error("No ADE browser window is open for this project.");
      },
    } as unknown as BuiltInBrowserService;

    const outcome = await runRemoteAgentBrowserCall({ service, method: "observe", input: {} });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toContain("No ADE browser window is open");
  });
});
