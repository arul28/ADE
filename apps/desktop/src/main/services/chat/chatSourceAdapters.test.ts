import { describe, expect, it } from "vitest";
import {
  acpResourceLinkSourceRef,
  acpToolSourceRefs,
  claudeCitationSourceRefs,
  claudeMessageCitationSourceRefs,
  claudeWebToolSourceRefs,
  codexMemoryCitationSourceRefs,
  cursorWebToolSourceRefs,
  droidWebToolSourceRefs,
  isWebFetchToolName,
  isWebSearchToolName,
  openCodeWebToolSourceRefs,
} from "./chatSourceAdapters";

// Fixtures follow the installed typings: Codex app-server v2 (`codex app-server
// generate-ts`), @anthropic-ai/claude-agent-sdk sdk-tools.d.ts, @anthropic-ai/sdk
// messages.d.ts, @cursor/sdk agent protobuf, @opencode-ai/sdk ToolStateCompleted,
// and ADE's acpProtocolTypes.ts.

describe("tool name recognition", () => {
  it("accepts every provider spelling of the web tools", () => {
    for (const name of ["WebSearch", "webSearch", "websearch", "web_search", "mcp__x__web_search"]) {
      expect(isWebSearchToolName(name)).toBe(true);
    }
    for (const name of ["WebFetch", "webFetch", "webfetch", "web_fetch", "FetchUrl", "fetch_url"]) {
      expect(isWebFetchToolName(name)).toBe(true);
    }
    for (const name of ["Grep", "grep", "search", "Read", "fetch"]) {
      expect(isWebSearchToolName(name) || isWebFetchToolName(name)).toBe(false);
    }
  });
});

describe("Codex memoryCitation", () => {
  it("maps MemoryCitation.entries to cited file sources", () => {
    const refs = codexMemoryCitationSourceRefs({
      entries: [
        { path: "/Users/me/.codex/memories/ade.md", lineStart: 12, lineEnd: 18, note: "Build rules" },
        { path: "", lineStart: 1, lineEnd: 1, note: "" },
      ],
      threadIds: ["thr_1"],
    });
    expect(refs).toEqual([{
      kind: "file",
      path: "/Users/me/.codex/memories/ade.md",
      cited: true,
      lineStart: 12,
      lineEnd: 18,
      snippet: "Build rules",
    }]);
    expect(codexMemoryCitationSourceRefs(null)).toEqual([]);
  });
});

describe("Claude", () => {
  it("maps WebSearchOutput results to web results with the query", () => {
    const refs = claudeWebToolSourceRefs("WebSearch", {
      query: "vitest fake timers",
      results: [
        { tool_use_id: "srvtoolu_1", content: [
          { title: "Fake timers", url: "https://vitest.dev/guide/mocking#timers" },
          { title: "API", url: "https://vitest.dev/api/vi" },
        ] },
        "Summary text the model wrote",
      ],
      durationSeconds: 1.2,
    });
    expect(refs).toEqual([
      { kind: "web_search_result", url: "https://vitest.dev/guide/mocking#timers", title: "Fake timers", query: "vitest fake timers" },
      { kind: "web_search_result", url: "https://vitest.dev/api/vi", title: "API", query: "vitest fake timers" },
    ]);
  });

  it("maps WebFetchOutput to a fetched page, not for HTTP errors", () => {
    expect(claudeWebToolSourceRefs("WebFetch", {
      url: "https://example.com/post", code: 200, codeText: "OK", result: "…", bytes: 10, durationMs: 5,
    })).toEqual([{ kind: "fetched_url", url: "https://example.com/post" }]);
    expect(claudeWebToolSourceRefs("WebFetch", { url: "https://example.com/missing", code: 404 })).toEqual([]);
    expect(claudeWebToolSourceRefs("Read", { url: "https://x.dev" })).toEqual([]);
  });

  it("maps web_search_result_location / search_result_location citations; skips document locations", () => {
    const refs = claudeMessageCitationSourceRefs([
      {
        type: "text",
        text: "Answer",
        citations: [
          { type: "web_search_result_location", url: "https://a.dev/x", title: "A", cited_text: "quoted", encrypted_index: "e" },
          { type: "search_result_location", source: "https://b.dev", title: null, cited_text: "b", search_result_index: 0, start_block_index: 0, end_block_index: 1 },
          { type: "char_location", cited_text: "c", document_index: 0, document_title: "Doc", start_char_index: 0, end_char_index: 4, file_id: null },
        ],
      },
      { type: "tool_use", id: "t", name: "Read", input: {} },
    ]);
    expect(refs).toEqual([
      { kind: "citation", url: "https://a.dev/x", cited: true, title: "A", snippet: "quoted" },
      { kind: "citation", url: "https://b.dev", cited: true, snippet: "b" },
    ]);
    expect(claudeCitationSourceRefs({ type: "citations_delta" })).toEqual([]);
  });
});

describe("Cursor", () => {
  it("reads webSearch references through the { status, value } wrapper", () => {
    const refs = cursorWebToolSourceRefs(
      "webSearch",
      { searchTerm: "cursor sdk" },
      { status: "success", value: { references: [{ title: "Cursor SDK", url: "https://cursor.com/docs/sdk", chunk: "The SDK…" }] } },
    );
    expect(refs).toEqual([{
      kind: "web_search_result",
      url: "https://cursor.com/docs/sdk",
      title: "Cursor SDK",
      snippet: "The SDK…",
      query: "cursor sdk",
    }]);
  });

  it("uses webFetch args.url when the result has no URL record, but not on a rejected fetch", () => {
    expect(cursorWebToolSourceRefs("webFetch", { url: "https://a.dev" }, { status: "success", value: { markdown: "# A" } }))
      .toEqual([{ kind: "fetched_url", url: "https://a.dev" }]);
    expect(cursorWebToolSourceRefs("webFetch", { url: "https://a.dev" }, { status: "error", error: { error: "blocked" } }))
      .toEqual([]);
  });
});

describe("OpenCode", () => {
  it("maps webfetch input.url with the part title, and websearch only from JSON output", () => {
    expect(openCodeWebToolSourceRefs("webfetch", { url: "https://opencode.ai/docs", format: "markdown" }, "# Docs", "OpenCode docs"))
      .toEqual([{ kind: "fetched_url", url: "https://opencode.ai/docs", title: "OpenCode docs" }]);
    expect(openCodeWebToolSourceRefs("websearch", { query: "q" }, JSON.stringify({ results: [{ url: "https://r.dev", title: "R" }] })))
      .toEqual([{ kind: "web_search_result", url: "https://r.dev", title: "R", query: "q" }]);
    expect(openCodeWebToolSourceRefs("websearch", { query: "q" }, "Plain text mentioning https://r.dev")).toEqual([]);
    expect(openCodeWebToolSourceRefs("read", { url: "https://x.dev" }, "")).toEqual([]);
  });
});

describe("Droid", () => {
  it("only the web tool allowlist produces sources", () => {
    expect(droidWebToolSourceRefs("FetchUrl", { url: "https://f.dev" }, "page"))
      .toEqual([{ kind: "fetched_url", url: "https://f.dev" }]);
    expect(droidWebToolSourceRefs("WebSearch", { query: "q" }, [{ type: "text", text: JSON.stringify([{ url: "https://s.dev" }]) }]))
      .toEqual([{ kind: "web_search_result", url: "https://s.dev", query: "q" }]);
    expect(droidWebToolSourceRefs("Execute", { url: "https://x.dev" }, "")).toEqual([]);
  });
});

describe("ACP", () => {
  it("fetch with a URL is a fetched page", () => {
    expect(acpToolSourceRefs({ kind: "fetch", rawInput: { url: "https://a.dev/page" }, rawOutput: "…" }))
      .toEqual([{ kind: "fetched_url", url: "https://a.dev/page" }]);
  });

  it("search is web only with a query, no local path, and URL records in the output", () => {
    const output = { results: [{ url: "https://w.dev", title: "W" }] };
    expect(acpToolSourceRefs({ kind: "search", rawInput: { query: "q" }, rawOutput: output }))
      .toEqual([{ kind: "web_search_result", url: "https://w.dev", title: "W", query: "q" }]);
    // grep-shaped searches never become sources, even if the output mentions URLs.
    expect(acpToolSourceRefs({ kind: "search", rawInput: { pattern: "TODO", path: "src" }, rawOutput: output })).toEqual([]);
    expect(acpToolSourceRefs({ kind: "search", rawInput: { query: "q" }, rawOutput: output, locations: [{ path: "/repo/a.ts" }] }))
      .toEqual([]);
    expect(acpToolSourceRefs({ kind: "search", rawInput: { pattern: "x" }, rawOutput: output })).toEqual([]);
    expect(acpToolSourceRefs({ kind: "read", rawInput: { url: "https://a.dev" }, rawOutput: null })).toEqual([]);
  });

  it("resource_link blocks become cited web or file sources", () => {
    expect(acpResourceLinkSourceRef({ type: "resource_link", uri: "https://spec.dev/acp", name: "acp", title: "ACP spec" }))
      .toEqual({ kind: "citation", url: "https://spec.dev/acp", cited: true, title: "ACP spec" });
    expect(acpResourceLinkSourceRef({ type: "resource_link", uri: "file:///repo/src/a%20b.ts", name: "a b.ts", description: "entry" }))
      .toEqual({ kind: "file", path: "/repo/src/a b.ts", cited: true, title: "a b.ts", snippet: "entry" });
    expect(acpResourceLinkSourceRef({ type: "resource_link", uri: "zed://thread/1", name: "thread" })).toBeNull();
    expect(acpResourceLinkSourceRef({ type: "text", text: "x" })).toBeNull();
  });

  it("preserves Windows drive and UNC paths from file URLs", () => {
    expect(acpResourceLinkSourceRef({
      type: "resource_link",
      uri: "file:///C:/Users/Ada%20Lovelace/notes.md",
      name: "notes.md",
    })).toMatchObject({ kind: "file", path: "C:\\Users\\Ada Lovelace\\notes.md" });
    expect(acpResourceLinkSourceRef({
      type: "resource_link",
      uri: "file://build-share/reports/run.md",
      name: "run.md",
    })).toMatchObject({ kind: "file", path: "\\\\build-share\\reports\\run.md" });
  });
});
