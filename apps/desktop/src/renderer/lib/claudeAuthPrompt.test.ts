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

  it("detects Claude auth failures emitted as system notices", () => {
    expect(shouldShowClaudeChatLoginPrompt({
      provider: "claude",
      events: [
        envelope({ type: "user_message", text: "hello" }),
        envelope({
          type: "system_notice",
          noticeKind: "warning",
          severity: "info",
          status: "authentication_failed",
          message: "Claude API retry 2/10: authentication failed",
          detail: "HTTP 401",
        }),
        envelope({ type: "done", turnId: "turn-1", status: "failed" }),
      ],
    })).toBe(true);
  });

  it("does not treat Claude auth progress notices as failures", () => {
    expect(shouldShowClaudeChatLoginPrompt({
      provider: "claude",
      events: [
        envelope({
          type: "system_notice",
          noticeKind: "auth",
          message: "Authenticating...",
        }),
      ],
    })).toBe(false);
  });

  it("does not treat non-Claude auth system notices as Claude login failures", () => {
    expect(shouldShowClaudeChatLoginPrompt({
      provider: "claude",
      events: [
        envelope({
          type: "system_notice",
          noticeKind: "warning",
          status: "authentication_failed",
          message: "MCP tool failed to authenticate to GitHub",
          detail: "HTTP 401",
        }),
      ],
    })).toBe(false);
  });

  it("detects the final plaintext Claude invalid-credentials failure", () => {
    expect(shouldShowClaudeChatLoginPrompt({
      provider: "claude",
      events: [
        envelope({ type: "user_message", text: "hello" }),
        envelope({
          type: "text",
          text: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        }),
        envelope({ type: "done", turnId: "turn-1", status: "failed" }),
      ],
    })).toBe(true);
  });

  it("does not treat generic Claude text about auth failures as a login failure", () => {
    expect(shouldShowClaudeChatLoginPrompt({
      provider: "claude",
      events: [
        envelope({
          type: "text",
          text: "A GitHub request failed to authenticate because the remote server rejected it.",
        }),
      ],
    })).toBe(false);
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

  it("ignores a stale auth summary when a live Claude CLI session has healthy output", () => {
    expect(shouldShowClaudeCliLoginPrompt(cliSession({
      status: "running",
      runtimeState: "idle",
      ptyId: "pty-1",
      lastOutputPreview: "Claude Code ready",
      summary: "Previous run failed: Please run /login · API Error: 401 Invalid authentication credentials",
      exitCode: null,
      endedAt: null,
    }))).toBe(false);
  });
});
