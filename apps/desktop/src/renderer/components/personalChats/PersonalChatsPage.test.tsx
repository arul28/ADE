/* @vitest-environment jsdom */

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatSessionSummary } from "../../../shared/types";
import type { ModelDescriptor } from "../../../shared/modelRegistry";

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

vi.mock("../chat/AgentChatMessageList", () => ({
  AgentChatMessageList: () => <div data-testid="message-list" />,
}));

vi.mock("../chat/ChatBuiltInBrowserPanel", () => ({
  ChatBuiltInBrowserPanel: () => <div data-testid="browser-panel" />,
}));

vi.mock("./PersonalTerminalPanel", () => ({
  PersonalTerminalPanel: () => <div data-testid="terminal-panel" />,
}));

const storeState = vi.hoisted(() => ({
  projectBinding: null as unknown,
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

type CallArgs = { action: string; args?: Record<string, unknown> };

const state = vi.hoisted(() => ({
  sessions: [] as AgentChatSessionSummary[],
  catalogAvailable: true,
  historyEvents: [] as Array<Record<string, unknown>>,
}));

function installBridge() {
  const call = vi.fn(async ({ action, args }: CallArgs) => {
    switch (action) {
      case "list":
        return { result: state.sessions };
      case "modelCatalog":
        return { result: { groups: [], fetchedAt: "", available: state.catalogAvailable } };
      case "getEventHistory":
        return { result: { sessionId: args?.sessionId, events: state.historyEvents } };
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
    state.sessions = [];
    state.catalogAvailable = true;
    state.historyEvents = [];
    storeState.chatChromeTint = "colored";
    installBridge();
  });

  afterEach(() => {
    cleanup();
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
});
