/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppControlContextItem,
  AppControlSession,
  BuiltInBrowserStatus,
  IosElementContextItem,
  IosSimulatorSession,
  LaneSummary,
  TerminalSessionSummary,
} from "../../../shared/types";
import { ADE_WORK_PTY_CONTEXT_INSERTED_EVENT } from "../../lib/workPtyContextEvents";
import { useAppStore, type WorkSidebarTab } from "../../state/appStore";
import { WorkSidebar, type WorkSidebarContextTarget } from "./WorkSidebar";

vi.mock("../chat/ChatIosSimulatorPanel", async () => {
  const React = await import("react");
  return {
    ChatIosSimulatorPanel: (props: {
      sessionId: string | null;
      controlDisabledReason?: string | null;
      ignoreChatOwnership?: boolean;
      onAddAttachment?: (attachment: { path: string; type: "image" }) => void;
      onAddContext?: (item: IosElementContextItem) => void;
      onInsertDraft?: (text: string) => void;
    }) => React.createElement("div", {
      "data-testid": "ios-panel",
      "data-session-id": props.sessionId ?? "",
      "data-control-disabled": props.controlDisabledReason ?? "",
      "data-ignore-chat-ownership": props.ignoreChatOwnership ? "true" : "false",
    }, [
      React.createElement("button", {
        key: "context",
        type: "button",
        disabled: !props.onAddContext,
        onClick: () => props.onAddContext?.(iosContextItem),
      }, "Add iOS context"),
      React.createElement("button", {
        key: "attachment",
        type: "button",
        disabled: !props.onAddAttachment,
        onClick: () => props.onAddAttachment?.({ path: ".ade/artifacts/ios.png", type: "image" }),
      }, "Add iOS attachment"),
      React.createElement("button", {
        key: "draft",
        type: "button",
        disabled: !props.onInsertDraft,
        onClick: () => props.onInsertDraft?.("inspect this iOS screen"),
      }, "Insert iOS draft"),
    ]),
  };
});

vi.mock("../chat/ChatAppControlPanel", async () => {
  const React = await import("react");
  return {
    ChatAppControlPanel: (props: {
      sessionId: string | null;
      controlDisabledReason?: string | null;
      onAddContext?: (item: AppControlContextItem) => void;
    }) => React.createElement("div", {
      "data-testid": "app-control-panel",
      "data-session-id": props.sessionId ?? "",
      "data-control-disabled": props.controlDisabledReason ?? "",
    },
      React.createElement("button", {
        type: "button",
        disabled: !props.onAddContext,
        onClick: () => props.onAddContext?.(appControlContextItem),
      }, "Add App Control context"),
    ),
  };
});

vi.mock("../chat/ChatBuiltInBrowserPanel", async () => {
  const React = await import("react");
  return {
    ChatBuiltInBrowserPanel: (props: {
      sessionId: string | null;
      onAddAttachment?: (attachment: { path: string; type: "image" }) => void;
      onAddContext?: (item: unknown) => void;
      onInsertDraft?: (text: string) => void;
    }) => React.createElement("div", { "data-testid": "browser-panel", "data-session-id": props.sessionId ?? "" }, [
      React.createElement("button", {
        key: "context",
        type: "button",
        disabled: !props.onAddContext,
        onClick: () => props.onAddContext?.({
          kind: "built_in_browser_element",
          id: "browser-context-1",
          componentId: "button.submit",
          label: "Submit",
          selector: "button.submit",
          frame: { x: 1, y: 2, width: 30, height: 12 },
          metadata: { label: "Submit", selector: "button.submit" },
          selectedAt: "2026-05-13T00:00:00.000Z",
        }),
      }, "Add Browser context"),
      React.createElement("button", {
        key: "attachment",
        type: "button",
        disabled: !props.onAddAttachment,
        onClick: () => props.onAddAttachment?.({ path: ".ade/artifacts/browser.png", type: "image" }),
      }, "Add Browser attachment"),
      React.createElement("button", {
        key: "draft",
        type: "button",
        disabled: !props.onInsertDraft,
        onClick: () => props.onInsertDraft?.("inspect this browser state"),
      }, "Insert Browser draft"),
    ]),
  };
});

vi.mock("../chat/ChatTerminalDrawer", async () => {
  const React = await import("react");
  return {
    ChatTerminalDrawer: (props: {
      variant?: string;
      laneId: string;
      chatSessionId?: string | null;
      open: boolean;
    }) => React.createElement("div", {
      "data-testid": "chat-terminal-drawer",
      "data-variant": props.variant ?? "",
      "data-lane-id": props.laneId,
      "data-chat-session-id": props.chatSessionId ?? "",
      "data-open": props.open ? "true" : "false",
    }),
  };
});

vi.mock("../files/FilesTab", async () => {
  const React = await import("react");
  return { FilesTab: () => React.createElement("div", null, "Files") };
});

vi.mock("../lanes/LaneDiffPane", async () => {
  const React = await import("react");
  return { LaneDiffPane: () => React.createElement("div", null, "Diff") };
});

vi.mock("../lanes/LaneGitActionsPane", async () => {
  const React = await import("react");
  return { LaneGitActionsPane: () => React.createElement("div", null, "Git") };
});

vi.mock("../ui/SmartTooltip", async () => {
  const React = await import("react");
  return { SmartTooltip: ({ children }: { children: unknown }) => React.createElement(React.Fragment, null, children as never) };
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
  status: {
    dirty: false,
    ahead: 0,
    behind: 0,
    remoteBehind: 0,
    rebaseInProgress: false,
  },
  createdAt: "2026-05-13T00:00:00.000Z",
  color: null,
  icon: null,
  tags: [],
};

const laneTwo: LaneSummary = {
  ...lane,
  id: "lane-2",
  name: "Lane 2",
  branchRef: "feature/other",
  worktreePath: "/repo-two",
};

const activeSession: TerminalSessionSummary = {
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

const otherLaneAppControlSession: AppControlSession = {
  id: "app-control-session-2",
  appKind: "electron",
  label: "Other lane app",
  projectRoot: "/repo-two",
  laneId: "lane-2",
  cwd: "/repo-two",
  command: "npm run dev",
  pid: 123,
  terminalSessionId: "term-2",
  terminalPtyId: "pty-2",
  cdpPort: 9222,
  cdpEndpoint: "http://127.0.0.1:9222",
  cdpTargetId: "target-2",
  provider: "cdp",
  chatSessionId: "chat-2",
  startedAt: "2026-05-13T00:00:00.000Z",
  connectedAt: "2026-05-13T00:00:01.000Z",
  status: "connected",
  lastError: null,
};

const otherLaneIosSession: IosSimulatorSession = {
  id: "ios-session-2",
  deviceUdid: "device-2",
  deviceName: "iPhone 16",
  bundleId: "com.example.app",
  appName: "Example",
  appBundlePath: null,
  targetId: null,
  projectRoot: "/repo-two",
  laneId: "lane-2",
  chatSessionId: "chat-2",
  mode: "live",
  bridgeUrl: null,
  startedAt: "2026-05-13T00:00:00.000Z",
  claimedAt: "2026-05-13T00:00:01.000Z",
};

const iosContextItem: IosElementContextItem = {
  kind: "ios_element",
  id: "ios-context-1",
  componentId: "ContentView/Continue",
  sourceFile: "ContentView.swift",
  sourceLine: 12,
  frame: { x: 1, y: 2, width: 3, height: 4 },
  metadata: { label: "Continue", role: "Button" },
  screenshotDataUrl: null,
  selectedAt: "2026-05-13T00:00:00.000Z",
};

const appControlContextItem: AppControlContextItem = {
  kind: "app_control_element",
  id: "app-context-1",
  appKind: "electron",
  sessionId: "app-control-session-1",
  provider: "cdp",
  componentId: "Run button",
  sourceFile: "src/App.tsx",
  sourceLine: 42,
  frame: { x: 10, y: 20, width: 30, height: 40 },
  metadata: { label: "Run", selector: "button.run" },
  screenshotDataUrl: null,
  selectedAt: "2026-05-13T00:00:00.000Z",
};

const defaultBrowserStatus: BuiltInBrowserStatus = {
  attached: false,
  partition: "persist:ade-browser",
  storageProfileKey: "global",
  collectionKey: "window",
  collectionProjectRoot: null,
  persistentProfile: true,
  visible: false,
  bounds: { x: 0, y: 0, width: 0, height: 0 },
  activeTabId: null,
  tabs: [],
  url: null,
  title: null,
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  isInspecting: false,
  hasSelection: false,
  ownerLaneId: null,
  ownerChatSessionId: null,
  ownerClaimedAt: null,
  ownerLeaseExpiresAt: null,
};

function installAdeMock(options: {
  appControlSession?: AppControlSession | null;
  iosSession?: IosSimulatorSession | null;
  browserStatus?: BuiltInBrowserStatus | null;
} = {}) {
  const terminalWrite = vi.fn().mockResolvedValue({ ok: true });
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      appControl: {
        getStatus: vi.fn().mockResolvedValue({ activeSession: options.appControlSession ?? null }),
        onEvent: vi.fn(() => () => {}),
      },
      builtInBrowser: {
        getStatus: vi.fn().mockResolvedValue(options.browserStatus ?? defaultBrowserStatus),
        onEvent: vi.fn(() => () => {}),
        stopInspect: vi.fn().mockResolvedValue(undefined),
        setBounds: vi.fn().mockResolvedValue(undefined),
      },
      iosSimulator: {
        getStatus: vi.fn().mockResolvedValue({ activeSession: options.iosSession ?? null }),
        onEvent: vi.fn(() => () => {}),
      },
      terminal: {
        write: terminalWrite,
      },
    },
  });
  return { terminalWrite };
}

function renderSidebar(args: {
  tab: WorkSidebarTab;
  contextTarget: WorkSidebarContextTarget | null;
  contextDisabledReason?: string | null;
  laneId?: string;
  lanes?: LaneSummary[];
  activeSession?: TerminalSessionSummary | null;
  onTabChange?: (tab: WorkSidebarTab) => void;
}) {
  return render(
    <MemoryRouter>
      <WorkSidebar
        active
        laneId={args.laneId ?? "lane-1"}
        lanes={args.lanes ?? [lane]}
        activeSession={args.activeSession ?? activeSession}
        tab={args.tab}
        onTabChange={args.onTabChange ?? vi.fn()}
        onClose={vi.fn()}
        contextTarget={args.contextTarget}
        contextDisabledReason={args.contextDisabledReason ?? null}
      />
    </MemoryRouter>,
  );
}

describe("WorkSidebar context targets", () => {
  beforeEach(() => {
    installAdeMock();
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ project: null, projectBinding: null } as any);
    delete (window as unknown as { ade?: unknown }).ade;
    vi.restoreAllMocks();
  });

  it("passes chat session ids into iOS and App Control panels and dispatches chat events", async () => {
    const received: unknown[] = [];
    window.addEventListener("ade:agent-chat:add-ios-context", (event) => {
      received.push((event as CustomEvent).detail);
    });
    renderSidebar({ tab: "ios", contextTarget: { kind: "chat", sessionId: "chat-1" } });

    expect(screen.getByTestId("ios-panel").getAttribute("data-session-id")).toBe("chat-1");
    expect((screen.getByText("Add iOS attachment") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Add iOS context"));

    expect(received).toEqual([expect.objectContaining({
      sessionId: "chat-1",
      item: expect.objectContaining({ id: "ios-context-1" }),
    })]);

    cleanup();
    renderSidebar({ tab: "app-control", contextTarget: { kind: "chat", sessionId: "chat-1" } });

    expect(screen.getByTestId("app-control-panel").getAttribute("data-session-id")).toBe("chat-1");
  });

  it("renders the attached terminal panel for running CLI session owners", () => {
    renderSidebar({
      tab: "terminal",
      contextTarget: { kind: "pty", sessionId: "term-1", ptyId: "pty-1", toolType: "codex" },
    });

    const drawer = screen.getByTestId("chat-terminal-drawer");
    expect(drawer.getAttribute("data-variant")).toBe("panel");
    expect(drawer.getAttribute("data-lane-id")).toBe("lane-1");
    expect(drawer.getAttribute("data-chat-session-id")).toBe("term-1");
    expect(drawer.getAttribute("data-open")).toBe("true");
  });

  it("renders the attached terminal panel for chat owners", () => {
    renderSidebar({
      tab: "terminal",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
    });

    expect(screen.getByTestId("chat-terminal-drawer").getAttribute("data-chat-session-id")).toBe("chat-1");
  });

  it("explains why ended CLI sessions cannot open attached terminals", () => {
    renderSidebar({
      tab: "terminal",
      activeSession: { ...activeSession, status: "completed" },
      contextTarget: null,
    });

    expect(screen.getByText(/Continue this .* session before opening an attached terminal\./)).toBeTruthy();
  });

  it("writes formatted context to active PTY targets instead of dispatching chat events", async () => {
    const { terminalWrite } = installAdeMock();
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const inserted: unknown[] = [];
    window.addEventListener(ADE_WORK_PTY_CONTEXT_INSERTED_EVENT, (event) => {
      inserted.push((event as CustomEvent).detail);
    });

    renderSidebar({
      tab: "ios",
      contextTarget: { kind: "pty", sessionId: "term-1", ptyId: "pty-1", toolType: "claude" },
    });

    expect(screen.getByTestId("ios-panel").getAttribute("data-session-id")).toBe("");
    fireEvent.click(screen.getByText("Add iOS context"));

    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(1));
    expect(terminalWrite).toHaveBeenCalledWith({
      terminalId: "term-1",
      ptyId: "pty-1",
      data: expect.stringContaining("\x1b[200~"),
    });
    expect(terminalWrite.mock.calls[0]?.[0].data).toContain("iOS visual inspect context attached by the user.");
    expect(terminalWrite.mock.calls[0]?.[0].data).toContain("Continue");
    expect(dispatchSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ade:agent-chat:add-ios-context" }));
    await waitFor(() => expect(inserted).toEqual([expect.objectContaining({
      sessionId: "term-1",
      ptyId: "pty-1",
      toolType: "claude",
      kind: "ios",
    })]));
  });

  it("inserts screenshot attachment paths immediately for PTY targets", async () => {
    const { terminalWrite } = installAdeMock();
    renderSidebar({
      tab: "browser",
      contextTarget: { kind: "pty", sessionId: "term-1", ptyId: "pty-1", toolType: "codex" },
    });

    fireEvent.click(screen.getByText("Add Browser attachment"));

    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(1));
    expect(terminalWrite.mock.calls[0]?.[0].data).toContain(".ade/artifacts/browser.png");
    expect(terminalWrite.mock.calls[0]?.[0].data).not.toContain("base64");
  });

  it("keeps tools mounted but disables context insertion when there is no target", () => {
    renderSidebar({
      tab: "ios",
      contextTarget: null,
      contextDisabledReason: "Shell sessions can use the lane tools, but context insertion targets chats or agent CLI sessions.",
    });

    expect(screen.getByTestId("ios-panel")).toBeTruthy();
    expect(screen.getByText(/Shell sessions can use the lane tools/)).toBeTruthy();
    expect((screen.getByText("Add iOS context") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Add iOS attachment") as HTMLButtonElement).disabled).toBe(true);
  });

  it("dispatches draft target events without faking a chat session", () => {
    const received: unknown[] = [];
    window.addEventListener("ade:agent-chat:add-ios-context", (event) => {
      received.push((event as CustomEvent).detail);
    });

    renderSidebar({
      tab: "ios",
      contextTarget: {
        kind: "draft",
        draftTargetId: "work:draft:lane-1:chat",
        laneId: "lane-1",
        draftKind: "chat",
      },
    });

    expect(screen.getByTestId("ios-panel").getAttribute("data-session-id")).toBe("");
    expect((screen.getByText("Add iOS context") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("Add iOS context"));

    expect(received).toEqual([expect.objectContaining({
      draftTargetId: "work:draft:lane-1:chat",
      laneId: "lane-1",
      draftKind: "chat",
      item: expect.objectContaining({ id: "ios-context-1" }),
    })]);
    expect(received[0]).not.toHaveProperty("sessionId");
  });

  it("warns when App Control is attached to another lane while keeping Work controls usable", async () => {
    const { terminalWrite } = installAdeMock({ appControlSession: otherLaneAppControlSession });

    renderSidebar({
      tab: "app-control",
      contextTarget: { kind: "pty", sessionId: "term-1", ptyId: "pty-1", toolType: "claude" },
      lanes: [lane, laneTwo],
    });

    expect(await screen.findByText(/This App Control view is claimed by Lane 2, not Lane 1/)).toBeTruthy();
    expect(screen.getByTestId("app-control-panel").getAttribute("data-control-disabled")).toBe("");
    expect((screen.getByText("Add App Control context") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("Add App Control context"));
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(1));
  });

  it("warns when the iOS Simulator is attached to another lane while keeping Work controls usable", async () => {
    const { terminalWrite } = installAdeMock({ iosSession: otherLaneIosSession });

    renderSidebar({
      tab: "ios",
      contextTarget: { kind: "pty", sessionId: "term-1", ptyId: "pty-1", toolType: "claude" },
      lanes: [lane, laneTwo],
    });

    expect(await screen.findByText(/This iOS Simulator view is claimed by Lane 2, not Lane 1/)).toBeTruthy();
    expect(screen.getByTestId("ios-panel").getAttribute("data-control-disabled")).toBe("");
    expect(screen.getByTestId("ios-panel").getAttribute("data-ignore-chat-ownership")).toBe("true");
    expect((screen.getByText("Add iOS context") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("Add iOS context"));
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(1));
  });

  it("does not assign Browser ownership from the currently visible lane", async () => {
    installAdeMock();

    renderSidebar({
      tab: "browser",
      laneId: "lane-2",
      lanes: [lane, laneTwo],
      activeSession: { ...activeSession, laneId: "lane-2", laneName: "Lane 2" },
      contextTarget: { kind: "pty", sessionId: "term-2", ptyId: "pty-2", toolType: "claude" },
    });

    await waitFor(() => expect(screen.queryByText(/This Browser view is claimed/)).toBeNull());
    expect((screen.getByText("Add Browser context") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("Add Browser attachment") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not show a view-level Browser warning for another lane's active tab", async () => {
    installAdeMock({
      browserStatus: {
        ...defaultBrowserStatus,
        ownerLaneId: "lane-1",
        ownerChatSessionId: "session-1",
        ownerClaimedAt: "2026-05-13T00:00:00.000Z",
        ownerLeaseExpiresAt: "2026-05-13T00:10:00.000Z",
      },
    });

    renderSidebar({
      tab: "browser",
      laneId: "lane-2",
      lanes: [lane, laneTwo],
      activeSession: { ...activeSession, laneId: "lane-2", laneName: "Lane 2" },
      contextTarget: { kind: "pty", sessionId: "term-2", ptyId: "pty-2", toolType: "claude" },
    });

    await waitFor(() => expect(screen.queryByText(/This Browser view is claimed/)).toBeNull());
    expect((screen.getByText("Add Browser context") as HTMLButtonElement).disabled).toBe(false);
  });

  it("scopes Browser sidebar status to the current project and ignores malformed open events", async () => {
    installAdeMock({
      browserStatus: {
        ...defaultBrowserStatus,
        collectionProjectRoot: "/repo-one",
      },
    });
    useAppStore.setState({
      project: { rootPath: "/repo-one", name: "Repo One" },
    } as any);
    const browserEventListener: {
      current: ((event: { type?: string; status?: unknown }) => void) | null;
    } = { current: null };
    const browser = window.ade.builtInBrowser;
    vi.mocked(browser.onEvent).mockImplementation((listener) => {
      browserEventListener.current = (event) => listener(event as Parameters<typeof listener>[0]);
      return () => {};
    });

    renderSidebar({
      tab: "browser",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
    });

    await waitFor(() => {
      expect(browser.getStatus).toHaveBeenCalledWith({
        projectRoot: "/repo-one",
      });
    });
    expect(() => browserEventListener.current?.({ type: "open-request" })).not.toThrow();
    expect(() => browserEventListener.current?.({
      type: "status",
      status: {
        ...defaultBrowserStatus,
        collectionProjectRoot: "/repo-two",
      },
    })).not.toThrow();
  });

  it("only exposes remote-aware tool panes for remote projects", async () => {
    const onTabChange = vi.fn();
    useAppStore.setState({
      projectBinding: {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "Mac Studio",
        projectId: "project-1",
        rootPath: "/repo",
        displayName: "Repo",
      },
    } as any);

    renderSidebar({
      tab: "browser",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
      onTabChange,
    });

    expect(screen.getByRole("button", { name: "Git" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "iOS Sim" })).toBeNull();
    expect(screen.queryByRole("button", { name: "App Control" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Browser" })).toBeNull();
    expect(screen.queryByTestId("browser-panel")).toBeNull();
    await waitFor(() => expect(onTabChange).toHaveBeenCalledWith("git"));
    expect(window.ade.builtInBrowser.getStatus).not.toHaveBeenCalled();
    expect(window.ade.iosSimulator.getStatus).not.toHaveBeenCalled();
    expect(window.ade.appControl.getStatus).not.toHaveBeenCalled();
  });
});
