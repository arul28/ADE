/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TabNav } from "./TabNav";
import { useAppStore } from "../../state/appStore";

function resetStore() {
  useAppStore.setState({
    project: { rootPath: "/Users/arul/ADE", name: "ADE" } as any,
    projectBinding: null,
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
    vi.useRealTimers();
    cleanup();
    Object.defineProperty(globalThis.window, "ade", {
      configurable: true,
      writable: true,
      value: originalAde,
    });
  });

  it("links the sidebar account avatar to the account page", () => {
    render(
      <MemoryRouter initialEntries={["/work"]}>
        <TabNav githubStatus={{ userLogin: "arul28" } as any} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "ADE account — signed out" }).getAttribute("href")).toBe(
      "/account",
    );
    expect(screen.getByText("Signed out")).toBeTruthy();
  });

  it("keeps Chats available and active without a project", () => {
    useAppStore.setState({ project: null, showWelcome: true } as any);

    render(
      <MemoryRouter initialEntries={["/chats"]}>
        <TabNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Chats" }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("link", { name: "Work" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps Activity a header control and a modal, never a nav tab", () => {
    useAppStore.setState({
      project: null,
      projectBinding: null,
      showWelcome: true,
    } as any);

    render(
      <MemoryRouter initialEntries={["/chats"]}>
        <TabNav />
      </MemoryRouter>,
    );

    // Deliberate: deleting this assertion is the quiet path to a tenth tab
    // nobody agreed to. Activity lives in the header and opens as a modal.
    expect(screen.queryByRole("link", { name: "Activity" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Activity" })).toBeNull();
  });
});
