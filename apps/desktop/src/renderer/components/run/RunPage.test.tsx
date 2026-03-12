// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunPage } from "./RunPage";

let mockStoreState: {
  lanes: Array<{ id: string; name: string }>;
  selectedLaneId: string | null;
  runLaneId: string | null;
  showWelcome: boolean;
  selectRunLane: ReturnType<typeof vi.fn>;
  openRepo: ReturnType<typeof vi.fn>;
  switchProjectToPath: ReturnType<typeof vi.fn>;
};

vi.mock("../../state/appStore", () => ({
  useAppStore: (
    selector: (state: {
      lanes: Array<{ id: string; name: string }>;
      selectedLaneId: string | null;
      runLaneId: string | null;
      showWelcome: boolean;
      selectRunLane: ReturnType<typeof vi.fn>;
      openRepo: ReturnType<typeof vi.fn>;
      switchProjectToPath: ReturnType<typeof vi.fn>;
    }) => unknown
  ) => selector(mockStoreState),
}));

vi.mock("./RunSidebar", () => ({
  RunSidebar: () => <div data-testid="run-sidebar" />,
}));

vi.mock("./ProcessMonitor", () => ({
  ProcessMonitor: () => <div data-testid="process-monitor" />,
}));

vi.mock("./LaneRuntimeBar", () => ({
  LaneRuntimeBar: () => <div data-testid="lane-runtime-bar" />,
}));

vi.mock("./AiScanPanel", () => ({
  AiScanPanel: () => null,
}));

function makeSnapshot(processes: Array<{ id: string; name: string; command: string[]; cwd?: string }> = []) {
  return {
    shared: {
      processes,
      stackButtons: [],
    },
    local: {},
    effective: {
      stackButtons: [],
    },
  };
}

function installAdeMocks(args: {
  snapshot?: ReturnType<typeof makeSnapshot>;
  definitions?: Array<{ id: string; name: string; command: string[]; cwd?: string }>;
  runtime?: Array<{ processId: string; laneId: string; status: string; ports: number[] }>;
}) {
  const snapshot = args.snapshot ?? makeSnapshot();
  const definitions = args.definitions ?? [];
  const runtime = args.runtime ?? [];

  const projectConfigGet = vi.fn(async () => snapshot as any);
  const projectConfigSave = vi.fn<[
    config: { shared: { processes: Array<{ command: string[] }> } }
  ], Promise<void>>(async () => undefined);
  const listDefinitions = vi.fn(async () => definitions as any);
  const listRuntime = vi.fn(async () =>
    runtime.map((entry) => ({
      readiness: "unknown",
      pid: null,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      lastExitCode: null,
      lastEndedAt: null,
      uptimeMs: null,
      updatedAt: "2026-03-12T00:00:00.000Z",
      ...entry,
    })) as any
  );
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const kill = vi.fn(async () => undefined);
  const startStack = vi.fn(async () => undefined);
  const stopStack = vi.fn(async () => undefined);
  const startAll = vi.fn(async () => undefined);
  const stopAll = vi.fn(async () => undefined);
  const onEvent = vi.fn(() => () => undefined);
  const ptyCreate = vi.fn<[args: Record<string, unknown>], Promise<{ ptyId: string; sessionId: string }>>(
    async () => ({ ptyId: "pty-1", sessionId: "session-1" })
  );

  (window as any).ade = {
    projectConfig: {
      get: projectConfigGet,
      save: projectConfigSave,
    },
    processes: {
      listDefinitions,
      listRuntime,
      start,
      stop,
      kill,
      startStack,
      stopStack,
      startAll,
      stopAll,
      onEvent,
    },
    pty: {
      create: ptyCreate,
    },
  };

  return {
    projectConfigGet,
    projectConfigSave,
    listDefinitions,
    listRuntime,
    start,
    stop,
    kill,
    startStack,
    stopStack,
    startAll,
    stopAll,
    onEvent,
    ptyCreate,
  };
}

function getDialogAddButton(): HTMLButtonElement {
  const submit = screen
    .getAllByRole("button", { name: /^add$/i })
    .find((button) => button.getAttribute("type") === "submit");
  if (!(submit instanceof HTMLButtonElement)) {
    throw new Error("Add dialog submit button not found");
  }
  return submit;
}

describe("RunPage", () => {
  beforeEach(() => {
    mockStoreState = {
      lanes: [{ id: "lane-1", name: "Lane 1" }],
      selectedLaneId: "lane-1",
      runLaneId: "lane-1",
      showWelcome: false,
      selectRunLane: vi.fn(),
      openRepo: vi.fn(),
      switchProjectToPath: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
    vi.restoreAllMocks();
  });

  it("formats argv previews with quotes and does not replay the process command in a PTY", async () => {
    const command = ["pnpm", "--filter", "web app", "dev"];
    const bridge = installAdeMocks({
      snapshot: makeSnapshot([{ id: "proc-1", name: "Web", command }]),
      definitions: [{ id: "proc-1", name: "Web", command }],
    });

    render(<RunPage />);

    expect(await screen.findByText("Web")).toBeTruthy();
    expect(screen.getByText('pnpm --filter "web app" dev')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => expect(bridge.start).toHaveBeenCalledWith({ laneId: "lane-1", processId: "proc-1" }));
    await waitFor(() => expect(bridge.ptyCreate).toHaveBeenCalledTimes(1));
    expect(bridge.ptyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        title: "Web",
        tracked: true,
      })
    );
    const ptyCreateArgs = bridge.ptyCreate.mock.calls[0]?.[0];
    expect(ptyCreateArgs).toBeDefined();
    if (!ptyCreateArgs) {
      throw new Error("PTY create args not captured");
    }
    expect(ptyCreateArgs).not.toHaveProperty("startupCommand");
  });

  it("parses quoted command input into argv when adding a process", async () => {
    const bridge = installAdeMocks({
      snapshot: makeSnapshot(),
      definitions: [],
    });

    render(<RunPage />);

    fireEvent.click(await screen.findByRole("button", { name: /add/i }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Dev Server"), { target: { value: "Web" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. npx sst dev"), {
      target: { value: 'pnpm --filter "web app" dev' },
    });
    fireEvent.click(getDialogAddButton());

    await waitFor(() => expect(bridge.projectConfigSave).toHaveBeenCalledTimes(1));
    const savedConfig = bridge.projectConfigSave.mock.calls[0]?.[0];
    expect(savedConfig).toBeDefined();
    if (!savedConfig) {
      throw new Error("Saved config not captured");
    }
    expect(savedConfig.shared.processes).toHaveLength(1);
    expect(savedConfig.shared.processes[0].command).toEqual(["pnpm", "--filter", "web app", "dev"]);
  });

  it("keeps the dialog open and blocks save when the command has an unclosed quote", async () => {
    const bridge = installAdeMocks({
      snapshot: makeSnapshot(),
      definitions: [],
    });

    render(<RunPage />);

    fireEvent.click(await screen.findByRole("button", { name: /add/i }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Dev Server"), { target: { value: "Broken" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. npx sst dev"), {
      target: { value: 'pnpm --filter "web app dev' },
    });

    expect(screen.getByText(/unclosed quote/i)).toBeTruthy();
    const submit = getDialogAddButton();
    expect(submit.disabled).toBe(true);

    fireEvent.click(submit);

    await waitFor(() => expect(bridge.projectConfigSave).not.toHaveBeenCalled());
    expect(screen.getByPlaceholderText("e.g. npx sst dev")).toBeTruthy();
  });
});
