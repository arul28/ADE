/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { AgentChatMessageList } from "./AgentChatMessageList";

function findButtonByTextContent(matcher: RegExp): HTMLButtonElement {
  const match = screen.getAllByRole("button").find((button) => matcher.test(button.textContent ?? ""));
  if (!match) {
    throw new Error(`Unable to find button matching ${String(matcher)}`);
  }
  return match as HTMLButtonElement;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}{location.search}
      {"::"}
      {JSON.stringify(location.state ?? null)}
    </div>
  );
}

function renderMessageList(
  events: AgentChatEventEnvelope[],
  options?: {
    assistantLabel?: string;
    initialState?: Record<string, unknown>;
    showStreamingIndicator?: boolean;
  },
) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/", state: options?.initialState }]}>
      <AgentChatMessageList
        events={events}
        assistantLabel={options?.assistantLabel}
        showStreamingIndicator={options?.showStreamingIndicator}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const originalAde = globalThis.window.ade;

beforeEach(() => {
  globalThis.window.ade = {
    ...(originalAde ?? {}),
    files: {
      ...(originalAde?.files ?? {}),
      listWorkspaces: vi.fn().mockResolvedValue([
        {
          id: "workspace-lane-123",
          kind: "worktree",
          laneId: "lane-123",
          name: "Lane 123",
          rootPath: "/Users/admin/Projects/ADE/.ade/worktrees/fix-codex-chat-67bc1826",
          isReadOnlyByDefault: false,
        },
      ]),
    },
  } as any;
});

afterEach(() => {
  cleanup();
  if (originalAde === undefined) {
    delete (globalThis.window as any).ade;
  } else {
    globalThis.window.ade = originalAde;
  }
});

describe("AgentChatMessageList operator navigation suggestions", () => {
  it("renders Work suggestions from tool results and navigates by deeplink", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_result",
          tool: "spawnChat",
          itemId: "tool-1",
          status: "completed",
          result: {
            success: true,
            navigationSuggestions: [
              {
                surface: "work",
                label: "Open in Work",
                href: "/work?sessionId=chat-1",
                sessionId: "chat-1",
              },
            ],
          },
        },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Open in Work" }));

    expect(screen.getByTestId("location").textContent).toBe("/work?sessionId=chat-1::null");
  });

  it("renders mission suggestions from tool results and navigates by deeplink", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_result",
          tool: "startMission",
          itemId: "tool-2",
          status: "completed",
          result: {
            success: true,
            navigationSuggestions: [
              {
                surface: "missions",
                label: "Open mission",
                href: "/missions?missionId=mission-1",
                missionId: "mission-1",
              },
            ],
          },
        },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Open mission" }));

    expect(screen.getByTestId("location").textContent).toBe("/missions?missionId=mission-1::null");
  });
});

describe("AgentChatMessageList transcript rendering", () => {
  it("renders queued follow-ups as pending next-turn notices", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "what are you doing?",
          deliveryState: "queued",
        },
      },
    ]);

    expect(screen.getByText(/Queued.*will be delivered/)).toBeTruthy();
    expect(screen.getByText("what are you doing?")).toBeTruthy();
  });

  it("renders memory system notices as compact pills in the transcript", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "memory",
          message: "Memory: 3 relevant entries injected",
          detail: {
            summary: "Memory: 3 relevant entries injected",
          },
        },
      },
    ]);

    // Memory notices now render as a compact pill, not a collapsible card
    expect(screen.getByText("Memory: 3 relevant entries injected")).toBeTruthy();
    // No collapsible detail sections
    expect(screen.queryByText("Memory lookup")).toBeNull();
    expect(screen.queryByText("Policy")).toBeNull();
  });

  it("renders provider health and thread error notices distinctly", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "provider_health",
          message: "Claude is taking longer than usual",
          detail: "Streaming is still connected, but the provider is slow to respond.",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "system_notice",
          noticeKind: "thread_error",
          message: "Codex session is missing thread id",
          detail: "The session returned a turn result without a thread identifier.",
        },
      },
    ]);

    expect(screen.getByText("provider health")).toBeTruthy();
    expect(screen.getByText("thread error")).toBeTruthy();
    expect(screen.getByText("Claude is taking longer than usual")).toBeTruthy();
    expect(screen.getByText("Codex session is missing thread id")).toBeTruthy();
  });

  it("groups consecutive commands into one compact work log block", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "command",
          command: "npm test",
          cwd: "/Users/admin/project",
          output: "ok",
          itemId: "command-1",
          turnId: "turn-1",
          status: "completed",
          exitCode: 0,
          durationMs: 120,
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "command",
          command: "npm run lint",
          cwd: "/Users/admin/project",
          output: "lint ok",
          itemId: "command-2",
          turnId: "turn-1",
          status: "completed",
          exitCode: 0,
          durationMs: 140,
        },
      },
    ]);

    expect(screen.getByText("Work log (2)")).toBeTruthy();

    fireEvent.click(findButtonByTextContent(/npm test/i));
    fireEvent.click(findButtonByTextContent(/npm run lint/i));

    expect(screen.getAllByText("npm test").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("npm run lint").length).toBeGreaterThanOrEqual(1);
  });

  it("groups consecutive file changes into one compact work log block", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "file_change",
          path: "apps/desktop/src/foo.ts",
          diff: "+ const a = 1;\n",
          kind: "modify",
          itemId: "file-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "file_change",
          path: "apps/desktop/src/bar.ts",
          diff: "+ const b = 2;\n",
          kind: "modify",
          itemId: "file-2",
          turnId: "turn-1",
          status: "completed",
        },
      },
    ]);

    expect(screen.getByText("Work log (2)")).toBeTruthy();

    fireEvent.click(findButtonByTextContent(/foo\.ts/i));
    fireEvent.click(findButtonByTextContent(/bar\.ts/i));

    const body = document.body.textContent ?? "";
    expect(body).toContain("foo.ts");
    expect(body).toContain("bar.ts");
  });

  it("shows the newest six work-log entries by default and expands overflow on demand", () => {
    renderMessageList(
      Array.from({ length: 7 }, (_, index) => ({
        sessionId: "session-1",
        timestamp: `2026-03-17T10:00:0${index}.000Z`,
        event: {
          type: "command" as const,
          command: `echo ${index + 1}`,
          cwd: "/Users/admin/project",
          output: String(index + 1),
          itemId: `command-${index + 1}`,
          turnId: "turn-1",
          status: "completed" as const,
          exitCode: 0,
        },
      })),
    );

    expect(screen.getByText("Work log (7)")).toBeTruthy();
    expect(screen.getByText("Show 1 more")).toBeTruthy();
    expect(screen.queryByText(/Shell - echo 1/i)).toBeNull();
    expect(findButtonByTextContent(/echo 7/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show 1 more" }));

    expect(findButtonByTextContent(/echo 1/i)).toBeTruthy();
  });

  it("makes workspace markdown links open the Files tab", () => {
    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Open [AgentChatMessageList.tsx](apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx) for the renderer.",
            itemId: "text-1",
            turnId: "turn-1",
          },
        },
      ],
      {
        initialState: { laneId: "lane-123" },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "AgentChatMessageList.tsx" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"openFilePath\":\"apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx\",\"laneId\":\"lane-123\"}",
    );
  });

  it("maps absolute workspace file references into Files navigation targets", async () => {
    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Inspect `/Users/admin/Projects/ADE/.ade/worktrees/fix-codex-chat-67bc1826/apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx`.",
            itemId: "text-absolute",
            turnId: "turn-1",
          },
        },
      ],
      {
        initialState: { laneId: "lane-123" },
      },
    );

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "/Users/admin/Projects/ADE/.ade/worktrees/fix-codex-chat-67bc1826/apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx",
      }),
    );

    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"openFilePath\":\"apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx\",\"laneId\":\"lane-123\"}",
    );
  });

  it("does not coalesce text fragments across command boundaries", () => {
    const view = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: "Grouped",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "command",
          command: "echo ok",
          cwd: "/Users/admin/project",
          output: "ok",
          itemId: "command-1",
          turnId: "turn-1",
          status: "completed",
          exitCode: 0,
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "text",
          text: " output",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
    ]);

    // Text should NOT merge across the command boundary
    expect(view.container.textContent).not.toContain("Grouped output");
    expect(view.container.textContent).toContain("Grouped");
    expect(view.container.textContent).toContain("output");
    expect(findButtonByTextContent(/echo ok/i)).toBeTruthy();
  });

  it("keeps activity rows in the streaming indicator instead of the transcript", () => {
    const sharedEvents: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: "Let me check that.",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "activity",
          activity: "running_command",
          detail: "npm test",
          turnId: "turn-1",
        },
      },
    ];

    const streaming = renderMessageList(sharedEvents, { showStreamingIndicator: true });

    expect(streaming.container.textContent).toContain("Running command: npm test");

    cleanup();

    const transcriptOnly = renderMessageList(sharedEvents, { showStreamingIndicator: false });

    expect(transcriptOnly.container.textContent).not.toContain("Running command: npm test");
  });

  it("keeps the live assistant bubble stable until the turn finishes", () => {
    const live = renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Streaming response",
            itemId: "text-live",
            turnId: "turn-live",
          },
        },
      ],
      { showStreamingIndicator: true },
    );

    expect(live.container.innerHTML).toContain("min-h-[5.5rem]");

    cleanup();

    const settled = renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Streaming response",
            itemId: "text-live",
            turnId: "turn-live",
          },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:01.000Z",
          event: {
            type: "done",
            turnId: "turn-live",
            status: "completed",
            modelId: "gpt-5.4-codex",
          },
        },
      ],
      { showStreamingIndicator: false },
    );

    expect(settled.container.innerHTML).not.toContain("min-h-[5.5rem]");
  });

  it("renders a bottom turn summary card with task, file, and background-agent totals", () => {
    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "todo_update",
            turnId: "turn-1",
            items: [
              { id: "task-1", description: "Inspect chat renderer", status: "completed" },
              { id: "task-2", description: "Refine summary card", status: "in_progress" },
            ],
          },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:01.000Z",
          event: {
            type: "file_change",
            path: "apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx",
            diff: "+ const added = true;\n- const removed = false;\n",
            kind: "modify",
            itemId: "file-1",
            turnId: "turn-1",
            status: "completed",
          },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:02.000Z",
          event: {
            type: "subagent_started",
            taskId: "agent-1",
            description: "Check Claude task list support",
            background: true,
            turnId: "turn-1",
          },
        },
      ],
      {
        initialState: { laneId: "lane-123" },
      },
    );

    expect(screen.getAllByText("1 of 2 tasks completed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/1 file changed/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/1 background agent/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("1 active").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("+1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("-1").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));

    expect(screen.getByTestId("location").textContent).toBe("/files::{\"laneId\":\"lane-123\"}");
  });

  it("renders ask-user requests with a static amber dot instead of a spinner", () => {
    const view = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "approval_request",
          itemId: "approval-1",
          kind: "tool_call",
          description: "Which branch should I use?",
          turnId: "turn-1",
          detail: {
            tool: "askUser",
            question: "Which branch should I use?",
          },
        },
      },
    ]);

    expect(screen.getByText("Needs Input")).toBeTruthy();
    expect(view.container.querySelector(".animate-spin")).toBeNull();
    expect(view.container.querySelector(".bg-amber-400\\/85")).toBeTruthy();
  });

  it("labels provider chats as Codex and preserves explicit assistant labels", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: "Streaming response",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "done",
          turnId: "turn-1",
          status: "completed",
          modelId: "gpt-5.4-codex",
        },
      },
    ]);

    expect(screen.getByText("Codex")).toBeTruthy();

    cleanup();

    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Streaming response",
            itemId: "text-1",
            turnId: "turn-1",
          },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:01.000Z",
          event: {
            type: "done",
            turnId: "turn-1",
            status: "completed",
            modelId: "gpt-5.4-codex",
          },
        },
      ],
      {
        assistantLabel: "Workbench",
      },
    );

    expect(screen.getByText("Workbench")).toBeTruthy();
  });

  it("surfaces the latest turn task summary with review changes near the composer", () => {
    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Working through the renderer pass.",
            itemId: "text-1",
            turnId: "turn-7",
          },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:01.000Z",
          event: {
            type: "todo_update",
            turnId: "turn-7",
            items: [
              { id: "task-1", description: "Inspect shared renderer", status: "completed" },
              { id: "task-2", description: "Implement calmer transcript rows", status: "in_progress" },
            ],
          },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:02.000Z",
          event: {
            type: "file_change",
            path: "apps/desktop/src/foo.ts",
            diff: "+ const a = 1;\n",
            kind: "modify",
            itemId: "file-1",
            turnId: "turn-7",
            status: "completed",
          },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:03.000Z",
          event: {
            type: "subagent_started",
            taskId: "bg-1",
            description: "Check mission thread renderer",
            turnId: "turn-7",
            background: true,
          },
        },
      ],
      {
        initialState: { laneId: "lane-123" },
      },
    );

    expect(screen.getAllByText("1 of 2 tasks completed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Inspect shared renderer").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Implement calmer transcript rows").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/1 file changed/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/1 background agent/i).length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: /Review changes/i }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"laneId\":\"lane-123\"}",
    );
  });

  it("keeps reasoning blocks separated across Claude tool boundaries", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "reasoning",
          text: "First thought.",
          itemId: "claude-thinking:turn-1:0",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "tool_call",
          tool: "functions.exec_command",
          args: { cmd: "pwd" },
          itemId: "claude-tool:turn-1:1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "reasoning",
          text: "Second thought.",
          itemId: "claude-thinking:turn-1:2",
          turnId: "turn-1",
        },
      },
    ]);

    const reasoningButtons = screen.getAllByRole("button", { name: /Thought for/i });
    expect(reasoningButtons).toHaveLength(2);

    fireEvent.click(reasoningButtons[0]!);
    fireEvent.click(reasoningButtons[1]!);

    expect(screen.getByText("First thought.")).toBeTruthy();
    expect(screen.getByText("Second thought.")).toBeTruthy();
    expect(screen.queryByText("First thought.Second thought.")).toBeNull();
  });
});
