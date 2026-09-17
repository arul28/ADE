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
    ops: MAC_DESKTOP_DRIVER_OPS,
    calls,
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
