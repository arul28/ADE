/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RequireProject } from "./App";
import { useAppStore } from "../../state/appStore";

function resetStore() {
  useAppStore.setState({
    project: null,
    projectHydrated: false,
    showWelcome: true,
    lanes: [],
    selectedLaneId: null,
    runLaneId: null,
    focusedSessionId: null,
    laneInspectorTabs: {},
    terminalAttention: {
      runningCount: 0,
      activeCount: 0,
      needsAttentionCount: 0,
      indicator: "none",
      byLaneId: {},
    },
    workViewByProject: {},
    laneWorkViewByScope: {},
  });
}

describe("RequireProject", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  it("waits for project hydration instead of redirecting settings immediately", () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route
            path="/settings"
            element={(
              <RequireProject>
                <div>Settings content</div>
              </RequireProject>
            )}
          />
          <Route path="/project" element={<div>Run page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Loading...")).toBeTruthy();
    expect(screen.queryByText("Run page")).toBeNull();
  });

  it("redirects to run after hydration when there is no active project", () => {
    useAppStore.getState().setProjectHydrated(true);

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route
            path="/settings"
            element={(
              <RequireProject>
                <div>Settings content</div>
              </RequireProject>
            )}
          />
          <Route path="/project" element={<div>Run page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Run page")).toBeTruthy();
    expect(screen.queryByText("Settings content")).toBeNull();
  });
});
