/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";
import { AgentChatMessageList } from "./AgentChatMessageList";

function envelope(event: AgentChatEvent, index = 0): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
    event
  };
}

describe("AgentChatMessageList", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders user message as right-aligned bubble", () => {
    const { container } = render(
      <AgentChatMessageList
        events={[
          envelope({ type: "user_message", text: "hello user" })
        ]}
      />
    );

    expect(screen.getByText("hello user")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(container.querySelector(".justify-end")).toBeTruthy();
  });

  it("renders agent text markdown formatting", () => {
    const { container } = render(
      <AgentChatMessageList
        events={[
          envelope({ type: "text", text: "**bold** and `inline`" })
        ]}
      />
    );

    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("bold");
    expect(screen.getByText("inline")).toBeTruthy();
  });

  it("renders command execution with exit code and output", () => {
    render(
      <AgentChatMessageList
        events={[
          envelope({
            type: "command",
            itemId: "cmd-1",
            command: "npm test",
            cwd: "/tmp",
            output: "all good",
            status: "completed",
            exitCode: 0,
            durationMs: 120
          })
        ]}
      />
    );

    expect(screen.getByText("BASH")).toBeTruthy();
    expect(screen.getByText(/PASS/)).toBeTruthy();
    expect(screen.getByText("all good")).toBeTruthy();
  });

  it("renders file change with diff and kind", () => {
    const { container } = render(
      <AgentChatMessageList
        events={[
          envelope({
            type: "file_change",
            itemId: "file-1",
            path: "src/index.ts",
            kind: "modify",
            diff: "@@ -1 +1 @@\n-old\n+new",
            status: "completed"
          })
        ]}
      />
    );

    expect(screen.getByText("EDIT")).toBeTruthy();
    expect(screen.getByText("modify")).toBeTruthy();
    expect(screen.getByText("src/index.ts")).toBeTruthy();
    const diff = container.querySelector("pre");
    expect(diff?.textContent).toContain("@@ -1 +1 @@");
    expect(diff?.textContent).toContain("-old");
    expect(diff?.textContent).toContain("+new");
  });

  it("renders plan step status indicators", () => {
    render(
      <AgentChatMessageList
        events={[
          envelope({
            type: "plan",
            steps: [
              { text: "Collect context", status: "pending" },
              { text: "Run checks", status: "in_progress" },
              { text: "Apply fix", status: "completed" },
              { text: "Publish", status: "failed" }
            ],
            explanation: "Working through plan"
          })
        ]}
      />
    );

    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("Collect context")).toBeTruthy();
    expect(screen.getByText("Run checks")).toBeTruthy();
    expect(screen.getByText("Apply fix")).toBeTruthy();
    expect(screen.getByText("Publish")).toBeTruthy();
    expect(screen.getByText("Working through plan")).toBeTruthy();
  });

  it("renders approval request with action buttons", () => {
    const onApproval = vi.fn();
    render(
      <AgentChatMessageList
        events={[
          envelope({
            type: "approval_request",
            itemId: "approval-1",
            kind: "command",
            description: "Run destructive command",
            detail: { command: "rm -rf .cache" }
          })
        ]}
        onApproval={onApproval}
      />
    );

    expect(screen.getByText("Approval Required")).toBeTruthy();
    expect(screen.getByText("Run destructive command")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept All" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
  });

  it("renders askUser requests as input-needed cards instead of approval buttons", () => {
    render(
      <AgentChatMessageList
        events={[
          envelope({
            type: "approval_request",
            itemId: "approval-ask-user",
            kind: "tool_call",
            description: "What branch should I target?",
            detail: {
              tool: "askUser",
              question: "What branch should I target?",
              inputType: "text",
            },
          })
        ]}
        onApproval={vi.fn()}
      />
    );

    expect(screen.getByText("Needs Input")).toBeTruthy();
    expect(screen.getByText("What branch should I target?")).toBeTruthy();
    expect(screen.getByText(/question modal/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("renders done events with model and usage metadata", () => {
    render(
      <AgentChatMessageList
        events={[
          envelope({
            type: "done",
            turnId: "turn-1",
            status: "completed",
            modelId: "anthropic/claude-sonnet-4-6",
            usage: { inputTokens: 42, outputTokens: 13 },
          })
        ]}
      />
    );

    expect(screen.getByText("Usage")).toBeTruthy();
    expect(screen.getByText(/Claude Sonnet 4\.6/i)).toBeTruthy();
    expect(screen.getByText("In 42")).toBeTruthy();
    expect(screen.getByText("Out 13")).toBeTruthy();
  });

  it("renders error with red styling", () => {
    const { container } = render(
      <AgentChatMessageList
        events={[
          envelope({
            type: "error",
            message: "Something failed",
            errorInfo: "UsageLimitExceeded"
          })
        ]}
      />
    );

    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("Something failed")).toBeTruthy();
    expect(screen.getByText("UsageLimitExceeded")).toBeTruthy();

    const errorBlock = container.querySelector(".border-red-500\\/12");
    expect(errorBlock).toBeTruthy();
  });

  it("auto-scrolls to bottom on new events unless user scrolled up", async () => {
    const initialEvents = [envelope({ type: "text", text: "first" })];
    const { container, rerender } = render(<AgentChatMessageList events={initialEvents} />);
    const scroller = container.firstElementChild as HTMLDivElement;

    let scrollTopValue = 0;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      }
    });

    rerender(
      <AgentChatMessageList
        events={[...initialEvents, envelope({ type: "text", text: "second" }, 1)]}
      />
    );

    await waitFor(() => {
      expect(scrollTopValue).toBe(900);
    });

    scrollTopValue = 100;
    fireEvent.scroll(scroller);

    rerender(
      <AgentChatMessageList
        events={[...initialEvents, envelope({ type: "text", text: "second" }, 1), envelope({ type: "text", text: "third" }, 2)]}
      />
    );

    await waitFor(() => {
      expect(scrollTopValue).toBe(100);
    });
  });

  it("collapses consecutive text deltas into a single rendered message", () => {
    render(
      <AgentChatMessageList
        events={[
          envelope({ type: "text", text: "Hello ", turnId: "turn-1", itemId: "msg-1" }),
          envelope({ type: "text", text: "world", turnId: "turn-1", itemId: "msg-1" }, 1)
        ]}
      />
    );

    expect(screen.getByText("Hello world")).toBeTruthy();
    expect(screen.getAllByText("Agent")).toHaveLength(1);
  });

  it("keeps activity in the streaming indicator while collapsing reasoning deltas", () => {
    render(
      <AgentChatMessageList
        showStreamingIndicator
        events={[
          envelope({ type: "activity", activity: "thinking", detail: "Analyzing" }),
          envelope({ type: "reasoning", text: "Plan ", turnId: "turn-1", itemId: "reason-1" }, 1),
          envelope({ type: "activity", activity: "thinking", detail: "Analyzing" }, 2),
          envelope({ type: "reasoning", text: "the fix", turnId: "turn-1", itemId: "reason-1" }, 3),
        ]}
      />
    );

    // Reasoning is collapsed by default — verify the label renders and activity indicator is visible
    expect(screen.getByText("Reasoning")).toBeTruthy();
    expect(screen.getAllByText("Thinking: Analyzing")).toHaveLength(1);
  });

  it("merges reasoning deltas across interleaved tool chatter in the same turn", () => {
    render(
      <AgentChatMessageList
        events={[
          envelope({ type: "reasoning", text: "Let ", turnId: "turn-1", itemId: "reason-1" }),
          envelope({ type: "tool_call", tool: "get_project_context", args: {}, itemId: "tool-1", turnId: "turn-1" }, 1),
          envelope({ type: "tool_result", tool: "get_project_context", result: { ok: true }, itemId: "tool-1", turnId: "turn-1", status: "completed" }, 2),
          envelope({ type: "reasoning", text: "me think this through", turnId: "turn-1", itemId: "reason-2" }, 3),
        ]}
      />
    );

    expect(screen.getByText("Let me think this through")).toBeTruthy();
    expect(screen.getAllByText("Reasoning")).toHaveLength(1);
  });

  it("renders a stable placeholder for tiny reasoning fragments", () => {
    render(
      <AgentChatMessageList
        events={[
          envelope({ type: "reasoning", text: "Let", turnId: "turn-1", itemId: "reason-1" }),
        ]}
      />
    );

    expect(screen.getByText("Thinking...")).toBeTruthy();
  });

  it("merges tool calls and tool results into a single invocation card", () => {
    render(
      <AgentChatMessageList
        events={[
          envelope({ type: "tool_call", tool: "Read", args: { path: "src/index.ts" }, itemId: "tool-1", turnId: "turn-1" }),
          envelope({ type: "tool_result", tool: "Read", result: { ok: true }, itemId: "tool-1", turnId: "turn-1", status: "completed" }, 1),
        ]}
      />
    );

    expect(screen.getAllByText("Read")).toHaveLength(1);
    expect(screen.getByText(/completed/i)).toBeTruthy();
  });
});
