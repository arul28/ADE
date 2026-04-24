/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TabNav } from "./TabNav";
import { useAppStore } from "../../state/appStore";

function resetStore() {
  useAppStore.setState({
    project: { rootPath: "/Users/arul/ADE", name: "ADE" } as any,
    projectHydrated: true,
    showWelcome: false,
    selectedLaneId: "lane-1",
    runLaneId: null,
    focusedSessionId: null,
    lanes: [],
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

describe("TabNav", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    resetStore();
    globalThis.window.ade = {
      app: {
        revealPath: async () => undefined,
        getInfo: async () => ({ isPackaged: false }) as any,
      },
    } as any;
  });

  afterEach(() => {
    globalThis.window.ade = originalAde;
  });

  it("places Review directly below PRs in the sidebar", () => {
    render(
      <MemoryRouter initialEntries={["/work"]}>
        <TabNav />
      </MemoryRouter>,
    );

    const prs = screen.getByRole("link", { name: "PRs" });
    const review = screen.getByRole("link", { name: "Review" });
    expect(prs.nextElementSibling).toBe(review);
  });
});

