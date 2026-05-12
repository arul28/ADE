import { describe, expect, it } from "vitest";
import { latestExpandableFailureId, parseAssistantMarkdown, renderChatLines, renderObject } from "../format";

describe("renderChatLines", () => {
  it("parses assistant markdown into stable blocks", () => {
    expect(parseAssistantMarkdown([
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
    ].join("\n"))).toEqual([
      { kind: "heading", level: 1, text: "Heading" },
      { kind: "paragraph", text: "Paragraph text" },
      { kind: "bullet", text: "Bullet" },
      { kind: "numbered", number: "1", text: "Numbered" },
      { kind: "quote", text: "Quote" },
      { kind: "code", language: "sh", lines: ["npm test"] },
    ]);
  });

  it("renders compact rule-separated chat turns", () => {
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
    expect(lines[0]?.header).toContain("you");
    expect(lines[1]?.header).toContain("ADE");
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
  });

  it("keeps terminal formatting artifacts out of model labels", () => {
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

    expect(lines[0]?.header).toMatch(/^Claude · .* · claude-opus-4-7$/);
  });

  it("renders non-JSON-safe objects without throwing", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(renderObject(value)).toBe("[object Object]");
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
    expect(body).toContain("image generated");
    // Goal/token-usage events are suppressed in the chat transcript.
    expect(body).not.toContain("goal active");
    expect(body).not.toContain("tokens · last");
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
    expect(lines[0]?.header).toMatch(/^Codex /);
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
    expect(lines[2]?.header).toMatch(/^Codex /);
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
