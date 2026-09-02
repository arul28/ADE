/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TabNav } from "./TabNav";
import { useAppStore } from "../../state/appStore";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";

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
    },
    workViewByProject: {},
    laneWorkViewByScope: {},
    smartTooltipsEnabled: true,
  });
}

describe("TabNav", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    resetStore();
    window.localStorage.clear();
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
    resetBuiltinSurfacePlugins();
    window.localStorage.clear();
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
    // Compiled Review is on the rail by default (supersedes). Graph is not.

    render(
      <MemoryRouter initialEntries={["/chats"]}>
        <TabNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Chats" }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("link", { name: "Work" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("leaves enabling plugin tabs out of the rail on a machine with no plugins", () => {
    // Graph and iOS stay hidden until their plugins land. Review and History
    // are compiled tabs ADE already ships, so a fresh install still has them.
    render(
      <MemoryRouter initialEntries={["/work"]}>
        <TabNav />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link", { name: "Graph" })).toBeNull();
    expect(screen.getByRole("link", { name: "Review" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "History" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Work" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "PRs" })).toBeTruthy();
  });

  it("puts a tab in the rail once its own plugin is installed, and only that one", () => {
    seedBuiltinSurfacePlugins(["graph"]);

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <TabNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Graph" })).toBeTruthy();
    // No second entry for the plugin itself: it has no panel of its own, and a
    // duplicate row opening an empty page would wear the feature's name.
    expect(screen.getAllByRole("link", { name: "Graph" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Review" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "History" })).toBeTruthy();
  });

  it("places sidebar tooltips beside navigation rows", () => {
    useAppStore.setState({ smartTooltipsEnabled: true });
    vi.useFakeTimers();

    render(
      <MemoryRouter initialEntries={["/chats"]}>
        <TabNav />
      </MemoryRouter>,
    );

    const chatsLink = screen.getByRole("link", { name: "Chats" });
    const wrapper = chatsLink.parentElement;
    if (!(wrapper instanceof HTMLElement)) throw new Error("sidebar tooltip wrapper is missing");
    fireEvent.mouseEnter(wrapper);
    act(() => vi.advanceTimersByTime(320));

    expect(document.querySelector('.ade-smart-tooltip[data-side="right"]')).toBeTruthy();
  });

  it("does not steal Tab from sidebar rows that have documentation links", () => {
    useAppStore.setState({ smartTooltipsEnabled: true });
    vi.useFakeTimers();

    render(
      <MemoryRouter initialEntries={["/chats"]}>
        <TabNav />
      </MemoryRouter>,
    );

    const workLink = screen.getByRole("link", { name: "Work" });
    const wrapper = workLink.parentElement;
    if (!(wrapper instanceof HTMLElement)) throw new Error("sidebar tooltip wrapper is missing");
    fireEvent.mouseEnter(wrapper);
    act(() => vi.advanceTimersByTime(320));

    const tooltip = document.querySelector(".ade-smart-tooltip");
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(workLink.getAttribute("aria-haspopup")).toBeNull();
    expect(fireEvent.keyDown(wrapper, { key: "Tab" })).toBe(true);
  });

  it("falls back to a native title when detailed tooltips are disabled", () => {
    useAppStore.setState({ smartTooltipsEnabled: false });

    render(
      <MemoryRouter initialEntries={["/chats"]}>
        <TabNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Chats" }).getAttribute("title")).toBe("Chats");
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

  it("reopens the active project's last settings location", () => {
    window.localStorage.setItem(
      "ade:project-route:local:/Users/arul/ADE",
      "/settings?tab=appearance#chat-launch-clipboard",
    );

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <TabNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
      "/settings?tab=appearance#chat-launch-clipboard",
    );
  });
});
