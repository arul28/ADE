import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope, TerminalSessionSummary } from "../../shared/types";
import {
  CLAUDE_AUTH_LOGIN_COMMAND,
  shouldShowClaudeChatLoginPrompt,
  shouldShowClaudeCliLoginPrompt,
  textHasClaudeAuthError,
} from "./claudeAuthPrompt";

function envelope(event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope {
  return {
    sessionId: "chat-1",
    timestamp: "2026-06-22T12:00:00.000Z",
    event,
  };
}

function cliSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "term-1",
    laneId: "lane-1",
    laneName: "Primary",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "claude",
    title: "Claude Code",
    status: "failed",
    startedAt: "2026-06-22T12:00:00.000Z",
    endedAt: "2026-06-22T12:01:00.000Z",
    exitCode: 1,
    transcriptPath: "/tmp/transcript.log",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: "Please run /login · API Error: 401 Invalid authentication credentials",
    summary: null,
    runtimeState: "exited",
    resumeCommand: null,
    ...overrides,
  };
}

describe("claude auth prompt helpers", () => {
  it("uses the requested Claude login command", () => {
    expect(CLAUDE_AUTH_LOGIN_COMMAND).toBe("claude auth login");
  });

  it("detects the Claude Code invalid credentials output", () => {
    expect(textHasClaudeAuthError("Please run /login · API Error: 401 Invalid authentication credentials")).toBe(true);
  });

  it("shows for the latest Claude chat auth error", () => {
    expect(shouldShowClaudeChatLoginPrompt({
      provider: "claude",
      events: [
        envelope({ type: "user_message", text: "hello" }),
        envelope({
          type: "error",
          message: "Please run /login",
          detail: "API Error: 401 Invalid authentication credentials",
        }),
        envelope({ type: "done", turnId: "turn-1", status: "failed" }),
      ],
    })).toBe(true);
  });

  it("lets an explicit latest auth error beat stale positive auth status", () => {
    expect(shouldShowClaudeChatLoginPrompt({
      provider: "claude",
      authAvailable: true,
      events: [
        envelope({
          type: "error",
          message: "Please run /login",
          detail: "API Error: 401 Invalid authentication credentials",
        }),
      ],
    })).toBe(true);
  });

  it("suppresses the chat prompt once Claude has produced a later successful reply", () => {
    expect(shouldShowClaudeChatLoginPrompt({
      provider: "claude",
      events: [
        envelope({
          type: "error",
          message: "Please run /login",
          detail: "API Error: 401 Invalid authentication credentials",
        }),
        envelope({ type: "text", text: "I am back online." }),
      ],
    })).toBe(false);
  });

  it("detects auth errors from Claude CLI session previews", () => {
    expect(shouldShowClaudeCliLoginPrompt(cliSession())).toBe(true);
  });

  it("does not show on a healthy running Claude CLI session", () => {
    expect(shouldShowClaudeCliLoginPrompt(cliSession({
      status: "running",
      runtimeState: "running",
      ptyId: "pty-1",
      lastOutputPreview: "Claude Code ready",
      exitCode: null,
      endedAt: null,
    }))).toBe(false);
  });
});
