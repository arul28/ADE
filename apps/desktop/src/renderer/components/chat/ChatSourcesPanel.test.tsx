/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";
import { deriveChatSources } from "../../../shared/chatSources";
import { ChatSourcesPanel as ChatSourcesPanelView } from "./ChatSourcesPanel";
import { resetSourceFaviconCacheForTests } from "./useSourceFavicon";

function envelope(event: AgentChatEvent, sequence: number): AgentChatEventEnvelope {
  return { sessionId: "s", timestamp: `2026-09-23T00:00:0${sequence}.000Z`, sequence, event };
}

const events: AgentChatEventEnvelope[] = [
  envelope({ type: "user_message", text: "Read", attachments: [{ type: "file", path: "/repo/spec.md" }] }, 1),
  envelope({
    type: "tool_result",
    tool: "webfetch",
    result: "page",
    sources: [{ kind: "fetched_url", url: "https://www.zed.dev/docs", title: "Zed docs" }],
    itemId: "t1",
    turnId: "turn-1",
    status: "completed",
  }, 2),
  envelope({
    type: "sources",
    sources: [{ kind: "citation", url: "https://acp.dev/spec", title: "ACP spec", cited: true }],
    itemId: "m1",
    turnId: "turn-2",
  }, 3),
  envelope({
    type: "tool_call",
    tool: "linear:list_issues",
    args: {},
    mcp: { server: "linear", tool: "list_issues", appContext: { appName: "Linear" } },
    itemId: "mcp-1",
    turnId: "turn-2",
  }, 4),
];

function webResults(turnId: string, urls: string[], sequence: number): AgentChatEventEnvelope {
  return envelope({
    type: "web_search",
    query: "agentic ides",
    results: urls.map((url, index) => ({ url, title: `Result ${index + 1}` })),
    itemId: `search-${turnId}`,
    turnId,
    status: "completed",
  }, sequence);
}

function installFavicons(resolve: (args: { domains: string[] }) => Promise<{ icons: Record<string, string | null> }>) {
  const resolveSourceFavicons = vi.fn(resolve);
  const writeClipboardText = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { ade: unknown }).ade = { agentChat: { resolveSourceFavicons }, app: { writeClipboardText } };
  return { resolveSourceFavicons, writeClipboardText };
}

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

function ChatSourcesPanel({ events: sourceEvents, provider, turnId, onShowAll }: {
  events: AgentChatEventEnvelope[];
  provider: string;
  turnId?: string | null;
  onShowAll?: () => void;
}) {
  return <ChatSourcesPanelView sources={deriveChatSources(sourceEvents, { provider })} turnId={turnId} onShowAll={onShowAll} />;
}

describe("ChatSourcesPanel", () => {
  afterEach(() => {
    cleanup();
    resetSourceFaviconCacheForTests();
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("renders nothing, not an empty state, when the chat has no sources", () => {
    const { container } = render(<ChatSourcesPanel events={[]} provider="opencode" />);
    expect(container.innerHTML).toBe("");
  });

  it("groups Cited, Web, Files, Apps in that order for a non-Codex chat, with no scroller or Codex copy", () => {
    render(<ChatSourcesPanel events={events} provider="opencode" />);
    const panel = screen.getByTestId("chat-sources-panel");
    const groups = [...panel.querySelectorAll("[data-testid^='chat-sources-group-']")].map((node) =>
      node.getAttribute("data-testid"));
    expect(groups).toEqual([
      "chat-sources-group-cited",
      "chat-sources-group-web",
      "chat-sources-group-files",
      "chat-sources-group-apps",
    ]);
    const web = within(screen.getByTestId("chat-sources-group-web"));
    expect(web.getByText("Zed docs")).toBeTruthy();
    expect(web.getByText("zed.dev")).toBeTruthy();
    // Domain initial, never a remote favicon request.
    expect(web.getByText("Z")).toBeTruthy();
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.className).not.toMatch(/overflow|h-full|border/);
    expect(screen.queryByText(/Codex|No sources yet/)).toBeNull();
  });

  it("narrows to one turn and clears the filter on Show all", () => {
    const onShowAll = vi.fn();
    render(<ChatSourcesPanel events={events} provider="claude" turnId="turn-2" onShowAll={onShowAll} />);
    expect(screen.getByText("ACP spec")).toBeTruthy();
    expect(screen.queryByText("Zed docs")).toBeNull();
    // Apps are not "sources used by the answer", so the turn view omits them.
    expect(screen.queryByText("Linear")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-sources-show-all"));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it("shows three rows per group, then expands with Show N more and collapses with Show less", () => {
    const urls = Array.from({ length: 5 }, (_, index) => `https://site${index + 1}.dev/page`);
    render(<ChatSourcesPanel events={[webResults("turn-9", urls, 1)]} provider="claude" />);
    const web = screen.getByTestId("chat-sources-group-web");
    // The header keeps the full count.
    expect(within(web).getByText("5")).toBeTruthy();
    expect(within(web).getAllByTestId("chat-source-row")).toHaveLength(3);
    fireEvent.click(within(web).getByRole("button", { name: "Show 2 more" }));
    expect(within(web).getAllByTestId("chat-source-row")).toHaveLength(5);
    fireEvent.click(within(web).getByRole("button", { name: "Show less" }));
    expect(within(web).getAllByTestId("chat-source-row")).toHaveLength(3);
  });

  it("truncates the per-turn view the same way, independently of the whole-chat view", () => {
    const events = [
      webResults("turn-a", Array.from({ length: 4 }, (_, index) => `https://a${index}.dev`), 1),
      webResults("turn-b", Array.from({ length: 6 }, (_, index) => `https://b${index}.dev`), 2),
    ];
    const { rerender } = render(<ChatSourcesPanel events={events} provider="codex" turnId="turn-b" />);
    const web = () => screen.getByTestId("chat-sources-group-web");
    expect(within(web()).getAllByTestId("chat-source-row")).toHaveLength(3);
    fireEvent.click(within(web()).getByRole("button", { name: "Show 3 more" }));
    expect(within(web()).getAllByTestId("chat-source-row")).toHaveLength(6);
    rerender(<ChatSourcesPanel events={events} provider="codex" turnId={null} />);
    expect(within(web()).getAllByTestId("chat-source-row")).toHaveLength(3);
    expect(within(web()).getByRole("button", { name: "Show 7 more" })).toBeTruthy();
  });

  it("lists a cited page once, in Cited with a cited mark, never again under Web", () => {
    const events = [
      webResults("turn-1", ["https://zed.dev/docs", "https://acp.dev"], 1),
      envelope({ type: "text", text: "See [Zed](http://www.zed.dev/docs/).", itemId: "answer", turnId: "turn-1" }, 2),
    ];
    render(<ChatSourcesPanel events={events} provider="claude" />);
    const rows = screen.getAllByTestId("chat-source-row");
    expect(rows).toHaveLength(2);
    const cited = within(screen.getByTestId("chat-sources-group-cited"));
    expect(cited.getByText("Result 1")).toBeTruthy();
    expect(cited.getByTestId("chat-source-cited")).toBeTruthy();
    expect(within(screen.getByTestId("chat-sources-group-web")).queryByText("Result 1")).toBeNull();
  });

  it("prints an untitled root page's domain once (the owner's duplicated rows)", () => {
    const events = [envelope({
      type: "tool_result",
      tool: "WebFetch",
      result: "# DeepSeek Overview",
      sources: [{ kind: "fetched_url", url: "https://www.deepseek.com" }],
      itemId: "toolu_01VwXH7TVduSJgweCbMFdCCh",
      turnId: "turn-1",
      status: "completed",
    }, 1)];
    render(<ChatSourcesPanel events={events} provider="claude" />);
    const row = screen.getByTestId("chat-source-row");
    expect(within(row).getAllByText("deepseek.com")).toHaveLength(1);
  });

  it("batches visible rows into one favicon call, draws icons, and keeps the initial when there is none", async () => {
    const { resolveSourceFavicons } = installFavicons(async () => ({
      icons: { "zed.dev": PNG_DATA_URL, "acp.dev": null },
    }));
    render(<ChatSourcesPanel events={events} provider="opencode" />);
    await waitFor(() => expect(screen.getByTestId("chat-sources-group-web").querySelector("img")).toBeTruthy());
    expect(resolveSourceFavicons).toHaveBeenCalledTimes(1);
    expect(new Set(resolveSourceFavicons.mock.calls[0]![0].domains)).toEqual(new Set(["zed.dev", "acp.dev"]));
    expect(screen.getByTestId("chat-sources-group-web").querySelector("img")!.getAttribute("src")).toBe(PNG_DATA_URL);
    // No icon for acp.dev: its initial stays.
    expect(within(screen.getByTestId("chat-sources-group-cited")).getByText("A")).toBeTruthy();
  });

  it("falls back to the initial when the icon fails to decode or the call fails", async () => {
    installFavicons(async () => ({ icons: { "zed.dev": PNG_DATA_URL } }));
    render(<ChatSourcesPanel events={events} provider="opencode" />);
    const web = screen.getByTestId("chat-sources-group-web");
    await waitFor(() => expect(web.querySelector("img")).toBeTruthy());
    act(() => {
      fireEvent.error(web.querySelector("img")!);
    });
    expect(web.querySelector("img")).toBeNull();
    expect(within(web).getByText("Z")).toBeTruthy();

    cleanup();
    resetSourceFaviconCacheForTests();
    const offline = Promise.reject(new Error("runtime offline"));
    offline.catch(() => undefined);
    const { resolveSourceFavicons } = installFavicons(() => offline);
    render(<ChatSourcesPanel events={events} provider="opencode" />);
    await waitFor(() => expect(resolveSourceFavicons).toHaveBeenCalledTimes(1));
    await act(async () => {
      await offline.catch(() => undefined);
    });
    expect(screen.getByTestId("chat-sources-panel").querySelector("img")).toBeNull();
    expect(within(screen.getByTestId("chat-sources-group-web")).getByText("Z")).toBeTruthy();
  });

  it("copies a row's link without opening it", async () => {
    const { writeClipboardText } = installFavicons(async () => ({ icons: {} }));
    render(<ChatSourcesPanel events={events} provider="opencode" />);
    const web = within(screen.getByTestId("chat-sources-group-web"));
    fireEvent.click(web.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith("https://www.zed.dev/docs"));
  });
});
