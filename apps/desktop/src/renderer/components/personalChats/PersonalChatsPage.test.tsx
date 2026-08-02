/* @vitest-environment jsdom */

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentChatEventEnvelope,
  AgentChatEventHistoryPage,
  AgentChatEventHistorySnapshot,
  AgentChatSessionSummary,
} from "../../../shared/types";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { ADE_OPEN_BUILT_IN_BROWSER_EVENT, openUrlInAdeBrowser } from "../../lib/openExternal";

// Deliberately a LIGHT accent (Codex-style) so the contrast tests can tell the
// colored path (dark glyph) apart from the neutral-tint path (white glyph).
const FAKE_MODEL = {
  id: "fake-model",
  shortId: "fake",
  displayName: "Fake Model",
  family: "claude",
  color: "#E7E5E4",
  capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
} as unknown as ModelDescriptor;

// The catalog→descriptor transform is not the unit under test; a small stub lets
// each case flip provider availability deterministically.
vi.mock("../shared/ModelPicker/modelCatalog", () => ({
  descriptorsFromAgentChatModelCatalog: (catalog: { available?: boolean } | null | undefined) => ({
    models: [FAKE_MODEL],
    availableModelIds: catalog?.available === false ? [] : ["fake-model"],
  }),
}));

vi.mock("../shared/ModelPicker/ModelPicker", () => ({
  ModelPicker: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="model-picker" data-disabled={disabled ? "true" : "false"} />
  ),
}));

vi.mock("../shared/ModelPicker/ReasoningEffortPicker", () => ({
  ReasoningEffortPicker: () => <div data-testid="reasoning-picker" />,
}));

type MessageListHarnessProps = {
  events: AgentChatEventEnvelope[];
  sessionId?: string | null;
  hasOlderHistory?: boolean;
  loadingOlderHistory?: boolean;
  olderHistoryError?: string | null;
  onLoadOlderHistory?: () => void;
  onRetryOlderHistory?: () => void;
};

vi.mock("../chat/AgentChatMessageList", () => ({
  AgentChatMessageList: (props: MessageListHarnessProps) => {
    const texts = props.events
      .map((event) => {
        const body = event.event as unknown as Record<string, unknown>;
        return typeof body.text === "string" ? body.text : "";
      })
      .filter(Boolean)
      .join("|");
    return (
      <div
        data-testid="message-list"
        data-session-id={props.sessionId ?? ""}
        data-event-texts={texts}
        data-has-older={props.hasOlderHistory ? "true" : "false"}
        data-loading-older={props.loadingOlderHistory ? "true" : "false"}
        data-older-error={props.olderHistoryError ?? ""}
      >
        <button
          type="button"
          data-testid="load-older"
          onClick={() => (props.olderHistoryError ? props.onRetryOlderHistory?.() : props.onLoadOlderHistory?.())}
        >
          Load older
        </button>
      </div>
    );
  },
}));

vi.mock("../chat/ChatBuiltInBrowserPanel", () => ({
  ChatBuiltInBrowserPanel: () => <div data-testid="browser-panel" />,
}));

vi.mock("./PersonalTerminalPanel", () => ({
  PersonalTerminalPanel: () => <div data-testid="terminal-panel" />,
}));

const storeState = vi.hoisted(() => ({
  projectBinding: null as unknown,
  openRemoteProjectTabs: [] as unknown[],
  openProjectTabRoots: [] as string[],
  project: null as unknown,
  switchProjectToPath: () => Promise.resolve(),
  switchRemoteProject: () => Promise.resolve(),
  chatFontSizePx: 13,
  chatTranscriptDensity: "comfortable",
  chatChromeTint: "colored",
  chatShellGeometry: "default",
}));

vi.mock("../../state/appStore", () => ({
  useAppStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}));

function makeSession(overrides: Partial<AgentChatSessionSummary>): AgentChatSessionSummary {
  return {
    sessionId: "s1",
    laneId: "",
    provider: "claude",
    model: "fake-model",
    modelId: "fake-model",
    status: "idle",
    startedAt: new Date().toISOString(),
    endedAt: null,
    lastActivityAt: new Date().toISOString(),
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
    ...overrides,
  } as unknown as AgentChatSessionSummary;
}

function makeHistoryEvent(args: {
  sessionId?: string;
  sequence: number;
  text: string;
  timestamp: string;
}): AgentChatEventEnvelope {
  return {
    sessionId: args.sessionId ?? "s1",
    sequence: args.sequence,
    timestamp: args.timestamp,
    event: { type: "assistant", text: args.text },
  } as unknown as AgentChatEventEnvelope;
}

type CallArgs = { action: string; args?: Record<string, unknown> };

const state = vi.hoisted(() => ({
  sessions: [] as AgentChatSessionSummary[],
  catalogAvailable: true,
  historyEvents: [] as Array<Record<string, unknown>>,
  historySnapshotHandler: null as null | (
    (sessionId: string) => AgentChatEventHistorySnapshot | Promise<AgentChatEventHistorySnapshot>
  ),
  historyPageHandler: null as null | (
    (args: Record<string, unknown>) => AgentChatEventHistoryPage | Promise<AgentChatEventHistoryPage>
  ),
}));

function installBridge() {
  const call = vi.fn(async ({ action, args }: CallArgs) => {
    switch (action) {
      case "list":
        return { result: state.sessions };
      case "modelCatalog":
        return { result: { groups: [], fetchedAt: "", available: state.catalogAvailable } };
      case "getEventHistory": {
        const sessionId = String(args?.sessionId ?? "");
        return {
          result: state.historySnapshotHandler
            ? await state.historySnapshotHandler(sessionId)
            : {
              sessionId,
              events: state.historyEvents,
              sessionFound: true,
              hasOlderHistory: false,
              tailStartOffset: 0,
            },
        };
      }
      case "getEventHistoryPage":
        return {
          result: state.historyPageHandler
            ? await state.historyPageHandler(args ?? {})
            : {
              sessionId: String(args?.sessionId ?? ""),
              events: [],
              sessionFound: true,
              startOffset: 0,
              hasMore: false,
            },
        };
      default:
        return { result: undefined };
    }
  });
  const streamEvents = vi.fn(async () => ({ events: [], nextCursor: 0, hasMore: false }));
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: { personalChats: { call, streamEvents } },
  });
  return { call, streamEvents };
}

async function renderPage() {
  const { PersonalChatsPage } = await import("./PersonalChatsPage");
  return render(
    <MemoryRouter initialEntries={["/chats"]}>
      <PersonalChatsPage standalone />
    </MemoryRouter>,
  );
}

describe("PersonalChatsPage", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete window.__adeWebClient;
    state.sessions = [];
    state.catalogAvailable = true;
    state.historyEvents = [];
    state.historySnapshotHandler = null;
    state.historyPageHandler = null;
    storeState.chatChromeTint = "colored";
    storeState.projectBinding = null;
    storeState.openRemoteProjectTabs = [];
    installBridge();
  });

  afterEach(() => {
    cleanup();
    delete window.__adeWebClient;
  });

  it("renders the hero (greeting + composer + chips) with the composer inside the canvas and no shell footer", async () => {
    await renderPage();

    expect(await screen.findByText("What can I help with?")).toBeTruthy();
    const textarea = screen.getByLabelText("Message an ADE agent");
    // Composer lives in the hero canvas (variant "hero"), not in the docked footer.
    expect(textarea.closest("[data-composer-variant]")?.getAttribute("data-composer-variant")).toBe("hero");
    expect(screen.getByText("Think through a decision")).toBeTruthy();
  });

  it("pre-fills the draft when a suggestion chip is clicked", async () => {
    await renderPage();

    await screen.findByText("What can I help with?");
    fireEvent.click(screen.getByText("Draft from a rough idea"));

    const textarea = screen.getByLabelText("Message an ADE agent") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("Help me draft this from a rough idea: "));
  });

  it("docks the composer in the footer once a selected session has events", async () => {
    state.sessions = [makeSession({ title: "My chat" })];
    state.historyEvents = [
      { sessionId: "s1", timestamp: new Date().toISOString(), sequence: 1, event: { type: "assistant", text: "hi" } },
    ];
    await renderPage();

    fireEvent.click(await screen.findByText("My chat"));

    expect(await screen.findByTestId("message-list")).toBeTruthy();
    const textarea = screen.getByLabelText("Message an ADE agent");
    expect(textarea.closest("[data-composer-variant]")?.getAttribute("data-composer-variant")).toBe("docked");
  });

  it("pages through empty cursor windows and prepends older transcript events", async () => {
    const newer = makeHistoryEvent({
      sequence: 2,
      text: "newer",
      timestamp: "2026-07-28T12:00:00.000Z",
    });
    const older = makeHistoryEvent({
      sequence: 1,
      text: "older",
      timestamp: "2026-07-28T11:00:00.000Z",
    });
    state.sessions = [makeSession({ title: "Paged chat" })];
    state.historySnapshotHandler = async (sessionId) => ({
      sessionId,
      events: [newer],
      sessionFound: true,
      truncated: true,
      hasOlderHistory: true,
      tailStartOffset: 4_096,
    });
    state.historyPageHandler = async (args) => (
      args.beforeOffset === 4_096
        ? {
          sessionId: "s1",
          events: [],
          sessionFound: true,
          startOffset: 2_048,
          hasMore: true,
        }
        : {
          sessionId: "s1",
          events: [older],
          sessionFound: true,
          startOffset: 0,
          hasMore: false,
        }
    );
    await renderPage();

    fireEvent.click(await screen.findByText("Paged chat"));
    const list = await screen.findByTestId("message-list");
    await waitFor(() => expect(list.getAttribute("data-has-older")).toBe("true"));
    fireEvent.click(screen.getByTestId("load-older"));

    await waitFor(() => {
      expect(list.getAttribute("data-event-texts")).toBe("older|newer");
      expect(list.getAttribute("data-has-older")).toBe("false");
    });
    const call = (window as unknown as { ade: { personalChats: { call: ReturnType<typeof vi.fn> } } })
      .ade.personalChats.call;
    const pageCalls = call.mock.calls.filter((callArgs) => (callArgs[0] as CallArgs).action === "getEventHistoryPage");
    expect(pageCalls.map((callArgs) => callArgs[0] as CallArgs)).toEqual([
      {
        action: "getEventHistoryPage",
        args: { sessionId: "s1", beforeOffset: 4_096, maxBytes: 262_144 },
      },
      {
        action: "getEventHistoryPage",
        args: { sessionId: "s1", beforeOffset: 2_048, maxBytes: 262_144 },
      },
    ]);
  });

  it("keeps the cursor and visible error while an interactive page retry is running", async () => {
    const newer = makeHistoryEvent({
      sequence: 2,
      text: "newer",
      timestamp: "2026-07-28T12:00:00.000Z",
    });
    const older = makeHistoryEvent({
      sequence: 1,
      text: "older",
      timestamp: "2026-07-28T11:00:00.000Z",
    });
    state.sessions = [makeSession({ title: "Retry chat" })];
    state.historySnapshotHandler = async (sessionId) => ({
      sessionId,
      events: [newer],
      sessionFound: true,
      truncated: true,
      hasOlderHistory: true,
      tailStartOffset: 4_096,
    });
    let pageCallCount = 0;
    let resolveRetry: (page: AgentChatEventHistoryPage) => void = () => {};
    const pendingRetry = new Promise<AgentChatEventHistoryPage>((resolve) => {
      resolveRetry = resolve;
    });
    state.historyPageHandler = async () => {
      pageCallCount += 1;
      if (pageCallCount === 1) {
        return {
          sessionId: "s1",
          events: [],
          sessionFound: false,
          unavailable: true,
          startOffset: 0,
          hasMore: false,
        };
      }
      return pendingRetry;
    };
    await renderPage();

    fireEvent.click(await screen.findByText("Retry chat"));
    const list = await screen.findByTestId("message-list");
    await waitFor(() => expect(list.getAttribute("data-has-older")).toBe("true"));
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => {
      expect(list.getAttribute("data-older-error")).toContain("temporarily unavailable");
      expect(list.getAttribute("data-loading-older")).toBe("false");
      expect(list.getAttribute("data-has-older")).toBe("true");
    });

    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => {
      expect(list.getAttribute("data-loading-older")).toBe("true");
      expect(list.getAttribute("data-older-error")).toContain("temporarily unavailable");
    });
    expect(pageCallCount).toBe(2);
    await act(async () => {
      resolveRetry({
        sessionId: "s1",
        events: [older],
        sessionFound: true,
        startOffset: 0,
        hasMore: false,
      });
    });
    await waitFor(() => {
      expect(list.getAttribute("data-loading-older")).toBe("false");
      expect(list.getAttribute("data-older-error")).toBe("");
      expect(list.getAttribute("data-has-older")).toBe("false");
      expect(list.getAttribute("data-event-texts")).toBe("older|newer");
    });
    const call = (window as unknown as { ade: { personalChats: { call: ReturnType<typeof vi.fn> } } })
      .ade.personalChats.call;
    const pageCalls = call.mock.calls.filter((callArgs) => (callArgs[0] as CallArgs).action === "getEventHistoryPage");
    expect(pageCalls.map((callArgs) => (callArgs[0] as CallArgs).args?.beforeOffset)).toEqual([4_096, 4_096]);
  });

  it("preserves distinct events whose provider sequence restarted across transcript hydration", async () => {
    const newer = makeHistoryEvent({
      sequence: 1,
      text: "new run",
      timestamp: "2026-07-28T12:00:00.000Z",
    });
    const olderSameSequence = makeHistoryEvent({
      sequence: 1,
      text: "older run",
      timestamp: "2026-07-28T11:00:00.000Z",
    });
    const otherChat = makeHistoryEvent({
      sessionId: "s2",
      sequence: 1,
      text: "other chat",
      timestamp: "2026-07-28T12:00:00.000Z",
    });
    state.sessions = [
      makeSession({ sessionId: "s1", title: "Restarted sequence" }),
      makeSession({ sessionId: "s2", title: "Other chat" }),
    ];
    state.historySnapshotHandler = async (sessionId) => ({
      sessionId,
      events: [sessionId === "s1" ? newer : otherChat],
      sessionFound: true,
      truncated: sessionId === "s1",
      hasOlderHistory: sessionId === "s1",
      tailStartOffset: sessionId === "s1" ? 4_096 : 0,
    });
    state.historyPageHandler = async () => ({
      sessionId: "s1",
      events: [olderSameSequence],
      sessionFound: true,
      startOffset: 0,
      hasMore: false,
    });
    await renderPage();

    fireEvent.click(await screen.findByText("Restarted sequence"));
    await screen.findByTestId("message-list");
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => {
      expect(screen.getByTestId("message-list").getAttribute("data-event-texts")).toBe("older run|new run");
    });

    fireEvent.click(screen.getByText("Other chat"));
    await waitFor(() => {
      expect(screen.getByTestId("message-list").getAttribute("data-event-texts")).toBe("other chat");
    });
    fireEvent.click(screen.getByText("Restarted sequence"));
    await waitFor(() => {
      expect(screen.getByTestId("message-list").getAttribute("data-event-texts")).toBe("older run|new run");
    });
  });

  it("ignores a late older page after switching chats", async () => {
    const newestA = makeHistoryEvent({
      sequence: 2,
      text: "newest A",
      timestamp: "2026-07-28T12:00:00.000Z",
    });
    const newestB = makeHistoryEvent({
      sessionId: "s2",
      sequence: 2,
      text: "newest B",
      timestamp: "2026-07-28T12:00:00.000Z",
    });
    const staleOlderA = makeHistoryEvent({
      sequence: 1,
      text: "stale older A",
      timestamp: "2026-07-28T11:00:00.000Z",
    });
    state.sessions = [
      makeSession({ sessionId: "s1", title: "Chat A" }),
      makeSession({ sessionId: "s2", title: "Chat B" }),
    ];
    state.historySnapshotHandler = async (sessionId) => ({
      sessionId,
      events: [sessionId === "s1" ? newestA : newestB],
      sessionFound: true,
      truncated: true,
      hasOlderHistory: true,
      tailStartOffset: 4_096,
    });
    let resolvePage: (page: AgentChatEventHistoryPage) => void = () => {};
    state.historyPageHandler = () => new Promise<AgentChatEventHistoryPage>((resolve) => {
      resolvePage = resolve;
    });
    await renderPage();

    fireEvent.click(await screen.findByText("Chat A"));
    const list = await screen.findByTestId("message-list");
    await waitFor(() => expect(list.getAttribute("data-event-texts")).toBe("newest A"));
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => expect(list.getAttribute("data-loading-older")).toBe("true"));
    fireEvent.click(screen.getByText("Chat B"));
    await waitFor(() => {
      expect(screen.getByTestId("message-list").getAttribute("data-session-id")).toBe("s2");
      expect(screen.getByTestId("message-list").getAttribute("data-event-texts")).toBe("newest B");
    });

    await act(async () => {
      resolvePage({
        sessionId: "s1",
        events: [staleOlderA],
        sessionFound: true,
        startOffset: 0,
        hasMore: false,
      });
    });
    expect(screen.getByTestId("message-list").getAttribute("data-event-texts")).toBe("newest B");

    fireEvent.click(screen.getByText("Chat A"));
    await waitFor(() => {
      expect(screen.getByTestId("message-list").getAttribute("data-session-id")).toBe("s1");
      expect(screen.getByTestId("message-list").getAttribute("data-event-texts")).toBe("newest A");
      expect(screen.getByTestId("message-list").getAttribute("data-has-older")).toBe("true");
    });
  });

  it("filters the session list by the search query", async () => {
    state.sessions = [
      makeSession({ sessionId: "s1", title: "Alpha chat" }),
      makeSession({ sessionId: "s2", title: "Beta chat" }),
    ];
    await renderPage();

    await screen.findByText("Alpha chat");
    expect(screen.getByText("Beta chat")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "Alpha" } });

    await waitFor(() => expect(screen.queryByText("Beta chat")).toBeNull());
    expect(screen.getByText("Alpha chat")).toBeTruthy();
  });

  it("shows the empty-list message when there are no chats", async () => {
    await renderPage();
    expect(await screen.findByText(/No chats yet/)).toBeTruthy();
  });

  it("disables send and shows a notice when no provider is available", async () => {
    state.catalogAvailable = false;
    await renderPage();

    expect(await screen.findByText(/No connected agent is available/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message an ADE agent"), { target: { value: "hello" } });

    const sendButton = screen.getByLabelText("Send message") as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(true));
  });

  it("paints the send button with the provider chat accent", async () => {
    await renderPage();

    await screen.findByText("What can I help with?");
    const sendButton = screen.getByLabelText("Send message") as HTMLButtonElement;
    expect(sendButton.className).toContain("bg-[color:var(--chat-accent)]");
    // Light provider accent on colored tint → dark glyph for contrast. The
    // glyph color lands only after the catalog load resolves the fallback
    // modelId, so wait rather than asserting the first paint.
    await waitFor(() => expect(sendButton.style.color).toBe("rgb(28, 25, 23)"));
  });

  it("keeps the hero and composer visible while the initial fetch is still loading", async () => {
    let resolveList: (rows: AgentChatSessionSummary[]) => void = () => {};
    const pendingList = new Promise<AgentChatSessionSummary[]>((resolve) => { resolveList = resolve; });
    const bridge = (window as unknown as { ade: { personalChats: { call: ReturnType<typeof vi.fn> } } });
    installBridge();
    bridge.ade.personalChats.call.mockImplementation(async ({ action }: CallArgs) => {
      if (action === "list") return { result: await pendingList };
      if (action === "modelCatalog") return { result: await pendingList.then(() => ({ groups: [], fetchedAt: "", available: true })) };
      return { result: undefined };
    });
    await renderPage();

    // Composer paints immediately; an in-flight catalog is not "no provider".
    expect(await screen.findByText("What can I help with?")).toBeTruthy();
    expect(screen.getByLabelText("Message an ADE agent")).toBeTruthy();
    expect(screen.queryByText(/No connected agent is available/)).toBeNull();

    resolveList([]);
    await waitFor(() => expect(screen.getByText(/No chats yet/)).toBeTruthy());
  });

  it("finishes chat-list loading without waiting for the model catalog", async () => {
    state.sessions = [makeSession({ title: "Ready chat" })];
    const pendingCatalog = new Promise<never>(() => {});
    const bridge = (window as unknown as { ade: { personalChats: { call: ReturnType<typeof vi.fn> } } });
    bridge.ade.personalChats.call.mockImplementation(async ({ action }: CallArgs) => {
      if (action === "list") return { result: state.sessions };
      if (action === "modelCatalog") return await pendingCatalog;
      return { result: undefined };
    });

    await renderPage();

    expect(await screen.findByText("Ready chat")).toBeTruthy();
    const sidebar = screen.getByText("Chats").closest("aside");
    await waitFor(() => expect(sidebar?.querySelector(".animate-spin")).toBeNull());
  });

  it("routes transcript link requests into the visible personal browser collection", async () => {
    const navigate = vi.fn(async () => undefined);
    const current = window.ade;
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ...current, builtInBrowser: { navigate } },
    });
    await renderPage();

    window.dispatchEvent(new CustomEvent(ADE_OPEN_BUILT_IN_BROWSER_EVENT, {
      detail: { url: "https://example.test/docs" },
      cancelable: true,
    }));

    expect(await screen.findByTestId("browser-panel")).toBeTruthy();
    expect(navigate).toHaveBeenCalledWith({
      url: "https://example.test/docs",
      newTab: true,
      tabCollection: "personal",
    });
  });

  it("claims valid link requests and shows an ADE error when the browser bridge is missing", async () => {
    const openExternal = vi.fn(async () => undefined);
    const current = window.ade;
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ...current, app: { openExternal }, builtInBrowser: undefined },
    });
    await renderPage();

    const handled = !window.dispatchEvent(new CustomEvent(ADE_OPEN_BUILT_IN_BROWSER_EVENT, {
      detail: { url: "https://example.test/docs" },
      cancelable: true,
    }));

    expect(handled).toBe(true);
    expect(await screen.findByTestId("browser-panel")).toBeTruthy();
    expect(await screen.findByText("ADE Browser couldn't open that link. Try again.")).toBeTruthy();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("leaves hosted-web link requests unclaimed so they can fall back externally", async () => {
    const openExternal = vi.fn(async () => undefined);
    const current = window.ade;
    window.__adeWebClient = true;
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ...current, app: { openExternal }, builtInBrowser: undefined },
    });
    await renderPage();

    openUrlInAdeBrowser("https://example.test/docs");

    expect(openExternal).toHaveBeenCalledWith("https://example.test/docs");
    expect(screen.queryByTestId("browser-panel")).toBeNull();
    expect(screen.queryByText("ADE Browser couldn't open that link. Try again.")).toBeNull();
  });

  it("shows an ADE error instead of surprise-opening Safari when personal link navigation fails", async () => {
    const openExternal = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => {
      throw new Error("browser unavailable");
    });
    const current = window.ade;
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ...current, app: { openExternal }, builtInBrowser: { navigate } },
    });
    await renderPage();

    window.dispatchEvent(new CustomEvent(ADE_OPEN_BUILT_IN_BROWSER_EVENT, {
      detail: { url: "https://example.test/docs" },
      cancelable: true,
    }));

    expect(await screen.findByText("ADE Browser couldn't open that link. Try again.")).toBeTruthy();
    expect(navigate).toHaveBeenCalledWith({
      url: "https://example.test/docs",
      newTab: true,
      tabCollection: "personal",
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("docks (not hero) when selecting a session whose events have not loaded yet", async () => {
    state.sessions = [makeSession({ title: "Empty chat" })];
    state.historyEvents = [];
    await renderPage();

    fireEvent.click(await screen.findByText("Empty chat"));

    await waitFor(() => {
      const textarea = screen.getByLabelText("Message an ADE agent");
      expect(textarea.closest("[data-composer-variant]")?.getAttribute("data-composer-variant")).toBe("docked");
    });
    expect(screen.queryByText("What can I help with?")).toBeNull();
    // Exactly one composer instance — the hero variant must not linger alongside the docked one.
    expect(screen.getAllByLabelText("Message an ADE agent")).toHaveLength(1);
    // Once history settles empty, a stable empty state replaces the spinner.
    expect(await screen.findByText("No messages in this chat yet.")).toBeTruthy();
  });

  it("does not submit when Enter confirms an IME composition", async () => {
    await renderPage();

    await screen.findByText("What can I help with?");
    const textarea = screen.getByLabelText("Message an ADE agent");
    fireEvent.change(textarea, { target: { value: "こんにちは" } });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });

    const bridge = (window as unknown as { ade: { personalChats: { call: ReturnType<typeof vi.fn> } } });
    const sendish = bridge.ade.personalChats.call.mock.calls.filter((call) => {
      const arg = call[0] as CallArgs | undefined;
      return arg?.action === "create" || arg?.action === "send";
    });
    expect(sendish).toHaveLength(0);
    expect((textarea as HTMLTextAreaElement).value).toBe("こんにちは");
  });

  it("computes the send glyph contrast from the tint-resolved accent in neutral chrome", async () => {
    storeState.chatChromeTint = "neutral";
    await renderPage();

    await screen.findByText("What can I help with?");
    const sendButton = screen.getByLabelText("Send message") as HTMLButtonElement;
    // Neutral tint paints the fill gray (#52525b), so the glyph must stay white
    // even though the provider accent alone would demand a dark glyph.
    await waitFor(() => expect(sendButton.style.color).toBe("rgb(255, 255, 255)"));
    expect(sendButton.className).toContain("bg-[color:var(--chat-accent)]");
  });

  it("names the chats machine absolutely and offers every open machine", async () => {
    const remoteTab = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "MacBook Pro (97)",
      projectId: "project-1",
      rootPath: "/remote/ADE",
      displayName: "ADE",
    };
    storeState.openRemoteProjectTabs = [remoteTab];
    await renderPage();

    // Composed from THIS_MACHINE_NAME, not spelled out: the local machine's
    // absolute name is the helper's to define (it stopped being "This Mac" when
    // ADE started running on Windows), and this assertion is about the sentence
    // shape, not the noun.
    const trigger = await screen.findByRole("button", {
      name: `Chats run on ${THIS_MACHINE_NAME}. Choose a machine.`,
    });
    // "This machine" was ambiguous once a tab's machine became switchable.
    expect(document.body.textContent).not.toMatch(/this machine/i);

    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: /MacBook Pro \(97\)/ })).toBeTruthy();
  });

  it("names the bound machine when the window runs on another Mac", async () => {
    storeState.projectBinding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "MacBook Pro (97)",
      projectId: "project-1",
      rootPath: "/remote/ADE",
      displayName: "ADE",
    };
    await renderPage();

    expect(
      await screen.findByRole("button", {
        name: "Chats run on MacBook Pro (97). Choose a machine.",
      }),
    ).toBeTruthy();
  });
});
