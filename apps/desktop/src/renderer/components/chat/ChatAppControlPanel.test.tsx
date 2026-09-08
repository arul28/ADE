/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AppControlActionTraceEntry,
  AppControlContextItem,
  AppControlDriversResult,
  AppControlObservation,
  AppControlSession,
  AppControlSnapshot,
  AppControlStatus,
  AppControlTarget,
} from "../../../shared/types";
import { ChatAppControlPanel } from "./ChatAppControlPanel";

const transparentPngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const connectedSession: AppControlSession = {
  id: "app-control-session-1",
  appKind: "electron",
  label: "ADE Test",
  projectRoot: "/repo",
  laneId: "lane-1",
  cwd: "/repo",
  command: "npm run dev",
  pid: 1234,
  terminalSessionId: "terminal-1",
  terminalPtyId: "pty-1",
  cdpPort: 9222,
  cdpEndpoint: "ws://127.0.0.1:9222/devtools/page/1",
  cdpTargetId: "target-1",
  provider: "cdp",
  driver: "cdp",
  chatSessionId: "chat-1",
  startedAt: "2026-05-12T00:00:00.000Z",
  connectedAt: "2026-05-12T00:00:01.000Z",
  status: "connected",
  lastError: null,
  lastObservationId: null,
  lastTraceEntryId: null,
};

const connectedStatus: AppControlStatus = {
  platform: "darwin",
  supported: true,
  activeSession: connectedSession,
  providers: [{ provider: "cdp", available: true }],
};

const idleStatus: AppControlStatus = {
  platform: "darwin",
  supported: true,
  activeSession: null,
  providers: [{ provider: "cdp", available: true }],
};

const snapshot: AppControlSnapshot = {
  session: connectedSession,
  capturedAt: "2026-05-12T00:00:02.000Z",
  screenshot: {
    sessionId: connectedSession.id,
    cdpTargetId: "target-1",
    capturedAt: "2026-05-12T00:00:02.000Z",
    width: 100,
    height: 80,
    dataUrl: transparentPngDataUrl,
  },
  screen: {
    width: 100,
    height: 80,
    scale: 1,
    viewportWidth: 100,
    viewportHeight: 80,
    devicePixelRatio: 1,
    scaleX: 1,
    scaleY: 1,
  },
  elements: [{
    id: "element-1",
    ref: "ref-1",
    provider: "cdp",
    tagName: "button",
    role: "button",
    label: "Run",
    value: null,
    selector: "button.run",
    testId: "run-button",
    frame: { x: 10, y: 10, width: 30, height: 20 },
    pixelFrame: { x: 10, y: 10, width: 30, height: 20 },
    metadata: {},
  }],
  hitElement: null,
  providers: [{ provider: "screenshot", available: true }, { provider: "cdp", available: true, elementCount: 1 }],
  url: "http://localhost:5173",
  title: "ADE renderer",
};

const selectedSnapshot: AppControlSnapshot = {
  ...snapshot,
  hitElement: snapshot.elements[0] ?? null,
};

const targets: AppControlTarget[] = [
  { id: "target-1", title: "ADE renderer", url: "http://localhost:5173", type: "page", active: true },
  { id: "target-2", title: "Settings", url: "http://localhost:5173/settings", type: "page", active: false },
];

const contextItem: AppControlContextItem = {
  kind: "app_control_element",
  id: "context-1",
  appKind: "electron",
  sessionId: connectedSession.id,
  provider: "cdp",
  componentId: "Run button",
  sourceFile: "src/App.tsx",
  sourceLine: 42,
  frame: null,
  metadata: {},
  screenshotDataUrl: null,
  selectedAt: "2026-05-12T00:00:03.000Z",
};

const OBSERVATION_ID = "obs-1717000000000-8b0c1a2d";

const observation: AppControlObservation = {
  id: OBSERVATION_ID,
  sessionId: connectedSession.id,
  cdpTargetId: "target-1",
  url: "http://localhost:5173",
  title: "ADE renderer",
  capturedAt: "2026-05-12T00:00:04.000Z",
  width: 100,
  height: 80,
  mimeType: "image/png",
  filePath: "/repo/.ade/cache/app-control-observations/session/obs.png",
  relativePath: ".ade/cache/app-control-observations/session/obs.png",
  dom: {
    url: "http://localhost:5173",
    title: "ADE renderer",
    capturedAt: "2026-05-12T00:00:04.000Z",
    viewport: { x: 0, y: 0, width: 100, height: 80 },
    scroll: { x: 0, y: 0 },
    elementCount: 1,
    elements: [{
      index: 1,
      handle: `${OBSERVATION_ID}:e:1`,
      tagName: "button",
      role: "button",
      label: "Sign in",
      text: null,
      value: null,
      placeholder: null,
      selector: "button.sign-in",
      testId: null,
      href: null,
      disabled: false,
      frame: { x: 10, y: 20, width: 40, height: 16 },
      center: { x: 30, y: 28 },
    }],
  },
  diagnostics: {
    capturedAt: "2026-05-12T00:00:04.000Z",
    pendingRequestCount: 0,
    console: [
      { level: "error", message: "boom", sourceId: null, line: null, column: null, timestamp: "2026-05-12T00:00:04.000Z" },
    ],
    network: [
      { url: "/api", method: "GET", resourceType: "fetch", statusCode: 500, error: null, startedAt: null, endedAt: "2026-05-12T00:00:04.000Z", durationMs: 12 },
    ],
  },
  laneId: "lane-1",
  chatSessionId: "chat-1",
  cleanup: { keepCount: 3, keptCount: 1, deletedCount: 0 },
};

const traceEntry: AppControlActionTraceEntry = {
  id: "trace-1",
  sessionId: connectedSession.id,
  cdpTargetId: "target-1",
  action: "click",
  status: "ok",
  startedAt: "2026-05-12T00:00:05.000Z",
  endedAt: "2026-05-12T00:00:06.200Z",
  durationMs: 1_200,
  before: { url: null, title: null },
  after: { url: null, title: null },
  target: { handle: `${OBSERVATION_ID}:e:1` },
  observationId: OBSERVATION_ID,
  error: null,
};

const drivers: AppControlDriversResult = {
  platform: "darwin",
  activeDriver: "cdp",
  drivers: [
    { driver: "cdp", status: "available", reason: null, implemented: true },
    {
      driver: "computer_use",
      status: "unavailable",
      reason: "The computer-use App Control driver is not implemented in this build.",
      implemented: false,
    },
  ],
};

const appControlEventListeners = new Set<(event: unknown) => void>();

function emitAppControlEvent(event: unknown): void {
  act(() => {
    for (const listener of appControlEventListeners) listener(event);
  });
}

function installAdeMock({
  status = idleStatus,
  targetList = [],
  traceEntries = [] as AppControlActionTraceEntry[],
}: {
  status?: AppControlStatus;
  targetList?: AppControlTarget[];
  traceEntries?: AppControlActionTraceEntry[];
} = {}) {
  const api = {
    appControl: {
      getStatus: vi.fn().mockResolvedValue(status),
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      listTargets: vi.fn().mockResolvedValue(targetList),
      onEvent: vi.fn((cb: (event: unknown) => void) => {
        appControlEventListeners.add(cb);
        return () => appControlEventListeners.delete(cb);
      }),
      attachToTarget: vi.fn().mockResolvedValue(connectedSession),
      switchWindow: vi.fn().mockResolvedValue({
        sessionId: connectedSession.id,
        activeTargetId: "target-2",
        windows: targetList,
      }),
      launchInTerminal: vi.fn(),
      connect: vi.fn(),
      stop: vi.fn(),
      focusWindow: vi.fn().mockResolvedValue({ ok: true }),
      minimizeWindow: vi.fn().mockResolvedValue({ ok: true }),
      screenshot: vi.fn().mockResolvedValue({
        sessionId: connectedSession.id,
        cdpTargetId: "target-1",
        capturedAt: "2026-05-12T00:00:02.000Z",
        width: 100,
        height: 80,
        dataUrl: transparentPngDataUrl,
      }),
      click: vi.fn().mockResolvedValue(undefined),
      typeText: vi.fn().mockResolvedValue(undefined),
      scroll: vi.fn().mockResolvedValue(undefined),
      inspectPoint: vi.fn().mockResolvedValue({ item: contextItem, source: "cdp", snapshot: selectedSnapshot }),
      selectPoint: vi.fn().mockResolvedValue({ item: contextItem, source: "cdp", snapshot: selectedSnapshot }),
      listDrivers: vi.fn().mockResolvedValue(drivers),
      observe: vi.fn().mockResolvedValue(observation),
      getTrace: vi.fn().mockResolvedValue({ sessionId: connectedSession.id, entries: traceEntries }),
      windows: vi.fn().mockResolvedValue({
        sessionId: connectedSession.id,
        activeTargetId: "target-1",
        windows: targetList,
      }),
    },
    agentChat: {
      saveTempAttachment: vi.fn().mockResolvedValue({ path: ".ade/artifacts/app-control-selection.png" }),
    },
  };
  (window as any).ade = api;
  return api;
}

/** Open the "…" toolbar menu and return once its items are on screen. */
async function openOverflow(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "App Control actions" }));
  await screen.findByRole("menu", { name: "App Control actions" });
}

async function openAppPicker(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "App Control launch target" }));
  await screen.findByRole("menu", { name: "App Control launch target" });
}

function stubImageBounds(image: HTMLImageElement): void {
  image.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 80,
    width: 100,
    height: 80,
    toJSON: () => ({}),
  });
}

describe("ChatAppControlPanel", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    appControlEventListeners.clear();
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("offers the launch target picker with no session, and inserts the CDP help draft", async () => {
    installAdeMock();
    const onInsertDraft = vi.fn();

    render(
      <ChatAppControlPanel
        sessionId="chat-help-draft"
        laneId="lane-1"
        projectRoot="/repo"
        onInsertDraft={onInsertDraft}
      />,
    );

    // The empty state is the launchpad, not a dead end.
    expect(await screen.findByRole("button", { name: "Pick an app to drive" })).toBeTruthy();
    expect(screen.getByText("No app attached")).toBeTruthy();
    expect(screen.getByText(/ade app-control launch/)).toBeTruthy();

    await openAppPicker();
    fireEvent.click(screen.getByText("Help wire CDP"));

    expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("Set up this Electron app for ADE App Control."));
  });

  it("launches from the picker and remembers the command as a recent", async () => {
    const api = installAdeMock();
    api.appControl.launchInTerminal.mockResolvedValue({ ...connectedSession, status: "starting" });

    render(
      <ChatAppControlPanel sessionId="chat-launch" laneId="lane-1" projectRoot="/repo" />,
    );

    await openAppPicker();
    fireEvent.change(screen.getByLabelText("App Control launch command"), {
      target: { value: "pnpm dev" },
    });
    fireEvent.click(screen.getByLabelText("Launch App Control command"));

    await waitFor(() => {
      expect(api.appControl.launchInTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ command: "pnpm dev", projectRoot: "/repo" }),
        null,
      );
    });

    await openAppPicker();
    expect(await screen.findByText("Recent")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "pnpm dev" })).toBeTruthy();
  });

  it("drives connected-session controls without launching or sending input", async () => {
    const api = installAdeMock({ status: connectedStatus, targetList: targets });
    const onShowTerminal = vi.fn();

    render(
      <ChatAppControlPanel
        sessionId="chat-connected"
        laneId="lane-1"
        projectRoot="/repo"
        onShowTerminal={onShowTerminal}
      />,
    );

    // The toolbar names the app and says it is attached.
    expect(await screen.findByText("ADE Test")).toBeTruthy();
    expect(screen.getByText("attached")).toBeTruthy();

    await openOverflow();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal terminal" }));
    expect(onShowTerminal).toHaveBeenCalledWith({
      terminalId: "terminal-1",
      ptyId: "pty-1",
      label: "ADE Test",
    });

    await openOverflow();
    fireEvent.click(screen.getByRole("menuitem", { name: "Show app window" }));
    await waitFor(() => {
      expect(api.appControl.focusWindow).toHaveBeenCalled();
    });

    await openOverflow();
    fireEvent.click(screen.getByRole("menuitem", { name: "Minimize app window" }));
    await waitFor(() => {
      expect(api.appControl.minimizeWindow).toHaveBeenCalled();
    });

    await openOverflow();
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh snapshot" }));
    expect(await screen.findByText("Snapshot refreshed.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    await waitFor(() => {
      expect(screen.queryByText("Snapshot refreshed.")).toBeNull();
    });

    fireEvent.click(screen.getByText("Inspect"));
    expect(screen.getByText("Click an element to insert its source context.")).toBeTruthy();

    fireEvent.click(screen.getByText("Control"));
    const typeInput = screen.getByLabelText("Text to type into the focused app element") as HTMLInputElement;
    fireEvent.change(typeInput, { target: { value: "hello from fixture" } });
    expect(typeInput.value).toBe("hello from fixture");
    expect(api.appControl.typeText).not.toHaveBeenCalled();

    // Multi-window: a segmented switcher, and switching goes through
    // switchWindow so the stale trace is dropped with the old document.
    const switcher = await screen.findByRole("group", { name: "Controlled window" });
    expect(switcher).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Switch to Settings"));
    await waitFor(() => {
      expect(api.appControl.switchWindow).toHaveBeenCalledWith({ targetId: "target-2" }, null);
    });
  });

  it("names the driver and explains why computer use is unavailable", async () => {
    installAdeMock({ status: connectedStatus, targetList: targets });

    render(
      <ChatAppControlPanel sessionId="chat-drivers" laneId="lane-1" projectRoot="/repo" />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "App Control driver" }));
    const computerUse = await screen.findByRole("menuitemcheckbox", { name: "Computer use" });
    expect((computerUse as HTMLButtonElement).disabled).toBe(true);
    expect(computerUse.getAttribute("title"))
      .toBe("The computer-use App Control driver is not implemented in this build.");
    expect((screen.getByRole("menuitemcheckbox", { name: "CDP" })).getAttribute("aria-checked")).toBe("true");
  });

  it("shows the remote machine when App Control runs on another runtime", async () => {
    installAdeMock({ status: connectedStatus });

    render(
      <ChatAppControlPanel
        sessionId="chat-remote"
        laneId="lane-1"
        projectRoot="/repo"
        runtimePin={{
          kind: "remote",
          key: "remote:1",
          targetId: "target",
          runtimeName: "studio-mini",
          projectId: "p1",
          rootPath: "/repo",
          displayName: "ADE",
        }}
      />,
    );

    expect(await screen.findByText("remote: studio-mini")).toBeTruthy();
  });

  it("keeps another-lane connected session read-only", async () => {
    const api = installAdeMock({ status: connectedStatus, targetList: targets });

    render(
      <ChatAppControlPanel
        sessionId="chat-connected"
        laneId="lane-2"
        projectRoot="/repo"
        controlDisabledReason="This App Control view is attached to Lane 1, not Lane 2."
      />,
    );

    const switchButton = await screen.findByLabelText("Switch to Settings") as HTMLButtonElement;
    expect(switchButton.disabled).toBe(true);

    await openOverflow();
    expect((screen.getByRole("menuitem", { name: "Refresh snapshot" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });

    const typeInput = screen.getByLabelText("Text to type into the focused app element") as HTMLInputElement;
    fireEvent.change(typeInput, { target: { value: "wrong lane" } });
    expect((screen.getByLabelText("Type into focused app element") as HTMLButtonElement).disabled).toBe(true);

    expect(api.appControl.stop).not.toHaveBeenCalled();
    expect(api.appControl.switchWindow).not.toHaveBeenCalled();
    expect(api.appControl.typeText).not.toHaveBeenCalled();
    expect(api.appControl.click).not.toHaveBeenCalled();
  });

  it("hovers, attaches, and re-attaches an inspected app element", async () => {
    const api = installAdeMock({ status: connectedStatus, targetList: targets });
    const onAddContext = vi.fn();

    render(
      <ChatAppControlPanel
        sessionId="chat-inspect"
        laneId="lane-1"
        projectRoot="/repo"
        onAddContext={onAddContext}
      />,
    );

    const image = await screen.findByAltText("Electron app screenshot") as HTMLImageElement;
    stubImageBounds(image);

    fireEvent.click(screen.getByText("Inspect"));
    fireEvent.mouseMove(image, { clientX: 15, clientY: 15 });

    await waitFor(() => {
      expect(api.appControl.inspectPoint).toHaveBeenCalledWith({
        projectRoot: "/repo",
        x: 15,
        y: 15,
        coordinateSpace: "viewport",
        includeScreenshot: false,
      }, null);
    });
    expect(screen.getByText("hovering")).toBeTruthy();

    fireEvent.click(image, { clientX: 60, clientY: 60 });

    await waitFor(() => {
      expect(api.appControl.selectPoint).toHaveBeenCalledWith({
        projectRoot: "/repo",
        x: 60,
        y: 60,
        coordinateSpace: "viewport",
        includeScreenshot: false,
      }, null);
    });
    expect(onAddContext).toHaveBeenCalledWith(expect.objectContaining({
      id: "context-1",
      sourceFile: "src/App.tsx",
    }));
    expect(await screen.findByText("Inserted Run context.")).toBeTruthy();

    const selectCallsBeforeReattach = api.appControl.selectPoint.mock.calls.length;
    fireEvent.click(screen.getByText("Re-attach"));

    await waitFor(() => {
      expect(api.appControl.selectPoint.mock.calls.length).toBeGreaterThan(selectCallsBeforeReattach);
    });
  });

  it("forwards screenshot data to the context owner when attachment persistence is delegated", async () => {
    const api = installAdeMock({ status: connectedStatus, targetList: targets });
    const onAddContext = vi.fn();
    api.appControl.selectPoint.mockResolvedValue({
      item: {
        ...contextItem,
        screenshotDataUrl: transparentPngDataUrl,
      },
      source: "cdp",
      snapshot: null,
    });

    render(
      <ChatAppControlPanel
        sessionId="chat-inspect"
        laneId="lane-1"
        projectRoot="/repo"
        onAddContext={onAddContext}
      />,
    );

    const image = await screen.findByAltText("Electron app screenshot") as HTMLImageElement;
    stubImageBounds(image);
    fireEvent.click(screen.getByText("Inspect"));
    fireEvent.click(image, { clientX: 60, clientY: 60 });

    await waitFor(() => {
      expect(onAddContext).toHaveBeenCalledWith(expect.objectContaining({
        screenshotDataUrl: expect.stringMatching(/^data:image\//),
      }));
    });
    expect(api.agentChat.saveTempAttachment).not.toHaveBeenCalled();
  });

  it("attaches a full screenshot to the chat from the overflow menu", async () => {
    const api = installAdeMock({ status: connectedStatus });
    const onAddAttachment = vi.fn();

    render(
      <ChatAppControlPanel
        sessionId="chat-shot"
        laneId="lane-1"
        projectRoot="/repo"
        onAddAttachment={onAddAttachment}
      />,
    );

    await screen.findByAltText("Electron app screenshot");
    await openOverflow();
    fireEvent.click(screen.getByRole("menuitem", { name: "Screenshot to chat" }));

    await waitFor(() => {
      expect(api.appControl.screenshot).toHaveBeenCalled();
    });
    expect(onAddAttachment).toHaveBeenCalledWith(expect.objectContaining({
      path: ".ade/artifacts/app-control-selection.png",
    }));
  });

  it("paints the observe map on request and hands a handle to the chat", async () => {
    const api = installAdeMock({ status: connectedStatus });
    const onAddContext = vi.fn();

    render(
      <ChatAppControlPanel
        sessionId="chat-observe"
        laneId="lane-1"
        projectRoot="/repo"
        onAddContext={onAddContext}
      />,
    );

    await screen.findByAltText("Electron app screenshot");
    // Never on a timer: observe writes a record and prunes older ones.
    expect(api.appControl.observe).not.toHaveBeenCalled();

    await openOverflow();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Observe with map" }));

    const badge = await screen.findByLabelText(`Element 1, Sign in. Copy handle ${OBSERVATION_ID}:e:1.`);
    // No `maxElements`: the panel takes the service default so its badge
    // numbers match the ones `ade app-control observe` reports. Indices are
    // assigned after the bound, so a smaller bound would renumber elements.
    expect(api.appControl.observe).toHaveBeenCalledWith(
      { includeDom: true, includeDiagnostics: true, includeDataUrl: false },
      null,
    );
    expect(badge.textContent).toBe("①");

    fireEvent.click(badge);
    fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));

    expect(onAddContext).toHaveBeenCalledWith(expect.objectContaining({
      id: `${OBSERVATION_ID}:e:1`,
      componentId: "Sign in",
      metadata: expect.objectContaining({ handle: `${OBSERVATION_ID}:e:1`, elementIndex: 1 }),
    }));

    // Diagnostics from the same observation land in the status row.
    expect(await screen.findByTitle("1 console error in the last observation")).toBeTruthy();
    expect(screen.getByTitle("1 failed request in the last observation")).toBeTruthy();

    // Toggling off removes the map without another observe round trip.
    await openOverflow();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Hide observe map" }));
    await waitFor(() => {
      expect(screen.queryByTestId("app-control-observe-map")).toBeNull();
    });
    expect(api.appControl.observe).toHaveBeenCalledTimes(1);
  });

  it("summarises the last agent action and opens the trace drawer", async () => {
    const api = installAdeMock({ status: connectedStatus, traceEntries: [traceEntry] });

    render(
      <ChatAppControlPanel sessionId="chat-trace" laneId="lane-1" projectRoot="/repo" />,
    );

    await waitFor(() => {
      expect(api.appControl.getTrace).toHaveBeenCalledWith({ limit: 20 }, null);
    });
    expect(await screen.findByText("last: click ① · 1.2s")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show action trace" }));
    const drawer = await screen.findByTestId("app-control-trace-drawer");
    expect(drawer.textContent).toContain("click");
    expect(drawer.textContent).toContain("1.2s");

    fireEvent.click(screen.getByRole("button", { name: "Hide action trace" }));
    await waitFor(() => {
      expect(screen.queryByTestId("app-control-trace-drawer")).toBeNull();
    });
  });

  it("marks failed trace rows and says so on the status line", async () => {
    installAdeMock({
      status: connectedStatus,
      traceEntries: [{
        ...traceEntry,
        status: "error",
        error: "No matching App Control element was found.",
      }],
    });

    render(
      <ChatAppControlPanel sessionId="chat-trace-failed" laneId="lane-1" projectRoot="/repo" />,
    );

    expect(await screen.findByText("last: click ① · 1.2s · failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show action trace" }));
    const row = await screen.findByTitle("No matching App Control element was found.");
    expect(row.textContent).toContain("failed");
  });

  /**
   * "The app stopped responding" is a DROPPED session's screen. A deliberate
   * Stop used to land on it too — the gate was "there is a stale frame and no
   * live one", which is also true one beat after you chose Stop — so the pane
   * offered Reconnect for a session you had just ended.
   */
  function emitLiveFrame(): void {
    // `session-updated` first: the frame handler drops frames whose CDP target
    // is not the one the panel is tracking.
    emitAppControlEvent({ type: "session-updated", session: connectedSession });
    emitAppControlEvent({
      type: "frame",
      frame: {
        cdpTargetId: "target-1",
        mimeType: "image/png",
        data: transparentPngDataUrl.split(",")[1],
        width: 100,
        height: 80,
        viewportWidth: 100,
        viewportHeight: 80,
        scale: 1,
        scaleX: 1,
        scaleY: 1,
      },
    });
  }

  it("returns to the empty state after a deliberate Stop, not to the disconnect screen", async () => {
    const api = installAdeMock({ status: connectedStatus });
    // No static screenshot, so the only frame in play is the live one — which
    // is the situation the disconnect screen is actually about.
    api.appControl.getSnapshot.mockRejectedValue(new Error("no snapshot"));
    render(<ChatAppControlPanel sessionId="chat-stop" laneId="lane-1" projectRoot="/repo" />);
    await screen.findByRole("button", { name: "App Control actions" });

    emitLiveFrame();
    // A stale frame now exists — the precondition the old gate keyed on.
    api.appControl.getStatus.mockResolvedValue(idleStatus);
    emitAppControlEvent({ type: "session-stopped", previousSession: connectedSession });

    await waitFor(() => {
      expect(screen.queryByText("The app stopped responding")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();
  });

  it("still shows the disconnect screen when the session ends in an error", async () => {
    const failedSession: AppControlSession = {
      ...connectedSession,
      status: "failed",
      lastError: "ADE Test stopped responding.",
    };
    const api = installAdeMock({ status: connectedStatus });
    api.appControl.getSnapshot.mockRejectedValue(new Error("no snapshot"));
    render(<ChatAppControlPanel sessionId="chat-dropped" laneId="lane-1" projectRoot="/repo" />);
    await screen.findByRole("button", { name: "App Control actions" });

    emitLiveFrame();
    api.appControl.getStatus.mockResolvedValue({ ...connectedStatus, activeSession: failedSession });
    emitAppControlEvent({ type: "session-updated", session: failedSession });

    expect(await screen.findByText("The app stopped responding")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reconnect/ })).toBeTruthy();
  });
});
