// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RunPage } from "./RunPage";
import { useAppStore } from "../../state/appStore";
import type { LaneSummary, ProjectInfo } from "../../../shared/types";

const STORAGE_KEY = "ade.run.laneRuntimeBarOpen";

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

function installAdeStub() {
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
    processes: {
      listDefinitions: vi.fn().mockResolvedValue([]),
      listRuntime: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn(() => vi.fn()),
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
    },
  };
}

let originalAde: unknown;

beforeEach(() => {
  originalAde = (globalThis.window as unknown as { ade?: unknown }).ade;
  installAdeStub();
  localStorage.removeItem("ade.runPageLaneSelections.v1");
  localStorage.removeItem(STORAGE_KEY);
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
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
  });

  it("restores open state from localStorage on first mount", async () => {
    localStorage.setItem(STORAGE_KEY, "true");
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
});
