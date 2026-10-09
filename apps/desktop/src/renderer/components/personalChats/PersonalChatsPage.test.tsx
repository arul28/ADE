/* @vitest-environment jsdom */

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatSessionSummary } from "../../../shared/types";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { ADE_OPEN_BUILT_IN_BROWSER_EVENT, openUrlInAdeBrowser } from "../../lib/openExternal";
import { useAppStore } from "../../state/appStore";
import { resetModelPickerRuntimeCatalogForTests } from "../shared/ModelPicker/runtimeCatalogCache";

// The page renders the real chat pane over `window.ade.personalChats` (the IPC
// boundary these tests fake). The catalog→descriptor transform is not the unit
// under test; a small stub lets each case flip provider availability.
const FAKE_MODEL = {
  id: "fake-model",
  shortId: "fake",
  displayName: "Fake Model",
  family: "claude",
  color: "#E7E5E4",
  capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
} as unknown as ModelDescriptor;

vi.mock("../shared/ModelPicker/modelCatalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/ModelPicker/modelCatalog")>();
  return {
    ...actual,
    descriptorsFromAgentChatModelCatalog: (catalog: { available?: boolean } | null | undefined) => ({
      models: [FAKE_MODEL],
      availableModelIds: catalog?.available === false ? [] : ["fake-model"],
    }),
  };
});

const webChatsState = vi.hoisted(() => ({
  picker: null as null | {
    machineId: string | null;
    machineLabel: string | null;
    options: Array<{ id: string; name: string }>;
    select: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("../../webclient/workspace/useWebChatsMachines", () => ({
  useWebChatsMachines: () => webChatsState.picker,
}));

// Native surfaces (an Electron WebContentsView, a PTY) with nothing to render
// in jsdom. The tests only need to know the page opened them.
vi.mock("../chat/ChatBuiltInBrowserPanel", () => ({
  ChatBuiltInBrowserPanel: () => <div data-testid="browser-panel" />,
}));

vi.mock("./PersonalTerminalPanel", () => ({
  PersonalTerminalPanel: () => <div data-testid="terminal-panel" />,
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
    surface: "personal",
    ...overrides,
  } as unknown as AgentChatSessionSummary;
}

type CallArgs = { action: string; args?: Record<string, unknown> };

const state = vi.hoisted(() => ({
  sessions: [] as AgentChatSessionSummary[],
  catalogAvailable: true,
}));

/**
 * `window.ade` as the preload exposes it: every namespace the pane touches
 * exists. Namespaces a test names are used as given (an explicit `undefined`
 * stays missing); any other one answers subscriptions with a no-op unsubscribe
 * and calls with nothing.
 */
function fakeAdeBridge(explicit: Record<string, unknown>): Record<string, unknown> {
  const idleNamespace = new Proxy({}, {
    get: (_target, key) => (typeof key === "string" && /^on[A-Z]/.test(key)
      ? () => () => undefined
      : async () => undefined),
  });
  return new Proxy(explicit, {
    get: (target, key) => (key in target ? target[key as string] : idleNamespace),
  });
}

function setAdeBridge(explicit: Record<string, unknown>) {
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: fakeAdeBridge(explicit),
  });
}

function installBridge(extra: Record<string, unknown> = {}) {
  const call = vi.fn(async ({ action, args }: CallArgs) => {
    switch (action) {
      case "list":
        return { result: state.sessions };
      case "modelCatalog":
        return { result: { groups: [], fetchedAt: "", available: state.catalogAvailable } };
      case "getEventHistory":
        return {
          result: {
            sessionId: String(args?.sessionId ?? ""),
            events: [],
            sessionFound: true,
            hasOlderHistory: false,
            tailStartOffset: 0,
          },
        };
      default:
        return { result: undefined };
    }
  });
  const streamEvents = vi.fn(async () => ({ events: [], nextCursor: 0, hasMore: false }));
  setAdeBridge({ personalChats: { call, streamEvents }, ...extra });
  return { call, streamEvents };
}

function seedStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    project: null,
    projectBinding: null,
    openRemoteProjectTabs: [],
    openProjectTabRoots: [],
    ...overrides,
  } as never);
}

async function renderPage() {
  const { PersonalChatsPage } = await import("./PersonalChatsPage");
  return render(
    <MemoryRouter initialEntries={["/chats"]}>
      <PersonalChatsPage standalone />
    </MemoryRouter>,
  );
}

function composerText(): string {
  const field = screen.getByRole("textbox", { name: /Ask anything/i });
  return field instanceof HTMLTextAreaElement ? field.value : field.textContent ?? "";
}

describe("PersonalChatsPage", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    delete window.__adeWebClient;
    webChatsState.picker = null;
    resetModelPickerRuntimeCatalogForTests();
    state.sessions = [];
    state.catalogAvailable = true;
    seedStore();
    installBridge();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete window.__adeWebClient;
  });

  it("keys catalog reload off the hosted web machine catalog id", async () => {
    webChatsState.picker = {
      machineId: "catalog-machine-a",
      machineLabel: "Studio A",
      options: [{ id: "catalog-machine-a", name: "Studio A" }],
      select: vi.fn(async () => null),
    };
    await renderPage();
    const page = await screen.findByTestId("personal-chats-page");
    expect(page.getAttribute("data-target")).toBe("web:catalog-machine-a");
  });

  it("forces a personal catalog refresh when refresh-stale returns no available models", async () => {
    const { call } = installBridge();
    await renderPage();
    await waitFor(() => {
      const modes = call.mock.calls
        .filter((entry) => entry[0]?.action === "modelCatalog")
        .map((entry) => entry[0]?.args?.mode);
      expect(modes).toContain("refresh-stale");
      expect(modes).toContain("force");
    });
  });

  it.each([
    ["Draft from a rough idea", "Help me draft this from a rough idea: "],
    ["Research a topic", "Research this topic with me: "],
  ])("fills the new chat's composer when the %s chip is clicked", async (label, prefill) => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: label }));

    await waitFor(() => expect(composerText()).toBe(prefill));
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

  it("shows a notice and no suggestions when no provider is available", async () => {
    state.catalogAvailable = false;
    await renderPage();

    expect(await screen.findByText(/No connected agent is available/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Research a topic" })).toBeNull();
  });

  it("finishes chat-list loading without waiting for the model catalog", async () => {
    state.sessions = [makeSession({ title: "Ready chat" })];
    const pendingCatalog = new Promise<never>(() => {});
    const { call } = installBridge();
    call.mockImplementation(async ({ action }: CallArgs) => {
      if (action === "list") return { result: state.sessions };
      if (action === "modelCatalog") return await pendingCatalog;
      return { result: undefined };
    });

    await renderPage();

    expect(await screen.findByText("Ready chat")).toBeTruthy();
  });

  it("routes transcript link requests into the visible personal browser collection", async () => {
    const navigate = vi.fn(async () => undefined);
    installBridge({ builtInBrowser: { navigate } });
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
    installBridge({ app: { openExternal }, builtInBrowser: undefined });
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
    window.__adeWebClient = true;
    installBridge({ app: { openExternal }, builtInBrowser: undefined });
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
    installBridge({ app: { openExternal }, builtInBrowser: { navigate } });
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

  it("names the chats machine absolutely and offers every open machine", async () => {
    seedStore({
      openRemoteProjectTabs: [{
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "MacBook Pro (97)",
        projectId: "project-1",
        rootPath: "/remote/ADE",
        displayName: "ADE",
      }],
    });
    await renderPage();

    // Composed from THIS_MACHINE_NAME, not spelled out: the local machine's
    // absolute name is the helper's to define (it stopped being "This Mac" when
    // ADE started running on Windows), and this assertion is about the sentence
    // shape, not the noun.
    const trigger = await screen.findByRole("button", {
      name: `Chats run on ${THIS_MACHINE_NAME}. Choose a machine.`,
    });

    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: /MacBook Pro \(97\)/ })).toBeTruthy();
  });

  it("names the bound machine when the window runs on another computer", async () => {
    seedStore({
      projectBinding: {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "MacBook Pro (97)",
        projectId: "project-1",
        rootPath: "/remote/ADE",
        displayName: "ADE",
      },
    });
    await renderPage();

    expect(
      await screen.findByRole("button", {
        name: "Chats run on MacBook Pro (97). Choose a machine.",
      }),
    ).toBeTruthy();
  });
  it("never calls the project chat API from an open personal chat", async () => {
    // Every project-runtime call is recorded: `window.ade.agentChat` is the
    // project's chat domain, and a personal pane must reach only
    // `personalChats.*` — sends, stashes (Ctrl+S), diffs, voice, handoff.
    const projectCalls: string[] = [];
    const recorder = (name: string): unknown => new Proxy(
      (..._args: unknown[]) => { projectCalls.push(name); return Promise.resolve(undefined); },
      { get: (_target, key) => (typeof key === "string" && key !== "then" ? recorder(`${name}.${key}`) : undefined) },
    );
    state.sessions = [makeSession({ sessionId: "s1", title: "Trip plan" })];
    const { call } = installBridge({ agentChat: recorder("agentChat") });
    const base = call.getMockImplementation()!;
    call.mockImplementation((async (request: CallArgs) => (
      request.action === "getSummary" || request.action === "updateSession"
        ? { result: state.sessions[0] }
        : await base(request)
    )) as never);
    await renderPage();

    fireEvent.click(await screen.findByText("Trip plan"));
    await waitFor(() => {
      expect(call.mock.calls.some(([request]) => request.action === "getEventHistory")).toBe(true);
    });
    const field = await screen.findByRole("textbox", { name: /Ask anything/i });
    fireEvent.change(field, { target: { value: "Book the train" } });
    fireEvent.keyDown(field, { key: "s", ctrlKey: true });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => {
      expect(call.mock.calls.some(([request]) => request.action === "send" && request.args?.sessionId === "s1")).toBe(true);
    });
    expect(projectCalls).toEqual([]);
  });

  it("hides Pin for a machine whose host refuses it, without showing an error", async () => {
    state.sessions = [makeSession({ sessionId: "s1", title: "Old host chat" })];
    const { call } = installBridge();
    const listAndCatalog = call.getMockImplementation()!;
    call.mockImplementation(async (request: CallArgs) => {
      if (request.action === "setPinned") throw new Error("Unsupported personal chat action: setPinned.");
      return await listAndCatalog(request);
    });
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "More actions for Old host chat" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(call.mock.calls.some(([request]) => request.action === "setPinned")).toBe(true));

    fireEvent.click(await screen.findByRole("button", { name: "More actions for Old host chat" }));
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull());
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    expect(screen.queryByText(/Could not pin/)).toBeNull();
  });

  it("shows any other Pin failure and keeps offering Pin", async () => {
    state.sessions = [makeSession({ sessionId: "s1", title: "Busy chat" })];
    const { call } = installBridge();
    const listAndCatalog = call.getMockImplementation()!;
    call.mockImplementation(async (request: CallArgs) => {
      if (request.action === "setPinned") throw new Error("database is locked");
      return await listAndCatalog(request);
    });
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "More actions for Busy chat" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));

    expect(await screen.findByText(/Could not pin this chat: database is locked/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Busy chat" }));
    expect(screen.getByRole("menuitem", { name: "Pin" })).toBeTruthy();
  });
});
