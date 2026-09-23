import { describe, expect, it } from "vitest";
import {
  CURSOR_PRECOMPACT_HOOK_FIELDS,
  createCursorSdkRunTelemetry,
  cursorPreCompactHookEnabled,
  isCursorPreCompactHookPayload,
  parseCursorPreCompactHookPayload,
} from "./cursorSdkTelemetry";

/**
 * The stdin JSON `@cursor/sdk` 1.0.31 hands a `preCompact` hook: the
 * PreCompactRequestQuery fields plus the executor's common envelope.
 */
const PRECOMPACT_HOOK_STDIN = {
  conversation_id: "conv-1",
  generation_id: "gen-9",
  model: "claude-4.6-sonnet",
  model_id: "claude-4.6-sonnet",
  trigger: "auto",
  context_usage_percent: 91.5,
  context_tokens: 183_000,
  context_window_size: 200_000,
  message_count: 64,
  messages_to_compact: 58,
  is_first_compaction: true,
  session_id: "conv-1",
  hook_event_name: "preCompact",
  cursor_version: "1.0.31",
  workspace_roots: ["/repo"],
  user_email: "dev@example.com",
  transcript_path: null,
};

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Cursor preCompact hook payload", () => {
  it("parses every field ADE reads from the SDK's hook stdin", () => {
    expect(isCursorPreCompactHookPayload(PRECOMPACT_HOOK_STDIN)).toBe(true);
    expect(parseCursorPreCompactHookPayload(PRECOMPACT_HOOK_STDIN)).toEqual({
      trigger: "auto",
      contextTokens: 183_000,
      contextWindowSize: 200_000,
      contextUsagePercent: 91.5,
      messageCount: 64,
      messagesToCompact: 58,
      isFirstCompaction: true,
      model: "claude-4.6-sonnet",
    });
    // The fixture exercises exactly the field list the contract test guards.
    for (const field of CURSOR_PRECOMPACT_HOOK_FIELDS) {
      expect(PRECOMPACT_HOOK_STDIN).toHaveProperty(field);
    }
  });

  it("reads a manual trigger and nulls fields the SDK sent as NaN (JSON null)", () => {
    expect(parseCursorPreCompactHookPayload({
      hook_event_name: "preCompact",
      trigger: "manual",
      context_tokens: null,
      context_window_size: null,
      model: "",
    })).toMatchObject({
      trigger: "manual",
      contextTokens: null,
      contextWindowSize: null,
      model: null,
    });
  });

  it("ignores other hook events", () => {
    expect(isCursorPreCompactHookPayload({ hook_event_name: "preToolUse" })).toBe(false);
    expect(parseCursorPreCompactHookPayload({ hook_event_name: "preToolUse", context_tokens: 5 })).toBeNull();
    expect(parseCursorPreCompactHookPayload("not json")).toBeNull();
  });

  it("is on by default and off with ADE_CURSOR_PRECOMPACT_HOOK=0 or an explicit init flag", () => {
    expect(cursorPreCompactHookEnabled({}, {})).toBe(true);
    expect(cursorPreCompactHookEnabled({}, { ADE_CURSOR_PRECOMPACT_HOOK: "1" })).toBe(true);
    expect(cursorPreCompactHookEnabled({}, { ADE_CURSOR_PRECOMPACT_HOOK: "0" })).toBe(false);
    expect(cursorPreCompactHookEnabled({}, { ADE_CURSOR_PRECOMPACT_HOOK: "false" })).toBe(false);
    expect(cursorPreCompactHookEnabled({ preCompactHook: false }, {})).toBe(false);
  });
});

describe("Cursor SDK run telemetry", () => {
  const payload = parseCursorPreCompactHookPayload(PRECOMPACT_HOOK_STDIN)!;

  it("opens a compaction from the hook and closes it on Cursor's summary message", () => {
    const time = clock();
    const telemetry = createCursorSdkRunTelemetry(time.now);
    telemetry.beginRun("composer-2");
    expect(telemetry.preCompactStarted(payload)).toEqual({
      type: "ade_cursor_compaction",
      phase: "started",
      seq: 1,
      trigger: "auto",
      contextTokens: 183_000,
      contextWindowSize: 200_000,
      contextUsagePercent: 91.5,
      model: "claude-4.6-sonnet",
    });
    // A status frame is not proof generation resumed.
    expect(telemetry.beforeStreamEvent({ type: "status", status: "RUNNING" }).completion).toBeNull();
    time.advance(4_200);
    const summary = telemetry.beforeStreamEvent({ type: "task", text: "Summary of the conversation so far" });
    expect(summary.completion).toEqual({
      type: "ade_cursor_compaction",
      phase: "completed",
      seq: 1,
      trigger: "auto",
      contextTokens: 183_000,
      durationMs: 4_200,
      closedBy: "summary",
    });
    expect(telemetry.beforeStreamEvent({ type: "assistant" }).completion).toBeNull();
    expect(telemetry.endRun("finished")).toBeNull();
  });

  it("falls back to the next generation event, then to the run end", () => {
    const telemetry = createCursorSdkRunTelemetry(clock().now);
    telemetry.beginRun("composer-2");
    telemetry.preCompactStarted(payload);
    expect(telemetry.beforeStreamEvent({ type: "thinking", text: "..." }).completion)
      .toMatchObject({ phase: "completed", closedBy: "next_event", seq: 1 });

    telemetry.preCompactStarted(payload);
    expect(telemetry.endRun("cancelled")).toMatchObject({
      phase: "failed",
      failReason: "interrupted",
      closedBy: "run_end",
      seq: 2,
    });
  });

  it("marks status events once the hook fired so the text fallback stays quiet", () => {
    const telemetry = createCursorSdkRunTelemetry(clock().now);
    telemetry.beginRun("composer-2");
    const status = { type: "status", status: "RUNNING", message: "Summarizing chat context" };
    expect(telemetry.beforeStreamEvent(status).event).toBe(status);
    telemetry.preCompactStarted(payload);
    expect(telemetry.beforeStreamEvent(status).event).toEqual({ ...status, adePreCompactHook: true });
    telemetry.beginRun("composer-2");
    expect(telemetry.beforeStreamEvent(status).event).toBe(status);
  });

  it("names the served model only for an auto selection, and keeps the login email", () => {
    const telemetry = createCursorSdkRunTelemetry(clock().now);
    telemetry.beginRun("auto");
    telemetry.noteHookPayload({ hook_event_name: "preToolUse", model: "gpt-5.5", user_email: "dev@example.com" });
    expect(telemetry.turnTelemetry(null)).toEqual({ accountEmail: "dev@example.com", servedModel: "gpt-5.5" });

    telemetry.beginRun("composer-2");
    telemetry.noteHookPayload({ hook_event_name: "preToolUse", model: "Composer 2" });
    expect(telemetry.turnTelemetry(null)).toEqual({ accountEmail: "dev@example.com" });

    const fresh = createCursorSdkRunTelemetry(clock().now);
    fresh.beginRun("auto");
    fresh.noteHookPayload({ hook_event_name: "preToolUse", model: "auto" });
    expect(fresh.turnTelemetry("me@example.com")).toEqual({ accountEmail: "me@example.com" });
  });
});
