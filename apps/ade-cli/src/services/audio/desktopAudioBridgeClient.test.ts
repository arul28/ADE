import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startJsonRpcServer,
  type JsonRpcRequest,
  type JsonRpcTransport,
} from "../../jsonrpc";
import { JsonRpcClient } from "../../tuiClient/jsonRpcClient";
import { startBuiltInBrowserDesktopBridgeServer } from "../../../../desktop/src/main/services/builtInBrowser/desktopBridgeServer";
import type { BuiltInBrowserService } from "../../../../desktop/src/main/services/builtInBrowser/builtInBrowserService";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { createDesktopAudioCaptureBridge } from "./desktopAudioBridgeClient";
import {
  desktopAudioCaptureTimeoutMs,
  DESKTOP_AUDIO_BRIDGE_METHOD,
  DESKTOP_AUDIO_CAPTURE_GRACE_MS,
  DESKTOP_AUDIO_CAPTURE_MAX_DURATION_MS,
  DESKTOP_AUDIO_REQUESTER_LABEL_MAX_CHARS,
} from "./desktopAudioBridge";

function silentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger;
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function bridgeSocketPath(prefix = "ade-audio-bridge-test"): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${prefix}-${process.pid}-${randomUUID()}`;
  }
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)), "bridge.sock");
}

type StubServer = {
  socketPath: string;
  dropConnections: () => void;
  close: () => Promise<void>;
};

/** A stand-in desktop: answers one JSON-RPC method however the test says. */
async function startStubDesktop(
  handler: (request: JsonRpcRequest) => Promise<unknown>,
): Promise<StubServer> {
  const socketPath = bridgeSocketPath();
  const stopHandles = new Set<() => void>();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((conn) => {
    sockets.add(conn);
    const transport: JsonRpcTransport = {
      onData: (callback) => conn.on("data", callback),
      write: (data) => conn.write(data),
      close: () => {
        if (!conn.destroyed) conn.destroy();
      },
    };
    const stop = startJsonRpcServer(handler, transport, { nonFatal: true });
    stopHandles.add(stop);
    conn.on("close", () => {
      sockets.delete(conn);
      stopHandles.delete(stop);
      stop();
    });
    conn.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  const destroyAll = () => {
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  };
  return {
    socketPath,
    dropConnections: destroyAll,
    close: () =>
      new Promise<void>((resolve) => {
        destroyAll();
        for (const stop of stopHandles) {
          try {
            stop();
          } catch {
            // ignore
          }
        }
        server.close(() => {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // ignore
          }
          resolve();
        });
      }),
  };
}

describe("desktopAudioCaptureTimeoutMs", () => {
  it("gives a capture its own budget: the requested duration plus a grace margin", () => {
    // A ten-minute recording is a legitimate request and must not expire at the
    // bridge's ordinary per-call ceiling.
    expect(desktopAudioCaptureTimeoutMs(600_000)).toBe(600_000 + DESKTOP_AUDIO_CAPTURE_GRACE_MS);
    expect(desktopAudioCaptureTimeoutMs(1_000)).toBe(1_000 + DESKTOP_AUDIO_CAPTURE_GRACE_MS);
  });

  it("caps an open-ended capture at the recorder's own ceiling", () => {
    const ceiling = DESKTOP_AUDIO_CAPTURE_MAX_DURATION_MS + DESKTOP_AUDIO_CAPTURE_GRACE_MS;
    // No duration at all: the user stops when they stop, so the deadline is the
    // longest clip the recorder would accept anyway.
    expect(desktopAudioCaptureTimeoutMs(undefined)).toBe(ceiling);
    expect(desktopAudioCaptureTimeoutMs(60 * 60 * 1_000)).toBe(ceiling);
    expect(desktopAudioCaptureTimeoutMs(-5)).toBe(ceiling);
  });
});

describe("createDesktopAudioCaptureBridge", () => {
  let server: StubServer | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("round-trips a capture to the desktop and answers with the clip", async () => {
    const seen: JsonRpcRequest[] = [];
    server = await startStubDesktop(async (request) => {
      seen.push(request);
      return { audioPath: "/tmp/ade-audio-captures/clip.wav", durationMs: 4_200 };
    });
    const bridge = createDesktopAudioCaptureBridge({
      socketPath: server.socketPath,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });

    await expect(bridge.captureClip({ label: "Voice", maxDurationMs: 30_000 })).resolves.toEqual({
      audioPath: "/tmp/ade-audio-captures/clip.wav",
      durationMs: 4_200,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe(DESKTOP_AUDIO_BRIDGE_METHOD);
    // The pill has to name the requester, so the label crosses with the request.
    expect(seen[0]?.params).toEqual({
      maxDurationMs: 30_000,
      requesterLabel: "Voice",
      __adeDesktopBridgeAuth: "bridge-auth",
    });
  });

  it("gives the request the capture's own timeout, not the socket default", async () => {
    server = await startStubDesktop(async () => ({ audioPath: "/tmp/clip.wav", durationMs: 1 }));
    const request = vi.spyOn(JsonRpcClient.prototype, "request");
    const bridge = createDesktopAudioCaptureBridge({
      socketPath: server.socketPath,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });

    await bridge.captureClip({ label: "Voice", maxDurationMs: 600_000 });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[2]).toEqual({ timeoutMs: desktopAudioCaptureTimeoutMs(600_000) });
  });

  it("keeps a cancelled capture's code so the plugin can treat it as a no-op", async () => {
    server = await startStubDesktop(async () => {
      throw new Error("audio_capture_cancelled: You stopped the recording.");
    });
    const bridge = createDesktopAudioCaptureBridge({
      socketPath: server.socketPath,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });

    const error = await bridge.captureClip({ label: "Voice" }).catch((thrown: unknown) => thrown);
    expect(codeOf(error)).toBe("audio_capture_cancelled");
    expect((error as Error).message).toBe("You stopped the recording.");
  });

  it("keeps a busy refusal's code rather than adding a second concurrency gate", async () => {
    server = await startStubDesktop(async () => {
      throw new Error("audio_capture_busy: Another recording is already in progress.");
    });
    const bridge = createDesktopAudioCaptureBridge({
      socketPath: server.socketPath,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });

    const error = await bridge.captureClip({ label: "Voice" }).catch((thrown: unknown) => thrown);
    expect(codeOf(error)).toBe("audio_capture_busy");
  });

  it.skipIf(process.platform === "win32")("refuses immediately when no desktop is listening", async () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-audio-none-")), "bridge.sock");
    const bridge = createDesktopAudioCaptureBridge({
      socketPath: missing,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });

    const error = await bridge.captureClip({ label: "Voice" }).catch((thrown: unknown) => thrown);
    expect(codeOf(error)).toBe("audio_capture_mic_unavailable");
  });

  it("refuses when the desktop never handed over a bridge credential", async () => {
    server = await startStubDesktop(async () => ({ audioPath: "/tmp/clip.wav", durationMs: 1 }));
    const bridge = createDesktopAudioCaptureBridge({
      socketPath: server.socketPath,
      getAuthToken: () => null,
      logger: silentLogger(),
    });

    const error = await bridge.captureClip({ label: "Voice" }).catch((thrown: unknown) => thrown);
    expect(codeOf(error)).toBe("audio_capture_mic_unavailable");
  });

  it("fails a capture the desktop abandoned mid-recording instead of hanging", async () => {
    let reachedDesktop: (() => void) | null = null;
    const arrived = new Promise<void>((resolve) => {
      reachedDesktop = resolve;
    });
    server = await startStubDesktop(async () => {
      reachedDesktop?.();
      // A recording in progress: the desktop answers only when it finishes, and
      // in this test it never does — it goes away instead.
      return await new Promise<never>(() => {});
    });
    const bridge = createDesktopAudioCaptureBridge({
      socketPath: server.socketPath,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });

    const capture = bridge.captureClip({ label: "Voice", maxDurationMs: 600_000 });
    const settled = capture.catch((thrown: unknown) => thrown);
    await arrived;
    server.dropConnections();

    expect(codeOf(await settled)).toBe("audio_capture_failed");
  });
});

describe("desktop bridge audio.captureClip", () => {
  let bridgeServer: ReturnType<typeof startBuiltInBrowserDesktopBridgeServer> | null = null;
  let socketDir: string | null = null;

  afterEach(() => {
    bridgeServer?.dispose();
    bridgeServer = null;
    if (socketDir) {
      fs.rmSync(socketDir, { recursive: true, force: true });
      socketDir = null;
    }
  });

  const startBridge = (
    captureAudioClip?: (input: { maxDurationMs?: number; requesterLabel?: string }) => Promise<{
      audioPath: string;
      durationMs: number;
    }>,
  ): string => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-audio-e2e-"));
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\ade-audio-e2e-${process.pid}-${randomUUID()}`
      : path.join(socketDir, "desktop-bridge.sock");
    bridgeServer = startBuiltInBrowserDesktopBridgeServer({
      socketPath,
      service: {} as unknown as BuiltInBrowserService,
      logger: silentLogger(),
      ...(captureAudioClip ? { captureAudioClip } : {}),
    });
    return socketPath;
  };

  const waitForSocket = async (socketPath: string): Promise<void> => {
    if (process.platform === "win32") return;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fs.existsSync(socketPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`bridge socket never appeared at ${socketPath}`);
  };

  it("records through the real bridge and returns the clip to the daemon", async () => {
    const captures: { maxDurationMs?: number; requesterLabel?: string }[] = [];
    const socketPath = startBridge(async (input) => {
      captures.push(input);
      return { audioPath: "/tmp/ade-audio-captures/e2e.wav", durationMs: 900 };
    });
    await waitForSocket(socketPath);
    const bridge = createDesktopAudioCaptureBridge({
      socketPath,
      getAuthToken: () => bridgeServer!.authToken,
      logger: silentLogger(),
    });

    await expect(bridge.captureClip({ label: "ADE Voice", maxDurationMs: 120_000 })).resolves.toEqual({
      audioPath: "/tmp/ade-audio-captures/e2e.wav",
      durationMs: 900,
    });
    expect(captures).toEqual([{ maxDurationMs: 120_000, requesterLabel: "ADE Voice" }]);
  });

  it("bounds the name a plugin can put on the pill", async () => {
    const captures: { requesterLabel?: string }[] = [];
    const socketPath = startBridge(async (input) => {
      captures.push(input);
      return { audioPath: "/tmp/clip.wav", durationMs: 1 };
    });
    await waitForSocket(socketPath);
    const bridge = createDesktopAudioCaptureBridge({
      socketPath,
      getAuthToken: () => bridgeServer!.authToken,
      logger: silentLogger(),
    });

    await bridge.captureClip({ label: "N".repeat(500) });

    expect(captures[0]?.requesterLabel).toHaveLength(DESKTOP_AUDIO_REQUESTER_LABEL_MAX_CHARS);
  });

  it("carries a recorder refusal's code end to end", async () => {
    const socketPath = startBridge(async () => {
      const refusal = Object.assign(new Error("Another recording is already in progress."), {
        code: "audio_capture_busy",
      });
      throw refusal;
    });
    await waitForSocket(socketPath);
    const bridge = createDesktopAudioCaptureBridge({
      socketPath,
      getAuthToken: () => bridgeServer!.authToken,
      logger: silentLogger(),
    });

    const error = await bridge.captureClip({ label: "ADE Voice" }).catch((thrown: unknown) => thrown);
    expect(codeOf(error)).toBe("audio_capture_busy");
    expect((error as Error).message).toBe("Another recording is already in progress.");
  });

  it("reports a desktop that cannot record, rather than leaving the plugin waiting", async () => {
    const socketPath = startBridge();
    await waitForSocket(socketPath);
    const bridge = createDesktopAudioCaptureBridge({
      socketPath,
      getAuthToken: () => bridgeServer!.authToken,
      logger: silentLogger(),
    });

    const error = await bridge.captureClip({ label: "ADE Voice" }).catch((thrown: unknown) => thrown);
    expect(codeOf(error)).toBe("audio_capture_mic_unavailable");
  });

  it("refuses an unauthenticated caller on the audio method too", async () => {
    const capture = vi.fn(async () => ({ audioPath: "/tmp/clip.wav", durationMs: 1 }));
    const socketPath = startBridge(capture);
    await waitForSocket(socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    try {
      await expect(client.request(DESKTOP_AUDIO_BRIDGE_METHOD, { requesterLabel: "Impostor" }))
        .rejects.toThrow(/bridge authentication failed/);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      client.close();
    }
  });
});
