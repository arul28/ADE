/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkSidebar } from "./WorkSidebar";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { pluginPanelSlotId } from "../plugins/sockets/panelSlotId";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";

/**
 * The bug this file exists for.
 *
 * `ade-app-control` and `ade-ios-sim` each ship a complete page. The rail
 * matched their plugin id, concluded the contributed pane WAS the compiled
 * engine, and drew ADE's old panel — so neither page could be reached from the
 * Work rail at all, on any machine, no matter what the manifest said.
 *
 * The pane is mocked rather than seeded through the contribution store because
 * the question under test is the rail's branch, not the store's resolution:
 * given a pane that resolved a page, does the rail draw the page or the panel.
 * `PluginSlotPanel` already has its own tests for drawing a guest.
 */

const PAGE_PANE = {
  id: pluginPanelSlotId("ade-app-control", "control-pane"),
  key: "ade-app-control:control-pane",
  pluginId: "ade-app-control",
  panelId: "control-pane",
  label: "Electron Control",
  icon: (() => null) as never,
  displayName: "Electron Control",
  entryHtml: "dist/index.html",
  webviewSurfaceId: "control",
};

/**
 * The same pane with the page fields ABSENT rather than undefined, because that
 * is what a client which cannot host a guest actually produces: `entryHtml` is
 * spread in conditionally, so its key is missing, not empty.
 */
const { entryHtml: _entryHtml, webviewSurfaceId: _surfaceId, ...PANEL_PANE } = PAGE_PANE;

type Pane = typeof PAGE_PANE | typeof PANEL_PANE;

const panes = { current: [PAGE_PANE] as Pane[] };

vi.mock("../plugins/sockets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/sockets")>();
  const React = await import("react");
  return {
    ...actual,
    usePluginPanelSlots: () => panes.current,
    PluginSlotPanel: ({ slot }: { slot: { id: string } }) =>
      React.createElement("div", { "data-testid": "plugin-page", "data-slot-id": slot.id }),
  };
});

vi.mock("../chat/ChatAppControlPanel", async () => {
  const React = await import("react");
  return {
    ChatAppControlPanel: () => React.createElement("div", { "data-testid": "compiled-app-control-panel" }),
  };
});

vi.mock("../chat/ChatIosSimulatorPanel", async () => {
  const React = await import("react");
  return {
    ChatIosSimulatorPanel: () => React.createElement("div", { "data-testid": "compiled-ios-panel" }),
  };
});

vi.mock("../chat/ChatBuiltInBrowserPanel", async () => {
  const React = await import("react");
  return { ChatBuiltInBrowserPanel: () => React.createElement("div", null) };
});

vi.mock("../chat/ChatTerminalDrawer", async () => {
  const React = await import("react");
  return { ChatTerminalDrawer: () => React.createElement("div", null) };
});

vi.mock("../files/FilesTab", async () => {
  const React = await import("react");
  return { FilesTab: () => React.createElement("div", null) };
});

vi.mock("../lanes/LaneDiffPane", async () => {
  const React = await import("react");
  return { LaneDiffPane: () => React.createElement("div", null) };
});

vi.mock("../lanes/LaneGitActionsPane", async () => {
  const React = await import("react");
  return { LaneGitActionsPane: () => React.createElement("div", null) };
});

vi.mock("../ui/SmartTooltip", async () => {
  const React = await import("react");
  return {
    SmartTooltip: ({ children }: { children: unknown }) =>
      React.createElement(React.Fragment, null, children as never),
  };
});

const lane: LaneSummary = {
  id: "lane-1",
  name: "Lane 1",
  laneType: "worktree",
  baseRef: "main",
  branchRef: "feature/test",
  worktreePath: "/repo",
  parentLaneId: null,
  childCount: 0,
  stackDepth: 0,
  parentStatus: null,
  isEditProtected: false,
  status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
  createdAt: "2026-05-13T00:00:00.000Z",
  color: null,
  icon: null,
  tags: [],
};

const session: TerminalSessionSummary = {
  id: "session-1",
  laneId: "lane-1",
  laneName: "Lane 1",
  ptyId: "pty-1",
  tracked: true,
  pinned: false,
  goal: null,
  toolType: "claude",
  title: "Claude Code",
  status: "running",
  startedAt: "2026-05-13T00:00:00.000Z",
  endedAt: null,
  exitCode: null,
  transcriptPath: "/tmp/transcript",
  headShaStart: null,
  headShaEnd: null,
  lastOutputPreview: null,
  summary: null,
  runtimeState: "running",
  resumeCommand: null,
};

function renderRail(tab: string) {
  return render(
    <MemoryRouter>
      <WorkSidebar
        active
        laneId="lane-1"
        lanes={[lane]}
        activeSession={session}
        tab={tab as never}
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        contextTarget={{ kind: "chat", sessionId: "chat-1" }}
        contextDisabledReason={null}
      />
    </MemoryRouter>,
  );
}

describe("a Work-rail pane whose plugin ships a page", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    // The owner is installed, so the compiled tab is gone and the pane holds
    // the seat — the state the reader is actually in once the plugin lands.
    seedBuiltinSurfacePlugins(["app-control"]);
    panes.current = [PAGE_PANE];
    (window as unknown as { ade: Record<string, unknown> }).ade = {
      appControl: { getStatus: vi.fn().mockResolvedValue({ activeSession: null }), onEvent: vi.fn(() => () => {}) },
      iosSimulator: { getStatus: vi.fn().mockResolvedValue({ activeSession: null }), onEvent: vi.fn(() => () => {}) },
      builtInBrowser: { stopInspect: vi.fn().mockResolvedValue(undefined), setBounds: vi.fn().mockResolvedValue(undefined) },
    };
  });

  afterEach(() => {
    cleanup();
    resetBuiltinSurfacePlugins();
    vi.clearAllMocks();
  });

  it("draws the page, not ADE's compiled panel", () => {
    renderRail(PAGE_PANE.id);
    expect(screen.getByTestId("plugin-page").getAttribute("data-slot-id")).toBe(PAGE_PANE.id);
    // The whole defect: the compiled panel used to win this branch, and the
    // page the plugin shipped was unreachable from the rail.
    expect(screen.queryByTestId("compiled-app-control-panel")).toBeNull();
  });

  it("still falls back to the compiled panel when the pane resolved no page", () => {
    panes.current = [PANEL_PANE];
    renderRail(PANEL_PANE.id);
    // A client that cannot host a guest resolves no `entryHtml`, and the
    // webview surface's own declared fallback is the panel.
    expect(screen.getByTestId("compiled-app-control-panel")).toBeTruthy();
    expect(screen.queryByTestId("plugin-page")).toBeNull();
  });
});
