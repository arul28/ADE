import { describe, expect, it } from "vitest";
import {
  __clearAssistantMarkdownCacheForTests,
  __getAssistantMarkdownCacheStatsForTests,
  diffLineKind,
  latestExpandableFailureId,
  parseAssistantMarkdown,
  parseInlineRuns,
  renderChatLines,
  renderObject,
  webSearchResultDomain,
  webSearchResultPreviewLines,
} from "../format";
import { formatRelativePastTime } from "../relativeTime";
import { terminalReasonLabel } from "../terminalReason";

describe("terminalReasonLabel", () => {
  it.each([
    ["budget_exhausted", "budget limit reached"],
    ["max_turns", "max turns reached"],
    ["prompt_too_long", "context window overflow"],
    ["api_error", "API error after retries"],
    ["malformed_tool_use_exhausted", "tool-call retries exhausted"],
    ["structured_output_retry_exhausted", "output retries exhausted"],
    ["model_error", "model error"],
    ["turn_setup_failed", "turn setup failed"],
    ["tool_deferred_unavailable", "deferred tool unavailable"],
  ])("maps %s to its shared short label", (reason, label) => {
    expect(terminalReasonLabel(reason)).toBe(label);
  });

  it("keeps unknown future reasons silent", () => {
    expect(terminalReasonLabel("future_reason")).toBeNull();
  });
});

describe("webSearchResultPreviewLines", () => {
  it("derives domains defensively and never throws on malformed urls", () => {
    expect(webSearchResultDomain("https://www.example.com/codex")).toBe("example.com");
    expect(webSearchResultDomain("docs.example.org/server?x=1")).toBe("docs.example.org");
    expect(webSearchResultDomain("not a url")).toBe("not a url");
    expect(webSearchResultDomain(undefined)).toBe("");
  });

  it("renders `title — domain` lines, falling back to domain then url", () => {
    const lines = webSearchResultPreviewLines(
      [
        { title: "Codex docs", url: "https://www.example.com/codex" },
        { url: "https://docs.example.org/server" },
      ],
      undefined,
      3,
    );
    expect(lines).toEqual([
      "Codex docs — example.com",
      "docs.example.org",
    ]);
  });

  it("caps at max and appends `+N more` using resultsTotal", () => {
    const lines = webSearchResultPreviewLines(
      [
        { title: "One", url: "https://a.com" },
        { title: "Two", url: "https://b.com" },
        { title: "Three", url: "https://c.com" },
        { title: "Four", url: "https://d.com" },
      ],
      9,
      3,
    );
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("Three — c.com  +6 more");
  });

  it("returns no lines when results are absent", () => {
    expect(webSearchResultPreviewLines(undefined, undefined)).toEqual([]);
    expect(webSearchResultPreviewLines([], 0)).toEqual([]);
  });
});

describe("diffLineKind", () => {
  it("classifies hunk, meta, add, del, and context lines", () => {
    expect(diffLineKind("@@ -1,4 +1,6 @@ fn main()")).toBe("hunk");
    expect(diffLineKind("diff --git a/x b/x")).toBe("meta");
    expect(diffLineKind("index 1234..5678 100644")).toBe("meta");
    expect(diffLineKind("--- a/x")).toBe("meta");
    expect(diffLineKind("+++ b/x")).toBe("meta");
    expect(diffLineKind("new file mode 100644")).toBe("meta");
    expect(diffLineKind("\\ No newline at end of file")).toBe("meta");
    expect(diffLineKind("+added content")).toBe("add");
    expect(diffLineKind("-removed content")).toBe("del");
    expect(diffLineKind(" unchanged context")).toBe("context");
    expect(diffLineKind("")).toBe("context");
  });
});

describe("formatRelativePastTime", () => {
  it("uses a neutral fallback for missing or invalid timestamps", () => {
    expect(formatRelativePastTime(null)).toBe("recently");
    expect(formatRelativePastTime("not-a-date")).toBe("recently");
  });
});

describe("renderChatLines", () => {
  it("LRU-caches assistant markdown parses by message text", () => {
    __clearAssistantMarkdownCacheForTests();
    const text = "Paragraph text\n\n```ts\nconst value = 1;\n```";
    const first = parseAssistantMarkdown(text);
    const second = parseAssistantMarkdown(text);

    expect(second).toBe(first);
    expect(__getAssistantMarkdownCacheStatsForTests().entries).toBe(1);
  });

  it("parses assistant markdown into stable blocks", () => {
    const blocks = parseAssistantMarkdown([
      "# Heading",
      "",
      "Paragraph text",
      "",
      "- Bullet",
      "1. Numbered",
      "> Quote",
      "",
      "```sh",
      "npm test",
      "```",
    ].join("\n"));
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Heading" },
      { kind: "paragraph", text: "Paragraph text" },
      { kind: "bullet", text: "Bullet" },
      { kind: "numbered", number: "1", text: "Numbered" },
      { kind: "quote", text: "Quote" },
      expect.objectContaining({ kind: "code", language: "sh", lines: ["npm test"] }),
    ]);
    const code = blocks[5];
    expect(code?.kind).toBe("code");
    if (code?.kind === "code") {
      // sh is aliased → bash, so highlighting populates per-line tokens.
      expect(code.tokens).toBeDefined();
      expect(code.tokens?.length).toBe(1);
      expect(code.tokens?.[0]?.length).toBeGreaterThan(0);
    }
  });

  it("parses fenced code without language as raw lines and no tokens", () => {
    const blocks = parseAssistantMarkdown(["```", "plain line 1", "plain line 2", "```"].join("\n"));
    expect(blocks).toEqual([
      { kind: "code", lines: ["plain line 1", "plain line 2"] },
    ]);
    const code = blocks[0];
    if (code?.kind === "code") {
      expect(code.language).toBeUndefined();
      expect(code.tokens).toBeUndefined();
    }
  });

  it("parses multi-line typescript code block with per-line token arrays", () => {
    const blocks = parseAssistantMarkdown([
      "```ts",
      "const x = 1;",
      "const y = \"two\";",
      "```",
    ].join("\n"));
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block?.kind).toBe("code");
    if (block?.kind === "code") {
      expect(block.lines).toEqual(["const x = 1;", "const y = \"two\";"]);
      expect(block.tokens).toBeDefined();
      expect(block.tokens?.length).toBe(2);
      // At least one keyword token (`const`) must be tagged.
      const allTokens = block.tokens?.flat() ?? [];
      expect(allTokens.some((t) => t.category === "keyword")).toBe(true);
      expect(allTokens.some((t) => t.category === "string")).toBe(true);
    }
  });

  it("parses GFM tables", () => {
    const blocks = parseAssistantMarkdown([
      "| Name | Status |",
      "|------|--------|",
      "| Alice | OK |",
      "| Bob   | Bad |",
    ].join("\n"));
    expect(blocks).toEqual([
      { kind: "table", headers: ["Name", "Status"], rows: [["Alice", "OK"], ["Bob", "Bad"]] },
    ]);
  });

  it("parses thematic break (hr)", () => {
    expect(parseAssistantMarkdown("paragraph\n\n---\n\nafter")).toEqual([
      { kind: "paragraph", text: "paragraph" },
      { kind: "hr" },
      { kind: "paragraph", text: "after" },
    ]);
  });

  it("parses numbered list with explicit starting number", () => {
    expect(parseAssistantMarkdown(["3. Three", "4. Four"].join("\n"))).toEqual([
      { kind: "numbered", number: "3", text: "Three" },
      { kind: "numbered", number: "4", text: "Four" },
    ]);
  });

  it("parses task list checkboxes into bullets", () => {
    const blocks = parseAssistantMarkdown(["- [ ] Open", "- [x] Done"].join("\n"));
    expect(blocks).toEqual([
      { kind: "bullet", text: "[ ] Open" },
      { kind: "bullet", text: "[x] Done" },
    ]);
  });

  it("parses inline markdown into bold/italic/code/link runs", () => {
    const runs = parseInlineRuns("Hello **bold** and *italic* and `code` plus [the docs](https://x)");
    // First plain text, then bold, then plain, then italic, then plain, then code, then plain, then link.
    expect(runs.map((r) => ({ text: r.text, bold: !!r.bold, italic: !!r.italic, code: !!r.code, link: !!r.link })))
      .toEqual([
        { text: "Hello ", bold: false, italic: false, code: false, link: false },
        { text: "bold", bold: true, italic: false, code: false, link: false },
        { text: " and ", bold: false, italic: false, code: false, link: false },
        { text: "italic", bold: false, italic: true, code: false, link: false },
        { text: " and ", bold: false, italic: false, code: false, link: false },
        { text: "code", bold: false, italic: false, code: true, link: false },
        { text: " plus ", bold: false, italic: false, code: false, link: false },
        { text: "the docs", bold: false, italic: false, code: false, link: true },
      ]);
  });

  it("parses nested bold-italic correctly (marked handles nesting)", () => {
    const runs = parseInlineRuns("**bold _both_ rest**");
    // First "bold ", then "both" with bold+italic, then " rest" with bold.
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({ text: "bold ", bold: true });
    expect(runs[1]).toMatchObject({ text: "both", bold: true, italic: true });
    expect(runs[2]).toMatchObject({ text: " rest", bold: true });
  });

  it("renders compact chat turns without speaker metadata spam", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: { type: "user_message", text: "hello" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: { type: "text", text: "hi" },
        },
      ],
    });
    expect(lines.map((line) => line.tone)).toEqual(["user", "assistant"]);
    expect(lines.map((line) => line.header)).toEqual([undefined, undefined]);
  });

  it("orders local notices and chat events by timestamp", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [
        {
          id: "notice-1",
          timestamp: "2026-01-01T12:00:02.000Z",
          tone: "success",
          text: "Auth completed.",
        },
      ],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 1,
          event: { type: "user_message", text: "hello" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 2,
          event: { type: "text", text: "hi" },
        },
      ],
    });

    expect(lines.map((line) => line.body)).toEqual(["hello", "Auth completed.", "hi"]);
    expect(lines.map((line) => line.header)).toEqual([undefined, undefined, undefined]);
  });

  it("omits assistant model labels from normal text", () => {
    const lines = renderChatLines({
      activeSession: {
        sessionId: "s1",
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-7[1m]",
        status: "idle",
        startedAt: "2026-01-01T12:00:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-01-01T12:00:00.000Z",
        lastOutputPreview: null,
        summary: null,
        nextWakeAt: null,
      },
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 1,
          event: { type: "text", text: "hi" },
        },
      ],
    });

    expect(lines[0]?.header).toBeUndefined();
    expect(lines[0]?.body).toBe("hi");
  });

  it("renders non-JSON-safe objects without throwing", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(renderObject(value)).toBe("[object Object]");
  });

  it("passes known terminal-reason labels through failed turn endings", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: { type: "status", turnStatus: "failed", turnId: "turn-1" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: { type: "done", status: "failed", turnId: "turn-1", terminalReason: "prompt_too_long" },
        },
      ],
    });

    expect(terminalReasonLabel("budget_exhausted")).toBe("budget limit reached");
    expect(terminalReasonLabel("future_reason")).toBeNull();
    expect(lines.map((line) => line.body)).toEqual([
      "[status] failed · context window overflow",
      "[done] failed · context window overflow",
    ]);
  });

  it("renders stop receipts and conversation resets as dim notice lines", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: { type: "interrupt_receipt", stillQueuedUuids: ["a", "b"], known: [] },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: { type: "conversation_reset", newConversationId: "conversation-2" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 3,
          event: {
            type: "command_lifecycle",
            commandUuid: "command-1",
            status: "discarded",
            preview: "Run the old request",
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 4,
          event: {
            type: "queue_recovery",
            recoveryId: "recovery-1",
            state: "available",
            messageCount: 2,
            expiresAt: "2026-01-01T12:00:11.000Z",
            stopMode: "stop_and_clear",
          },
        },
      ],
    });

    expect(lines).toEqual([
      expect.objectContaining({ tone: "notice", body: "stopped — 2 queued messages will still run" }),
      expect.objectContaining({ tone: "notice", body: "conversation reset" }),
      expect.objectContaining({ tone: "notice", body: "queued message discarded · Run the old request" }),
      expect.objectContaining({ tone: "notice", body: "cleared 2 queued messages · undo /restore-queue recovery-1" }),
    ]);
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.tone === "notice")).toBe(true);

    const terminalRecoveryLines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 4,
          event: {
            type: "queue_recovery",
            recoveryId: "recovery-1",
            state: "available",
            messageCount: 2,
            expiresAt: "2026-01-01T12:00:11.000Z",
            stopMode: "stop_and_clear",
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:11.000Z",
          sequence: 5,
          event: {
            type: "queue_recovery",
            recoveryId: "recovery-1",
            state: "expired",
            messageCount: 2,
            expiresAt: "2026-01-01T12:00:11.000Z",
            stopMode: "stop_and_clear",
          },
        },
      ],
    });
    expect(terminalRecoveryLines).toEqual([
      expect.objectContaining({ tone: "notice", body: "queue recovery expired" }),
    ]);
  });

  it("renders tool, edit, and compaction events compactly", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: { type: "tool_call", tool: "read", args: { path: "src/app.ts" }, itemId: "tool-1" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: {
            type: "file_change",
            path: "src/app.ts",
            kind: "modify",
            status: "completed",
            itemId: "edit-1",
            diff: "+hello\n-world",
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 3,
          event: { type: "context_compact", trigger: "auto" },
        },
      ],
    });

    expect(lines).toEqual([
      expect.objectContaining({ tone: "tool", body: expect.stringContaining("> read") }),
      expect.objectContaining({ tone: "tool", body: expect.stringContaining("> edit src/app.ts") }),
      expect.objectContaining({ tone: "notice", body: expect.stringContaining("context compacted") }),
    ]);
  });

  it("renders Codex plan, web, and image events and suppresses goal/token chat rows", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: {
            type: "plan",
            steps: [{ text: "Inspect protocol", status: "completed" }],
            state: "updated",
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: {
            type: "web_search",
            query: "Codex app server",
            itemId: "web-1",
            status: "completed",
            actions: [
              { type: "search", query: "Codex app server" },
              { type: "openPage", url: "https://example.com/codex" },
            ],
            results: [
              { title: "Codex app server docs", url: "https://www.example.com/codex" },
              { title: "Deep dive", url: "https://docs.example.org/deep" },
            ],
            resultsTotal: 4,
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 3,
          event: { type: "codex_goal_updated", goal: { objective: "Ship the migration", status: "active" } },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 4,
          event: {
            type: "codex_image_generation",
            itemId: "img-1",
            prompt: "diagram",
            status: "completed",
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:04.000Z",
          sequence: 5,
          event: {
            type: "codex_token_usage",
            usage: { total: { totalTokens: 1200 }, last: { totalTokens: 120 }, modelContextWindow: 200000 },
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:05.000Z",
          sequence: 6,
          event: {
            type: "codex_turn_stalled",
            turnId: "turn-1",
            reason: "no_output",
            message: "Codex accepted the turn but has not streamed output.",
          },
        },
      ],
    });

    const body = lines.map((line) => line.body).join("\n");
    expect(body).toContain("plan");
    // Plan glyphs are unicode now (◐/○/●), not ASCII.
    expect(body).toContain("● Inspect protocol");
    // Web search renders actions per-line, not joined with ` · `.
    expect(body).toContain("web Codex app server");
    expect(body).toMatch(/search\s+Codex app server/);
    expect(body).toMatch(/openPage\s+https:\/\/example\.com\/codex/);
    // Result hits render as compact `title — domain` previews with a `+N more` tail.
    expect(body).toContain("Codex app server docs — example.com");
    expect(body).toContain("Deep dive — docs.example.org +2 more");
    expect(body).toContain("image generated");
    expect(body).toContain("/recover resume (restart runtime + resume)");
    expect(body).toContain("/recover retry (keep current runtime)");
    // Goal/token-usage events are suppressed in the chat transcript.
    expect(body).not.toContain("goal active");
    expect(body).not.toContain("tokens · last");
  });

  it("folds durable resolution into the original unprocessed user message", () => {
    const baseEvents = [{
      sessionId: "s1",
      timestamp: "2026-01-01T12:00:00.000Z",
      sequence: 1,
      event: {
        type: "user_message" as const,
        text: "Please continue",
        steerId: "steer-1",
        deliveryState: "unprocessed" as const,
      },
    }];

    const unresolved = renderChatLines({
      activeSession: null,
      notices: [],
      events: baseEvents,
    });
    expect(unresolved).toEqual([expect.objectContaining({
      header: "not processed · /run-next steer-1 · /edit-message steer-1 · /dismiss-message steer-1",
      body: "Please continue",
    })]);

    const resolved = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        ...baseEvents,
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: {
            type: "user_message_resolution" as const,
            steerId: "steer-1",
            action: "run_next" as const,
            state: "completed" as const,
            resolvedAt: "2026-01-01T12:00:01.000Z",
          },
        },
      ],
    });
    expect(resolved).toEqual([expect.objectContaining({
      header: "not processed · started as the next turn",
      body: "Please continue",
    })]);
  });

  it("prefers provider-neutral health and recovery events over legacy duplicates", () => {
    const healthLines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: {
            type: "turn_health",
            provider: "codex",
            turnId: "turn-1",
            state: "stalled",
            reason: "no_output",
            message: "No output yet",
            turnStartedAt: "2026-01-01T11:58:00.000Z",
            lastProgressAt: "2026-01-01T11:58:00.000Z",
            detectedAt: "2026-01-01T12:00:00.000Z",
            recoveryCount: 0,
            supportedActions: ["wait", "nudge", "retry_same_runtime", "restart_resume"],
            automaticRecoveryAttempted: false,
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.001Z",
          sequence: 2,
          event: {
            type: "turn_health",
            provider: "codex",
            turnId: "turn-1",
            state: "stalled",
            reason: "no_progress",
            message: "Still no output",
            turnStartedAt: "2026-01-01T11:58:00.000Z",
            lastProgressAt: "2026-01-01T11:58:00.000Z",
            detectedAt: "2026-01-01T12:00:00.001Z",
            recoveryCount: 0,
            supportedActions: ["wait", "nudge", "retry_same_runtime", "restart_resume"],
            automaticRecoveryAttempted: false,
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.002Z",
          sequence: 3,
          event: {
            type: "codex_turn_stalled",
            turnId: "turn-1",
            reason: "no_output",
            message: "No output yet",
          },
        },
      ],
    });
    expect(healthLines.filter((line) => line.body.startsWith("recovery ·"))).toHaveLength(1);
    expect(healthLines[0]?.body).toContain("Still no output");
    expect(healthLines[0]?.body).toContain("keep current runtime");

    const recoveryLines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 3,
          event: {
            type: "turn_recovery",
            provider: "codex",
            turnId: "turn-1",
            action: "restart_resume",
            state: "recovered",
            message: "Thread resumed",
            automatic: true,
            at: "2026-01-01T12:00:01.000Z",
            recoveryCount: 1,
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.001Z",
          sequence: 4,
          event: {
            type: "codex_turn_recovery",
            turnId: "turn-1",
            action: "restart_resume_thread",
            state: "recovered",
            message: "Thread resumed",
            automatic: true,
            at: "2026-01-01T12:00:01.000Z",
          },
        },
      ],
    });
    expect(recoveryLines).toEqual([expect.objectContaining({
      body: "recovered automatically · Thread resumed",
    })]);
  });

  it("renders the new event variants (status, error, done, todo, subagent, completion_report, turn_diff_summary, codex_context_compaction)", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: { type: "status", turnStatus: "completed" } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: { type: "error", message: "rate limited" } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 3,
          event: {
            type: "done",
            turnId: "t1",
            status: "completed",
            usage: { inputTokens: 1200, outputTokens: 500 },
            costUsd: 0.13,
          } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 4,
          event: {
            type: "todo_update",
            items: [
              { id: "1", description: "Read", status: "completed" },
              { id: "2", description: "Write", status: "in_progress" },
            ],
          } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:04.000Z",
          sequence: 5,
          event: { type: "subagent_started", taskId: "ag", description: "do thing" } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:05.000Z",
          sequence: 6,
          event: {
            type: "completion_report",
            report: { timestamp: "x", summary: "shipped it", status: "completed", artifacts: [] },
          } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:06.000Z",
          sequence: 7,
          event: {
            type: "turn_diff_summary",
            turnId: "t",
            beforeSha: "a",
            afterSha: "b",
            files: [{ path: "x" }, { path: "y" }] as never,
            totalAdditions: 12,
            totalDeletions: 4,
          } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:07.000Z",
          sequence: 8,
          event: {
            type: "codex_context_compaction",
            turnId: "t",
            state: "started",
            trigger: "manual",
          } as never,
        },
      ],
    });

    const body = lines.map((line) => line.body).join("\n");
    expect(body).toContain("[status] completed");
    expect(body).toContain("[error] rate limited");
    expect(body).toMatch(/\[done\] completed/);
    expect(body).toContain("todos");
    expect(body).toContain("● Read");
    expect(body).toContain("◐ Write");
    expect(body).toContain("[agent] do thing (started)");
    expect(body).toContain("[done] turn summary: shipped it");
    expect(body).toContain("[diff] +12/-4 across 2 files");
    expect(body).toContain("⟳ compacting · manual");
  });

  it("renders cloud, step_boundary, structured_question, prompt_suggestion, auto_approval_review, tool_use_summary, and delegation_state lines", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: {
            type: "cloud_artifact",
            turnId: "t",
            itemId: "i",
            agentId: "a",
            runId: "r",
            path: "/tmp/out.txt",
            lanePath: "/tmp/lane",
          } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: {
            type: "cloud_status",
            turnId: "t",
            runId: "r",
            status: "running",
            detail: "spinning up",
          } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 3,
          event: { type: "step_boundary", stepNumber: 3 } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 4,
          event: {
            type: "structured_question",
            question: "Approve refactor?",
            itemId: "q1",
          } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:04.000Z",
          sequence: 5,
          event: { type: "prompt_suggestion", suggestion: "try /compact" } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:05.000Z",
          sequence: 6,
          event: {
            type: "auto_approval_review",
            targetItemId: "x",
            reviewStatus: "started",
            action: "shell",
          } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:06.000Z",
          sequence: 7,
          event: { type: "tool_use_summary", summary: "ran 4 tools", toolUseIds: [] } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:07.000Z",
          sequence: 8,
          event: {
            type: "delegation_state",
            message: "handoff to worker-a",
            contract: { status: "active", workerIntent: "implement" } as never,
          } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:08.000Z",
          sequence: 9,
          event: { type: "delegation_state" } as never,
        },
      ],
    });

    const body = lines.map((line) => line.body).join("\n");
    expect(body).toContain("[cloud] artifact");
    expect(body).toContain("out.txt");
    expect(body).toContain("[cloud] running");
    expect(body).toContain("── step 3 ──");
    expect(body).toContain("[?] Approve refactor?");
    expect(body).toContain("💡 try /compact");
    expect(body).toMatch(/\[auto-approval\] started/);
    expect(body).toContain("[tools] ran 4 tools");
    expect(body).toContain("[delegation] handoff to worker-a");
    expect(body).toContain("[delegation] state");
  });

  it("suppresses pending_input_resolved and tokens events from the chat transcript", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: {
            type: "pending_input_resolved",
            itemId: "q1",
            resolution: "accepted",
          } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: {
            type: "tokens",
            turnId: "t",
            inputTokens: 100,
            outputTokens: 50,
            contextWindow: 10_000,
          } as never,
        },
      ],
    });
    expect(lines).toHaveLength(0);
  });

  it("fixes the system_notice continue regression (does not duplicate subsequent rows)", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: { type: "system_notice", noticeKind: "info", message: "hi" } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: { type: "text", text: "after notice" },
        },
      ],
    });
    // Without the `continue;` fix the loop would fall through and a duplicate
    // empty/error row could be appended. Assert the two-event input → two-line
    // output, with the notice first and the text second.
    expect(lines).toHaveLength(2);
    expect(lines[0]?.tone).toBe("notice");
    expect(lines[1]?.tone).toBe("assistant");
  });

  it("suppresses low-value startup system notices and keeps auth failures concise", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: { type: "system_notice", noticeKind: "info", message: "Session ready" } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: { type: "system_notice", noticeKind: "hook", message: "Hook: SessionStart:startup started" } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 3,
          event: { type: "system_notice", noticeKind: "hook", message: "Trimmed large tool output before sending it back to Claude." } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 4,
          event: { type: "system_notice", noticeKind: "auth", message: "Failed to authenticate. API Error: 401 Invalid authentication credentials" } as never,
        },
      ],
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(expect.objectContaining({
      tone: "error",
      body: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    }));
    expect(lines[0]?.header).toBeUndefined();
  });

  it("deduplicates consecutive identical notice rows", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: { type: "system_notice", noticeKind: "info", message: "Refreshing provider status." } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: { type: "system_notice", noticeKind: "info", message: "Refreshing provider status." } as never,
        },
      ],
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.body).toBe("Refreshing provider status.");
  });

  it("routes severity-bearing system_notice variants to tone=error in the TUI", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: { type: "system_notice", noticeKind: "error", message: "🛡 guardian: sandbox tripped" } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: { type: "system_notice", noticeKind: "warning", message: "⚠ deprecated: old method" } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 3,
          event: { type: "system_notice", noticeKind: "config", message: "⚙ config: stale layer" } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 4,
          event: { type: "system_notice", noticeKind: "rate_limit", severity: "error", message: "rate limit hit" } as never,
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:04.000Z",
          sequence: 5,
          event: { type: "system_notice", noticeKind: "rate_limit", severity: "info", message: "Claude rate limit allowed" } as never,
        },
      ],
    });
    expect(lines).toHaveLength(5);
    expect(lines[0]?.tone).toBe("error"); // error noticeKind
    expect(lines[1]?.tone).toBe("notice"); // warning is informational
    expect(lines[2]?.tone).toBe("notice"); // config is informational
    expect(lines[3]?.tone).toBe("error"); // blocking rate_limit is severity-bearing
    expect(lines[4]?.tone).toBe("notice"); // allowed rate_limit is telemetry
  });

  it("summarizes command pass and fail counts when present", () => {
    const events = [{
      sessionId: "s1",
      timestamp: "2026-01-01T12:00:00.000Z",
      sequence: 1,
      event: {
        type: "command",
        command: "vitest",
        cwd: "/repo",
        output: "Test Files 1 failed | Tests 7 passed, 1 failed",
        itemId: "cmd-1",
        status: "failed",
        exitCode: 1,
        durationMs: 2100,
      },
    }] as const;
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [...events],
    });

    expect(lines[0]).toEqual(expect.objectContaining({
      tone: "error",
      body: expect.stringContaining("7 passed · 1 failed"),
    }));
    expect(lines[0]?.body).toContain("↵ expands");
    expect(latestExpandableFailureId([...events])).toBe("1:command:2026-01-01T12:00:00.000Z");
  });

  it("coalesces consecutive streamed text events from the same provider into one line", () => {
    const session = {
      sessionId: "s1",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.5",
      status: "idle",
      startedAt: "2026-01-01T12:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-01-01T12:00:00.000Z",
      lastOutputPreview: null,
      summary: null,
      nextWakeAt: null,
    } as const;
    const lines = renderChatLines({
      activeSession: session,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 1,
          event: { type: "text", text: "I'm Codex," },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 2,
          event: { type: "text", text: " running as a GPT-5 based" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 3,
          event: { type: "text", text: " software engineering agent." },
        },
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.tone).toBe("assistant");
    expect(lines[0]?.body).toBe("I'm Codex, running as a GPT-5 based software engineering agent.");
    expect(lines[0]?.blocks).toEqual([
      { kind: "paragraph", text: "I'm Codex, running as a GPT-5 based software engineering agent." },
    ]);
    expect(lines[0]?.header).toBeUndefined();
  });

  it("keeps concurrent interleaved messages separate and intact, and filters codex-subagent text", () => {
    const session = {
      sessionId: "s1", laneId: "lane-1", provider: "codex", model: "gpt-5.5", status: "idle",
      startedAt: "2026-01-01T12:00:00.000Z", endedAt: null, lastActivityAt: "2026-01-01T12:00:00.000Z",
      lastOutputPreview: null, summary: null, nextWakeAt: null,
    } as const;
    // Parent message "A" and a concurrent message "B" stream interleaved by
    // timestamp, plus a codex-subagent message that must not reach the parent
    // transcript. Each delta carries its own leading space.
    const lines = renderChatLines({
      activeSession: session,
      notices: [],
      events: [
        { sessionId: "s1", timestamp: "2026-01-01T12:00:01.000Z", sequence: 1,
          event: { type: "text", text: "Planning the", messageId: "msg-A", turnId: "t1", itemId: "iA" } },
        { sessionId: "s1", timestamp: "2026-01-01T12:00:01.100Z", sequence: 2,
          event: { type: "text", text: "Reading the", messageId: "msg-B", turnId: "t1", itemId: "iB" } },
        { sessionId: "s1", timestamp: "2026-01-01T12:00:01.200Z", sequence: 3,
          event: { type: "text", text: " architecture pass.", messageId: "msg-A", turnId: "t1", itemId: "iA" } },
        { sessionId: "s1", timestamp: "2026-01-01T12:00:01.300Z", sequence: 4,
          event: { type: "text", text: " renderer files.", messageId: "msg-B", turnId: "t1", itemId: "iB" } },
        { sessionId: "s1", timestamp: "2026-01-01T12:00:01.400Z", sequence: 5,
          event: { type: "text", text: "Subagent secret leak.", messageId: "codex-subagent:x:y:z:text", turnId: "t1", itemId: "iC" } },
      ],
    });
    const assistant = lines.filter((l) => l.tone === "assistant");
    // No single line scrambles the two messages together (the old identity-blind
    // bug fused interleaved deltas — losing word boundaries at the seams).
    for (const line of assistant) {
      expect(line.body.includes("architecture") && line.body.includes("renderer")).toBe(false);
    }
    // Re-joining each message's fragments (kept attributed by messageId) yields
    // the original, fully-spaced text — proving the pipeline never drops spaces.
    const joinById = (id: string) => assistant.filter((l) => l.messageId === id).map((l) => l.body).join("");
    expect(joinById("msg-A")).toBe("Planning the architecture pass.");
    expect(joinById("msg-B")).toBe("Reading the renderer files.");
    // codex-subagent content never reaches the parent transcript.
    expect(assistant.map((l) => l.body).join("\n")).not.toContain("Subagent secret leak");
  });

  it("does not coalesce assistant text across a tool call", () => {
    const session = {
      sessionId: "s1",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.5",
      status: "idle",
      startedAt: "2026-01-01T12:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-01-01T12:00:00.000Z",
      lastOutputPreview: null,
      summary: null,
      nextWakeAt: null,
    } as const;
    const lines = renderChatLines({
      activeSession: session,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 1,
          event: { type: "text", text: "I'll check the branch." },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 2,
          event: { type: "tool_call", tool: "shell", args: { command: "git branch" }, itemId: "tool-1" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 3,
          event: { type: "text", text: "We're on main." },
        },
      ],
    });
    expect(lines.map((line) => line.tone)).toEqual(["assistant", "tool", "assistant"]);
    expect(lines[0]?.body).toBe("I'll check the branch.");
    expect(lines[2]?.body).toBe("We're on main.");
    expect(lines[2]?.header).toBeUndefined();
  });

  it("removes assistant lines superseded by transcript retractions", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 1,
          event: { type: "text", text: "Original answer", messageId: "msg-old", turnId: "turn-1" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 2,
          event: {
            type: "transcript_retraction",
            messageIds: ["msg-old"],
            reason: "assistant_supersedes",
            replacementMessageId: "msg-new",
            turnId: "turn-1",
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 3,
          event: { type: "text", text: "Replacement answer", messageId: "msg-new", turnId: "turn-1" },
        },
      ],
    });

    expect(lines.filter((line) => line.tone === "assistant").map((line) => line.body)).toEqual([
      "Replacement answer",
    ]);
  });

  it("renders expanded failed tool output when requested", () => {
    const events = [{
      sessionId: "s1",
      timestamp: "2026-01-01T12:00:00.000Z",
      sequence: 1,
      event: {
        type: "tool_result",
        tool: "read",
        result: { error: "Permission denied", path: "/repo/secret" },
        itemId: "tool-1",
        status: "failed",
      },
    }] as const;
    const id = latestExpandableFailureId([...events]);
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [...events],
      expandedLineIds: new Set(id ? [id] : []),
    });

    expect(lines[0]).toEqual(expect.objectContaining({
      tone: "error",
      body: expect.stringContaining("Permission denied"),
    }));
    expect(lines[0]?.body).not.toContain("↵ expands");
  });
});

describe("ade_card (TUI)", () => {
  const env = (timestamp: string, sequence: number, event: unknown) => ({
    sessionId: "s1",
    timestamp,
    sequence,
    event: event as never,
  });

  const card = (over: Record<string, unknown> = {}) => ({
    type: "ade_card",
    cardId: "run-42",
    variant: "proof_artifact",
    state: "terminal",
    title: "Cloud artifacts pulled",
    fallbackText: "3 cloud artifacts pulled into the lane",
    ...over,
  });

  it("renders a box-drawn card with fixed-width walls", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        env("2026-07-27T12:00:00.000Z", 1, card({
          subtitle: "run-42",
          metrics: [{ label: "files", value: "3" }],
          rows: [{ icon: "file", text: "report.md", detail: "12 KB" }],
          progress: { passed: 3, failed: 0, running: 0, queued: 0 },
        })),
      ],
    });

    const body = lines.at(-1)!.body;
    const rendered = body.split("\n");
    expect(rendered[0]!.startsWith("┌")).toBe(true);
    expect(rendered[0]!).toContain("Cloud artifacts pulled");
    expect(body).toContain("3 files");
    expect(body).toContain("report.md");
    expect(body).toContain("12 KB");

    // Every box line is exactly the same width — a ragged box is the one thing
    // that makes a TUI card look broken.
    const boxLines = rendered.filter((line) => /^[┌│└]/.test(line));
    expect(new Set(boxLines.map((line) => [...line].length)).size).toBe(1);
    expect(boxLines.at(-1)!.startsWith("└")).toBe(true);
  });

  it("falls back to fallbackText + deeplink for an unknown variant", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        env("2026-07-27T12:00:00.000Z", 1, card({
          variant: "future_ci",
          title: "CI failed",
          fallbackText: "CI failed · 20 passed · 1 failed",
          navTarget: { kind: "pr", repoOwner: "arul28", repoName: "ADE", prNumber: 916 },
        })),
      ],
    });

    const body = lines.at(-1)!.body;
    expect(body).toContain("CI failed · 20 passed · 1 failed");
    expect(body).toContain("ade://");
    // No box: an unknown variant must not be drawn as if it were understood.
    expect(body).not.toContain("┌");
  });

  it("shows only the executable open hint, not inert numbered actions", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        env("2026-07-27T12:00:00.000Z", 1, card({
          navTarget: { kind: "pr", repoOwner: "arul28", repoName: "ADE", prNumber: 916 },
          actions: [
            { id: "open", label: "Review merge", kind: "primary" },
            { id: "future-action", label: "Do something", kind: "default" },
          ],
        })),
      ],
    });

    const body = lines.at(-1)!.body;
    expect(body).toContain("[o] open");
    expect(body).not.toContain("[1]");
    expect(body).not.toContain("Do something");
  });

  it("merges repeat emits of one cardId into a single row at its first position", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        env("2026-07-27T12:00:00.000Z", 1, card({ state: "live", title: "Pulling cloud artifacts", metrics: [{ label: "files", value: "1" }] })),
        env("2026-07-27T12:00:01.000Z", 2, { type: "text", text: "meanwhile", messageId: "m-1" }),
        env("2026-07-27T12:00:02.000Z", 3, card({ metrics: [{ label: "files", value: "3" }] })),
      ],
    });

    const cardLines = lines.filter((line) => line.body.includes("┌"));
    expect(cardLines).toHaveLength(1);
    expect(cardLines[0]!.body).toContain("Cloud artifacts pulled");
    expect(cardLines[0]!.body).toContain("3 files");
    // Position: the card precedes the text that arrived after its first emit.
    const cardIndex = lines.findIndex((line) => line.body.includes("┌"));
    const textIndex = lines.findIndex((line) => line.body.includes("meanwhile"));
    expect(cardIndex).toBeLessThan(textIndex);
  });

  it("preserves trusted detail and labels it stale when a degraded refresh lands", () => {
    const initial = card({
      rows: [{ icon: "pass", text: "lint", detail: "passed" }],
      rowsTruncated: 2,
      metrics: [{ label: "jobs", value: "3" }],
      progress: { passed: 3, failed: 0, running: 0, queued: 0 },
    });
    const degraded = card({
      rows: [],
      progress: { passed: 0, failed: 0, running: 0, queued: 0 },
      degradedReason: "HTTP 403: rate limited",
    });

    const degradedBody = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        env("2026-07-27T12:00:00.000Z", 1, initial),
        env("2026-07-27T12:01:00.000Z", 2, degraded),
      ],
    }).at(-1)!.body;
    expect(degradedBody).toContain("lint");
    expect(degradedBody).toContain("3 jobs");
    expect(degradedBody).toContain("+2 more");
    expect(degradedBody).toContain("detail unavailable");
    expect(degradedBody).toContain("stale");
    expect(degradedBody).toContain("HTTP 403: rate limited");

    const recoveredBody = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        env("2026-07-27T12:00:00.000Z", 1, initial),
        env("2026-07-27T12:01:00.000Z", 2, degraded),
        env("2026-07-27T12:02:00.000Z", 3, card({
          rows: [{ icon: "pass", text: "tests", detail: "passed" }],
          progress: { passed: 1, failed: 0, running: 0, queued: 0 },
        })),
      ],
    }).at(-1)!.body;
    expect(recoveredBody).toContain("tests");
    expect(recoveredBody).not.toContain("lint");
    expect(recoveredBody).not.toContain("stale");
    expect(recoveredBody).not.toContain("detail unavailable");
  });

  it("renders a card's measured duration with an hour unit", () => {
    const body = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        env("2026-07-27T12:00:00.000Z", 1, card({
          durationMs: 3_723_000,
          rows: [{ icon: "file", text: "report.md" }],
          rowsTruncated: 4,
        })),
      ],
    }).at(-1)!.body;

    expect(body).toContain("ran 1h 2m");
    expect(body).toContain("report.md");
    expect(body).toContain("+4 more");
  });
});
