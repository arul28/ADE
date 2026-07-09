import { describe, expect, it } from "vitest";
import {
  createClaudeStructuredActivityState,
  finalizeClaudeStructuredActivities,
  mapClaudeStructuredActivityBlock,
} from "./claudeStructuredActivity";

function createMapper() {
  const state = createClaudeStructuredActivityState();
  let fallbackIndex = 0;
  return {
    state,
    map(block: unknown) {
      fallbackIndex += 1;
      return mapClaudeStructuredActivityBlock({
        block,
        turnId: "turn-1",
        fallbackItemId: `fallback-${fallbackIndex}`,
        state,
      });
    },
  };
}

describe("mapClaudeStructuredActivityBlock", () => {
  it("maps a web search lifecycle with result links and dedupes stream snapshots", () => {
    const mapper = createMapper();
    const start = {
      type: "server_tool_use",
      id: "search-1",
      name: "web_search",
      input: { query: "ADE coding agents" },
    };

    expect(mapper.map(start)).toEqual([expect.objectContaining({
      type: "web_search",
      itemId: "search-1",
      query: "ADE coding agents",
      status: "running",
    })]);
    expect(mapper.map(start)).toEqual([]);

    const completed = mapper.map({
      type: "web_search_tool_result",
      tool_use_id: "search-1",
      content: [{
        type: "web_search_result",
        title: "ADE",
        url: "https://example.com/ade",
        encrypted_content: "opaque",
      }],
    });
    expect(completed).toEqual([expect.objectContaining({
      type: "web_search",
      itemId: "search-1",
      query: "ADE coding agents",
      status: "completed",
      actions: [expect.objectContaining({
        type: "search_result",
        title: "ADE",
        url: "https://example.com/ade",
      })],
    })]);
  });

  it("maps web fetch results and typed failures", () => {
    const mapper = createMapper();
    mapper.map({
      type: "server_tool_use",
      id: "fetch-1",
      name: "web_fetch",
      input: { url: "https://example.com/docs" },
    });
    expect(mapper.map({
      type: "web_fetch_tool_result",
      tool_use_id: "fetch-1",
      content: {
        type: "web_fetch_result",
        url: "https://example.com/docs",
        retrieved_at: "2026-07-09T12:00:00Z",
      },
    })).toEqual([expect.objectContaining({
      type: "web_search",
      query: "https://example.com/docs",
      status: "completed",
      actions: [expect.objectContaining({ type: "open_page", url: "https://example.com/docs" })],
    })]);

    mapper.map({
      type: "server_tool_use",
      id: "fetch-2",
      name: "web_fetch",
      input: { url: "https://blocked.example" },
    });
    expect(mapper.map({
      type: "web_fetch_tool_result",
      tool_use_id: "fetch-2",
      content: { type: "web_fetch_tool_result_error", error_code: "url_not_allowed" },
    })).toEqual([expect.objectContaining({
      type: "web_search",
      query: "https://blocked.example",
      action: "url not allowed",
      status: "failed",
    })]);
  });

  it("maps MCP calls and results with connector identity preserved", () => {
    const mapper = createMapper();
    expect(mapper.map({
      type: "mcp_tool_use",
      id: "mcp-1",
      server_name: "github",
      name: "search_issues",
      input: { query: "is:open label:bug" },
    })).toEqual([expect.objectContaining({
      type: "tool_call",
      tool: "github:search_issues",
      itemId: "mcp-1",
      mcp: { server: "github", tool: "search_issues" },
    })]);

    expect(mapper.map({
      type: "mcp_tool_result",
      tool_use_id: "mcp-1",
      is_error: false,
      content: [
        { type: "text", text: "Issue 1" },
        { type: "text", text: "Issue 2" },
      ],
    })).toEqual([expect.objectContaining({
      type: "tool_result",
      tool: "github:search_issues",
      result: "Issue 1\nIssue 2",
      status: "completed",
      mcp: { server: "github", tool: "search_issues" },
    })]);
  });

  it("refreshes MCP args when a streamed empty start is followed by the full snapshot", () => {
    const mapper = createMapper();
    const emptyStart = {
      type: "mcp_tool_use",
      id: "mcp-streamed",
      server_name: "linear",
      name: "get_issue",
      input: {},
    };
    expect(mapper.map(emptyStart)).toEqual([expect.objectContaining({ args: {} })]);
    expect(mapper.map({ ...emptyStart, input: { id: "ADE-123" } })).toEqual([
      expect.objectContaining({
        type: "tool_call",
        itemId: "mcp-streamed",
        args: { id: "ADE-123" },
      }),
    ]);
    expect(mapper.map({ ...emptyStart, input: { id: "ADE-123" } })).toEqual([]);
  });

  it("closes unresolved structured rows when a turn ends", () => {
    const mapper = createMapper();
    mapper.map({
      type: "server_tool_use",
      id: "search-pending",
      name: "web_search",
      input: { query: "still searching" },
    });
    mapper.map({
      type: "mcp_tool_use",
      id: "mcp-pending",
      server_name: "linear",
      name: "get_issue",
      input: { id: "ADE-1" },
    });

    expect(finalizeClaudeStructuredActivities(mapper.state, "turn-1", "interrupted")).toEqual([
      expect.objectContaining({ type: "web_search", itemId: "search-pending", status: "failed" }),
      expect.objectContaining({ type: "tool_result", itemId: "mcp-pending", status: "interrupted" }),
    ]);
  });

  it("ignores unrelated Claude content blocks", () => {
    const mapper = createMapper();
    expect(mapper.map({ type: "text", text: "hello" })).toEqual([]);
    expect(mapper.map({ type: "server_tool_use", id: "code-1", name: "code_execution", input: {} })).toEqual([]);
  });
});
