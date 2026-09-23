import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ComputerUseArtifactIngestionRequest,
  ComputerUseArtifactIngestionResult,
} from "../../../shared/types/computerUseArtifacts";
import {
  MAC_DESKTOP_IDLE_RELEASE_MS,
  MAC_DESKTOP_LEASE_TTL_MS,
  macDesktopPaneCaption,
  type MacDesktopEventPayload,
} from "../../../shared/types/macDesktop";
import {
  MAC_DESKTOP_DRIVER_OPS,
  MAC_DESKTOP_GESTURE_IN_FLIGHT_CODE,
  type MacDesktopDriverClient,
} from "./macDesktopDriverClient";
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
    /** How many times `restart` was asked for. */
    restartCalls: 0,
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
    async restart() {
      client.restartCalls += 1;
      calls.push({ op: "restart", payload: {} });
    },
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
  ingestArtifacts?: (request: ComputerUseArtifactIngestionRequest) => ComputerUseArtifactIngestionResult;
} = {}) {
  const events: MacDesktopEventPayload[] = [];
  const driver = options.driver ?? createFakeDriver();
  const service = createMacDesktopService({
    projectRoot: options.projectRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-test-")),
    logger,
    platform: options.platform ?? "darwin",
    ...(options.now ? { now: options.now } : {}),
    ...(options.ingestArtifacts ? { ingestArtifacts: options.ingestArtifacts } : {}),
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

  it("tells the prompt a Windows host has no lane screen to offer", () => {
    const { service } = makeService({ platform: "win32" });
    expect(service.supportsLaneDisplaySync()).toBe(false);
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

describe("macDesktopService permissions", () => {
  it("recheckPermissions restarts the driver and returns the fresh probe", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.health]: () => ({
        version: "1.0.0",
        permissions: { screenRecording: "denied", accessibility: "granted" },
        displayMode: "virtual",
      }),
    });
    const { service } = makeService({ driver });
    expect((await service.getStatus({ laneId: "lane-1" })).permissions.screenRecording).toBe("denied");

    // The grant was made in System Settings and macOS showed it to a fresh
    // helper process, which is the whole reason the restart comes first.
    driver.overrides[MAC_DESKTOP_DRIVER_OPS.health] = () => ({
      version: "1.0.0",
      permissions: { screenRecording: "granted", accessibility: "granted" },
      displayMode: "virtual",
    });

    const permissions = await service.recheckPermissions({ restartDriver: true });
    expect(driver.restartCalls).toBe(1);
    expect(permissions).toEqual({ screenRecording: "granted", accessibility: "granted" });
    expect((await service.getStatus({ laneId: "lane-1" })).permissions.screenRecording).toBe("granted");
    service.dispose();
  });

  it("status watch turns the driver permission watch on and off", async () => {
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.getStatus({ laneId: "lane-1" });
    const watches = () => driver.calls
      .filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.watchPermissions)
      .map((call) => call.payload.watch);
    // A plain status read watches nothing: the helper stays idle.
    expect(watches()).toEqual([]);

    const unsubscribe = service.subscribe(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(watches()).toEqual([true]);

    unsubscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(watches()).toEqual([true, false]);
    service.dispose();
  });

  it("request-permission is refused without allowPrompt", async () => {
    const driver = createFakeDriver();
    const service = createMacDesktopService({
      projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-test-")),
      logger,
      platform: "darwin",
      // The lane's Mac is not this computer: prompting would fire a system
      // modal at somebody sitting at a machine that is not theirs.
      hostIsLocal: () => false,
      createDriverClient: () => driver as unknown as MacDesktopDriverClient,
    });
    await service.requestPermission({ which: "screenRecording" });
    const ask = driver.calls.find((call) => call.op === MAC_DESKTOP_DRIVER_OPS.requestPermission);
    expect(ask?.payload).toMatchObject({ which: "screenRecording", allowPrompt: false });
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

  it("refuses an automation's synthetic holder without emitting a request card", async () => {
    const driver = createFakeDriver();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-test-"));
    let asked = 0;
    const service = createMacDesktopService({
      projectRoot,
      logger,
      platform: "darwin",
      createDriverClient: () => driver as unknown as MacDesktopDriverClient,
      // `automation:<ruleId>` is not a chat id, so the real host throws
      // "chat not found" here.
      requestChatInput: async () => {
        asked += 1;
        throw new Error("chat not found");
      },
    });
    const seen: MacDesktopEventPayload[] = [];
    const unsubscribe = service.subscribe((event) => seen.push(event));
    await service.start({ laneId: "lane-1" });
    const result = await service.requestInputLease({ laneId: "lane-1", chatSessionId: "automation:rule-1" });
    expect(result.granted).toBe(false);
    expect(result.code).toBe("MAC_DESKTOP_INPUT_LEASE_REQUIRED");
    expect(asked).toBe(0);
    // No card was promised, so none is left dangling in the UI.
    expect(seen.some((event) => event.type === "lease-requested")).toBe(false);
    unsubscribe();
    service.dispose();
  });

  it("a chat that vanished mid-prompt grants nothing instead of throwing", async () => {
    const driver = createFakeDriver();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-test-"));
    const service = createMacDesktopService({
      projectRoot,
      logger,
      platform: "darwin",
      createDriverClient: () => driver as unknown as MacDesktopDriverClient,
      requestChatInput: async () => { throw new Error("chat not found"); },
    });
    await service.start({ laneId: "lane-1" });
    const result = await service.requestInputLease({ laneId: "lane-1", chatSessionId: "chat-gone" });
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
  it("refuses real input while Accessibility is off, naming the grant, before the driver sees it", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.health]: () => ({
        version: "1.0.0",
        permissions: { screenRecording: "granted", accessibility: "denied" },
        displayMode: "virtual",
      }),
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.takeControl({ laneId: "lane-1", controllerId: "ade-window:abc" });

    // macOS drops a synthetic event posted without Accessibility silently; the
    // service says so instead of letting the takeover look like a dead screen.
    await expect(service.click({
      laneId: "lane-1",
      x: 10,
      y: 10,
      mode: "real",
      chatSessionId: "chat-1",
      controllerId: "ade-window:abc",
    })).rejects.toMatchObject({
      code: "MAC_DESKTOP_PERMISSION_REQUIRED",
      message: expect.stringContaining("Accessibility"),
    });
    expect(driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input)).toBe(false);
  });

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

    // The holder id is readable by anyone who can read the lane's status —
    // including an agent, which is why the RPC scope strips `controllerId` on
    // the way in rather than hiding it here.
    expect((await service.getStatus({ laneId: "lane-1" })).lease?.holderId).toBe("ade-window:abc");

    // Without the controller id the same panel looks like an agent chat, and
    // the user's own takeover refuses it.
    const inputCallsBefore = driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input).length;
    await expect(service.click({
      laneId: "lane-1",
      x: 10,
      y: 10,
      mode: "real",
      chatSessionId: "chat-1",
    })).rejects.toMatchObject({ code: "MAC_DESKTOP_USER_HAS_CONTROL" });
    // Refused before the driver: no second input op was posted.
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input).length)
      .toBe(inputCallsBefore);
    service.dispose();
  });

  it("acts without looking when a takeover asks for silence", async () => {
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.takeControl({ laneId: "lane-1", controllerId: "ade-window:abc" });
    driver.calls.length = 0;
    events.length = 0;

    const result = await service.move({
      laneId: "lane-1",
      x: 12,
      y: 34,
      controllerId: "ade-window:abc",
      chatSessionId: "chat-1",
    });

    // The event reached the driver...
    const input = driver.calls.find((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input);
    expect(input?.payload).toMatchObject({
      command: "move",
      mode: "real",
      lease: { holderId: "ade-window:abc" },
      payload: expect.objectContaining({ restoreCursor: true }),
    });
    // ...and nothing looked at the screen afterwards. No capture, no AX walk.
    expect(driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.observe)).toBe(false);
    // And nothing narrated the user's own pointer back into the chat.
    expect(events.some((event) => event.type === "observation")).toBe(false);
    expect(result).toMatchObject({ ok: true, silent: true, observation: null, trace: null });
    service.dispose();
  });

  it("ignores `silent` from a caller that is not a human takeover", async () => {
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    // An agent chat with its own lease, asking to skip the observation.
    await service.takeControl({ laneId: "lane-1", controllerId: "ade-window:abc" });
    await service.returnControl({ laneId: "lane-1", controllerId: "ade-window:abc" });
    driver.calls.length = 0;
    events.length = 0;

    // No controller id: `silent` is not a thing this caller may ask for, and
    // the observation happens exactly as it always did.
    const result = await service.click({
      laneId: "lane-1",
      text: "OK",
      silent: true,
      chatSessionId: "chat-1",
    });
    expect(driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.observe)).toBe(true);
    expect(events.some((event) => event.type === "observation")).toBe(true);
    expect(result.observation).not.toBeNull();
    service.dispose();
  });

  it("shows the captured pointer while a person drives, and hides it again", async () => {
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    const visibility = () => driver.calls
      .filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.setStreamCursorVisible)
      .map((call) => call.payload.visible);

    await service.takeControl({ laneId: "lane-1", controllerId: "ade-window:abc" });
    expect(visibility()).toEqual([true]);

    // A renewal is not a transition, but it must not contradict one either.
    await service.renewLease({ laneId: "lane-1", holderId: "ade-window:abc" });
    expect(visibility()).toEqual([true, true]);

    await service.returnControl({ laneId: "lane-1", controllerId: "ade-window:abc" });
    expect(visibility()).toEqual([true, true, false]);
    service.dispose();
  });

  it("hides the captured pointer when a takeover lapses instead of ending", async () => {
    vi.useFakeTimers();
    try {
      let clock = 1_000;
      const driver = createFakeDriver();
      const { service } = makeService({ driver, now: () => clock });
      await service.start({ laneId: "lane-1" });
      await service.takeControl({ laneId: "lane-1", controllerId: "ade-window:abc" });
      driver.calls.length = 0;

      // Nobody renewed: the viewer's tab was closed, or the tunnel died. The
      // lease lapses on its own, and the pointer it made visible must not be
      // left drawn on a display nobody is driving.
      clock += MAC_DESKTOP_LEASE_TTL_MS + 1;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(driver.calls
        .filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.setStreamCursorVisible)
        .map((call) => call.payload.visible)).toContain(false);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
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

  it("sends the words to type apart from a text target's label", async () => {
    // Both used to ride `text`: the words overwrote the label, and the driver
    // then searched the screen for the words it was asked to type.
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.type({ laneId: "lane-1", text: "hello", target: { text: "Search" }, chatSessionId: "chat-1" });
    await service.type({ laneId: "lane-1", text: "again", chatSessionId: "chat-1" });
    const inputs = driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input);
    const commandPayload = (call: (typeof inputs)[number]) =>
      (call.payload.payload ?? call.payload) as Record<string, unknown>;
    expect(commandPayload(inputs[0]!)).toMatchObject({ typeText: "hello", text: "Search" });
    expect(commandPayload(inputs[1]!)).toMatchObject({ typeText: "again" });
    expect(commandPayload(inputs[1]!)).not.toHaveProperty("text");
    service.dispose();
  });
});

describe("macDesktopService wait and the gesture gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a wait the driver refused mid-gesture, until it can poll", async () => {
    let refusals = 0;
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.input]: () => {
        // The driver will not poll while a real drag holds the mouse button:
        // the wait would run nested inside the drag's run-loop pump and keep
        // the button down for its whole timeout.
        if (refusals < 2) {
          refusals += 1;
          const error = new Error("a real gesture is in flight") as Error & { code: string };
          error.code = MAC_DESKTOP_GESTURE_IN_FLIGHT_CODE;
          throw error;
        }
        return { ok: true, resolvedIndex: 4 };
      },
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });

    const pending = service.wait({ laneId: "lane-1", text: "Done", timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(refusals).toBe(2);
    const waits = driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input);
    expect(waits).toHaveLength(3);
    // Each retry is charged against the caller's own deadline, not given a
    // fresh one: the third attempt asks for what is left of the ten seconds.
    const remaining = waits.map((call) => (call.payload.payload as { timeoutMs: number }).timeoutMs);
    expect(remaining[0]).toBe(10_000);
    expect(remaining[2]).toBeLessThan(10_000);
    service.dispose();
  });

  it("stops retrying at the caller's deadline and answers like an unmatched wait", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.input]: () => {
        const error = new Error("a real gesture is in flight") as Error & { code: string };
        error.code = MAC_DESKTOP_GESTURE_IN_FLIGHT_CODE;
        throw error;
      },
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });

    const pending = service.wait({ laneId: "lane-1", text: "Done", timeoutMs: 600 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    // The same answer an unmatched poll gives, because it is the same fact.
    expect(result.ok).toBe(false);
    expect(result.matched).toBeNull();
    expect(result.waitedMs).toBeGreaterThanOrEqual(600);
    // Bounded by the deadline, not by the gesture: it stopped asking.
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input).length)
      .toBeLessThanOrEqual(4);
    service.dispose();
  });

  it("surfaces any other driver failure instead of retrying it", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.input]: () => {
        const error = new Error("no display") as Error & { code: string };
        error.code = "MAC_DESKTOP_NO_DISPLAY";
        throw error;
      },
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await expect(service.wait({ laneId: "lane-1", text: "Done", timeoutMs: 1_000 }))
      .rejects.toMatchObject({ code: "MAC_DESKTOP_NO_DISPLAY" });
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

  it("a stop that fails marks the recording failed instead of leaving it running", async () => {
    // The driver removed its recorder before it finalised, so a stop that
    // timed out left the local status on `running: true` with no file while
    // the next stop answered "not running" — two states, one recording.
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => {
        throw new Error("internal_error: record.stop did not complete within 16s.");
      },
    });
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    const started = await service.startRecording({ laneId: "lane-1", caption: "the bug" });
    expect(started.running).toBe(true);

    await expect(service.stopRecording({ laneId: "lane-1" }))
      .rejects.toThrow(/did not complete/);

    const status = await service.getStatus({ laneId: "lane-1" });
    expect(status.recording).toMatchObject({
      running: false,
      lastError: expect.stringContaining("did not complete"),
    });
    // The path the helper was handed is what a partial recording lives at;
    // naming it is what keeps the failure actionable.
    expect(status.recording?.filePath).toMatch(/mac-desktop-recording-lane-1.*\.mp4$/);
    // The stop button's surface hears about the transition, not just the throw.
    expect(events.filter((event) =>
      event.type === "recording-changed" && event.status.running === false)).toHaveLength(1);

    // A second stop reports a clean failure and names the partial file.
    await expect(service.stopRecording({ laneId: "lane-1" }))
      .rejects.toThrow(/is not recording its desktop.*mac-desktop-recording-lane-1/);
    service.dispose();
  });

  it("a clean stop clears the failure state", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ filePath: "/tmp/clip.mp4", durationMs: 1_200 }),
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.startRecording({ laneId: "lane-1", caption: "the fix" });
    const stopped = await service.stopRecording({ laneId: "lane-1", chatSessionId: "chat-1" });
    expect(stopped).toMatchObject({ running: false, filePath: "/tmp/clip.mp4", durationMs: 1_200, lastError: null });

    // A second stop is a clean "not running" with no path to report.
    await expect(service.stopRecording({ laneId: "lane-1" }))
      .rejects.toThrow(/MAC_DESKTOP_RECORDING_NOT_RUNNING: Lane lane-1 is not recording its desktop\.$/);
    service.dispose();
  });
});

/**
 * A broker that remembers what it was asked to file and answers with one
 * record per input, the way `computerUseArtifactBrokerService.ingest` does.
 */
function createFakeBroker() {
  const requests: ComputerUseArtifactIngestionRequest[] = [];
  const ingest = (request: ComputerUseArtifactIngestionRequest): ComputerUseArtifactIngestionResult => {
    requests.push(request);
    return {
      artifacts: request.inputs.map((input, index) => ({
        id: `artifact-${requests.length}-${index}`,
        kind: input.kind,
        title: input.title ?? "",
      })) as unknown as ComputerUseArtifactIngestionResult["artifacts"],
      links: [],
    };
  };
  return { requests, ingest };
}

/** A real file for the driver to "finish", so the size can be read back. */
function writeCapture(name: string, bytes: number): string {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-capture-")), name);
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
  return filePath;
}

describe("macDesktopService proof from the pane", () => {
  it("names a pane capture after the lane, and plainly without one", () => {
    expect(macDesktopPaneCaption("recording", "docs-fix")).toBe("Mac Desktop recording · docs-fix");
    expect(macDesktopPaneCaption("screenshot", "  ")).toBe("Mac Desktop screenshot");
    expect(macDesktopPaneCaption("recording", null)).toBe("Mac Desktop recording");
  });

  it("files a captioned recording and hands back its proof record and size", async () => {
    const clip = writeCapture("clip.mp4", 3_072);
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ filePath: clip, durationMs: 12_000 }),
    });
    const broker = createFakeBroker();
    const { service } = makeService({ driver, ingestArtifacts: broker.ingest });
    await service.start({ laneId: "lane-1" });
    await service.startRecording({
      laneId: "lane-1",
      caption: macDesktopPaneCaption("recording", "docs-fix"),
      chatSessionId: "chat-1",
    });

    const stopped = await service.stopRecording({ laneId: "lane-1", chatSessionId: "chat-1" });

    expect(stopped).toMatchObject({
      running: false,
      filePath: clip,
      durationMs: 12_000,
      proofArtifactId: "artifact-1-0",
      bytes: 3_072,
    });
    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0]!.inputs[0]).toMatchObject({
      kind: "video_recording",
      title: "Mac Desktop recording · docs-fix",
      path: clip,
    });
    // The status read afterwards agrees with what the stop returned.
    expect((await service.getStatus({ laneId: "lane-1" })).recording?.proofArtifactId).toBe("artifact-1-0");
    service.dispose();
  });

  it("keeps an uncaptioned recording out of the drawer, as an agent's must be", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ filePath: "/tmp/clip.mp4", durationMs: 1_200 }),
    });
    const broker = createFakeBroker();
    const { service } = makeService({ driver, ingestArtifacts: broker.ingest });
    await service.start({ laneId: "lane-1" });
    await service.startRecording({ laneId: "lane-1" });

    const stopped = await service.stopRecording({ laneId: "lane-1" });

    expect(stopped.proofArtifactId).toBeNull();
    expect(broker.requests).toHaveLength(0);
    service.dispose();
  });

  it("files a captioned screenshot, and leaves an uncaptioned one as scratch", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.screenshot]: (payload) => {
        fs.writeFileSync(String(payload.path), Buffer.alloc(2_048));
        return { filePath: payload.path, width: 2560, height: 1440 };
      },
    });
    const broker = createFakeBroker();
    const { service } = makeService({ driver, ingestArtifacts: broker.ingest });
    await service.start({ laneId: "lane-1" });

    const scratch = await service.screenshot({ laneId: "lane-1" });
    expect(scratch.proofArtifactId).toBeUndefined();
    expect(broker.requests).toHaveLength(0);

    const filed = await service.screenshot({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      caption: macDesktopPaneCaption("screenshot", "docs-fix"),
    });
    expect(filed).toMatchObject({ proofArtifactId: "artifact-1-0", bytes: 2_048 });
    expect(broker.requests[0]!.inputs[0]).toMatchObject({
      kind: "screenshot",
      title: "Mac Desktop screenshot · docs-fix",
      path: filed.filePath,
    });
    expect(broker.requests[0]!.owners).toEqual(expect.arrayContaining([
      { kind: "lane", id: "lane-1", relation: "attached_to" },
      { kind: "chat_session", id: "chat-1", relation: "attached_to" },
    ]));
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
    // The redacted viewer list names both askers as ids, so the floating
    // preview can tell which chat may show the lane's screen.
    expect((await service.getStreamStatus({ laneId: "lane-1" })).viewerChatSessionIds.sort())
      .toEqual(["chat-a", "chat-b"]);

    await service.releaseIfOwnedBy("chat-a");
    const shared = await service.getStreamStatus({ laneId: "lane-1" });
    expect(shared.running).toBe(true);
    expect(shared.viewerChatSessionIds).toEqual(["chat-b"]);

    // The last asker leaving is what stops it.
    await service.releaseIfOwnedBy("chat-b");
    const stopped = await service.getStreamStatus({ laneId: "lane-1" });
    expect(stopped.running).toBe(false);
    expect(stopped.viewerChatSessionIds).toEqual([]);
    service.dispose();
  });

  it("shares the stream with a sync subscription without calling it a chat", async () => {
    // The web/phone live view asks through the same start path but is a
    // subscription, not a chat: it must keep the encoder up for a chat that is
    // watching while staying out of `viewerChatSessionIds`, which the floating
    // preview reads as "the chat you are looking at is watching this lane".
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.startStream]: () => ({ port: 65_000, codec: "avc1.640032", width: 2560, height: 1440 }),
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.startStream({ laneId: "lane-1", chatSessionId: "chat-a" });

    const started = await service.startStreamForSubscription({ laneId: "lane-1", subscriptionId: "sub-1" });
    expect(started.running).toBe(true);
    expect((await service.getStreamStatus({ laneId: "lane-1" })).viewerChatSessionIds).toEqual(["chat-a"]);

    // Either kind of last owner leaving is what stops it.
    await service.releaseIfOwnedBy("chat-a");
    expect((await service.getStreamStatus({ laneId: "lane-1" })).running).toBe(true);
    await service.releaseStreamSubscription("sub-1");
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
