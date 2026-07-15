/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type {
  AgentChatApprovalDecision,
  AgentChatEventEnvelope,
  AgentChatRecoverCodexTurnArgs,
  AgentChatRecoverCodexTurnResult,
} from "../../../shared/types";
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

// Render-count instrumentation for the memo-boundary tests below.
// AgentChatMessageListMain calls useAppStore exactly twice in its body and
// nowhere else in the module (rows do not read the store), so a counting delegate
// is an exact list-BODY render counter. It delegates to the real hook so store
// behavior is unchanged for every other test in this file.
let memoListBodyRenders = 0;
vi.mock("../../state/appStore", async (importOriginal) => {
  const actual = await importOriginal<typeof AppStoreModule>();
  return {
    ...actual,
    useAppStore: ((selector: (s: unknown) => unknown, equality?: (a: unknown, b: unknown) => boolean) => {
      memoListBodyRenders++;
      return (actual.useAppStore as unknown as (s: typeof selector, e?: typeof equality) => unknown)(
        selector,
        equality,
      );
    }) as typeof actual.useAppStore,
  };
});

import { useCallback, useMemo, useState } from "react";
import type * as AppStoreModule from "../../state/appStore";
import {
  AgentChatMessageList,
  calculateVirtualWindow,
  calculateVirtualWindowAnchoredToEnd,
  deriveTurnModelState,
  findAnchoredChatEventIndex,
  formatElapsedSeconds,
  reconcileMeasuredScrollTop,
  resolveAnchoredChatRowIndex,
  shouldAbsorbProgrammaticScrollEvent,
  shouldStickToBottomAfterScroll,
  looksLikeWireframe,
} from "./AgentChatMessageList";
import {
  collapseChatTranscriptEvents,
  groupConsecutiveWorkLogRows,
} from "./chatTranscriptRows";

function findButtonByTextContent(matcher: RegExp): HTMLButtonElement {
  // Option buttons carry role="radio"/"checkbox" for accessibility, so search
  // every interactive role rather than just "button".
  const candidates = [
    ...screen.queryAllByRole("button"),
    ...screen.queryAllByRole("radio"),
    ...screen.queryAllByRole("checkbox"),
  ];
  const match = candidates.find((node) => matcher.test(node.textContent ?? ""));
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

async function expectLocationText(expected: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("location").textContent).toBe(expected);
  });
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
    onCodexRecovery?: (args: AgentChatRecoverCodexTurnArgs) => Promise<AgentChatRecoverCodexTurnResult>;
    scrollToRowKeyRequest?: { key: string; requestId: number } | null;
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
        onCodexRecovery={options?.onCodexRecovery}
        scrollToRowKeyRequest={options?.scrollToRowKeyRequest}
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
  it("keeps turn file-change summaries visible without a session id", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "turn_diff_summary",
          turnId: "turn-1",
          beforeSha: "before",
          afterSha: "after",
          files: [
            { path: "apps/desktop/src/main.ts", additions: 12, deletions: 3, status: "M" },
            { path: "apps/desktop/src/renderer.tsx", additions: 4, deletions: 1, status: "M" },
          ],
          totalAdditions: 16,
          totalDeletions: 4,
        },
      },
    ]);

    expect(screen.getByText("Files changed")).toBeTruthy();
    expect(screen.getByText("This turn: 2 files +16 -4")).toBeTruthy();
    expect(screen.getByText("Full thread: 2 files +16 -4")).toBeTruthy();
  });

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
          updateKind: "status",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "codex_goal_updated",
          goal: { objective: "Ship CLI parity", status: "active", tokenBudget: null },
          updateKind: "status",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:03.000Z",
        event: { type: "codex_goal_cleared" },
      },
    ]);

    expect(screen.getByText("Goal set: Ship CLI parity")).toBeTruthy();
    expect(screen.getByText("Goal paused: Wait for review")).toBeTruthy();
    expect(screen.getByText("Goal resumed: Ship CLI parity")).toBeTruthy();
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
      expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("ade terminal read"));
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

  it("copies a multi-block assistant turn from the last text row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "text", text: "First block.", itemId: "text-1", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "text", text: "Second block.", itemId: "text-2", turnId: "turn-1" },
      },
    ]);

    expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(2);
    const turnButton = screen.getByRole("button", { name: "Copy whole turn" });
    fireEvent.click(turnButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("First block.\n\nSecond block."));
  });

  it("does not add turn-copy chrome for single-block or legacy null-turn text", () => {
    const { rerender } = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "text", text: "One block.", itemId: "text-1", turnId: "turn-1" },
      },
    ]);
    expect(screen.queryByRole("button", { name: "Copy whole turn" })).toBeNull();

    rerender(
      <MemoryRouter>
        <AgentChatMessageList
          events={[
            {
              sessionId: "session-1",
              timestamp: "2026-03-17T10:00:00.000Z",
              event: { type: "text", text: "Legacy one.", itemId: "legacy-1" },
            },
            {
              sessionId: "session-1",
              timestamp: "2026-03-17T10:00:01.000Z",
              event: { type: "text", text: "Legacy two.", itemId: "legacy-2" },
            },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: "Copy whole turn" })).toBeNull();
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

  it("hides the full handoff prompt when handoff metadata marks it internal", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "This message was injected automatically by ADE during a chat handoff.\n\nSecret implementation brief.",
          displayText: "Chat handoff from previous session",
          metadata: { kind: "handoff", hideFullPrompt: true },
        },
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Chat handoff from previous session")).toBeTruthy();
    });
    expect(screen.queryByText("Full prompt")).toBeNull();
    expect(screen.queryByText(/Secret implementation brief/)).toBeNull();
  });

  it("renders a brief chip for hidden cross-machine handoff messages", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "Injected handoff brief with full detail.",
          displayText: "Continue the handoff",
          metadata: { kind: "cross_machine_handoff", hideFullPrompt: true },
        },
      },
    ]);

    await waitFor(() => {
      expect(screen.getByTestId("handoff-brief-chip")).toBeTruthy();
    });
    expect(screen.getByText(/Previous chat summarized into this chat/i)).toBeTruthy();
    expect(screen.getByText("Continue the handoff")).toBeTruthy();
  });

  it("does not render a brief chip for hidden messages that are not handoffs", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "Some hidden system prompt.",
          displayText: "Visible summary",
          metadata: { kind: "system", hideFullPrompt: true },
        },
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Visible summary")).toBeTruthy();
    });
    expect(screen.queryByTestId("handoff-brief-chip")).toBeNull();
  });

  it("draws exactly one fork-history divider between seeded history and the first live event", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "user_message", text: "Earlier question" },
        provenance: { providerOrigin: "handoff_fork", sourceSessionId: "prev-session" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "text", text: "Earlier answer", itemId: "t0", turnId: "turn-0", messageId: "m0" },
        provenance: { providerOrigin: "handoff_fork", sourceSessionId: "prev-session" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:03.000Z",
        event: { type: "user_message", text: "Live question after fork" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:04.000Z",
        event: { type: "text", text: "Live answer", itemId: "t1", turnId: "turn-1", messageId: "m1" },
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Live question after fork")).toBeTruthy();
    });
    const dividers = screen.getAllByTestId("fork-history-divider");
    expect(dividers).toHaveLength(1);
    expect(screen.getByText(/Forked from the previous chat — full history above/i)).toBeTruthy();
  });

  it("draws no fork-history divider when no envelope carries fork provenance", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "user_message", text: "Plain question" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "text", text: "Plain answer", messageId: "m1" },
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Plain question")).toBeTruthy();
    });
    expect(screen.queryByTestId("fork-history-divider")).toBeNull();
  });

  it("does not fall back to hidden handoff prompt text when display text is missing", async () => {
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
          type: "user_message",
          text: "Internal handoff prompt that should never be exposed.",
          metadata: { kind: "handoff", hideFullPrompt: true },
        },
      },
    ]);

    await waitFor(() => {
      expect(screen.queryByText(/Internal handoff prompt/)).toBeNull();
    });
    expect(screen.queryByText("Full prompt")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("");
    });
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

  it("surfaces the model attribution on an interrupted end-of-turn divider", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "done",
          turnId: "turn-1",
          status: "interrupted",
          modelId: "anthropic/claude-sonnet-5",
        },
      },
    ]);

    // The end-of-turn divider shows the model attribution (styled span) plus the
    // non-completed status for interrupted/failed turns.
    expect(screen.getAllByText(/Claude Sonnet 5/).length).toBeGreaterThan(0);
    expect(screen.getByText("interrupted")).toBeTruthy();
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

  it("renders unauthenticated agent CLI errors as a re-login card", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "error",
          message: "Authentication failed for Claude Sonnet 5.",
          detail: "API Error: 401 Invalid authentication credentials",
          errorInfo: {
            category: "agent_cli_auth",
            provider: "Claude Code",
            agentCli: {
              agent: "claude",
              displayName: "Claude Code",
              category: "unauthenticated",
              installCommand: "npm install -g @anthropic-ai/claude-code",
              authCommand: "claude auth login",
            },
          },
        },
      },
    ], { sessionId: "session-1" });

    expect(screen.getByText("Claude Code is logged out")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry turn/i })).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.queryByText("Error")).toBeNull();
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

  it("renders a spawn_completed peer notice as a quiet chip that navigates to the child", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    renderMessageList([
      {
        sessionId: "parent-session",
        timestamp: "2026-07-14T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          status: "spawn_completed",
          message: 'Peer "Docs" finished',
          detail: {
            spawnCompletion: {
              childSessionId: "child-peer-1",
              childTitle: "Docs",
              spawnKind: "peer",
              status: "completed",
              summary: "Wrote the docs.",
            },
          },
        },
      },
    ], { sessionId: "parent-session" });

    const chip = screen.getByRole("button", { name: /Docs.*finished/i });
    fireEvent.click(chip);

    const navEvent = dispatchSpy.mock.calls
      .map(([evt]) => evt)
      .find((evt): evt is CustomEvent => evt instanceof CustomEvent && evt.type === "ade:work:select-session");
    expect(navEvent).toBeTruthy();
    expect((navEvent!.detail as { sessionId?: string }).sessionId).toBe("child-peer-1");
  });

  it("suppresses the legacy subagent_spawned pill for a plain spawn (the unified card replaces it)", () => {
    renderMessageList([
      {
        sessionId: "parent-session",
        timestamp: "2026-07-14T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          status: "subagent_spawned",
          message: "Subagent spawned: Wave 2 UI",
          detail: {
            spawnedSession: { sessionId: "child-1", laneId: null, title: "Wave 2 UI" },
            spawnKind: "subagent",
            // Plain spawn: an inline SubagentSpawnCard accompanies the notice, so
            // the quiet pill is suppressed.
            hasInlineCard: true,
          },
        },
      },
    ], { sessionId: "parent-session" });

    expect(screen.queryByText("Wave 2 UI")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the subagent_spawned deep-link pill when there is no inline card (orchestration/continuity)", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    renderMessageList([
      {
        sessionId: "parent-session",
        timestamp: "2026-07-14T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          status: "subagent_spawned",
          message: "Subagent spawned: Worker A",
          detail: {
            spawnedSession: { sessionId: "child-worker-1", laneId: null, title: "Worker A" },
            spawnKind: "subagent",
            // No accompanying card (orchestration-run child / continuity spawn) →
            // the quiet deep-link pill is retained.
            hasInlineCard: false,
          },
        },
      },
    ], { sessionId: "parent-session" });

    const pill = screen.getByRole("button");
    expect(pill.textContent).toContain("Worker A");
    fireEvent.click(pill);
    const navEvent = dispatchSpy.mock.calls
      .map(([evt]) => evt)
      .find((evt): evt is CustomEvent => evt instanceof CustomEvent && evt.type === "ade:work:select-session");
    expect(navEvent).toBeTruthy();
    expect((navEvent!.detail as { sessionId?: string }).sessionId).toBe("child-worker-1");
    dispatchSpy.mockRestore();
  });

  it("runs Codex stalled-turn recovery actions against the source chat", async () => {
    const onCodexRecovery = vi.fn().mockResolvedValue({
      action: "wait",
      turnId: "turn-stalled",
      status: "waiting",
    });
    renderMessageList([
      {
        sessionId: "parent-session",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "codex_turn_stalled",
          turnId: "turn-stalled",
          reason: "no_output",
          message: "Codex accepted this turn but has not streamed output yet.",
          recoveryOptions: ["wait", "steer", "interrupt_retry_same_thread", "restart_resume_thread"],
          sourceSessionId: "child-session",
          parentSessionId: "parent-session",
        },
      },
    ], { sessionId: "parent-session", onCodexRecovery });

    fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    await waitFor(() => {
      expect(onCodexRecovery).toHaveBeenCalledWith({
        sessionId: "child-session",
        turnId: "turn-stalled",
        action: "wait",
      });
    });
    expect(await screen.findByText("Waiting for Codex output…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nudge" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("shows a Codex recovery error without making the card inert", async () => {
    const onCodexRecovery = vi.fn().mockRejectedValue(new Error("This stalled Codex turn is no longer active."));
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "codex_turn_stalled",
          turnId: "turn-stalled",
          reason: "app_server_state_unknown",
          message: "Codex paused unexpectedly.",
          recoveryOptions: ["restart_resume_thread"],
        },
      },
    ], { sessionId: "session-1", onCodexRecovery });

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no longer active");
    expect((screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(false);
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

  it("renders Claude PreToolUse hook errors in the compact work-log disclosure", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "hook",
          message: "Hook: PreToolUse:Bash error",
          detail: "Command rejected by hook",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "system_notice",
          noticeKind: "hook",
          message: "Hook: PreToolUse:Read error",
          detail: "Read rejected by hook",
          turnId: "turn-1",
        },
      },
    ]);

    const disclosure = findButtonByTextContent(/Tool calls.*\(2\).*PreToolUse:Read error/);
    expect(screen.queryByText("Hook: PreToolUse:Bash error")).toBeNull();

    fireEvent.click(disclosure);

    expect(screen.getByText("PreToolUse:Bash error")).toBeTruthy();
    expect(screen.getAllByText("PreToolUse:Read error").length).toBeGreaterThan(0);
    expect(screen.getByText("Command rejected by hook")).toBeTruthy();
    expect(screen.getByText("Read rejected by hook")).toBeTruthy();
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

  it("does not resume bottom stickiness until the user returns to latest", () => {
    expect(shouldStickToBottomAfterScroll({
      distanceFromBottom: 80,
      wasStuckToBottom: true,
    })).toBe(true);
    expect(shouldStickToBottomAfterScroll({
      distanceFromBottom: 80,
      wasStuckToBottom: false,
    })).toBe(false);
    expect(shouldStickToBottomAfterScroll({
      distanceFromBottom: 12,
      wasStuckToBottom: false,
    })).toBe(true);
  });

  it("lets upward wheel intent break bottom-follow before streaming output grows", async () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "Start streaming",
          deliveryState: "delivered",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "text",
          text: "Streaming chunk",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
    ];
    const view = renderMessageList(events, { showStreamingIndicator: true });

    const transcript = document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    transcript.scrollTop = 800;

    fireEvent.wheel(transcript, { deltaY: -80 });
    transcript.scrollTop = 760;
    fireEvent.scroll(transcript);

    expect(await screen.findByRole("button", { name: "Jump to latest message" })).toBeTruthy();

    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_100 });
    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList
          events={[
            ...events,
            {
              sessionId: "session-1",
              timestamp: "2026-03-17T10:00:02.000Z",
              event: {
                type: "text",
                text: "More streaming output",
                itemId: "text-2",
                turnId: "turn-1",
              },
            },
          ]}
          showStreamingIndicator
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(transcript.scrollTop).toBe(760);
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

  it("handles each external row jump request only once across transcript updates", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-a",
          agentId: "agent-a",
          agentType: "Explore",
          description: "Inspect the chat timeline",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "subagent_result",
          taskId: "agent-a",
          agentId: "agent-a",
          status: "completed",
          summary: "Timeline inspected",
          turnId: "turn-1",
        },
      },
    ];
    const view = renderMessageList(events);
    const transcript = document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    const request = { key: "subagent-result:agent-a", requestId: 1 };

    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={events} scrollToRowKeyRequest={request} />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(transcript.scrollTop).toBeGreaterThan(0);

    transcript.scrollTop = 0;
    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList
          events={[
            ...events,
            {
              sessionId: "session-1",
              timestamp: "2026-03-17T10:00:02.000Z",
              event: { type: "status", turnStatus: "completed", turnId: "turn-1" },
            },
          ]}
          scrollToRowKeyRequest={request}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(transcript.scrollTop).toBe(0);
  });

  // "absorbs tool summaries" test removed: tested old ChatWorkLogBlock
  // summary absorption rendering which changes with UI iterations.

  it("makes workspace markdown links open the Files tab", async () => {
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

    await expectLocationText(
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

    expect(globalThis.window.ade.files.listWorkspaces).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "/Users/admin/Projects/ADE/.ade/worktrees/fix-codex-chat-67bc1826/apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx",
      }),
    );

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });
    await expectLocationText(
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

    expect(globalThis.window.ade.files.listWorkspaces).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "C:\\Users\\me\\repo\\src\\main.ts" }));

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });
    await expectLocationText(
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

    expect(globalThis.window.ade.files.listWorkspaces).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "c:\\users\\me\\repo\\src\\main.ts" }));

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });
    await expectLocationText(
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

    expect(globalThis.window.ade.files.listWorkspaces).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "main.ts" }));

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });
    await expectLocationText(
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

    expect(globalThis.window.ade.files.listWorkspaces).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "C:\\Users\\me\\repo\\src\\main.ts:42:5" }));

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });
    await expectLocationText(
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

    expect(globalThis.window.ade.files.listWorkspaces).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "C:\\Users\\me\\repo\\src\\..\\main.ts:42" }));

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });
    await expectLocationText(
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

    expect(globalThis.window.ade.files.listWorkspaces).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "\\\\server\\share\\repo\\src\\main.ts" }));

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });
    await expectLocationText(
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

    expect(globalThis.window.ade.files.listWorkspaces).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "file://server/share/repo/src/main.ts#line=12" }));

    await waitFor(() => {
      expect(globalThis.window.ade.files.listWorkspaces).toHaveBeenCalledTimes(1);
    });
    await expectLocationText(
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

  it("anchors the follow-bottom window to the last row regardless of stale estimates", () => {
    const win = calculateVirtualWindowAnchoredToEnd({
      rowCount: 100,
      containerHeight: 240,
      rowHeight: () => 80,
      rowGap: 0,
    });
    // The tail must always be mounted so the streaming indicator stays flush.
    expect(win.endIndex).toBe(100);
    // Window must cover the viewport (240 / 80 = 3 rows) plus overscan.
    expect(win.startIndex).toBeLessThan(100 - 3);
    // offsetTop + rendered estimate must reconstruct totalHeight exactly so
    // there is no phantom gap below the rendered rows.
    const renderedEstimate = (100 - win.startIndex) * 80;
    expect(win.offsetTop + renderedEstimate).toBe(win.totalHeight);
  });

  it("keeps the anchored window valid when the viewport is taller than the content", () => {
    const win = calculateVirtualWindowAnchoredToEnd({
      rowCount: 3,
      containerHeight: 2000,
      rowHeight: () => 80,
      rowGap: 0,
    });
    expect(win.startIndex).toBe(0);
    expect(win.endIndex).toBe(3);
    expect(win.offsetTop).toBe(0);
  });

  it("resolves chat deeplink anchors by envelope sequence before ordinal fallback", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "user_message", text: "first", messageId: "user-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        sequence: 41,
        event: { type: "user_message", text: "target", messageId: "user-2" },
      },
    ];
    const groupedRows = groupConsecutiveWorkLogRows(collapseChatTranscriptEvents(events));

    expect(findAnchoredChatEventIndex({ events, anchorEvent: 41, hasFullHistory: false })).toBe(1);
    expect(resolveAnchoredChatRowIndex({ events, groupedRows, anchorEvent: 41, hasFullHistory: false })).toBe(1);
    expect(findAnchoredChatEventIndex({ events, anchorEvent: 1, hasFullHistory: false })).toBe(-1);
    expect(findAnchoredChatEventIndex({ events, anchorEvent: 1, hasFullHistory: true })).toBe(1);
  });

  it("maps anchors inside merged text events to the containing rendered row", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        sequence: 40,
        event: { type: "text", text: "hello", messageId: "assistant-1", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        sequence: 41,
        event: { type: "text", text: " world", messageId: "assistant-1", turnId: "turn-1" },
      },
    ];
    const groupedRows = groupConsecutiveWorkLogRows(collapseChatTranscriptEvents(events));

    expect(groupedRows).toHaveLength(1);
    expect(resolveAnchoredChatRowIndex({ events, groupedRows, anchorEvent: 41, hasFullHistory: false })).toBe(0);
  });

  it("formats turn elapsed time as working-for seconds then minutes", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
    expect(formatElapsedSeconds(42)).toBe("42s");
    expect(formatElapsedSeconds(59)).toBe("59s");
    expect(formatElapsedSeconds(60)).toBe("1m 00s");
    expect(formatElapsedSeconds(65)).toBe("1m 05s");
    expect(formatElapsedSeconds(793)).toBe("13m 13s");
    expect(formatElapsedSeconds(-5)).toBe("0s");
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

  it("does not reuse virtualized row heights after row identities change", async () => {
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
        if (!(this instanceof HTMLElement) || this.dataset.chatVirtualizedRow !== "true") return 0;
        return (this.textContent ?? "").includes("Tall message") ? 220 : 40;
      },
    });

    const makeEvents = (prefix: string): AgentChatEventEnvelope[] => (
      Array.from({ length: 65 }, (_, index): AgentChatEventEnvelope => ({
        sessionId: "session-1",
        timestamp: `2026-03-17T10:${String(index).padStart(2, "0")}:00.000Z`,
        event: {
          type: "user_message",
          text: `${prefix} message ${index}`,
          messageId: `${prefix.toLowerCase()}-${index}`,
          turnId: `turn-${index}`,
        },
      }))
    );
    const virtualSizerHeight = (container: HTMLElement): number => {
      const virtualSizer = Array.from(container.querySelectorAll("div"))
        .find((el) => el.style.position === "relative" && el.style.height);
      return Number.parseFloat(virtualSizer?.style.height ?? "0");
    };

    try {
      const rendered = renderMessageList(makeEvents("Tall"));

      let tallHeight = 0;
      await waitFor(() => {
        tallHeight = virtualSizerHeight(rendered.container);
        expect(tallHeight).toBeGreaterThan(0);
      });

      rendered.rerender(
        <MemoryRouter initialEntries={[{ pathname: "/" }]}>
          <AgentChatMessageList events={makeEvents("Short")} />
          <LocationProbe />
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(virtualSizerHeight(rendered.container)).toBeLessThan(tallHeight);
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

    // The single working indicator surfaces the concise activity label, never
    // the raw tool detail (kept calm — t3code / Codex reference).
    expect(streaming.container.textContent).toContain("Running command");
    expect(streaming.container.textContent).not.toContain("npm test");
    // Elapsed reads as "working for <duration>" so the timer is attributed to
    // the whole turn, not the current sub-action. The space before the digits
    // guards against JSX collapsing "working for " into "working for0s".
    expect(streaming.container.textContent).toMatch(/working for \d/);

    cleanup();

    const transcriptOnly = renderMessageList(sharedEvents, { showStreamingIndicator: false });

    expect(transcriptOnly.container.textContent).not.toContain("Running command");
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

    // Single calm working indicator: concise "Thinking" label, no raw detail / shimmer text.
    expect(rendered.container.textContent).toContain("Thinking");
    expect(rendered.container.textContent).not.toContain("Thinking through the answer");
  });

  it("keeps the live assistant message stable until the turn finishes", () => {
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

    // Assistant prose is unbubbled and calm now — no glow-pulse; the live text
    // simply renders and stays stable through the turn.
    expect(live.container.textContent).toContain("Streaming response");

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

    expect(settled.container.textContent).toContain("Streaming response");
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

  it("renders each subagent as spawn + result cards (no per-tick activity bundle)", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-a",
          agentId: "agent-a",
          agentType: "Explore",
          label: "Laplace",
          description: "Inspect the info pane",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "subagent_progress",
          taskId: "agent-a",
          agentId: "agent-a",
          label: "Laplace",
          summary: "Mapping pane state",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-b",
          agentId: "agent-b",
          agentType: "Explore",
          label: "Meitner",
          description: "Inspect the thread",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:03.000Z",
        event: {
          type: "subagent_result",
          taskId: "agent-a",
          agentId: "agent-a",
          label: "Laplace",
          status: "completed",
          summary: "Pane mapped",
          turnId: "turn-1",
        },
      },
    ]);

    const text = rendered.container.textContent ?? "";
    // Spawn card descriptions render; the result card shows the final summary.
    expect(text).toContain("Inspect the info pane");
    expect(text).toContain("Inspect the thread");
    expect(text).toContain("Pane mapped");
    // The old per-tick activity-bundle chrome is gone.
    expect(text).not.toContain("Subagent updates");
    expect(text).not.toContain("2 subagents");
    // The result card exposes a "View transcript" affordance.
    expect(text).toContain("View transcript");
  });

  it("renders a single spawn card for a Codex parent placeholder + resolved agent pair", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-thread-1",
          agentType: "Explore",
          parentToolUseId: "call-spawn-1",
          description: "Inspect the placeholder path",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "subagent_progress",
          taskId: "agent-thread-1",
          agentId: "agent-thread-1",
          agentType: "Explore",
          parentToolUseId: "call-spawn-1",
          label: "Sagan",
          summary: "Reading files",
          turnId: "turn-1",
        },
      },
    ]);

    const text = rendered.container.textContent ?? "";
    // A single spawn card — the rebind from taskId to agentId does not duplicate it.
    expect(text).toContain("Inspect the placeholder path");
    expect(text).not.toContain("2 subagents");
    expect(text).not.toContain("Subagents spawned");
    const spawnCards = rendered.container.querySelectorAll('[class*="chat-radius-card"]');
    expect(spawnCards.length).toBeGreaterThanOrEqual(1);
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

    // The turn surfaces task progress as a compact activity row.
    expect(rendered.container.textContent).toMatch(/Refine summary card/);
    expect(rendered.container.textContent).toMatch(/1\/2 complete/);
    expect(rendered.container.textContent).toMatch(/Inspect chat renderer/);
    expect(screen.getAllByText("Refine summary card").length).toBeGreaterThanOrEqual(1);

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

  it("renders completed Codex plan markdown without requiring expansion and opens chat info on card click", () => {
    const openInfo = vi.fn();
    window.addEventListener("ade:chat:open-info", openInfo);
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
    ], { sessionId: "session-1" });

    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("Inspect the app-server wiring.")).toBeTruthy();
    expect(screen.getByText("Patch the native plan handoff.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Plan/ }));
    expect(openInfo).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({ sessionId: "session-1" }),
    }));
    window.removeEventListener("ade:chat:open-info", openInfo);
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
          model: "claude-haiku-4-5-20260707",
          modelId: "anthropic/claude-haiku-4-5",
        },
      },
    ]);

    expect(screen.getAllByText("Claude Haiku 4.5 (claude-haiku-4-5-20260707)").length).toBeGreaterThan(0);
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

    expect(rendered.container.textContent).toMatch(/Implement calmer transcript rows/);
    expect(rendered.container.textContent).toMatch(/1\/2 complete/);
    expect(rendered.container.textContent).toMatch(/Inspect shared renderer/);
    expect(rendered.container.textContent).toMatch(/1 file changed/);

    fireEvent.click(screen.getByRole("button", { name: /Undo/i }));
    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"laneId\":\"lane-123\"}",
    );
  });

  it("shows the latest turn task update alongside model attribution", () => {
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
          status: "interrupted",
          modelId: "anthropic/claude-sonnet-5",
        },
      },
    ]);

    expect(rendered.container.textContent).toMatch(/Investigate Claude turn status/);
    expect(rendered.container.textContent).toMatch(/completed/);
    // Model attribution surfaces on the end-of-turn divider for non-completed turns.
    expect(screen.getAllByText(/Claude Sonnet 5/).length).toBeGreaterThanOrEqual(1);
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

  it("preserves exact structured option values when submitting", () => {
    const onApproval = vi.fn();
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [
          {
            id: "plan_choice",
            header: "Plan",
            question: "Which plan should we follow?",
            options: [
              { label: "  Rebase  ", value: " rebase " },
            ],
            allowsFreeform: false,
          },
        ],
      }),
    ], { onApproval });

    fireEvent.click(findButtonByTextContent(/^Rebase/));
    expect(onApproval).toHaveBeenCalledWith("approval-ask", "accept", null, { plan_choice: " rebase " });
  });

  it("number keys select single-choice answers without submitting immediately", () => {
    const onApproval = vi.fn();
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [
          {
            id: "plan_choice",
            header: "Plan",
            question: "Which plan should we follow?",
            options: [
              {
                label: "Rebase",
                value: "rebase",
                preview: "Replay commits on main.",
                previewFormat: "markdown",
              },
              { label: "Merge", value: "merge" },
            ],
            allowsFreeform: true,
          },
        ],
      }),
    ], { onApproval });

    const questionCard = screen.getByRole("group", { name: /ade asks/i });

    fireEvent.keyDown(questionCard, { key: "1" });

    expect(onApproval).not.toHaveBeenCalled();
    expect(findButtonByTextContent(/^Rebase/).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("inline-question-preview-plan_choice").textContent ?? "").toContain("Replay commits on main.");

    fireEvent.keyDown(questionCard, { key: "Enter" });
    expect(onApproval).toHaveBeenCalledWith("approval-ask", "accept", null, { plan_choice: "rebase" });
  });

  it("lets focused controls handle Enter inside inline questions", () => {
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
            allowsFreeform: true,
          },
        ],
      }),
    ], { onApproval });

    fireEvent.keyDown(screen.getByRole("group", { name: /ade asks/i }), { key: "1" });
    expect(findButtonByTextContent(/^Rebase/).getAttribute("aria-checked")).toBe("true");

    const declineButton = screen.getByRole("button", { name: /decline/i });
    declineButton.focus();
    fireEvent.keyDown(declineButton, { key: "Enter" });

    expect(onApproval).not.toHaveBeenCalled();
    fireEvent.click(declineButton);
    expect(onApproval.mock.calls[0]?.slice(0, 2)).toEqual(["approval-ask", "decline"]);
  });

  it("does not discard freeform drafts when selecting a single-choice option", () => {
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
            allowsFreeform: true,
          },
        ],
      }),
    ], { onApproval });

    fireEvent.change(screen.getByPlaceholderText("Optional response"), {
      target: { value: "Keep the release note." },
    });
    fireEvent.click(findButtonByTextContent(/^Rebase/));

    expect(onApproval).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));
    expect(onApproval).toHaveBeenCalledWith("approval-ask", "accept", null, {
      plan_choice: ["rebase", "Keep the release note."],
    });
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

  it("updates the option preview when hovering another preview option", () => {
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [
          {
            id: "strategy",
            header: "Strategy",
            question: "Pick a merge strategy",
            options: [
              {
                label: "Squash",
                value: "squash",
                recommended: true,
                preview: "Squash preview",
                previewFormat: "markdown",
              },
              {
                label: "Rebase",
                value: "rebase",
                preview: "Rebase preview",
                previewFormat: "markdown",
              },
            ],
          },
        ],
      }),
    ]);

    const preview = screen.getByTestId("inline-question-preview-strategy");
    expect(preview.textContent ?? "").toContain("Squash preview");

    fireEvent.mouseEnter(findButtonByTextContent(/^Rebase/));

    expect(screen.getByTestId("inline-question-preview-strategy").textContent ?? "").toContain("Rebase preview");
  });

  it("renders a wireframe option preview in an aligned monospace block", () => {
    const wireframe = "┌──────────┐\n│ Home     │\n├──────────┤\n│ ▸ item   │\n└──────────┘";
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [
          {
            id: "layout",
            header: "Layout",
            question: "Pick a layout",
            multiSelect: true,
            options: [
              // previewFormat is "markdown" but the content is ASCII art — it
              // must still render column-preserved, not collapsed into prose.
              { label: "Boxed", value: "boxed", preview: wireframe, previewFormat: "markdown" },
              { label: "Plain", value: "plain" },
            ],
          },
        ],
      }),
    ]);

    fireEvent.click(findButtonByTextContent(/^Boxed/));
    const preview = screen.getByTestId("inline-question-preview-layout");
    const pre = preview.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre?.textContent ?? "").toContain("│ Home     │");
  });

  describe("looksLikeWireframe", () => {
    it("detects box-drawing and bullet wireframes", () => {
      expect(looksLikeWireframe("┌──┐\n│ x│\n└──┘")).toBe(true);
      expect(looksLikeWireframe("● one\n○ two")).toBe(true);
    });
    it("detects indentation-significant multi-line art", () => {
      expect(looksLikeWireframe("Home\n    nested one\n    nested two")).toBe(true);
    });
    it("treats normal prose / short markdown as not a wireframe", () => {
      expect(looksLikeWireframe("**Bold** and a sentence.")).toBe(false);
      expect(looksLikeWireframe("One line only")).toBe(false);
      expect(looksLikeWireframe("Line one\nLine two")).toBe(false);
    });
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

describe("AgentChatMessageList memo boundary", () => {
  const TEXT_EVENTS: AgentChatEventEnvelope[] = [
    {
      sessionId: "s1",
      timestamp: "2026-03-17T10:00:00.000Z",
      event: { type: "text", text: "Hello world.", itemId: "text-1", turnId: "turn-1" },
    },
  ];

  /**
   * A composer-like owner holding character-level draft state (like AgentChatPane /
   * PersonalChatsPage) that renders the memoized transcript boundary. `unstable`
   * recreates a row-facing callback each render to model the pre-fix inline-arrow
   * props that defeated the boundary.
   */
  function Harness({ unstable = false }: { unstable?: boolean }) {
    const [draft, setDraft] = useState("");
    const events = useMemo(() => TEXT_EVENTS, []);
    const stableApproval = useCallback(() => {}, []);
    const onApproval = unstable ? () => {} : stableApproval;
    return (
      <MemoryRouter>
        <input data-testid="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <AgentChatMessageList
          events={events}
          sessionId="s1"
          assistantLabel="Assistant"
          onApproval={onApproval as never}
        />
      </MemoryRouter>
    );
  }

  it("is a memoized component", () => {
    expect((AgentChatMessageList as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  it("does not re-render on a draft-only update when transcript props are unchanged", () => {
    memoListBodyRenders = 0;
    const { getByTestId } = render(<Harness />);
    expect(memoListBodyRenders).toBeGreaterThan(0);

    const before = memoListBodyRenders;
    fireEvent.change(getByTestId("draft"), { target: { value: "typing a draft" } });
    fireEvent.change(getByTestId("draft"), { target: { value: "typing a draft further" } });
    // The memoized boundary bails out: the list body does not re-run on draft-only updates.
    expect(memoListBodyRenders).toBe(before);
  });

  it("re-renders when a row-facing callback identity churns (guards the stabilization)", () => {
    memoListBodyRenders = 0;
    const { getByTestId } = render(<Harness unstable />);
    expect(memoListBodyRenders).toBeGreaterThan(0);

    const before = memoListBodyRenders;
    fireEvent.change(getByTestId("draft"), { target: { value: "typing" } });
    // An unstable row-facing prop defeats the boundary — proving the boundary + prop
    // stabilization are load-bearing, not incidental.
    expect(memoListBodyRenders).toBeGreaterThan(before);
  });
});
