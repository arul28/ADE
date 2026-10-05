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
  MAC_DESKTOP_USER_CLI_HOLDER_ID,
  macDesktopPaneCaption,
  type MacDesktopEventPayload,
  type MacDesktopRecordingStatus,
} from "../../../shared/types/macDesktop";
import {
  MAC_DESKTOP_DRIVER_OPS,
  MAC_DESKTOP_GESTURE_IN_FLIGHT_CODE,
  type MacDesktopDriverClient,
} from "./macDesktopDriverClient";
import { createMacDesktopService } from "./macDesktopService";
import type { DesktopSeatAdapter } from "./macDesktopSeatProvider";
import type { MacDesktopRequestChatInput } from "./macDesktopLeaseFlow";
import { createWindowsDesktopSeatAdapter } from "../windowsDesktop/windowsDesktopSeatProvider";
import { MAC_DESKTOP_STREAM_STALE_MS } from "./macDesktopStreaming";
import { readProofProvenance } from "../../../shared/proofProvenance";
import { describeDesktopSeat, desktopSeatKind } from "../../../shared/desktopSeat";
import type { DemoEngine } from "../../../shared/demoVideo/demoContract";
import { movie } from "../demoVideo/__fixtures__/demoMp4Bytes";

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
  const calls: Array<{ op: string; payload: Record<string, unknown>; options?: { timeoutMs?: number } }> = [];
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
    async request(op: string, payload: Record<string, unknown> = {}, options?: { timeoutMs?: number }) {
      calls.push({ op, payload, ...(options ? { options } : {}) });
      const override = overrides[op];
      if (override) {
        const result = override(payload);
        if (op === MAC_DESKTOP_DRIVER_OPS.stopRecording && result && typeof result === "object") {
          const started = calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.startRecording).at(-1);
          const rawPath = started?.payload.filePath;
          if (typeof rawPath === "string") {
            fs.mkdirSync(path.dirname(rawPath), { recursive: true });
            const { rawBytes, ...values } = result as Record<string, unknown>;
            // `rawBytes`: what the recorder really wrote, for a test of the file itself.
            fs.writeFileSync(rawPath, Buffer.isBuffer(rawBytes) ? rawBytes : String(values.wallDurationMs ?? values.durationMs ?? 1_200));
            return { ...values, filePath: rawPath };
          }
        }
        return result;
      }
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
        case MAC_DESKTOP_DRIVER_OPS.startRecording:
          if (typeof payload.filePath === "string") {
            fs.mkdirSync(path.dirname(payload.filePath), { recursive: true });
            fs.writeFileSync(payload.filePath, "1200");
          }
          return {};
        case MAC_DESKTOP_DRIVER_OPS.stopRecording: {
          const started = calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.startRecording).at(-1);
          return { filePath: started?.payload.filePath, durationMs: 1_200 };
        }
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
  seat?: DesktopSeatAdapter;
  hostIsLocal?: () => boolean;
  driver?: ReturnType<typeof createFakeDriver>;
  projectRoot?: string;
  now?: () => number;
  ingestArtifacts?: (request: ComputerUseArtifactIngestionRequest) => ComputerUseArtifactIngestionResult;
  captureAnalytics?: (properties: { action: "mac_desktop"; outcome: "started" | "agent_drove" | "recorded" }) => void;
  requestChatInput?: MacDesktopRequestChatInput;
  /** Replaces the fake demo engine; `[]` is a host with none. */
  demoEngines?: DemoEngine[];
  isArtifactFileReferenced?: (filePath: string) => boolean;
} = {}) {
  const events: MacDesktopEventPayload[] = [];
  const driver = options.driver ?? createFakeDriver();
  const demoEngine: DemoEngine = {
    id: "chromium",
    canRead: (filePath) => filePath.endsWith(".mp4"),
    async analyze(filePath) {
      const durationSeconds = Number(fs.readFileSync(filePath, "utf8")) / 1000;
      return { version: 1, width: 640, height: 480, durationSeconds, frames: [{ t: 0, changed: 1 }] };
    },
    async render({ input, output, plan }) {
      fs.copyFileSync(input, output);
      return { bytes: fs.statSync(output).size, durationSeconds: plan.durationSeconds, frames: 1 };
    },
  };
  const service = createMacDesktopService({
    projectRoot: options.projectRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-test-")),
    logger,
    platform: options.platform ?? "darwin",
    ...(options.seat ? { seat: options.seat } : {}),
    ...(options.hostIsLocal ? { hostIsLocal: options.hostIsLocal } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.ingestArtifacts ? { ingestArtifacts: options.ingestArtifacts } : {}),
    ...(options.captureAnalytics ? { captureAnalytics: options.captureAnalytics } : {}),
    ...(options.requestChatInput ? { requestChatInput: options.requestChatInput } : {}),
    ...(options.isArtifactFileReferenced ? { isArtifactFileReferenced: options.isArtifactFileReferenced } : {}),
    demoEngines: { engines: () => options.demoEngines ?? [demoEngine] },
    onEvent: (event) => events.push(event),
    createDriverClient: () => driver as unknown as MacDesktopDriverClient,
  });
  return { service, driver, events };
}

describe("Windows seat through the shared desktop service", () => {
  const readyHost = { state: "ready", locked: false, childSessionsEnabled: true, remoteDesktopAllowed: true, passwordSaved: false, consoleSessionId: 1, sessionId: 1, inConsoleSession: true, holderLaneId: null, childSessionId: null, edition: "Professional" };
  function windowsService(
    status: Record<string, unknown>,
    hostIsLocal = true,
    options: Omit<NonNullable<Parameters<typeof makeService>[0]>, "platform" | "seat" | "driver" | "hostIsLocal"> & {
      ops?: Record<string, (payload: Record<string, unknown>) => unknown>;
    } = {},
  ) {
    const { ops, ...rest } = options;
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.windowsStatus]: () => status,
      [MAC_DESKTOP_DRIVER_OPS.health]: () => ({ version: "1.0.0", windowsDesktop: status }),
      ...ops,
    });
    const seat = { ...createWindowsDesktopSeatAdapter({ logger, adeHome: "C:\\ADE" }), createDriverClient: null };
    return makeService({ platform: "win32", seat, driver, hostIsLocal: () => hostIsLocal, ...rest });
  }

  it("starts and stops a Windows lane through the shared lifecycle and reports native host identity", async () => {
    const { service } = windowsService(readyHost);
    try {
      const started = await service.start({ laneId: "windows-lane" });
      expect(started.supported).toBe(true);
      expect(started.display?.laneId).toBe("windows-lane");
      expect(started.windowsDesktop).toMatchObject({ driverSessionId: 1, hostIsConsoleSession: true, edition: "Professional" });
      await service.stop({ laneId: "windows-lane" });
      expect((await service.getStatus({ laneId: "windows-lane" })).display).toBeNull();
    } finally { service.dispose(); }
  });

  it.each([
    ["locked", "WINDOWS_DESKTOP_LOCKED"],
    ["setup_required", "WINDOWS_DESKTOP_SETUP_REQUIRED"],
    ["not_console_session", "WINDOWS_DESKTOP_NOT_CONSOLE_SESSION"],
    ["held", "WINDOWS_DESKTOP_HELD"],
  ])("refuses a private start on a %s host", async (state, code) => {
    const { service } = windowsService({ ...readyHost, state, holderLaneId: state === "held" ? "other-lane" : null });
    try {
      await expect(service.start({ laneId: "windows-lane" })).rejects.toMatchObject({ code });
      expect((await service.getStatus({ laneId: "windows-lane" })).display).toBeNull();
    } finally { service.dispose(); }
  });

  it.each([
    [true, false], [false, true], [false, false], [true, true],
  ])("requires explicit consent from either client location (local=%s consent=%s)", async (local, consent) => {
    const { service } = windowsService(readyHost, local);
    try {
      const start = service.start({ laneId: "windows-lane", seatMode: "shared", sharedDesktopConsent: consent });
      if (consent) {
        await expect(start).resolves.toMatchObject({ display: { laneId: "windows-lane" } });
        expect((await service.getStatus({ laneId: "windows-lane" })).display?.laneId).toBe("windows-lane");
        await service.stop({ laneId: "windows-lane" });
        expect((await service.getStatus({ laneId: "windows-lane" })).display).toBeNull();
      } else {
        await expect(start).rejects.toMatchObject({ code: "WINDOWS_DESKTOP_CONSENT_REQUIRED" });
        expect((await service.getStatus({ laneId: "windows-lane" })).display).toBeNull();
      }
    } finally { service.dispose(); }
  });
});

describe("Windows Desktop seats, consent and window verbs", () => {
  const readyHost = { state: "ready", locked: false, childSessionsEnabled: true, remoteDesktopAllowed: true, passwordSaved: true, consoleSessionId: 1, sessionId: 1, inConsoleSession: true, holderLaneId: null, childSessionId: null, edition: "Professional" };
  function windowsService(options: Omit<NonNullable<Parameters<typeof makeService>[0]>, "platform" | "seat" | "driver"> & {
    ops?: Record<string, (payload: Record<string, unknown>) => unknown>;
  } = {}) {
    const { ops, ...rest } = options;
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.windowsStatus]: () => readyHost,
      [MAC_DESKTOP_DRIVER_OPS.health]: () => ({ version: "1.0.0", windowsDesktop: readyHost }),
      ...ops,
    });
    const seat = { ...createWindowsDesktopSeatAdapter({ logger, adeHome: "C:\\ADE" }), createDriverClient: null };
    return makeService({ platform: "win32", seat, driver, ...rest });
  }
  /** A chat host that answers the one question it is asked with `picked`. */
  function answering(response: { decision: string; picked: string[]; responseText?: string | null }) {
    const asked: string[] = [];
    const requestChatInput: MacDesktopRequestChatInput = async (input) => {
      asked.push(input.chatSessionId);
      return {
        decision: response.decision,
        answers: { [input.questions?.[0]?.id ?? "q"]: response.picked },
        responseText: response.responseText ?? null,
      };
    };
    return { asked, requestChatInput };
  }
  const inputOps = (driver: ReturnType<typeof createFakeDriver>, laneId: string) =>
    driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input && call.payload.laneId === laneId);

  it.each([
    ["the Allow option", { decision: "accept", picked: ["allow"] }, true],
    ["Allow in another case, with spaces", { decision: "accept", picked: ["  Allow "] }, true],
    ["typed 'no'", { decision: "accept", picked: ["no"] }, false],
    ["typed 'disallow'", { decision: "accept", picked: ["disallow"] }, false],
    ["typed 'I do not want to allow'", { decision: "accept", picked: ["I do not want to allow"] }, false],
    ["both options at once", { decision: "accept", picked: ["allow", "deny"] }, false],
    ["an accept with only free text", { decision: "accept", picked: [], responseText: "allow" }, false],
    ["a decline", { decision: "decline", picked: ["allow"] }, false],
    ["a cancel", { decision: "cancel", picked: ["allow"] }, false],
  ])("a consent card grants only on the Allow option: %s", async (_name, response, grants) => {
    // The Mac input lease.
    const mac = makeService({ requestChatInput: answering(response).requestChatInput });
    await mac.service.start({ laneId: "lane-1" });
    const lease = await mac.service.requestInputLease({ laneId: "lane-1", chatSessionId: "chat-1" });
    expect(lease.granted).toBe(grants);
    expect((await mac.service.getStatus({ laneId: "lane-1" })).lease?.holderId ?? null).toBe(grants ? "chat-1" : null);
    mac.service.dispose();

    // The Windows main desktop.
    const windows = windowsService({ requestChatInput: answering(response).requestChatInput });
    const shared = windows.service.requestSharedDesktop({ laneId: "lane-1", chatSessionId: "chat-1", reason: "check the tray" });
    if (grants) {
      await expect(shared).resolves.toMatchObject({ display: { laneId: "lane-1", seatMode: "shared" } });
    } else {
      await expect(shared).rejects.toMatchObject({ code: "WINDOWS_DESKTOP_CONSENT_REQUIRED" });
      expect(windows.driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.createDisplay)).toBe(false);
    }
    windows.service.dispose();
  });

  it("asks for the main desktop once per chat, forgets it with the chat, and never asks without a chat", async () => {
    const card = answering({ decision: "accept", picked: ["allow"] });
    const { service, driver } = windowsService({ requestChatInput: card.requestChatInput });
    try {
      await service.requestSharedDesktop({ laneId: "lane-1", chatSessionId: "chat-1", reason: null });
      await service.stop({ laneId: "lane-1" });
      // The same chat, after the screen stopped: no second card.
      await expect(service.requestSharedDesktop({ laneId: "lane-1", chatSessionId: "chat-1", reason: null }))
        .resolves.toMatchObject({ display: { seatMode: "shared" } });
      expect(card.asked).toEqual(["chat-1"]);
      await service.stop({ laneId: "lane-1" });

      // The chat closed: its consent went with it.
      await service.releaseIfOwnedBy("chat-1");
      await service.requestSharedDesktop({ laneId: "lane-1", chatSessionId: "chat-1", reason: null });
      expect(card.asked).toEqual(["chat-1", "chat-1"]);
      await service.stop({ laneId: "lane-1" });

      // No chat, or an automation's synthetic holder: nobody to ask, no card.
      const creates = driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.createDisplay).length;
      for (const chatSessionId of [null, "automation:rule-1"]) {
        await expect(service.requestSharedDesktop({ laneId: "lane-2", chatSessionId, reason: null }))
          .rejects.toMatchObject({ code: "WINDOWS_DESKTOP_CONSENT_REQUIRED" });
      }
      expect(card.asked).toHaveLength(2);
      expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.createDisplay)).toHaveLength(creates);
    } finally { service.dispose(); }
  });

  it("starts nothing when the card is overtaken: a private start while it is open, or its deadline", async () => {
    // The card stays open until answered or withdrawn, as the real one does.
    const open: Array<{ allow: () => void }> = [];
    let cardShown: () => void = () => {};
    const shown = new Promise<void>((resolve) => { cardShown = resolve; });
    const requestChatInput: MacDesktopRequestChatInput = (input) => new Promise((resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(new Error("withdrawn")));
      open.push({ allow: () => resolve({ decision: "accept", answers: { [input.questions?.[0]?.id ?? "q"]: ["allow"] }, responseText: null }) });
      cardShown();
    });
    const { service, driver } = windowsService({ requestChatInput });
    try {
      const shared = service.requestSharedDesktop({ laneId: "lane-1", chatSessionId: "chat-1", reason: null });
      await shown;
      await service.start({ laneId: "lane-1" });
      open[0]!.allow();
      await expect(shared).rejects.toMatchObject({ code: "WINDOWS_DESKTOP_CONSENT_REQUIRED" });
      expect((await service.getStatus({ laneId: "lane-1" })).display?.seatMode).toBe("private");
    } finally { service.dispose(); }

    vi.useFakeTimers();
    const late = windowsService({ requestChatInput });
    try {
      let settled: unknown = null;
      const shared = late.service.requestSharedDesktop({ laneId: "lane-2", chatSessionId: "chat-2", reason: null })
        .then(() => "started", (error: { code?: string }) => error.code);
      void shared.then((value) => { settled = value; });
      await vi.advanceTimersByTimeAsync(169_000);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe("WINDOWS_DESKTOP_CONSENT_REQUIRED");
      // The user's Allow arrives after the card was withdrawn.
      open.at(-1)!.allow();
      await vi.advanceTimersByTimeAsync(0);
      expect(late.driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.createDisplay)).toBe(false);
      expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.createDisplay)).toHaveLength(1);
    } finally {
      late.service.dispose();
      vi.useRealTimers();
    }
  });

  it("authorizes real input per seat: private needs no lease, shared takes it once, the user and the first lane win", async () => {
    const { service, driver } = windowsService();
    try {
      await service.start({ laneId: "private" });
      await service.start({ laneId: "shared-1", seatMode: "shared", sharedDesktopConsent: true });
      await service.start({ laneId: "shared-2", seatMode: "shared", sharedDesktopConsent: true });
      const real = (laneId: string, chatSessionId?: string | null) =>
        service.click({ laneId, x: 10, y: 10, mode: "real", ...(chatSessionId ? { chatSessionId } : {}) });

      // Private: its own session, its own pointer. No lease is taken or needed.
      await expect(real("private", "chat-p")).resolves.toMatchObject({ ok: true });
      expect((await service.getStatus({ laneId: "private" })).lease).toBeNull();

      // Shared: the user's consent covers this lane's chats; the lease is taken.
      await expect(real("shared-1", "chat-1")).resolves.toMatchObject({ ok: true });
      expect((await service.getStatus({ laneId: "shared-1" })).lease?.holderId).toBe("chat-1");
      // A second shared lane cannot drive the user's one pointer meanwhile.
      await expect(real("shared-2", "chat-2")).rejects.toMatchObject({ code: "MAC_DESKTOP_LEASE_HELD_BY_OTHER" });
      expect(inputOps(driver, "shared-2")).toHaveLength(0);
      // A caller with no chat is nobody's consent.
      await expect(real("shared-1", null)).rejects.toMatchObject({ code: "MAC_DESKTOP_INPUT_LEASE_REQUIRED" });

      // A person who took control keeps it, on either seat.
      await service.takeControl({ laneId: "private", controllerId: "ade-window:user" });
      await expect(real("private", "chat-p")).rejects.toMatchObject({ code: "MAC_DESKTOP_USER_HAS_CONTROL" });
      expect(inputOps(driver, "private")).toHaveLength(1);
    } finally { service.dispose(); }

    // A Mac still needs the chat's own lease.
    const mac = makeService();
    await mac.service.start({ laneId: "lane-1" });
    await expect(mac.service.click({ laneId: "lane-1", x: 1, y: 1, mode: "real", chatSessionId: "chat-1" }))
      .rejects.toMatchObject({ code: "MAC_DESKTOP_INPUT_LEASE_REQUIRED" });
    mac.service.dispose();

    // The user's own trusted `ade` with no chat (`ade --role cto screen …`)
    // arrives under its stable holder and drives the shared seat it started;
    // an agent's `ade` shell with no chat arrives as nobody and is refused.
    const cli = windowsService({
      ops: { [MAC_DESKTOP_DRIVER_OPS.launch]: () => ({ pid: 900, appName: "Notepad", windows: [] }) },
    });
    try {
      await cli.service.start({ laneId: "shared-1", seatMode: "shared", sharedDesktopConsent: true });
      await cli.service.start({ laneId: "shared-2", seatMode: "shared", sharedDesktopConsent: true });
      const trusted = { holderId: MAC_DESKTOP_USER_CLI_HOLDER_ID };
      await expect(cli.service.open({ laneId: "shared-1", target: "notepad" }))
        .rejects.toMatchObject({ code: "MAC_DESKTOP_INPUT_LEASE_REQUIRED" });
      await expect(cli.service.click({ laneId: "shared-1", x: 10, y: 10, mode: "real" }))
        .rejects.toMatchObject({ code: "MAC_DESKTOP_INPUT_LEASE_REQUIRED" });
      expect(inputOps(cli.driver, "shared-1")).toHaveLength(0);

      await expect(cli.service.open({ laneId: "shared-1", target: "notepad", ...trusted })).resolves.toBeTruthy();
      await expect(cli.service.click({ laneId: "shared-1", x: 10, y: 10, mode: "real", ...trusted }))
        .resolves.toMatchObject({ ok: true });
      expect((await cli.service.getStatus({ laneId: "shared-1" })).lease?.holderId).toBe(MAC_DESKTOP_USER_CLI_HOLDER_ID);
      // Still one pointer per host: another shared lane waits.
      await expect(cli.service.click({ laneId: "shared-2", x: 10, y: 10, mode: "real", ...trusted }))
        .rejects.toMatchObject({ code: "MAC_DESKTOP_LEASE_HELD_BY_OTHER" });
      // And a person who takes control in the pane wins.
      await cli.service.takeControl({ laneId: "shared-1", controllerId: "ade-window:user" });
      await expect(cli.service.click({ laneId: "shared-1", x: 10, y: 10, mode: "real", ...trusted }))
        .rejects.toMatchObject({ code: "MAC_DESKTOP_USER_HAS_CONTROL" });
    } finally { cli.service.dispose(); }
  });

  it("acts only on the lane's own windows, and refuses the window verbs on a Mac", async () => {
    const notepad = { id: 501, pid: 900, appName: "Notepad", title: "a.txt", laneId: "lane-2" };
    const { service, driver } = windowsService({
      ops: {
        [MAC_DESKTOP_DRIVER_OPS.launch]: () => ({ pid: 900, appName: "Notepad", windows: [notepad] }),
        // The driver lists a lane's windows (and every window for no lane).
        [MAC_DESKTOP_DRIVER_OPS.listWindows]: (payload) => ({
          windows: payload.laneId == null || payload.laneId === "lane-2" ? [notepad] : [],
        }),
      },
    });
    try {
      await service.start({ laneId: "lane-1", seatMode: "shared", sharedDesktopConsent: true });
      await service.start({ laneId: "lane-2" });
      await service.open({ laneId: "lane-2", target: "notepad", chatSessionId: "chat-2" });
      const verbs = new Set<string>([MAC_DESKTOP_DRIVER_OPS.windowFocus, MAC_DESKTOP_DRIVER_OPS.windowMinimize, MAC_DESKTOP_DRIVER_OPS.windowClose]);
      const windowOps = () => driver.calls.filter((call) => verbs.has(call.op));

      await expect(service.focusWindow({ laneId: "lane-1", windowId: 501, chatSessionId: "chat-1" }))
        .rejects.toMatchObject({ code: "MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE" });
      await expect(service.closeWindow({ laneId: "lane-1", windowId: 501, chatSessionId: "chat-1" }))
        .rejects.toMatchObject({ code: "MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE" });
      await expect(service.minimizeWindow({ laneId: "lane-1", windowId: 999, chatSessionId: "chat-1" }))
        .rejects.toMatchObject({ code: "MAC_DESKTOP_WINDOW_NOT_FOUND" });
      expect(windowOps()).toEqual([]);

      await expect(service.minimizeWindow({ laneId: "lane-2", windowId: 501, chatSessionId: "chat-2" }))
        .resolves.toMatchObject({ laneId: "lane-2", windowId: 501, action: "minimize" });
      expect(windowOps().map(({ op, payload }) => ({ op, payload }))).toEqual([{ op: "window.minimize", payload: { laneId: "lane-2", windowId: 501 } }]);
    } finally { service.dispose(); }

    const mac = makeService();
    await mac.service.start({ laneId: "lane-1" });
    for (const verb of ["focusWindow", "minimizeWindow", "closeWindow"] as const) {
      await expect(mac.service[verb]({ laneId: "lane-1", windowId: 1 }))
        .rejects.toMatchObject({ code: "MAC_DESKTOP_UNSUPPORTED_PLATFORM" });
    }
    expect(mac.driver.calls.some((call) => /^window\.(focus|minimize|close)$/.test(call.op))).toBe(false);
    mac.service.dispose();
  });

  it("puts the running operation on every status and the outcome after, without starting a second", async () => {
    let finishSetup: () => void = () => {};
    let setupBegan: () => void = () => {};
    const began = new Promise<void>((resolve) => { setupBegan = resolve; });
    let setups = 0;
    const { service, events } = windowsService({
      ops: {
        [MAC_DESKTOP_DRIVER_OPS.setupWindows]: () => {
          setups += 1;
          if (setups > 1) return { status: readyHost };
          setupBegan();
          return new Promise((resolve) => { finishSetup = () => resolve({ status: readyHost }); });
        },
      },
    });
    try {
      await service.getStatus({});
      const setup = service.setupWindowsDesktop({ allowPrompt: true });
      await began;
      expect((await service.getStatus({})).windowsDesktop).toMatchObject({ operation: { kind: "setup" }, lastOperation: null });

      // A second request while one runs joins the record instead of replacing it.
      await service.setupWindowsDesktop({ allowPrompt: true, savePassword: true });
      expect((await service.getStatus({})).windowsDesktop?.operation).toMatchObject({ kind: "setup" });

      finishSetup();
      await setup;
      const after = (await service.getStatus({})).windowsDesktop;
      expect(after?.operation).toBeNull();
      expect(after?.lastOperation).toMatchObject({ kind: "setup", outcome: "succeeded", error: null });
      // A pane that was closed meanwhile learns both edges from the events.
      const published = events.flatMap((event) => (event.type === "windows-desktop-changed" ? [event.status.operation?.kind ?? null] : []));
      expect(published).toEqual(["setup", null]);
    } finally { service.dispose(); }
  });

  it("caps typed text a Windows seat sends key by key, with a budget that grows with the text", async () => {
    const { service, driver } = windowsService();
    try {
      await service.start({ laneId: "private" });
      await service.start({ laneId: "shared", seatMode: "shared", sharedDesktopConsent: true });
      const typeTimeouts = (laneId: string) => inputOps(driver, laneId).map((call) => call.options?.timeoutMs ?? null);

      // Private: every type is key by key. Over the cap is refused before the driver.
      await expect(service.type({ laneId: "private", text: "x".repeat(4_001), chatSessionId: "chat-1" }))
        .rejects.toThrow(/4000/);
      expect(inputOps(driver, "private")).toHaveLength(0);
      await service.type({ laneId: "private", text: "short", chatSessionId: "chat-1" });
      await service.type({ laneId: "private", text: "y".repeat(3_000), chatSessionId: "chat-1" });
      const [short, long] = typeTimeouts("private");
      expect(short).toBeGreaterThan(0);
      expect(long).toBeGreaterThan(short!);

      // Shared, accessibility: the value is set at once, so no cap applies.
      await service.type({ laneId: "shared", text: "z".repeat(5_000), mode: "accessibility", chatSessionId: "chat-2" });
      expect(typeTimeouts("shared")).toEqual([null]);
      // Shared, real input: key by key again, and capped.
      await expect(service.type({ laneId: "shared", text: "z".repeat(5_000), mode: "real", chatSessionId: "chat-2" }))
        .rejects.toThrow(/4000/);
    } finally { service.dispose(); }
  });
});

describe("desktop seat summary (the status `seat` every text surface leads with)", () => {
  const display = (extra: Record<string, unknown>) => ({ laneId: "lane-1", mode: "virtual", ...extra }) as never;
  const host = (extra: Record<string, unknown>) => ({
    state: "ready", locked: false, childSessionsEnabled: true, remoteDesktopAllowed: true, passwordSaved: true,
    privateAvailable: true, privateUnavailableReason: null, heldByLaneId: null, heldByLaneName: null, seatMode: null, ...extra,
  }) as never;
  it.each([
    // [case, platform, supported, display, windowsDesktop, kind, seat, lease, next step]
    ["Mac with a display", "darwin", true, display({}), null, "mac", "virtual-display", true, null],
    ["Mac in the off-screen fallback", "darwin", true, display({ mode: "offscreen-region" }), null, "mac", "offscreen-region", true, null],
    ["Mac with no display yet", "darwin", true, null, null, "mac", null, true, /ade screen start/],
    ["an unsupported host", "linux", false, null, null, "mac", null, true, null],
    ["Windows private screen", "win32", true, display({ seatMode: "private" }), host({}), "windows-private", "private", false, null],
    ["Windows main desktop", "win32", true, display({ seatMode: "shared" }), host({}), "windows-shared", "shared", true, null],
    ["an older runtime's off-screen display", "win32", true, display({ mode: "offscreen-region" }), host({}), "windows-shared", "shared", true, null],
    ["an older runtime's shared host", "win32", true, display({}), host({ seatMode: "shared" }), "windows-shared", "shared", true, null],
    ["Windows, private screen held", "win32", true, null, host({ state: "held", privateAvailable: false, privateUnavailableReason: "held", heldByLaneId: "lane-9", heldByLaneName: "Login" }), "windows-private", null, false, /Login \(lane-9\)[\s\S]*ade screen start --shared/],
    ["Windows, locked", "win32", true, null, host({ state: "locked", locked: true, privateAvailable: false, privateUnavailableReason: "locked" }), "windows-private", null, false, /unlock/],
    ["Windows, not set up", "win32", true, null, host({ state: "setup_required", childSessionsEnabled: false, privateAvailable: false, privateUnavailableReason: "setup_required" }), "windows-private", null, false, /ade screen setup/],
    ["Windows, ADE not on the console", "win32", true, null, host({ state: "not_console_session", privateAvailable: false, privateUnavailableReason: "not_console_session" }), "windows-private", null, false, /ade screen start --shared/],
    ["Windows, ready without a saved password", "win32", true, null, host({ passwordSaved: false }), "windows-private", null, false, /ade screen start --text[\s\S]*password/],
    ["Windows, ready", "win32", true, null, host({}), "windows-private", null, false, /^ade screen start --text$/],
  ])("%s", (_case, platform, supported, shownDisplay, windowsDesktop, kind, seat, lease, nextStep) => {
    expect(desktopSeatKind({ platform, display: shownDisplay, windowsDesktop })).toBe(kind);
    const summary = describeDesktopSeat({ platform, supported, display: shownDisplay, windowsDesktop });
    expect(summary.product).toBe(platform === "win32" ? "Windows Desktop" : "Mac Desktop");
    expect(summary.seat).toBe(seat);
    // A seat says whether real input needs a lease; no seat, no sentence.
    if (seat) expect(summary.realInputNeedsLease).toBe(lease);
    expect(Boolean(summary.realInputSentence)).toBe(Boolean(seat));
    if (nextStep) expect(summary.nextStep).toMatch(nextStep);
    else expect(summary.nextStep).toBeNull();
  });
});

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

describe("macDesktopService usage analytics", () => {
  it("emits one coarse fact per outcome and no id", async () => {
    const clip = writeCapture("clip.mp4", 128);
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ filePath: clip, durationMs: 1_000 }),
    });
    const broker = createFakeBroker();
    const captures: Array<{ action: "mac_desktop"; outcome: "started" | "agent_drove" | "recorded" }> = [];
    const { service } = makeService({
      driver,
      ingestArtifacts: broker.ingest,
      captureAnalytics: (properties) => captures.push(properties),
    });

    await service.start({ laneId: "lane-1", laneName: "Login fix" });
    await service.start({ laneId: "lane-1" });
    await service.click({ laneId: "lane-1", text: "OK", chatSessionId: "chat-1" });
    await service.click({ laneId: "lane-1", text: "OK", controllerId: "ade-window:user" });
    await service.startRecording({ laneId: "lane-1", caption: "the fix", chatSessionId: "chat-1" });
    await service.stopRecording({ laneId: "lane-1" });

    expect(captures).toEqual([
      { action: "mac_desktop", outcome: "started" },
      { action: "mac_desktop", outcome: "agent_drove" },
      { action: "mac_desktop", outcome: "recorded" },
    ]);
    const serialized = JSON.stringify(captures);
    expect(serialized).not.toContain("lane-1");
    expect(serialized).not.toContain("chat-1");
    expect(serialized).not.toContain("Login");
    expect(serialized).not.toContain("clip");
    expect(serialized).not.toContain("ade-window");
    service.dispose();

    // A Windows lane screen reports through the same closed taxonomy, and its
    // setup, saved password and main-desktop consent are never product events.
    const ready = { state: "ready", locked: false, childSessionsEnabled: true, remoteDesktopAllowed: true, passwordSaved: true, consoleSessionId: 1, sessionId: 1, inConsoleSession: true, holderLaneId: null, edition: "Professional" };
    const windowsCaptures: typeof captures = [];
    const windows = makeService({
      platform: "win32",
      seat: { ...createWindowsDesktopSeatAdapter({ logger, adeHome: "C:\\ADE" }), createDriverClient: null },
      driver: createFakeDriver({
        [MAC_DESKTOP_DRIVER_OPS.windowsStatus]: () => ready,
        [MAC_DESKTOP_DRIVER_OPS.health]: () => ({ version: "1.0.0", windowsDesktop: ready }),
        [MAC_DESKTOP_DRIVER_OPS.setupWindows]: () => ({ status: ready }),
      }),
      captureAnalytics: (properties) => windowsCaptures.push(properties),
    });
    await windows.service.setupWindowsDesktop({ allowPrompt: true, savePassword: true });
    await windows.service.start({ laneId: "lane-w", laneName: "Tray fix" });
    await windows.service.click({ laneId: "lane-w", x: 5, y: 5, mode: "real", chatSessionId: "chat-w" });
    expect(windowsCaptures).toEqual([
      { action: "mac_desktop", outcome: "started" },
      { action: "mac_desktop", outcome: "agent_drove" },
    ]);
    windows.service.dispose();
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

  it("a stop during a start waits for it, so the lane ends stopped", async () => {
    let finishCreate: () => void = () => {};
    const created = new Promise<void>((resolve) => {
      finishCreate = resolve;
    });
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver });
    driver.overrides[MAC_DESKTOP_DRIVER_OPS.createDisplay] = async (payload) => {
      await created;
      return { displayId: 7, name: payload.name, mode: "virtual", width: payload.width, height: payload.height, scale: 2 };
    };
    const starting = service.start({ laneId: "lane-1" });
    await vi.waitFor(() => {
      expect(driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.createDisplay)).toBe(true);
    });
    const stopping = service.stop({ laneId: "lane-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The stop has not reached the driver while the create is still open.
    expect(driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.destroyDisplay)).toBe(false);
    finishCreate();
    await starting;
    await expect(stopping).resolves.toMatchObject({ stopped: true });
    expect(service.hasDisplaySync("lane-1")).toBe(false);
    expect(events.map((event) => event.type).filter((type) => type.startsWith("display-")))
      .toEqual(["display-created", "display-destroyed"]);

    // A start queued behind a stop does not join the start before it: it
    // makes a new display once the stop is done.
    const again = service.start({ laneId: "lane-1" });
    const stopAgain = service.stop({ laneId: "lane-1" });
    const third = service.start({ laneId: "lane-1" });
    await again;
    await stopAgain;
    await third;
    expect(service.hasDisplaySync("lane-1")).toBe(true);
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.createDisplay)).toHaveLength(3);
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

  it("names the element a text click resolved from the tree the driver searched, not the one after the click", async () => {
    // 2026-09-23: a click on "New Document" closed TextEdit's Open panel. The
    // index was looked up in the observation taken AFTER the click, where it
    // no longer existed, so the agent read "no element; acted on a point".
    let observes = 0;
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.observe]: () => {
        observes += 1;
        return observes === 1
          ? {
              id: "before",
              elements: [
                { index: 3, handle: "obs-before:e:3", role: "AXButton", title: "New Document", pid: 42 },
              ],
            }
          : {
              id: "after",
              elements: [{ index: 3, handle: "obs-after:e:3", role: "AXTextArea", pid: 42 }],
            };
      },
      [MAC_DESKTOP_DRIVER_OPS.input]: () => ({ ok: true, resolvedIndex: 3 }),
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.observe({ laneId: "lane-1" });

    const result = await service.click({ laneId: "lane-1", text: "New Document", chatSessionId: "chat-1" });

    expect(result.resolved).toMatchObject({ handle: "obs-before:e:3", title: "New Document" });
    expect(result.observation?.id).toContain("after");
    // The same pair of trees answers whether the click changed anything.
    expect(result.ok && "effect" in result ? result.effect : null)
      .toEqual({
        status: "observed",
        reason: '1 element appeared (AXTextArea); 1 element went away (AXButton "New Document")',
      });
    service.dispose();
  });

  it("answers unconfirmed when the tree after an action matches the one it resolved against", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.observe]: () => ({
        id: `o-${Math.random()}`,
        elements: [{ index: 1, handle: "obs-o:e:1", role: "AXButton", title: "Save", pid: 42 }],
      }),
      [MAC_DESKTOP_DRIVER_OPS.input]: () => ({ ok: true, resolvedIndex: 1 }),
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });

    // No earlier observation: nothing to compare with, and it says so.
    const first = await service.click({ laneId: "lane-1", text: "Save", chatSessionId: "chat-1" });
    expect("effect" in first ? first.effect.status : null).toBe("not_checked");

    const second = await service.click({ laneId: "lane-1", text: "Save", chatSessionId: "chat-1" });
    const effect = "effect" in second ? second.effect : null;
    expect(effect?.status).toBe("unconfirmed");
    expect(effect?.reason).toBe("nothing on screen changed");
    // The unconfirmed effect now carries the one next method to try, so the
    // agent does not repeat the accessibility action that just did nothing.
    expect(effect?.next?.method).toBe("observe");
    expect(effect?.next?.command).toBeNull();
    service.dispose();
  });

  it("appends the next step to a refused accessibility click's error", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.input]: () => {
        const error = new Error('AXStaticText "Read more" answered no press action.') as Error & { code: string };
        error.code = "invalid_argument";
        throw error;
      },
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });

    // No lease: the refusal names the lease as the fix and prints its command,
    // instead of leaving the agent to repeat the same accessibility click.
    const failure = (await service
      .click({ laneId: "lane-1", text: "Read more", chatSessionId: "chat-1" })
      .catch((error: Error) => error)) as Error;
    expect(failure.message).toContain("answered no press action.");
    expect(failure.message).toContain("Next: the element has no press action");
    expect(failure.message).toContain("mac-desktop lease");
    service.dispose();
  });

  it("presses Return after the words on submit, to the element that took them, and observes once", async () => {
    // 2026-09-23: an Apple agent typed a search and had no way to press
    // Return, so it tapped the screen and then used a search URL.
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.observe]: () => ({
        id: "o1",
        elements: [
          { index: 1, handle: "obs-o1:e:1", role: "AXButton", focused: false, pid: 42 },
          { index: 2, handle: "obs-o1:e:2", role: "AXTextField", focused: true, pid: 42 },
        ],
      }),
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.observe({ laneId: "lane-1" });
    const observesBefore = driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.observe).length;

    const result = await service.type({ laneId: "lane-1", text: "reddit", submit: true, chatSessionId: "chat-1" });
    const inputs = driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input);
    expect(inputs.map((call) => call.payload.command)).toEqual(["type", "press"]);
    const commandPayload = (call: (typeof inputs)[number]) =>
      (call.payload.payload ?? call.payload) as Record<string, unknown>;
    expect(commandPayload(inputs[0]!)).toMatchObject({ typeText: "reddit" });
    // No target named: the driver typed into the focused element, so Return goes there.
    expect(commandPayload(inputs[1]!)).toMatchObject({ key: "return", modifiers: [], handle: "obs-o1:e:2" });
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.observe).length).toBe(observesBefore + 1);
    expect(result).toMatchObject({ ok: true, action: "type" });
    expect(result.observation).not.toBeNull();

    driver.calls.length = 0;
    await service.type({ laneId: "lane-1", text: "hi", target: { text: "Search" }, submit: true, chatSessionId: "chat-1" });
    const targeted = driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input);
    expect(commandPayload(targeted[1]!)).toMatchObject({ key: "return", text: "Search" });

    driver.calls.length = 0;
    await service.type({ laneId: "lane-1", text: "plain", chatSessionId: "chat-1" });
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.input)).toHaveLength(1);
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
    expect(lapse).toMatchObject({ laneId: "lane-1", turnId: "turn-1", durationMs: 1_200 });
    expect(lapse?.filePath).toMatch(/mac-desktop-turn-turn-1-[a-f0-9-]+\.mp4$/);
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

  it("files a raw recording with its real length and says why it is no demo, and never files an unusable one", async () => {
    let clock = Date.parse("2026-10-01T00:00:00.000Z");
    const raws: Buffer[] = [movie({ frames: 30 }), Buffer.from("not a movie")];
    const driver = createFakeDriver({
      // A driver that reports no lengths at all.
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ rawBytes: raws.shift() }),
    });
    const broker = createFakeBroker();
    const { service } = makeService({ driver, demoEngines: [], ingestArtifacts: broker.ingest, now: () => clock });
    await service.start({ laneId: "lane-1" });

    await service.startRecording({ laneId: "lane-1", caption: "the fix", chatSessionId: "chat-1" });
    clock += 4_000;
    const filed = await service.stopRecording({ laneId: "lane-1", chatSessionId: "chat-1" });
    // The driver sent no lengths and no engine read the movie, so its length
    // is read from the movie's own index (30 frames of 100 ms), not zero.
    expect(filed).toMatchObject({ running: false, lastError: null, durationMs: 3_000, wallDurationMs: 3_000 });
    expect(filed.demoNote).toEqual(expect.stringMatching(/\S/));
    expect(filed.proofArtifactId).toBeTruthy();
    expect(broker.requests).toHaveLength(1);

    await service.startRecording({ laneId: "lane-1", caption: "the fix again", chatSessionId: "chat-1" });
    clock += 2_000;
    const unusable = await service.stopRecording({ laneId: "lane-1", chatSessionId: "chat-1" });
    // Nothing to show, so nothing filed; the time it ran is the wall clock.
    expect(unusable).toMatchObject({ running: false, filePath: null, proofArtifactId: null, durationMs: 0, wallDurationMs: 2_000 });
    expect(unusable.lastError).toMatch(/not filed/);
    expect(broker.requests).toHaveLength(1);
    service.dispose();
  });

  it.each([
    // The driver names the clip exactly as ADE did.
    ["darwin", "as ADE spelled it", (filePath: string) => filePath],
    // Both seats' file systems fold case, and Windows takes either separator:
    // a clip the driver names another way is still the clip being published.
    ["darwin", "in another case", (filePath: string) => filePath.toUpperCase()],
    ["win32", "as ADE spelled it", (filePath: string) => filePath],
    ["win32", "in another case and separator", (filePath: string) => filePath.toUpperCase().replace(/\//g, "\\")],
  ] as const)("prunes a chat's superseded turn clip, but never one a proof points at or another chat's current one (%s, driver path %s)", async (platform, _spelling, driverSpelling) => {
    const referenced = new Set<string>();
    const isArtifactFileReferenced = (filePath: string) => referenced.has(path.resolve(filePath));
    const driver = createFakeDriver(platform === "win32" ? {
      [MAC_DESKTOP_DRIVER_OPS.windowsStatus]: () => ({ state: "ready", locked: false, childSessionsEnabled: true, remoteDesktopAllowed: true, passwordSaved: true, consoleSessionId: 1, sessionId: 1, inConsoleSession: true, holderLaneId: null, childSessionId: null, edition: "Professional" }),
    } : {});
    // Only the newest clip is reported in the driver's own spelling: it is the
    // one that must survive its own publication. (An older one is deleted by
    // the name the driver gave, which a case-sensitive test host cannot do.)
    let spellLikeDriver = false;
    const answer = driver.request.bind(driver);
    driver.request = async (op, payload, options) => {
      const reply = await answer(op, payload, options);
      if (!spellLikeDriver || op !== MAC_DESKTOP_DRIVER_OPS.stopRecording) return reply;
      const values = reply as Record<string, unknown>;
      return typeof values.filePath === "string" ? { ...values, filePath: driverSpelling(values.filePath) } : reply;
    };
    const { service } = platform === "win32"
      ? makeService({
        platform,
        seat: { ...createWindowsDesktopSeatAdapter({ logger, adeHome: "C:\\ADE" }), createDriverClient: null },
        driver,
        hostIsLocal: () => true,
        isArtifactFileReferenced,
      })
      : makeService({ driver, isArtifactFileReferenced });
    await service.start({ laneId: "lane-1" });
    let turn = 0;
    /** The clip's file as ADE asked the driver to write it. */
    const clip = async (chatSessionId: string): Promise<string> => {
      turn += 1;
      await service.beginTurn({ laneId: "lane-1", chatSessionId, turnId: `turn-${turn}` });
      const lapse = await service.noteTurnEnded({ laneId: "lane-1", chatSessionId, turnId: `turn-${turn}` });
      expect(lapse?.filePath, "setup: the turn produced a clip").toBeTruthy();
      const started = driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.startRecording).at(-1);
      return String(started!.payload.filePath);
    };

    const filedAsProof = await clip("chat-1");
    referenced.add(path.resolve(filedAsProof));
    const otherChats = await clip("chat-2");
    const superseded = await clip("chat-1");
    spellLikeDriver = true;
    const current = await clip("chat-1");

    expect(fs.existsSync(filedAsProof)).toBe(true);
    expect(fs.existsSync(otherChats)).toBe(true);
    expect(fs.existsSync(current)).toBe(true);
    // Only the newest clip per chat is shown, so the one before it goes.
    expect(fs.existsSync(superseded)).toBe(false);
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
    expect(stopped).toMatchObject({ running: false, durationMs: 1_200, lastError: null });
    expect(stopped.filePath).toMatch(/mac-desktop-recording-lane-1-[a-f0-9-]+\.mp4$/);

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
    expect(macDesktopPaneCaption("recording", "docs-fix", "Mac Desktop")).toBe("Mac Desktop recording · docs-fix");
    expect(macDesktopPaneCaption("screenshot", "  ", "Mac Desktop")).toBe("Mac Desktop screenshot");
    expect(macDesktopPaneCaption("recording", null, "Mac Desktop")).toBe("Mac Desktop recording");
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
      caption: macDesktopPaneCaption("recording", "docs-fix", "Mac Desktop"),
      chatSessionId: "chat-1",
    });

    const stopped = await service.stopRecording({ laneId: "lane-1", chatSessionId: "chat-1" });

    expect(stopped).toMatchObject({
      running: false,
      durationMs: 1_250,
      wallDurationMs: 12_000,
      proofArtifactId: "artifact-1-0",
      bytes: 5,
    });
    expect(stopped.filePath).not.toBe(clip);
    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0]!.inputs[0]).toMatchObject({
      kind: "video_recording",
      title: "Mac Desktop recording · docs-fix",
      path: stopped.filePath,
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
      caption: macDesktopPaneCaption("screenshot", "docs-fix", "Mac Desktop"),
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

describe("macDesktopService proof provenance and recording rules", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The next time a lane's recording is published as stopped.
   *
   * A cap stop is a timer, but what it runs is not: it files the proof and
   * reads the finished file's size from disk before it publishes. Advancing
   * fake timers fires the timer and nothing more, so an assertion made right
   * after the advance raced real disk I/O, and lost it under load. Awaiting
   * the published stop is the one moment the stop is actually done.
   */
  const nextRecordingStop = (
    service: ReturnType<typeof makeService>["service"],
  ): Promise<MacDesktopRecordingStatus> => new Promise((resolve) => {
    const unsubscribe = service.subscribe((event) => {
      if (event.type !== "recording-changed" || event.status.running || event.status.makingDemo) return;
      unsubscribe();
      resolve(event.status);
    });
  });

  const chatOwners = (request: ComputerUseArtifactIngestionRequest): string[] =>
    (request.owners ?? []).filter((owner) => owner.kind === "chat_session").map((owner) => owner.id);

  it("files ADE's own screenshot as an ADE capture, so a repeat of a still screen is not a duplicate", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.screenshot]: (payload) => {
        fs.writeFileSync(String(payload.path), Buffer.alloc(64));
        return { filePath: payload.path, width: 100, height: 100 };
      },
    });
    const broker = createFakeBroker();
    const { service } = makeService({ driver, ingestArtifacts: broker.ingest });
    await service.start({ laneId: "lane-1" });
    await service.screenshot({ laneId: "lane-1", chatSessionId: "chat-1", caption: "the screen" });
    expect(broker.requests[0]!.provenance).toEqual({ source: "ade-capture" });
    service.dispose();
  });

  it("files a recording from ADE's recorder with its wall-clock times, under the chat that started it", async () => {
    let clock = Date.parse("2026-09-23T10:00:00.000Z");
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ filePath: "/tmp/clip.mp4", durationMs: 8_000 }),
    });
    const broker = createFakeBroker();
    const { service } = makeService({ driver, ingestArtifacts: broker.ingest, now: () => clock });
    await service.start({ laneId: "lane-1" });
    const started = await service.startRecording({ laneId: "lane-1", caption: "the fix", chatSessionId: "chat-1" });
    expect(started.chatSessionId).toBe("chat-1");

    clock += 8_000;
    // Another chat stops it. The proof is still the first chat's.
    await service.stopRecording({ laneId: "lane-1", chatSessionId: "chat-2" });

    expect(broker.requests[0]!.provenance).toEqual({
      source: "ade-recorder",
      recordedFrom: "2026-09-23T10:00:00.000Z",
      recordedTo: "2026-09-23T10:00:08.000Z",
    });
    expect(chatOwners(broker.requests[0]!)).toEqual(["chat-1"]);
    service.dispose();
  });

  it("files a recording no chat started under the chat that stopped it", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ filePath: "/tmp/clip.mp4", durationMs: 1_000 }),
    });
    const broker = createFakeBroker();
    const { service } = makeService({ driver, ingestArtifacts: broker.ingest });
    await service.start({ laneId: "lane-1" });
    await service.startRecording({ laneId: "lane-1", caption: "the fix" });
    await service.stopRecording({ laneId: "lane-1", chatSessionId: "chat-2" });
    expect(chatOwners(broker.requests[0]!)).toEqual(["chat-2"]);
    service.dispose();
  });

  it("stops a chat's recording at five minutes, files it, and says why", async () => {
    vi.useFakeTimers();
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ filePath: "/tmp/clip.mp4", durationMs: 300_000 }),
    });
    const broker = createFakeBroker();
    const { service, events } = makeService({ driver, ingestArtifacts: broker.ingest });
    await service.start({ laneId: "lane-1" });
    const started = await service.startRecording({ laneId: "lane-1", caption: "the flow", chatSessionId: "chat-1" });
    expect(started.maxDurationMs).toBe(300_000);

    const chatCapStop = nextRecordingStop(service);
    for (let i = 0; i < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(110_000);
      await service.click({ laneId: "lane-1", text: "Continue", chatSessionId: "chat-1" });
    }
    await vi.advanceTimersByTimeAsync(79_000);
    expect(driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.stopRecording)).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await chatCapStop;
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.stopRecording)).toHaveLength(1);
    const stopped = events.filter((event) =>
      event.type === "recording-changed" && event.status.running === false);
    expect(stopped.at(-1)).toMatchObject({ status: { stopReason: "cap", proofArtifactId: "artifact-1-0" } });
    expect(broker.requests[0]!.inputs[0]!.description).toContain("Stopped at its 5:00 limit.");
    expect(chatOwners(broker.requests[0]!)).toEqual(["chat-1"]);
    // A stop after the cap is a clean "not running", not a second file. The
    // recorder publishes "stopped" a moment before it lets go of its own stop,
    // and a stop asked in that moment is handed that same stop back; the first
    // call waits it out whichever side of the moment it lands on.
    await service.stopRecording({ laneId: "lane-1" }).catch(() => null);
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.stopRecording)).toHaveLength(1);
    await expect(service.stopRecording({ laneId: "lane-1" })).rejects.toThrow(/is not recording its desktop/);
    service.dispose();
  });

  it("files a chat's uncaptioned recording itself when the cap stops it, as the Apple device does", async () => {
    vi.useFakeTimers();
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ filePath: "/tmp/clip.mp4", durationMs: 300_000 }),
    });
    const broker = createFakeBroker();
    const { service, events } = makeService({ driver, ingestArtifacts: broker.ingest });
    await service.start({ laneId: "lane-1" });
    await service.startRecording({ laneId: "lane-1", chatSessionId: "chat-1" });
    const capStop = nextRecordingStop(service);
    for (let i = 0; i < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(110_000);
      await service.click({ laneId: "lane-1", text: "Continue", chatSessionId: "chat-1" });
    }
    await vi.advanceTimersByTimeAsync(80_000);
    await capStop;

    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0]!.inputs[0]).toMatchObject({
      kind: "video_recording",
      metadata: { stopReason: "cap", wallDurationMs: 300_000 },
    });
    expect(broker.requests[0]!.inputs[0]!.description).toContain("Stopped at its 5:00 limit.");
    expect(broker.requests[0]!.provenance).toMatchObject({ source: "ade-recorder" });
    expect(chatOwners(broker.requests[0]!)).toEqual(["chat-1"]);
    const stopped = events.filter((event) =>
      event.type === "recording-changed" && event.status.running === false);
    expect(stopped.at(-1)).toMatchObject({ status: { proofArtifactId: "artifact-1-0", stopReason: "cap" } });

    // A normal stop keeps the caption rule: no caption, no proof.
    await service.startRecording({ laneId: "lane-1", chatSessionId: "chat-1" });
    await service.stopRecording({ laneId: "lane-1" });
    expect(broker.requests).toHaveLength(1);
    service.dispose();
  });

  it("caps a recording with no chat owner and honours --max-seconds", async () => {
    vi.useFakeTimers();
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ filePath: "/tmp/clip.mp4", durationMs: 30_000 }),
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    const unowned = await service.startRecording({ laneId: "lane-1", caption: "mine" });
    expect(unowned.maxDurationMs).toBe(300_000);
    const capStop = nextRecordingStop(service);
    for (let i = 0; i < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(110_000);
      await service.click({ laneId: "lane-1", text: "Continue", controllerId: "ade-window:user" });
    }
    const defaultCapStop = capStop;
    await vi.advanceTimersByTimeAsync(80_000);
    await defaultCapStop;
    expect((await service.getStatus({ laneId: "lane-1" })).recording?.running).toBe(false);

    const capped = await service.startRecording({ laneId: "lane-1", caption: "short", maxSeconds: 30 });
    expect(capped.maxDurationMs).toBe(30_000);
    const shortCapStop = nextRecordingStop(service);
    await vi.advanceTimersByTimeAsync(30_000);
    await shortCapStop;
    expect((await service.getStatus({ laneId: "lane-1" })).recording).toMatchObject({
      running: false,
      stopReason: "cap",
    });
    service.dispose();
  });

  it("keeps the helper capture raw for either demo mode", async () => {
    const driver = createFakeDriver();
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.startRecording({ laneId: "lane-1" });
    await service.stopRecording({ laneId: "lane-1" });
    await service.startRecording({ laneId: "lane-1", keepIdle: true });
    const starts = driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.startRecording);
    expect((await service.getStatus({ laneId: "lane-1" })).recording?.plain).toBe(true);
    expect(starts.every((start) => start.payload.keepIdle === true)).toBe(true);
    service.dispose();
  });

  it("uses the analysis duration for the demo while keeping the raw wall span", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({
        filePath: "/tmp/clip.mp4",
        durationMs: 70_000,
        wallDurationMs: 182_000,
        idleCutMs: 112_000,
      }),
    });
    const broker = createFakeBroker();
    const { service } = makeService({ driver, ingestArtifacts: broker.ingest });
    await service.start({ laneId: "lane-1" });
    await service.startRecording({ laneId: "lane-1", caption: "the flow", chatSessionId: "chat-1" });
    const stopped = await service.stopRecording({ laneId: "lane-1" });

    expect(stopped).toMatchObject({ wallDurationMs: 182_000 });
    expect(stopped.durationMs).toBeLessThan(stopped.wallDurationMs!);
    const input = broker.requests[0]!.inputs[0]!;
    expect(input.metadata).toMatchObject({ demo: { sourceSeconds: 182 } });
    expect(readProofProvenance(input.metadata).idleCutMs).toBeGreaterThan(0);
    service.dispose();
  });

  it("reads an older driver's stop as nothing cut", async () => {
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.stopRecording]: () => ({ filePath: "/tmp/clip.mp4", durationMs: 9_000 }),
    });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.startRecording({ laneId: "lane-1" });
    const stopped = await service.stopRecording({ laneId: "lane-1" });
    expect(stopped.wallDurationMs).toBe(9_000);
    expect(stopped.durationMs).toBeLessThan(stopped.wallDurationMs!);
    expect(stopped.idleCutMs).toBeGreaterThan(0);
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

  it("regression: two starts in flight for one lane share one encoder and one token", async () => {
    // Coming back to a chat mounted two viewers of the lane a beat apart, and
    // both asked while the first start was still waiting on the driver. Each
    // saw no running stream and started one, so the driver built two encoders
    // on two ports and the viewer holding the first address read a dead one.
    const releases: Array<() => void> = [];
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.startStream]: async () => {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return { port: 65_000, codec: "avc1.640032", width: 2560, height: 1440 };
      },
    });
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    const first = service.startStream({ laneId: "lane-1", chatSessionId: "chat-a" });
    const second = service.startStream({ laneId: "lane-1", chatSessionId: "chat-b" });
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
    // Let both callers reach the driver if they are going to.
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const release of releases) release();
    const [a, b] = await Promise.all([first, second]);
    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.startStream)).toHaveLength(1);
    expect(b.transport?.token).toBe(a.transport?.token);
    expect(events.filter((event) => event.type === "stream-started")).toHaveLength(1);
    // The second chat still joined the viewer list.
    expect((await service.getStreamStatus({ laneId: "lane-1" })).viewerChatSessionIds.sort())
      .toEqual(["chat-a", "chat-b"]);
    service.dispose();
  });

  it("regression: Reconnect on a stream that delivers nothing starts a new one", async () => {
    // Reconnect asked `startStream` again and was handed the same dead run
    // every time, so it never recovered. A `fresh` ask on a stream that has
    // carried no bytes for a while stops it and opens a new one.
    let clock = 1_000_000;
    let port = 65_000;
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.startStream]: () => ({ port: port++, codec: "avc1.640032", width: 2560, height: 1440 }),
    });
    const { service } = makeService({ driver, now: () => clock });
    await service.start({ laneId: "lane-1" });
    const first = await service.startStream({ laneId: "lane-1", chatSessionId: "chat-a" });
    const starts = () => driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.startStream).length;

    // Just started: a fresh ask is still a read, not a restart.
    clock += 500;
    const early = await service.startStream({ laneId: "lane-1", chatSessionId: "chat-a", fresh: true });
    expect(early.transport?.token).toBe(first.transport?.token);
    expect(starts()).toBe(1);

    // Nothing arrived for longer than a still desktop's keep-alive allows.
    clock += MAC_DESKTOP_STREAM_STALE_MS;
    const restarted = await service.startStream({ laneId: "lane-1", chatSessionId: "chat-a", fresh: true });
    expect(starts()).toBe(2);
    expect(driver.calls.some((call) => call.op === MAC_DESKTOP_DRIVER_OPS.stopStream)).toBe(true);
    expect(restarted.transport?.token).toBeTruthy();
    expect(restarted.transport?.token).not.toBe(first.transport?.token);
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

  it("regression: the desktop's last viewer leaving does not cut off a phone reading the same capture", async () => {
    // The desktop's stop used to clear every chat and every sync subscription,
    // so closing the pane ended the stream the phone was watching.
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.startStream]: () => ({ port: 65_000, codec: "avc1.640032", width: 2560, height: 1440 }),
    });
    const { service } = makeService({ driver });
    const streamStops = () => driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.stopStream).length;
    await service.start({ laneId: "lane-1" });
    await service.startStream({ laneId: "lane-1", chatSessionId: "chat-a" });
    await service.startStreamForSubscription({ laneId: "lane-1", subscriptionId: "sub-1" });

    const kept = await service.stopStream({ laneId: "lane-1", chatSessionId: "chat-a", localViewer: true });
    expect(kept.running).toBe(true);
    expect(kept.viewerChatSessionIds).toEqual([]);
    expect(streamStops()).toBe(0);

    // The phone leaving is what stops it now.
    await service.releaseStreamSubscription("sub-1");
    expect((await service.getStreamStatus({ laneId: "lane-1" })).running).toBe(false);
    expect(streamStops()).toBe(1);

    // With nobody else watching, the viewer's stop stops.
    await service.startStream({ laneId: "lane-1", chatSessionId: "chat-a" });
    await service.stopStream({ laneId: "lane-1", chatSessionId: "chat-a", localViewer: true });
    expect((await service.getStreamStatus({ laneId: "lane-1" })).running).toBe(false);
    expect(streamStops()).toBe(2);
    service.dispose();
  });

  it("a viewer's stop drops only its own chat and republishes the viewer list", async () => {
    // The floating card authorizes a chat by this list, so a chat whose viewer
    // left must come off it while the other chat keeps watching.
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.startStream]: () => ({ port: 65_000, codec: "avc1.640032", width: 2560, height: 1440 }),
    });
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.startStream({ laneId: "lane-1", chatSessionId: "chat-a" });
    await service.startStream({ laneId: "lane-1", chatSessionId: "chat-b" });
    const published = () => events
      .filter((event): event is Extract<MacDesktopEventPayload, { type: "stream-status" }> => event.type === "stream-status")
      .map((event) => [...event.status.viewerChatSessionIds].sort());
    // A chat joining a running capture is news for the list too.
    expect(published().at(-1)).toEqual(["chat-a", "chat-b"]);

    await service.stopStream({ laneId: "lane-1", chatSessionId: "chat-a", localViewer: true });
    const status = await service.getStreamStatus({ laneId: "lane-1" });
    expect(status.running).toBe(true);
    expect(status.viewerChatSessionIds).toEqual(["chat-b"]);
    expect(published().at(-1)).toEqual(["chat-b"]);

    // An explicit stop, an agent's `stream-stop`, still ends it for everyone.
    await service.startStreamForSubscription({ laneId: "lane-1", subscriptionId: "sub-1" });
    await service.stopStream({ laneId: "lane-1" });
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

    // A retirement while a lane has a screen is a lost driver like any other.
    await service.start({ laneId: "lane-3" });
    driverLost[0]!("retired");
    expect(events.filter((event) => event.type === "display-destroyed").at(-1)).toMatchObject({ laneId: "lane-3", reason: "driver_lost" });
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

  it("stop names the apps the lane opened that quit, and the ones that stayed to save", async () => {
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    const message = "TextEdit did not quit, even when forced. It moved to your screen.";
    driver.overrides[MAC_DESKTOP_DRIVER_OPS.destroyDisplay] = () => ({
      destroyed: true,
      releasedWindows: 1,
      quitApps: ["Safari", 7],
      appsLeftOpen: [{ pid: 88, appName: "TextEdit", message }, { pid: 3 }],
    });
    const result = await service.stop({ laneId: "lane-1" });
    // Malformed rows are dropped rather than shown as blank names.
    expect(result).toEqual({
      stopped: true,
      releasedWindows: 1,
      quitApps: ["Safari"],
      appsLeftOpen: [{ pid: 88, appName: "TextEdit", message }],
    });
    // Every surface hears it, not only the caller of `stop`: idle release has no caller.
    expect(events.filter((event) => event.type === "display-destroyed")).toEqual([
      { type: "display-destroyed", laneId: "lane-1", reason: "stopped", appsLeftOpen: [{ pid: 88, appName: "TextEdit", message }] },
    ]);
    service.dispose();
  });

  it("stop against an older driver answers with empty app lists", async () => {
    const { service } = makeService();
    await service.start({ laneId: "lane-1" });
    await expect(service.stop({ laneId: "lane-1" })).resolves.toEqual({
      stopped: true,
      releasedWindows: 0,
      quitApps: [],
      appsLeftOpen: [],
    });
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

describe("macDesktopService stale display state", () => {
  const window = (laneId: string) => ({
    id: 501,
    pid: 77,
    appName: "TextEdit",
    bundleId: "com.apple.TextEdit",
    title: "Untitled",
    frame: { x: 8000, y: 0, width: 800, height: 600 },
    laneId,
    origin: "ade_launched",
    onDisplayId: 7,
    minimized: false,
    singleInstance: false,
  });

  const healthWith = (displays: string[]) => () => ({
    version: "1.0.0",
    permissions: { screenRecording: "granted", accessibility: "granted" },
    displayMode: "virtual",
    displays,
  });

  it("a lost driver releases the lane's windows, lease and recording before the display, so every surface goes Off", async () => {
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
    driver.overrides[MAC_DESKTOP_DRIVER_OPS.listWindows] = () => ({ windows: [window("lane-1")] });
    for (const listener of driver.listeners) {
      listener({ event: "windows-changed", laneId: "lane-1", windows: [window("lane-1")] });
    }
    await service.takeControl({ laneId: "lane-1", controllerId: "ade-window:1" });
    await service.startRecording({ laneId: "lane-1" });
    expect((await service.getStatus({ laneId: "lane-1" })).lanes[0]?.windowCount).toBe(1);
    events.length = 0;

    driverLost[0]?.("signal SIGKILL");

    // The tool tile read "Mac Desktop active · 1 window" from these, not from
    // `display-destroyed`, and kept reading it after the screen was gone.
    expect(events.map((event) => event.type)).toEqual([
      "recording-changed",
      "lease-changed",
      "windows-changed",
      "display-destroyed",
    ]);
    expect(events[0]).toMatchObject({ status: { laneId: "lane-1", running: false } });
    expect(events[1]).toEqual({ type: "lease-changed", laneId: "lane-1", lease: null });
    expect(events[2]).toEqual({ type: "windows-changed", laneId: "lane-1", windows: [] });
    expect(events[3]).toEqual({ type: "display-destroyed", laneId: "lane-1", reason: "driver_lost" });
    const status = await service.getStatus({ laneId: "lane-1" });
    expect(status.display).toBeNull();
    expect(status.lanes).toEqual([]);
    expect(status.lease).toBeNull();
    service.dispose();
  });

  it("drops a display the driver no longer reports, on the next status read", async () => {
    const driver = createFakeDriver({ [MAC_DESKTOP_DRIVER_OPS.health]: healthWith([]) });
    const { service, events } = makeService({ driver });
    driver.overrides[MAC_DESKTOP_DRIVER_OPS.health] = healthWith(["lane-1", "lane-2"]);
    await service.start({ laneId: "lane-1" });
    await service.start({ laneId: "lane-2" });
    expect((await service.getStatus({ laneId: "lane-1" })).display?.laneId).toBe("lane-1");

    // The helper was replaced behind the service's back, and only lane-2's
    // display came back with it.
    driver.overrides[MAC_DESKTOP_DRIVER_OPS.health] = healthWith(["lane-2"]);
    const status = await service.getStatus({ laneId: "lane-1" });

    expect(status.display).toBeNull();
    expect(status.lanes.map((lane) => lane.laneId)).toEqual(["lane-2"]);
    expect(events.filter((event) => event.type === "display-destroyed")).toEqual([
      { type: "display-destroyed", laneId: "lane-1", reason: "driver_lost" },
    ]);
    service.dispose();
  });

  it("never reconciles against an older driver that sends no display list", async () => {
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    await service.getStatus({ laneId: "lane-1" });
    expect((await service.getStatus({ laneId: "lane-1" })).display?.laneId).toBe("lane-1");
    expect(events.some((event) => event.type === "display-destroyed")).toBe(false);
    service.dispose();
  });

  it("start after the display was lost creates a new one instead of answering with the old", async () => {
    const driver = createFakeDriver({ [MAC_DESKTOP_DRIVER_OPS.health]: healthWith(["lane-1"]) });
    const { service } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    driver.overrides[MAC_DESKTOP_DRIVER_OPS.health] = healthWith([]);

    const status = await service.start({ laneId: "lane-1" });

    expect(driver.calls.filter((call) => call.op === MAC_DESKTOP_DRIVER_OPS.createDisplay)).toHaveLength(2);
    expect(status.display?.laneId).toBe("lane-1");
    service.dispose();
  });

  it("publishes a display the window server ended as lost, and forgets its windows", async () => {
    const driver = createFakeDriver();
    const { service, events } = makeService({ driver });
    await service.start({ laneId: "lane-1" });
    for (const listener of driver.listeners) {
      listener({ event: "windows-changed", laneId: "lane-1", windows: [window("lane-1")] });
    }
    events.length = 0;
    for (const listener of driver.listeners) {
      listener({ event: "display-destroyed", laneId: "lane-1", reason: "terminated" });
    }
    expect(events).toEqual([
      { type: "windows-changed", laneId: "lane-1", windows: [] },
      { type: "display-destroyed", laneId: "lane-1", reason: "driver_lost" },
    ]);
    expect(service.hasDisplaySync("lane-1")).toBe(false);
    service.dispose();
  });

  it("answers a status read when the driver never answers the window list", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const driver = createFakeDriver();
      const { service } = makeService({ driver });
      await service.start({ laneId: "lane-1" });
      driver.overrides[MAC_DESKTOP_DRIVER_OPS.listWindows] = () => new Promise(() => {});
      let settled = false;
      const read = service.getStatus({ laneId: "lane-1" }).then((status) => {
        settled = true;
        return status;
      });
      await vi.advanceTimersByTimeAsync(3_900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      const status = await read;
      // "Checking Mac Desktop…" waits on exactly this read.
      expect(status.display?.laneId).toBe("lane-1");
      expect(status.windows).toEqual([]);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("macDesktopService persistent log", () => {
  function recordingLogger() {
    const lines: Array<{ level: string; event: string; meta?: Record<string, unknown> }> = [];
    const at = (level: string) => (event: string, meta?: Record<string, unknown>) => {
      lines.push({ level, event, ...(meta ? { meta } : {}) });
    };
    return { lines, logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } };
  }

  it("records the display lifecycle and a truncated observation, with ids and app names only", async () => {
    const { lines, logger: recorded } = recordingLogger();
    const driver = createFakeDriver({
      [MAC_DESKTOP_DRIVER_OPS.observe]: () => ({
        id: "obs-1",
        elements: [],
        elementCount: 0,
        truncated: true,
        truncatedReason: "stalled",
        stalledApps: ["TextEdit"],
        windows: [],
      }),
    });
    const service = createMacDesktopService({
      projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-test-")),
      logger: recorded,
      platform: "darwin",
      createDriverClient: () => driver as unknown as MacDesktopDriverClient,
    });
    await service.start({ laneId: "lane-1" });
    const observation = await service.observe({ laneId: "lane-1" });
    expect(observation.truncatedReason).toBe("stalled");
    expect(observation.stalledApps).toEqual(["TextEdit"]);
    await service.stop({ laneId: "lane-1" });

    const persistent = lines.filter((line) => line.level !== "debug");
    expect(persistent.map((line) => line.event)).toEqual([
      "mac_desktop.permissions_changed",
      "mac_desktop.driver_health",
      "mac_desktop.display_created",
      "mac_desktop.observe_truncated",
      "mac_desktop.display_destroyed",
    ]);
    expect(persistent[3]).toMatchObject({
      level: "warn",
      meta: { laneId: "lane-1", reason: "stalled", stalledApps: ["TextEdit"] },
    });
    expect(persistent[4]).toMatchObject({ meta: { laneId: "lane-1", reason: "stopped" } });
    // No screenshot path, no window title.
    expect(JSON.stringify(persistent)).not.toContain(os.tmpdir());
    service.dispose();
  });
});
