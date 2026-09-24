import { describe, expect, it } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "./types";
import {
  boundChatSourceRefs,
  chatSourceInitial,
  chatSourceSubtitle,
  deriveChatSources,
  linkedSourceUrls,
  normalizeSourceUrl,
  webSourceRefsFromValue,
} from "./chatSources";

function envelope(event: AgentChatEvent, sequence = 1): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp: `2026-09-23T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    sequence,
    event,
  };
}

describe("normalizeSourceUrl", () => {
  it("lowercases scheme and host, drops www, fragment, tracking params, and trailing slash", () => {
    expect(normalizeSourceUrl("HTTPS://WWW.Example.COM/Docs/Guide/?utm_source=x&id=7&fbclid=a&gclid=b#part"))
      .toBe("https://example.com/Docs/Guide?id=7");
    expect(normalizeSourceUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeSourceUrl("https://user:pass@example.com/a")).toBe("https://example.com/a");
  });

  it("gives one page one key across scheme, mirror hosts, AMP, query order, and referral tags", () => {
    const key = normalizeSourceUrl("https://example.com/post?b=2&a=1");
    for (const variant of [
      "http://example.com/post?a=1&b=2",
      "https://www.example.com/post/?a=1&b=2",
      "https://m.example.com/post?a=1&b=2&utm_campaign=x",
      "https://amp.example.com/post/amp?b=2&a=1",
      "https://example.com:443/post?a=1&b=2&ref=aidevstack.dev",
    ]) {
      expect(normalizeSourceUrl(variant), variant).toBe(key);
    }
    expect(normalizeSourceUrl("https://en.m.wikipedia.org/wiki/Rust")).toBe(normalizeSourceUrl("https://en.wikipedia.org/wiki/Rust"));
    // Real misses from ~/.ade transcripts: a `?ref=<site>` referral tag on a GitHub page.
    expect(normalizeSourceUrl("https://github.com/openai/codex/releases?ref=aidevstack.dev"))
      .toBe(normalizeSourceUrl("https://github.com/openai/codex/releases"));
  });

  it("keeps meaningful differences apart: git refs, other ports, other hosts, a bare m. domain", () => {
    expect(normalizeSourceUrl("https://api.github.com/repos/o/r/contents/a?ref=main"))
      .not.toBe(normalizeSourceUrl("https://api.github.com/repos/o/r/contents/a?ref=v1.2.3"));
    expect(normalizeSourceUrl("https://example.com:8443/a")).not.toBe(normalizeSourceUrl("https://example.com/a"));
    expect(normalizeSourceUrl("https://docs.example.com/a")).not.toBe(normalizeSourceUrl("https://example.com/a"));
    expect(normalizeSourceUrl("https://m.co/a")).toBe("https://m.co/a");
  });

  it("keeps path case and distinct paths apart", () => {
    expect(normalizeSourceUrl("https://github.com/Acme/Repo")).not.toBe(normalizeSourceUrl("https://github.com/acme/repo"));
  });

  it("rejects non-web schemes", () => {
    for (const value of ["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hi", "not a url", ""]) {
      expect(normalizeSourceUrl(value)).toBeNull();
    }
  });
});

describe("boundChatSourceRefs / webSourceRefsFromValue", () => {
  it("drops unusable refs, dedupes by normalized URL, clips, and caps", () => {
    const refs = boundChatSourceRefs([
      { kind: "web_search_result", url: "https://a.dev/x#1", title: "A" },
      { kind: "web_search_result", url: "https://www.a.dev/x/", title: "dupe" },
      { kind: "web_search_result", url: "javascript:alert(1)" },
      { kind: "citation" },
      { kind: "file", path: "/repo/MEMORY.md", lineStart: 3, lineEnd: 9, snippet: "x".repeat(5_000) },
    ]);
    expect(refs.map((ref) => ref.url ?? ref.path)).toEqual(["https://a.dev/x#1", "/repo/MEMORY.md"]);
    expect(refs[1]!.snippet!.length).toBeLessThanOrEqual(400);
    const many = boundChatSourceRefs(
      Array.from({ length: 50 }, (_, index) => ({ kind: "web_search_result" as const, url: `https://a.dev/${index}` })),
    );
    expect(many).toHaveLength(20);
  });

  it("rejects credential-bearing source URLs before they can be synced or opened", () => {
    expect(boundChatSourceRefs([
      { kind: "citation", url: "https://user:secret@example.com/private" },
    ])).toEqual([]);
    expect(boundChatSourceRefs([
      { kind: "citation", url: "https://example.com/public" },
    ])).toEqual([{ kind: "citation", url: "https://example.com/public" }]);
  });

  it("walks wrappers and JSON strings, never prose", () => {
    const refs = webSourceRefsFromValue(
      { status: "success", value: { references: [{ title: "Ref", url: "https://r.dev", chunk: "excerpt" }] } },
      "web_search_result",
      { query: "q" },
    );
    expect(refs).toEqual([{ kind: "web_search_result", url: "https://r.dev", title: "Ref", snippet: "excerpt", query: "q" }]);
    expect(webSourceRefsFromValue(JSON.stringify([{ link: "https://j.dev" }]), "fetched_url")).toHaveLength(1);
    expect(webSourceRefsFromValue("see https://prose.dev for details", "fetched_url")).toEqual([]);
  });
});

describe("deriveChatSources", () => {
  it("dedupes web results and page actions across events; queries are metadata, not items", () => {
    const sources = deriveChatSources([
      envelope({
        type: "web_search",
        query: "codex releases",
        actions: [{ type: "open_page", url: "https://openai.com/index/codex#top" }],
        results: [
          { url: "https://www.openai.com/index/codex/?utm_medium=feed", title: "Codex", snippet: "Plans." },
          { url: "https://platform.openai.com/docs/codex", title: "Codex API docs" },
        ],
        itemId: "search-1",
        turnId: "turn-1",
        status: "completed",
      }),
      envelope({
        type: "web_search",
        query: "codex pricing",
        results: [{ url: "https://openai.com/index/codex", title: "Codex pricing and plans" }],
        itemId: "search-2",
        turnId: "turn-2",
        status: "completed",
      }, 2),
      envelope({ type: "web_search", query: "only a query", itemId: "search-3", turnId: "turn-2", status: "completed" }, 3),
    ], { provider: "codex" });

    expect(sources.web.map((source) => source.normalizedUrl)).toEqual([
      "https://openai.com/index/codex",
      "https://platform.openai.com/docs/codex",
    ]);
    const codex = sources.web[0]!;
    expect(codex.title).toBe("Codex pricing and plans");
    expect(codex.kinds).toEqual(["fetched_url", "web_search_result"]);
    expect(codex.queries).toEqual(["codex releases", "codex pricing"]);
    expect(codex.turnIds).toEqual(["turn-1", "turn-2"]);
    expect(codex.itemIds).toEqual(["search-1", "search-2"]);
    expect(codex.provider).toBe("codex");
    expect(codex.domain).toBe("openai.com");
    expect(codex.firstSeenAt).toBe("2026-09-23T00:00:01.000Z");
    expect(sources.total).toBe(2);
    expect(sources.sources.some((source) => source.title === "only a query")).toBe(false);
  });

  it("skips failed web searches and failed tool results", () => {
    const sources = deriveChatSources([
      envelope({
        type: "web_search",
        query: "x",
        results: [{ url: "https://failed.dev" }],
        itemId: "s",
        status: "failed",
      }),
      envelope({
        type: "tool_result",
        tool: "WebFetch",
        result: "error",
        sources: [{ kind: "fetched_url", url: "https://failed-fetch.dev" }],
        itemId: "t",
        status: "failed",
      }, 2),
    ]);
    expect(sources.total).toBe(0);
  });

  it("groups cited first, then web, files, apps; citations from `sources` events are cited", () => {
    const sources = deriveChatSources([
      envelope({
        type: "user_message",
        text: "Use these",
        attachments: [{ type: "file", path: "/repo/spec.md" }, { type: "file", path: "/repo/spec.md" }],
      }),
      envelope({
        type: "tool_result",
        tool: "webFetch",
        result: {},
        sources: [{ kind: "fetched_url", url: "https://docs.dev/a", title: "Docs A" }],
        itemId: "fetch-1",
        turnId: "turn-1",
        status: "completed",
      }, 2),
      envelope({
        type: "sources",
        sources: [
          { kind: "citation", url: "https://docs.dev/a#section", cited: true, snippet: "quoted" },
          { kind: "file", path: "/mem/MEMORY.md", lineStart: 4, lineEnd: 8, cited: true },
        ],
        itemId: "msg-1",
        turnId: "turn-1",
      }, 3),
      envelope({
        type: "tool_call",
        tool: "linear:list_issues",
        args: {},
        mcp: { server: "linear", tool: "list_issues", appContext: { appName: "Linear", actionName: "List issues" } },
        itemId: "mcp-1",
        turnId: "turn-1",
      }, 4),
    ]);

    expect(sources.cited.map((source) => source.url ?? source.path)).toEqual(["https://docs.dev/a", "/mem/MEMORY.md"]);
    expect(sources.cited[0]!.kinds).toEqual(["fetched_url", "citation"]);
    expect(sources.cited[0]!.title).toBe("Docs A");
    expect(sources.web).toEqual([]);
    expect(sources.files.map((source) => source.title)).toEqual(["spec.md"]);
    expect(sources.apps).toEqual([expect.objectContaining({ title: "Linear", detail: "List issues" })]);
    expect(chatSourceSubtitle(sources.cited[1]!)).toBe("/mem/MEMORY.md:4-8");
  });

  it("marks a source cited when an assistant answer links to it, across fragments and turns", () => {
    const events = [
      envelope({ type: "user_message", text: "research", turnId: "turn-1" }),
      envelope({
        type: "tool_result",
        tool: "WebSearch",
        result: {},
        sources: [
          { kind: "web_search_result", url: "https://www.augmentcode.com/guides/what-is-an-agentic-development-environment", title: "Augment" },
          { kind: "web_search_result", url: "https://docs.letta.com/guides/ade/overview/", title: "Letta" },
          { kind: "web_search_result", url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "Wiki" },
          { kind: "web_search_result", url: "https://arxiv.org/abs/1", title: "Never linked" },
        ],
        itemId: "search-1",
        turnId: "turn-1",
        status: "completed",
      }, 2),
      // A markdown link streamed across two fragments of one message.
      envelope({ type: "text", text: "Sources:\n- [Augment](https://www.augmentcode.com/guides/what-is-an-a", messageId: "m1", turnId: "turn-1" }, 3),
      envelope({ type: "text", text: "gentic-development-environment)\n", messageId: "m1", turnId: "turn-1" }, 4),
      // A later (internal) turn: a bare URL with a trailing period, and a
      // wiki link whose parentheses belong to the URL.
      envelope({
        type: "text",
        text: "See https://docs.letta.com/guides/ade/overview. Also [wiki](https://en.wikipedia.org/wiki/Foo_(bar)).",
        turnId: "claude-idle-1",
      }, 5),
      // A link to a page no tool touched does not become a source.
      envelope({ type: "text", text: "[elsewhere](https://elsewhere.dev/x)", messageId: "m3", turnId: "claude-idle-1" }, 6),
      // A user message linking a source is not a citation.
      envelope({ type: "user_message", text: "what about https://arxiv.org/abs/1 ?", turnId: "turn-2" }, 7),
    ];
    const sources = deriveChatSources(events);
    expect(sources.cited.map((source) => source.title)).toEqual(["Augment", "Letta", "Wiki"]);
    expect(sources.web.map((source) => source.title)).toEqual(["Never linked"]);
    expect(sources.total).toBe(4);
    // Linking changes the group only; the per-turn count is what the turn used.
    expect(sources.byTurn.get("turn-1")).toHaveLength(4);
    expect(sources.byTurn.has("claude-idle-1")).toBe(false);
  });

  it("reads markdown links, autolinks, and bare URLs with the source URL normalization", () => {
    expect([...linkedSourceUrls(
      "Read [A](HTTPS://WWW.A.dev/Docs/?utm_source=x#top), <https://b.dev/path/>, and https://c.dev/q?id=1, then `https://d.dev`.",
    )]).toEqual(["https://a.dev/Docs", "https://b.dev/path", "https://c.dev/q?id=1", "https://d.dev"]);
    expect([...linkedSourceUrls("**https://e.dev/x**")]).toEqual(["https://e.dev/x"]);
    expect(linkedSourceUrls("no links here, file:///etc/passwd").size).toBe(0);
  });

  it("counts per turn without attachments or apps", () => {
    const events = [
      envelope({ type: "user_message", text: "hi", turnId: "turn-1", attachments: [{ type: "file", path: "/a.md" }] }),
      envelope({
        type: "tool_call",
        tool: "github:search",
        args: {},
        mcp: { server: "github", tool: "search" },
        itemId: "m",
        turnId: "turn-1",
      }, 2),
      envelope({
        type: "web_search",
        query: "q",
        results: [{ url: "https://a.dev" }, { url: "https://b.dev" }],
        itemId: "w",
        turnId: "turn-1",
        status: "completed",
      }, 3),
      envelope({
        type: "web_search",
        query: "q2",
        results: [{ url: "https://a.dev/" }],
        itemId: "w2",
        turnId: "turn-2",
        status: "completed",
      }, 4),
    ];
    const derived = deriveChatSources(events);
    expect([...derived.byTurn].map(([turnId, list]) => [turnId, list.length])).toEqual([
      ["turn-1", 2],
      ["turn-2", 1],
    ]);
    expect(derived.apps.map((source) => source.title)).toEqual(["github"]);
    expect(derived.total).toBe(4);
    expect(deriveChatSources([]).total).toBe(0);
  });

  it("keeps MCP connectors and JSON result URLs, excluding node_repl plumbing", () => {
    const mcp = { server: "github", tool: "search_issues", appContext: { appName: "GitHub", actionName: "Search issues" } };
    const sources = deriveChatSources([
      envelope({ type: "tool_call", tool: "github:search_issues", args: {}, mcp, itemId: "mcp-1" }),
      envelope({
        type: "tool_result",
        tool: "github:search_issues",
        result: { items: [{ title: "Issue 56", url: "https://github.com/acme/ade/issues/56#x" }, { url: "file:///tmp/secret" }] },
        itemId: "mcp-1",
        status: "completed",
      }, 2),
      envelope({ type: "tool_call", tool: "node_repl:js", args: {}, mcp: { server: "node_repl", tool: "js" }, itemId: "n" }, 3),
      envelope({ type: "tool_result", tool: "docs:read", result: "See https://prose.dev in prose.", itemId: "p", status: "completed" }, 4),
    ]);
    expect(sources.apps.map((source) => source.title)).toEqual(["GitHub", "docs"]);
    expect(sources.web.map((source) => source.url)).toEqual(["https://github.com/acme/ade/issues/56#x"]);
    expect(sources.web[0]!.title).toBe("Issue 56");
  });

  it("puts every source in exactly one group, with Cited winning over Web and Files", () => {
    const sources = deriveChatSources([
      envelope({ type: "web_search", query: "q", results: [{ url: "https://a.dev/x", title: "A" }, { url: "https://b.dev", title: "B" }], itemId: "w", turnId: "t", status: "completed" }),
      envelope({ type: "tool_result", tool: "WebFetch", result: "", sources: [{ kind: "fetched_url", url: "http://www.a.dev/x/" }], itemId: "f", turnId: "t", status: "completed" }, 2),
      envelope({ type: "sources", sources: [{ kind: "file", path: "/m/MEMORY.md", cited: true }], itemId: "m", turnId: "t" }, 3),
      envelope({ type: "user_message", text: "see", attachments: [{ type: "file", path: "/m/MEMORY.md" }] }, 4),
      envelope({ type: "text", text: "Per [A](https://a.dev/x) it works.", itemId: "answer", turnId: "t" }, 5),
    ]);
    const grouped = [...sources.cited, ...sources.web, ...sources.files, ...sources.apps].map((source) => source.id);
    expect(grouped).toHaveLength(sources.total);
    expect(new Set(grouped).size).toBe(sources.total);
    expect(sources.cited.map((source) => source.url ?? source.path)).toEqual(["https://a.dev/x", "/m/MEMORY.md"]);
    expect(sources.web.map((source) => source.url)).toEqual(["https://b.dev"]);
    expect(sources.files).toEqual([]);
  });

  it("owner's '20 sites' chat: an untitled root fetch no longer prints its domain twice", () => {
    // Trimmed from ~/Projects/ADE/.ade/transcripts/00ed2037-….chat.jsonl: Claude
    // WebFetch results carry only a URL. Root URLs fell back to the domain as the
    // title and the row printed the domain again under it (13 of 22 rows).
    const turnId = "bb8417a7-7663-4425-9695-867f62daa06c";
    const fetched = (itemId: string, url: string, sequence: number) => envelope({
      type: "tool_result",
      tool: "WebFetch",
      result: "# Overview",
      sources: [{ kind: "fetched_url", url }],
      itemId,
      logicalItemId: itemId,
      turnId,
      status: "completed",
    }, sequence);
    const sources = deriveChatSources([
      fetched("toolu_01VwXH7TVduSJgweCbMFdCCh", "https://www.deepseek.com", 1),
      fetched("toolu_01E9uzqxLn14BmARX6jQCnLf", "https://www.anthropic.com/research", 2),
      fetched("toolu_01W6KEu5SbJvKLyjn9GqjJvm", "https://windsurf.com/", 3),
      fetched("toolu_017mab2yfBTYcw7wqYgfYcdw", "https://cursor.com/", 4),
    ]).sources;
    expect(sources.map((source) => [source.title, chatSourceSubtitle(source)])).toEqual([
      ["deepseek.com", null],
      ["anthropic.com/research", null],
      ["windsurf.com", null],
      ["cursor.com", null],
    ]);
    // A real title still gets its domain beside it.
    const [titled] = deriveChatSources([
      envelope({ type: "web_search", query: "q", results: [{ url: "https://www.deepseek.com", title: "DeepSeek" }], itemId: "w", status: "completed" }),
    ]).sources;
    expect(chatSourceSubtitle(titled!)).toBe("deepseek.com");
  });

  it("draws a domain or file initial instead of a remote favicon", () => {
    const [web] = deriveChatSources([
      envelope({ type: "web_search", query: "q", results: [{ url: "https://www.zed.dev" }], itemId: "w", status: "completed" }),
    ]).sources;
    expect(chatSourceInitial(web!)).toBe("Z");
    expect(chatSourceInitial({ title: "x", path: "/repo/readme.md" })).toBe("R");
  });
});
