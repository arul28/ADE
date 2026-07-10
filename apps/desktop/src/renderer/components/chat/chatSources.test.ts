import { describe, expect, it } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";
import { deriveChatSources } from "./chatSources";

function envelope(event: AgentChatEvent, sequence = 1): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp: `2026-07-09T00:00:0${sequence}.000Z`,
    sequence,
    event,
  };
}

describe("deriveChatSources", () => {
  it("deduplicates attachments, web queries, and canonical web URLs", () => {
    const sources = deriveChatSources([
      envelope({
        type: "user_message",
        text: "Use these",
        attachments: [
          { type: "file", path: "/repo/spec.md" },
          { type: "file", path: "/repo/spec.md" },
          { type: "image-url", path: "diagram.png", url: "https://example.com/diagram.png#preview" },
        ],
      }),
      envelope({
        type: "web_search",
        query: "GPT-5.6 docs",
        actions: [{ type: "open_page", url: "https://openai.com/docs/5.6#models" }],
        itemId: "search-1",
        status: "running",
      }, 2),
      envelope({
        type: "web_search",
        query: "GPT-5.6 docs",
        actions: [{
          type: "open_page",
          url: "https://openai.com/docs/5.6#reasoning",
          title: "GPT-5.6 model guide",
          snippet: "The current reasoning ladder.",
        }],
        itemId: "search-1",
        status: "completed",
      }, 3),
    ]);

    expect(sources.files).toHaveLength(2);
    expect(sources.files.map((source) => source.title)).toEqual(["spec.md", "diagram.png"]);
    expect(sources.web).toHaveLength(2);
    expect(sources.web.find((source) => source.url)?.url).toBe("https://openai.com/docs/5.6");
    expect(sources.web.find((source) => source.url)?.title).toBe("GPT-5.6 model guide");
    expect(sources.web.find((source) => !source.url)?.title).toBe("GPT-5.6 docs");
  });

  it("groups MCP calls by connected app and extracts safe external resources", () => {
    const mcp = {
      server: "github",
      tool: "search_issues",
      pluginId: "github-plugin",
      appContext: {
        connectorId: "github",
        appName: "GitHub",
        actionName: "Search issues",
        resourceUri: "ui://github/search",
      },
    };
    const sources = deriveChatSources([
      envelope({
        type: "tool_call",
        tool: "github:search_issues",
        args: { query: "5.6" },
        mcp,
        itemId: "mcp-1",
      }),
      envelope({
        type: "tool_result",
        tool: "github:search_issues",
        result: {
          items: [
            { title: "Model support", url: "https://github.com/acme/ade/issues/56#discussion" },
            { title: "Ignored", url: "file:///tmp/secret" },
          ],
        },
        mcp,
        itemId: "mcp-1",
        status: "completed",
      }, 2),
      envelope({
        type: "tool_call",
        tool: "legacy-server:lookup",
        args: null,
        itemId: "legacy-mcp",
      }, 3),
    ]);

    expect(sources.tools).toEqual([
      expect.objectContaining({ title: "GitHub", detail: "Search issues" }),
      expect.objectContaining({ title: "legacy-server", detail: "lookup" }),
    ]);
    expect(sources.external).toEqual([
      expect.objectContaining({
        title: "Model support",
        url: "https://github.com/acme/ade/issues/56",
      }),
    ]);
  });

  it("reads JSON tool results without treating arbitrary prose as a URL", () => {
    const sources = deriveChatSources([
      envelope({
        type: "tool_result",
        tool: "docs:read",
        result: JSON.stringify({ title: "Reference", href: "https://docs.example.com/reference#top" }),
        itemId: "mcp-2",
        status: "completed",
      }),
      envelope({
        type: "tool_result",
        tool: "docs:read",
        result: "See https://docs.example.com/not-extracted in ordinary prose.",
        itemId: "mcp-3",
        status: "completed",
      }, 2),
    ]);

    expect(sources.tools).toHaveLength(1);
    expect(sources.external).toEqual([
      expect.objectContaining({ url: "https://docs.example.com/reference" }),
    ]);
  });

  it("omits Codex's internal node_repl host from Sources", () => {
    const sources = deriveChatSources([
      envelope({
        type: "tool_call",
        tool: "node_repl:js",
        args: { code: "1 + 1" },
        mcp: { server: "node_repl", tool: "js" },
        itemId: "node-repl-1",
      }),
      envelope({
        type: "tool_result",
        tool: "node_repl:js",
        result: { value: 2 },
        mcp: { server: "node_repl", tool: "js" },
        itemId: "node-repl-1",
        status: "completed",
      }, 2),
    ]);

    expect(sources.tools).toEqual([]);
    expect(sources.external).toEqual([]);
    expect(sources.total).toBe(0);
  });
});
