/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TabNav } from "./TabNav";
import { useAppStore } from "../../state/appStore";

function resetStore() {
  useAppStore.setState({
    project: { rootPath: "/Users/arul/ADE", name: "ADE" } as any,
    projectHydrated: true,
    showWelcome: false,
    selectedLaneId: "lane-1",
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
    Object.defineProperty(globalThis.window, "ade", {
      configurable: true,
      writable: true,
      value: {
        app: {
          revealPath: async () => undefined,
          getInfo: async () => ({ isPackaged: false }) as any,
          openExternal: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis.window, "ade", {
      configurable: true,
      writable: true,
      value: originalAde,
    });
  });

  it("places Review directly below Run in the sidebar", () => {
    render(
      <MemoryRouter initialEntries={["/work"]}>
        <TabNav />
      </MemoryRouter>,
    );

    const run = screen.getByRole("link", { name: "Run" });
    const review = screen.getByRole("link", { name: "Review" });
    const links = screen.getAllByRole("link");
    expect(links[links.indexOf(run) + 1]).toBe(review);
  });

  it("opens the connected GitHub profile from the sidebar avatar", () => {
    render(
      <MemoryRouter initialEntries={["/work"]}>
        <TabNav githubStatus={{ userLogin: "arul28" } as any} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open GitHub profile for arul28" }));

    expect(globalThis.window.ade.app.openExternal).toHaveBeenCalledWith("https://github.com/arul28");
  });
});
