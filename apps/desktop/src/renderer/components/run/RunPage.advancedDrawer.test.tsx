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
      create: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
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
});
