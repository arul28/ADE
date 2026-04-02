/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { AgentChatApprovalDecision, AgentChatEventEnvelope } from "../../../shared/types";
import * as modelRegistry from "../../../shared/modelRegistry";
import {
  AgentChatMessageList,
  calculateVirtualWindow,
  deriveTurnModelState,
  reconcileMeasuredScrollTop,
} from "./AgentChatMessageList";

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
    onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => void;
  },
) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/", state: options?.initialState }]}>
      <AgentChatMessageList
        events={events}
        assistantLabel={options?.assistantLabel}
        showStreamingIndicator={options?.showStreamingIndicator}
        onApproval={options?.onApproval as any}
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
  vi.restoreAllMocks();
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

  it("keeps the done summary visible when only the model attribution is available", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "done",
          turnId: "turn-1",
          status: "completed",
          modelId: "anthropic/claude-sonnet-4-6",
        },
      },
    ]);

    expect(screen.getByText("Usage")).toBeTruthy();
    expect(screen.getAllByText(/Claude Sonnet 4\.6/).length).toBeGreaterThan(0);
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

    expect(screen.getByText("Ran shell")).toBeTruthy();

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

    expect(screen.getByText("Edited files")).toBeTruthy();

    fireEvent.click(findButtonByTextContent(/foo\.ts/i));
    fireEvent.click(findButtonByTextContent(/bar\.ts/i));

    const body = document.body.textContent ?? "";
    expect(body).toContain("foo.ts");
    expect(body).toContain("bar.ts");
  });

  it("shows the four most recent work-log entries by default and expands overflow on demand", () => {
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

    expect(screen.getByText("Ran shell")).toBeTruthy();
    expect(screen.getByText("Show 3 earlier")).toBeTruthy();
    expect(screen.queryByText(/echo 3/i)).toBeNull();
    expect(findButtonByTextContent(/echo 4/i)).toBeTruthy();
    expect(findButtonByTextContent(/echo 7/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show 3 earlier" }));

    expect(findButtonByTextContent(/echo 1/i)).toBeTruthy();
  });

  it("uses a bounded assistant bubble width for long markdown responses", () => {
    const view = renderMessageList([
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
    ]);

    expect(view.container.innerHTML).toContain("max-w-[78ch]");
  });

  it("renders markdown tables inside a dedicated scroll shell", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: [
            "| Aspect | ADE | Other UI |",
            "| --- | --- | --- |",
            "| Task progress | Flat tool cards | Step-based progress |",
          ].join("\n"),
          itemId: "text-table",
          turnId: "turn-1",
        },
      },
    ]);

    const table = screen.getByRole("table");
    expect(table.parentElement?.className).toContain("overflow-x-auto");
    expect(screen.getByText("Task progress")).toBeTruthy();
  });

  it("absorbs tool summaries into the grouped work-log header instead of rendering a separate row", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_call",
          tool: "functions.exec_command",
          args: { cmd: "pwd" },
          itemId: "tool-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "tool_result",
          tool: "functions.exec_command",
          result: { stdout: "/tmp/project" },
          itemId: "tool-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "tool_use_summary",
          summary: "Checked the current working directory",
          toolUseIds: ["tool-1"],
          turnId: "turn-1",
        },
      },
    ]);

    expect(screen.getByText("Checked the current working directory")).toBeTruthy();
    expect(screen.queryByText("Tool summary")).toBeNull();
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

  it("recomputes virtualization windows when measured heights change", () => {
    const baseline = calculateVirtualWindow({
      rowCount: 100,
      scrollTop: 2000,
      containerHeight: 240,
      rowHeight: () => 80,
    });
    const updated = calculateVirtualWindow({
      rowCount: 100,
      scrollTop: 2000,
      containerHeight: 240,
      rowHeight: (index) => (index === 0 ? 180 : 80),
    });

    expect(updated.totalHeight).toBeGreaterThan(baseline.totalHeight);
    expect(updated.offsetTop).toBeGreaterThan(baseline.offsetTop);
  });

  it("keeps the current viewport anchored when rows above it grow", () => {
    const adjusted = reconcileMeasuredScrollTop({
      index: 2,
      previousHeight: 80,
      nextHeight: 140,
      scrollTop: 400,
      rowHeight: () => 80,
    });
    const unchanged = reconcileMeasuredScrollTop({
      index: 8,
      previousHeight: 80,
      nextHeight: 140,
      scrollTop: 400,
      rowHeight: () => 80,
    });

    expect(adjusted).toBe(460);
    expect(unchanged).toBe(400);
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

    expect(screen.getByText("Turn recap")).toBeTruthy();
    expect(screen.getAllByText("1/2 complete").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^1 file$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^1 agent$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("1 active").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("+1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("-1").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();

    fireEvent.click(screen.getByText("Turn recap"));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));

    expect(screen.getByTestId("location").textContent).toBe("/files::{\"laneId\":\"lane-123\"}");
  });

  it("renders ask-user requests with an amber waiting icon", () => {
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
    expect(view.container.querySelector("svg.text-amber-400")).toBeTruthy();
    expect(view.container.querySelector(".animate-spin.text-amber-400")).toBeFalsy();
  });

  it("renders structured question blocks and forwards structured answers from option chips", () => {
    const onApproval = vi.fn();
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "approval_request",
          itemId: "approval-structured",
          kind: "tool_call",
          description: "Choose how to proceed",
          turnId: "turn-1",
          detail: {
            request: {
              requestId: "request-structured",
              itemId: "approval-structured",
              source: "codex",
              kind: "structured_question",
              title: "Input needed",
              description: "Choose how to proceed",
              questions: [
                {
                  id: "question_1",
                  header: "Question 1",
                  question: "Which area should we test first?",
                  options: [
                    { label: "Question flow", value: "question_flow" },
                    { label: "Plan updates", value: "plan_updates" },
                  ],
                  allowsFreeform: true,
                },
                {
                  id: "question_2",
                  header: "Question 2",
                  question: "What validation strategy should we use?",
                  allowsFreeform: true,
                },
              ],
              allowsFreeform: true,
              blocking: true,
              canProceedWithoutAnswer: false,
            },
          },
        },
      },
    ], { onApproval });

    expect(screen.getByText("Question 1")).toBeTruthy();
    expect(screen.getByText("Question 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Question flow" }));

    expect(onApproval).toHaveBeenCalledWith(
      "approval-structured",
      "accept",
      null,
      { question_1: ["question_flow"] },
    );
  });

  it("shows structured questions as declined once the first resolution arrives and disables stale option chips", () => {
    const onApproval = vi.fn();
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "approval_request",
          itemId: "approval-structured",
          kind: "tool_call",
          description: "Choose how to proceed",
          turnId: "turn-1",
          detail: {
            request: {
              requestId: "request-structured",
              itemId: "approval-structured",
              source: "codex",
              kind: "structured_question",
              title: "Input needed",
              description: "Choose how to proceed",
              questions: [
                {
                  id: "question_1",
                  header: "Question 1",
                  question: "Which area should we test first?",
                  options: [
                    { label: "Question flow", value: "question_flow" },
                    { label: "Plan updates", value: "plan_updates" },
                  ],
                  allowsFreeform: true,
                },
              ],
              allowsFreeform: true,
              blocking: true,
              canProceedWithoutAnswer: false,
            },
          },
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "pending_input_resolved",
          itemId: "approval-structured",
          resolution: "declined",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "pending_input_resolved",
          itemId: "approval-structured",
          resolution: "cancelled",
        },
      },
    ], { onApproval });

    expect(screen.getByText("Declined")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Question flow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan updates" })).toBeNull();
    expect(onApproval).not.toHaveBeenCalled();
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

  it("renders detailed Claude labels when the turn only reports a CLI alias", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: "Fast response",
          itemId: "text-1",
          turnId: "turn-claude",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "done",
          turnId: "turn-claude",
          status: "interrupted",
          model: "sonnet",
        },
      },
    ]);

    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getAllByText("Claude Sonnet 4.6 (anthropic/claude-sonnet-4-6)").length).toBeGreaterThan(0);
  });

  it("shows the SDK-reported Claude model name when it differs from the registry id", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "done",
          turnId: "turn-claude-runtime",
          status: "failed",
          model: "claude-haiku-4-5",
          modelId: "anthropic/claude-haiku-4-5",
        },
      },
    ]);

    expect(screen.getAllByText("Claude Haiku 4.5 (claude-haiku-4-5)").length).toBeGreaterThan(0);
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

    expect(screen.getByText("Turn recap")).toBeTruthy();
    expect(screen.getAllByText("1/2 complete").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Inspect shared renderer").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Implement calmer transcript rows").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^1 file$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^1 agent$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /Review changes/i })).toBeNull();

    fireEvent.click(screen.getByText("Turn recap"));
    fireEvent.click(screen.getByRole("button", { name: /Review changes/i }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"laneId\":\"lane-123\"}",
    );
  });

  it("shows the active Claude model on the latest turn summary card", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "todo_update",
          turnId: "turn-9",
          items: [
            { id: "task-1", description: "Investigate Claude turn status", status: "completed" },
          ],
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "done",
          turnId: "turn-9",
          status: "completed",
          modelId: "anthropic/claude-sonnet-4-6",
        },
      },
    ]);

    expect(screen.getByText("Turn recap")).toBeTruthy();
    expect(screen.getAllByText("1/1 complete").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Claude Sonnet 4\.6/).length).toBeGreaterThanOrEqual(1);
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

    const reasoningButtons = screen.getAllByRole("button", { name: /Thought/i });
    expect(reasoningButtons).toHaveLength(2);

    fireEvent.click(reasoningButtons[0]!);
    fireEvent.click(reasoningButtons[1]!);

    expect(screen.getAllByText("First thought.")).toHaveLength(2);
    expect(screen.getAllByText("Second thought.")).toHaveLength(2);
    expect(screen.queryByText("First thought.Second thought.")).toBeNull();
  });
});

describe("deriveTurnModelState", () => {
  it("only processes newly appended done events when history grows", () => {
    const getModelByIdSpy = vi.spyOn(modelRegistry, "getModelById").mockReturnValue({
      displayName: "Codex",
    } as any);
    const firstBatch: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "done",
          turnId: "turn-1",
          status: "completed",
          modelId: "gpt-5.4-codex",
        },
      },
    ];

    const initialState = deriveTurnModelState(firstBatch);
    expect(initialState.map.get("turn-1")?.label).toContain("Codex");
    expect(getModelByIdSpy).toHaveBeenCalledTimes(1);

    const nextState = deriveTurnModelState(
      [
        ...firstBatch,
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:01.000Z",
          event: {
            type: "done",
            turnId: "turn-2",
            status: "completed",
            modelId: "gpt-5.4-codex",
          },
        },
      ],
      initialState,
    );

    expect(nextState.map.get("turn-2")?.label).toContain("Codex");
    expect(getModelByIdSpy).toHaveBeenCalledTimes(2);
  });
});
