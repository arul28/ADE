import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppControlStatus } from "../../../../desktop/src/shared/types";
import type {
  BuiltInBrowserRuntimeStatus,
  BuiltInBrowserRuntimeTabStatus,
} from "../../../../desktop/src/shared/types/builtInBrowserRuntimeStatus";
import type {
  MacDesktopEventPayload,
  MacDesktopStatus,
} from "../../../../desktop/src/shared/types/macDesktop";
import { DesktopBridgeUnavailableError } from "../builtInBrowser/desktopBridgeClient";
import {
  createWorkToolsStateService,
  WORK_TOOLS_PRESENCE_EVENT_WINDOW_MS,
} from "./workToolsStateService";

/** A 1x1 PNG. Enough for the preview reader to accept and encode. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function browserStatus(
  overrides: Partial<BuiltInBrowserRuntimeStatus> = {},
): BuiltInBrowserRuntimeStatus {
  return {
    activeTabId: "tab-1",
    tabs: [],
    unavailable: null,
    ...overrides,
  };
}

function tab(
  overrides: Partial<BuiltInBrowserRuntimeTabStatus> = {},
): BuiltInBrowserRuntimeTabStatus {
  return {
    id: "tab-1",
    url: "https://example.test/",
    title: "Example",
    ownerLaneId: null,
    ownerChatSessionId: null,
    recording: false,
    handoff: null,
    ...overrides,
  };
}

function appControlStatus(session: Partial<NonNullable<AppControlStatus["activeSession"]>> | null): AppControlStatus {
  return {
    platform: process.platform,
    supported: true,
    providers: [],
    activeSession: session
      ? ({
        id: "sess-1",
        appKind: "electron",
        label: "ADE Dev",
        projectRoot: null,
        laneId: null,
        cwd: null,
        command: null,
        pid: 1,
        terminalSessionId: null,
        terminalPtyId: null,
        cdpPort: 9222,
        cdpEndpoint: null,
        cdpTargetId: null,
        provider: "cdp",
        driver: "cdp",
        chatSessionId: null,
        startedAt: new Date().toISOString(),
        connectedAt: null,
        status: "connected",
        lastError: null,
        lastObservationId: null,
        lastTraceEntryId: null,
        ...session,
      } as NonNullable<AppControlStatus["activeSession"]>)
      : null,
  } as AppControlStatus;
}

describe("workToolsStateService", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-work-tools-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function writeObservation(args: {
    kind: "browser" | "app-control";
    id: string;
    capturedAt: string;
    ownerLaneId?: string | null;
    title?: string | null;
  }): string {
    const root = path.join(
      projectRoot,
      ".ade",
      "cache",
      args.kind === "browser" ? "browser-observations" : "app-control-observations",
      "collection",
    );
    fs.mkdirSync(root, { recursive: true });
    const imagePath = path.join(root, `${args.id}.png`);
    fs.writeFileSync(imagePath, PNG_BYTES);
    fs.writeFileSync(
      path.join(root, `${args.id}.json`),
      JSON.stringify({
        id: args.id,
        capturedAt: args.capturedAt,
        filePath: imagePath,
        title: args.title ?? "Example",
        url: "https://example.test/",
        ownerLaneId: args.ownerLaneId ?? null,
      }),
      "utf8",
    );
    return imagePath;
  }

  it("summarizes the desktop's tabs when a browser bridge answers", async () => {
    const service = createWorkToolsStateService({
      projectRoot,
      getBrowserStatus: async () => browserStatus({
        activeTabId: "tab-1",
        tabs: [
          tab({ id: "tab-1", ownerChatSessionId: "chat-9", recording: true }),
          // Claimed by a different lane: belongs to that lane's pane, not ours.
          tab({ id: "tab-2", ownerLaneId: "lane-other", title: "Other" }),
          tab({ id: "tab-3", ownerLaneId: "lane-1", title: "Mine" }),
        ],
      }),
    });

    const state = await service.getLaneState({ laneId: "lane-1" });

    expect(state.browserUnavailable).toBeNull();
    expect(state.browser?.tabs.map((entry) => entry.id)).toEqual(["tab-1", "tab-3"]);
    expect(state.browser?.tabs[0]).toMatchObject({
      title: "Example",
      url: "https://example.test/",
      ownerChatSessionId: "chat-9",
      recording: true,
      active: true,
    });
    service.dispose();
  });

  it("publishes the lane's agent browser presence and hides another lane's", async () => {
    const service = createWorkToolsStateService({
      projectRoot,
      getBrowserStatus: async () => browserStatus({
        presence: [
          { chatSessionId: "chat-1", laneId: "lane-1", tabId: "tab-1", since: "2026-09-09T10:00:00Z", lastActivityAt: "2026-09-09T10:00:05Z" },
          { chatSessionId: "chat-other", laneId: "lane-other", tabId: "tab-9", since: "2026-09-09T10:00:00Z", lastActivityAt: "2026-09-09T10:00:05Z" },
          // A personal chat has no lane: shared browsing, same rule as an
          // unclaimed tab.
          { chatSessionId: "chat-personal", laneId: null, tabId: null, since: "2026-09-09T10:00:00Z", lastActivityAt: "2026-09-09T10:00:05Z" },
        ],
      }),
    });

    const state = await service.getLaneState({ laneId: "lane-1" });
    expect(state.agentBrowserPresence.map((entry) => entry.chatSessionId))
      .toEqual(["chat-1", "chat-personal"]);
    expect(state.agentBrowserPresence[0]).toMatchObject({ tabId: "tab-1" });
    service.dispose();
  });

  it("reads a desktop that cannot report presence as nobody browsing", async () => {
    const service = createWorkToolsStateService({
      projectRoot,
      getBrowserStatus: async () => browserStatus({ tabs: [tab()] }),
    });

    const state = await service.getLaneState({ laneId: "lane-1" });
    expect(state.agentBrowserPresence).toEqual([]);
    service.dispose();
  });

  it("reports no presence when there is no browser to vouch for it", async () => {
    const service = createWorkToolsStateService({
      projectRoot,
      getBrowserStatus: async () => {
        throw new DesktopBridgeUnavailableError("/tmp/desktop-bridge.sock", "no desktop");
      },
    });

    const state = await service.getLaneState({ laneId: "lane-1" });
    expect(state.browser).toBeNull();
    expect(state.agentBrowserPresence).toEqual([]);
    service.dispose();
  });

  it("announces the edges of a browsing stretch and nothing in between", () => {
    vi.useFakeTimers();
    const onStateChanged = vi.fn();
    const service = createWorkToolsStateService({ projectRoot, onStateChanged, debounceMs: 10 });

    service.noteAgentBrowserActivity({ laneId: "lane-1", chatSessionId: "chat-1" });
    vi.advanceTimersByTime(10);
    expect(onStateChanged).toHaveBeenCalledTimes(1);

    // A busy agent: many commands, no new news.
    for (let i = 0; i < 5; i += 1) {
      service.noteAgentBrowserActivity({ laneId: "lane-1", chatSessionId: "chat-1" });
      vi.advanceTimersByTime(1_000);
    }
    expect(onStateChanged).toHaveBeenCalledTimes(1);

    // Then it stops, and the window closes: clients are told to look again.
    vi.advanceTimersByTime(WORK_TOOLS_PRESENCE_EVENT_WINDOW_MS + 10);
    expect(onStateChanged).toHaveBeenCalledTimes(2);
    expect(onStateChanged).toHaveBeenLastCalledWith("lane-1");
    service.dispose();
  });

  it("retracts only the edge the failing call opened", () => {
    vi.useFakeTimers();
    const onStateChanged = vi.fn();
    const service = createWorkToolsStateService({ projectRoot, onStateChanged, debounceMs: 10 });

    const opened = service.noteAgentBrowserActivity({ laneId: "lane-1", chatSessionId: "chat-1" });
    expect(opened).toMatchObject({ started: true });
    vi.advanceTimersByTime(10);
    expect(onStateChanged).toHaveBeenCalledTimes(1);

    // A second call from the same chat re-arms the shared timer while the first
    // is still in flight. When the first then fails, its undo must not close a
    // window the second one is still standing in: the phone would drop presence
    // while the desktop's own guarded tracker stayed lit.
    const second = service.noteAgentBrowserActivity({ laneId: "lane-1", chatSessionId: "chat-1" });
    expect(second.started).toBe(false);
    expect(second.sequence).not.toBe(opened.sequence);

    service.clearAgentBrowserActivity({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      sequence: opened.sequence,
    });
    vi.advanceTimersByTime(20);
    expect(onStateChanged).toHaveBeenCalledTimes(1);

    // A sequence that never opened anything is not a licence to clear either:
    // the guard is the only shape this call has.
    service.clearAgentBrowserActivity({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      sequence: second.sequence + 1000,
    });
    vi.advanceTimersByTime(20);
    expect(onStateChanged).toHaveBeenCalledTimes(1);

    // The live call's own retraction still lands.
    service.clearAgentBrowserActivity({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      sequence: second.sequence,
    });
    vi.advanceTimersByTime(20);
    expect(onStateChanged).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("ignores browser activity with no lane or no chat to attribute it to", () => {
    vi.useFakeTimers();
    const onStateChanged = vi.fn();
    const service = createWorkToolsStateService({ projectRoot, onStateChanged, debounceMs: 10 });

    service.noteAgentBrowserActivity({ laneId: null, chatSessionId: "chat-1" });
    service.noteAgentBrowserActivity({ laneId: "lane-1", chatSessionId: null });
    vi.advanceTimersByTime(WORK_TOOLS_PRESENCE_EVENT_WINDOW_MS + 100);
    expect(onStateChanged).not.toHaveBeenCalled();
    service.dispose();
  });

  it("reports absence, not failure, when no desktop is attached", async () => {
    const service = createWorkToolsStateService({
      projectRoot,
      getBrowserStatus: async () => {
        throw new Error("No ADE Desktop browser is attached to this machine");
      },
      getAppControlStatus: () => appControlStatus({ label: "ADE Dev", status: "connected" }),
    });

    const state = await service.getLaneState({ laneId: "lane-1" });

    expect(state.browser).toBeNull();
    expect(state.browserUnavailable).toBe("desktop_not_attached");
    // App Control runs in the daemon, so it survives a desktop that has quit.
    expect(state.appControl).toMatchObject({ appName: "ADE Dev", status: "connected", driver: "cdp" });
    service.dispose();
  });

  it("reports a desktop with no window for this project as its own state", async () => {
    // Not "desktop_not_attached": ADE Desktop IS running, so telling the user to
    // open it sends them chasing the wrong thing. And deliberately not the other
    // project's tabs, which is what an unscoped answer used to return.
    const service = createWorkToolsStateService({
      projectRoot,
      getBrowserStatus: async () => ({
        activeTabId: null,
        tabs: [],
        unavailable: "desktop_not_attached_for_project" as const,
      }),
    });
    const state = await service.getLaneState({ laneId: "lane-1" });
    expect(state.browser).toBeNull();
    expect(state.browserUnavailable).toBe("desktop_not_attached_for_project");
    service.dispose();
  });

  it("passes through an unopened Browser pane as its own reason", async () => {
    // Narrower than "not attached for this project": the project IS open on the
    // desktop, only the pane is unused. The daemon must forward the distinction
    // verbatim — it is what decides whether the phone tells someone to open a
    // project they already have open.
    const service = createWorkToolsStateService({
      projectRoot,
      getBrowserStatus: async () => ({
        activeTabId: null,
        tabs: [],
        unavailable: "browser_pane_not_opened" as const,
      }),
    });
    const state = await service.getLaneState({ laneId: "lane-1" });
    expect(state.browser).toBeNull();
    expect(state.browserUnavailable).toBe("browser_pane_not_opened");
    service.dispose();
  });

  it("omits the browser entirely on a runtime with no bridge", async () => {
    const service = createWorkToolsStateService({ projectRoot });
    const state = await service.getLaneState({ laneId: "lane-1" });
    expect(state.browser).toBeNull();
    expect(state.browserUnavailable).toBe("desktop_not_attached");
    expect(state.appControl).toBeNull();
    service.dispose();
  });

  it("holds the desktop's active tool per lane and coalesces rapid changes into one event", async () => {
    vi.useFakeTimers();
    const onStateChanged = vi.fn();
    const service = createWorkToolsStateService({ projectRoot, onStateChanged, debounceMs: 250 });

    service.setActiveTool({ laneId: "lane-1", tool: "git" });
    service.setActiveTool({ laneId: "lane-1", tool: "files" });
    service.setActiveTool({ laneId: "lane-1", tool: "browser" });
    expect(onStateChanged).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(onStateChanged).toHaveBeenCalledTimes(1);
    expect(onStateChanged).toHaveBeenCalledWith("lane-1");

    const state = await service.getLaneState({ laneId: "lane-1" });
    expect(state.activeTool).toBe("browser");
    expect(state.activeToolUpdatedAt).toBeTruthy();

    // A different lane is its own debounce window.
    service.setActiveTool({ laneId: "lane-2", tool: "ios" });
    vi.advanceTimersByTime(250);
    expect(onStateChanged).toHaveBeenCalledTimes(2);
    expect(onStateChanged).toHaveBeenLastCalledWith("lane-2");
    expect((await service.getLaneState({ laneId: "lane-1" })).activeTool).toBe("browser");
    service.dispose();
  });

  it("does not emit when the desktop re-publishes the tool it already published", () => {
    vi.useFakeTimers();
    const onStateChanged = vi.fn();
    const service = createWorkToolsStateService({ projectRoot, onStateChanged, debounceMs: 10 });

    service.setActiveTool({ laneId: "lane-1", tool: "browser" });
    vi.advanceTimersByTime(10);
    expect(onStateChanged).toHaveBeenCalledTimes(1);

    // Reconnect re-publish: same value, so nothing changed for any client.
    service.setActiveTool({ laneId: "lane-1", tool: "browser" });
    vi.advanceTimersByTime(10);
    expect(onStateChanged).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("mirrors the whole tab strip, not just the tool on screen", async () => {
    const service = createWorkToolsStateService({ projectRoot });

    service.setActiveTool({
      laneId: "lane-1",
      tool: "browser",
      openTools: ["terminal", "browser", "git"],
    });
    expect((await service.getLaneState({ laneId: "lane-1" })).openTools)
      .toEqual(["terminal", "browser", "git"]);

    // Closing a tab is just the next publish.
    service.setActiveTool({ laneId: "lane-1", tool: "git", openTools: ["terminal", "git"] });
    const closed = await service.getLaneState({ laneId: "lane-1" });
    expect(closed.openTools).toEqual(["terminal", "git"]);
    expect(closed.activeTool).toBe("git");

    // Back to the picker with tabs still open.
    service.setActiveTool({ laneId: "lane-1", tool: null, openTools: ["terminal", "git"] });
    const picker = await service.getLaneState({ laneId: "lane-1" });
    expect(picker.activeTool).toBeNull();
    expect(picker.openTools).toEqual(["terminal", "git"]);
    service.dispose();
  });

  it("treats a desktop that publishes no strip as the one-tab pane it has", async () => {
    const service = createWorkToolsStateService({ projectRoot });

    service.setActiveTool({ laneId: "lane-1", tool: "files" });
    expect((await service.getLaneState({ laneId: "lane-1" })).openTools).toEqual(["files"]);

    service.setActiveTool({ laneId: "lane-2", tool: null });
    expect((await service.getLaneState({ laneId: "lane-2" })).openTools).toEqual([]);

    // A lane nobody has published for has no strip at all.
    expect((await service.getLaneState({ laneId: "lane-3" })).openTools).toEqual([]);
    service.dispose();
  });

  it("drops unknown and duplicated strip entries and keeps the active tab in it", async () => {
    const service = createWorkToolsStateService({ projectRoot });
    service.setActiveTool({
      laneId: "lane-1",
      tool: "git",
      openTools: ["browser", "browser", "nope", 7] as never,
    });
    expect((await service.getLaneState({ laneId: "lane-1" })).openTools).toEqual(["browser", "git"]);
    service.dispose();
  });

  it("emits when only the strip changed", () => {
    vi.useFakeTimers();
    const onStateChanged = vi.fn();
    const service = createWorkToolsStateService({ projectRoot, onStateChanged, debounceMs: 10 });

    service.setActiveTool({ laneId: "lane-1", tool: "git", openTools: ["git"] });
    vi.advanceTimersByTime(10);
    expect(onStateChanged).toHaveBeenCalledTimes(1);

    // Same tool on screen, one more tab behind it: a client showing the strip
    // would otherwise never hear about the new tab.
    service.setActiveTool({ laneId: "lane-1", tool: "git", openTools: ["git", "browser"] });
    vi.advanceTimersByTime(10);
    expect(onStateChanged).toHaveBeenCalledTimes(2);

    // …and a true re-publish still says nothing.
    service.setActiveTool({ laneId: "lane-1", tool: "git", openTools: ["git", "browser"] });
    vi.advanceTimersByTime(10);
    expect(onStateChanged).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("rejects an unknown tool rather than storing it", () => {
    const service = createWorkToolsStateService({ projectRoot });
    expect(() => service.setActiveTool({ laneId: "lane-1", tool: "nope" as never })).toThrow(/unknown tool/);
    service.dispose();
  });

  it("requires a lane id", async () => {
    const service = createWorkToolsStateService({ projectRoot });
    expect(() => service.setActiveTool({ laneId: "  ", tool: null })).toThrow(/requires laneId/);
    await expect(service.getLaneState({ laneId: "" })).rejects.toThrow(/requires laneId/);
    service.dispose();
  });

  it("reports the newest observation for the lane and serves its bytes separately", async () => {
    writeObservation({ kind: "browser", id: "obs-1", capturedAt: "2026-01-01T00:00:00.000Z" });
    const newest = writeObservation({
      kind: "browser",
      id: "obs-2",
      capturedAt: "2026-01-02T00:00:00.000Z",
      ownerLaneId: "lane-1",
      title: "Sign in",
    });
    // Another lane's capture must not leak into this lane's pane.
    writeObservation({
      kind: "browser",
      id: "obs-3",
      capturedAt: "2026-01-03T00:00:00.000Z",
      ownerLaneId: "lane-other",
    });

    const service = createWorkToolsStateService({
      projectRoot,
      getBrowserStatus: async () => browserStatus({ tabs: [tab()] }),
    });

    const state = await service.getLaneState({ laneId: "lane-1" });
    expect(state.browser?.latestObservation).toEqual({
      path: newest,
      capturedAt: "2026-01-02T00:00:00.000Z",
      caption: "Sign in",
    });
    // The state carried a path, never bytes.
    expect(JSON.stringify(state)).not.toContain("base64");

    const preview = await service.readObservationPreview({ path: newest });
    expect(preview?.mimeType).toBe("image/png");
    expect(preview?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    service.dispose();
  });

  it("refuses to read a path outside the observation caches", async () => {
    const outside = path.join(projectRoot, "secret.png");
    fs.writeFileSync(outside, PNG_BYTES);
    const service = createWorkToolsStateService({ projectRoot });
    await expect(service.readObservationPreview({ path: outside })).resolves.toBeNull();
    service.dispose();
  });

  it("refuses a non-image observation path even inside the cache", async () => {
    const root = path.join(projectRoot, ".ade", "cache", "browser-observations");
    fs.mkdirSync(root, { recursive: true });
    const notAnImage = path.join(root, "notes.txt");
    fs.writeFileSync(notAnImage, "hello");
    const service = createWorkToolsStateService({ projectRoot });
    await expect(service.readObservationPreview({ path: notAnImage })).resolves.toBeNull();
    service.dispose();
  });

  it("refuses another lane's observation preview when the caller names its lane", async () => {
    const mine = writeObservation({
      kind: "browser",
      id: "obs-mine",
      capturedAt: "2026-01-01T00:00:00.000Z",
      ownerLaneId: "lane-1",
    });
    const theirs = writeObservation({
      kind: "browser",
      id: "obs-theirs",
      capturedAt: "2026-01-01T00:01:00.000Z",
      ownerLaneId: "lane-2",
    });
    const service = createWorkToolsStateService({ projectRoot });
    // The sidecar is the authority, re-read here: a path is not a permission,
    // and the caller could have learned or guessed one from another lane.
    await expect(
      service.readObservationPreview({ path: theirs, callerLaneId: "lane-1" }),
    ).resolves.toBeNull();
    await expect(
      service.readObservationPreview({ path: mine, callerLaneId: "lane-1" }),
    ).resolves.toMatchObject({ mimeType: "image/png" });
    // A user client sends no lane and stays unscoped.
    await expect(service.readObservationPreview({ path: theirs })).resolves.toMatchObject({
      mimeType: "image/png",
    });
    service.dispose();
  });

  it("warns when a desktop IS attached and refuses, and stays quiet when there is none", async () => {
    const warn = vi.fn();
    const debug = vi.fn();
    const logger = { debug, info: vi.fn(), warn, error: vi.fn() } as never;

    const refused = createWorkToolsStateService({
      projectRoot,
      logger,
      getBrowserStatus: async () => {
        throw new Error("Built-in browser automation needs a chat capability");
      },
    });
    const refusedState = await refused.getLaneState({ laneId: "lane-1" });
    expect(refusedState.browserUnavailable).toBe("desktop_not_attached");
    // A refusal is a real fault: it renders as the same empty state on every
    // phone, so a debug line would make it invisible (it did).
    expect(warn).toHaveBeenCalledWith("work_tools.browser_status_failed", expect.anything());
    refused.dispose();

    warn.mockClear();
    const headless = createWorkToolsStateService({
      projectRoot,
      logger,
      getBrowserStatus: async () => {
        throw new DesktopBridgeUnavailableError("/tmp/bridge.sock", "no desktop is listening");
      },
    });
    await headless.getLaneState({ laneId: "lane-1" });
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith("work_tools.browser_status_unavailable", expect.anything());
    headless.dispose();
  });

  describe("mac desktop", () => {
    function macStatus(
      overrides: Partial<MacDesktopStatus> = {},
    ): MacDesktopStatus {
      return {
        platform: "darwin",
        supported: true,
        unsupportedReason: null,
        driver: { state: "running", title: "Running", message: "", recovery: null, version: "1.0.0" },
        permissions: { screenRecording: "granted", accessibility: "granted" },
        displayMode: "virtual",
        display: {
          laneId: "lane-1",
          displayId: 7,
          name: "ADE · lane",
          mode: "virtual",
          width: 2560,
          height: 1440,
          scale: 2,
          origin: { x: 0, y: 0 },
          createdAt: "2026-01-01T00:00:00.000Z",
          windowCount: 1,
          lastActivityAt: "2026-01-01T00:01:00.000Z",
        },
        windows: [],
        lease: null,
        stream: null,
        recording: null,
        lanes: [],
        hostIsLocal: true,
        responsibleAppName: "ADE",
        signing: "identity",
        ...overrides,
      };
    }

    /** A stub service with the exact two-member shape the aggregator may hold. */
    function macService(status: () => MacDesktopStatus) {
      const listeners = new Set<(event: MacDesktopEventPayload) => void>();
      return {
        reader: {
          getStatus: async () => status(),
          subscribe(listener: (event: MacDesktopEventPayload) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        emit(event: MacDesktopEventPayload) {
          for (const listener of [...listeners]) listener(event);
        },
        get listenerCount() {
          return listeners.size;
        },
      };
    }

    it("hides the tool entirely on a runtime with no mac desktop service", async () => {
      const service = createWorkToolsStateService({ projectRoot });
      const state = await service.getLaneState({ laneId: "lane-1" });
      expect(state.macDesktop).toBeNull();
      service.dispose();
    });

    it("reports supported:false on a host that cannot hold a display", async () => {
      const mac = macService(() => macStatus({
        platform: "win32",
        supported: false,
        unsupportedReason: "Mac Desktop runs on macOS only.",
        displayMode: "unavailable",
        display: null,
        hostIsLocal: false,
      }));
      const service = createWorkToolsStateService({ projectRoot, macDesktopService: mac.reader });
      const state = await service.getLaneState({ laneId: "lane-1" });
      expect(state.macDesktop?.supported).toBe(false);
      expect(state.macDesktop?.display).toBeNull();
      expect(state.macDesktop?.hostIsLocal).toBe(false);
      service.dispose();
    });

    it("summarizes the lane's display, windows, lease and stream", async () => {
      const mac = macService(() => macStatus({
        windows: [{
          id: 11,
          pid: 42,
          appName: "Safari",
          bundleId: "com.apple.Safari",
          title: "Example",
          frame: { x: 0, y: 0, width: 800, height: 600 },
          laneId: "lane-1",
          origin: "ade_launched",
          onDisplayId: 7,
          minimized: false,
          singleInstance: false,
        }],
        lease: {
          laneId: "lane-1",
          holder: "agent",
          holderId: "chat-1",
          holderLabel: "Fix the header",
          grantedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T00:01:00.000Z",
        },
        stream: { running: true, idle: false, fps: 30, bitrateKbps: 2000, lastError: null },
      }));
      const service = createWorkToolsStateService({ projectRoot, macDesktopService: mac.reader });
      const state = await service.getLaneState({ laneId: "lane-1" });
      expect(state.macDesktop?.windows.map((window) => window.appName)).toEqual(["Safari"]);
      expect(state.macDesktop?.lease?.holder).toBe("agent");
      expect(state.macDesktop?.stream?.running).toBe(true);
      expect(state.macDesktop?.permissions.screenRecording).toBe("granted");
      service.dispose();
    });

    it("carries only whether the lane is recording and since when", async () => {
      let recording: MacDesktopStatus["recording"] = null;
      const mac = macService(() => macStatus({ recording }));
      const service = createWorkToolsStateService({ projectRoot, macDesktopService: mac.reader });
      expect((await service.getLaneState({ laneId: "lane-1" })).macDesktop?.recording).toBeNull();

      recording = {
        laneId: "lane-1",
        running: true,
        startedAt: "2026-01-02T00:00:00.000Z",
        filePath: "/Users/someone/private/rec.mp4",
        durationMs: null,
        caption: "Proof caption",
      };
      const live = await service.getLaneState({ laneId: "lane-1" });
      // The host path and the caption never cross the wire.
      expect(live.macDesktop?.recording).toEqual({ running: true, startedAt: "2026-01-02T00:00:00.000Z" });

      recording = { ...recording, running: false, filePath: "/Users/someone/private/rec.mp4", durationMs: 4000 };
      const stopped = await service.getLaneState({ laneId: "lane-1" });
      expect(stopped.macDesktop?.recording).toEqual({ running: false, startedAt: "2026-01-02T00:00:00.000Z" });
      service.dispose();
    });

    it("re-derives from the observation event rather than polling for frames", async () => {
      const mac = macService(() => macStatus());
      const service = createWorkToolsStateService({ projectRoot, macDesktopService: mac.reader });
      expect((await service.getLaneState({ laneId: "lane-1" })).macDesktop?.lastObservation).toBeNull();
      mac.emit({
        type: "observation",
        laneId: "lane-1",
        observation: {
          id: "obs-1",
          laneId: "lane-1",
          capturedAt: "2026-01-02T00:00:00.000Z",
          screenshotPath: "/tmp/mac/obs-1.png",
          mapPath: null,
          display: { width: 2560, height: 1440, scale: 2 },
          windows: [],
          elements: [],
          elementCount: 0,
          truncated: false,
          caption: "click · Sign in",
        },
      });
      const after = await service.getLaneState({ laneId: "lane-1" });
      expect(after.macDesktop?.lastObservation).toEqual({
        id: "obs-1",
        capturedAt: "2026-01-02T00:00:00.000Z",
        caption: "click · Sign in",
        screenshotPath: "/tmp/mac/obs-1.png",
      });
      service.dispose();
    });

    it("tells clients to look again on every desktop event, and fans host-wide ones out", async () => {
      vi.useFakeTimers();
      const onStateChanged = vi.fn();
      const mac = macService(() => macStatus());
      const service = createWorkToolsStateService({
        projectRoot,
        macDesktopService: mac.reader,
        onStateChanged,
        debounceMs: 10,
      });
      await service.getLaneState({ laneId: "lane-1" });
      await service.getLaneState({ laneId: "lane-2" });
      mac.emit({ type: "lease-changed", laneId: "lane-1", lease: null });
      vi.advanceTimersByTime(20);
      expect(onStateChanged.mock.calls.map(([laneId]) => laneId)).toEqual(["lane-1"]);

      onStateChanged.mockClear();
      // A revoked grant changes every lane's answer at once.
      mac.emit({
        type: "permission-changed",
        permissions: { screenRecording: "denied", accessibility: "granted" },
      });
      vi.advanceTimersByTime(20);
      expect(onStateChanged.mock.calls.map(([laneId]) => laneId).sort()).toEqual(["lane-1", "lane-2"]);
      service.dispose();
    });

    it("drops the last frame with the display it described", async () => {
      const mac = macService(() => macStatus({ display: null }));
      const service = createWorkToolsStateService({ projectRoot, macDesktopService: mac.reader });
      mac.emit({
        type: "observation",
        laneId: "lane-1",
        observation: {
          id: "obs-1",
          laneId: "lane-1",
          capturedAt: "2026-01-02T00:00:00.000Z",
          screenshotPath: "/tmp/mac/obs-1.png",
          mapPath: null,
          display: { width: 2560, height: 1440, scale: 2 },
          windows: [],
          elements: [],
          elementCount: 0,
          truncated: false,
          caption: null,
        },
      });
      const state = await service.getLaneState({ laneId: "lane-1" });
      expect(state.macDesktop?.lastObservation).toBeNull();
      service.dispose();
    });

    it("mirrors stranded windows, hides a retry in progress, and drops one once it parks", async () => {
      // `window-not-parked` used to reach the mirror and stop there. A window
      // the driver could not park is on the human's own screen, which is the one
      // thing a phone cannot see, so it is the thing most worth forwarding — but
      // a `not_ready` retry the driver is about to fix is not news, and a phone
      // shows whatever it is handed, so it never crosses the wire.
      const mac = macService(() => macStatus());
      const service = createWorkToolsStateService({ projectRoot, macDesktopService: mac.reader });
      await service.getLaneState({ laneId: "lane-1" });
      mac.emit({ type: "window-not-parked", laneId: "lane-1", windowId: 1, reason: "not_ready" });
      mac.emit({ type: "window-not-parked", laneId: "lane-1", windowId: 2, reason: "denied" });
      // Another lane's stranded window must not show up in this lane's mirror.
      mac.emit({ type: "window-not-parked", laneId: "lane-2", windowId: 3, reason: "denied" });

      const stranded = await service.getLaneState({ laneId: "lane-1" });
      expect(stranded.macDesktop?.notParked).toEqual([
        { windowId: 2, reason: "denied", at: expect.any(Number), firstSeenAt: expect.any(Number) },
      ]);

      mac.emit({
        type: "windows-changed",
        laneId: "lane-1",
        // Window 2 landed; window 1 is not listed at all, so it is gone.
        windows: [{ id: 2, laneId: "lane-1", appName: "Safari" }] as never,
      });
      const settled = await service.getLaneState({ laneId: "lane-1" });
      expect(settled.macDesktop?.notParked).toEqual([]);
      service.dispose();
    });

    it("reports the tool as absent when getStatus fails, and warns", async () => {
      const warn = vi.fn();
      const mac = macService(() => {
        throw new Error("driver is gone");
      });
      const service = createWorkToolsStateService({
        projectRoot,
        macDesktopService: mac.reader,
        logger: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Parameters<
          typeof createWorkToolsStateService
        >[0]["logger"],
      });
      const state = await service.getLaneState({ laneId: "lane-1" });
      expect(state.macDesktop).toBeNull();
      expect(warn).toHaveBeenCalledWith("work_tools.mac_desktop_status_failed", expect.anything());
      service.dispose();
    });

    it("unsubscribes on dispose", async () => {
      const mac = macService(() => macStatus());
      const service = createWorkToolsStateService({ projectRoot, macDesktopService: mac.reader });
      expect(mac.listenerCount).toBe(1);
      service.dispose();
      expect(mac.listenerCount).toBe(0);
    });
  });

  it("stops emitting after dispose", () => {
    vi.useFakeTimers();
    const onStateChanged = vi.fn();
    const service = createWorkToolsStateService({ projectRoot, onStateChanged, debounceMs: 10 });
    service.setActiveTool({ laneId: "lane-1", tool: "git" });
    service.dispose();
    vi.advanceTimersByTime(50);
    expect(onStateChanged).not.toHaveBeenCalled();
  });
});
