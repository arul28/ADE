/* @vitest-environment jsdom */

import type { ReactNode } from "react";
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
  OpenProjectBinding,
  TerminalSessionSummary,
} from "../../../shared/types";
import { ADE_WORK_PTY_CONTEXT_INSERTED_EVENT } from "../../lib/workPtyContextEvents";
import { useAppStore, type WorkSidebarTab } from "../../state/appStore";
import { WorkSidebar, type WorkSidebarContextTarget } from "./WorkSidebar";
import { NativeToolFeedsProvider } from "./NativeToolFeedsContext";
import { makeBuiltInBrowserStatus } from "../chat/__fixtures__/builtInBrowserStatus";

const originalNavigatorPlatform = Object.getOwnPropertyDescriptor(window.navigator, "platform");

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

vi.mock("../chat/ChatPrPane", async () => {
  const React = await import("react");
  return {
    ChatPrPane: ({ chromeless, onRegisterRefresh }: {
      chromeless?: boolean;
      onRegisterRefresh?: (action: { run: () => void; syncing: boolean } | null) => void;
    }) => {
      React.useEffect(() => {
        onRegisterRefresh?.({ run: () => {}, syncing: false });
        return () => onRegisterRefresh?.(null);
      }, [onRegisterRefresh]);
      return React.createElement("div", {
        "data-testid": "pr-pane",
        "data-chromeless": chromeless ? "true" : "false",
      });
    },
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
  driver: "cdp",
  chatSessionId: "chat-2",
  startedAt: "2026-05-13T00:00:00.000Z",
  connectedAt: "2026-05-13T00:00:01.000Z",
  status: "connected",
  lastError: null,
  lastObservationId: null,
  lastTraceEntryId: null,
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

const defaultBrowserStatus: BuiltInBrowserStatus = makeBuiltInBrowserStatus({
  attached: false,
  collectionKey: "window",
  visible: false,
  bounds: { x: 0, y: 0, width: 0, height: 0 },
  activeTabId: null,
  tabs: [],
  url: null,
  title: null,
});

function installAdeMock(options: {
  appControlSession?: AppControlSession | null;
  iosSession?: IosSimulatorSession | null;
  browserStatus?: BuiltInBrowserStatus | null;
} = {}) {
  const terminalWrite = vi.fn().mockResolvedValue({ ok: true });
  const resumeSession = vi.fn().mockResolvedValue({ ok: true });
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
      pty: {
        resumeSession,
      },
    },
  });
  return { terminalWrite, resumeSession };
}

/**
 * The feeds come from the page's provider in production; the pane opens no
 * subscriptions of its own, so every render site here has to supply the owner.
 */
function withFeeds(runtimePin: OpenProjectBinding | null, children: ReactNode) {
  return (
    <MemoryRouter>
      <NativeToolFeedsProvider active runtimePin={runtimePin}>
        {children}
      </NativeToolFeedsProvider>
    </MemoryRouter>
  );
}

function renderSidebar(args: {
  tab: WorkSidebarTab;
  contextTarget: WorkSidebarContextTarget | null;
  contextDisabledReason?: string | null;
  laneId?: string;
  lanes?: LaneSummary[];
  activeSession?: TerminalSessionSummary | null;
  onTabChange?: (tab: WorkSidebarTab | null) => void;
  runtimePin?: OpenProjectBinding | null;
}) {
  const runtimePin = args.runtimePin ?? null;
  return render(withFeeds(runtimePin, (
    <WorkSidebar
      active
      laneId={args.laneId ?? "lane-1"}
      lanes={args.lanes ?? [lane]}
      activeSession={args.activeSession === undefined ? activeSession : args.activeSession}
      tool={args.tab}
      onToolChange={args.onTabChange ?? vi.fn()}
      onClose={vi.fn()}
      contextTarget={args.contextTarget}
      contextDisabledReason={args.contextDisabledReason ?? null}
      runtimePin={runtimePin}
    />
  )));
}

/** A picker card, found by the tool name it renders. */
function cardFor(label: string): HTMLButtonElement {
  const heading = screen.getByText(label);
  const card = heading.closest("button");
  if (!card) throw new Error(`No picker card for ${label}`);
  return card as HTMLButtonElement;
}

describe("WorkSidebar context targets", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    installAdeMock();
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ project: null, projectBinding: null } as any);
    delete (window as unknown as { ade?: unknown }).ade;
    if (originalNavigatorPlatform) {
      Object.defineProperty(window.navigator, "platform", originalNavigatorPlatform);
    }
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
      activeSession: { ...activeSession, id: "term-1", toolType: "codex" },
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
      activeSession: { ...activeSession, id: "chat-1", toolType: "claude-chat" },
      contextTarget: { kind: "chat", sessionId: "chat-1" },
    });

    expect(screen.getByTestId("chat-terminal-drawer").getAttribute("data-chat-session-id")).toBe("chat-1");
  });

  it("offers an ended CLI session the one action that brings its shells back", async () => {
    const { resumeSession } = installAdeMock();
    renderSidebar({
      tab: "terminal",
      activeSession: { ...activeSession, status: "completed" },
      contextTarget: null,
    });

    // The whole empty state, not the bare sentence it used to be: a headline
    // you can act on, the reason, an action, and the CLI hint.
    expect(screen.getByText("This session has ended")).toBeTruthy();
    expect(screen.getByText(/Resume this .* to attach shells to it again\./)).toBeTruthy();
    expect(screen.getByText("ade terminal")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Resume session/ }));
    await waitFor(() => expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: activeSession.id }),
    ));
  });

  it("keeps a lane with no owning session on the same warm empty state", () => {
    installAdeMock();
    renderSidebar({ tab: "terminal", activeSession: null, contextTarget: null });

    expect(screen.getByText("Start a shell in this lane")).toBeTruthy();
    expect(screen.getByText("ade terminal")).toBeTruthy();
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
    }, null);
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

  it("returns to the picker on Escape and parks the browser view on the way out", async () => {
    installAdeMock({});
    const onTabChange = vi.fn();
    const { container } = renderSidebar({
      tab: "browser",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
      onTabChange,
    });

    expect(screen.getByTestId("browser-panel")).toBeTruthy();
    fireEvent.keyDown(container.querySelector("aside")!, { key: "Escape" });

    expect(onTabChange).toHaveBeenCalledWith(null);
    await waitFor(() => {
      expect(window.ade.builtInBrowser.setBounds).toHaveBeenCalledWith(
        expect.objectContaining({ visible: false }),
      );
    });
  });

  it("offers an activity dot for another lane-usable tool that is live", async () => {
    installAdeMock({
      iosSession: { ...otherLaneIosSession, laneId: "lane-1", deviceName: "iPhone 17 Pro" },
    });
    const onTabChange = vi.fn();
    renderSidebar({ tab: "git", contextTarget: { kind: "chat", sessionId: "chat-1" }, onTabChange });

    const dot = await screen.findByRole("button", {
      name: "Switch to iOS Simulator — iPhone 17 Pro",
    });
    fireEvent.click(dot);
    expect(onTabChange).toHaveBeenCalledWith("ios");
  });

  it("hides the browser view for the pinned checkout, not the tab's project", async () => {
    installAdeMock({});
    useAppStore.setState({
      project: { rootPath: "/repo-one", name: "Repo One" },
    } as any);
    const browser = window.ade.builtInBrowser;
    const pin = {
      kind: "local" as const,
      key: "local:/repo-two",
      rootPath: "/repo-two",
      displayName: "Repo Two",
    };

    renderSidebar({
      tab: "browser",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
      runtimePin: pin,
    });

    // Every browser read the pane makes follows the pin, so a pinned checkout
    // never describes (or parks) the tab's own project's view.
    await waitFor(() => {
      expect(browser.getStatus).toHaveBeenCalledWith({ projectRoot: "/repo-two" }, pin);
    });

    fireEvent.click(screen.getByRole("button", { name: "Back to tools" }));

    await waitFor(() => {
      expect(browser.setBounds).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot: "/repo-two",
        visible: false,
      }));
    });
    expect(browser.stopInspect).toHaveBeenCalledWith({ projectRoot: "/repo-two" });
    expect(browser.setBounds).not.toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: "/repo-one",
    }));
  });

  it("disables the local-only tools for remote projects and falls back to the picker", async () => {
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

    // Every tool still has a card — an unavailable one says why rather than
    // vanishing — but only the remote-capable ones are clickable.
    expect(cardFor("Git").disabled).toBe(false);
    expect(cardFor("Files").disabled).toBe(false);
    expect(cardFor("Terminal").disabled).toBe(false);
    expect(cardFor("iOS Simulator").disabled).toBe(true);
    expect(cardFor("App Control").disabled).toBe(true);
    expect(cardFor("Browser").disabled).toBe(true);
    expect(screen.getAllByText("Runs on this computer only").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("browser-panel")).toBeNull();
    // The picker, not some other tool: being dumped into Git because the
    // browser is unavailable would be a non-sequitur.
    await waitFor(() => expect(onTabChange).toHaveBeenCalledWith(null));
    expect(window.ade.builtInBrowser.getStatus).not.toHaveBeenCalled();
    expect(window.ade.iosSimulator.getStatus).not.toHaveBeenCalled();
    expect(window.ade.appControl.getStatus).not.toHaveBeenCalled();
  });

  it("disables the macOS-only iOS Simulator card on Windows", async () => {
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "Win32",
    });
    const onTabChange = vi.fn();

    renderSidebar({
      tab: "ios",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
      onTabChange,
    });

    expect(cardFor("iOS Simulator").disabled).toBe(true);
    expect(screen.getByText("macOS only")).toBeTruthy();
    expect(cardFor("App Control").disabled).toBe(false);
    expect(cardFor("Browser").disabled).toBe(false);
    expect(screen.queryByTestId("ios-panel")).toBeNull();
    await waitFor(() => expect(onTabChange).toHaveBeenCalledWith(null));
    expect(window.ade.iosSimulator.getStatus).not.toHaveBeenCalled();
  });
});

describe("WorkSidebar live tool status", () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ project: null, projectBinding: null } as any);
    delete (window as unknown as { ade?: unknown }).ade;
    vi.restoreAllMocks();
  });

  /**
   * The pane with a terminal list that can change, plus the two events that can
   * change it. `installAdeMock` deliberately has neither, so this builds on it
   * rather than widening the mock every other test in this file shares.
   */
  function installLiveTerminalMock() {
    installAdeMock();
    const shells: Array<{ terminalId: string; ptyId: string; title: string; status: string }> = [];
    const sessionListeners: Array<() => void> = [];
    const list = vi.fn(async () => shells.map((shell) => ({ ...shell })));
    Object.assign(window.ade as Record<string, unknown>, {
      terminal: { ...(window.ade as { terminal: object }).terminal, list },
      sessions: {
        onChanged: vi.fn((cb: () => void) => {
          sessionListeners.push(cb);
          return () => {};
        }),
      },
      pty: { onExit: vi.fn(() => () => {}) },
    });
    return {
      list,
      startShell(title: string) {
        shells.push({ terminalId: `term-${shells.length + 1}`, ptyId: `pty-${shells.length + 1}`, title, status: "running" });
        for (const listener of sessionListeners) listener();
      },
    };
  }

  it("re-reads attached shells when a session appears, without remounting the pane", async () => {
    const live = installLiveTerminalMock();
    const { container } = render(withFeeds(null, (
      <WorkSidebar
        active
        laneId="lane-1"
        lanes={[lane]}
        activeSession={null}
        tool="terminal"
        onToolChange={vi.fn()}
        onClose={vi.fn()}
        contextTarget={{ kind: "chat", sessionId: "chat-1" }}
        contextDisabledReason={null}
      />
    )));

    // The defect: the header committed to this and never moved again.
    await waitFor(() => expect(screen.getByText("No shells")).toBeTruthy());
    const paneBefore = container.querySelector("aside");

    live.startShell("zsh");

    // The count is the whole line: shell titles are unbounded and truncated the
    // status at pane widths people actually use.
    await waitFor(() => expect(screen.getByText("1 shell")).toBeTruthy());
    expect(live.list).toHaveBeenCalledTimes(2);
    // Same <aside> node: the status is live, not the product of a remount.
    expect(container.querySelector("aside")).toBe(paneBefore);
  });
});

describe("WorkSidebar pane chrome", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "platform", { configurable: true, value: "MacIntel" });
    installAdeMock();
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ project: null, projectBinding: null } as any);
    delete (window as unknown as { ade?: unknown }).ade;
    if (originalNavigatorPlatform) {
      Object.defineProperty(window.navigator, "platform", originalNavigatorPlatform);
    }
    vi.restoreAllMocks();
  });

  it("mounts the PR pane chromeless and lifts its refresh into the shell header", async () => {
    renderSidebar({ tab: "pr", contextTarget: { kind: "chat", sessionId: "chat-1" } });

    // One header, not two: the pane surrenders its own title bar...
    expect(screen.getByTestId("pr-pane").getAttribute("data-chromeless")).toBe("true");
    // ...and does not lose its one action doing so.
    await waitFor(() => expect(screen.getByLabelText("Refresh pull request")).toBeTruthy());
    expect(screen.getAllByText("Pull request")).toHaveLength(1);
  });

  it("returns to the picker on Escape from inside the pane", () => {
    const onTabChange = vi.fn();
    const { container } = renderSidebar({
      tab: "git",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
      onTabChange,
    });

    const inside = container.querySelector("aside")!.querySelector("div")!;
    fireEvent.keyDown(inside, { key: "Escape" });
    expect(onTabChange).toHaveBeenCalledWith(null);
  });

  it("keeps Escape working after a picker card is clicked", () => {
    // The card that was clicked unmounts with the picker, and the browser then
    // drops focus onto <body> — where a keydown is never dispatched inside the
    // pane, so the pane's capture handler never saw it. Escape did nothing at
    // all, which is the one keystroke a pane you just opened has to honour.
    const onToolChange = vi.fn();
    const tree = (tool: WorkSidebarTab | null) => withFeeds(null, (
      <WorkSidebar
        active
        laneId="lane-1"
        lanes={[lane]}
        activeSession={activeSession}
        tool={tool}
        onToolChange={onToolChange}
        onClose={vi.fn()}
        contextTarget={{ kind: "chat", sessionId: "chat-1" }}
        contextDisabledReason={null}
      />
    ));
    const { container, rerender } = render(tree(null));

    const aside = container.querySelector("aside")!;
    fireEvent.click(cardFor("Git"));
    expect(onToolChange).toHaveBeenCalledWith("git");
    expect(document.activeElement).toBe(aside);

    // The pane is controlled, so the parent's answer to that pick is the tool
    // being on screen — which is the state Escape has to get you out of.
    rerender(tree("git"));
    fireEvent.keyDown(aside, { key: "Escape" });
    expect(onToolChange).toHaveBeenLastCalledWith(null);
  });

  it("takes Escape from <body> when the pane was the last thing clicked", () => {
    // The belt to the focus braces above: whatever drops focus — an unmounting
    // card, a panel that blurs itself — a keystroke that lands on <body> still
    // belongs to the surface the pointer last committed to.
    const onTabChange = vi.fn();
    const { container } = renderSidebar({
      tab: "git",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
      onTabChange,
    });

    const inside = container.querySelector("aside")!.querySelector("div")!;
    fireEvent.pointerDown(inside);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onTabChange).toHaveBeenCalledWith(null);
  });

  it("leaves a <body> Escape alone when the pointer last went somewhere else", () => {
    const onTabChange = vi.fn();
    renderSidebar({
      tab: "git",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
      onTabChange,
    });

    // The composer, say: its Escape is its own, and the pane must not race it.
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it("leaves plain Escape to the terminal and takes Shift+Escape instead", () => {
    const onTabChange = vi.fn();
    const { container } = renderSidebar({
      tab: "git",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
      onTabChange,
    });

    // Stand in for xterm's helper textarea: the pane identifies a terminal by
    // the `.xterm` container it always renders into.
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const textarea = document.createElement("textarea");
    xterm.appendChild(textarea);
    container.querySelector("aside")!.appendChild(xterm);

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onTabChange).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Escape", shiftKey: true });
    expect(onTabChange).toHaveBeenCalledWith(null);
  });

  it("leaves Escape to a tool that claimed it", () => {
    const onTabChange = vi.fn();
    const { container } = renderSidebar({
      tab: "git",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
      onTabChange,
    });

    // The browser's find bar marks itself: its Escape closes the find bar, and
    // the pane must not also take you back to the picker on the same keystroke.
    const findBar = document.createElement("div");
    findBar.setAttribute("data-ade-escape-scope", "browser-find");
    const input = document.createElement("input");
    findBar.appendChild(input);
    container.querySelector("aside")!.appendChild(findBar);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it("leaves Escape to a text field that has something to clear, but not to an empty one", () => {
    const onTabChange = vi.fn();
    const { container } = renderSidebar({
      tab: "git",
      contextTarget: { kind: "chat", sessionId: "chat-1" },
      onTabChange,
    });

    const field = document.createElement("input");
    field.value = "localhost:3000";
    container.querySelector("aside")!.appendChild(field);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onTabChange).not.toHaveBeenCalled();

    // An empty field has nothing to clear, so Escape is the pane's again.
    field.value = "";
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onTabChange).toHaveBeenCalledWith(null);
  });

  it("closes the pane on Escape at the picker, where there is nothing to go back to", () => {
    const onClose = vi.fn();
    const { container } = render(withFeeds(null, (
      <WorkSidebar
        active
        laneId="lane-1"
        lanes={[lane]}
        activeSession={activeSession}
        tool={null}
        onToolChange={vi.fn()}
        onClose={onClose}
        contextTarget={{ kind: "chat", sessionId: "chat-1" }}
        contextDisabledReason={null}
      />
    )));

    fireEvent.keyDown(container.querySelector("aside")!.querySelector("div")!, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("stands down while a modal layer owns Escape", () => {
    const onTabChange = vi.fn();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    try {
      const { container } = renderSidebar({
        tab: "git",
        contextTarget: { kind: "chat", sessionId: "chat-1" },
        onTabChange,
      });
      fireEvent.keyDown(container.querySelector("aside")!.querySelector("div")!, { key: "Escape" });
      expect(onTabChange).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });
});
