/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AppControlContextItem,
  AppControlSession,
  AppControlSnapshot,
  AppControlStatus,
  AppControlTarget,
  ProcessDefinition,
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
  chatSessionId: "chat-1",
  startedAt: "2026-05-12T00:00:00.000Z",
  connectedAt: "2026-05-12T00:00:01.000Z",
  status: "connected",
  lastError: null,
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

const devProcess: ProcessDefinition = {
  id: "dev",
  name: "Desktop dev",
  command: ["npm", "run", "dev"],
  cwd: "apps/desktop",
  env: {},
  groupIds: [],
  autostart: false,
  restart: "never",
  gracefulShutdownMs: 1000,
  dependsOn: [],
  readiness: { type: "none" },
};

function installAdeMock({
  status = idleStatus,
  processes = [],
  targetList = [],
}: {
  status?: AppControlStatus;
  processes?: ProcessDefinition[];
  targetList?: AppControlTarget[];
} = {}) {
  const api = {
    projectConfig: {
      get: vi.fn().mockResolvedValue({ effective: { processes } }),
    },
    appControl: {
      getStatus: vi.fn().mockResolvedValue(status),
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      listTargets: vi.fn().mockResolvedValue(targetList),
      onEvent: vi.fn(() => () => {}),
      attachToTarget: vi.fn().mockResolvedValue(connectedSession),
      launchInTerminal: vi.fn(),
      connect: vi.fn(),
      stop: vi.fn(),
      focusWindow: vi.fn().mockResolvedValue({ ok: true }),
      minimizeWindow: vi.fn().mockResolvedValue({ ok: true }),
      click: vi.fn().mockResolvedValue(undefined),
      typeText: vi.fn().mockResolvedValue(undefined),
      scroll: vi.fn().mockResolvedValue(undefined),
      inspectPoint: vi.fn().mockResolvedValue({ item: contextItem, source: "cdp", snapshot: selectedSnapshot }),
      selectPoint: vi.fn().mockResolvedValue({ item: contextItem, source: "cdp", snapshot: selectedSnapshot }),
    },
    agentChat: {
      saveTempAttachment: vi.fn().mockResolvedValue({ path: ".ade/artifacts/app-control-selection.png" }),
    },
  };
  (window as any).ade = api;
  return api;
}

describe("ChatAppControlPanel", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("selects a configured run command and inserts the CDP help draft", async () => {
    const api = installAdeMock({ processes: [devProcess] });
    const onInsertDraft = vi.fn();

    render(
      <ChatAppControlPanel
        sessionId="chat-run-command"
        laneId="lane-1"
        projectRoot="/repo"
        onInsertDraft={onInsertDraft}
      />,
    );

    const runCommandSelect = await screen.findByLabelText("Select run command") as HTMLSelectElement;
    await waitFor(() => expect(runCommandSelect.disabled).toBe(false));

    fireEvent.change(runCommandSelect, { target: { value: "dev" } });

    expect((screen.getByLabelText("App Control launch command") as HTMLInputElement).value).toBe("npm run dev");
    expect(api.projectConfig.get).toHaveBeenCalled();

    fireEvent.click(screen.getByText("Help wire CDP"));

    expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("Set up this Electron app for ADE App Control."));
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

    fireEvent.click(await screen.findByTitle("Show the launch terminal"));
    expect(onShowTerminal).toHaveBeenCalledWith({
      terminalId: "terminal-1",
      ptyId: "pty-1",
      label: "ADE Test",
    });

    fireEvent.click(screen.getByTitle("Show the controlled app window"));
    await waitFor(() => {
      expect(api.appControl.focusWindow).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByLabelText("Minimize controlled app window"));
    await waitFor(() => {
      expect(api.appControl.minimizeWindow).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByTitle("Re-capture screenshot and DOM snapshot"));
    expect(await screen.findByText("Snapshot refreshed.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    await waitFor(() => {
      expect(screen.queryByText("Snapshot refreshed.")).toBeNull();
    });

    fireEvent.click(screen.getByText("Inspect"));
    expect(screen.getByText("Inspect mode inserts clicked element context")).toBeTruthy();

    fireEvent.click(screen.getByText("Control"));
    expect(screen.getByText("Click the screenshot to drive the app, or type into the focused element below.")).toBeTruthy();

    const typeInput = screen.getByLabelText("Text to type into the focused app element") as HTMLInputElement;
    fireEvent.change(typeInput, { target: { value: "hello from fixture" } });
    expect(typeInput.value).toBe("hello from fixture");
    expect(api.appControl.typeText).not.toHaveBeenCalled();

    const targetSelect = await screen.findByLabelText("Switch the controlled window") as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: "target-2" } });
    await waitFor(() => {
      expect(api.appControl.attachToTarget).toHaveBeenCalledWith({ targetId: "target-2" });
    });

    const targetRefreshCalls = api.appControl.listTargets.mock.calls.length;
    fireEvent.click(screen.getByTitle("Re-scan controlled app windows"));
    expect(api.appControl.listTargets.mock.calls.length).toBeGreaterThan(targetRefreshCalls);
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

    const targetSelect = await screen.findByLabelText("Switch the controlled window") as HTMLSelectElement;
    expect(targetSelect.disabled).toBe(true);
    expect(screen.queryByLabelText("Stop App Control session")).toBeNull();
    expect((screen.getByTitle("Re-capture screenshot and DOM snapshot") as HTMLButtonElement).disabled).toBe(true);

    const typeInput = screen.getByLabelText("Text to type into the focused app element") as HTMLInputElement;
    fireEvent.change(typeInput, { target: { value: "wrong lane" } });
    expect((screen.getByLabelText("Type into focused app element") as HTMLButtonElement).disabled).toBe(true);

    expect(api.appControl.stop).not.toHaveBeenCalled();
    expect(api.appControl.attachToTarget).not.toHaveBeenCalled();
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

    fireEvent.click(await screen.findByTitle("Re-capture screenshot and DOM snapshot"));
    const image = await screen.findByAltText("Electron app screenshot") as HTMLImageElement;
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

    fireEvent.click(screen.getByText("Inspect"));
    fireEvent.mouseMove(image, { clientX: 15, clientY: 15 });

    await waitFor(() => {
      expect(api.appControl.inspectPoint).toHaveBeenCalledWith({
        projectRoot: "/repo",
        x: 15,
        y: 15,
        coordinateSpace: "viewport",
        includeScreenshot: false,
      });
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
      });
    });
    expect(onAddContext).toHaveBeenCalledWith(expect.objectContaining({
      id: "context-1",
      sourceFile: "src/App.tsx",
    }));
    expect(await screen.findByText("Inserted Run context")).toBeTruthy();

    const selectCallsBeforeReattach = api.appControl.selectPoint.mock.calls.length;
    fireEvent.click(screen.getByText("Re-attach"));

    await waitFor(() => {
      expect(api.appControl.selectPoint.mock.calls.length).toBeGreaterThan(selectCallsBeforeReattach);
    });
  });
});
