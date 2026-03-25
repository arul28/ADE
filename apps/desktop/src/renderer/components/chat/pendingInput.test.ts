/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { derivePendingInputRequests } from "./pendingInput";
import type { DerivedPendingInput } from "./pendingInput";

// ---------------------------------------------------------------------------
// Helpers for building test envelopes
// ---------------------------------------------------------------------------

function envelope(
  event: AgentChatEventEnvelope["event"],
  sessionId = "session-1",
  timestamp = "2026-03-25T10:00:00.000Z",
): AgentChatEventEnvelope {
  return { sessionId, timestamp, event };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("derivePendingInputRequests", () => {
  // ---- Empty / trivial cases -------------------------------------------

  it("returns empty array for empty events", () => {
    expect(derivePendingInputRequests([])).toEqual([]);
  });

  it("returns empty array when events contain no pending-input types", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "text",
        text: "Hello world",
        turnId: "turn-1",
      }),
      envelope({
        type: "reasoning",
        text: "Thinking...",
        turnId: "turn-1",
      }),
    ];
    expect(derivePendingInputRequests(events)).toEqual([]);
  });

  // ---- done event clears all pending ------------------------------------

  it("done event clears all pending inputs", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-1",
        kind: "command",
        description: "Run npm test",
        turnId: "turn-1",
        detail: { tool: "exec_command", question: "" },
      }),
      envelope({
        type: "approval_request",
        itemId: "item-2",
        kind: "file_change",
        description: "Edit foo.ts",
        turnId: "turn-1",
        detail: { tool: "write_file", question: "" },
      }),
      envelope({
        type: "done",
        turnId: "turn-1",
        status: "completed",
      }),
    ];
    expect(derivePendingInputRequests(events)).toEqual([]);
  });

  // ---- approval_request with structured request in detail ---------------

  it("derives PendingInputRequest from approval_request with structured request", () => {
    const structuredRequest = {
      requestId: "req-1",
      itemId: "item-1",
      source: "mission",
      kind: "approval",
      title: "Approve deploy",
      description: "Deploy to staging",
      questions: [
        {
          id: "q1",
          question: "Are you sure?",
          header: "Confirmation",
          allowsFreeform: true,
        },
      ],
      allowsFreeform: false,
      blocking: true,
      canProceedWithoutAnswer: false,
    };
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-1",
        kind: "command",
        description: "Deploy to staging",
        turnId: "turn-1",
        detail: { request: structuredRequest },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe("session-1");
    expect(result[0]!.itemId).toBe("item-1");
    expect(result[0]!.request.requestId).toBe("req-1");
    expect(result[0]!.request.kind).toBe("approval");
    expect(result[0]!.request.title).toBe("Approve deploy");
    expect(result[0]!.request.questions).toHaveLength(1);
    expect(result[0]!.request.questions[0]!.id).toBe("q1");
  });

  // ---- approval_request legacy AskUser ----------------------------------

  it("builds legacy pending input from AskUser tool", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-ask",
        kind: "tool_call",
        description: "AskUser",
        turnId: "turn-1",
        detail: {
          tool: "AskUser",
          question: "What color theme do you prefer?",
        },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.kind).toBe("question");
    expect(result[0]!.request.description).toBe("What color theme do you prefer?");
    expect(result[0]!.request.allowsFreeform).toBe(true);
    expect(result[0]!.request.questions).toHaveLength(1);
    expect(result[0]!.request.questions[0]!.id).toBe("response");
    expect(result[0]!.request.questions[0]!.question).toBe("What color theme do you prefer?");
    expect(result[0]!.request.questions[0]!.allowsFreeform).toBe(true);
    expect(result[0]!.request.source).toBe("mission");
    expect(result[0]!.request.turnId).toBe("turn-1");
  });

  it("builds legacy pending input from ask_user tool (snake_case)", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-ask-2",
        kind: "tool_call",
        description: "ask_user",
        turnId: "turn-1",
        detail: {
          tool: "ask_user",
          question: "Pick a number",
        },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.kind).toBe("question");
    expect(result[0]!.request.description).toBe("Pick a number");
  });

  it("AskUser with options yields structured_question kind", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-opt",
        kind: "tool_call",
        description: "AskUser",
        turnId: "turn-1",
        detail: {
          tool: "AskUser",
          question: "Choose a deployment target",
          options: [
            { label: "Staging", value: "staging" },
            { label: "Production", value: "production", description: "Be careful", recommended: true },
          ],
        },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.kind).toBe("structured_question");
    expect(result[0]!.request.questions[0]!.options).toHaveLength(2);
    expect(result[0]!.request.questions[0]!.options![0]!.label).toBe("Staging");
    expect(result[0]!.request.questions[0]!.options![1]!.recommended).toBe(true);
    expect(result[0]!.request.questions[0]!.options![1]!.description).toBe("Be careful");
  });

  // ---- approval_request generic approval --------------------------------

  it("builds approval pending input for non-AskUser tool", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-cmd",
        kind: "command",
        description: "Run: rm -rf /tmp/junk",
        turnId: "turn-1",
        detail: {
          tool: "exec_command",
          command: "rm -rf /tmp/junk",
        },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.kind).toBe("approval");
    expect(result[0]!.request.description).toBe("Run: rm -rf /tmp/junk");
    expect(result[0]!.request.allowsFreeform).toBe(false);
    expect(result[0]!.request.questions).toEqual([]);
    expect(result[0]!.request.blocking).toBe(true);
  });

  // ---- structured_question event ----------------------------------------

  it("derives structured question input from structured_question event", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "structured_question",
        question: "Which database should I use?",
        options: [
          { label: "PostgreSQL", value: "pg" },
          { label: "SQLite", value: "sqlite" },
        ],
        itemId: "sq-1",
        turnId: "turn-1",
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.kind).toBe("structured_question");
    expect(result[0]!.request.description).toBe("Which database should I use?");
    expect(result[0]!.request.questions).toHaveLength(1);
    expect(result[0]!.request.questions[0]!.question).toBe("Which database should I use?");
    expect(result[0]!.request.questions[0]!.options).toHaveLength(2);
    expect(result[0]!.request.questions[0]!.options![0]!.label).toBe("PostgreSQL");
    expect(result[0]!.request.questions[0]!.options![0]!.value).toBe("pg");
    expect(result[0]!.request.allowsFreeform).toBe(true);
    expect(result[0]!.request.blocking).toBe(true);
    expect(result[0]!.request.turnId).toBe("turn-1");
  });

  it("structured_question without options omits options from question", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "structured_question",
        question: "Freeform question here",
        itemId: "sq-2",
        turnId: "turn-1",
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.questions[0]!.options).toBeUndefined();
    expect(result[0]!.request.questions[0]!.allowsFreeform).toBe(true);
  });

  // ---- Clearing events: tool_result, command, file_change ---------------

  it("tool_result removes the matching pending input", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-1",
        kind: "command",
        description: "Run test",
        turnId: "turn-1",
        detail: { tool: "exec", command: "test" },
      }),
      envelope({
        type: "tool_result",
        tool: "exec",
        result: { stdout: "ok" },
        itemId: "item-1",
        turnId: "turn-1",
        status: "completed",
      }),
    ];
    expect(derivePendingInputRequests(events)).toEqual([]);
  });

  it("command removes the matching pending input", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "cmd-1",
        kind: "command",
        description: "Run npm build",
        turnId: "turn-1",
        detail: { tool: "exec_command" },
      }),
      envelope({
        type: "command",
        command: "npm build",
        cwd: "/project",
        output: "ok",
        itemId: "cmd-1",
        turnId: "turn-1",
        status: "completed",
        exitCode: 0,
      }),
    ];
    expect(derivePendingInputRequests(events)).toEqual([]);
  });

  it("file_change removes the matching pending input", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "fc-1",
        kind: "file_change",
        description: "Edit foo.ts",
        turnId: "turn-1",
        detail: { tool: "write_file" },
      }),
      envelope({
        type: "file_change",
        path: "foo.ts",
        diff: "+line",
        kind: "modify",
        itemId: "fc-1",
        turnId: "turn-1",
        status: "completed",
      }),
    ];
    expect(derivePendingInputRequests(events)).toEqual([]);
  });

  it("clearing event only removes matching itemId, not others", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "keep-me",
        kind: "command",
        description: "Run lint",
        turnId: "turn-1",
        detail: { tool: "exec" },
      }),
      envelope({
        type: "approval_request",
        itemId: "remove-me",
        kind: "command",
        description: "Run test",
        turnId: "turn-1",
        detail: { tool: "exec" },
      }),
      envelope({
        type: "tool_result",
        tool: "exec",
        result: {},
        itemId: "remove-me",
        turnId: "turn-1",
        status: "completed",
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.itemId).toBe("keep-me");
  });

  // ---- Mixed events ------------------------------------------------------

  it("handles multiple events with mixed types", () => {
    const events: AgentChatEventEnvelope[] = [
      // First: an approval that will be resolved
      envelope({
        type: "approval_request",
        itemId: "a1",
        kind: "command",
        description: "Run build",
        turnId: "turn-1",
        detail: { tool: "exec" },
      }),
      // A structured question that should persist
      envelope({
        type: "structured_question",
        question: "Pick a port",
        options: [{ label: "3000", value: "3000" }],
        itemId: "sq-1",
        turnId: "turn-1",
      }),
      // Resolve the approval
      envelope({
        type: "tool_result",
        tool: "exec",
        result: {},
        itemId: "a1",
        turnId: "turn-1",
        status: "completed",
      }),
      // A second approval that should persist
      envelope({
        type: "approval_request",
        itemId: "a2",
        kind: "file_change",
        description: "Write bar.ts",
        turnId: "turn-1",
        detail: { tool: "write_file" },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.itemId);
    expect(ids).toContain("sq-1");
    expect(ids).toContain("a2");
    expect(ids).not.toContain("a1");
  });

  it("done mid-stream clears earlier items but new items after done persist", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "before-done",
        kind: "command",
        description: "Run test",
        turnId: "turn-1",
        detail: { tool: "exec" },
      }),
      envelope({
        type: "done",
        turnId: "turn-1",
        status: "completed",
      }),
      envelope({
        type: "approval_request",
        itemId: "after-done",
        kind: "command",
        description: "Run lint",
        turnId: "turn-2",
        detail: { tool: "exec" },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.itemId).toBe("after-done");
  });

  // ---- Malformed / graceful handling ------------------------------------

  it("approval_request with null detail falls back to generic approval", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "null-detail",
        kind: "command",
        description: "Something",
        turnId: "turn-1",
        detail: null,
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.kind).toBe("approval");
    expect(result[0]!.request.description).toBe("Something");
  });

  it("approval_request with detail but empty request falls back to legacy", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "bad-req",
        kind: "command",
        description: "Fallback desc",
        turnId: "turn-1",
        detail: { request: { requestId: "", source: "", kind: "" } },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    // Empty required fields in request cause it to fall back to legacy
    expect(result[0]!.request.kind).toBe("approval");
    expect(result[0]!.request.description).toBe("Fallback desc");
  });

  it("approval_request with detail.request as non-object falls back to legacy", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "str-req",
        kind: "command",
        description: "Fallback",
        turnId: "turn-1",
        detail: { request: "not-an-object" },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.kind).toBe("approval");
  });

  it("AskUser with empty question falls back to generic approval", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "empty-q",
        kind: "tool_call",
        description: "AskUser with no question",
        turnId: "turn-1",
        detail: { tool: "AskUser", question: "" },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.kind).toBe("approval");
  });

  it("AskUser with whitespace-only question falls back to generic approval", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "ws-q",
        kind: "tool_call",
        description: "AskUser whitespace",
        turnId: "turn-1",
        detail: { tool: "AskUser", question: "   " },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.kind).toBe("approval");
  });

  // ---- Options parsing --------------------------------------------------

  it("filters out invalid options (missing label)", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "opt-bad",
        kind: "tool_call",
        description: "AskUser",
        turnId: "turn-1",
        detail: {
          tool: "AskUser",
          question: "Choose one",
          options: [
            { label: "Valid", value: "v1" },
            { value: "no-label" },
            { label: "", value: "empty-label" },
            null,
            42,
            { label: "Also valid", value: "v2" },
          ],
        },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.questions[0]!.options).toHaveLength(2);
    expect(result[0]!.request.questions[0]!.options![0]!.label).toBe("Valid");
    expect(result[0]!.request.questions[0]!.options![1]!.label).toBe("Also valid");
  });

  it("option value defaults to label when value is missing", () => {
    const structuredRequest = {
      requestId: "req-opt",
      source: "mission",
      kind: "structured_question",
      questions: [
        {
          id: "q1",
          question: "Pick",
          options: [{ label: "MyLabel" }],
        },
      ],
    };
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-opt-def",
        kind: "tool_call",
        description: "test",
        turnId: "turn-1",
        detail: { request: structuredRequest },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    const opt = result[0]!.request.questions[0]!.options![0]!;
    expect(opt.label).toBe("MyLabel");
    expect(opt.value).toBe("MyLabel");
  });

  it("option description is included only when non-empty string", () => {
    const structuredRequest = {
      requestId: "req-desc",
      source: "mission",
      kind: "structured_question",
      questions: [
        {
          id: "q1",
          question: "Pick",
          options: [
            { label: "A", value: "a", description: "Has desc" },
            { label: "B", value: "b", description: "" },
            { label: "C", value: "c", description: "   " },
            { label: "D", value: "d" },
          ],
        },
      ],
    };
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-desc",
        kind: "tool_call",
        description: "test",
        turnId: "turn-1",
        detail: { request: structuredRequest },
      }),
    ];
    const result = derivePendingInputRequests(events);
    const opts = result[0]!.request.questions[0]!.options!;
    expect(opts[0]!.description).toBe("Has desc");
    expect(opts[1]!.description).toBeUndefined();
    expect(opts[2]!.description).toBeUndefined();
    expect(opts[3]!.description).toBeUndefined();
  });

  it("option recommended is included only when true", () => {
    const structuredRequest = {
      requestId: "req-rec",
      source: "mission",
      kind: "structured_question",
      questions: [
        {
          id: "q1",
          question: "Pick",
          options: [
            { label: "A", value: "a", recommended: true },
            { label: "B", value: "b", recommended: false },
            { label: "C", value: "c" },
          ],
        },
      ],
    };
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-rec",
        kind: "tool_call",
        description: "test",
        turnId: "turn-1",
        detail: { request: structuredRequest },
      }),
    ];
    const result = derivePendingInputRequests(events);
    const opts = result[0]!.request.questions[0]!.options!;
    expect(opts[0]!.recommended).toBe(true);
    expect(opts[1]!.recommended).toBeUndefined();
    expect(opts[2]!.recommended).toBeUndefined();
  });

  // ---- Question parsing with optional fields ----------------------------

  it("parses question with all optional fields", () => {
    const structuredRequest = {
      requestId: "req-q",
      source: "mission",
      kind: "structured_question",
      questions: [
        {
          id: "q-full",
          question: "What next?",
          header: "Decision Point",
          allowsFreeform: true,
          isSecret: true,
          defaultAssumption: "Continue as planned",
          impact: "High impact choice",
          options: [{ label: "Go", value: "go" }],
        },
      ],
    };
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-q-full",
        kind: "tool_call",
        description: "test",
        turnId: "turn-1",
        detail: { request: structuredRequest },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    const q = result[0]!.request.questions[0]!;
    expect(q.id).toBe("q-full");
    expect(q.question).toBe("What next?");
    expect(q.header).toBe("Decision Point");
    expect(q.allowsFreeform).toBe(true);
    expect(q.isSecret).toBe(true);
    expect(q.defaultAssumption).toBe("Continue as planned");
    expect(q.impact).toBe("High impact choice");
    expect(q.options).toHaveLength(1);
  });

  it("omits optional question fields when not provided or empty", () => {
    const structuredRequest = {
      requestId: "req-q-min",
      source: "mission",
      kind: "structured_question",
      questions: [
        {
          id: "q-min",
          question: "Minimal",
          header: "",
          allowsFreeform: false,
          isSecret: false,
          defaultAssumption: "  ",
          impact: "",
        },
      ],
    };
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-q-min",
        kind: "tool_call",
        description: "test",
        turnId: "turn-1",
        detail: { request: structuredRequest },
      }),
    ];
    const result = derivePendingInputRequests(events);
    const q = result[0]!.request.questions[0]!;
    expect(q.header).toBeUndefined();
    expect(q.allowsFreeform).toBeUndefined();
    expect(q.isSecret).toBeUndefined();
    expect(q.defaultAssumption).toBeUndefined();
    expect(q.impact).toBeUndefined();
  });

  it("filters out questions with missing id or question text", () => {
    const structuredRequest = {
      requestId: "req-filter",
      source: "mission",
      kind: "structured_question",
      questions: [
        { id: "", question: "no id" },
        { id: "has-id", question: "" },
        { id: "valid", question: "Valid question" },
        null,
        "not-an-object",
      ],
    };
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-filter",
        kind: "tool_call",
        description: "test",
        turnId: "turn-1",
        detail: { request: structuredRequest },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.questions).toHaveLength(1);
    expect(result[0]!.request.questions[0]!.id).toBe("valid");
  });

  // ---- Structured request fields ----------------------------------------

  it("parses structured request with all optional fields", () => {
    const structuredRequest = {
      requestId: "req-full",
      itemId: "item-full",
      source: "unified",
      kind: "permissions",
      title: "Grant access",
      description: "Grant file system access",
      questions: [],
      allowsFreeform: true,
      blocking: false,
      canProceedWithoutAnswer: true,
      options: [{ label: "Allow", value: "allow" }],
      providerMetadata: { provider: "openai", custom: 42 },
      turnId: "t-1",
    };
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-full",
        kind: "tool_call",
        description: "test",
        turnId: "turn-1",
        detail: { request: structuredRequest },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    const req = result[0]!.request;
    expect(req.requestId).toBe("req-full");
    expect(req.itemId).toBe("item-full");
    expect(req.source).toBe("unified");
    expect(req.kind).toBe("permissions");
    expect(req.title).toBe("Grant access");
    expect(req.description).toBe("Grant file system access");
    expect(req.allowsFreeform).toBe(true);
    expect(req.blocking).toBe(false);
    expect(req.canProceedWithoutAnswer).toBe(true);
    expect(req.options).toHaveLength(1);
    expect(req.providerMetadata).toEqual({ provider: "openai", custom: 42 });
    expect(req.turnId).toBe("t-1");
  });

  it("blocking defaults to true when not explicitly false", () => {
    const structuredRequest = {
      requestId: "req-block",
      source: "mission",
      kind: "approval",
      questions: [],
    };
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-block",
        kind: "command",
        description: "test",
        turnId: "turn-1",
        detail: { request: structuredRequest },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result[0]!.request.blocking).toBe(true);
  });

  // ---- Duplicate itemId replaces earlier entry --------------------------

  it("later approval_request with same itemId replaces earlier one", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "dup-1",
        kind: "command",
        description: "First version",
        turnId: "turn-1",
        detail: { tool: "exec" },
      }),
      envelope({
        type: "approval_request",
        itemId: "dup-1",
        kind: "command",
        description: "Updated version",
        turnId: "turn-1",
        detail: { tool: "exec" },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.description).toBe("Updated version");
  });

  // ---- Session ID propagation -------------------------------------------

  it("propagates sessionId from envelope to derived pending input", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope(
        {
          type: "structured_question",
          question: "Which?",
          itemId: "sq-sess",
          turnId: "turn-1",
        },
        "my-session-42",
      ),
    ];
    const result = derivePendingInputRequests(events);
    expect(result[0]!.sessionId).toBe("my-session-42");
  });

  // ---- readRecord edge cases (via structured request path) ---------------

  it("array as detail is treated as non-record, falls back to legacy", () => {
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "arr-detail",
        kind: "command",
        description: "Array detail",
        turnId: "turn-1",
        detail: [1, 2, 3],
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.request.kind).toBe("approval");
  });

  it("providerMetadata is omitted when not a valid record", () => {
    const structuredRequest = {
      requestId: "req-pm",
      source: "mission",
      kind: "approval",
      questions: [],
      providerMetadata: "not-an-object",
    };
    const events: AgentChatEventEnvelope[] = [
      envelope({
        type: "approval_request",
        itemId: "item-pm",
        kind: "command",
        description: "test",
        turnId: "turn-1",
        detail: { request: structuredRequest },
      }),
    ];
    const result = derivePendingInputRequests(events);
    expect(result[0]!.request.providerMetadata).toBeUndefined();
  });
});
