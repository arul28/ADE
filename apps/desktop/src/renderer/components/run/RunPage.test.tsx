// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RunPage } from "./RunPage";
import { useAppStore } from "../../state/appStore";
import type { LaneSummary, ProcessRuntime, ProjectInfo } from "../../../shared/types";

const STORAGE_KEY = "ade.run.laneRuntimeBarOpen";
type EventHandler = (event: unknown) => void;
type VitestMock = ReturnType<typeof vi.fn>;
type RuntimeBarAdeStub = {
  lanes: {
    diagnosticsRunHealthCheck: VitestMock;
    proxyGetPreviewInfo: VitestMock;
    portGetLease: VitestMock;
    proxyGetStatus: VitestMock;
    oauthGetStatus: VitestMock;
    oauthGenerateRedirectUris: VitestMock;
  };
  processes: {
    listRuntime: VitestMock;
  };
};

const mocks = vi.hoisted(() => ({
  laneBarSpy: vi.fn(),
}));

vi.mock("./LaneRuntimeBar", () => {
  const ReactMod = require("react") as typeof import("react");
  return {
    LaneRuntimeBar: (props: { laneId: string | null }) => {
      mocks.laneBarSpy(props);
      return ReactMod.createElement("div", { "data-testid": "lane-runtime-bar-mock" }, "bar");
    },
  };
});

vi.mock("../terminals/TerminalView", () => {
  const ReactMod = require("react") as typeof import("react");
  return {
    TerminalView: (props: { sessionId: string; ptyId: string }) =>
      ReactMod.createElement("div", { "data-testid": "terminal-view" }, `${props.sessionId}:${props.ptyId}`),
  };
});

const laneStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false };

const stubLane: LaneSummary = {
  id: "lane-a",
  name: "Primary lane",
  laneType: "primary",
  baseRef: "main",
  branchRef: "main",
  worktreePath: "/tmp/wt",
  parentLaneId: null,
  childCount: 0,
  stackDepth: 0,
  parentStatus: null,
  isEditProtected: false,
  status: laneStatus,
  color: null,
  icon: null,
  tags: [],
  createdAt: "2020-01-01T00:00:00.000Z",
};

const stubProject: ProjectInfo = {
  rootPath: "/tmp/ade-run-test",
  displayName: "Run test",
  baseRef: "main",
};

const baseRuntime: ProcessRuntime = {
  runId: "run-1",
  laneId: "lane-a",
  processId: "proc-1",
  status: "running",
  readiness: "unknown",
  pid: 1234,
  sessionId: null,
  ptyId: null,
  startedAt: "2026-05-13T00:00:00.000Z",
  endedAt: null,
  exitCode: null,
  lastExitCode: null,
  lastEndedAt: null,
  uptimeMs: 1_000,
  ports: [3000],
  logPath: null,
  updatedAt: "2026-05-13T00:00:01.000Z",
};

function installAdeStub() {
  const handlers: {
    process?: EventHandler;
    proxy?: EventHandler;
    port?: EventHandler;
    diagnostics?: EventHandler;
  } = {};
  const emptyConfig = {
    effective: { processGroups: [] },
    shared: { processGroups: [], processes: [] },
    local: { processGroups: [], processes: [] },
  };
  (globalThis.window as unknown as { ade: Record<string, unknown> }).ade = {
    projectConfig: {
      get: vi.fn().mockResolvedValue(emptyConfig),
      save: vi.fn().mockResolvedValue(undefined),
      confirmTrust: vi.fn().mockResolvedValue(undefined),
    },
    lanes: {
      diagnosticsGetLaneHealth: vi.fn().mockResolvedValue({
        laneId: "lane-a",
        status: "unknown",
        issues: [],
        respondingPort: null,
        portResponding: null,
      }),
      diagnosticsRunHealthCheck: vi.fn().mockResolvedValue({
        laneId: "lane-a",
        status: "healthy",
        issues: [],
        respondingPort: 3000,
        portResponding: true,
      }),
      proxyGetPreviewInfo: vi.fn().mockResolvedValue({
        laneId: "lane-a",
        previewUrl: "http://lane-a.localhost:5174",
        hostname: "lane-a.localhost",
        proxyPort: 5174,
        targetPort: 3000,
        active: true,
      }),
      portGetLease: vi.fn().mockResolvedValue({
        laneId: "lane-a",
        status: "active",
        rangeStart: 3000,
        rangeEnd: 3099,
      }),
      proxyGetStatus: vi.fn().mockResolvedValue({ running: true, proxyPort: 5174 }),
      oauthGetStatus: vi.fn().mockResolvedValue({ enabled: true }),
      oauthGenerateRedirectUris: vi.fn().mockResolvedValue([
        {
          provider: "google",
          uris: ["http://localhost:5174/oauth/callback"],
        },
      ]),
      onDiagnosticsEvent: vi.fn((handler: EventHandler) => {
        handlers.diagnostics = handler;
        return vi.fn();
      }),
      onProxyEvent: vi.fn((handler: EventHandler) => {
        handlers.proxy = handler;
        return vi.fn();
      }),
      onPortEvent: vi.fn((handler: EventHandler) => {
        handlers.port = handler;
        return vi.fn();
      }),
    },
    processes: {
      listDefinitions: vi.fn().mockResolvedValue([]),
      listRuntime: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn((handler: EventHandler) => {
        handlers.process = handler;
        return vi.fn();
      }),
      start: vi.fn(),
      stop: vi.fn(),
      kill: vi.fn(),
      startGroup: vi.fn(),
      stopGroup: vi.fn(),
    },
    pty: {
      create: vi.fn().mockResolvedValue({ sessionId: "terminal-new", ptyId: "pty-new", pid: 1234 }),
      dispose: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn(() => vi.fn()),
    },
    project: {
      listRecent: vi.fn().mockResolvedValue([]),
      resolveIcon: vi.fn().mockResolvedValue({ dataUrl: null, sourcePath: null, mimeType: null }),
      forgetRecent: vi.fn().mockResolvedValue([]),
      setRecentPinned: vi.fn().mockResolvedValue([]),
    },
    remoteRuntime: {
      getConnectionSnapshot: vi.fn().mockResolvedValue({
        connections: [],
        connectedCount: 0,
        updatedAt: Date.now(),
      }),
      onConnectionSnapshotChanged: vi.fn(() => vi.fn()),
      connect: vi.fn().mockResolvedValue(undefined),
    },
    app: {
      writeClipboardText: vi.fn(),
    },
  };
  return { handlers };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advanceTimers(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
  await flushPromises();
}

function getRuntimeBarAdeStub(): RuntimeBarAdeStub {
  return (window as unknown as { ade: RuntimeBarAdeStub }).ade;
}

function testLocalStorage(): Storage {
  try {
    if (window.localStorage) return window.localStorage;
  } catch {
    // Fall through to the in-memory test storage below.
  }
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } satisfies Storage;
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
  return storage;
}

let originalAde: unknown;

beforeEach(() => {
  originalAde = (globalThis.window as unknown as { ade?: unknown }).ade;
  installAdeStub();
  const storage = testLocalStorage();
  storage.removeItem("ade.runPageLaneSelections.v1");
  storage.removeItem(STORAGE_KEY);
  useAppStore.setState({
    showWelcome: false,
    project: stubProject,
    lanes: [stubLane],
  });
  mocks.laneBarSpy.mockClear();
});

afterEach(() => {
  cleanup();
  (globalThis.window as unknown as { ade?: unknown }).ade = originalAde as typeof window.ade;
});

describe("RunPage Advanced lane runtime drawer", () => {
  it("renders saved project icons in the recent projects list", async () => {
    const ade = (window as unknown as {
      ade: {
        project: {
          listRecent: ReturnType<typeof vi.fn>;
          resolveIcon: ReturnType<typeof vi.fn>;
        };
      };
    }).ade;
    ade.project.listRecent.mockResolvedValueOnce([
      {
        rootPath: "/tmp/icon-project",
        displayName: "Icon project",
        exists: true,
        lastOpenedAt: "2026-05-08T00:00:00.000Z",
        laneCount: 1,
      },
    ]);
    ade.project.resolveIcon.mockResolvedValueOnce({
      dataUrl: "data:image/png;base64,icon",
      sourcePath: "/tmp/icon-project/.ade/icon.png",
      mimeType: "image/png",
    });
    useAppStore.setState({ showWelcome: true, project: null });

    const { container } = render(
      <MemoryRouter>
        <RunPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Icon project")).toBeTruthy();
    await waitFor(() => {
      expect(ade.project.resolveIcon).toHaveBeenCalledWith("/tmp/icon-project");
      expect(container.querySelector('img[src="data:image/png;base64,icon"]')).toBeTruthy();
    });
  });

  it("renders remote project icons in the recent projects list", async () => {
    const ade = (window as unknown as {
      ade: {
        project: {
          listRecent: ReturnType<typeof vi.fn>;
          resolveIcon: ReturnType<typeof vi.fn>;
        };
        remoteRuntime: {
          getConnectionSnapshot: ReturnType<typeof vi.fn>;
        };
      };
    }).ade;
    ade.project.listRecent.mockResolvedValueOnce([
      {
        rootPath: "/srv/ade/remote-app",
        displayName: "Remote App",
        exists: true,
        lastOpenedAt: "2026-05-08T00:00:00.000Z",
        kind: "remote",
        remote: {
          targetId: "studio",
          projectId: "remote-app",
          runtimeName: "Mac Studio",
          hostname: "studio.local",
          iconDataUrl: "data:image/png;base64,remote-icon",
        },
      },
    ]);
    ade.remoteRuntime.getConnectionSnapshot.mockResolvedValueOnce({
      connections: [
        {
          target: { id: "studio", name: "Mac Studio" },
          state: "connected",
        },
      ],
      connectedCount: 1,
      updatedAt: Date.now(),
    });
    useAppStore.setState({ showWelcome: true, project: null });

    const { container } = render(
      <MemoryRouter>
        <RunPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Remote App")).toBeTruthy();
    expect(
      container.querySelector('img[src="data:image/png;base64,remote-icon"]'),
    ).toBeTruthy();
    expect(ade.project.resolveIcon).not.toHaveBeenCalled();
  });

  it("shows only reconnecting copy on the right side while a remote recent reconnects", async () => {
    const ade = (window as unknown as {
      ade: {
        project: {
          listRecent: ReturnType<typeof vi.fn>;
        };
        remoteRuntime: {
          getConnectionSnapshot: ReturnType<typeof vi.fn>;
        };
      };
    }).ade;
    ade.project.listRecent.mockResolvedValueOnce([
      {
        rootPath: "/srv/ade/remote-app",
        displayName: "Remote App",
        exists: true,
        lastOpenedAt: new Date().toISOString(),
        kind: "remote",
        pinned: true,
        remote: {
          targetId: "studio",
          projectId: "remote-app",
          runtimeName: "Mac Studio",
          hostname: "studio.local",
        },
      },
    ]);
    ade.remoteRuntime.getConnectionSnapshot.mockResolvedValueOnce({
      connections: [
        {
          target: { id: "studio", name: "Mac Studio" },
          state: "connecting",
        },
      ],
      connectedCount: 0,
      updatedAt: Date.now(),
    });
    useAppStore.setState({ showWelcome: true, project: null });

    render(
      <MemoryRouter>
        <RunPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Reconnecting")).toBeTruthy();
    expect(screen.queryByLabelText("Unpin Remote App")).toBeNull();
    expect(screen.queryByLabelText("Remove Remote App from recents")).toBeNull();
    expect(screen.queryByText("active just now")).toBeNull();
  });

  it("keeps LaneRuntimeBar collapsed by default with aria-expanded on the toggle", async () => {
    render(<RunPage />);
    const toggle = screen.getByRole("button", { name: /^advanced$/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("run-lane-runtime-panel");
    expect(screen.queryByTestId("lane-runtime-bar-mock")).toBeNull();

    await waitFor(() => {
      expect(vi.mocked((window as unknown as { ade: { projectConfig: { get: ReturnType<typeof vi.fn> } } }).ade.projectConfig.get)).toHaveBeenCalled();
    });

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByTestId("lane-runtime-bar-mock")).toBeTruthy();
    expect(mocks.laneBarSpy).toHaveBeenCalledWith(expect.objectContaining({ laneId: "lane-a" }));
    expect(testLocalStorage().getItem(STORAGE_KEY)).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(testLocalStorage().getItem(STORAGE_KEY)).toBe("false");
  });

  it("restores open state from localStorage on first mount", async () => {
    testLocalStorage().setItem(STORAGE_KEY, "true");
    render(<RunPage />);
    const toggle = screen.getByRole("button", { name: /^advanced$/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(mocks.laneBarSpy).toHaveBeenCalled());
  });

  it("uses the shared terminal drawer when opening a run shell", async () => {
    render(<RunPage />);
    fireEvent.click(screen.getByRole("button", { name: /new shell/i }));

    await waitFor(() => {
      expect(vi.mocked((window as unknown as { ade: { pty: { create: ReturnType<typeof vi.fn> } } }).ade.pty.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-a",
          toolType: "shell",
          tracked: true,
        }),
      );
    });
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("terminal-new:pty-new");
  });

  it("opens the terminal drawer without creating a shell from the plain toggle", async () => {
    render(<RunPage />);
    fireEvent.click(screen.getByRole("button", { name: /open terminal/i }));

    expect(await screen.findByText("Open a shell or run a command to attach a terminal.")).toBeTruthy();
    expect(vi.mocked((window as unknown as { ade: { pty: { create: ReturnType<typeof vi.fn> } } }).ade.pty.create)).not.toHaveBeenCalled();
  });

  it("surfaces shell creation failures from the shared terminal drawer", async () => {
    const create = vi.mocked((window as unknown as { ade: { pty: { create: ReturnType<typeof vi.fn> } } }).ade.pty.create);
    create.mockRejectedValueOnce(new Error("missing shell"));

    render(<RunPage />);
    fireEvent.click(screen.getByRole("button", { name: /new shell/i }));

    expect(await screen.findByText("missing shell")).toBeTruthy();
  });

  it("disposes run shell terminals when RunPage unmounts", async () => {
    const { unmount } = render(<RunPage />);
    fireEvent.click(screen.getByRole("button", { name: /new shell/i }));
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("terminal-new:pty-new");

    unmount();

    expect(vi.mocked((window as unknown as { ade: { pty: { dispose: ReturnType<typeof vi.fn> } } }).ade.pty.dispose)).toHaveBeenCalledWith({
      ptyId: "pty-new",
      sessionId: "terminal-new",
    });
  });

  it("reveals a run command terminal returned by the process service", async () => {
    const definition = {
      id: "proc-1",
      name: "Dev server",
      command: ["npm", "run", "dev"],
      cwd: ".",
      env: {},
      groupIds: [],
      autostart: false,
      restart: "never",
      gracefulShutdownMs: 7000,
      dependsOn: [],
      readiness: { type: "none" as const },
    };
    const runtime = {
      runId: "run-1",
      laneId: "lane-a",
      processId: "proc-1",
      status: "running" as const,
      readiness: "unknown" as const,
      pid: 4321,
      sessionId: "terminal-run",
      ptyId: "pty-run",
      startedAt: "2026-04-30T12:00:00.000Z",
      endedAt: null,
      exitCode: null,
      lastExitCode: null,
      lastEndedAt: null,
      uptimeMs: 0,
      ports: [],
      logPath: null,
      updatedAt: "2026-04-30T12:00:00.000Z",
    };
    const ade = (window as unknown as { ade: {
      projectConfig: { get: ReturnType<typeof vi.fn> };
      processes: { listDefinitions: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
    } }).ade;
    ade.projectConfig.get.mockResolvedValue({
      effective: { processGroups: [] },
      shared: { processGroups: [], processes: [definition] },
      local: { processGroups: [], processes: [] },
    });
    ade.processes.listDefinitions.mockResolvedValue([definition]);
    ade.processes.start.mockResolvedValue(runtime);

    render(<RunPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Run$/i }));

    await waitFor(() => {
      expect(ade.processes.start).toHaveBeenCalledWith({ laneId: "lane-a", processId: "proc-1" });
    });
    expect((await screen.findByTestId("terminal-view")).textContent).toBe("terminal-run:pty-run");
  });

  it("reveals and selects a terminal started from a group run event", async () => {
    const { handlers } = installAdeStub();
    const group = { id: "group-dev", name: "Dev" };
    const definitions = [
      {
        id: "proc-1",
        name: "API",
        command: ["npm", "run", "api"],
        cwd: ".",
        env: {},
        groupIds: [group.id],
        autostart: false,
        restart: "never",
        gracefulShutdownMs: 7000,
        dependsOn: [],
        readiness: { type: "none" as const },
      },
      {
        id: "proc-2",
        name: "Web",
        command: ["npm", "run", "web"],
        cwd: ".",
        env: {},
        groupIds: [group.id],
        autostart: false,
        restart: "never",
        gracefulShutdownMs: 7000,
        dependsOn: [],
        readiness: { type: "none" as const },
      },
    ];
    const ade = (window as unknown as { ade: {
      projectConfig: { get: ReturnType<typeof vi.fn> };
      processes: { listDefinitions: ReturnType<typeof vi.fn>; startGroup: ReturnType<typeof vi.fn> };
    } }).ade;
    ade.projectConfig.get.mockResolvedValue({
      effective: { processGroups: [group] },
      shared: { processGroups: [group], processes: definitions },
      local: { processGroups: [], processes: [] },
    });
    ade.processes.listDefinitions.mockResolvedValue(definitions);
    ade.processes.startGroup.mockResolvedValue(undefined);

    render(<RunPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Dev\s*2/i }));
    fireEvent.click(screen.getByRole("button", { name: /run all/i }));

    await waitFor(() => {
      expect(ade.processes.startGroup).toHaveBeenCalledWith({
        groupId: "group-dev",
        laneByProcessId: { "proc-1": "lane-a", "proc-2": "lane-a" },
      });
    });

    await act(async () => {
      handlers.process?.({
        type: "runtime",
        runtime: {
          ...baseRuntime,
          runId: "run-2",
          processId: "proc-2",
          sessionId: "terminal-group",
          ptyId: "pty-group",
        },
      });
    });

    expect((await screen.findByTestId("terminal-view")).textContent).toBe("terminal-group:pty-group");
  });

  it("keeps the project root cwd when saving a new command", async () => {
    const ade = (window as unknown as {
      ade: {
        projectConfig: {
          get: ReturnType<typeof vi.fn>;
          save: ReturnType<typeof vi.fn>;
        };
      };
    }).ade;

    render(<RunPage />);
    await waitFor(() => expect(ade.projectConfig.get).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: /^add command$/i })[0]!);
    fireEvent.change(await screen.findByPlaceholderText("e.g. Dev server"), { target: { value: "Docs" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. npm run dev"), { target: { value: "npm run docs" } });

    const submitButton = within(document.body).getAllByRole("button", { name: /^add command$/i }).at(-1);
    expect(submitButton).toBeTruthy();
    await waitFor(() => expect((submitButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submitButton!);

    await waitFor(() => {
      expect(ade.projectConfig.save).toHaveBeenCalledWith(
        expect.objectContaining({
          shared: expect.objectContaining({
            processes: [
              expect.objectContaining({
                name: "Docs",
                command: ["npm", "run", "docs"],
                cwd: ".",
              }),
            ],
          }),
        }),
      );
    });
  });
});

describe("LaneRuntimeBar refresh behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes health after runtime events without rereading the routing snapshot", async () => {
    const { LaneRuntimeBar } = await vi.importActual<typeof import("./LaneRuntimeBar")>("./LaneRuntimeBar");
    const { handlers } = installAdeStub();
    const ade = getRuntimeBarAdeStub();
    render(<LaneRuntimeBar laneId="lane-a" />);

    await flushPromises();
    expect(ade.lanes.proxyGetPreviewInfo).toHaveBeenCalledTimes(1);
    await advanceTimers(200);
    expect(ade.lanes.diagnosticsRunHealthCheck).toHaveBeenCalledTimes(1);

    ade.lanes.proxyGetPreviewInfo.mockClear();
    ade.lanes.portGetLease.mockClear();
    ade.lanes.proxyGetStatus.mockClear();
    ade.lanes.oauthGetStatus.mockClear();
    ade.lanes.oauthGenerateRedirectUris.mockClear();
    ade.lanes.diagnosticsRunHealthCheck.mockClear();
    ade.processes.listRuntime.mockClear();

    await act(async () => {
      handlers.process?.({ type: "runtime", runtime: baseRuntime });
    });
    await advanceTimers(200);

    expect(ade.lanes.diagnosticsRunHealthCheck).toHaveBeenCalledTimes(1);
    expect(ade.processes.listRuntime).toHaveBeenCalledTimes(1);
    expect(ade.lanes.proxyGetPreviewInfo).not.toHaveBeenCalled();
    expect(ade.lanes.portGetLease).not.toHaveBeenCalled();
    expect(ade.lanes.proxyGetStatus).not.toHaveBeenCalled();
    expect(ade.lanes.oauthGetStatus).not.toHaveBeenCalled();
    expect(ade.lanes.oauthGenerateRedirectUris).not.toHaveBeenCalled();
  });

  it("keeps routing refreshes event-driven between slower safety polls", async () => {
    const { LaneRuntimeBar } = await vi.importActual<typeof import("./LaneRuntimeBar")>("./LaneRuntimeBar");
    const { handlers } = installAdeStub();
    const ade = getRuntimeBarAdeStub();
    render(<LaneRuntimeBar laneId="lane-a" />);

    await flushPromises();
    expect(ade.lanes.proxyGetPreviewInfo).toHaveBeenCalledTimes(1);
    await advanceTimers(200);

    ade.lanes.proxyGetPreviewInfo.mockClear();
    ade.lanes.portGetLease.mockClear();
    ade.lanes.proxyGetStatus.mockClear();

    await advanceTimers(10_000);
    expect(ade.lanes.proxyGetPreviewInfo).not.toHaveBeenCalled();
    expect(ade.lanes.portGetLease).not.toHaveBeenCalled();
    expect(ade.lanes.proxyGetStatus).not.toHaveBeenCalled();

    await act(async () => {
      handlers.proxy?.({ type: "proxy-started" });
    });
    await advanceTimers(100);

    expect(ade.lanes.proxyGetPreviewInfo).toHaveBeenCalledTimes(1);
    expect(ade.lanes.portGetLease).toHaveBeenCalledTimes(1);
    expect(ade.lanes.proxyGetStatus).toHaveBeenCalledTimes(1);
  });
});
