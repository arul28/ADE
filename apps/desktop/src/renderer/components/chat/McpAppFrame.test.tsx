/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { McpAppDocument } from "../../../shared/mcpApp";
import { ChatRuntimeScopeProvider } from "./ChatRuntimeScope";
import { McpAppCard } from "./McpAppFrame";

const CHAT_PIN: OpenProjectBinding = { kind: "local", key: "local:/repo", rootPath: "/repo", displayName: "repo" };

const APP: McpAppDocument = {
  sessionId: "chat-1",
  itemId: "call-1",
  provider: "claude",
  server: "higgsfield",
  tool: "generate_video",
  toolTitle: null,
  toolDescription: null,
  toolInputSchema: { type: "object" },
  resourceUri: "ui://higgsfield/generation-v2.html",
  html: "<!doctype html><div id=root></div>",
  csp: { connectDomains: [], resourceDomains: ["https://mcp.example.com"] },
  toolInput: { prompt: "a cloud" },
  toolResult: { content: [{ type: "text", text: "{\"id\":\"job-1\",\"status\":\"pending\"}" }] },
  createdAt: "2026-11-18T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as { ade?: unknown }).ade;
});

/**
 * An app's tool already ran when its page is shown, and it may have cost money
 * (a paid generation). A page that never answers must not leave an empty frame,
 * and reloading its preview must read the stored app again and never run the
 * tool a second time.
 */
describe("McpAppCard, a page that never answers", () => {
  it("folds to the tool's result, and Reload preview reloads the page without running the tool", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const getMcpApp = vi.fn(async () => ({ status: "ready" as const, app: APP }));
    let prepared = 0;
    const prepareApp = vi.fn(async (): Promise<string> => `ade-scene://app/${++prepared}`);
    const mcpAppRequest = vi.fn(async () => ({ ok: true as const, result: {} }));
    (window as { ade?: unknown }).ade = {
      scene: { prepareApp },
      agentChat: {
        getMcpApp,
        mcpAppRequest,
        listMcpAppGrants: vi.fn(async () => ({ server: "higgsfield", tools: [] })),
        revokeMcpAppGrant: vi.fn(),
      },
    };

    render(
      <ChatRuntimeScopeProvider pin={CHAT_PIN} binding={CHAT_PIN} laneId={null} sessionId="chat-1">
        <McpAppCard
          card={{ cardId: "mcp-app:call-1", variant: "mcp_app", state: "terminal", title: "generate_video", subtitle: "higgsfield", fallbackText: "" }}
        />
      </ChatRuntimeScopeProvider>,
    );
    await screen.findByTestId("chat-mcp-app-frame");

    await act(async () => { vi.advanceTimersByTime(10_000); });
    const folded = await screen.findByTestId("chat-mcp-app-stalled");
    expect(folded.textContent).toContain("did not load");
    expect(folded.textContent).toContain("job-1");

    fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
    await waitFor(() => expect(prepareApp).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("chat-mcp-app-stalled")).toBeNull());
    expect(getMcpApp).toHaveBeenCalledTimes(2);
    expect(mcpAppRequest).not.toHaveBeenCalled();
  });
});
