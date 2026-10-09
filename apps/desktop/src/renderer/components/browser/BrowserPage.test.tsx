/* @vitest-environment jsdom */

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatSessionSummary } from "../../../shared/types";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import { useAppStore } from "../../state/appStore";
import { resetModelPickerRuntimeCatalogForTests } from "../shared/ModelPicker/runtimeCatalogCache";

// The Browser top tab over `window.ade` (the IPC boundary these tests fake):
// the dock is the real chat pane on `personalChats.*`, and the page talks to
// tabs only through `builtInBrowser.*`. The tab surface itself is an Electron
// WebContentsView with nothing to draw in jsdom, so the panel renders only the
// toolbar slot the page fills.
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
    descriptorsFromAgentChatModelCatalog: () => ({ models: [FAKE_MODEL], availableModelIds: ["fake-model"] }),
  };
});

vi.mock("../chat/ChatBuiltInBrowserPanel", () => ({
  ChatBuiltInBrowserPanel: ({ toolbarEnd, onAttachTab }: {
    toolbarEnd?: React.ReactNode;
    onAttachTab?: (tab: { tabId: string; title: string | null; url: string }) => void;
  }) => (
    <div>
      {toolbarEnd}
      {/* The tab strip's "Attach to chat", offered only while a chat is docked. */}
      {onAttachTab ? (
        <button type="button" onClick={() => onAttachTab({ tabId: "tab-2", title: "Hotel list", url: "https://hotels.example.test/" })}>
          Attach to chat
        </button>
      ) : null}
    </div>
  ),
}));

const TAB = { id: "tab-1", title: "Flight search", url: "https://flights.example.test/", isLaunchpad: false };

function makeSession(sessionId: string, title: string): AgentChatSessionSummary {
  return {
    sessionId,
    laneId: "",
    provider: "claude",
    model: "fake-model",
    modelId: "fake-model",
    status: "idle",
    title,
    startedAt: new Date().toISOString(),
    endedAt: null,
    lastActivityAt: new Date().toISOString(),
    lastOutputPreview: null,
    summary: null,
    surface: "personal",
  } as unknown as AgentChatSessionSummary;
}

const sessions = [makeSession("s1", "Docked chat"), makeSession("s2", "Other chat")];

/** Every `builtInBrowser.*` call the page makes, by name. */
let browserCalls: Array<{ method: string; args: unknown }> = [];

function installBridge() {
  browserCalls = [];
  const call = vi.fn(async ({ action, args }: { action: string; args?: Record<string, unknown> }) => {
    switch (action) {
      case "list":
        return { result: sessions };
      case "modelCatalog":
        return { result: { groups: [], fetchedAt: "", available: true } };
      case "updateSession":
        return { result: { ...sessions.find((session) => session.sessionId === args?.sessionId), id: args?.sessionId, ...args } };
      case "getSummary":
        return { result: sessions.find((session) => session.sessionId === args?.sessionId) ?? null };
      case "getEventHistory":
        return {
          result: { sessionId: String(args?.sessionId ?? ""), events: [], sessionFound: true, hasOlderHistory: false, tailStartOffset: 0 },
        };
      default:
        return { result: undefined };
    }
  });
  const builtInBrowser = new Proxy({}, {
    get: (_target, method) => (typeof method !== "string"
      ? undefined
      : method.startsWith("on")
        ? () => () => undefined
        : async (args: unknown) => {
          browserCalls.push({ method, args });
          return method === "getStatus" ? { tabs: [TAB], activeTabId: TAB.id } : undefined;
        }),
  });
  const idle = new Proxy({}, {
    get: (_target, key) => (typeof key === "string" && /^on[A-Z]/.test(key) ? () => () => undefined : async () => undefined),
  });
  const explicit: Record<string, unknown> = {
    personalChats: { call, streamEvents: vi.fn(async () => ({ events: [], nextCursor: 0, hasMore: false })) },
    builtInBrowser,
  };
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: new Proxy(explicit, { get: (target, key) => (key in target ? target[key as string] : idle) }),
  });
  return { call };
}

async function renderPage() {
  const { BrowserPage } = await import("./BrowserPage");
  return render(
    <MemoryRouter initialEntries={["/browser"]}>
      <BrowserPage />
    </MemoryRouter>,
  );
}

/** Explicit tab attachments staged in the draft, in either editor mode. */
function tabTokensInDraft(tab: { id: string; title: string }): number {
  const field = screen.getByRole("textbox", { name: /Ask about this page/i });
  return field instanceof HTMLTextAreaElement
    ? field.value.split(`id="${tab.id}"`).length - 1
    : screen.queryAllByLabelText(`Browser tab: ${tab.title}`).length;
}

function handOffs(): unknown[] {
  return browserCalls.filter((entry) => entry.method === "handTabToChat").map((entry) => entry.args);
}

describe("BrowserPage dock", () => {
  beforeEach(() => {
    TAB.url = "https://flights.example.test/";
    cleanup();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    resetModelPickerRuntimeCatalogForTests();
    useAppStore.setState({
      project: null,
      projectBinding: null,
      browserDock: { open: false, chat: { targetKey: "local-machine", sessionId: "s1" } },
    } as never);
    installBridge();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    ["https://flights.example.test/", "https://flights.example.test/"],
    ["https://user:password-proof@flights.example.test/?token=secret-proof&reset_token=reset-proof&X-Amz-Signature=signed-proof&search=Paris#access_token=fragment-proof", "https://flights.example.test/?token=%5Bredacted+by+ADE%5D&reset_token=%5Bredacted+by+ADE%5D&X-Amz-Signature=%5Bredacted+by+ADE%5D&search=Paris"],
  ])("hands the page to the docked chat with safe hidden context for %s", async (url, safeUrl) => {
    TAB.url = url;
    const { container } = await renderPage();
    const call = vi.mocked(window.ade.personalChats.call);
    const askAgent = () => within(container.querySelector("main")!).getByRole("button", { name: /Ask agent/ });

    fireEvent.click(askAgent());
    await waitFor(() => expect(handOffs()).toEqual([{ tabCollection: "personal", tabId: TAB.id, chatSessionId: "s1" }]));
    const field = await screen.findByRole("textbox", { name: /Ask about this page/i });
    fireEvent.change(field, { target: { value: "Summarize this page" } });
    fireEvent.click(within(container).getByRole("button", { name: /^Send$/i }));
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({
      action: "send", args: expect.objectContaining({ sessionId: "s1", text: expect.stringContaining(safeUrl) }),
    })));
    const send = call.mock.calls.find(([request]) => request.action === "send")?.[0];
    const sentText = (send?.args as { text?: string } | undefined)?.text;
    expect(sentText).not.toMatch(/password-proof|secret-proof|reset-proof|signed-proof|fragment-proof/);
    expect(sentText).toContain(TAB.id);
    expect(sentText).toContain("Summarize this page");

    // Reopening hands the same page back to the same chat.
    fireEvent.click(askAgent());
    fireEvent.click(askAgent());
    await waitFor(() => expect(handOffs()).toHaveLength(2));

    // "Attach to chat" on another tab lands in the same dock's draft.
    fireEvent.click(screen.getByRole("button", { name: "Attach to chat" }));
    await waitFor(() => expect(tabTokensInDraft({ id: "tab-2", title: "Hotel list" })).toBe(1));

    // The person already chose this tab: no claim (which a lease held by another
    // chat refuses), no bringing it to the front, no consent prompt.
    expect([...new Set(browserCalls.map((entry) => entry.method))].sort()).toEqual(["getStatus", "handTabToChat"]);
  });

  it("hands the page to a chat picked from the dock's switcher", async () => {
    const { container } = await renderPage();
    fireEvent.click(within(container.querySelector("main")!).getByRole("button", { name: /Ask agent/ }));
    await waitFor(() => expect(handOffs()).toHaveLength(1));

    const switcher = await screen.findByRole("button", { name: "Recent chats" });
    fireEvent.keyDown(switcher, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Other chat/ }));

    await waitFor(() => expect(handOffs().at(-1)).toEqual({ tabCollection: "personal", tabId: TAB.id, chatSessionId: "s2" }));
    expect(useAppStore.getState().browserDock.chat).toEqual({ targetKey: "local-machine", sessionId: "s2" });
  });
});
