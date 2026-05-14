/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps } from "react";
import type { AgentChatSessionSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { AgentChatPane } from "./AgentChatPane";

vi.mock("../terminals/TerminalView", () => {
  const ReactMod = require("react") as typeof import("react");
  return {
    TerminalView: (props: { sessionId: string; ptyId: string }) =>
      ReactMod.createElement("div", { "data-testid": "terminal-view" }, `${props.sessionId}:${props.ptyId}`),
  };
});

vi.mock("lottie-react", () => ({
  useLottie: () => ({
    View: null,
    play: () => {},
    stop: () => {},
    pause: () => {},
    setSpeed: () => {},
    goToAndStop: () => {},
    goToAndPlay: () => {},
    setDirection: () => {},
    getDuration: () => 0,
    destroy: () => {},
    animationItem: null,
  }),
  default: () => null,
}));

vi.mock("@lobehub/icons", () => {
  const brand = () => {
    const Component = () => null;
    Object.assign(Component, {
      Avatar: () => null,
      Color: () => null,
      Combine: () => null,
      Text: () => null,
      colorPrimary: "#888",
      title: "stub",
    });
    return Component;
  };
  return {
    Claude: brand(),
    Codex: brand(),
    Cursor: brand(),
    OpenCode: brand(),
  };
});

vi.mock("./ChatIosSimulatorPanel", () => {
  const ReactMod = require("react") as typeof import("react");
  return {
    ChatIosSimulatorPanel: () => ReactMod.createElement("div", { "data-testid": "ios-panel" }, "iOS panel mounted"),
  };
});

vi.mock("./ChatAppControlPanel", () => {
  const ReactMod = require("react") as typeof import("react");
  return {
    ChatAppControlPanel: () => ReactMod.createElement("div", { "data-testid": "app-control-panel" }, "App Control panel mounted"),
  };
});

const originalAde = globalThis.window.ade;
const originalNavigatorPlatform = window.navigator.platform;
let iosEventListener: ((event: { type: string; chatSessionId?: string; laneId?: string; mode?: string }) => void) | null = null;

function buildSession(overrides: Partial<AgentChatSessionSummary> = {}): AgentChatSessionSummary {
  return {
    sessionId: "session-1",
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5.4",
    modelId: "openai/gpt-5.4",
    endedAt: null,
    lastOutputPreview: null,
    summary: null,
    startedAt: "2026-03-24T05:57:45.700Z",
    lastActivityAt: "2026-03-24T05:57:45.700Z",
    status: "active",
    sessionProfile: "workflow",
    title: "Drawer audit chat",
    goal: null,
    completion: null,
    reasoningEffort: "xhigh",
    executionMode: "focused",
    interactionMode: null,
    ...overrides,
  };
}

function installAdeMocks(
  sessionOrSessions: AgentChatSessionSummary | AgentChatSessionSummary[],
  options?: { transcript?: string },
) {
  const sessions = Array.isArray(sessionOrSessions) ? sessionOrSessions : [sessionOrSessions];
  const unarchive = vi.fn().mockResolvedValue(undefined);
  globalThis.window.ade = {
    projectConfig: {
      get: vi.fn().mockResolvedValue({
        effective: {
          ai: {
            chat: {
              sendOnEnter: true,
            },
          },
        },
      }),
    },
    ai: {
      getStatus: vi.fn().mockRejectedValue(new Error("no ai status")),
    },
    agentChat: {
      models: vi.fn().mockResolvedValue([{ id: "gpt-5.4" }]),
      slashCommands: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue(sessions),
      getSummary: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) =>
        sessions.find((session) => session.sessionId === sessionId) ?? null,
      ),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
      send: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({ id: "created-session", laneId: "lane-1" }),
      handoff: vi.fn().mockResolvedValue({ session: { id: "handoff-session", laneId: "lane-1" }, usedFallbackSummary: false }),
      suggestLaneName: vi.fn().mockResolvedValue("drawer-task"),
      parallelLaunchState: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      },
      editSteer: vi.fn().mockResolvedValue(undefined),
      updateSession: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
      unarchive,
      delete: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
      approve: vi.fn().mockResolvedValue(undefined),
      respondToInput: vi.fn().mockResolvedValue(undefined),
      warmupModel: vi.fn().mockResolvedValue(undefined),
      fileSearch: vi.fn().mockResolvedValue([]),
      dispose: vi.fn().mockResolvedValue(undefined),
    },
    sessions: {
      get: vi.fn().mockResolvedValue({ toolType: "codex-chat" }),
      readTranscriptTail: vi.fn().mockResolvedValue(options?.transcript ?? ""),
      getDelta: vi.fn().mockResolvedValue(null),
      onChanged: vi.fn().mockImplementation(() => () => undefined),
    },
    computerUse: {
      getOwnerSnapshot: vi.fn().mockResolvedValue({ artifacts: [] }),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
    },
    files: {
      listWorkspaces: vi.fn().mockResolvedValue([]),
    },
    lanes: {
      list: vi.fn().mockResolvedValue([]),
      listSnapshots: vi.fn().mockResolvedValue([]),
    },
    git: {
      listBranches: vi.fn().mockResolvedValue([]),
      getActionRuntime: vi.fn().mockResolvedValue(null),
      onActionRuntimeEvent: vi.fn().mockImplementation(() => () => undefined),
    },
    diff: {
      getChanges: vi.fn().mockResolvedValue({ staged: [], unstaged: [] }),
    },
    prs: {
      getForLane: vi.fn().mockResolvedValue(null),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
      getChecks: vi.fn().mockResolvedValue([]),
      openInGitHub: vi.fn().mockResolvedValue(undefined),
    },
    pty: {
      create: vi.fn().mockResolvedValue({ ptyId: "pty-created", sessionId: "terminal-created", pid: 1234 }),
      onExit: vi.fn().mockImplementation(() => () => undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      onData: vi.fn().mockImplementation(() => () => undefined),
    },
    terminal: {
      list: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue({ terminalId: "term-1", data: "", nextSince: 0 }),
      write: vi.fn().mockResolvedValue({ ok: true }),
      signal: vi.fn().mockResolvedValue({ ok: true }),
      activeForChat: vi.fn().mockResolvedValue(null),
    },
    iosSimulator: {
      getStatus: vi.fn().mockResolvedValue({ platform: "darwin" }),
      onEvent: vi.fn().mockImplementation((listener) => {
        iosEventListener = listener;
        return () => {
          if (iosEventListener === listener) iosEventListener = null;
        };
      }),
    },
    appControl: {
      getStatus: vi.fn().mockResolvedValue({ supported: true }),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
    },
  } as any;
  return { unarchive };
}

function seedStore() {
  useAppStore.setState({
    project: { rootPath: "/tmp/project-under-test" } as any,
    lanes: [{
      id: "lane-1",
      name: "drawer lane",
      branchRef: "refs/heads/drawer-lane",
      laneType: "worktree",
      worktreePath: "/tmp/project-under-test/drawer-lane",
    } as any],
    selectedLaneId: "lane-1",
  });
}

function renderPane() {
  const session = buildSession();
  installAdeMocks(session);
  seedStore();

  return render(
    <MemoryRouter>
      <AgentChatPane
        laneId="lane-1"
        lockSessionId={session.sessionId}
        hideSessionTabs
        initialSessionSummary={session}
      />
    </MemoryRouter>,
  );
}

function renderSessionPane(
  sessions: AgentChatSessionSummary[],
  options?: {
    transcript?: string;
    presentation?: ComponentProps<typeof AgentChatPane>["presentation"];
  },
) {
  const active = sessions[0]!;
  const mocks = installAdeMocks(sessions, { transcript: options?.transcript });
  seedStore();
  const view = render(
    <MemoryRouter>
      <AgentChatPane
        laneId="lane-1"
        initialSessionId={active.sessionId}
        initialSessionSummary={active}
        presentation={options?.presentation}
      />
    </MemoryRouter>,
  );
  return { ...mocks, view };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  iosEventListener = null;
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  useAppStore.setState({
    project: null,
    laneSnapshots: [],
    lanes: [],
    selectedLaneId: null,
    focusedSessionId: null,
    laneInspectorTabs: {},
    workViewByProject: {},
    laneWorkViewByScope: {},
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: originalNavigatorPlatform,
  });
  if (originalAde === undefined) {
    delete (globalThis.window as any).ade;
  } else {
    globalThis.window.ade = originalAde;
  }
});

describe("AgentChatPane companion drawers", () => {
  it("opens and closes the iOS simulator and App Control drawers from chat chrome", async () => {
    renderPane();

    await waitFor(() => {
      expect(iosEventListener).toBeTruthy();
    });
    act(() => {
      iosEventListener?.({
        type: "drawer-open-requested",
        chatSessionId: "session-1",
        laneId: "lane-1",
        mode: "control",
      });
    });

    expect(screen.getByTestId("ios-panel").textContent).toBe("iOS panel mounted");
    fireEvent.click(screen.getAllByRole("button", { name: "Close iOS simulator drawer" })[0]!);
    await waitFor(() => {
      expect(screen.queryByTestId("ios-panel")).toBeNull();
    });

    const iosButton = screen.getAllByRole("button", { name: "Open iOS simulator drawer" })[0]!;
    fireEvent.click(iosButton);

    expect(screen.getByTestId("ios-panel").textContent).toBe("iOS panel mounted");
    expect(screen.getAllByRole("button", { name: "Close iOS simulator drawer" })[0]!.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getAllByRole("button", { name: "Close iOS simulator drawer" })[0]!);
    await waitFor(() => {
      expect(screen.queryByTestId("ios-panel")).toBeNull();
    });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Open App Control drawer" }).length).toBeGreaterThan(0);
    });
    const appControlButton = screen.getAllByRole("button", { name: "Open App Control drawer" })[0]!;
    fireEvent.click(appControlButton);

    expect(screen.getByTestId("app-control-panel").textContent).toBe("App Control panel mounted");
    expect(screen.getAllByRole("button", { name: "Close App Control drawer" })[0]!.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getAllByRole("button", { name: "Close App Control drawer" })[0]!);
    await waitFor(() => {
      expect(screen.queryByTestId("app-control-panel")).toBeNull();
    });
  });

  it("opens the proof drawer and persists split resize from the real divider", async () => {
    renderPane();

    fireEvent.click(await screen.findByRole("button", { name: "Open proof drawer" }));
    expect(screen.getByText("Artifacts")).toBeTruthy();

    const divider = screen.getByRole("separator", { name: "" });
    const splitParent = divider.parentElement;
    expect(splitParent).toBeTruthy();
    Object.defineProperty(splitParent, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 1000,
        height: 600,
        top: 0,
        right: 1000,
        bottom: 600,
        left: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.mouseDown(divider, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 600 });
    fireEvent.mouseUp(document);

    await waitFor(() => {
      expect(window.sessionStorage.getItem("ade.chat.rightPaneSplit")).toBe("40");
    });

    fireEvent.click(screen.getByRole("button", { name: "Close proof drawer" }));
    await waitFor(() => {
      expect(screen.queryByText("Artifacts")).toBeNull();
    });
  });

  it("restores an archived chat from the archived selector", async () => {
    const active = buildSession({ sessionId: "active-session", title: "Active chat" });
    const archived = buildSession({
      sessionId: "archived-session",
      title: "Archived chat",
      archivedAt: "2026-05-12T00:00:00.000Z",
    });
    const { unarchive } = renderSessionPane([active, archived]);

    const restoreSelect = await screen.findByTitle("Restore archived chat");
    fireEvent.change(restoreSelect, { target: { value: "archived-session" } });

    await waitFor(() => {
      expect(unarchive).toHaveBeenCalledWith({ sessionId: "archived-session" });
    });
  });

  it("clears a persistent identity chat view without deleting the session", async () => {
    const transcript = `${JSON.stringify({
      sessionId: "persistent-session",
      timestamp: "2026-05-12T00:00:00.000Z",
      event: {
        type: "text",
        text: "Persistent memory view text",
        itemId: "persistent-text",
        turnId: "turn-1",
      },
    })}\n`;

    renderSessionPane(
      [buildSession({ sessionId: "persistent-session", title: "Persistent identity" })],
      {
        transcript,
        presentation: { mode: "standard", profile: "persistent_identity" },
      },
    );

    expect(await screen.findByText("Persistent memory view text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear view" }));

    await waitFor(() => {
      expect(screen.queryByText("Persistent memory view text")).toBeNull();
    });
    expect(globalThis.window.ade.agentChat.delete).not.toHaveBeenCalled();
  });
});
