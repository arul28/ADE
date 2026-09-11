import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppControlStatus } from "../../../../desktop/src/shared/types";
import type {
  BuiltInBrowserRuntimeStatus,
  BuiltInBrowserRuntimeTabStatus,
} from "../../../../desktop/src/shared/types/builtInBrowserRuntimeStatus";
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
