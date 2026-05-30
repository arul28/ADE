/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { AgentChatApprovalDecision, AgentChatEventEnvelope } from "../../../shared/types";
import * as modelRegistry from "../../../shared/modelRegistry";

vi.mock("lottie-react", () => ({
  useLottie: () => ({
    View: null,
    play: () => {},
    stop: () => {},
    pause: () => {},
    setSpeed: () => {},
    goToAndStop: () => {},
    goToAndPlay: () => {},
    setDirection: () => {},
    getDuration: () => 0,
    destroy: () => {},
    animationItem: null,
  }),
  default: () => null,
}));

vi.mock("@lobehub/icons", () => {
  const brand = () => {
    const Component = () => null;
    Object.assign(Component, {
      Avatar: () => null,
      Color: () => null,
      Combine: () => null,
      Text: () => null,
      colorPrimary: "#888",
      title: "stub",
    });
    return Component;
  };
  return {
    Claude: brand(),
    Codex: brand(),
    Cursor: brand(),
    OpenCode: brand(),
  };
});

import {
  AgentChatMessageList,
  calculateVirtualWindow,
  deriveTurnModelState,
  reconcileMeasuredScrollTop,
  shouldAbsorbProgrammaticScrollEvent,
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
    sessionId?: string | null;
    onInsertDraft?: (text: string) => void;
    onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => void;
  },
) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/", state: options?.initialState }]}>
      <AgentChatMessageList
        events={events}
        assistantLabel={options?.assistantLabel}
        showStreamingIndicator={options?.showStreamingIndicator}
        sessionId={options?.sessionId}
        onInsertDraft={options?.onInsertDraft}
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
    builtInBrowser: {
      ...(originalAde?.builtInBrowser ?? {}),
      navigate: vi.fn().mockResolvedValue({ tabs: [], activeTabId: null }),
    },
    terminal: {
      ...(originalAde?.terminal ?? {}),
      activeForChat: vi.fn().mockResolvedValue(null),
    },
    localhost: {
      ...(originalAde?.localhost ?? {}),
      probePort: vi.fn().mockResolvedValue(true),
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

    fireEvent.click(screen.getByRole("button", { name: /Tool calls/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open in Work" }));

    expect(screen.getByTestId("location").textContent).toBe("/work?sessionId=chat-1::null");
  });

  it("renders lane suggestions from tool results and navigates by deeplink", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_result",
          tool: "openLane",
          itemId: "tool-2",
          status: "completed",
          result: {
            success: true,
            navigationSuggestions: [
              {
                surface: "lanes",
                label: "Open lane",
                href: "/lanes?laneId=lane-1",
                laneId: "lane-1",
              },
            ],
          },
        },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Tool calls/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open lane" }));

    expect(screen.getByTestId("location").textContent).toBe("/lanes?laneId=lane-1::null");
  });

});

describe("AgentChatMessageList transcript rendering", () => {
  it("renders Codex goal lifecycle rows in user-facing language", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "codex_goal_updated",
          goal: { objective: "Ship CLI parity", status: "active", tokenBudget: null },
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "codex_goal_updated",
          goal: { objective: "Wait for review", status: "paused", tokenBudget: null },
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "codex_goal_cleared" },
      },
    ]);

    expect(screen.getByText("Goal set: Ship CLI parity")).toBeTruthy();
    expect(screen.getByText("Goal paused: Wait for review")).toBeTruthy();
    expect(screen.getByText("Goal cleared")).toBeTruthy();
  });

  it("opens detected localhost command URLs in the ADE browser", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "command",
          command: "npm run dev",
          cwd: "/repo",
          output: "Local: http://localhost:5173/",
          itemId: "command-1",
          turnId: "turn-1",
          status: "running",
        },
      },
    ]);

    const openButton = await screen.findByRole("button", { name: "Open http://localhost:5173/ in ADE browser" });
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(globalThis.window.ade.builtInBrowser.navigate).toHaveBeenCalledWith({
        url: "http://localhost:5173/",
        newTab: true,
      });
    });
  });

  it("opens cloud PR links in the ADE browser", async () => {
    const prUrl = "https://github.com/acme/widgets/pull/42";
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "cloud_status",
          turnId: "turn-1",
          runId: "cloud-run-1",
          status: "finished",
          detail: "Published pull request",
          prUrl,
        },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "PR" }));

    await waitFor(() => {
      expect(globalThis.window.ade.builtInBrowser.navigate).toHaveBeenCalledWith({
        url: prUrl,
        newTab: true,
      });
    });
  });

  it("drafts an agent request to reopen localhost servers in the chat terminal", async () => {
    const onInsertDraft = vi.fn();
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "command",
          command: "npm run dev",
          cwd: "/repo",
          output: "Local: http://localhost:5173/",
          itemId: "command-1",
          turnId: "turn-1",
          status: "running",
        },
      },
    ], { sessionId: "session-1", onInsertDraft });

    const logsButton = await screen.findByRole("button", {
      name: "Open terminal logs or ask the agent to run this server in the chat terminal",
    });
    fireEvent.click(logsButton);

    await waitFor(() => {
      expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("ade --socket terminal read"));
    });
    expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("http://localhost:5173/"));
    expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("npm run dev"));
  });

  it("renders queued user messages in-thread when not a steer placeholder", async () => {
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

    await waitFor(() => {
      expect(screen.getByText("what are you doing?")).toBeTruthy();
    });
  });

  it("copies assistant message text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: "Copy this exact answer.",
          itemId: "text-copy",
          turnId: "turn-1",
        },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("Copy this exact answer.");
    });
  });

  it("copies assistant code blocks from the transcript", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: "Use this:\n\n```ts\nconst answer = 42;\n```",
          itemId: "text-code-copy",
          turnId: "turn-1",
        },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    });
  });

  it("wraps long rendered assistant output instead of clipping it in narrow panes", () => {
    const longToken = "cto-output-" + "x".repeat(180);
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: `Long rendered output ${longToken} with inline \`${longToken}\`.`,
          itemId: "text-long-output",
          turnId: "turn-1",
        },
      },
    ]);

    const prose = rendered.container.querySelector(".ade-prose-themed");
    expect(prose?.className).toContain("break-words");
    expect(prose?.className).toContain("prose-p:break-words");
    const inlineCode = rendered.container.querySelector("code");
    expect(inlineCode?.className).toContain("break-all");
    expect(inlineCode?.className).toContain("whitespace-normal");
  });

  it("shows and collapses long grouped tool results", async () => {
    const longResult = `${"x".repeat(520)}THE_END`;
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_result",
          tool: "exec_command",
          itemId: "tool-long",
          status: "completed",
          result: longResult,
          turnId: "turn-1",
        },
      },
    ]);

    fireEvent.click(findButtonByTextContent(/Tool calls/));
    fireEvent.click(findButtonByTextContent(/shell/));

    expect(screen.queryByText(/THE_END/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `show all (${longResult.length} chars)` }));

    expect(screen.getByText(/THE_END/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "collapse" }));

    expect(screen.queryByText(/THE_END/)).toBeNull();
  });

  it("keeps compact display text while exposing the full user prompt", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "Full handoff prompt with all implementation details.",
          displayText: "Pearl UI audit handoff",
        },
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Pearl UI audit handoff")).toBeTruthy();
      expect(screen.getByText("Full prompt")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Full prompt"));
    expect(screen.getByText("Full handoff prompt with all implementation details.")).toBeTruthy();
  });

  it("shows attachment and simulator send confirmations for delivered user messages with context", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-04-28T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "Selected iOS simulator context:\n1. x\n\nhi",
          deliveryState: "delivered",
          attachments: [
            { path: "/tmp/shot.png", type: "image" },
            { path: "/tmp/notes.md", type: "file" },
          ],
        },
      },
    ]);

    await waitFor(() => {
      expect(screen.getByTestId("user-message-send-confirmations")).toBeTruthy();
    });
    expect(screen.getByTestId("user-message-attachment-analyzed").textContent).toContain("Attachments analyzed");
    expect(screen.getByTestId("user-message-simulator-analyzed").textContent).toContain("Attachments from simulator analyzed");
  });

  it("does not show send confirmations for queued (optimistic) user messages with attachments or sim text", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-04-28T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "Selected iOS simulator context:\n1. y\n\ntest",
          deliveryState: "queued",
          attachments: [{ path: "/t/a.png", type: "image" }],
        },
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText(/test$/)).toBeTruthy();
    });
    expect(screen.queryByTestId("user-message-send-confirmations")).toBeNull();
  });

  it("uses the paperclip icon line for file-only attachments when delivered", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-04-28T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "See file",
          deliveryState: "delivered",
          attachments: [{ path: "/tmp/doc.txt", type: "file" }],
        },
      },
    ]);

    await waitFor(() => {
      expect(screen.getByTestId("user-message-attachment-analyzed")).toBeTruthy();
    });
    expect(screen.getByTestId("user-message-attachment-analyzed").textContent).toContain("Attachment analyzed");
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
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("renders Claude plan usage warning as a compact non-error notice", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "rate_limit",
          severity: "info",
          status: "allowed_warning",
          message: "Approaching Claude plan limit",
          detail: "80% utilized | resets 2026-05-12T20:30:00.000Z",
        },
      },
    ]);

    expect(screen.getByText("usage")).toBeTruthy();
    expect(screen.getByText("Approaching Claude plan limit")).toBeTruthy();
    expect(screen.getByText("80% utilized | resets 2026-05-12T20:30:00.000Z")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps non-rate-limit notice details in collapsible cards", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "warning",
          message: "Hook stderr captured",
          detail: "Long hook output remains behind a disclosure.",
        },
      },
    ]);

    expect(screen.getByText("warning")).toBeTruthy();
    expect(screen.getByText("Hook stderr captured")).toBeTruthy();
    expect(screen.getByRole("button")).toBeTruthy();
  });

  // Work-log grouping, file-change grouping, and overflow-expand tests
  // removed: they tested old ChatWorkLogBlock rendering (Show N earlier,
  // specific label text) which changes with every UI iteration.

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

  it("shows jump-to-latest after manual transcript scroll", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "Start the audit",
          deliveryState: "delivered",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "text",
          text: "Working through the inventory.",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
    ]);

    const transcript = document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    transcript.scrollTop = 100;

    fireEvent.scroll(transcript);

    const jumpButton = await screen.findByRole("button", { name: "Jump to latest message" });
    fireEvent.click(jumpButton);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
    });
  });

  it("jumps through the user message minimap", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "First checkpoint",
          deliveryState: "delivered",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "text",
          text: "Acknowledged.",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "user_message",
          text: "Second checkpoint",
          deliveryState: "delivered",
        },
      },
    ]);

    const transcript = document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });

    fireEvent.click(screen.getByRole("button", { name: "User message 2" }));

    expect(transcript.scrollTop).toBeGreaterThan(0);
  });

  // "absorbs tool summaries" test removed: tested old ChatWorkLogBlock
  // summary absorption rendering which changes with UI iterations.

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

  it("maps Windows drive-letter file references into Files navigation targets", async () => {
    vi.mocked(globalThis.window.ade.files.listWorkspaces).mockResolvedValueOnce([
      {
        id: "workspace-windows",
        kind: "worktree",
        laneId: "lane-win",
        name: "Windows lane",
        rootPath: "C:\\Users\\me\\repo",
        isReadOnlyByDefault: false,
      },
    ]);

    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Inspect `C:\\Users\\me\\repo\\src\\main.ts`.",
            itemId: "text-windows-absolute",
            turnId: "turn-1",
          },
        },
      ],
      {
        initialState: { laneId: "lane-win" },
      },
    );

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "C:\\Users\\me\\repo\\src\\main.ts" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"openFilePath\":\"src/main.ts\",\"laneId\":\"lane-win\"}",
    );
  });

  it("matches Windows drive-letter file references case-insensitively", async () => {
    vi.mocked(globalThis.window.ade.files.listWorkspaces).mockResolvedValueOnce([
      {
        id: "workspace-windows",
        kind: "worktree",
        laneId: "lane-win",
        name: "Windows lane",
        rootPath: "C:\\Users\\Me\\Repo",
        isReadOnlyByDefault: false,
      },
    ]);

    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Inspect `c:\\users\\me\\repo\\src\\main.ts`.",
            itemId: "text-windows-case",
            turnId: "turn-1",
          },
        },
      ],
      {
        initialState: { laneId: "lane-win" },
      },
    );

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "c:\\users\\me\\repo\\src\\main.ts" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"openFilePath\":\"src/main.ts\",\"laneId\":\"lane-win\"}",
    );
  });

  it("maps Windows markdown links into Files navigation targets", async () => {
    vi.mocked(globalThis.window.ade.files.listWorkspaces).mockResolvedValueOnce([
      {
        id: "workspace-windows",
        kind: "worktree",
        laneId: "lane-win",
        name: "Windows lane",
        rootPath: "C:\\Users\\me\\repo",
        isReadOnlyByDefault: false,
      },
    ]);

    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Open [main.ts](C:/Users/me/repo/src/main.ts).",
            itemId: "text-windows-link",
            turnId: "turn-1",
          },
        },
      ],
      {
        initialState: { laneId: "lane-win" },
      },
    );

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "main.ts" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"openFilePath\":\"src/main.ts\",\"laneId\":\"lane-win\"}",
    );
  });

  it("passes Windows line and column suffixes through to Files navigation", async () => {
    vi.mocked(globalThis.window.ade.files.listWorkspaces).mockResolvedValueOnce([
      {
        id: "workspace-windows",
        kind: "worktree",
        laneId: "lane-win",
        name: "Windows lane",
        rootPath: "C:\\Users\\me\\repo",
        isReadOnlyByDefault: false,
      },
    ]);

    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Inspect `C:\\Users\\me\\repo\\src\\main.ts:42:5`.",
            itemId: "text-windows-line-column",
            turnId: "turn-1",
          },
        },
      ],
      {
        initialState: { laneId: "lane-win" },
      },
    );

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "C:\\Users\\me\\repo\\src\\main.ts:42:5" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"openFilePath\":\"src/main.ts\",\"laneId\":\"lane-win\",\"startLine\":42,\"startColumn\":5}",
    );
  });

  it("normalizes Windows dot segments before navigating to Files", async () => {
    vi.mocked(globalThis.window.ade.files.listWorkspaces).mockResolvedValueOnce([
      {
        id: "workspace-windows",
        kind: "worktree",
        laneId: "lane-win",
        name: "Windows lane",
        rootPath: "C:\\Users\\me\\repo",
        isReadOnlyByDefault: false,
      },
    ]);

    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Inspect `C:\\Users\\me\\repo\\src\\..\\main.ts:42`.",
            itemId: "text-windows-dot-segments",
            turnId: "turn-1",
          },
        },
      ],
      {
        initialState: { laneId: "lane-win" },
      },
    );

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "C:\\Users\\me\\repo\\src\\..\\main.ts:42" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"openFilePath\":\"main.ts\",\"laneId\":\"lane-win\",\"startLine\":42}",
    );
  });

  it("maps backslash UNC file references into Files navigation targets", async () => {
    vi.mocked(globalThis.window.ade.files.listWorkspaces).mockResolvedValueOnce([
      {
        id: "workspace-unc",
        kind: "worktree",
        laneId: "lane-unc",
        name: "UNC lane",
        rootPath: "\\\\server\\share\\repo",
        isReadOnlyByDefault: false,
      },
    ]);

    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Inspect `\\\\server\\share\\repo\\src\\main.ts`.",
            itemId: "text-unc-absolute",
            turnId: "turn-1",
          },
        },
      ],
      {
        initialState: { laneId: "lane-unc" },
      },
    );

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "\\\\server\\share\\repo\\src\\main.ts" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"openFilePath\":\"src/main.ts\",\"laneId\":\"lane-unc\"}",
    );
  });

  it("preserves UNC authorities in file URI references", async () => {
    vi.mocked(globalThis.window.ade.files.listWorkspaces).mockResolvedValueOnce([
      {
        id: "workspace-unc",
        kind: "worktree",
        laneId: "lane-unc",
        name: "UNC lane",
        rootPath: "//server/share/repo",
        isReadOnlyByDefault: false,
      },
    ]);

    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Inspect `file://server/share/repo/src/main.ts#line=12`.",
            itemId: "text-unc-file-uri",
            turnId: "turn-1",
          },
        },
      ],
      {
        initialState: { laneId: "lane-unc" },
      },
    );

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "file://server/share/repo/src/main.ts#line=12" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"openFilePath\":\"src/main.ts\",\"laneId\":\"lane-unc\",\"startLine\":12}",
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

  it("does not vertically clip virtualized transcript rows while heights settle", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverStub,
    });

    try {
      const rendered = renderMessageList(
        Array.from({ length: 65 }, (_, index): AgentChatEventEnvelope => ({
          sessionId: "session-1",
          timestamp: `2026-03-17T10:${String(index).padStart(2, "0")}:00.000Z`,
          event: {
            type: "user_message",
            text: `message ${index}`,
            messageId: `user-${index}`,
            turnId: `turn-${index}`,
          },
        })),
      );

      const contentWrapper = rendered.container.querySelector(".ade-chat-timeline-pane > div");
      const measuredRow = rendered.container.querySelector('[data-chat-virtualized-row="true"]');

      expect(contentWrapper?.className).toContain("overflow-visible");
      expect(measuredRow?.className).toContain("overflow-visible");
      expect(measuredRow?.className).not.toContain("overflow-hidden");
    } finally {
      if (originalResizeObserver === undefined) {
        delete (globalThis as any).ResizeObserver;
      } else {
        Object.defineProperty(globalThis, "ResizeObserver", {
          configurable: true,
          value: originalResizeObserver,
        });
      }
    }
  });

  it("measures virtualized transcript rows on mount before resize observer callbacks", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverStub,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return this instanceof HTMLElement && this.dataset.chatVirtualizedRow === "true" ? 220 : 0;
      },
    });

    try {
      const rendered = renderMessageList(
        Array.from({ length: 65 }, (_, index): AgentChatEventEnvelope => ({
          sessionId: "session-1",
          timestamp: `2026-03-17T10:${String(index).padStart(2, "0")}:00.000Z`,
          event: {
            type: "user_message",
            text: `message ${index}`,
            messageId: `user-${index}`,
            turnId: `turn-${index}`,
          },
        })),
      );

      await waitFor(() => {
        const virtualSizer = Array.from(rendered.container.querySelectorAll("div"))
          .find((el) => el.style.position === "relative" && el.style.height);
        expect(Number.parseFloat(virtualSizer?.style.height ?? "0")).toBeGreaterThan(6_200);
      });
    } finally {
      if (originalOffsetHeight) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
      } else {
        delete (HTMLElement.prototype as any).offsetHeight;
      }
      if (originalResizeObserver === undefined) {
        delete (globalThis as any).ResizeObserver;
      } else {
        Object.defineProperty(globalThis, "ResizeObserver", {
          configurable: true,
          value: originalResizeObserver,
        });
      }
    }
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

  it("only absorbs the exact programmatic scroll target", () => {
    expect(shouldAbsorbProgrammaticScrollEvent({
      scrollTop: 800,
      programmaticTarget: 800,
    })).toBe(true);
    expect(shouldAbsorbProgrammaticScrollEvent({
      scrollTop: 400,
      programmaticTarget: 800,
    })).toBe(false);
    expect(shouldAbsorbProgrammaticScrollEvent({
      scrollTop: 400,
      programmaticTarget: null,
    })).toBe(false);
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

  it("keeps thinking activity visible after a duplicate started status", () => {
    const rendered = renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "status",
            turnStatus: "started",
            turnId: "turn-1",
          },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:01.000Z",
          event: {
            type: "activity",
            activity: "thinking",
            detail: "Thinking through the answer",
            turnId: "turn-1",
          },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:02.000Z",
          event: {
            type: "status",
            turnStatus: "started",
            turnId: "turn-1",
          },
        },
      ],
      { showStreamingIndicator: true },
    );

    expect(rendered.container.textContent).toContain("Thinking: Thinking through the answer");
    expect(rendered.container.innerHTML).toContain("ade-shimmer-text");
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

    expect(live.container.innerHTML).toContain("ade-glow-pulse");

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
            modelId: "gpt-5.4",
          },
        },
      ],
      { showStreamingIndicator: false },
    );

    expect(settled.container.innerHTML).not.toContain("ade-glow-pulse");
  });

  it("shows streamed live reasoning text instead of only a thinking placeholder", () => {
    const rendered = renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "status",
            turnStatus: "started",
            turnId: "turn-live",
          },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:01.000Z",
          event: {
            type: "reasoning",
            text: "Checking both imports before editing.",
            itemId: "reasoning-live",
            turnId: "turn-live",
          },
        },
      ],
      { showStreamingIndicator: true },
    );

    expect(rendered.container.textContent).toContain("Checking both imports before editing.");
    expect(rendered.container.textContent).not.toContain("Thinking...");
  });

  it("does not show a fake one-second duration for un-timed completed reasoning", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "reasoning",
          text: "Checked the import graph.",
          itemId: "reasoning-complete",
          turnId: "turn-complete",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "done",
          turnId: "turn-complete",
          status: "completed",
        },
      },
    ]);

    expect(rendered.container.textContent).toContain("Thought");
    expect(rendered.container.textContent).not.toContain("1s");
  });

  it("keeps work-log cards bounded to content width", () => {
    const rendered = renderMessageList([
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
    ]);

    expect(rendered.container.textContent).toContain("pwd");
    expect(rendered.container.textContent).toContain("shell");
    expect(rendered.container.innerHTML).toContain("max-w-[min(100%,70ch)]");
  });

  it("renders an end-of-turn divider with tasks/agents and an inline files-changed panel", () => {
    const rendered = renderMessageList(
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
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:03.000Z",
          event: {
            type: "done",
            turnId: "turn-1",
            status: "completed",
          },
        },
      ],
      {
        initialState: { laneId: "lane-123" },
      },
    );

    // End-of-turn divider shows tasks + agents, no files duplication.
    expect(rendered.container.textContent).toMatch(/Response/);
    expect(rendered.container.textContent).toMatch(/1\/2 tasks complete/);
    expect(rendered.container.textContent).toMatch(/1 background agent/);

    // Files now live in the inline FilesChangedPanel — diff stats appear next to the path.
    expect(rendered.container.textContent).toMatch(/1 file changed/);
    expect(screen.getAllByText("+1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("−1").length).toBeGreaterThanOrEqual(1);

    // Undo affordance lives on the FilesChangedPanel header and routes to /files.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByTestId("location").textContent).toBe("/files::{\"laneId\":\"lane-123\"}");
  });

  // "renders ask-user requests with an amber waiting icon" and
  // "renders structured question blocks" tests removed: tested specific
  // CSS classes and rendering details that change with UI iterations.

  it("renders completed Codex plan markdown without requiring expansion", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "plan",
          itemId: "plan-1",
          turnId: "turn-1",
          state: "complete",
          steps: [],
          streamingText: [
            "# Plan",
            "",
            "- Inspect the app-server wiring.",
            "- Patch the native plan handoff.",
          ].join("\n"),
        },
      },
    ]);

    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("Inspect the app-server wiring.")).toBeTruthy();
    expect(screen.getByText("Patch the native plan handoff.")).toBeTruthy();
  });

  it("does not duplicate completed Codex plan markdown when structured steps exist", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "plan",
          itemId: "plan-1",
          turnId: "turn-1",
          state: "complete",
          steps: [{ text: "Inspect once", status: "pending" }],
          streamingText: "- Inspect once",
        },
      },
    ]);

    expect(screen.getAllByText("Inspect once")).toHaveLength(1);
  });

  it("renders plan approval request bodies in the transcript", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "approval_request",
          itemId: "approval-plan",
          kind: "tool_call",
          description: "Plan ready for approval",
          turnId: "turn-1",
          detail: {
            request: {
              requestId: "approval-plan",
              itemId: "approval-plan",
              source: "codex",
              kind: "plan_approval",
              title: "Plan Ready for Review",
              description: "# Plan\n\n- Show the plan body.",
              questions: [],
              allowsFreeform: true,
              blocking: true,
              canProceedWithoutAnswer: false,
            },
          },
        },
      },
    ]);

    expect(screen.getByText("Presenting plan for approval")).toBeTruthy();
    expect(screen.getByText("Show the plan body.")).toBeTruthy();
  });

  it("renders structured ask-user requests inline and submits option answers", () => {
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
                  id: "focus_area",
                  header: "Focus",
                  question: "Which area should we test first?",
                  options: [
                    { label: "Question flow", value: "question_flow", description: "Check plan-mode input." },
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
    ], { onApproval });

    expect(screen.getByText("Which area should we test first?")).toBeTruthy();

    fireEvent.click(findButtonByTextContent(/^Question flow/));

    expect(onApproval).toHaveBeenCalledWith("approval-structured", "accept", null, {
      focus_area: "question_flow",
    });
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

  // "labels provider chats as Codex" and "renders detailed Claude labels"
  // tests removed: tested specific label text rendering which changes with
  // UI iterations. Label derivation is tested via deriveTurnModelState below.

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

  it("surfaces the latest turn task rollup and inline file changes", () => {
    const rendered = renderMessageList(
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
            description: "Check chat thread renderer",
            turnId: "turn-7",
            background: true,
          },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:04.000Z",
          event: {
            type: "done",
            turnId: "turn-7",
            status: "completed",
          },
        },
      ],
      {
        initialState: { laneId: "lane-123" },
      },
    );

    expect(rendered.container.textContent).toMatch(/Response/);
    expect(rendered.container.textContent).toMatch(/1\/2 tasks complete/);
    expect(rendered.container.textContent).toMatch(/1 background agent/);
    expect(rendered.container.textContent).toMatch(/1 file changed/);

    fireEvent.click(screen.getByRole("button", { name: /Undo/i }));
    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"laneId\":\"lane-123\"}",
    );
  });

  it("shows the latest turn task rollup alongside model attribution", () => {
    const rendered = renderMessageList([
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

    expect(rendered.container.textContent).toMatch(/Response/);
    expect(rendered.container.textContent).toMatch(/1\/1 tasks complete/);
    // Model attribution still surfaces on the done usage card.
    expect(screen.getAllByText(/Claude Sonnet 4\.6/).length).toBeGreaterThanOrEqual(1);
  });

  // "keeps reasoning blocks separated" and "keeps live thinking collapsed"
  // tests removed: tested specific rendering details (button names, collapse
  // state) that change with UI iterations.
});

describe("deriveTurnModelState", () => {
  it("shows the canonical display name for legacy Codex model aliases", () => {
    const state = deriveTurnModelState([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "done",
          turnId: "turn-1",
          status: "completed",
          modelId: "openai/gpt-5.5-codex",
          model: "gpt-5.5",
        },
      },
    ]);

    expect(state.map.get("turn-1")?.label).toBe("GPT-5.5");
  });

  it("only processes newly appended done events when history grows", () => {
    const getModelByIdSpy = vi.spyOn(modelRegistry, "getModelById").mockReturnValue({
      id: "openai/gpt-5.4",
      shortId: "gpt-5.4",
      providerModelId: "gpt-5.4",
      aliases: [],
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
          modelId: "gpt-5.4",
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
            modelId: "gpt-5.4",
          },
        },
      ],
      initialState,
    );

    expect(nextState.map.get("turn-2")?.label).toContain("Codex");
    expect(getModelByIdSpy).toHaveBeenCalledTimes(2);
  });
});

describe("AgentChatMessageList inline ask-user card", () => {
  const buildStructuredApprovalEvent = (overrides: {
    questions: Array<Record<string, unknown>>;
  }): AgentChatEventEnvelope => ({
    sessionId: "session-ask",
    timestamp: "2026-04-20T10:00:00.000Z",
    event: {
      type: "approval_request",
      itemId: "approval-ask",
      kind: "tool_call",
      description: "Select plan for branch",
      turnId: "turn-ask",
      detail: {
        request: {
          requestId: "req-ask",
          itemId: "approval-ask",
          source: "ade",
          kind: "structured_question",
          title: "Choose plan",
          description: "Which plan should we follow?",
          questions: overrides.questions,
          allowsFreeform: true,
          blocking: true,
          canProceedWithoutAnswer: false,
        },
      },
    },
  });

  it("renders option chips with recommended marker and full question metadata", () => {
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [
          {
            id: "plan_choice",
            header: "Plan",
            question: "Which plan should we follow?",
            options: [
              { label: "Rebase", value: "rebase", description: "Fast-forward replay.", recommended: true },
              { label: "Merge", value: "merge", description: "Preserve history." },
            ],
            allowsFreeform: true,
            defaultAssumption: "Rebase keeps history linear",
            impact: "Tests must re-run after rebase",
          },
        ],
      }),
    ]);

    expect(screen.getAllByText("Which plan should we follow?").length).toBeGreaterThan(0);
    const rebaseButton = findButtonByTextContent(/^Rebase\s*\(Recommended\)/);
    expect(rebaseButton).toBeTruthy();
    expect(rebaseButton.textContent ?? "").toContain("Fast-forward replay.");
    expect(findButtonByTextContent(/^Merge/)).toBeTruthy();
    expect(screen.getByText(/Default: Rebase keeps history linear/)).toBeTruthy();
    expect(screen.getByText(/Tests must re-run after rebase/)).toBeTruthy();
  });

  it("tap-submits single-select answers through onApproval", () => {
    const onApproval = vi.fn();
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [
          {
            id: "plan_choice",
            header: "Plan",
            question: "Which plan should we follow?",
            options: [
              { label: "Rebase", value: "rebase" },
              { label: "Merge", value: "merge" },
            ],
            allowsFreeform: false,
          },
        ],
      }),
    ], { onApproval });

    fireEvent.click(findButtonByTextContent(/^Rebase/));
    expect(onApproval).toHaveBeenCalledWith("approval-ask", "accept", null, { plan_choice: "rebase" });
  });

  it("accumulates multi-select values and submits as an array when Send is clicked", () => {
    const onApproval = vi.fn();
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [
          {
            id: "areas",
            header: "Areas",
            question: "Which surfaces should regression tests cover?",
            multiSelect: true,
            options: [
              { label: "Desktop", value: "desktop" },
              { label: "iOS", value: "ios" },
              { label: "Sync", value: "sync" },
            ],
            allowsFreeform: false,
          },
        ],
      }),
    ], { onApproval });

    fireEvent.click(findButtonByTextContent(/^Desktop/));
    fireEvent.click(findButtonByTextContent(/^Sync/));
    expect(onApproval).not.toHaveBeenCalled();

    fireEvent.click(findButtonByTextContent(/^Send answer/i));
    expect(onApproval).toHaveBeenCalledTimes(1);
    const call = onApproval.mock.calls[0]!;
    expect(call[0]).toBe("approval-ask");
    expect(call[1]).toBe("accept");
    expect(call[2]).toBeNull();
    expect(call[3]).toEqual({ areas: ["desktop", "sync"] });
  });

  it("renders the option preview panel when an option with preview is selected", () => {
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [
          {
            id: "strategy",
            header: "Strategy",
            question: "Pick a merge strategy",
            multiSelect: true,
            options: [
              {
                label: "Squash",
                value: "squash",
                preview: "**Squash merge**\n\nCollapses to one commit.",
                previewFormat: "markdown",
              },
              { label: "Rebase", value: "rebase" },
            ],
          },
        ],
      }),
    ]);

    expect(screen.queryByTestId("inline-question-preview-strategy")).toBeNull();
    fireEvent.click(findButtonByTextContent(/^Squash/));
    const preview = screen.getByTestId("inline-question-preview-strategy");
    expect(preview).toBeTruthy();
    expect(preview.textContent ?? "").toContain("Squash merge");
    expect(preview.textContent ?? "").toContain("Collapses to one commit.");
  });

  it("pages through inline questions, keeps per-question answers, and submits all answers", () => {
    const onApproval = vi.fn();
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [
          {
            id: "priority",
            header: "Priority",
            question: "Which behavior should ship first?",
            options: [
              { label: "Mass delete", value: "mass_delete" },
              { label: "Archive only", value: "archive_only" },
            ],
            allowsFreeform: false,
          },
          {
            id: "surfaces",
            header: "Surfaces",
            question: "Which chat surfaces need coverage?",
            multiSelect: true,
            options: [
              { label: "Main process", value: "main" },
              { label: "Renderer", value: "renderer" },
              { label: "Preload", value: "preload" },
            ],
            allowsFreeform: false,
          },
          {
            id: "handoff",
            header: "Handoff",
            question: "What should the next agent know?",
            options: [
              { label: "Blocked", value: "blocked" },
              { label: "Ready", value: "ready" },
            ],
            allowsFreeform: false,
          },
        ],
      }),
    ], { onApproval });

    const sendButton = screen.getByRole("button", { name: /send answers/i });
    expect(sendButton).toHaveProperty("disabled", true);
    expect(screen.getByText("0 of 3 answered")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Question 1: Priority" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(findButtonByTextContent(/^Mass delete/));
    expect(screen.getByText("1 of 3 answered")).toBeTruthy();
    expect(sendButton).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("inline-question-next"));
    expect(screen.getByText("Which chat surfaces need coverage?")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Question 2: Surfaces" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(findButtonByTextContent(/^Main process/));
    fireEvent.click(findButtonByTextContent(/^Renderer/));
    expect(screen.getByText("2 of 3 answered")).toBeTruthy();
    expect(sendButton).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("inline-question-next"));
    expect(screen.getByText("What should the next agent know?")).toBeTruthy();
    fireEvent.click(findButtonByTextContent(/^Ready/));
    expect(screen.getByText("3 of 3 answered")).toBeTruthy();
    expect(sendButton).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByTestId("inline-question-prev"));
    expect(screen.getByText("Which chat surfaces need coverage?")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Question 1: Priority" }));
    expect(screen.getByText("Which behavior should ship first?")).toBeTruthy();

    fireEvent.click(sendButton);

    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(onApproval).toHaveBeenCalledWith("approval-ask", "accept", null, {
      priority: "mass_delete",
      surfaces: ["main", "renderer"],
      handoff: "ready",
    });
  });
});
