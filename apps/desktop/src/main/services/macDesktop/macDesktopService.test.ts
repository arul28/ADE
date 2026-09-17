import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAC_DESKTOP_IDLE_RELEASE_MS, type MacDesktopEventPayload } from "../../../shared/types/macDesktop";
import { MAC_DESKTOP_DRIVER_OPS, type MacDesktopDriverClient } from "./macDesktopDriverClient";
import { createMacDesktopService } from "./macDesktopService";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A driver client that records what it was asked for and never spawns a
 * process. Every unit test here drives the service through this, because the
 * real helper needs a window server and a signed binary.
 */
function createFakeDriver(overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {}) {
  const calls: Array<{ op: string; payload: Record<string, unknown> }> = [];
  const listeners = new Set<(event: { event: string } & Record<string, unknown>) => void>();
  let resolveCreate: (() => void) | null = null;
  const client = {
    calls,
    /** Lets a test swap an op's answer after the driver was built. */
    overrides,
    listeners,
    /** Lets a test hold `display.create` open to force a race. */
    blockCreate() {
      return new Promise<void>((resolve) => {
        resolveCreate = resolve;
      });
    },
    releaseCreate() {
      resolveCreate?.();
      resolveCreate = null;
    },
    async ensureStarted() {},
    isRunning: () => true,
    async request(op: string, payload: Record<string, unknown> = {}) {
      calls.push({ op, payload });
      const override = overrides[op];
      if (override) return override(payload);
      switch (op) {
        case MAC_DESKTOP_DRIVER_OPS.health:
          return { version: "1.0.0", permissions: { screenRecording: "granted", accessibility: "granted" }, displayMode: "virtual" };
        case MAC_DESKTOP_DRIVER_OPS.createDisplay:
          if (resolveCreate) await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            displayId: 7,
            name: payload.name,
            mode: "virtual",
            width: payload.width,
            height: payload.height,
            scale: 2,
            origin: { x: 8000, y: 0 },
            createdAt: new Date(0).toISOString(),
          };
        case MAC_DESKTOP_DRIVER_OPS.listWindows:
          return { windows: [] };
        case MAC_DESKTOP_DRIVER_OPS.destroyDisplay:
          return { destroyed: true, releasedWindows: 0 };
        case MAC_DESKTOP_DRIVER_OPS.reconcileDisplays:
          return { destroyed: [] };
        default:
          return {};
      }
    },
    onEvent(listener: (event: { event: string } & Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getHealth: () => ({
      state: "running" as const,
      title: "Mac Desktop is ready",
      message: "The native desktop driver is running.",
      recovery: null,
      version: "1.0.0",
    }),
    setVersion: () => {},
    retry: () => client.getHealth(),
    dispose: () => {},
  };
  return client;
}

function makeService(options: {
  platform?: NodeJS.Platform;
  driver?: ReturnType<typeof createFakeDriver>;
  projectRoot?: string;
  now?: () => number;
} = {}) {
  const events: MacDesktopEventPayload[] = [];
  const driver = options.driver ?? createFakeDriver();
  const service = createMacDesktopService({
    projectRoot: options.projectRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-test-")),
    logger,
    platform: options.platform ?? "darwin",
    ...(options.now ? { now: options.now } : {}),
    onEvent: (event) => events.push(event),
    createDriverClient: () => driver as unknown as MacDesktopDriverClient,
  });
  return { service, driver, events };
}

describe("macDesktopService capability gate", () => {
  it("getStatus answers on Windows with supported:false and an unsupported driver", async () => {
    const { service, driver } = makeService({ platform: "win32" });
    const status = await service.getStatus({ laneId: "lane-1" });
    expect(status.supported).toBe(false);
    expect(status.platform).toBe("win32");
    expect(status.unsupportedReason).toContain("macOS");
    expect(status.displayMode).toBe("unavailable");
    expect(status.driver.state).toBe("unsupported");
    // Nothing was asked of any helper: a Windows host has none to ask.
    expect(driver.calls).toHaveLength(0);
    service.dispose();
  });

  it("every other method rejects off macOS with the platform code", async () => {
    const { service } = makeService({ platform: "win32" });
    const rejections = await Promise.allSettled([
      service.start({ laneId: "lane-1" }),
      service.observe({ laneId: "lane-1" }),
      service.click({ laneId: "lane-1", text: "OK" }),
      service.startStream({ laneId: "lane-1" }),
      service.takeControl({ laneId: "lane-1", controllerId: "window-1" }),
      service.present({ laneId: "lane-1", destination: "main" }),
    ]);
    for (const result of rejections) {
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") continue;
      expect((result.reason as { code?: string }).code).toBe("MAC_DESKTOP_UNSUPPORTED_PLATFORM");
    }
    service.dispose();
  });

  it("the two cleanup methods still answer off macOS", async () => {
    const { service } = makeService({ platform: "win32" });
    await expect(service.releaseIfOwnedBy("chat-1")).resolves.toEqual({ released: false });
    await expect(service.destroyForLane("lane-1")).resolves.toEqual({ destroyed: false });
    service.dispose();
  });
});

describe("macDesktopService start", () => {
  it("is idempotent and serialised: two racing starts create one display", async () => {
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver });
    void driver.blockCreate();
    const [first, second] = await Promise.all([
      service.start({ laneId: "lane-1", laneName: "Login fix" }),
      service.start({ laneId: "lane-1", laneName: "Login fix" }),
    ]);
    driver.releaseCreate();
    expect(first.display?.displayId).toBe(7);
    expect(second.display?.displayId).toBe(7);
    const creates = driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.createDisplay);
    expect(creates).toHaveLength(1);
    expect(events.filter((event) => event.type === "display-created")).toHaveLength(1);
    service.dispose();
  });

  it("a third start after the first landed reuses the same display", async () => {
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.start({ laneId: "lane-1" });
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.createDisplay)).toHaveLength(1);
    service.dispose();
  });

  it("names the display after the lane", async () => {
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1", laneName: "Login fix" });
    const create = driver.calls.find((call) => call.op === MAC_DESKTOP_DRIVER_OPS.createDisplay);
    expect(create?.payload.name).toBe("ADE · Login fix");
    service.dispose();
  });
});

describe("macDesktopService idle release", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("destroys a display with no windows and no viewer after the idle window", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver, now: () => clock });
    await service.start({ laneId: "lane-1" });
    expect(await service.getDisplay({ laneId: "lane-1" })).not.toBeNull();

    // Not yet: the sweep runs, but the display is still inside its idle window.
    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await service.getDisplay({ laneId: "lane-1" })).not.toBeNull();

    clock += MAC_DESKTOP_IDLE_RELEASE_MS;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await service.getDisplay({ laneId: "lane-1" })).toBeNull();
    const destroyed = events.filter((event) => event.type === "display-destroyed");
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toMatchObject({ laneId: "lane-1", reason: "idle" });
    service.dispose();
  });

  it("drops every lease when the wall clock jumps, as a sleeping Mac does", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver, now: () => clock });
    await service.start({ laneId: "lane-1" });
    await service.takeControl({ laneId: "lane-1", controllerId: "window-7" });
    expect((await service.getStatus({ laneId: "lane-1" })).lease).not.toBeNull();

    // Four sweep intervals of wall clock passed while one timer tick fired.
    clock += 30_000 * 8;
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await service.getStatus({ laneId: "lane-1" })).lease).toBeNull();
    expect(events.some((event) => event.type === "lease-changed" && event.lease === null)).toBe(true);
    service.dispose();
  });
});

describe("macDesktopService lease", () => {
  it("asks the pending-input card once per chat, then re-grants silently", async () => {
    const driver = createFakeDriver();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-test-"));
    const asked: string[] = [];
    const service = createMacDesktopService({
      projectRoot,
      logger,
      platform: "darwin",
      createDriverClient: () => driver as unknown as MacDesktopDriverClient,
      requestChatInput: async (input) => {
        asked.push(input.chatSessionId);
        return { decision: "accept", answers: { mac_desktop_input_lease: ["allow"] }, responseText: null };
      },
    });
    await service.start({ laneId: "lane-1" });
    const first = await service.requestInputLease({ laneId: "lane-1", chatSessionId: "chat-1" });
    expect(first.granted).toBe(true);
    const second = await service.requestInputLease({ laneId: "lane-1", chatSessionId: "chat-1" });
    expect(second.granted).toBe(true);
    expect(asked).toEqual(["chat-1"]);
    service.dispose();
  });

  it("a refused card grants nothing", async () => {
    const driver = createFakeDriver();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-test-"));
    const service = createMacDesktopService({
      projectRoot,
      logger,
      platform: "darwin",
      createDriverClient: () => driver as unknown as MacDesktopDriverClient,
      requestChatInput: async () => ({ decision: "decline", answers: {}, responseText: "don't allow" }),
    });
    await service.start({ laneId: "lane-1" });
    const result = await service.requestInputLease({ laneId: "lane-1", chatSessionId: "chat-1" });
    expect(result.granted).toBe(false);
    expect(result.code).toBe("MAC_DESKTOP_INPUT_LEASE_REQUIRED");
    service.dispose();
  });

  it("releaseIfOwnedBy drops the chat's lease", async () => {
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.takeControl({ laneId: "lane-1", controllerId: "chat-1" });
    await expect(service.releaseIfOwnedBy("chat-1")).resolves.toEqual({ released: true });
    expect((await service.getStatus({ laneId: "lane-1" })).lease).toBeNull();
    service.dispose();
  });
});

describe("macDesktopService real input and the lease", () => {
  it("lets the controller who took over drive, and refuses a chat id that did not", async () => {
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    // The human takeover holds the lease under the window's controller id.
    await service.takeControl({ laneId: "lane-1", controllerId: "ade-window:abc" });

    const result = await service.click({
      laneId: "lane-1",
      x: 10,
      y: 10,
      mode: "real",
      chatSessionId: "chat-1",
      controllerId: "ade-window:abc",
    });
    expect(result.ok).toBe(true);
    const input = driver.calls.find((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input);
    // The helper keeps its own lease; it is told which holder we authorized.
    expect(input?.payload.lease).toEqual({ holderId: "ade-window:abc" });

    // Without the controller id the same panel looks like an agent chat, and
    // the user's own takeover refuses it.
    await expect(service.click({
      laneId: "lane-1",
      x: 10,
      y: 10,
      mode: "real",
      chatSessionId: "chat-1",
    })).rejects.toMatchObject({ code: "MAC_DESKTOP_USER_HAS_CONTROL" });
    service.dispose();
  });

  it("refuses a real click whose forged controllerId the RPC scope stripped", async () => {
    // An agent can read the human's takeover holder id out of
    // `getStatus().lease.holderId`. Echoing it back as `controllerId` would have
    // made `inputHolderId` hand it the lease, so the RPC scope strips the field
    // from an agent's call — and what arrives here is a real click with only a
    // chat id, which the user's own takeover refuses.
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.takeControl({ laneId: "lane-1", controllerId: "ade-window:human" });
    const holderId = (await service.getStatus({ laneId: "lane-1" })).lease?.holderId;
    expect(holderId).toBe("ade-window:human");

    await expect(service.click({
      laneId: "lane-1",
      x: 10,
      y: 10,
      mode: "real",
      chatSessionId: "chat-agent",
    })).rejects.toMatchObject({ code: "MAC_DESKTOP_USER_HAS_CONTROL" });
    expect(driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input)).toBe(false);
    service.dispose();
  });

  it("sends no lease on an accessibility action", async () => {
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.click({ laneId: "lane-1", text: "OK", chatSessionId: "chat-1" });
    const input = driver.calls.find((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input);
    expect(input?.payload.lease).toBeUndefined();
    service.dispose();
  });
});

describe("macDesktopService recordings", () => {
  it("a user recording stops the turn clip first — one lane, one writer", async () => {
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.beginTurn({ laneId: "lane-1", chatSessionId: "chat-1", turnId: "turn-1" });
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.startRecording)).toHaveLength(1);

    await service.startRecording({ laneId: "lane-1", caption: "the bug" });
    const ops = driver.calls.map((call) => call.op);
    const firstStop = ops.indexOf(MAC_DESKTOP_DRIVER_OPS.stopRecording);
    const secondStart = ops.lastIndexOf(MAC_DESKTOP_DRIVER_OPS.startRecording);
    expect(firstStop).toBeGreaterThanOrEqual(0);
    expect(secondStart).toBeGreaterThan(firstStop);

    // And the turn clip is gone, so the turn ending cannot stop the user's
    // recording out from under them.
    driver.calls.length = 0;
    expect(await service.noteTurnEnded({ laneId: "lane-1", chatSessionId: "chat-1", turnId: "turn-1" }))
      .toBeNull();
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.stopRecording)).toHaveLength(0);
    service.dispose();
  });

  it("ends a turn clip whose turn id no longer matches", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ filePath: "/tmp/clip.mp4", durationMs: 1_200 }),
    });
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.beginTurn({ laneId: "lane-1", chatSessionId: "chat-1", turnId: "turn-1" });
    // A turn that never emitted its own `done`: the next one closes the clip
    // rather than leaving the helper's one recorder held forever.
    const lapse = await service.noteTurnEnded({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      turnId: "turn-2",
    });
    expect(lapse).toMatchObject({ laneId: "lane-1", turnId: "turn-1", filePath: "/tmp/clip.mp4" });
    expect(events.some((event) => event.type === "time-lapse")).toBe(true);
    service.dispose();
  });

  it("stops the turn clip when the lane's display is destroyed", async () => {
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.beginTurn({ laneId: "lane-1", chatSessionId: "chat-1", turnId: "turn-1" });
    driver.calls.length = 0;
    await service.destroyForLane("lane-1");
    expect(driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.stopRecording)).toBe(true);
    service.dispose();
  });

  it("stops the turn clip when the chat that opened it ends", async () => {
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.takeControl({ laneId: "lane-1", controllerId: "chat-1" });
    await service.beginTurn({ laneId: "lane-1", chatSessionId: "chat-1", turnId: "turn-1" });
    driver.calls.length = 0;
    await service.releaseIfOwnedBy("chat-1");
    expect(driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.stopRecording)).toBe(true);
    service.dispose();
  });
});

describe("macDesktopService streaming", () => {
  it("startStream is the only call that hands out the token", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.startStream]: () => ({ port: 65_000, codec: "avc1.640032", width: 2560, height: 1440 }),
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    const started = await service.startStream({ laneId: "lane-1" });
    expect(started.transport?.token).toBeTruthy();
    expect(started.transport?.url).toContain("token=");

    const read = await service.getStreamStatus({ laneId: "lane-1" });
    expect(read.running).toBe(true);
    expect(read.transport?.token).toBeNull();
    expect(read.transport?.url).toBeNull();

    // The redacted half of `getStatus` carries no transport at all.
    const status = await service.getStatus({ laneId: "lane-1" });
    expect(status.stream).toMatchObject({ running: true });
    expect(status.stream).not.toHaveProperty("transport");
    service.dispose();
  });

  it("a second startStream on a running lane keeps the same token", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.startStream]: () => ({ port: 65_000, codec: "avc1.640032", width: 2560, height: 1440 }),
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    const first = await service.startStream({ laneId: "lane-1" });
    // A reconnecting viewer asks again. Minting a second token would evict
    // every client holding the first one.
    const second = await service.startStream({ laneId: "lane-1" });
    expect(second.transport?.token).toBe(first.transport?.token);
    expect(second.transport?.url).toBe(first.transport?.url);
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.startStream)).toHaveLength(1);

    // Only a stopped stream mints one.
    await service.stopStream({ laneId: "lane-1" });
    const third = await service.startStream({ laneId: "lane-1" });
    expect(third.transport?.token).not.toBe(first.transport?.token);
    service.dispose();
  });

  it("keeps a shared stream alive when one of its two chats ends", async () => {
    // The idempotent arm used to hand back the live stream without recording
    // who asked, so the first chat to end took down a stream the second chat
    // was still watching.
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.startStream]: () => ({ port: 65_000, codec: "avc1.640032", width: 2560, height: 1440 }),
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.startStream({ laneId: "lane-1", chatSessionId: "chat-a" });
    await service.startStream({ laneId: "lane-1", chatSessionId: "chat-b" });

    await service.releaseIfOwnedBy("chat-a");
    expect((await service.getStreamStatus({ laneId: "lane-1" })).running).toBe(true);

    // The last asker leaving is what stops it.
    await service.releaseIfOwnedBy("chat-b");
    expect((await service.getStreamStatus({ laneId: "lane-1" })).running).toBe(false);
    service.dispose();
  });
});

describe("macDesktopService teardown", () => {
  it("destroyForLane destroys the lane's display and says so", async () => {
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await expect(service.destroyForLane("lane-1")).resolves.toEqual({ destroyed: true });
    expect(events.some((event) => event.type === "display-destroyed" && event.reason === "lane_removed")).toBe(true);
    await expect(service.destroyForLane("lane-1")).resolves.toEqual({ destroyed: false });
    service.dispose();
  });

  it("a lost driver destroys every lane's display and says why", async () => {
    const driver = createFakeDriver();
    const events: MacDesktopEventPayload[] = [];
    const driverLost: Array<(reason: string) => void> = [];
    const service = createMacDesktopService({
      projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-test-")),
      logger,
      platform: "darwin",
      onEvent: (event) => events.push(event),
      createDriverClient: (args) => {
        driverLost.push(args.onDriverLost);
        return driver as unknown as MacDesktopDriverClient;
      },
    });
    await service.start({ laneId: "lane-1" });
    await service.start({ laneId: "lane-2" });
    driverLost[0]?.("signal SIGKILL");
    const destroyed = events.filter((event) => event.type === "display-destroyed");
    expect(destroyed).toHaveLength(2);
    expect(destroyed.every((event) => event.type === "display-destroyed" && event.reason === "driver_lost")).toBe(true);
    service.dispose();
  });

  it("publishes exactly one display-destroyed when the driver echoes our own destroy", async () => {
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    // The helper emits `display-destroyed` for the destroy ADE asked for. Both
    // copies reaching clients meant a second, vaguer reason overwrote the real
    // one, so the echo is dropped while our own destroy is in flight.
    driver.overrides[MAC_DESKTOP_DRIVER_OPS.destroyDisplay] = () => {
      for (const listener of driver.listeners) {
        listener({ event: "display-destroyed", laneId: "lane-1" });
      }
      return { destroyed: true, releasedWindows: 0 };
    };
    await service.stop({ laneId: "lane-1" });
    const destroyed = events.filter((event) => event.type === "display-destroyed");
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toMatchObject({ laneId: "lane-1", reason: "stopped" });
    service.dispose();
  });

  it("forwards a window the driver could not park", async () => {
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    for (const listener of driver.listeners) {
      listener({ event: "window-not-parked", laneId: "lane-1", windowId: 42, reason: "window_not_ready" });
    }
    // The window is on the user's own screen until something moves it; only the
    // surface watching the lane can say so.
    expect(events).toContainEqual({
      type: "window-not-parked",
      laneId: "lane-1",
      windowId: 42,
      reason: "window_not_ready",
    });
    service.dispose();
  });

  it("subscribers see the same events the runtime stream does", async () => {
    const { service } = makeService();
    const seen: MacDesktopEventPayload[] = [];
    const unsubscribe = service.subscribe((event) => seen.push(event));
    await service.start({ laneId: "lane-1" });
    expect(seen.some((event) => event.type === "display-created")).toBe(true);
    unsubscribe();
    await service.stop({ laneId: "lane-1" });
    expect(seen.some((event) => event.type === "display-destroyed")).toBe(false);
    service.dispose();
  });
});
