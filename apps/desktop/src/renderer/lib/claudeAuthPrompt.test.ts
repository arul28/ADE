import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope, TerminalSessionSummary } from "../../shared/types";
import {
  latestChatSignInFailure,
  shouldShowClaudeCliLoginPrompt,
  textHasClaudeAuthError,
} from "./claudeAuthPrompt";

function envelope(event: AgentChatEventEnvelope["event"], sequence?: number): AgentChatEventEnvelope {
  return {
    sessionId: "chat-1",
    timestamp: "2026-06-22T12:00:00.000Z",
    ...(sequence !== undefined ? { sequence } : {}),
    event,
  };
}

const claudeLoginError = envelope({
  type: "error",
  message: "Please run /login",
  detail: "API Error: 401 Invalid authentication credentials",
}, 2);

function signedOutError(agent: string, sequence = 2): AgentChatEventEnvelope {
  return envelope({
    type: "error",
    message: "not logged in: run /login to add an API key",
    errorInfo: { agentCli: { agent, displayName: agent, category: "unauthenticated", authCommand: `${agent} login` } },
  } as AgentChatEventEnvelope["event"], sequence);
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
  it("detects the Claude Code invalid credentials output", () => {
    expect(textHasClaudeAuthError("Please run /login · API Error: 401 Invalid authentication credentials")).toBe(true);
  });

  it("detects ADE's own classified auth message despite reversed word order", () => {
    // "Authentication failed" precedes "Claude" here, so the claude-first
    // patterns miss it — the dedicated "failed for" pattern catches it.
    expect(textHasClaudeAuthError("Authentication failed for Claude Sonnet 5. Check your API key in Settings.")).toBe(true);
  });

  it("does not treat other service auth failures as Claude login failures", () => {
    expect(textHasClaudeAuthError("Authentication failed for GitHub. Check your token in Settings.")).toBe(false);
  });

  it.each<[string, string, AgentChatEventEnvelope[]]>([
    ["a Claude login error", "claude", [
      envelope({ type: "user_message", text: "hello" }, 1),
      claudeLoginError,
      envelope({ type: "done", turnId: "turn-1", status: "failed" }, 3),
    ]],
    ["a Claude auth failure sent as a system notice", "claude", [
      envelope({ type: "user_message", text: "hello" }, 1),
      envelope({
        type: "system_notice",
        noticeKind: "warning",
        severity: "info",
        status: "authentication_failed",
        message: "Claude API retry 2/10: authentication failed",
        detail: "HTTP 401",
      }, 2),
      envelope({ type: "done", turnId: "turn-1", status: "failed" }, 3),
    ]],
    ["the final plaintext Claude invalid-credentials failure", "claude", [
      envelope({ type: "user_message", text: "hello" }, 1),
      envelope({ type: "text", text: "Failed to authenticate. API Error: 401 Invalid authentication credentials" }, 2),
      envelope({ type: "done", turnId: "turn-1", status: "failed" }, 3),
    ]],
    ["the host's signed-out classification for the chat's own agent", "muse", [
      envelope({ type: "user_message", text: "hello" }, 1),
      signedOutError("muse"),
      envelope({ type: "done", turnId: "turn-1", status: "failed" }, 3),
    ]],
  ])("finds the sign-in failure in %s", (_label, provider, events) => {
    const failure = latestChatSignInFailure({ provider, events });
    expect(failure).not.toBeNull();
    expect(failure?.provider).toBe(provider);
    // Keyed by the event that said so, so a dismissed card returns for the next one.
    expect(failure?.eventKey).toMatch(/^2:/);
  });

  it("keys a later failure apart from an earlier one", () => {
    const first = latestChatSignInFailure({ provider: "muse", events: [signedOutError("muse", 2)] });
    const second = latestChatSignInFailure({
      provider: "muse",
      events: [signedOutError("muse", 2), envelope({ type: "user_message", text: "again" }, 3), signedOutError("muse", 4)],
    });
    expect(first?.eventKey).toBeTruthy();
    expect(second?.eventKey).toBeTruthy();
    expect(second?.eventKey).not.toBe(first?.eventKey);
  });

  it.each<[string, string, AgentChatEventEnvelope[], boolean?]>([
    ["a Claude auth progress notice", "claude", [
      envelope({ type: "system_notice", noticeKind: "auth", message: "Authenticating..." }),
    ]],
    ["a non-Claude auth notice in a Claude chat", "claude", [
      envelope({
        type: "system_notice",
        noticeKind: "warning",
        status: "authentication_failed",
        message: "MCP tool failed to authenticate to GitHub",
        detail: "HTTP 401",
      }),
    ]],
    ["generic invalid-credentials notice detail", "claude", [
      envelope({
        type: "system_notice",
        noticeKind: "hook",
        message: "Hook response",
        detail: "GitHub request failed: Invalid authentication credentials",
      }),
    ]],
    ["generic Claude text about auth failures", "claude", [
      envelope({ type: "text", text: "A GitHub request failed to authenticate because the remote server rejected it." }),
    ]],
    ["third-party invalid-credentials text", "claude", [
      envelope({ type: "text", text: "GitHub request failed: Invalid authentication credentials" }),
    ]],
    ["a successful reply that quotes an API auth error", "claude", [
      envelope({
        type: "text",
        text: "The GitHub API Error: 401 Invalid authentication credentials means the repo token is stale.",
      }),
      envelope({ type: "done", turnId: "turn-1", status: "completed" }),
    ]],
    ["a later successful reply", "claude", [
      claudeLoginError,
      envelope({ type: "text", text: "I am back online." }),
    ]],
    ["a tool's own CLI signed out inside the chat", "claude", [
      signedOutError("grok"),
      envelope({ type: "done", turnId: "turn-1", status: "failed" }),
    ]],
    ["a turn that is running again", "muse", [signedOutError("muse")], true],
  ])("finds no sign-in failure for %s", (_label, provider, events, turnActive = false) => {
    expect(latestChatSignInFailure({ provider, events, turnActive })).toBeNull();
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
