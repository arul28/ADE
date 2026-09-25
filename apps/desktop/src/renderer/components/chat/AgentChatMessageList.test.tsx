/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type {
  AgentChatApprovalDecision,
  AgentChatEventEnvelope,
  AgentChatRecoverCodexTurnArgs,
  AgentChatRecoverCodexTurnResult,
  ComputerUseArtifactView,
} from "../../../shared/types";
import * as modelRegistry from "../../../shared/modelRegistry";
import {
  resetTextRevealHorizonCacheForTests,
  TEXT_REVEAL_HORIZON_STORAGE_KEY,
} from "./textReveal";
import { setPerfActive } from "../../perf/markers";
import { ADE_NAVIGATE_TARGET_EVENT } from "../../lib/openExternal";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    GithubCopilot: brand(),
    Qwen: brand(),
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
  deriveTranscriptToolActivity,
  deriveTurnModelState,
  estimateTranscriptRowHeight,
  findAnchoredChatEventIndex,
  formatElapsedSeconds,
  ChatInfoHostContext,
  getTranscriptCollapseCacheKeysForTests,
  reconcileMeasuredScrollTop,
  resetTranscriptCollapseCacheForTests,
  resetTurnFoldMemoryForTests,
  resolveAnchoredChatRowIndex,
  resolveOlderHistoryPrefetchTriggerPx,
  resolveWorkingIndicatorLabel,
  sameKeyList,
  sameMapContents,
  sameSetContents,
  shouldAbsorbProgrammaticScrollEvent,
  stabilizeTranscriptToolActivity,
  shouldKeepPinnedThroughViewportShrink,
  shouldStickToBottomAfterScroll,
} from "./AgentChatMessageList";
import { looksLikeWireframe } from "./questionOptionPreview";
import { resetChatTaskListCardStateForTests } from "./ChatTaskListCard";
import {
  buildTranscriptEventRowKeys,
  collapseChatTranscriptEvents,
  groupChatTranscriptRows,
  groupConsecutiveWorkLogRows,
} from "./chatTranscriptRows";
import { promptHistoryEventKey } from "./chatPromptHistory";
import { resetFilesWorkspaceCacheForTests } from "./chatWorkspacePaths";
import { rememberCallStill, resetSceneStillsForTest } from "./sceneStillStore";
import { stubSceneCaptureBridge } from "./sceneStillTestHarness";
import { mixedIdToolActivityBoundaryEvents } from "../../../shared/testFixtures/chatToolActivity";
import { setPendingSessionAnchor, takePendingSessionAnchor } from "../terminals/pendingSessionAnchors";
import { CHAT_TIMELINE_ROW_GAP_PX } from "./chatUserMinimap.logic";

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
    sessionEnded?: boolean;
    sessionId?: string | null;
    scrollMemoryKey?: string | null;
    transcriptCollapseCacheKey?: string | null;
    laneId?: string | null;
    onInsertDraft?: (text: string) => void;
    onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
    onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => void;
    onCodexRecovery?: (args: AgentChatRecoverCodexTurnArgs) => Promise<AgentChatRecoverCodexTurnResult>;
    onRunUnprocessedMessage?: (event: Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>) => void | Promise<void>;
    onRestoreCancelledQueue?: (recoveryId: string) => Promise<boolean>;
    scrollToRowKeyRequest?: { key: string; requestId: number } | null;
    scrollToPromptHistoryRequest?: { eventKey: string; requestId: number } | null;
    hasOlderHistory?: boolean;
    loadingOlderHistory?: boolean;
    olderHistoryError?: string | null;
    onLoadOlderHistory?: () => void;
    onRetryOlderHistory?: () => void;
    onReturnToLatest?: () => void;
    proofArtifacts?: ComputerUseArtifactView[];
    allowLocalProofArtifactProtocol?: boolean;
    onOpenProofDrawer?: () => void;
    onOpenTurnSources?: (turnId: string) => void;
    usageLimitResumeActive?: boolean;
    usageLimitResumeTurnId?: string | null;
    sessionProvider?: string | null;
    resolveSpawnedChatProvider?: (sessionId: string) => string | null;
  },
) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/", state: options?.initialState }]}>
      <AgentChatMessageList
        events={events}
        usageLimitResumeActive={options?.usageLimitResumeActive}
        usageLimitResumeTurnId={options?.usageLimitResumeTurnId}
        assistantLabel={options?.assistantLabel}
        showStreamingIndicator={options?.showStreamingIndicator}
        sessionEnded={options?.sessionEnded}
        sessionId={options?.sessionId}
        sessionProvider={options?.sessionProvider}
        resolveSpawnedChatProvider={options?.resolveSpawnedChatProvider}
        scrollMemoryKey={options?.scrollMemoryKey}
        transcriptCollapseCacheKey={options?.transcriptCollapseCacheKey}
        laneId={options?.laneId}
        onInsertDraft={options?.onInsertDraft}
        onRevealChatTerminal={options?.onRevealChatTerminal}
        onApproval={options?.onApproval as any}
        onCodexRecovery={options?.onCodexRecovery}
        onRunUnprocessedMessage={options?.onRunUnprocessedMessage}
        onRestoreCancelledQueue={options?.onRestoreCancelledQueue}
        scrollToRowKeyRequest={options?.scrollToRowKeyRequest}
        scrollToPromptHistoryRequest={options?.scrollToPromptHistoryRequest}
        hasOlderHistory={options?.hasOlderHistory}
        loadingOlderHistory={options?.loadingOlderHistory}
        olderHistoryError={options?.olderHistoryError}
        onLoadOlderHistory={options?.onLoadOlderHistory}
        onRetryOlderHistory={options?.onRetryOlderHistory}
        onReturnToLatest={options?.onReturnToLatest}
        proofArtifacts={options?.proofArtifacts}
        allowLocalProofArtifactProtocol={options?.allowLocalProofArtifactProtocol}
        onOpenProofDrawer={options?.onOpenProofDrawer}
        onOpenTurnSources={options?.onOpenTurnSources}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const transcriptProofArtifact: ComputerUseArtifactView = {
  id: "proof-only",
  kind: "console_logs",
  backendStyle: "manual",
  backendName: "ade-cli",
  sourceToolName: "attach",
  originalType: "log",
  title: "Focused tests passed",
  description: "381 focused tests passed.",
  uri: ".ade/artifacts/proof.log",
  storageKind: "file",
  mimeType: "text/plain",
  metadata: {},
  createdAt: "2026-07-28T12:00:00.000Z",
  links: [],
  reviewState: "pending",
  workflowState: "evidence_only",
  reviewNote: null,
};

function makeRect(box: { top?: number; left?: number; width?: number; height?: number }): DOMRect {
  const top = box.top ?? 0;
  const left = box.left ?? 0;
  const width = box.width ?? 0;
  const height = box.height ?? 0;
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * jsdom has no layout, so every box measures 0×0: the minimap rail decides it
 * is inert and `resolveMinimapIndexFromPointer` returns null for every pointer
 * Y. Stub the two boxes the rail actually reads — the list root and its own
 * hit strip.
 */
function stubMinimapLayout(options?: {
  listWidth?: number;
  listHeight?: number;
  railTop?: number;
  railHeight?: number;
}): { railTop: number; railHeight: number } {
  const listWidth = options?.listWidth ?? 960;
  const listHeight = options?.listHeight ?? 600;
  const railTop = options?.railTop ?? 100;
  const railHeight = options?.railHeight ?? 400;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-chat-message-list-root")) {
      return makeRect({ width: listWidth, height: listHeight });
    }
    if (this.tagName === "BUTTON" && this.closest("[data-testid='chat-user-minimap']")) {
      return makeRect({ top: railTop, height: railHeight, width: 24 });
    }
    return makeRect({});
  });
  return { railTop, railHeight };
}

function minimapRail(): HTMLButtonElement {
  const rail = screen.getByTestId("chat-user-minimap").querySelector("button");
  if (!rail) throw new Error("minimap rail button is not rendered");
  return rail as HTMLButtonElement;
}

/**
 * The scroll container reports 0 for both metrics in jsdom, and scroll restore
 * is gated on a non-zero container height measured at MOUNT — too early to
 * stub the node itself. Patch the prototype getters for the timeline pane only.
 */
function stubTimelineScrollBox(values: { clientHeight: number; scrollHeight: number }): () => void {
  const originals: Array<[string, PropertyDescriptor]> = [];
  for (const [prop, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    if (!descriptor) continue;
    originals.push([prop, descriptor]);
    Object.defineProperty(Element.prototype, prop, {
      configurable: true,
      get(this: Element) {
        return this.classList.contains("ade-chat-timeline-pane") ? value : 0;
      },
    });
  }
  return () => {
    for (const [prop, descriptor] of originals) Object.defineProperty(Element.prototype, prop, descriptor);
  };
}

function timelinePane(): HTMLDivElement {
  return document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function userMessageEvents(texts: string[], sessionId = "session-1"): AgentChatEventEnvelope[] {
  return texts.map((text, index) => ({
    sessionId,
    timestamp: `2026-03-17T10:00:${String(index).padStart(2, "0")}.000Z`,
    event: { type: "user_message", text, deliveryState: "delivered" },
  }));
}

/** Two user turns, each with a reply — the minimum the rail renders for. */
const MINIMAP_TRANSCRIPT: AgentChatEventEnvelope[] = [
  {
    sessionId: "session-1",
    timestamp: "2026-03-17T10:00:00.000Z",
    event: { type: "user_message", text: "First checkpoint", deliveryState: "delivered" },
  },
  {
    sessionId: "session-1",
    timestamp: "2026-03-17T10:00:01.000Z",
    event: { type: "text", text: "Acknowledged.", itemId: "text-1", turnId: "turn-1" },
  },
  {
    sessionId: "session-1",
    timestamp: "2026-03-17T10:00:02.000Z",
    event: { type: "user_message", text: "Second checkpoint", deliveryState: "delivered" },
  },
  {
    sessionId: "session-1",
    timestamp: "2026-03-17T10:00:03.000Z",
    event: { type: "text", text: "Shipped it.", itemId: "text-2", turnId: "turn-2" },
  },
];

const originalAde = globalThis.window.ade;

beforeEach(() => {
  resetTranscriptCollapseCacheForTests();
  // Workspace roots are cached per module so several chat surfaces share one
  // IPC read; clear it so each test starts from its own listWorkspaces mock.
  resetFilesWorkspaceCacheForTests();
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
  resetChatTaskListCardStateForTests();
  if (originalAde === undefined) {
    delete (globalThis.window as any).ade;
  } else {
    globalThis.window.ade = originalAde;
  }
});

describe("AgentChatMessageList board moves", () => {
  it("renders a board move as a divider with the sent text under it, not as a user bubble", () => {
    // The user dragged a card; they did not type this sentence. Rendering it as
    // a user bubble would put ADE's words in their mouth, and the transcript
    // would read as if they had asked for something they never asked for.
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "You moved this chat from Done to Working. Continue the work, or ask me what you need if the next step is unclear.",
          deliveryState: "delivered",
          metadata: {
            boardMove: {
              from: "done",
              to: "working",
              at: "2026-03-17T10:00:00.000Z",
              moveId: "move-1",
            },
          },
        },
      },
    ]);

    const divider = document.querySelector('[data-board-move-to="working"]');
    expect(divider).toBeTruthy();
    expect(divider?.textContent).toContain("Moved on the board");
    expect(divider?.textContent).toContain("Done");
    expect(divider?.textContent).toContain("Working");
    // The exact text the agent received is folded under it, so the transcript
    // shows what the agent was actually told.
    expect(divider?.textContent).toContain("Continue the work, or ask me what you need");
    // And it is NOT a user bubble.
    expect(document.querySelector(".ade-chat-message-card-user")).toBeNull();
  });

  it("labels a move into Needs you with the column the user sees", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "The user parked this for their input. Stop, summarize where you are, and list what you need from them.",
          deliveryState: "delivered",
          metadata: {
            boardMove: {
              from: "working",
              to: "needs_you",
              at: "2026-03-17T10:00:00.000Z",
              moveId: "move-2",
            },
          },
        },
      },
    ]);
    const divider = document.querySelector('[data-board-move-to="needs_you"]');
    expect(divider?.textContent).toContain("Working → Needs you");
  });
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
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^Show .+ from this turn$/ }));
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
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^Show .+ from this turn$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open lane" }));

    expect(screen.getByTestId("location").textContent).toBe("/lanes?laneId=lane-1::null");
  });

});

describe("AgentChatMessageList transcript rendering", () => {
  it("shows a launch message the host could not deliver as failed-to-send, with the reason on hover", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "Also check the logout",
          messageId: "launch-queued:q1",
          deliveryState: "failed",
          metadata: { launchDeliveryError: "Session is busy." },
        },
      },
    ]);

    const status = screen.getByTestId("user-message-status");
    expect(status.textContent).toBe("Couldn't send — retrying");
    expect(status.getAttribute("data-status-kind")).toBe("launch_retrying");
    expect(screen.getByText("Couldn't send — retrying").getAttribute("title")).toBe("Session is busy.");
  });

  describe("user message status line", () => {
    const userMessage = (
      overrides: Partial<Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>>,
    ): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: "2026-03-17T10:00:00.000Z",
      event: { type: "user_message", text: "what's happening?", turnId: "turn-1", ...overrides },
    });
    const bubbleOf = (container: HTMLElement): HTMLElement => {
      const bubble = container.querySelector<HTMLElement>(".ade-chat-message-card-user");
      expect(bubble).toBeTruthy();
      return bubble!;
    };

    it.each([
      ["inline", { steerId: "s-1", deliveryState: "inline" }, "steered", "Steered"],
      ["Codex accepted", { steerId: "s-1", deliveryState: "accepted" }, "steering", "Steering…"],
      ["Codex processed", { steerId: "s-1", deliveryState: "processed", processed: true }, "steered", "Steered"],
      ["legacy processed flag", { steerId: "s-1", processed: true }, "steered", "Steered"],
      ["queued steer sent at the turn boundary", { steerId: "s-1", deliveryState: "delivered" }, "sent_after_turn", "Sent after turn"],
      ["failed steer", { steerId: "s-1", deliveryState: "failed" }, "steer_failed", "Steer failed"],
      ["failed send", { deliveryState: "failed" }, "send_failed", "Couldn't send"],
    ] as const)("%s draws its label under the bubble, never a pill inside it", (_name, overrides, kind, label) => {
      const { container } = renderMessageList([userMessage(overrides)]);
      const status = screen.getByTestId("user-message-status");
      expect(status.getAttribute("data-status-kind")).toBe(kind);
      expect(status.textContent).toBe(label);
      expect(status.querySelector("svg")).toBeTruthy();
      const bubble = bubbleOf(container);
      expect(bubble.contains(status)).toBe(false);
      expect(bubble.textContent).not.toMatch(/accepted during turn|accepted · waiting|processed/);
      expect(screen.queryByTestId("user-message-delivery-chip")).toBeNull();
      // The bubble and its status line share one row, bubble first.
      expect(bubble.parentElement).toBe(screen.getByTestId("user-message-status-row").parentElement);
      expect(bubble.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps the hover actions inside the bubble and the status line outside it", () => {
      const { container } = renderMessageList([userMessage({ steerId: "s-1", deliveryState: "inline" })]);
      const bubble = bubbleOf(container);
      const copy = within(bubble).getByRole("button", { name: /copy/i });
      const status = screen.getByTestId("user-message-status");
      // Hover actions are absolutely positioned inside the bubble; the status
      // line is a sibling of the bubble, so the two can never overlap.
      expect(copy.closest(".absolute")?.parentElement).toBe(bubble);
      expect(status.closest(".ade-chat-message-card-user")).toBeNull();
    });

    it("draws no status line for plain, optimistic-queued, or spawn-prompt messages", () => {
      renderMessageList([
        userMessage({}),
        { ...userMessage({ deliveryState: "queued" }), timestamp: "2026-03-17T10:00:01.000Z" },
        { ...userMessage({ deliveryState: "delivered", processed: true, messageId: "subagent:a:spawn-prompt" }), timestamp: "2026-03-17T10:00:02.000Z" },
      ]);
      expect(screen.queryByTestId("user-message-status")).toBeNull();
    });

    it("updates the label in place as a Codex steer moves from accepted to processed", () => {
      const accepted = userMessage({ steerId: "s-1", deliveryState: "accepted" });
      const processed: AgentChatEventEnvelope = {
        ...userMessage({ steerId: "s-1", deliveryState: "processed", processed: true }),
        timestamp: "2026-03-17T10:00:03.000Z",
      };
      const { container, rerender } = renderMessageList([accepted]);
      const rowKey = container.querySelector("[data-chat-row-key]")?.getAttribute("data-chat-row-key");
      expect(screen.getByTestId("user-message-status").textContent).toBe("Steering…");
      rerender(
        <MemoryRouter>
          <AgentChatMessageList events={[accepted, processed]} />
        </MemoryRouter>,
      );
      expect(screen.getAllByTestId("user-message-status")).toHaveLength(1);
      expect(screen.getByTestId("user-message-status").textContent).toBe("Steered");
      expect(container.querySelector("[data-chat-row-key]")?.getAttribute("data-chat-row-key")).toBe(rowKey);
    });

    it("budgets the status line in the unmeasured row estimate", () => {
      const row = (event: AgentChatEventEnvelope["event"]) => ({
        key: "k",
        timestamp: "2026-09-23T00:00:00.000Z",
        event,
      }) as Parameters<typeof estimateTranscriptRowHeight>[0];
      const plain = estimateTranscriptRowHeight(row({ type: "user_message", text: "hi" }), 720);
      const steered = estimateTranscriptRowHeight(row({ type: "user_message", text: "hi", steerId: "s", deliveryState: "inline" }), 720);
      expect(steered - plain).toBe(20);
    });
  });

  // Proof used to be appended after every row as a permanently open thread
  // footer. With no transcript rows it is now a compact chronological capture
  // row that starts collapsed.
  it("renders proof attached to an empty chat as a collapsed capture row", () => {
    const rendered = renderMessageList([], { proofArtifacts: [transcriptProofArtifact] });

    expect(screen.queryByText("Proof collected in this chat")).toBeNull();
    expect(rendered.container.querySelector("[data-chat-proof-timeline]")).toBeNull();
    expect(screen.getByRole("button", { name: /Proof added/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("chips proof onto the turn rule of the turn that captured it", () => {
    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: { type: "user_message", text: "Capture proof.", turnId: "turn-1" },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:02:00.000Z",
          event: { type: "done", turnId: "turn-1", status: "completed" },
        },
      ],
      { proofArtifacts: [{ ...transcriptProofArtifact, createdAt: "2026-03-17T10:01:00.000Z" }] },
    );

    expect(screen.getByRole("button", { name: /1 proof/ })).toBeTruthy();
  });

  it("does not attribute proof older than the loaded transcript page to its first visible turn", () => {
    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: { type: "user_message", text: "Capture current proof.", turnId: "turn-visible" },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:02:00.000Z",
          event: { type: "done", turnId: "turn-visible", status: "completed" },
        },
      ],
      {
        hasOlderHistory: true,
        proofArtifacts: [
          { ...transcriptProofArtifact, id: "proof-older-page", createdAt: "2026-03-17T09:30:00.000Z" },
          { ...transcriptProofArtifact, id: "proof-visible-turn", createdAt: "2026-03-17T10:01:00.000Z" },
        ],
      },
    );

    expect(screen.getByRole("button", { name: /1 proof/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /2 proof/ })).toBeNull();
  });

  it("keeps proof captured after the latest done event visible at the transcript tail", () => {
    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: { type: "user_message", text: "Finish first.", turnId: "turn-1" },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:01:00.000Z",
          event: { type: "done", turnId: "turn-1", status: "completed" },
        },
      ],
      { proofArtifacts: [{ ...transcriptProofArtifact, createdAt: "2026-03-17T10:02:00.000Z" }] },
    );

    expect(screen.queryByRole("button", { name: /1 proof/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Proof added/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps idle proof before a later turn and never attributes it to that turn", () => {
    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: { type: "user_message", text: "First turn.", turnId: "turn-1" },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:01:00.000Z",
          event: { type: "done", turnId: "turn-1", status: "completed" },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:03:00.000Z",
          event: { type: "user_message", text: "Later turn.", turnId: "turn-2" },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:04:00.000Z",
          event: { type: "done", turnId: "turn-2", status: "completed" },
        },
      ],
      { proofArtifacts: [{ ...transcriptProofArtifact, createdAt: "2026-03-17T10:02:00.000Z" }] },
    );

    const proof = screen.getByRole("button", { name: /Proof added/ });
    const laterTurn = screen.getByText("Later turn.");
    expect(proof.compareDocumentPosition(laterTurn) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.queryByRole("button", { name: /1 proof/ })).toBeNull();
  });

  it("does not render trailing proof from outside the loaded history window", () => {
    renderMessageList([], {
      hasOlderHistory: true,
      proofArtifacts: [transcriptProofArtifact],
    });

    expect(screen.queryByRole("button", { name: /Proof added/ })).toBeNull();
  });

  it("renders broken timeline proof as an amber missing state", () => {
    renderMessageList(
      [{
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      }],
      {
        proofArtifacts: [{
          ...transcriptProofArtifact,
          availability: "missing_file",
          createdAt: "2026-03-17T10:00:00.000Z",
        }],
      },
    );

    fireEvent.click(screen.getByRole("button", { name: /1 proof/ }));
    expect(screen.getByText("Missing proof")).toBeTruthy();
    expect(document.querySelector('[data-chat-proof-broken="true"]')).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("resolves proof thumbnails in the non-virtualized transcript path", () => {
    renderMessageList(
      [{
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      }],
      {
        allowLocalProofArtifactProtocol: true,
        proofArtifacts: [{
          ...transcriptProofArtifact,
          kind: "screenshot",
          mimeType: "image/png",
          uri: ".ade/artifacts/proof.png",
          createdAt: "2026-03-17T10:00:00.000Z",
        }],
      },
    );

    fireEvent.click(screen.getByRole("button", { name: /1 proof/ }));
    expect(screen.getByRole("img", { name: transcriptProofArtifact.title }).getAttribute("src"))
      .toBe("ade-artifact://project/.ade/artifacts/proof.png");
  });

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

  it("suppresses automatic context-usage snapshots but renders the /context command card", () => {
    const usage = {
      categories: [
        { name: "Input", tokens: 2, percentage: 0 },
        { name: "Cache read", tokens: 96_500, percentage: 48 },
        { name: "Output", tokens: 5, percentage: 0 },
      ],
      totalTokens: 96_507,
      maxTokens: 1_000_000,
      percentage: 9.7,
      model: "claude-opus-4-8",
    };
    const { rerender } = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "context_usage", origin: "live", usage, turnId: "turn-1" },
      },
    ]);
    // The per-turn "live" snapshot only feeds the composer meter — no inline card.
    expect(screen.queryByTestId("claude-context-card")).toBeNull();

    // The user-requested `/context` command still renders its breakdown card.
    rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList
          events={[
            {
              sessionId: "session-1",
              timestamp: "2026-03-17T10:00:01.000Z",
              event: {
                type: "context_usage",
                origin: "command",
                usage: {
                  ...usage,
                  categories: [
                    { name: "Messages", tokens: 82_000, percentage: 41, kind: "used" },
                    { name: "MCP tools", tokens: 31_000, percentage: 16, kind: "used", mcpServers: [
                      { name: "posthog", tokens: 18_000 },
                      { name: "linear", tokens: 9_000 },
                    ] },
                    { name: "Free", tokens: 64_000, percentage: 32, kind: "free" },
                    { name: "Compaction gap", tokens: 8_000, percentage: 4, kind: "buffer" },
                  ],
                },
                turnId: "turn-1",
              },
            },
          ]}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("claude-context-card");
    expect(card.textContent).toContain("Context · claude-opus-4-8");
    expect(card.textContent).toContain("used");
    expect(card.textContent).toContain("free");
    expect(card.textContent).toContain("buffer");
    expect(card.textContent).toContain("posthog");
    expect(card.textContent).toContain("linear");
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
    ], { showStreamingIndicator: true });

    fireEvent.click(screen.getByRole("button", { name: "Show activity from the active turn" }));
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

  it("hides routine cloud running/finished chips", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "cloud_status", turnId: "turn-1", runId: "run-1", status: "running" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:08.000Z",
        event: { type: "cloud_status", turnId: "turn-1", runId: "run-1", status: "finished" },
      },
    ]);

    expect(screen.queryByText("Running in cloud")).toBeNull();
    expect(screen.queryByText("Cloud run finished")).toBeNull();
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
    ], { sessionId: "session-1", onInsertDraft, showStreamingIndicator: true });

    fireEvent.click(screen.getByRole("button", { name: "Show activity from the active turn" }));
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

  it("opens the active chat terminal from completed turn activity", async () => {
    const onRevealChatTerminal = vi.fn();
    vi.mocked(globalThis.window.ade.terminal.activeForChat).mockResolvedValue({
      terminalId: "terminal-1",
      ptyId: "pty-1",
      title: "Dev server",
    } as any);
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
          status: "completed",
          exitCode: 0,
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ], { sessionId: "session-1", onRevealChatTerminal });

    fireEvent.click(screen.getByRole("button", { name: /^Show .+ from this turn$/ }));
    fireEvent.click(await screen.findByRole("button", {
      name: "Open terminal logs or ask the agent to run this server in the chat terminal",
    }));

    await waitFor(() => {
      expect(globalThis.window.ade.terminal.activeForChat).toHaveBeenCalledWith({
        chatSessionId: "session-1",
      });
      expect(onRevealChatTerminal).toHaveBeenCalledWith({
        terminalId: "terminal-1",
        ptyId: "pty-1",
        label: "Dev server",
      });
    });
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

  it("puts the text row's hover footer on its own line under the prose, live or folded", () => {
    const footerOf = (text: string) => {
      const prose = screen.getByText(text).closest("[data-assistant-output]") as HTMLElement;
      const footer = prose.nextElementSibling as HTMLElement;
      expect(footer.getAttribute("data-testid")).toBe("assistant-text-hover-footer");
      return footer;
    };
    // A short interim line in a live turn: the footer used to sit over its end.
    const events: AgentChatEventEnvelope[] = [
      { sessionId: "session-1", timestamp: "2026-03-17T10:00:00.000Z", event: { type: "user_message", text: "What is this?", turnId: "turn-1" } },
      { sessionId: "session-1", timestamp: "2026-03-17T10:00:01.000Z", event: { type: "text", text: "I'll pull the description.", itemId: "t-1", turnId: "turn-1" } },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "command", command: "cat README.md", cwd: "/repo", output: "", itemId: "c-1", turnId: "turn-1", status: "completed", exitCode: 0 },
      },
      { sessionId: "session-1", timestamp: "2026-03-17T10:00:03.000Z", event: { type: "text", text: "ADE is a workspace.", itemId: "t-2", turnId: "turn-1" } },
    ];
    const view = renderMessageList(events, { showStreamingIndicator: true });
    for (const text of ["I'll pull the description.", "ADE is a workspace."]) {
      const footer = footerOf(text);
      // In flow, not pinned over the text.
      expect(footer.className).not.toMatch(/(^|\s)absolute(\s|$)/);
      expect(footer.parentElement!.className).not.toContain("pr-7");
      expect(within(footer).getByRole("button", { name: "Copy message" })).toBeTruthy();
    }

    // The folded turn's answer keeps the same footer, now with Copy turn.
    view.rerender(
      <MemoryRouter>
        <AgentChatMessageList
          events={[...events, { sessionId: "session-1", timestamp: "2026-03-17T10:00:04.000Z", event: { type: "done", turnId: "turn-1", status: "completed" } }]}
        />
      </MemoryRouter>,
    );
    const answerFooter = footerOf("ADE is a workspace.");
    expect(answerFooter.className).not.toMatch(/(^|\s)absolute(\s|$)/);
    expect(within(answerFooter).getByRole("button", { name: "Copy whole turn" })).toBeTruthy();
  });

  it("adds selected assistant text to the composer as chat context", async () => {
    const onInsertDraft = vi.fn();
    renderMessageList(
      [{
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "text", text: "Retry the lane checkout.", itemId: "text-1", turnId: "turn-1" },
      }],
      { onInsertDraft },
    );

    const output = document.querySelector("[data-assistant-output]");
    expect(output).toBeTruthy();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(output!);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(document);

    const add = await screen.findByTestId("assistant-output-add-to-chat");
    fireEvent.click(add);
    expect(onInsertDraft).toHaveBeenCalledTimes(1);
    expect(String(onInsertDraft.mock.calls[0]?.[0])).toContain("Retry the lane checkout.");
    expect(String(onInsertDraft.mock.calls[0]?.[0])).toContain("added it as context");
  });

  it("renders sent chat-context tags as Chat context chips", () => {
    renderMessageList([{
      sessionId: "session-1",
      timestamp: "2026-03-17T10:00:00.000Z",
      event: {
        type: "user_message",
        text: `please <ade-chat-context>\nThe user highlighted the following text from your previous output and added it as context:\n\nRetry the lane checkout.\n</ade-chat-context> thanks`,
        deliveryState: "delivered",
      },
    }]);
    expect(screen.getByTestId("user-message-chat-context-chip").textContent).toBe("Chat context");
    expect(screen.getByText(/please/)).toBeTruthy();
    expect(screen.getByText(/thanks/)).toBeTruthy();
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
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^Show .+ from this turn$/ }));
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

  it("renders a provider handoff divider with direction and provider marks", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "model_handoff",
          fromProvider: "claude",
          toProvider: "codex",
          fromModelId: "anthropic/claude-sonnet-5",
          toModelId: "openai/gpt-5.4",
        },
      },
    ]);

    const divider = screen.getByTestId("model-handoff-event");
    expect(divider.getAttribute("aria-label")).toBe("Model handoff from Claude to Codex");
    expect(divider.textContent).toContain("handoff");
    expect([...divider.querySelectorAll("[data-model-handoff-provider]")].map((node) => (
      node.getAttribute("data-model-handoff-provider")
    ))).toEqual(["claude", "codex"]);
    expect([...divider.querySelectorAll("[data-model-handoff-provider]")].every((node) => (
      node.className.includes("h-5") && node.className.includes("w-5")
    ))).toBe(true);
    expect(divider.querySelector(".items-center.h-6")).toBeTruthy();
  });

  it("draws no handoff divider when the provider did not actually change", () => {
    const { container } = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "model_handoff",
          fromProvider: "claude",
          toProvider: "claude",
          fromModelId: "anthropic/claude-opus-5",
          toModelId: "anthropic/claude-sonnet-5",
        },
      },
    ]);

    expect(screen.queryByTestId("model-handoff-event")).toBeNull();
    // The envelope is filtered out upstream, so no row wrapper is mounted at
    // all — an empty row would still consume a `--chat-row-gap`.
    const rowList = container.querySelector('[class*="--chat-row-gap"]');
    expect(rowList?.children.length ?? 0).toBe(0);
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

    // The invariant is that the hidden prompt never reaches the clipboard. The
    // shared copy hook no-ops on empty text rather than writing "", so the
    // clipboard is left untouched instead of being wiped. Asserting "not called
    // at all" is the exact new contract and is not vacuous: the sibling test
    // below proves the same button does reach `writeText` for a visible message.
    // The early return happens before any await, so no settling wait is needed.
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies the visible message text when it is not hidden", async () => {
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
          text: "A perfectly ordinary message.",
        },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("A perfectly ordinary message.");
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

  it("labels end-of-turn wall time as ran, not worked for", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "user_message", text: "Run the checks.", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:02:00.000Z",
        event: { type: "done", turnId: "turn-1", status: "interrupted" },
      },
    ]);

    // The turn rule reads `10:04 · ran 3m 32s` — mono, tabular, lower case.
    expect(screen.getByText("ran 2m")).toBeTruthy();
    expect(screen.queryByText(/Worked for/)).toBeNull();
  });

  it("measures ran duration from the last user prompt, not the first cloud turn", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "user_message", text: "first", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:05.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:18:49.000Z",
        event: { type: "user_message", text: "follow up", turnId: "turn-2" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:18:59.000Z",
        event: { type: "done", turnId: "turn-2", status: "completed" },
      },
    ]);

    expect(screen.getByText("ran 10s")).toBeTruthy();
    expect(screen.queryByText(/ran 18m/)).toBeNull();
  });

  it("renders the host-sleep chip once and swaps it for the resumed state in place", () => {
    const paused: AgentChatEventEnvelope = {
      sessionId: "session-1",
      timestamp: "2026-03-17T10:00:00.000Z",
      event: {
        type: "system_notice",
        noticeKind: "info",
        status: "host_asleep",
        message: "Paused — computer asleep",
        detail: { hostSleep: { sleepId: "host-sleep-1" } },
        turnId: "turn-1",
      },
    };
    const resumed: AgentChatEventEnvelope = {
      sessionId: "session-1",
      timestamp: "2026-03-17T10:04:00.000Z",
      event: {
        type: "system_notice",
        noticeKind: "info",
        status: "host_awake",
        message: "Resumed · paused 4m",
        detail: { hostSleep: { sleepId: "host-sleep-1", pausedMs: 240_000 } },
        turnId: "turn-1",
      },
    };

    renderMessageList([paused]);
    expect(screen.getByText("Paused — computer asleep")).toBeTruthy();

    cleanup();
    renderMessageList([paused, resumed]);
    // The resumed half replaces the paused one — the transcript keeps exactly
    // one artifact for the sleep rather than stacking a second banner.
    expect(screen.queryByText("Paused — computer asleep")).toBeNull();
    expect(screen.getByText("Resumed · paused 4m")).toBeTruthy();
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

  it("keeps provider retries in one inline working status", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "status", turnStatus: "started", turnId: "turn-1" },
      },
      ...[2, 3, 4].map((attempt, index) => ({
        sessionId: "session-1",
        timestamp: `2026-03-17T10:00:0${index + 1}.000Z`,
        event: {
          type: "system_notice" as const,
          noticeKind: "warning" as const,
          message: `Claude API retry ${attempt}/10: unknown`,
          detail: "retrying in 4s",
          turnId: "turn-1",
        },
      })),
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:04.000Z",
        event: {
          type: "activity",
          activity: "working",
          providerRetry: true,
          detail: "Reconnecting to Claude · attempt 6 of 10 · retrying in 8s",
          turnId: "turn-1",
        },
      },
    ], { showStreamingIndicator: true });

    expect(rendered.container.textContent).toContain("Reconnecting to Claude · attempt 6 of 10 · retrying in 8s");
    expect(rendered.container.textContent).not.toContain("Claude API retry");
    expect(rendered.container.textContent).not.toContain("provider health");
  });

  it("keeps a replayed legacy retry label when older output precedes the notice", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "status", turnStatus: "started", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "text", text: "Started working.", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "system_notice",
          noticeKind: "warning",
          message: "Claude API retry 2/10: unknown",
          turnId: "turn-1",
        },
      },
    ], { showStreamingIndicator: true });

    expect(rendered.container.textContent).toContain("Retrying Claude · attempt 2 of 10");
    expect(rendered.container.textContent).not.toContain("Claude API retry");
  });

  it("keeps an active retry after a same-turn inline steer", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "status", turnStatus: "started", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "activity",
          activity: "working",
          providerRetry: true,
          detail: "Retrying Claude · attempt 2 of 10",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "user_message",
          text: "also check tests",
          deliveryState: "inline",
          turnId: "turn-1",
        },
      },
    ], { showStreamingIndicator: true });

    expect(rendered.container.textContent).toContain("Retrying Claude · attempt 2 of 10");
  });

  it("does not replay an untagged retry from a completed prior turn", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "api_retry",
          attempt: 1,
          maxRetries: 3,
          retryDelayMs: 2_000,
          errorStatus: null,
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "status", turnStatus: "started", turnId: "turn-2" },
      },
    ], { showStreamingIndicator: true });

    expect(rendered.container.textContent).not.toContain("Retrying Claude");
    expect(rendered.container.textContent).not.toContain("Reconnecting to Claude");
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

  it("labels an inline subagent completion as returned context, not a wake", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    renderMessageList([
      {
        sessionId: "parent-session",
        timestamp: "2026-07-14T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "Your subagent finished.",
          turnId: "turn-active",
          deliveryState: "inline",
          metadata: {
            spawnCompletion: {
              childSessionId: "child-subagent-1",
              childTitle: "Review agent",
              spawnKind: "subagent",
              status: "completed",
              summary: "Review complete.",
            },
          },
        },
      },
    ], { sessionId: "parent-session" });

    expect(screen.getByText("Subagent returned")).toBeTruthy();
    expect(screen.queryByText("ADE woke this chat")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Review complete.*open/i }));
    const navEvent = dispatchSpy.mock.calls
      .map(([evt]) => evt)
      .find((evt): evt is CustomEvent => evt instanceof CustomEvent && evt.type === "ade:work:select-session");
    expect(navEvent?.detail).toMatchObject({ sessionId: "child-subagent-1" });
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

  it("titles a legacy spawn_completed notice from its old message when the detail carries no completion", () => {
    // Transcripts persisted before the copy change read `Peer "<title>" turn
    // finished` and some carry no structured completion at all. They are never
    // re-emitted, so the message parse has to keep working for both formats.
    renderMessageList([
      {
        sessionId: "parent-session",
        timestamp: "2026-07-14T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          status: "spawn_completed",
          message: 'Peer "Move/Regroup Engine and Undo" turn finished',
        },
      },
    ], { sessionId: "parent-session" });

    const chip = screen.getByRole("button", { name: /Move\/Regroup Engine and Undo/ });
    expect(chip.textContent).toContain('Chat "Move/Regroup Engine and Undo" finished its turn');
  });

  it("shows a repeat multiplier on a folded spawn_completed chip", () => {
    // The count lives on the render row, produced by the adjacency fold — so
    // the input is what a real transcript holds: one notice per sibling turn.
    const completion = (timestamp: string, childTurnId: string) => ({
      sessionId: "parent-session",
      timestamp,
      event: {
        type: "system_notice" as const,
        noticeKind: "info" as const,
        status: "spawn_completed",
        message: 'Chat "Docs" finished its turn',
        detail: {
          spawnCompletion: {
            childSessionId: "child-peer-1",
            childTitle: "Docs",
            spawnKind: "peer" as const,
            childTurnId,
            status: "completed" as const,
            summary: "Wrote the docs.",
          },
        },
      },
    });
    renderMessageList([
      completion("2026-07-14T10:00:00.000Z", "turn-1"),
      completion("2026-07-14T10:00:01.000Z", "turn-2"),
      completion("2026-07-14T10:00:02.000Z", "turn-3"),
    ], { sessionId: "parent-session" });

    expect(screen.getByText("×3")).toBeTruthy();
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

  it("keeps the subagent_spawned deep-link pill when there is no inline card (continuity spawn)", () => {
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
            // No accompanying card (continuity spawn) →
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

    fireEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
    await waitFor(() => {
      expect(onCodexRecovery).toHaveBeenCalledWith({
        sessionId: "child-session",
        turnId: "turn-stalled",
        action: "wait",
      });
    });
    expect(await screen.findByText("Waiting for Codex output…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart & resume" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Send nudge" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry same server" })).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: "Restart & resume" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no longer active");
    expect((screen.getByRole("button", { name: "Restart & resume" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides raw moderation rows and keeps cumulative diagnostics behind turn details", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "codex_moderation_metadata",
          metadata: { turnId: "turn-1", metadata: { is_blocked: false } },
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "turn_diagnostics",
          turnId: "turn-1",
          moderationChecks: 1,
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "turn_diagnostics",
          turnId: "turn-1",
          moderationChecks: 3,
          optionalIntegrationFailures: [{ integration: "unityMCP", message: "not configured" }],
        },
      },
    ]);

    expect(screen.queryByText("Moderation")).toBeNull();
    expect(screen.getAllByText("Turn details")).toHaveLength(1);
    expect(screen.getByText(/3 safety checks/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("unityMCP")).toBeTruthy();
  });

  it("merges steer lifecycle updates and can run an unprocessed message next", async () => {
    const onRunUnprocessedMessage = vi.fn().mockResolvedValue(undefined);
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "Check the release.",
          steerId: "steer-1",
          deliveryState: "accepted",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "user_message",
          text: "Check the release.",
          steerId: "steer-1",
          deliveryState: "unprocessed",
          turnId: "turn-1",
        },
      },
    ], { onRunUnprocessedMessage });

    expect(screen.getAllByText("Check the release.")).toHaveLength(1);
    const status = screen.getByTestId("user-message-status");
    expect(status.getAttribute("data-status-kind")).toBe("steer_unprocessed");
    expect(status.textContent).toBe("Not steered — turn ended first");
    // The actions sit with the status line under the bubble, not inside it.
    const runNext = screen.getByRole("button", { name: "Run next" });
    expect(runNext.closest(".ade-chat-message-card-user")).toBeNull();
    expect(screen.getByTestId("user-message-status-row").contains(runNext)).toBe(true);
    fireEvent.click(runNext);
    await waitFor(() => {
      expect(onRunUnprocessedMessage).toHaveBeenCalledWith(expect.objectContaining({
        steerId: "steer-1",
        deliveryState: "unprocessed",
      }));
    });
    expect(await screen.findByText("Started as the next turn")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run next" })).toBeNull();
    expect(screen.getByTestId("user-message-status").textContent).toBe("Started as the next turn");
  });

  it("collapses a resolved Codex recovery card into an audit receipt", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "codex_turn_stalled",
          turnId: "turn-stalled",
          reason: "no_output",
          message: "No output arrived.",
          recoveryOptions: ["restart_resume_thread", "wait"],
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "codex_turn_recovery",
          turnId: "turn-stalled",
          action: "restart_resume_thread",
          state: "recovered",
          message: "ADE restarted the Codex app-server and resumed the thread.",
          automatic: true,
          at: "2026-03-17T10:00:01.000Z",
        },
      },
    ]);

    expect(screen.queryByRole("button", { name: "Restart & resume" })).toBeNull();
    expect(screen.getByText("Recovered")).toBeTruthy();
    expect(screen.getByText(/restarted the Codex app-server/)).toBeTruthy();
  });

  it("keeps non-rate-limit, non-warning notice details in collapsible cards", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "hook",
          message: "Hook stderr captured",
          detail: "Long hook output remains behind a disclosure.",
        },
      },
    ]);

    expect(screen.getByText("hook")).toBeTruthy();
    expect(screen.getByText("Hook stderr captured")).toBeTruthy();
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("draws a warning notice as one compact line that expands to the full message and detail", () => {
    const message = "⚠ Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings. user (/Users/me/.codex/config.toml): `features.rmcp_client` is ignored.";
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "system_notice", noticeKind: "warning", message, detail: "Seen at thread start." },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "system_notice", noticeKind: "info", severity: "warning", message: "Claude could not compact this conversation." },
      },
    ]);

    const rows = screen.getAllByTestId("compact-warning-notice");
    expect(rows).toHaveLength(2);
    // No WARNING label block, and the provider's own ⚠ is not doubled next to the icon.
    expect(screen.queryByText(/^warning$/i)).toBeNull();
    const summary = within(rows[0]!).getByTitle(/^Codex is ignoring 1 unrecognized/);
    expect(summary.className).toContain("truncate");
    expect(screen.queryByText("Seen at thread start.")).toBeNull();

    const toggle = within(rows[0]!).getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Seen at thread start.")).toBeTruthy();
    expect(within(rows[0]!).getAllByText(/features\.rmcp_client/)).toHaveLength(2);
  });

  it("keeps error notices as cards, not compact warning lines", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "system_notice", noticeKind: "error", message: "🛡 guardian: blocked" },
      },
    ]);

    expect(screen.queryByTestId("compact-warning-notice")).toBeNull();
    expect(screen.getByText("error")).toBeTruthy();
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
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);

    expect(screen.queryByText("Hook: PreToolUse:Bash error")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Show .+ from this turn$/ }));

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
    const onReturnToLatest = vi.fn();
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
    ], { onReturnToLatest });

    const transcript = document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    transcript.scrollTop = 100;

    fireEvent.scroll(transcript);

    const jumpButton = await screen.findByRole("button", { name: "Jump to latest message" });
    expect(jumpButton.textContent).toContain("Jump To Latest");
    fireEvent.click(jumpButton);
    expect(onReturnToLatest).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
    });
  });

  it("stays pinned to latest when the composer grows and shrinks the transcript", async () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "Keep typing",
          deliveryState: "delivered",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "text",
          text: "Still at the bottom.",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
    ]);

    const transcript = document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 400 });
    transcript.scrollTop = 600;
    fireEvent.scroll(transcript);

    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    // Layout left scrollTop where it was; distance-from-bottom is now 200px.
    transcript.scrollTop = 600;
    fireEvent.scroll(transcript);

    expect(transcript.scrollTop).toBe(800);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });

  it("automatically backfills an underfilled transcript without requiring a scroll event", async () => {
    const onLoadOlderHistory = vi.fn();
    renderMessageList([], {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });

    await waitFor(() => expect(onLoadOlderHistory).toHaveBeenCalledTimes(1));
  });

  it("stops automatic retries after an older-history failure and exposes a retry button", async () => {
    const onLoadOlderHistory = vi.fn();
    const onRetryOlderHistory = vi.fn();
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    let intersectionCallback: IntersectionObserverCallback | null = null;
    globalThis.IntersectionObserver = class {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      disconnect() {}
      observe() {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
      unobserve() {}
    } as typeof IntersectionObserver;
    try {
      renderMessageList([], {
        hasOlderHistory: true,
        olderHistoryError: "Host disconnected",
        onLoadOlderHistory,
        onRetryOlderHistory,
      });

      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const observedIntersection = intersectionCallback as IntersectionObserverCallback | null;
      expect(observedIntersection).not.toBeNull();
      observedIntersection?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      expect(onLoadOlderHistory).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Retry loading earlier messages" }));
      expect(onRetryOlderHistory).toHaveBeenCalledTimes(1);
      expect(onLoadOlderHistory).not.toHaveBeenCalled();
    } finally {
      globalThis.IntersectionObserver = originalIntersectionObserver;
    }
  });

  it("does not resume bottom stickiness until the user returns to latest", () => {
    expect(shouldStickToBottomAfterScroll({
      distanceFromBottom: 80,
      wasStuckToBottom: true,
      scrolledDown: false,
      repinHeld: false,
    })).toBe(true);
    expect(shouldStickToBottomAfterScroll({
      distanceFromBottom: 80,
      wasStuckToBottom: false,
      scrolledDown: true,
      repinHeld: false,
    })).toBe(false);
    expect(shouldStickToBottomAfterScroll({
      distanceFromBottom: 12,
      wasStuckToBottom: false,
      scrolledDown: true,
      repinHeld: false,
    })).toBe(true);
  });

  it("treats a shrinking transcript viewport as a pin, not a user scroll", () => {
    expect(shouldKeepPinnedThroughViewportShrink({
      wasStuckToBottom: true,
      previousClientHeight: 400,
      nextClientHeight: 200,
    })).toBe(true);
    expect(shouldKeepPinnedThroughViewportShrink({
      wasStuckToBottom: false,
      previousClientHeight: 400,
      nextClientHeight: 200,
    })).toBe(false);
    expect(shouldKeepPinnedThroughViewportShrink({
      wasStuckToBottom: true,
      previousClientHeight: 0,
      nextClientHeight: 200,
    })).toBe(false);
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

  it("jumps through the single minimap rail using the pointer Y", () => {
    stubMinimapLayout();
    renderMessageList(MINIMAP_TRANSCRIPT);

    const transcript = timelinePane();
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });

    const rail = minimapRail();
    // One tab stop for the whole timeline — there is no per-message button.
    expect(screen.queryByRole("button", { name: "User message 2" })).toBeNull();
    expect(rail.getAttribute("aria-label")?.startsWith("Jump to message:")).toBe(true);

    fireEvent.mouseMove(rail, { clientY: 500 });
    fireEvent.click(rail, { clientY: 500 });

    expect(transcript.scrollTop).toBeGreaterThan(0);
  });

  it("previews the hovered prompt with its reply and never jumps from inside the card", () => {
    stubMinimapLayout();
    renderMessageList(MINIMAP_TRANSCRIPT);

    const transcript = timelinePane();
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });

    const rail = minimapRail();
    fireEvent.mouseMove(rail, { clientY: 500 });

    const preview = document.querySelector("[data-minimap-preview]") as HTMLElement | null;
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain("Second checkpoint");
    expect(preview?.textContent).toContain("Shipped it.");
    expect(rail.getAttribute("aria-label")).toBe("Jump to message: Second checkpoint");

    // Selecting text inside the card must not navigate the transcript.
    fireEvent.click(preview!, { clientY: 500 });
    expect(transcript.scrollTop).toBe(0);
  });

  it("keeps the rail anchored when a PR pane is floating", () => {
    // The PR pane is an overlay. Its presence must not move the transcript's
    // history markers down into the space below the card.
    stubMinimapLayout();
    renderMessageList(MINIMAP_TRANSCRIPT);

    expect(screen.getByTestId("chat-user-minimap").style.top).toBe("0px");
  });

  it("marks a failed turn's tick so colour is not the only signal", () => {
    stubMinimapLayout();
    renderMessageList([
      ...MINIMAP_TRANSCRIPT,
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:04.000Z",
        event: { type: "done", turnId: "turn-2", status: "failed" },
      },
    ]);

    const outcomes = [...screen.getByTestId("chat-user-minimap").querySelectorAll("[data-outcome]")];
    expect(outcomes.map((node) => node.getAttribute("data-outcome"))).toEqual(["failed"]);
  });

  it("backfills older history silently and only speaks up after a failure", () => {
    const view = render(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={[]} hasOlderHistory />
      </MemoryRouter>,
    );

    const slot = () => document.querySelector('[role="status"][aria-live="polite"]') as HTMLElement;
    // Paging happens on its own; the reader is never asked to press anything.
    expect(slot()).not.toBeNull();
    expect(slot().textContent).toBe("");
    expect(slot().querySelector("button")).toBeNull();
    expect(slot().className).toContain("h-7");

    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList
          events={[]}
          hasOlderHistory
          loadingOlderHistory
          olderHistoryError="Host disconnected"
        />
      </MemoryRouter>,
    );
    expect((screen.getByRole("button", { name: "Loading earlier messages" }) as HTMLButtonElement).disabled).toBe(true);
    expect(slot().textContent).toContain("loading earlier messages");

    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={[]} hasOlderHistory olderHistoryError="Host disconnected" />
      </MemoryRouter>,
    );
    const retry = screen.getByRole("button", { name: "Retry loading earlier messages" });
    expect(retry.textContent).toContain("retry");
    // Same fixed height in both states, so latching the error shifts nothing.
    expect(slot().className).toContain("h-7");
  });

  it("counts rows that arrived while detached on the jump pill", async () => {
    const all = userMessageEvents(["one", "two", "three", "four", "five"]);
    const view = render(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={all.slice(0, 3)} />
      </MemoryRouter>,
    );

    const transcript = timelinePane();
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);

    // Nothing new yet: the pill keeps its plain label.
    expect(await screen.findByRole("button", { name: "Jump to latest message" })).toBeTruthy();

    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={all} />
      </MemoryRouter>,
    );

    const pill = screen.getByRole("button", { name: "2 new · Jump To Latest" });
    expect(pill.textContent).toContain("2 new · Jump To Latest");

    fireEvent.click(pill);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
    });

    await nextFrame();
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    // The jump cleared the baseline, so detaching again starts from zero.
    expect(await screen.findByRole("button", { name: "Jump to latest message" })).toBeTruthy();
  });

  it("renders a long user prompt in full with no expand affordance", () => {
    // The owner's rule: conversation text is never hidden behind "Show full
    // message". A 900-character, many-line paste renders whole.
    const longPrompt = `Migration checklist ${"detail ".repeat(120)}`;
    const events = userMessageEvents([longPrompt], "collapse-session");
    renderMessageList(events, { sessionId: "collapse-session" });

    expect(screen.queryByTestId("user-message-collapsible-body")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show full message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show less" })).toBeNull();
    expect(screen.getByText(longPrompt.trim())).toBeTruthy();
  });

  it("isolates nested transcript collapse caches from the real session cache", () => {
    const sessionId = "collapse-cache-parent";
    const parentEvents = userMessageEvents(["Parent transcript"], sessionId);
    const nestedEvents = userMessageEvents(["Nested subagent transcript"], sessionId);
    const nestedCacheKey = `subagent:${sessionId}:task-1`;

    const parent = renderMessageList(parentEvents, { sessionId });
    parent.unmount();
    const nested = renderMessageList(nestedEvents, {
      sessionId,
      transcriptCollapseCacheKey: nestedCacheKey,
    });
    nested.unmount();

    expect(getTranscriptCollapseCacheKeysForTests()).toEqual([sessionId, nestedCacheKey]);

    renderMessageList(parentEvents, { sessionId });
    expect(screen.getByText("Parent transcript")).toBeTruthy();
    expect(screen.queryByText("Nested subagent transcript")).toBeNull();
    expect(getTranscriptCollapseCacheKeysForTests()).toEqual([nestedCacheKey, sessionId]);
  });

  it("does not refresh collapse-cache LRU recency on an ordinary rerender", () => {
    const firstSessionId = "collapse-lru-a";
    const firstEvents = userMessageEvents(["First"], firstSessionId);
    const first = render(
      <MemoryRouter>
        <AgentChatMessageList events={firstEvents} sessionId={firstSessionId} />
      </MemoryRouter>,
    );
    for (const suffix of ["b", "c", "d", "e", "f", "g", "h"]) {
      const sessionId = `collapse-lru-${suffix}`;
      renderMessageList(userMessageEvents([suffix], sessionId), { sessionId });
    }
    expect(getTranscriptCollapseCacheKeysForTests()[0]).toBe(firstSessionId);

    first.rerender(
      <MemoryRouter>
        <AgentChatMessageList
          events={firstEvents}
          sessionId={firstSessionId}
          showStreamingIndicator
        />
      </MemoryRouter>,
    );
    renderMessageList(userMessageEvents(["i"], "collapse-lru-i"), {
      sessionId: "collapse-lru-i",
    });

    const cacheKeys = getTranscriptCollapseCacheKeysForTests();
    expect(cacheKeys).not.toContain(firstSessionId);
    expect(cacheKeys).toContain("collapse-lru-b");
  });

  it("leaves a short user prompt uncollapsed", () => {
    renderMessageList(userMessageEvents(["Ship it"], "short-session"), { sessionId: "short-session" });
    expect(screen.queryByTestId("user-message-collapsible-body")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show full message" })).toBeNull();
    expect(screen.getByText("Ship it")).toBeTruthy();
  });

  it("returns a pinned chat to the live tail after a remount", async () => {
    const restoreScrollBox = stubTimelineScrollBox({ clientHeight: 200, scrollHeight: 1_000 });
    try {
      const events = userMessageEvents(["a", "b", "c", "d"], "restore-pinned");
      const view = renderMessageList(events, { sessionId: "restore-pinned" });
      const transcript = timelinePane();
      await nextFrame();

      transcript.scrollTop = 300;
      fireEvent.scroll(transcript);
      transcript.scrollTop = 800;
      fireEvent.scroll(transcript);
      view.unmount();

      renderMessageList(events, { sessionId: "restore-pinned" });
      await nextFrame();
      expect(timelinePane().scrollTop).toBe(800);
    } finally {
      restoreScrollBox();
    }
  });

  it("restores the exact offset a detached chat was left at", async () => {
    const restoreScrollBox = stubTimelineScrollBox({ clientHeight: 200, scrollHeight: 1_000 });
    try {
      const events = userMessageEvents(["a", "b", "c", "d", "e", "f", "g", "h"], "restore-detached");
      const view = renderMessageList(events, { sessionId: "restore-detached" });
      const transcript = timelinePane();
      await nextFrame();

      transcript.scrollTop = 400;
      fireEvent.scroll(transcript);
      view.unmount();

      renderMessageList(events, { sessionId: "restore-detached" });
      // Restored synchronously on the first frame that measures a real
      // viewport — no visible snap to the bottom first.
      expect(timelinePane().scrollTop).toBe(400);
      expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeTruthy();
    } finally {
      restoreScrollBox();
    }
  });

  it("preserves parent scroll memory while the mounted list shows a nested transcript", async () => {
    const restoreScrollBox = stubTimelineScrollBox({ clientHeight: 200, scrollHeight: 1_000 });
    try {
      const parentEvents = userMessageEvents(["parent-a", "parent-b", "parent-c", "parent-d"], "scroll-switch");
      const childEvents = userMessageEvents(["child-a", "child-b"], "scroll-switch");
      const view = renderMessageList(parentEvents, {
        sessionId: "scroll-switch",
        scrollMemoryKey: "parent:scroll-switch",
      });
      const transcript = timelinePane();
      await nextFrame();

      transcript.scrollTop = 400;
      fireEvent.scroll(transcript);
      expect(await screen.findByRole("button", { name: "Jump to latest message" })).toBeTruthy();
      view.rerender(
        <MemoryRouter initialEntries={[{ pathname: "/" }]}>
          <AgentChatMessageList
            events={childEvents}
            sessionId="scroll-switch"
            scrollMemoryKey="child:scroll-switch:task-1"
          />
          <LocationProbe />
        </MemoryRouter>,
      );
      await nextFrame();

      view.rerender(
        <MemoryRouter
          initialEntries={[{ pathname: "/" }]}
        >
          <AgentChatMessageList
            events={parentEvents}
            sessionId="scroll-switch"
            scrollMemoryKey="parent:scroll-switch"
          />
          <LocationProbe />
        </MemoryRouter>,
      );
      await nextFrame();
      expect(timelinePane().scrollTop).toBe(400);
    } finally {
      restoreScrollBox();
    }
  });

  it("follows the nested transcript tail when both views are pinned", async () => {
    const restoreScrollBox = stubTimelineScrollBox({ clientHeight: 200, scrollHeight: 1_000 });
    try {
      const parentEvents = userMessageEvents(["parent"], "pinned-switch");
      const childEvents = userMessageEvents(["child-a", "child-b", "child-c"], "pinned-switch");
      const view = renderMessageList(parentEvents, {
        sessionId: "pinned-switch",
        scrollMemoryKey: "parent:pinned-switch",
      });
      await nextFrame();
      const transcript = timelinePane();
      transcript.scrollTop = 120;

      view.rerender(
        <MemoryRouter
          initialEntries={[{ pathname: "/" }]}
        >
          <AgentChatMessageList
            events={childEvents}
            sessionId="pinned-switch"
            scrollMemoryKey="child:pinned-switch:task-1"
          />
          <LocationProbe />
        </MemoryRouter>,
      );
      await nextFrame();
      await nextFrame();
      expect(timelinePane().scrollTop).toBe(800);
    } finally {
      restoreScrollBox();
    }
  });

  it("handles each external row jump request only once across transcript updates", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T09:59:00.000Z",
        event: { type: "user_message", text: "Inspect the timeline.", turnId: "turn-1" },
      },
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

  it("scrolls to the prompt selected by composer history", () => {
    const view = renderMessageList(MINIMAP_TRANSCRIPT);
    const transcript = document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });

    const target = MINIMAP_TRANSCRIPT[2]!;
    if (target.event.type !== "user_message") throw new Error("test target must be a user message");
    const request = {
      eventKey: promptHistoryEventKey({ timestamp: target.timestamp, event: target.event }),
      requestId: 1,
    };
    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={MINIMAP_TRANSCRIPT} scrollToPromptHistoryRequest={request} />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(transcript.scrollTop).toBeGreaterThan(0);
  });

  it("scrolls to a steered prompt selected by composer history, status line and all", () => {
    const steered: AgentChatEventEnvelope[] = MINIMAP_TRANSCRIPT.map((envelope, index) => (
      index === 2 && envelope.event.type === "user_message"
        ? { ...envelope, event: { ...envelope.event, steerId: "steer-2", deliveryState: "inline" } }
        : envelope
    ));
    const view = renderMessageList(steered);
    const transcript = document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    expect(screen.getByTestId("user-message-status").textContent).toBe("Steered");

    const target = steered[2]!;
    if (target.event.type !== "user_message") throw new Error("test target must be a user message");
    const request = {
      eventKey: promptHistoryEventKey({ timestamp: target.timestamp, event: target.event }),
      requestId: 1,
    };
    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={steered} scrollToPromptHistoryRequest={request} />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(transcript.scrollTop).toBeGreaterThan(0);
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

    const fileLink = screen.getByRole("button", { name: "AgentChatMessageList.tsx" });
    expect(fileLink.getAttribute("title")).toBe("Open file in Files");
    expect(fileLink.className).toContain("cursor-pointer");
    fireEvent.click(fileLink);

    await expectLocationText(
      "/files::{\"openFilePath\":\"apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx\",\"laneId\":\"lane-123\"}",
    );
  });

  it("uses the chat's lane when the Work route has no router state", async () => {
    renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: {
            type: "text",
            text: "Open [AgentChatMessageList.tsx](apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx).",
            itemId: "text-chat-lane",
            turnId: "turn-1",
          },
        },
      ],
      {
        laneId: "lane-123",
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

  it("does not coalesce text fragments across hidden command boundaries", () => {
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
    expect(view.container.textContent).not.toContain("echo ok");
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

  it("keeps queue recovery actions available in virtualized transcript rows", async () => {
    const onRestoreCancelledQueue = vi.fn().mockResolvedValue(true);
    const events = Array.from({ length: 64 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: `2026-03-17T10:${String(index).padStart(2, "0")}:00.000Z`,
      event: {
        type: "user_message",
        text: `message ${index}`,
        messageId: `user-${index}`,
        turnId: `turn-${index}`,
      },
    }));
    events.push({
      sessionId: "session-1",
      timestamp: "2026-03-17T11:05:00.000Z",
      event: {
        type: "queue_recovery",
        recoveryId: "recovery-1",
        state: "available",
        messageCount: 2,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        stopMode: "stop_and_clear",
      },
    });

    renderMessageList(events, { onRestoreCancelledQueue });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => {
      expect(onRestoreCancelledQueue).toHaveBeenCalledWith("recovery-1");
    });
  });

  it("hides settled queue recovery cards in virtualized transcript rows", () => {
    const events = Array.from({ length: 63 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: `2026-03-17T10:${String(index).padStart(2, "0")}:00.000Z`,
      event: {
        type: "user_message",
        text: `message ${index}`,
        messageId: `user-${index}`,
        turnId: `turn-${index}`,
      },
    }));
    events.push(
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T11:04:00.000Z",
        event: {
          type: "queue_recovery",
          recoveryId: "recovery-1",
          state: "available",
          messageCount: 2,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          stopMode: "stop_and_clear",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T11:05:00.000Z",
        event: {
          type: "queue_recovery",
          recoveryId: "recovery-1",
          state: "restored",
          messageCount: 2,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          stopMode: "stop_and_clear",
        },
      },
    );

    renderMessageList(events, {
      onRestoreCancelledQueue: vi.fn().mockResolvedValue(true),
    });

    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
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

  it("resolves an anchor past a hidden context-usage row against the visible grouping", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        sequence: 40,
        event: { type: "user_message", text: "first", messageId: "user-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        sequence: 41,
        event: { type: "reasoning", text: "First thought.", itemId: "thought-1", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        sequence: 42,
        event: {
          type: "context_usage",
          origin: "live",
          turnId: "turn-1",
          usage: { categories: [], totalTokens: 1, maxTokens: 2, percentage: 0.1, model: "claude" },
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:03.000Z",
        sequence: 43,
        event: { type: "reasoning", text: "Second thought.", itemId: "thought-2", turnId: "turn-1" },
      },
    ];
    // The rendered list drops the hidden snapshot BEFORE grouping, so the two
    // thoughts merge into one row. The anchor resolver must group the same way,
    // or its target key will not match the rendered row and the anchor drifts
    // to an earlier row instead.
    const groupedRows = groupChatTranscriptRows(
      collapseChatTranscriptEvents(events).filter(
        (row) =>
          !(row.event.type === "context_usage"
            && row.event.origin !== undefined
            && row.event.origin !== "command"),
      ),
    );

    expect(groupedRows).toHaveLength(2);
    expect(groupedRows[0]?.event.type).toBe("user_message");
    expect(resolveAnchoredChatRowIndex({ events, groupedRows, anchorEvent: 43, hasFullHistory: false })).toBe(1);
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

      // What the sizer would be with every row still on its estimate.
      const estimatedOnly = 65 * (51 + CHAT_TIMELINE_ROW_GAP_PX) - CHAT_TIMELINE_ROW_GAP_PX;
      await waitFor(() => {
        const virtualSizer = Array.from(rendered.container.querySelectorAll("div"))
          .find((el) => el.style.position === "relative" && el.style.height);
        // Rows in the window measured at 220px on mount, not on a later RO callback.
        expect(Number.parseFloat(virtualSizer?.style.height ?? "0")).toBeGreaterThan(estimatedOnly + 5 * (220 - 51));
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

  it("keeps the elapsed timer ticking when the first tool call wraps the status line in a button", () => {
    // The status line renders bare while a turn has no tool activity and moves
    // inside an expander <button> the moment the first tool entry lands. That
    // swap remounts the timer <span>, so a timer that captured the element once
    // would keep writing into the detached node and freeze on screen at "0s"
    // while "taking longer than usual" still appears — the reported bug.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T10:00:00.000Z"));
    try {
      const before: AgentChatEventEnvelope[] = [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          sequence: 1,
          event: { type: "user_message", text: "go", turnId: "turn-1" },
        },
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          sequence: 2,
          event: { type: "text", text: "Let me check that.", itemId: "text-1", turnId: "turn-1" },
        },
      ];
      const after: AgentChatEventEnvelope[] = [
        ...before,
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:05.000Z",
          sequence: 3,
          event: {
            type: "command",
            command: "npm test",
            cwd: "/repo",
            output: "",
            itemId: "cmd-1",
            turnId: "turn-1",
            status: "completed",
            exitCode: 0,
          },
        },
      ];

      const view = renderMessageList(before, { showStreamingIndicator: true });
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(view.container.textContent).toContain("working for 5s");

      view.rerender(
        <MemoryRouter initialEntries={[{ pathname: "/" }]}>
          <AgentChatMessageList events={after} showStreamingIndicator />
          <LocationProbe />
        </MemoryRouter>,
      );
      // The expander button is now present, so the status line remounted.
      expect(screen.getByRole("button", { name: /activity from the active turn/i })).toBeTruthy();

      act(() => { vi.advanceTimersByTime(5_000); });
      expect(view.container.textContent).toContain("working for 10s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a running background job as one line, with no dead open affordance", () => {
    const runningJob: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "scheduled_work_update",
          id: "background:bg-1",
          kind: "background_task",
          status: "running",
          title: "cd /repo && npm install",
          sourceTaskId: "bg-1",
        },
      },
    ];

    // No host is listening for `ade:chat:open-info` (PersonalChatsPage is one),
    // so the affordance must not render at all — a button that silently does
    // nothing is worse than an absent one.
    const withoutHost = renderMessageList(runningJob);
    const line = withoutHost.container.querySelector("[data-background-job]")!;
    expect(line).toBeTruthy();
    expect(line.getAttribute("data-background-job-status")).toBe("running");
    expect(line.textContent).toContain("npm install");
    expect(withoutHost.container.querySelector("[data-background-job] button")).toBeNull();
    // Windows parity: bare ⚙/✓/✗ codepoints resolve to Segoe UI Emoji there,
    // rendering as heavier colour glyphs off the baseline of the line. Status is
    // a word (`running`, `done`), never a text codepoint.
    expect(line.textContent).not.toMatch(/[⚙✓✗]/);
    expect(line.textContent).toContain("running");
    cleanup();

    // Inside a host that owns the actions pane, the affordance appears and works.
    const withHost = render(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <ChatInfoHostContext.Provider value={true}>
          <AgentChatMessageList events={runningJob} />
        </ChatInfoHostContext.Provider>
      </MemoryRouter>,
    );
    const openButton = withHost.container.querySelector("[data-background-job] button")!;
    expect(openButton).toBeTruthy();

    const openInfo = vi.fn();
    window.addEventListener("ade:chat:open-info", openInfo);
    try {
      fireEvent.click(openButton);
      expect(openInfo).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("ade:chat:open-info", openInfo);
    }
  });

  it("does not tick a background job that never finished in an ended session", () => {
    // An archived chat whose job never got a terminal update stays `running`
    // forever. Reporting "1440h" is arithmetically right and useless; the row
    // shows no duration at all rather than asserting a number nobody should act
    // on.
    const endedJob: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "scheduled_work_update",
          id: "background:bg-1",
          kind: "background_task",
          status: "running",
          title: "cd /repo && npm run dev",
          sourceTaskId: "bg-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ];

    const rendered = renderMessageList(endedJob, { sessionEnded: true });
    const line = rendered.container.querySelector("[data-background-job]")!;
    expect(line).toBeTruthy();
    expect(line.getAttribute("data-background-job-status")).toBe("running");
    expect(line.textContent).toContain("npm run dev");
    // No elapsed at all — not a frozen one, and not a ticking one.
    expect(line.textContent).not.toMatch(/\d+\s*(s|m|h|d)\b/);
  });

  it("folds a finished turn's narration and moves its tool and file counts onto the fold row", () => {
    const rendered = renderMessageList([
      // No user message: the turn's own start event anchors its duration.
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "status", turnStatus: "started", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "text", text: "I’ll inspect the renderer first.", itemId: "text-1", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "command",
          command: "npm test",
          cwd: "/repo",
          output: "passed",
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
          type: "file_change",
          path: "src/chat.tsx",
          diff: "+ const calmer = true;\n",
          kind: "modify",
          itemId: "file-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:03.000Z",
        event: { type: "text", text: "The focused tests pass.", itemId: "text-2", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:05.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);

    // Closed by default: the interim narration is folded, the answer is not,
    // and the counts sit on the fold row instead of the turn-end line.
    const fold = screen.getByRole("button", { name: /^Worked for 5\.0s · 1 tool · 1 file\. Show/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    let text = rendered.container.textContent ?? "";
    expect(text).not.toContain("I’ll inspect the renderer first.");
    expect(text).toContain("The focused tests pass.");
    expect(text).toContain("ran 5.0s");
    expect(text).not.toContain("1 file changed");
    expect(screen.queryByRole("button", { name: /^Show .+ from this turn$/ })).toBeNull();
    expect(text.indexOf("Worked for 5.0s")).toBeLessThan(text.indexOf("The focused tests pass."));

    // Open: the narration returns in place and the turn's tools stay reachable.
    fireEvent.click(fold);
    text = rendered.container.textContent ?? "";
    expect(text).toContain("I’ll inspect the renderer first.");
    expect(text).toContain("1 file changed");
    expect(text.indexOf("I’ll inspect the renderer first.")).toBeLessThan(text.indexOf("The focused tests pass."));
    fireEvent.click(screen.getByRole("button", { name: /^Show .+ from this turn$/ }));
    text = rendered.container.textContent ?? "";
    expect(text).toContain("npm test");
    expect(text.indexOf("npm test")).toBeLessThan(text.indexOf("The focused tests pass."));
  });

  it("left-aligns the turn work summary with Thought and keeps time/usage last when expanded", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "status", turnStatus: "started", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "reasoning", text: "Checking the package name.", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "command",
          command: "cat package.json",
          cwd: "/repo",
          output: "{}",
          itemId: "command-1",
          turnId: "turn-1",
          status: "completed",
          exitCode: 0,
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);

    const summary = screen.getByRole("button", { name: /^Show .+ from this turn$/ });
    fireEvent.click(summary);
    const text = rendered.container.textContent ?? "";
    expect(text.indexOf("ran 2.0s")).toBeGreaterThan(-1);
    expect(text.indexOf("ran 2.0s")).toBeLessThan(text.indexOf("cat package.json"));
  });

  // "Keep the last": the row you read is the most recent one; quiet successes
  // fold behind a count. Failures never fold — burying a rejected command
  // behind "+N previous" is exactly the bug this shape must not introduce.
  it("keeps the last tool call and folds the quiet successes behind a count", () => {
    const command = (index: number, status: "completed" | "failed") => ({
      sessionId: "session-1",
      timestamp: `2026-03-17T10:00:0${index}.000Z`,
      event: {
        type: "command" as const,
        command: `step-${index}.sh`,
        cwd: "/repo",
        output: "ok",
        itemId: `command-${index}`,
        turnId: "turn-1",
        status,
        exitCode: status === "completed" ? 0 : 1,
      },
    });

    const rendered = renderMessageList([
      command(1, "completed"),
      command(2, "completed"),
      command(3, "failed"),
      command(4, "completed"),
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:06.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^Show .+ from this turn$/ }));

    // Last call + the failure survive; the two quiet successes fold.
    expect(rendered.container.textContent).toContain("step-4.sh");
    expect(rendered.container.textContent).toContain("step-3.sh");
    expect(rendered.container.textContent).not.toContain("step-1.sh");
    expect(rendered.container.textContent).toContain("+2 previous tool calls");

    fireEvent.click(screen.getByText("+2 previous tool calls"));
    expect(rendered.container.textContent).toContain("step-1.sh");
  });

  it("keeps mixed provider turn ids together while resetting fallback activity at a new user turn", () => {
    const rendered = renderMessageList(mixedIdToolActivityBoundaryEvents());

    fireEvent.click(screen.getByRole("button", { name: /^Show .+ from this turn$/ }));
    expect(rendered.container.textContent).toContain("tagged-command");
    expect(rendered.container.textContent).toContain("untagged-command");
    expect(rendered.container.textContent).not.toContain("stale-command");
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

  it("merges Thought rows separated only by a hidden context-usage snapshot", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "reasoning",
          text: "First thought.",
          itemId: "claude-thinking:turn-1:1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "context_usage",
          origin: "live",
          turnId: "turn-1",
          usage: {
            categories: [],
            totalTokens: 1,
            maxTokens: 2,
            percentage: 0.1,
            model: "claude",
          },
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "reasoning",
          text: "Second thought.",
          itemId: "claude-thinking:turn-1:0",
          turnId: "turn-1",
        },
      },
    ]);

    expect(screen.getAllByText("Thought")).toHaveLength(1);
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

  it("draws the collapsed Thought label as plain text, with no trailing dots", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "reasoning", text: "Checked the import graph.", itemId: "r-1", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);
    const label = rendered.container.querySelector("[data-testid='thought-label']") as HTMLElement;
    expect(label.textContent).toBe("Thought");
    // The dots were rounded-full spans after the word; none remain.
    expect(label.querySelectorAll(".rounded-full")).toHaveLength(0);
    expect(label.parentElement!.querySelectorAll(".rounded-full, .ade-thinking-pulse")).toHaveLength(0);
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
    ], { showStreamingIndicator: true });

    fireEvent.click(screen.getByRole("button", { name: "Show activity from the active turn" }));
    expect(rendered.container.textContent).toContain("pwd");
    expect(rendered.container.textContent).toContain("shell");
    expect(rendered.container.innerHTML).toContain("max-w-[var(--chat-content-width,52rem)]");
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
    // The card itself opens the transcript; there is no text link.
    expect(text).not.toContain("view transcript");
  });

  it("draws consecutive Codex agents side by side in one row, titled by name", () => {
    const codexStart = (id: string, path: string, second: number): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: `2026-03-17T10:00:0${second}.000Z`,
      event: {
        type: "subagent_started",
        taskId: id,
        agentId: id,
        agentType: path,
        label: path,
        description: path,
        turnId: "turn-1",
      },
    });
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T09:59:59.000Z",
        event: { type: "user_message", text: "scan this codebase using parallel agents", turnId: "turn-1" },
      },
      codexStart("t-1", "/root/desktop_scan", 1),
      codexStart("t-2", "/root/cli_tui_scan", 2),
      codexStart("t-3", "/root/ios_shared_scan", 3),
    ], { sessionProvider: "codex" });

    const grids = rendered.container.querySelectorAll("[data-subagent-card-grid]");
    expect(grids).toHaveLength(1);
    const grid = grids[0]!;
    expect(grid.getAttribute("data-subagent-card-count")).toBe("3");
    // One transcript row, keyed by the first card.
    expect(grid.closest("[data-chat-row-key]")?.getAttribute("data-chat-row-key")).toBe("subagent-spawn:t-1");
    expect([...grid.querySelectorAll("[data-subagent-name]")].map((node) => node.textContent))
      .toEqual(["Desktop scan", "CLI TUI scan", "iOS shared scan"]);
    expect(rendered.container.textContent).not.toContain("/root/");
  });

  it("keeps a lone card mounted when a second card joins it in a grid", () => {
    const start = (id: string, description: string, second: number): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: `2026-03-17T10:00:0${second}.000Z`,
      event: { type: "subagent_started", taskId: id, agentId: id, agentType: "Explore", description, turnId: "turn-1" },
    });
    const first = [start("agent-a", "Scan desktop", 1)];
    const rendered = renderMessageList(first);
    const cardBefore = rendered.container.querySelector("[data-subagent-card-key='subagent-spawn:agent-a'] [data-subagent-card]");
    expect(cardBefore).toBeTruthy();

    rendered.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={[...first, start("agent-b", "Scan iOS", 2)]} />
        <LocationProbe />
      </MemoryRouter>,
    );
    const grid = rendered.container.querySelector("[data-subagent-card-grid]")!;
    expect(grid.getAttribute("data-subagent-card-count")).toBe("2");
    expect(grid.querySelector("[data-subagent-card-key='subagent-spawn:agent-a'] [data-subagent-card]")).toBe(cardBefore);
  });

  it("settles cards in place: 3 running become 1 running + 2 finished in the same 3-card row", () => {
    const start = (id: string, description: string, second: number): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: `2026-03-17T10:00:0${second}.000Z`,
      event: { type: "subagent_started", taskId: id, agentId: id, description, turnId: "turn-1" },
    });
    const finish = (id: string, second: number): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: `2026-03-17T10:00:${second}.000Z`,
      event: { type: "subagent_result", taskId: id, agentId: id, status: "completed", summary: `${id} completed`, turnId: "turn-1" },
    });
    const spawns = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T09:59:59.000Z",
        event: { type: "user_message", text: "use parallel agents", turnId: "turn-1" },
      } satisfies AgentChatEventEnvelope,
      start("desktop", "Desktop architecture map", 1),
      start("sync", "Sync and shared contracts", 2),
      start("cli", "CLI and brain map", 3),
    ];
    const rendered = renderMessageList(spawns);
    const gridBefore = rendered.container.querySelector("[data-subagent-card-grid]")!;
    const rowBefore = gridBefore.closest("[data-chat-row-key]")!;
    expect(rowBefore.getAttribute("data-chat-row-key")).toBe("subagent-spawn:desktop");

    rendered.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={[...spawns, finish("sync", 20), finish("cli", 21)]} />
        <LocationProbe />
      </MemoryRouter>,
    );
    const grids = rendered.container.querySelectorAll("[data-subagent-card-grid]");
    expect(grids).toHaveLength(1);
    const grid = grids[0]!;
    // The same row element, still one 3-card grid, in the original order.
    expect(grid.closest("[data-chat-row-key]")).toBe(rowBefore);
    expect(grid.getAttribute("data-subagent-card-count")).toBe("3");
    expect([...grid.querySelectorAll("[data-subagent-card-key]")].map((cell) => cell.getAttribute("data-subagent-card-key")))
      .toEqual(["subagent-spawn:desktop", "subagent-spawn:sync", "subagent-spawn:cli"]);
    expect([...grid.querySelectorAll("[data-subagent-card]")].map((card) => card.getAttribute("data-subagent-status")))
      .toEqual(["running", "completed", "completed"]);
    expect([...grid.querySelectorAll("[data-subagent-name]")].map((node) => node.textContent))
      .toEqual(["Desktop architecture map", "Sync and shared contracts", "CLI and brain map"]);
  });

  it("resolves a jump to a card inside a grid to the grid's row", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T09:59:00.000Z",
        event: { type: "user_message", text: "Scan both.", turnId: "turn-1" },
      },
      ...["agent-a", "agent-b"].flatMap((id, index): AgentChatEventEnvelope[] => [{
        sessionId: "session-1",
        timestamp: `2026-03-17T10:00:0${index}.000Z`,
        event: { type: "subagent_started", taskId: id, agentId: id, agentType: "Explore", description: `Scan ${id}`, turnId: "turn-1" },
      }]),
      ...["agent-a", "agent-b"].map((id, index): AgentChatEventEnvelope => ({
        sessionId: "session-1",
        timestamp: `2026-03-17T10:00:1${index}.000Z`,
        event: { type: "subagent_result", taskId: id, agentId: id, status: "completed", summary: `${id} done`, turnId: "turn-1" },
      })),
    ];
    const view = renderMessageList(events);
    const transcript = document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    expect(transcript.querySelector("[data-chat-row-key='subagent-result:agent-b']")).toBeNull();

    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={events} scrollToRowKeyRequest={{ key: "subagent-result:agent-b", requestId: 1 }} />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(transcript.scrollTop).toBeGreaterThan(0);
  });

  it("lands a jump to an old subagent-result key on the card that settled in place", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T09:59:00.000Z",
        event: { type: "user_message", text: "Scan both.", turnId: "turn-1" },
      },
      ...["agent-a", "agent-b"].map((id, index): AgentChatEventEnvelope => ({
        sessionId: "session-1",
        timestamp: `2026-03-17T10:00:0${index}.000Z`,
        event: { type: "subagent_started", taskId: id, agentId: id, agentType: "Explore", description: `Scan ${id}`, turnId: "turn-1" },
      })),
      ...Array.from({ length: 12 }, (_, index): AgentChatEventEnvelope => ({
        sessionId: "session-1",
        timestamp: `2026-03-17T10:01:${String(index).padStart(2, "0")}.000Z`,
        event: { type: "text", text: `Parent note ${index}.`, messageId: `note-${index}`, turnId: "turn-1" },
      })),
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:02:00.000Z",
        event: { type: "subagent_result", taskId: "agent-b", agentId: "agent-b", status: "completed", summary: "b done", turnId: "turn-1" },
      },
    ];
    const jumpTo = (key: string) => {
      const view = renderMessageList(events);
      const transcript = document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
      Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 50_000 });
      Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
      // No row carries the result key: the card kept its spawn key.
      expect(transcript.querySelector("[data-chat-row-key='subagent-result:agent-b']")).toBeNull();
      expect(transcript.querySelector("[data-subagent-card-key='subagent-spawn:agent-b'] [data-subagent-status='completed']"))
        .toBeTruthy();
      view.rerender(
        <MemoryRouter initialEntries={[{ pathname: "/" }]}>
          <AgentChatMessageList events={events} scrollToRowKeyRequest={{ key, requestId: 1 }} />
          <LocationProbe />
        </MemoryRouter>,
      );
      const top = transcript.scrollTop;
      view.unmount();
      return top;
    };
    const viaGridRow = jumpTo("subagent-spawn:agent-a");
    expect(viaGridRow).toBeGreaterThan(0);
    // The old result key lands exactly where the card's own row does, not at the tail.
    expect(jumpTo("subagent-result:agent-b")).toBe(viaGridRow);
    expect(jumpTo("subagent-spawn:agent-b")).toBe(viaGridRow);
  });

  it("anchors a subagent result event to the card it settled, not to the last row", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T09:59:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "Scan.", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        sequence: 2,
        event: { type: "subagent_started", taskId: "agent-a", agentId: "agent-a", description: "Scan A", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        sequence: 3,
        event: { type: "text", text: "Waiting on the scan.", messageId: "m-1", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        sequence: 4,
        event: { type: "subagent_result", taskId: "agent-a", agentId: "agent-a", status: "completed", summary: "done", turnId: "turn-1" },
      },
    ];
    const groupedRows = groupChatTranscriptRows(collapseChatTranscriptEvents(events));
    expect(groupedRows.map((row) => row.key)).toContain("subagent-spawn:agent-a");
    const cardIndex = groupedRows.findIndex((row) => row.key === "subagent-spawn:agent-a");
    expect(cardIndex).toBe(1);
    expect(resolveAnchoredChatRowIndex({ events, groupedRows, anchorEvent: 4, hasFullHistory: false })).toBe(cardIndex);
  });

  it("marks inline subagent cards with the chat's runtime provider", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-a",
          agentId: "agent-a",
          agentType: "Explore",
          description: "Inspect the info pane",
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
          summary: "Pane mapped",
          turnId: "turn-1",
        },
      },
    ], { sessionProvider: "opencode" });

    const marks = [...rendered.container.querySelectorAll("[data-subagent-provider]")];
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => mark.getAttribute("data-subagent-provider") === "opencode")).toBe(true);
  });

  it("prefers a spawned child chat's own provider for its card mark", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "chat:child-9",
          agentId: "child-9",
          agentType: "Codex",
          description: "Investigate the failure",
          spawnKind: "subagent",
          turnId: "turn-1",
        },
      },
    ], {
      sessionProvider: "claude",
      resolveSpawnedChatProvider: (sessionId) => (sessionId === "child-9" ? "codex" : null),
    });

    const marks = [...rendered.container.querySelectorAll("[data-subagent-provider]")];
    expect(marks.map((mark) => mark.getAttribute("data-subagent-provider"))).toContain("codex");
  });

  it("uses an explicit Codex provider for a resumed CLI child inside a Claude parent", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "chat:cli-child",
          agentId: "cli-child",
          provider: "codex",
          agentType: "codex",
          taskType: "subagent",
          description: "Fix flaky tests",
          spawnKind: "subagent",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:01:00.000Z",
        event: {
          type: "subagent_result",
          taskId: "chat:cli-child",
          agentId: "cli-child",
          provider: "codex",
          agentType: "codex",
          status: "completed",
          summary: "Old run completed.",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:05:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "chat:cli-child",
          agentId: "cli-child",
          provider: "codex",
          agentType: "codex",
          taskType: "subagent",
          description: "Fix flaky tests",
          spawnKind: "subagent",
          resumed: true,
        },
      },
    ], { sessionProvider: "claude" });

    const card = rendered.container.querySelector("[data-subagent-card-key='subagent-spawn:chat:cli-child']");
    expect(card?.querySelector("[data-subagent-status='running']")).toBeTruthy();
    expect(card?.querySelector("[data-subagent-provider='codex']")).toBeTruthy();
    expect(card?.textContent).not.toContain("Old run completed.");
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

    // The turn surfaces task progress as the chat's one collapsed task-list
    // line; opening it lists every item.
    expect(screen.getByTestId("chat-task-list-card").textContent).toMatch(/Tasks·1\/2·Refine summary card/);
    fireEvent.click(within(screen.getByTestId("chat-task-list-card")).getByRole("button", { expanded: false }));
    expect(rendered.container.textContent).toMatch(/Inspect chat renderer/);
    expect(screen.getAllByText("Refine summary card").length).toBeGreaterThanOrEqual(1);

    // Files sit on the turn line. Opening that control shows the paths and Review in Files.
    expect(rendered.container.textContent).toContain("1 file changed");
    fireEvent.click(screen.getByRole("button", { name: "Show files changed" }));
    expect(screen.getAllByText("+1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("−1").length).toBeGreaterThanOrEqual(1);

    // The turn summary's action opens the Files tab for the lane — it is NOT a
    // revert (reverting is checkpoint-scoped and lives on the turn_diff_summary
    // panel), so it is labelled for what it does.
    fireEvent.click(screen.getByRole("button", { name: "Review in Files" }));
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

  it("renders a plan with structured steps as the task list, not as plan markdown", () => {
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

    fireEvent.click(within(screen.getByTestId("chat-task-list-card")).getByRole("button", { expanded: false }));
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

    // The controls moved to the composer; the transcript row is the record.
    const row = screen.getByTestId("open-question-receipt");
    expect(row.textContent ?? "").toContain("Codex asks");
    expect(row.textContent ?? "").toContain("Focus");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(onApproval).not.toHaveBeenCalled();
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

    // The first resolution wins; the receipt records the decline rather than
    // letting the request vanish, and no stale option control survives.
    expect(screen.getByTestId("answered-question-receipt").textContent ?? "").toContain("you declined");
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
    expect(rendered.container.textContent).toMatch(/1\/2/);
    fireEvent.click(within(screen.getByTestId("chat-task-list-card")).getByRole("button", { expanded: false }));
    expect(rendered.container.textContent).toMatch(/Inspect shared renderer/);
    expect(rendered.container.textContent).toContain("1 file changed");
    fireEvent.click(screen.getByRole("button", { name: "Show files changed" }));

    fireEvent.click(screen.getByRole("button", { name: "Review in Files" }));
    expect(screen.getByTestId("location").textContent).toBe(
      "/files::{\"laneId\":\"lane-123\"}",
    );
  });

  it("names the next pending task on the collapsed line when nothing is running", () => {
    renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "todo_update",
          turnId: "turn-9",
          items: [
            { id: "task-1", description: "Search the web", status: "pending" },
            { id: "task-2", description: "Fetch one result", status: "pending" },
          ],
        },
      },
    ]);
    expect(screen.getByTestId("chat-task-list-current").textContent).toBe("Next: Search the web");
    expect(screen.getByTestId("chat-task-list-card").textContent).toMatch(/Tasks·0\/2·Next: Search the web/);
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

    // A settled list reads "All done" collapsed; the item is one click away.
    expect(screen.getByTestId("chat-task-list-card").textContent).toMatch(/Tasks·1\/1·All done/);
    fireEvent.click(within(screen.getByTestId("chat-task-list-card")).getByRole("button", { expanded: false }));
    expect(rendered.container.textContent).toMatch(/Investigate Claude turn status/);
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

describe("AgentChatMessageList question receipts", () => {
  // The question's controls live in the composer now (see
  // AskQuestionComposer.test.tsx). The transcript keeps only the record.
  const buildStructuredApprovalEvent = (overrides: {
    questions: Array<Record<string, unknown>>;
    options?: Array<Record<string, unknown>>;
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
          ...(overrides.options ? { options: overrides.options } : {}),
          allowsFreeform: true,
          blocking: true,
          canProceedWithoutAnswer: false,
        },
      },
    },
  });

  const planQuestions = [
    {
      id: "plan_choice",
      header: "Plan",
      question: "Which plan should we follow?",
      options: [
        { label: "Rebase", value: "rebase", description: "Fast-forward replay.", recommended: true },
        { label: "Merge", value: "merge", description: "Preserve history." },
      ],
      allowsFreeform: true,
    },
  ];

  const resolvedEvent = (
    resolution: "accepted" | "declined" | "cancelled",
    answers?: Record<string, string | string[]>,
  ): AgentChatEventEnvelope => ({
    sessionId: "session-ask",
    timestamp: "2026-04-20T10:00:05.000Z",
    event: {
      type: "pending_input_resolved",
      itemId: "approval-ask",
      resolution,
      ...(answers ? { answers } : {}),
      turnId: "turn-ask",
    },
  });

  it("renders an awaiting-you row while the question is still open, with no answer controls", () => {
    const onApproval = vi.fn();
    renderMessageList([buildStructuredApprovalEvent({ questions: planQuestions })], { onApproval });

    const row = screen.getByTestId("open-question-receipt");
    expect(row.textContent ?? "").toContain("ADE asks");
    expect(row.textContent ?? "").toContain("Plan");
    expect(row.textContent ?? "").toContain("Answer it in the composer below.");
    // No radios, no Send: the transcript is a record, not a control surface.
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByTestId("ask-question-send")).toBeNull();
    expect(onApproval).not.toHaveBeenCalled();
  });

  it("reads the answer back on the receipt once resolved", () => {
    renderMessageList([
      buildStructuredApprovalEvent({ questions: planQuestions }),
      resolvedEvent("accepted", { plan_choice: ["rebase", "only if CI is green"] }),
    ]);

    const receipt = screen.getByTestId("answered-question-receipt");
    expect(receipt.textContent ?? "").toContain("Rebase");
    expect(receipt.textContent ?? "").toContain("answered");
    expect(screen.queryByTestId("answered-question-receipt-detail")).toBeNull();

    fireEvent.click(screen.getByTestId("answered-question-receipt-toggle"));
    const detail = screen.getByTestId("answered-question-receipt-detail");
    expect(detail.textContent ?? "").toContain("Plan");
    expect(detail.textContent ?? "").toContain("Rebase");
    expect(detail.textContent ?? "").toContain("only if CI is green");
  });

  it("regression: labels legacy request-level option answers as picks, not notes", () => {
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [{
          id: "plan_choice",
          header: "Plan",
          question: "Which plan should we follow?",
          options: [],
          allowsFreeform: false,
        }],
        options: [{ label: "Rebase", value: "rebase" }],
      }),
      resolvedEvent("accepted", { plan_choice: "rebase" }),
    ]);

    const receipt = screen.getByTestId("answered-question-receipt");
    expect(receipt.textContent ?? "").toContain("Rebase");
    fireEvent.click(screen.getByTestId("answered-question-receipt-toggle"));
    const detail = screen.getByTestId("answered-question-receipt-detail");
    expect(detail.textContent ?? "").toContain("Rebase");
    expect(detail.textContent ?? "").not.toContain("note:");
  });

  it("records a declined request rather than dropping it", () => {
    renderMessageList([
      buildStructuredApprovalEvent({ questions: planQuestions }),
      resolvedEvent("declined"),
    ]);

    const receipt = screen.getByTestId("answered-question-receipt");
    expect(receipt.textContent ?? "").toContain("you declined");
    expect(receipt.textContent ?? "").toContain("proceeded on its own assumption");
  });

  // The answer to an isSecret question never reaches the (durable, synced)
  // resolution event, so there is nothing for the receipt to show.
  it("regression: a secret question's answer is never displayed", () => {
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [
          { id: "token", header: "Token", question: "Paste the deploy token", isSecret: true, allowsFreeform: true },
        ],
      }),
      resolvedEvent("accepted"),
    ]);

    fireEvent.click(screen.getByTestId("answered-question-receipt-toggle"));
    const receipt = screen.getByTestId("answered-question-receipt");
    expect(receipt.textContent ?? "").toContain("answer hidden");
  });

  it("regression: a declined secret question is unanswered, not hidden", () => {
    renderMessageList([
      buildStructuredApprovalEvent({
        questions: [
          { id: "token", header: "Token", question: "Paste the deploy token", isSecret: true, allowsFreeform: true },
        ],
      }),
      resolvedEvent("declined"),
    ]);

    fireEvent.click(screen.getByTestId("answered-question-receipt-toggle"));
    const detail = screen.getByTestId("answered-question-receipt-detail");
    expect(detail.textContent ?? "").toContain("unanswered");
    expect(detail.textContent ?? "").not.toContain("answer hidden");
  });

  it("degrades to a bare answered receipt on a transcript with no recorded answers", () => {
    renderMessageList([
      buildStructuredApprovalEvent({ questions: planQuestions }),
      resolvedEvent("accepted"),
    ]);

    const receipt = screen.getByTestId("answered-question-receipt");
    expect(receipt.textContent ?? "").toContain("answered");
    fireEvent.click(screen.getByTestId("answered-question-receipt-toggle"));
    expect(screen.getByTestId("answered-question-receipt-detail").textContent ?? "")
      .toContain("no answer recorded");
  });
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

describe("AgentChatMessageList ade_card dispatch", () => {
  afterEach(() => cleanup());

  const cardEnvelope = (
    over: Record<string, unknown> = {},
  ): AgentChatEventEnvelope => ({
    sessionId: "s1",
    timestamp: "2026-07-27T12:00:00.000Z",
    event: {
      type: "ade_card",
      cardId: "run-42",
      variant: "proof_artifact",
      state: "terminal",
      title: "Cloud artifacts pulled",
      fallbackText: "3 cloud artifacts pulled into the lane",
      metrics: [{ label: "files", value: "3" }],
      ...over,
    } as never,
  });

  it("renders the card in the transcript", () => {
    renderMessageList([cardEnvelope()]);
    expect(screen.getByText("Cloud artifacts pulled")).toBeTruthy();
    expect(screen.getByText("files")).toBeTruthy();
  });

  it("shows one card, not two, when the same cardId is emitted twice", () => {
    renderMessageList([
      cardEnvelope({ state: "live", title: "Pulling cloud artifacts" }),
      cardEnvelope({ title: "Cloud artifacts pulled" }),
    ]);
    expect(screen.queryByText("Pulling cloud artifacts")).toBeNull();
    expect(screen.getAllByText("Cloud artifacts pulled")).toHaveLength(1);
  });

  it("degrades an unknown variant to its fallbackText", () => {
    renderMessageList([
      cardEnvelope({ variant: "future_ci", title: "CI failed", fallbackText: "CI failed · 1 failed" }),
    ]);
    expect(screen.getByText("CI failed · 1 failed")).toBeTruthy();
    expect(screen.queryByText("CI failed")).toBeNull();
  });

  // Previously the transcript passed no `onAction`, and `<AdeCard>` filters out
  // every action it cannot route — so the schema's action row was unreachable
  // by construction. It is now dispatched.
  it("renders a host action and broadcasts it as ade:chat:card-action", () => {
    const listener = vi.fn();
    window.addEventListener("ade:chat:card-action", listener);
    try {
      renderMessageList([
        cardEnvelope({ actions: [{ id: "open-lane", label: "Open lane", kind: "primary" }] }),
      ]);
      fireEvent.click(screen.getByText("Open lane"));
      expect(listener).toHaveBeenCalledTimes(1);
      const detail = (listener.mock.calls[0]![0] as CustomEvent).detail;
      expect(detail).toMatchObject({ actionId: "open-lane", cardId: "run-42", variant: "proof_artifact" });
    } finally {
      window.removeEventListener("ade:chat:card-action", listener);
    }
  });

  it("routes retry back through the card's own surface rather than a dead broadcast", () => {
    const navListener = vi.fn();
    window.addEventListener(ADE_NAVIGATE_TARGET_EVENT, navListener);
    try {
      renderMessageList([
        cardEnvelope({
          variant: "pr_ci",
          title: "CI is running",
          degradedReason: "Couldn’t read the job list from GitHub — 403",
          navTarget: { kind: "pr", repoOwner: "arul28", repoName: "ADE", prNumber: 916 },
          actions: [{ id: "retry", label: "Retry", kind: "primary" }],
        }),
      ]);
      fireEvent.click(screen.getByText("Retry"));
      expect(navListener).toHaveBeenCalled();
    } finally {
      window.removeEventListener(ADE_NAVIGATE_TARGET_EVENT, navListener);
    }
  });

  it("says the detail is unavailable instead of showing a content-free green card", () => {
    renderMessageList([
      cardEnvelope({
        variant: "pr_ci",
        title: "CI passed",
        metrics: [],
        degradedReason: "Couldn’t read the job list from GitHub — 403",
      }),
    ]);
    expect(screen.getByText("detail unavailable")).toBeTruthy();
    expect(screen.getByText(/403/)).toBeTruthy();
  });
});

/**
 * The transcript's ONE content width.
 *
 * Before `--chat-content-width` there were seven disagreeing clamps in this
 * directory, and the worst offender resolved `70` characters against the
 * browser's 16px default (no card sets a font-size), so every card stopped
 * ~26% short of the prose above it. This guard is source-level on purpose: a
 * jsdom render cannot catch a clamp on a code path that happens not to be
 * exercised.
 */
describe("chat transcript content width", () => {
  const chatDir = path.dirname(fileURLToPath(import.meta.url));

  /** Components only — a test file may name the old clamp to explain it. */
  function chatComponentFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return chatComponentFiles(full);
      if (/\.test\.tsx?$/.test(entry.name)) return [];
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("has no `ch`-relative card clamp left anywhere under components/chat", () => {
    const offenders = chatComponentFiles(chatDir)
      .filter((file) => fs.readFileSync(file, "utf8").includes("70ch"))
      .map((file) => path.basename(file));
    expect(offenders).toEqual([]);
  });

  it("routes every transcript-row max-width through the shared token", () => {
    // `max-w-[min(100%, …)]` is the row-level idiom the redesign unified. A
    // bare `max-w-[22rem]` on a nested control is a different thing and stays.
    const offenders: string[] = [];
    for (const file of chatComponentFiles(chatDir)) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/max-w-\[min\(100%,\s*[^\]]*\)\]/g)) {
        offenders.push(`${path.basename(file)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("turn-level file-change de-clutter", () => {
  const writeEntry = (id: string, filePath: string, additions: number, deletions: number) => ({
    id,
    createdAt: "2026-03-17T10:00:00.000Z",
    label: "Edit",
    tone: "tool" as const,
    status: "success" as const,
    entryKind: "file_change" as const,
    turnId: "turn-1",
    changedFiles: [{ path: filePath, kind: "modify" as const, additions, deletions, diff: "" }],
  });

  it("does not double a turn's diffstat when a work-log group carries a turnId", () => {
    // `deriveTranscriptToolActivity` concatenates its by-turn-id accumulator
    // with the pending segment, and a group with a turnId lands in BOTH. The
    // files-changed summary reads these raw entries, so without an id-dedupe
    // every +/- count renders at exactly 2x.
    const rows = groupConsecutiveWorkLogRows([
      {
        key: "work-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "work_log_entry",
          entry: writeEntry("entry-1", "/root/apps/desktop/src/a.ts", 3, 1),
        },
      },
      {
        key: "done-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ] as never);

    const activity = deriveTranscriptToolActivity(rows as never);
    const fileEntries = activity.fileEntriesByDoneRowKey.get("done-1") ?? [];
    expect(fileEntries).toHaveLength(1);
    const additions = fileEntries.flatMap((entry) => entry.changedFiles ?? [])
      .reduce((sum, file) => sum + file.additions, 0);
    expect(additions).toBe(3);
  });

  it("names the file being written in the working indicator", () => {
    expect(
      resolveWorkingIndicatorLabel("editing_file", [
        writeEntry("entry-1", "/root/apps/desktop/src/main/services/lanes/laneService.ts", 1, 0) as never,
      ]),
    ).toBe("Editing laneService.ts");
  });

  it("labels every activity the runtimes emit", () => {
    // An unmapped activity falls through to the raw identifier, so a gap here
    // puts `web_searching` on screen. Both were emitted and unmapped.
    expect(resolveWorkingIndicatorLabel("web_searching", [])).toBe("Searching the web");
    expect(resolveWorkingIndicatorLabel("spawning_agent", [])).toBe("Starting agent");
  });

  it("falls back to the bare verb when the edit target is unknown", () => {
    expect(resolveWorkingIndicatorLabel("editing_file", [])).toBe("Editing");
    expect(resolveWorkingIndicatorLabel("thinking", [])).toBe("Thinking");
    expect(resolveWorkingIndicatorLabel(null, [])).toBeNull();
  });

  it("keeps per-burst file panels out of the timeline", () => {
    // One turn, two edit bursts split by prose: the thread must show ONE
    // files-changed summary (at the turn's end), not one per burst.
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "file_change", kind: "modify", path: "/root/apps/a.ts", additions: 1, deletions: 0, diff: "", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "text", text: "Now the second file.", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "file_change", kind: "modify", path: "/root/apps/b.ts", additions: 2, deletions: 0, diff: "", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:03.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ] as never);

    expect(rendered.container.textContent).toContain("2 files changed");
    const text = rendered.container.textContent ?? "";
    // Find the closing time by SHAPE, and take the LAST one.
    //
    // This asserted `lastIndexOf("10:00")` — the UTC hour of the fixture
    // timestamp. The app renders times in the LOCAL zone, so off UTC the
    // string is never present, `lastIndexOf` answers -1, and the assertion
    // compares against "not found" instead of a position. It passed only
    // because CI runners are UTC; it failed on any developer machine that is
    // not, which is exactly backwards from what a test should do.
    //
    // The last match is the one that matters: the turn also renders an OPENING
    // time, so a first-match search would compare against the wrong end and
    // claim the summary is below the time when it is above it.
    const timeIndexes = [...text.matchAll(/\d{1,2}:\d{2}/g)].map((match) => match.index ?? -1);
    expect(timeIndexes.length).toBeGreaterThan(0);
    expect(text.lastIndexOf("files changed")).toBeGreaterThan(timeIndexes[timeIndexes.length - 1]!);
  });

  it("combines tools and files on one line above the done-divider time", () => {
    const rendered = renderMessageList([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "tool_call", tool: "Read", args: { path: "a.ts" }, itemId: "t-1", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "file_change", kind: "modify", path: "/root/apps/a.ts", additions: 1, deletions: 0, diff: "", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ] as never);

    // One tool reads "1 tool" (count and noun are separate spans).
    expect(rendered.container.textContent).toContain("1tool");
    expect(rendered.container.textContent).not.toContain("1tools");
    expect(rendered.container.textContent).toContain("1 file changed");
    const text = rendered.container.textContent ?? "";
    expect(text.indexOf("1tool")).toBeGreaterThan(text.search(/\d{1,2}:\d{2}/));
    expect(text.indexOf("file changed")).toBeGreaterThan(text.indexOf("1tool"));
  });
});

describe("older-history prefetch runway", () => {
  it("starts the fetch two viewport-heights before the top", () => {
    // The reader used to arrive at the top BEFORE the request went out, so a
    // page load was always a visible stall.
    expect(resolveOlderHistoryPrefetchTriggerPx(800)).toBe(1600);
  });

  it("never shrinks below the near-top fallback", () => {
    // Short panes and pre-measurement (clientHeight 0 in jsdom / first paint)
    // keep the original near-top trigger rather than disabling paging.
    expect(resolveOlderHistoryPrefetchTriggerPx(0)).toBe(300);
    expect(resolveOlderHistoryPrefetchTriggerPx(100)).toBe(300);
    expect(resolveOlderHistoryPrefetchTriggerPx(Number.NaN)).toBe(300);
  });

  it("requests an older page while still two screens from the top", async () => {
    const onLoadOlderHistory = vi.fn();
    const rendered = renderMessageList(
      [
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:00.000Z",
          event: { type: "text", text: "hello", turnId: "turn-1" },
        },
      ] as never,
      { hasOlderHistory: true, onLoadOlderHistory },
    );

    const pane = rendered.container.querySelector(".ade-chat-timeline-pane");
    expect(pane).not.toBeNull();
    Object.defineProperty(pane!, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(pane!, "scrollHeight", { value: 20_000, configurable: true });
    onLoadOlderHistory.mockClear();

    // 900px from the top: outside the old 300px trigger, inside the new runway.
    Object.defineProperty(pane!, "scrollTop", { value: 900, configurable: true, writable: true });
    fireEvent.scroll(pane!);

    await waitFor(() => expect(onLoadOlderHistory).toHaveBeenCalled());
  });
});

describe("transcript tool-activity identity stability", () => {
  // ONE entry object reused across builds — that is what production does: the
  // entries come from the cached collapse pipeline, so a settled turn hands back
  // the same objects on every rebuild. Fresh objects per call would model a
  // transcript that never reuses anything and defeat the check under test.
  const settledEntry = {
    id: "entry-1",
    createdAt: "2026-03-17T10:00:00.000Z",
    label: "Edit",
    tone: "tool",
    status: "success",
    entryKind: "file_change",
    turnId: "turn-1",
    changedFiles: [{ path: "/root/a.ts", kind: "modify", additions: 1, deletions: 0, diff: "" }],
  };
  const buildRows = (tail: string) => groupConsecutiveWorkLogRows([
    {
      key: "work-1",
      timestamp: "2026-03-17T10:00:00.000Z",
      event: { type: "work_log_entry", entry: settledEntry },
    },
    {
      key: "done-1",
      timestamp: "2026-03-17T10:00:01.000Z",
      event: { type: "done", turnId: "turn-1", status: "completed" },
    },
    {
      key: `text-${tail}`,
      timestamp: "2026-03-17T10:00:02.000Z",
      event: { type: "text", text: tail, turnId: "turn-2" },
    },
  ] as never);

  it("reuses a settled turn's arrays when a later delta arrives", () => {
    // Without this, every streaming tick hands each done row brand-new arrays
    // and React.memo misses on every completed turn in the thread.
    const first = deriveTranscriptToolActivity(buildRows("a") as never);
    const second = deriveTranscriptToolActivity(buildRows("ab") as never);
    expect(second.byDoneRowKey.get("done-1")).not.toBe(first.byDoneRowKey.get("done-1"));

    const stabilized = stabilizeTranscriptToolActivity(first, second);
    expect(stabilized.byDoneRowKey.get("done-1")).toBe(first.byDoneRowKey.get("done-1"));
    expect(stabilized.fileEntriesByDoneRowKey.get("done-1")).toBe(first.fileEntriesByDoneRowKey.get("done-1"));
  });

  it("does not discard fresh file entries when only they changed", () => {
    // byDoneRowKey drops file_change entries, so a turn whose FILE changes moved
    // while its tool entries did not looks identical through that map alone —
    // guarding on it only would throw away the fresh fileEntriesByDoneRowKey.
    const first = deriveTranscriptToolActivity(buildRows("a") as never);
    const second = deriveTranscriptToolActivity(buildRows("a") as never);
    const changedFileEntries = new Map(second.fileEntriesByDoneRowKey);
    changedFileEntries.set("done-1", [{ ...settledEntry, id: "entry-2" } as never]);
    const mutated = { ...second, fileEntriesByDoneRowKey: changedFileEntries };

    const stabilized = stabilizeTranscriptToolActivity(first, mutated);
    expect(stabilized).not.toBe(first);
    expect(stabilized.fileEntriesByDoneRowKey.get("done-1")).toBe(
      changedFileEntries.get("done-1"),
    );
  });

  it("returns the previous object outright when nothing changed", () => {
    const first = deriveTranscriptToolActivity(buildRows("a") as never);
    const second = deriveTranscriptToolActivity(buildRows("a") as never);
    expect(stabilizeTranscriptToolActivity(first, second)).toBe(first);
  });
});

describe("streaming-delta identity stabilization", () => {
  afterEach(() => cleanup());

  it("reuses the previous Map when a delta leaves the resolved-input contents alone", () => {
    // `resolvedInputStates` / `resolvedInputAnswers` are rebuilt on every delta
    // (they memoize on `events`, whose identity changes per flush) but their
    // contents only move when a question is answered.
    const resolution = { state: "answered" } as const;
    const previous = new Map<string, { readonly state: string }>([["item-1", resolution]]);
    const rebuilt = new Map([["item-1", resolution]]);
    expect(sameMapContents(previous, rebuilt)).toBe(true);
    expect(sameMapContents(previous, new Map([["item-1", { state: "cancelled" } as const]]))).toBe(false);
    expect(sameMapContents(previous, new Map())).toBe(false);
    expect(sameMapContents(previous, new Map([["item-2", resolution]]))).toBe(false);
  });

  it("reuses the previous Set when a delta leaves the receipt/queue ids alone", () => {
    const previous = new Set(["a", "b"]);
    expect(sameSetContents(previous, new Set(["a", "b"]))).toBe(true);
    expect(sameSetContents(previous, new Set(["b", "a"]))).toBe(true);
    expect(sameSetContents(previous, new Set(["a"]))).toBe(false);
    expect(sameSetContents(previous, new Set(["a", "c"]))).toBe(false);
  });

  it("treats the row-key list as changed as soon as any key moves", () => {
    // Order matters: `rowHeight` indexes by position, so a reorder MUST be
    // reported as a change or the virtualizer would measure the wrong row.
    expect(sameKeyList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameKeyList(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameKeyList(["a", "b"], ["a", "b", "c"])).toBe(false);
  });

  describe("virtualized rows", () => {
    let observerConstructions = 0;
    let observerDisconnects = 0;
    let previousResizeObserver: unknown;

    beforeEach(() => {
      observerConstructions = 0;
      observerDisconnects = 0;
      previousResizeObserver = (globalThis as Record<string, unknown>).ResizeObserver;
      (globalThis as Record<string, unknown>).ResizeObserver = class {
        constructor() {
          observerConstructions += 1;
        }
        observe() {}
        unobserve() {}
        disconnect() {
          observerDisconnects += 1;
        }
      };
    });

    afterEach(() => {
      if (previousResizeObserver === undefined) {
        delete (globalThis as Record<string, unknown>).ResizeObserver;
      } else {
        (globalThis as Record<string, unknown>).ResizeObserver = previousResizeObserver;
      }
    });

    // 40 turns → 80 grouped rows, comfortably past the virtualization threshold
    // so every rendered row goes through MeasuredEventRow's ResizeObserver.
    const TURNS = 40;
    function buildTranscript(): AgentChatEventEnvelope[] {
      const built: AgentChatEventEnvelope[] = [];
      for (let turn = 0; turn < TURNS; turn += 1) {
        const stamp = String(turn).padStart(2, "0");
        built.push({
          sessionId: "s1",
          timestamp: `2026-03-17T10:${stamp}:00.000Z`,
          event: { type: "user_message", text: `ask ${turn}` },
        } as AgentChatEventEnvelope);
        built.push({
          sessionId: "s1",
          timestamp: `2026-03-17T10:${stamp}:01.000Z`,
          event: { type: "text", text: `reply ${turn}`, itemId: `text-${turn}`, turnId: `turn-${turn}` },
        } as AgentChatEventEnvelope);
      }
      return built;
    }

    const listOf = (events: AgentChatEventEnvelope[]) => (
      <MemoryRouter>
        <AgentChatMessageList events={events} sessionId="s1" assistantLabel="Assistant" showStreamingIndicator />
      </MemoryRouter>
    );

    it("does not tear down per-row ResizeObservers when a streaming delta extends the last row", () => {
      const base = buildTranscript();
      const view = render(listOf(base));
      expect(observerConstructions).toBeGreaterThan(0);
      const constructionsAfterMount = observerConstructions;
      const disconnectsAfterMount = observerDisconnects;

      // A streaming delta: same envelopes for every settled row, one longer
      // text on the tail — exactly what a token flush produces.
      const tail = base[base.length - 1]!;
      const delta = [
        ...base.slice(0, -1),
        { ...tail, event: { ...tail.event, text: `${(tail.event as { text: string }).text} more` } } as AgentChatEventEnvelope,
      ];
      act(() => {
        view.rerender(listOf(delta));
      });

      // `handleMeasure` (and the `rowHeight` it closes over) keep their identity
      // across the delta, so MeasuredEventRow's layout effect does not re-run.
      expect(observerDisconnects).toBe(disconnectsAfterMount);
      expect(observerConstructions).toBe(constructionsAfterMount);
    });

    it("still observes rows that genuinely appear (the counter is live)", () => {
      const base = buildTranscript();
      const view = render(listOf(base));
      const constructionsAfterMount = observerConstructions;

      const appended: AgentChatEventEnvelope[] = [
        ...base,
        {
          sessionId: "s1",
          timestamp: "2026-03-17T11:00:00.000Z",
          event: { type: "user_message", text: "one more ask" },
        } as AgentChatEventEnvelope,
      ];
      act(() => {
        view.rerender(listOf(appended));
      });

      expect(observerConstructions).toBeGreaterThan(constructionsAfterMount);
    });
  });
});

/**
 * Paced text reveal (see textReveal.ts). These tests cover the contract the
 * pacing must never break — the store text is always complete, and anything
 * that is not a live, growing tail paints in full immediately. The pacing math
 * itself is covered without rAF in textReveal.test.ts.
 */
describe("AgentChatMessageList — paced assistant text", () => {
  const streamingText = (text: string): AgentChatEventEnvelope[] => ([
    {
      sessionId: "session-1",
      timestamp: "2026-03-17T10:00:00.000Z",
      event: { type: "text", text, itemId: "text-stream", turnId: "turn-1" },
    },
  ]);

  it("paints a message that is already complete when it first mounts", () => {
    // Mounting mid-turn (history, virtualization remount, backfill) must not
    // type the message out from zero.
    renderMessageList(streamingText("The whole answer was already here."), {
      showStreamingIndicator: true,
    });
    expect(screen.getByText("The whole answer was already here.")).toBeTruthy();
  });

  it("holds back growth that arrives after mount while keeping the store text whole", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    const view = renderMessageList(streamingText("Alpha."), { showStreamingIndicator: true });
    act(() => {
      view.rerender(
        <MemoryRouter>
          <AgentChatMessageList
            events={streamingText("Alpha. Beta gamma delta.")}
            showStreamingIndicator
          />
        </MemoryRouter>,
      );
    });

    // Painted: only what has been revealed so far.
    expect(screen.getByText("Alpha.")).toBeTruthy();
    expect(screen.queryByText(/Beta gamma delta/)).toBeNull();
    // Stored: the whole thing — copy must never hand back a paced prefix.
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Alpha. Beta gamma delta."));
  });

  it("snaps to the full text the moment the row stops streaming", () => {
    const view = renderMessageList(streamingText("Alpha."), { showStreamingIndicator: true });
    act(() => {
      view.rerender(
        <MemoryRouter>
          <AgentChatMessageList
            events={streamingText("Alpha. Beta gamma delta.")}
            showStreamingIndicator
          />
        </MemoryRouter>,
      );
    });
    expect(screen.queryByText(/Beta gamma delta/)).toBeNull();

    // The turn ends (`done` / settle / a newer row takes the tail): the row is
    // no longer paced and everything must be on screen in that same commit.
    act(() => {
      view.rerender(
        <MemoryRouter>
          <AgentChatMessageList
            events={streamingText("Alpha. Beta gamma delta.")}
            showStreamingIndicator={false}
          />
        </MemoryRouter>,
      );
    });
    expect(screen.getByText("Alpha. Beta gamma delta.")).toBeTruthy();
  });

  it("never paces a row that is not the trailing streaming row", () => {
    const view = renderMessageList(
      [
        ...streamingText("Earlier block."),
        {
          sessionId: "session-1",
          timestamp: "2026-03-17T10:00:01.000Z",
          event: { type: "text", text: "Later block.", itemId: "text-2", turnId: "turn-1" },
        },
      ],
      { showStreamingIndicator: true },
    );
    // Growing the EARLIER row (a late edit/backfill) paints immediately: only
    // the trailing row is paced.
    act(() => {
      view.rerender(
        <MemoryRouter>
          <AgentChatMessageList
            events={[
              ...streamingText("Earlier block, extended by a backfill."),
              {
                sessionId: "session-1",
                timestamp: "2026-03-17T10:00:01.000Z",
                event: { type: "text", text: "Later block.", itemId: "text-2", turnId: "turn-1" },
              },
            ]}
            showStreamingIndicator
          />
        </MemoryRouter>,
      );
    });
    expect(screen.getByText("Earlier block, extended by a backfill.")).toBeTruthy();
  });

  it("paints growth on arrival while the row is scrolled out of view", () => {
    // Visibility must gate the BACKLOG, not just the frame loop. A row that
    // only stopped its loop would sit on a stale prefix for as long as it is
    // off screen, and the first sight after scrolling back would show a
    // truncated message that then types out the whole accumulated backlog.
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    let intersectionCallback: IntersectionObserverCallback | null = null;
    globalThis.IntersectionObserver = class {
      root = null;
      rootMargin = "";
      thresholds = [];
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    } as unknown as typeof IntersectionObserver;

    try {
      const view = renderMessageList(streamingText("Alpha."), { showStreamingIndicator: true });
      const observed = intersectionCallback as IntersectionObserverCallback | null;
      expect(observed).toBeTruthy();
      act(() => {
        observed!(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });

      act(() => {
        view.rerender(
          <MemoryRouter>
            <AgentChatMessageList
              events={streamingText("Alpha. Beta gamma delta.")}
              showStreamingIndicator
            />
          </MemoryRouter>,
        );
      });

      // First sight after scrolling back is the full current text — no rAF ran.
      expect(screen.getByText("Alpha. Beta gamma delta.")).toBeTruthy();
    } finally {
      globalThis.IntersectionObserver = originalIntersectionObserver;
    }
  });

  it("paints on arrival when the horizon override turns pacing off", () => {
    // The A/B kill switch: `ade.textRevealHorizonMs = 0` must restore the
    // exact pre-pacing behavior, growth included.
    localStorage.setItem(TEXT_REVEAL_HORIZON_STORAGE_KEY, "0");
    resetTextRevealHorizonCacheForTests();
    try {
      const view = renderMessageList(streamingText("Alpha."), { showStreamingIndicator: true });
      act(() => {
        view.rerender(
          <MemoryRouter>
            <AgentChatMessageList
              events={streamingText("Alpha. Beta gamma delta.")}
              showStreamingIndicator
            />
          </MemoryRouter>,
        );
      });
      expect(screen.getByText("Alpha. Beta gamma delta.")).toBeTruthy();
    } finally {
      localStorage.removeItem(TEXT_REVEAL_HORIZON_STORAGE_KEY);
      resetTextRevealHorizonCacheForTests();
    }
  });

  it("reports the revealed length, not the store length, to the perf sampler", () => {
    // The attribute only exists during a perf run; without one it must stay
    // absent so production writes nothing.
    renderMessageList(streamingText("Measured."), { showStreamingIndicator: true });
    const node = document.querySelector("[data-assistant-output]");
    expect(node).toBeTruthy();
    expect(node!.getAttribute("data-stream-text-len")).toBeNull();
  });

  it("still reports the painted length to the perf sampler when pacing is off", () => {
    // The OFF arm of the A/B has to measure something: with pacing disabled
    // the painted length IS the store length, and the sampler must see it.
    // Without this the OFF run finds no `[data-stream-text-len]` node at all
    // and scores a blank baseline.
    localStorage.setItem(TEXT_REVEAL_HORIZON_STORAGE_KEY, "0");
    resetTextRevealHorizonCacheForTests();
    setPerfActive(true);
    try {
      renderMessageList(streamingText("Measured."), { showStreamingIndicator: true });
      const node = document.querySelector("[data-assistant-output]");
      expect(node).toBeTruthy();
      expect(node!.getAttribute("data-stream-text-len")).toBe(String("Measured.".length));
    } finally {
      setPerfActive(false);
      localStorage.removeItem(TEXT_REVEAL_HORIZON_STORAGE_KEY);
      resetTextRevealHorizonCacheForTests();
    }
  });
});

describe("usage-limit turn footer", () => {
  const usageEnvelopes = (
    done: Record<string, unknown>,
  ): AgentChatEventEnvelope[] => ([
    {
      sessionId: "session-1",
      timestamp: "2026-09-08T19:00:00.000Z",
      event: { type: "user_message", text: "Keep shipping the fix.", turnId: "turn-limit" },
    },
    {
      sessionId: "session-1",
      timestamp: "2026-09-08T19:04:00.000Z",
      event: {
        type: "done",
        turnId: "turn-limit",
        status: "failed",
        usage: { inputTokens: 12_000, outputTokens: 3_400 },
        ...done,
      },
    } as AgentChatEventEnvelope,
  ]);

  it("still shows the turn work summary on a usage-limit pause", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-09-08T19:00:00.000Z",
        event: { type: "user_message", text: "Keep shipping the fix.", turnId: "turn-limit" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-09-08T19:02:00.000Z",
        event: {
          type: "command",
          command: "npm test",
          cwd: "/repo",
          output: "ok",
          itemId: "command-1",
          turnId: "turn-limit",
          status: "completed",
          exitCode: 0,
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-09-08T19:04:00.000Z",
        event: {
          type: "done",
          turnId: "turn-limit",
          status: "failed",
          terminalReason: "api_error",
          apiErrorStatus: 429,
          usage: { inputTokens: 12_000, outputTokens: 3_400 },
        },
      } as AgentChatEventEnvelope,
    ];
    const rendered = renderMessageList(events);
    expect(rendered.container.textContent).toContain("1tool");
    expect(screen.getByText(/^Paused · usage limit/)).toBeTruthy();
    expect(rendered.container.textContent!.indexOf("Paused · usage limit"))
      .toBeLessThan(rendered.container.textContent!.indexOf("1tool"));
  });

  it("replaces the red FAILED line with one quiet paused line on a terminal 429", () => {
    renderMessageList(usageEnvelopes({ terminalReason: "api_error", apiErrorStatus: 429 }));

    expect(screen.getByText(/^Paused · usage limit/)).toBeTruthy();
    expect(screen.queryByText("failed")).toBeNull();
  });

  it("moves the usage row behind the details toggle for that turn", () => {
    renderMessageList(usageEnvelopes({ terminalReason: "api_error", apiErrorStatus: 429 }));

    // The token accounting is still reachable — it just stops competing with
    // the one fact that matters (when this chat comes back).
    expect(screen.queryByTestId("done-turn-usage-detail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details from this turn" }));
    expect(screen.getByTestId("done-turn-usage-detail").textContent).toContain("12.0k");
  });

  it("goes quiet for the turn the host's live resume state is anchored to", () => {
    renderMessageList(usageEnvelopes({}), {
      usageLimitResumeActive: true,
      usageLimitResumeTurnId: "turn-limit",
    });

    expect(screen.getByText(/^Paused · usage limit/)).toBeTruthy();
  });

  it("leaves every other failure loud", () => {
    renderMessageList(usageEnvelopes({ terminalReason: "api_error", apiErrorStatus: 529 }), {
      usageLimitResumeActive: true,
      usageLimitResumeTurnId: "turn-other",
    });

    expect(screen.queryByText(/^Paused · usage limit/)).toBeNull();
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("stands the quota card down while the composer pill owns the limit", () => {
    const quotaCard: AgentChatEventEnvelope = {
      sessionId: "session-1",
      timestamp: "2026-09-08T19:04:01.000Z",
      event: {
        type: "ade_card",
        cardId: "quota-1",
        variant: "claude_session_quota",
        // `live`, not `terminal`: a terminal quota card is the dismissed-after-
        // rebind row every client already hides (`adeCardIsHiddenAfterDismiss`).
        state: "live",
        title: "Claude session limit · resets 7:00 PM",
        subtitle: "Send again after reset, or fork this thread.",
        fallbackText: "Claude session limit",
        actions: [{ id: "fork-local", label: "Fork in this lane", kind: "primary" }],
      },
    } as AgentChatEventEnvelope;

    const events = [...usageEnvelopes({ terminalReason: "api_error", apiErrorStatus: 429 }), quotaCard];
    const withPill = renderMessageList(events, { usageLimitResumeActive: true });
    expect(withPill.container.textContent).not.toContain("Claude session limit");
    cleanup();

    // Once the limit clears the card renders exactly as before, so an old
    // transcript still reads.
    const withoutPill = renderMessageList(events, { usageLimitResumeActive: false });
    expect(withoutPill.container.textContent).toContain("Claude session limit");
  });
});

describe("AgentChatMessageList voice calls", () => {
  function voiceEnvelope(
    sequence: number,
    event: AgentChatEventEnvelope["event"],
    voiceCallId?: string,
  ): AgentChatEventEnvelope {
    return {
      sessionId: "session-voice",
      timestamp: new Date(Date.UTC(2026, 8, 16, 12, 0, sequence)).toISOString(),
      sequence,
      event,
      ...(voiceCallId ? { provenance: { voiceCallId } } : {}),
    } as AgentChatEventEnvelope;
  }

  const callEvents: AgentChatEventEnvelope[] = [
    voiceEnvelope(1, { type: "user_message", text: "what is failing on main?", deliveryState: "delivered" }, "call-1"),
    voiceEnvelope(2, { type: "text", text: "Two checks are red.", itemId: "a-1" }, "call-1"),
    voiceEnvelope(3, { type: "user_message", text: "fix the first one", deliveryState: "delivered" }, "call-1"),
  ];

  it("renders a whole call collapsed as one card, not as loose bubbles", () => {
    renderMessageList(callEvents);

    const card = screen.getByTestId("voice-call-card");
    expect(card.getAttribute("data-voice-call-id")).toBe("call-1");
    expect(card.textContent).toContain("Voice call");
    expect(card.textContent).toContain("2 exchanges");
    expect(card.textContent).toContain("what is failing on main?");
    // Collapsed is the default: nothing the model said is in the transcript yet.
    expect(document.body.textContent).not.toContain("Two checks are red.");
    expect(screen.queryByTestId("voice-call-rows")).toBeNull();
  });

  it("reveals the call's own rows when expanded", () => {
    renderMessageList(callEvents);

    const toggle = screen.getByRole("button", { expanded: false, name: /Voice call/ });
    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: /Voice call/ }).getAttribute("aria-expanded")).toBe("true");
    const rows = screen.getByTestId("voice-call-rows");
    expect(rows.textContent).toContain("what is failing on main?");
    expect(rows.textContent).toContain("Two checks are red.");
    expect(rows.textContent).toContain("fix the first one");
  });

  /** The caret is the one thing in the row that LOOKS like a toggle. */
  it("expands from the caret, not only from the title", () => {
    renderMessageList(callEvents);

    const caret = screen.getByTestId("voice-call-caret");
    expect(screen.getByRole("button", { expanded: false, name: /Voice call/ }).contains(caret)).toBe(true);

    fireEvent.click(caret);

    expect(screen.getByTestId("voice-call-rows")).toBeTruthy();
  });

  /**
   * The owner's report: "after an image scene the CTO makes, make sure there is
   * a still". A call's scene is drawn by the HUD, which is gone by the time the
   * card exists, so the picture has to be carried into the card or the call
   * reads as if it never drew anything.
   */
  it("shows the views the call drew, collapsed as a thumbnail and expanded in full", () => {
    rememberCallStill("call-1", {
      uri: ".ade/artifacts/computer-use/red-checks.png",
      artifactId: "a1",
      title: "Red checks",
    });
    try {
      renderMessageList(callEvents);

      const thumb = screen.getByTestId("voice-call-still-thumb");
      expect(thumb.getAttribute("src"))
        .toBe("ade-artifact://project/.ade/artifacts/computer-use/red-checks.png");

      fireEvent.click(screen.getByTestId("voice-call-caret"));
      expect(screen.queryByTestId("voice-call-still-thumb")).toBeNull();
      const stills = screen.getByTestId("voice-call-stills");
      expect(stills.textContent).toContain("Red checks");
      expect(screen.getByTestId("voice-call-still")).toBeTruthy();
    } finally {
      resetSceneStillsForTest();
    }
  });

  /**
   * A reopened window has nothing in memory: the pictures come back from the
   * artifact index, matched to this call by the id stored with them.
   */
  it("finds a finished call's views in the artifact index", async () => {
    const bridge = stubSceneCaptureBridge({
      artifacts: [{
        id: "a1",
        uri: ".ade/artifacts/computer-use/red-checks.png",
        title: "Generated view",
        metadata: { kind: "scene_still", voiceCallId: "call-1", sceneTitle: "Red checks" },
      }],
    });
    try {
      renderMessageList(callEvents, { sessionId: "chat-1" });
      await waitFor(() => expect(screen.getByTestId("voice-call-still-thumb")).toBeTruthy());
      expect(screen.getByTestId("voice-call-still-thumb").getAttribute("src"))
        .toBe("ade-artifact://project/.ade/artifacts/computer-use/red-checks.png");
      expect(bridge.listArtifacts.mock.calls[0]?.[0]).toMatchObject({
        ownerKind: "chat_session",
        ownerId: "chat-1",
        metadataKind: "scene_still",
      });
    } finally {
      resetSceneStillsForTest();
    }
  });

  it("draws no tile for a call that never drew anything", () => {
    renderMessageList(callEvents);
    expect(screen.queryByTestId("voice-call-still-thumb")).toBeNull();
    fireEvent.click(screen.getByTestId("voice-call-caret"));
    expect(screen.queryByTestId("voice-call-stills")).toBeNull();
  });

  it("leaves a transcript with no voice events untouched", () => {
    renderMessageList([
      voiceEnvelope(1, { type: "user_message", text: "typed by hand", deliveryState: "delivered" }),
      voiceEnvelope(2, { type: "text", text: "answered in text", itemId: "a-1" }),
    ]);

    expect(screen.queryByTestId("voice-call-card")).toBeNull();
    expect(document.body.textContent).toContain("typed by hand");
    expect(document.body.textContent).toContain("answered in text");
  });
});

describe("AgentChatMessageList turn fold", () => {
  beforeEach(() => resetTurnFoldMemoryForTests());
  afterEach(() => {
    takePendingSessionAnchor("session-1");
    resetTurnFoldMemoryForTests();
  });

  const at = (second: number) => `2026-09-23T10:00:${String(second).padStart(2, "0")}.000Z`;
  const turnEvents = (): AgentChatEventEnvelope[] => [
    { sessionId: "session-1", timestamp: at(0), event: { type: "user_message", text: "Fix the build", turnId: "turn-1" } },
    { sessionId: "session-1", timestamp: at(1), event: { type: "reasoning", text: "Reading the error.", turnId: "turn-1" } },
    { sessionId: "session-1", timestamp: at(2), event: { type: "text", text: "Checking the config first.", itemId: "t-1", turnId: "turn-1" } },
    {
      sessionId: "session-1",
      timestamp: at(3),
      event: { type: "command", command: "npm run build", cwd: "/repo", output: "ok", itemId: "c-1", turnId: "turn-1", status: "completed", exitCode: 0 },
    },
    { sessionId: "session-1", timestamp: at(4), event: { type: "text", text: "The build is green again.", itemId: "t-2", turnId: "turn-1" } },
  ];
  const doneEvent = (status: "completed" | "interrupted" = "completed"): AgentChatEventEnvelope => ({
    sessionId: "session-1",
    timestamp: at(12),
    event: { type: "done", turnId: "turn-1", status },
  });
  const foldButton = () => screen.getByRole("button", { name: /\. (Show|Hide) the work from this turn$/ });

  it("leaves a live turn exactly as it streams and folds it when done arrives", () => {
    const live = turnEvents();
    const view = renderMessageList(live, { showStreamingIndicator: true });
    expect(view.container.textContent).toContain("Checking the config first.");
    expect(screen.queryByTestId("turn-fold-row")).toBeNull();

    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={[...live, doneEvent()]} />
      </MemoryRouter>,
    );
    expect(foldButton().textContent).toBe("Worked for 12s · 1 tool");
    expect(view.container.textContent).not.toContain("Checking the config first.");
    expect(view.container.textContent).not.toContain("Reading the error.");
    expect(view.container.textContent).toContain("The build is green again.");
    const text = view.container.textContent ?? "";
    expect(text.indexOf("Fix the build")).toBeLessThan(text.indexOf("Worked for 12s"));
    expect(text.indexOf("Worked for 12s")).toBeLessThan(text.indexOf("The build is green again."));
    expect(text.indexOf("The build is green again.")).toBeLessThan(text.indexOf("ran 12s"));
  });

  it("measures an internal follow-up turn from its own start and draws no fold over a lone receipt", () => {
    // A Claude internal turn after background subagents finish: no user
    // message, a status start, a diagnostics receipt, then the answer.
    const internal = (second: number, event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: `2026-09-23T10:00:${String(second).padStart(2, "0")}.500Z`,
      event,
    });
    const view = renderMessageList([
      ...turnEvents(),
      doneEvent(),
      internal(20, { type: "status", turnStatus: "started", turnId: "claude-idle-1" }),
      internal(21, { type: "turn_diagnostics", turnId: "claude-idle-1", moderationChecks: 1 }),
      internal(22, { type: "text", text: "Task 3 complete.", messageId: "m-idle", turnId: "claude-idle-1" }),
      internal(23, { type: "done", turnId: "claude-idle-1", status: "completed" }),
    ]);
    // The user turn still folds; the internal turn's only hidden row would be
    // the receipt, so it does not fold and the receipt draws in place.
    expect(screen.getAllByTestId("turn-fold-row")).toHaveLength(1);
    expect(foldButton().textContent).toBe("Worked for 12s · 1 tool");
    const text = view.container.textContent ?? "";
    expect(text).toContain("Task 3 complete.");
    expect(text).toContain("Turn details");
    // 3s from its own status start, not 1s from the first drawn row.
    expect(text).toContain("ran 3.0s");
  });

  it("reads a sub-second turn as <1s on the fold row and the turn-end line", () => {
    const quick = (ms: number, event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: `2026-09-23T10:00:00.${String(ms).padStart(3, "0")}Z`,
      event,
    });
    const view = renderMessageList([
      quick(0, { type: "user_message", text: "Quick one", turnId: "turn-1" }),
      quick(50, { type: "reasoning", text: "Easy.", turnId: "turn-1" }),
      quick(100, { type: "text", text: "Looking.", itemId: "t-1", turnId: "turn-1" }),
      quick(200, { type: "text", text: "Done.", itemId: "t-2", turnId: "turn-1" }),
      quick(293, { type: "done", turnId: "turn-1", status: "completed" }),
    ]);
    expect(foldButton().textContent).toBe("Worked for <1s");
    const text = view.container.textContent ?? "";
    expect(text).toContain("ran <1s");
    expect(text).not.toMatch(/\d+ms/);
  });

  it("omits the duration of a turn with no user message and no start event", () => {
    const view = renderMessageList([
      ...turnEvents(),
      doneEvent(),
      { sessionId: "session-1", timestamp: at(30), event: { type: "reasoning", text: "Background result in.", turnId: "bg-1" } },
      { sessionId: "session-1", timestamp: at(31), event: { type: "text", text: "Background work finished.", itemId: "b-1", turnId: "bg-1" } },
      { sessionId: "session-1", timestamp: at(32), event: { type: "done", turnId: "bg-1", status: "completed" } },
    ]);
    const folds = screen.getAllByTestId("turn-fold-row");
    expect(folds).toHaveLength(2);
    expect(folds[1]!.textContent).toMatch(/^Worked(?! for)/);
    expect(view.container.textContent).not.toContain("ran 2.0s");
  });

  it("does not attribute an interrupted turn to the user", () => {
    renderMessageList([...turnEvents(), doneEvent("interrupted")]);
    expect(foldButton().textContent).toBe("Stopped after 12s · 1 tool");
  });

  it("counts the turn's sources on the fold row and puts an openable chip on the turn-end line", () => {
    const onOpenTurnSources = vi.fn();
    const events = turnEvents();
    events.splice(3, 0, {
      sessionId: "session-1",
      timestamp: at(3),
      event: {
        type: "web_search",
        query: "build errors",
        results: [{ url: "https://vitejs.dev/guide", title: "Vite guide" }, { url: "https://www.npmjs.com/package/x" }],
        itemId: "w-1",
        turnId: "turn-1",
        status: "completed",
      },
    }, {
      // Data-only citation: no row of its own, but it counts.
      sessionId: "session-1",
      timestamp: at(4),
      event: { type: "sources", sources: [{ kind: "citation", url: "https://vitejs.dev/guide#x", cited: true }], itemId: "t-2", turnId: "turn-1" },
    });
    renderMessageList([...events, doneEvent()], { onOpenTurnSources });

    const sources = screen.getByTestId("turn-fold-count-sources");
    expect(sources.textContent).toBe(" · 2 sources");
    expect(sources.querySelector("svg")!.getAttribute("class")).toContain("text-cyan-300");
    const chip = screen.getByTestId("turn-sources-chip");
    expect(chip.textContent).toBe("VN2 sources");
    fireEvent.click(chip);
    expect(onOpenTurnSources).toHaveBeenCalledWith("turn-1");
  });

  it("draws no sources chip or count for a turn without sources", () => {
    renderMessageList([...turnEvents(), doneEvent()], { onOpenTurnSources: vi.fn() });
    expect(screen.queryByTestId("turn-sources-chip")).toBeNull();
    expect(screen.queryByTestId("turn-fold-count-sources")).toBeNull();
  });

  it("puts a colored icon before each count on the fold row", () => {
    renderMessageList([...turnEvents(), doneEvent()]);
    const tools = screen.getByTestId("turn-fold-count-tools");
    expect(tools.textContent).toBe(" · 1 tool");
    const icon = tools.querySelector("svg");
    expect(icon).toBeTruthy();
    expect(icon!.getAttribute("class")).toContain("text-sky-300");
    expect(screen.queryByTestId("turn-fold-count-files")).toBeNull();
  });

  it("left-aligns the open fold's tool toggle and its tool list with the fold row", () => {
    renderMessageList([...turnEvents(), doneEvent()]);
    fireEvent.click(foldButton());
    const toolsToggle = screen.getByRole("button", { name: "Show 1 tool from this turn" });
    // No `ml-auto` pushing the toggle to the right edge, and no empty leading slot.
    expect(toolsToggle.parentElement!.className).not.toContain("ml-auto");
    expect(toolsToggle.parentElement!.previousElementSibling).toBeNull();
    // One tool reads "1 tool", not "1 tools".
    expect(toolsToggle.textContent).toBe("1tool");
    fireEvent.click(toolsToggle);
    expect(screen.getByRole("button", { name: "Hide 1 tool from this turn" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a restated answer once when the fold is open", () => {
    // Transcript 85fa4037 (Cursor, Grok 4.7): answer, tool call, thought, then
    // the same answer generated again.
    const answer = "I'm Grok 4.7, a language model trained by SpaceXAI.";
    const view = renderMessageList([
      { sessionId: "session-1", timestamp: at(0), event: { type: "user_message", text: "what model are you?", turnId: "turn-1" } },
      { sessionId: "session-1", timestamp: at(1), event: { type: "reasoning", text: "Answer directly.", turnId: "turn-1" } },
      { sessionId: "session-1", timestamp: at(2), event: { type: "text", text: answer, messageId: "91f596d8", turnId: "turn-1" } },
      {
        sessionId: "session-1",
        timestamp: at(3),
        event: { type: "command", command: "ade chat note", cwd: "/repo", output: "", itemId: "c-1", turnId: "turn-1", status: "completed", exitCode: 0 },
      },
      { sessionId: "session-1", timestamp: at(4), event: { type: "reasoning", text: "The question was already answered.", turnId: "turn-1" } },
      { sessionId: "session-1", timestamp: at(5), event: { type: "text", text: answer, messageId: "ec70564a", turnId: "turn-1" } },
      doneEvent(),
    ]);
    const count = () => (view.container.textContent ?? "").split(answer).length - 1;
    expect(count()).toBe(1);
    fireEvent.click(foldButton());
    expect(foldButton().getAttribute("aria-expanded")).toBe("true");
    // The span is revealed (both Thought rows), but the earlier copy is not.
    expect(view.container.querySelectorAll("[data-chat-row-key]").length).toBeGreaterThan(4);
    expect(count()).toBe(1);
  });

  it("draws the focus ring for keyboard focus only on the fold row and its toggles", () => {
    renderMessageList([...turnEvents(), doneEvent()]);
    const fold = foldButton();
    fireEvent.click(fold);
    for (const button of [fold, screen.getByRole("button", { name: "Show 1 tool from this turn" })]) {
      expect(button.className).toContain("focus:outline-none");
      expect(button.className).toContain("focus-visible:ring-1");
      expect(button.className).not.toMatch(/(^|\s)focus:ring/);
    }
  });

  it("counts the turn's background jobs on the fold row, red when one failed", () => {
    const job = (second: number, id: string, status: "running" | "completed" | "failed") => ({
      sessionId: "session-1",
      timestamp: at(second),
      event: {
        type: "scheduled_work_update" as const,
        id: `background:${id}`,
        kind: "background_task" as const,
        status,
        title: `job ${id}`,
        sourceTaskId: id,
        turnId: "turn-1",
      },
    });
    const events = turnEvents();
    renderMessageList([
      ...events.slice(0, 2),
      job(1, "a", "running"), job(1, "a", "completed"),
      job(1, "b", "running"), job(1, "b", "failed"),
      ...events.slice(2),
      doneEvent(),
    ]);
    expect(foldButton().textContent).toBe("Worked for 12s · 1 tool · 2 jobs (1 failed)");
    const jobs = screen.getByTestId("turn-fold-count-jobs");
    expect(jobs.className).toContain("text-red-300");
    expect(jobs.querySelector("svg")!.getAttribute("class")).toContain("text-red-400");
    // Both jobs finished before the turn ended, so they fold; open shows one compact row.
    expect(document.querySelector("[data-background-job]")).toBeNull();
    fireEvent.click(foldButton());
    const rows = document.querySelectorAll("[data-background-job-count]");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-background-job-count")).toBe("2");
  });

  it("folds a turn's warning and draws ONE Turn details row for it, in order when open", () => {
    const events: AgentChatEventEnvelope[] = [
      { sessionId: "session-1", timestamp: at(0), event: { type: "user_message", text: "Days till christmas?", turnId: "turn-1" } },
      { sessionId: "session-1", timestamp: at(1), event: { type: "system_notice", noticeKind: "warning", message: "⚠ Codex is ignoring 1 unrecognized configuration setting." } },
      { sessionId: "session-1", timestamp: at(2), event: { type: "turn_diagnostics", optionalIntegrationFailures: [{ integration: "unityMCP" }] } },
      {
        sessionId: "session-1",
        timestamp: at(3),
        event: { type: "command", command: "date", cwd: "/repo", output: "ok", itemId: "c-1", turnId: "turn-1", status: "completed", exitCode: 0 },
      },
      {
        sessionId: "session-1",
        timestamp: at(4),
        event: { type: "turn_diagnostics", turnId: "turn-1", optionalIntegrationFailures: [{ integration: "unityMCP" }, { integration: "figma" }, { integration: "linear" }] },
      },
      { sessionId: "session-1", timestamp: at(5), event: { type: "text", text: "93 days.", itemId: "t-1", turnId: "turn-1" } },
      doneEvent(),
    ];
    const view = renderMessageList(events);
    expect(view.container.textContent).not.toContain("Codex is ignoring");
    expect(screen.queryByText("Turn details")).toBeNull();

    fireEvent.click(foldButton());
    expect(screen.getAllByText("Turn details")).toHaveLength(1);
    expect(screen.getByText("3 optional integration warnings")).toBeTruthy();
    const text = view.container.textContent ?? "";
    expect(text.indexOf("Codex is ignoring")).toBeGreaterThan(text.indexOf("Worked for"));
    expect(text.indexOf("Codex is ignoring")).toBeLessThan(text.indexOf("Turn details"));
    expect(text.indexOf("Turn details")).toBeLessThan(text.indexOf("93 days."));
  });

  it("copies the whole turn, folded narration included, from the answer", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderMessageList([...turnEvents(), doneEvent()]);
    fireEvent.click(screen.getByRole("button", { name: "Copy whole turn" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      "Checking the config first.\n\nThe build is green again.",
    ));
  });

  it("remembers an opened fold for the chat view across remounts", () => {
    const events = [...turnEvents(), doneEvent()];
    const first = renderMessageList(events, { sessionId: "session-1" });
    fireEvent.click(foldButton());
    expect(foldButton().getAttribute("aria-expanded")).toBe("true");
    expect(first.container.textContent).toContain("Checking the config first.");
    first.unmount();

    const second = renderMessageList(events, { sessionId: "session-1" });
    expect(foldButton().getAttribute("aria-expanded")).toBe("true");
    expect(second.container.textContent).toContain("Checking the config first.");
    fireEvent.click(foldButton());
    expect(second.container.textContent).not.toContain("Checking the config first.");
  });

  it("opens the fold that hides a deep-linked event and highlights it", async () => {
    const events = [...turnEvents(), doneEvent()];
    setPendingSessionAnchor("session-1", { event: 2 });
    const view = renderMessageList(events, { sessionId: "session-1" });
    await waitFor(() => expect(foldButton().getAttribute("aria-expanded")).toBe("true"));
    const anchored = view.container.querySelector("[data-chat-anchored-row='true']");
    expect(anchored?.textContent).toContain("Checking the config first.");
  });

  it("opens the fold before jumping to a folded row", () => {
    const events = [...turnEvents(), doneEvent()];
    const view = renderMessageList(events);
    const transcript = document.querySelector(".ade-chat-timeline-pane") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    // The interim text row's key.
    const interimKey = buildTranscriptEventRowKeys(events)[2]!;
    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={events} scrollToRowKeyRequest={{ key: interimKey, requestId: 1 }} />
      </MemoryRouter>,
    );
    expect(foldButton().getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector(`[data-chat-row-key="${interimKey}"]`)).not.toBeNull();
    expect(transcript.scrollTop).toBeGreaterThan(0);
  });

  it("keeps a finished subagent result visible below the fold row", () => {
    const view = renderMessageList([
      { sessionId: "session-1", timestamp: at(0), event: { type: "user_message", text: "Survey it", turnId: "turn-1" } },
      {
        sessionId: "session-1",
        timestamp: at(1),
        event: { type: "subagent_started", taskId: "agent-a", agentId: "agent-a", agentType: "Explore", description: "Inspect the timeline", turnId: "turn-1" },
      },
      { sessionId: "session-1", timestamp: at(2), event: { type: "reasoning", text: "Waiting on the scout.", turnId: "turn-1" } },
      {
        sessionId: "session-1",
        timestamp: at(3),
        event: { type: "subagent_result", taskId: "agent-a", agentId: "agent-a", status: "completed", summary: "Timeline inspected", turnId: "turn-1" },
      },
      { sessionId: "session-1", timestamp: at(4), event: { type: "text", text: "Survey complete.", itemId: "t-1", turnId: "turn-1" } },
      { sessionId: "session-1", timestamp: at(5), event: { type: "done", turnId: "turn-1", status: "completed" } },
    ]);
    expect(foldButton().textContent).toBe("Worked for 5.0s · 1 subagent");
    const text = view.container.textContent ?? "";
    expect(text).toContain("Timeline inspected");
    expect(text).not.toContain("Waiting on the scout.");
    expect(text.indexOf("Worked for 5.0s")).toBeLessThan(text.indexOf("Timeline inspected"));
    expect(text.indexOf("Timeline inspected")).toBeLessThan(text.indexOf("Survey complete."));
  });
});

describe("AgentChatMessageList turn fold — scrolling, jumps, and row-indexed features", () => {
  // Scroll memory is per session and module-wide: every test gets its own chat.
  let sessionCounter = 0;
  let SESSION = "fold-session-0";
  beforeEach(() => {
    sessionCounter += 1;
    SESSION = `fold-session-${sessionCounter}`;
    resetTurnFoldMemoryForTests();
  });
  afterEach(() => {
    takePendingSessionAnchor(SESSION);
    resetTurnFoldMemoryForTests();
  });

  const at = (second: number) => `2026-09-23T11:00:${String(second).padStart(2, "0")}.000Z`;
  const env = (second: number, event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
    sessionId: SESSION,
    timestamp: at(second),
    event,
  });
  /** A live turn drawn as 7 rows: user, then reasoning/text pairs, then the answer so far. */
  const liveTurn = (): AgentChatEventEnvelope[] => [
    env(0, { type: "user_message", text: "Fix the build", turnId: "turn-1" }),
    env(1, { type: "reasoning", text: "Reading the error.", turnId: "turn-1" }),
    env(2, { type: "text", text: "Checking the config.", itemId: "i-1", turnId: "turn-1" }),
    env(3, { type: "command", command: "npm run build", cwd: "/repo", output: "", itemId: "c-1", turnId: "turn-1", status: "completed" }),
    env(4, { type: "reasoning", text: "Config looks fine.", turnId: "turn-1" }),
    env(5, { type: "text", text: "Checking the lockfile.", itemId: "i-2", turnId: "turn-1" }),
    env(6, { type: "command", command: "npm ci", cwd: "/repo", output: "", itemId: "c-2", turnId: "turn-1", status: "completed" }),
    env(7, { type: "reasoning", text: "Lockfile drifted.", turnId: "turn-1" }),
    env(8, { type: "text", text: "The build is green again.", itemId: "a-1", turnId: "turn-1" }),
  ];
  const done = (second = 12): AgentChatEventEnvelope => env(second, { type: "done", turnId: "turn-1", status: "completed" });
  /** Row key of the row the event at `index` opens. */
  const rowKeyOf = (events: AgentChatEventEnvelope[], index: number) => buildTranscriptEventRowKeys(events)[index];
  const foldButton = () => screen.getByRole("button", { name: /\. (Show|Hide) the work from this turn$/ });
  const rowKeys = () => [...timelinePane().querySelectorAll<HTMLElement>("[data-chat-row-key]")]
    .map((node) => node.dataset.chatRowKey);
  const rerenderList = (
    view: ReturnType<typeof render>,
    events: AgentChatEventEnvelope[],
    props: Partial<React.ComponentProps<typeof AgentChatMessageList>> = {},
  ) => view.rerender(
    <MemoryRouter initialEntries={[{ pathname: "/" }]}>
      <AgentChatMessageList events={events} sessionId={SESSION} {...props} />
    </MemoryRouter>,
  );

  /**
   * A 100px-per-row layout: row tops follow DOM order and the pane's
   * scrollTop, the pane's scrollHeight is its row count. jsdom has no layout,
   * so this is what makes the fold's scroll anchoring observable.
   */
  function stubRowLayout(clientHeight: number): () => void {
    const ROW = 100;
    const isPane = (el: Element) => el.classList.contains("ade-chat-timeline-pane");
    const rowsIn = (pane: Element) => [...pane.querySelectorAll("[data-chat-row-key]")];
    const originals = (["scrollHeight", "clientHeight"] as const)
      .map((prop) => [prop, Object.getOwnPropertyDescriptor(Element.prototype, prop)!] as const);
    Object.defineProperty(Element.prototype, "scrollHeight", {
      configurable: true,
      get(this: Element) { return isPane(this) ? rowsIn(this).length * ROW : 0; },
    });
    Object.defineProperty(Element.prototype, "clientHeight", {
      configurable: true,
      get(this: Element) { return isPane(this) ? clientHeight : 0; },
    });
    const originalRect = Element.prototype.getBoundingClientRect;
    const rect = (top: number, height: number) => ({
      top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}),
    }) as DOMRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const pane = document.querySelector(".ade-chat-timeline-pane");
      if (pane && this === pane) return rect(0, clientHeight);
      if (pane && this instanceof HTMLElement && this.dataset.chatRowKey !== undefined) {
        const index = rowsIn(pane).indexOf(this);
        if (index >= 0) return rect(index * ROW - (pane as HTMLElement).scrollTop, ROW);
      }
      return originalRect.call(this);
    };
    return () => {
      for (const [prop, descriptor] of originals) Object.defineProperty(Element.prototype, prop, descriptor);
      Element.prototype.getBoundingClientRect = originalRect;
    };
  }

  async function detachAt(scrollTop: number) {
    await nextFrame();
    await nextFrame();
    const pane = timelinePane();
    // Upward wheel intent breaks bottom-follow, as a real reader's would.
    fireEvent.wheel(pane, { deltaY: -80 });
    pane.scrollTop = scrollTop;
    fireEvent.scroll(pane);
  }

  describe("scroll stability", () => {
    it("keeps the row the reader is on in place when their turn folds above it", async () => {
      const restore = stubRowLayout(50);
      try {
        const view = renderMessageList(liveTurn(), { sessionId: SESSION, showStreamingIndicator: true });
        expect(rowKeys()).toHaveLength(7);
        // The answer so far is the first row on screen (index 6).
        await detachAt(600);
        const ended = [...liveTurn(), done()];
        rerenderList(view, ended);
        expect(rowKeys()).toEqual([rowKeyOf(ended, 0), "turn-fold:turn-1", rowKeyOf(ended, 8), rowKeyOf(ended, 9)]);
        // It moved from index 6 to 2: scrolled by exactly that, so it did not move on screen.
        expect(timelinePane().scrollTop).toBe(200);
      } finally {
        restore();
      }
    });

    it("anchors to the fold row when the row being read is itself folded", async () => {
      const restore = stubRowLayout(50);
      try {
        const view = renderMessageList(liveTurn(), { sessionId: SESSION, showStreamingIndicator: true });
        // Reading "Checking the lockfile." (index 4), which the fold hides.
        await detachAt(400);
        rerenderList(view, [...liveTurn(), done()]);
        // The fold row (index 1) now sits where that row was.
        expect(timelinePane().scrollTop).toBe(100);
        expect(foldButton().getAttribute("aria-expanded")).toBe("false");
      } finally {
        restore();
      }
    });

    it("stays pinned, with no stale frame, when a turn folds while following the bottom", async () => {
      const restore = stubRowLayout(100);
      try {
        const view = renderMessageList(liveTurn(), { sessionId: SESSION, showStreamingIndicator: true });
        await nextFrame();
        await nextFrame();
        expect(timelinePane().scrollTop).toBe(600);
        rerenderList(view, [...liveTurn(), done()]);
        // Pinned in the same commit (before any animation frame): 4 rows, 100px viewport.
        expect(timelinePane().scrollTop).toBe(300);
        expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
      } finally {
        restore();
      }
    });

    it("opening a fold at the bottom keeps the fold row put instead of chasing the new bottom; closing re-sticks", async () => {
      const restore = stubRowLayout(300);
      try {
        renderMessageList([...liveTurn(), done()], { sessionId: SESSION });
        await nextFrame();
        await nextFrame();
        // 4 rows, 300px viewport: pinned at 100, the fold row at the top edge.
        expect(timelinePane().scrollTop).toBe(100);

        fireEvent.click(foldButton());
        expect(rowKeys()).toHaveLength(9);
        await nextFrame();
        await nextFrame();
        expect(timelinePane().scrollTop).toBe(100);
        expect(screen.getByRole("button", { name: /jump to latest/i })).toBeTruthy();

        // Closing leaves the view at the end without any scroll event: follow again.
        fireEvent.click(foldButton());
        expect(rowKeys()).toHaveLength(4);
        await waitFor(() => expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull());
      } finally {
        restore();
      }
    });

    it("toggling a fold in the middle of the list while a later turn streams keeps the fold row put", async () => {
      const restore = stubRowLayout(200);
      try {
        const nextTurn = [
          env(20, { type: "user_message", text: "Now the tests", turnId: "turn-2" }),
          env(21, { type: "text", text: "Running them.", itemId: "b-1", turnId: "turn-2" }),
        ];
        const view = renderMessageList([...liveTurn(), done(), ...nextTurn], { sessionId: SESSION, showStreamingIndicator: true });
        // Fold row at index 1; put it 50px below the top edge and read from there.
        await detachAt(50);
        fireEvent.click(foldButton());
        expect(timelinePane().scrollTop).toBe(50);
        rerenderList(view, [
          ...liveTurn(), done(), ...nextTurn,
          env(22, { type: "text", text: "Still running.", itemId: "b-2", turnId: "turn-2" }),
        ], { showStreamingIndicator: true });
        await nextFrame();
        expect(timelinePane().scrollTop).toBe(50);
        fireEvent.click(foldButton());
        expect(timelinePane().scrollTop).toBe(50);
        expect(screen.getByRole("button", { name: /jump to latest/i })).toBeTruthy();
      } finally {
        restore();
      }
    });
  });

  describe("jumps open the containing fold first", () => {
    it("restores a reader who left mid-turn to the exact row, opening the fold that now hides it", async () => {
      const restoreLayout = stubRowLayout(200);
      try {
        const view = renderMessageList(liveTurn(), { sessionId: SESSION, showStreamingIndicator: true });
        // Row 4 ("Checking the lockfile.") at the top of the viewport, 10px in.
        await detachAt(4 * 100 + 10);
        view.unmount();

        // The turn finished while the chat was closed.
        renderMessageList([...liveTurn(), done()], { sessionId: SESSION });
        expect(foldButton().getAttribute("aria-expanded")).toBe("true");
        // One row further down now (the fold row sits above it), same offset.
        expect(timelinePane().scrollTop).toBe(5 * 100 + 10);
        const top = timelinePane().querySelector<HTMLElement>("[data-chat-row-key]:nth-child(6)");
        expect(top?.textContent).toContain("Checking the lockfile.");
      } finally {
        restoreLayout();
      }
    });

    it("opens a fold far off-screen in the virtualized list, then lands on and highlights the row", async () => {
      const restoreScrollBox = stubTimelineScrollBox({ clientHeight: 200, scrollHeight: 100_000 });
      try {
        const history = Array.from({ length: 70 }, (_, index) => ({
          sessionId: SESSION,
          timestamp: `2026-09-23T09:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
          event: { type: "user_message" as const, text: `Earlier ${index}`, deliveryState: "delivered" as const },
        }));
        const events = [...history, ...liveTurn(), done()];
        const targetKey = rowKeyOf(events, 70 + 5)!;
        const view = renderMessageList(events, { sessionId: SESSION });
        await nextFrame();
        timelinePane().scrollTop = 0;
        fireEvent.scroll(timelinePane());
        expect(timelinePane().querySelector(`[data-chat-row-key="${targetKey}"]`)).toBeNull();

        rerenderList(view, events, { scrollToRowKeyRequest: { key: targetKey, requestId: 1 } });
        await waitFor(() => {
          const row = timelinePane().querySelector(`[data-chat-row-key="${targetKey}"]`);
          expect(row?.getAttribute("data-chat-anchored-row")).toBe("true");
        });
        expect(foldButton().getAttribute("aria-expanded")).toBe("true");
        expect(timelinePane().scrollTop).toBeGreaterThan(0);
      } finally {
        restoreScrollBox();
      }
    });

    it("lands on the answer without opening the fold when the target is the answer", async () => {
      setPendingSessionAnchor(SESSION, { event: 8 });
      const view = renderMessageList([...liveTurn(), done()], { sessionId: SESSION });
      await waitFor(() => {
        expect(view.container.querySelector("[data-chat-anchored-row='true']")?.textContent)
          .toContain("The build is green again.");
      });
      expect(foldButton().getAttribute("aria-expanded")).toBe("false");
    });

    it("lands on a row of a turn that is still live (nothing to open)", async () => {
      setPendingSessionAnchor(SESSION, { event: 5 });
      const view = renderMessageList(liveTurn(), { sessionId: SESSION, showStreamingIndicator: true });
      await waitFor(() => {
        expect(view.container.querySelector("[data-chat-anchored-row='true']")?.textContent)
          .toContain("Checking the lockfile.");
      });
      expect(screen.queryByTestId("turn-fold-row")).toBeNull();
    });

    it("ignores a jump to a row that no longer exists and leaves the fold closed", () => {
      const events = [...liveTurn(), done()];
      const view = renderMessageList(events, { sessionId: SESSION });
      rerenderList(view, events, { scrollToRowKeyRequest: { key: "gone:row", requestId: 7 } });
      expect(foldButton().getAttribute("aria-expanded")).toBe("false");
      expect(view.container.querySelector("[data-chat-anchored-row='true']")).toBeNull();
    });
  });

  describe("row-indexed features", () => {
    it("keeps the N-new count when the row it counts from folds away", async () => {
      const restoreScrollBox = stubTimelineScrollBox({ clientHeight: 200, scrollHeight: 1_000 });
      try {
        const upToInterim = liveTurn().slice(0, 6);
        const view = renderMessageList(upToInterim, { sessionId: SESSION, showStreamingIndicator: true });
        // Detach: the last row ("Checking the lockfile.") becomes the count's anchor.
        await detachAt(100);
        expect(await screen.findByRole("button", { name: "Jump to latest message" })).toBeTruthy();

        rerenderList(view, [...liveTurn()], { showStreamingIndicator: true });
        expect(screen.getByRole("button", { name: "2 new · Jump To Latest" })).toBeTruthy();

        // The turn ends and folds the anchor row away: the answer and the turn
        // end are still new; the fold row (above the anchor) and hidden rows are not.
        const ended = [...liveTurn(), done()];
        rerenderList(view, ended);
        expect(rowKeys()).not.toContain(rowKeyOf(ended, 5));
        expect(screen.getByRole("button", { name: "2 new · Jump To Latest" })).toBeTruthy();
      } finally {
        restoreScrollBox();
      }
    });

    it("draws the fork divider on the fold row while its row is folded, and on the row once opened", () => {
      const fork = { providerOrigin: "handoff_fork" as const, sourceSessionId: "prev" };
      const forked: AgentChatEventEnvelope[] = [
        { ...env(0, { type: "user_message", text: "Earlier question", turnId: "turn-0" }), provenance: fork },
        { ...env(1, { type: "text", text: "Earlier answer", itemId: "e-1", turnId: "turn-0" }), provenance: fork },
        { ...env(2, { type: "done", turnId: "turn-0", status: "completed" }), provenance: fork },
        env(3, { type: "text", text: "Picking up the fork.", itemId: "f-1", turnId: "turn-1" }),
        env(4, { type: "reasoning", text: "Continuing.", turnId: "turn-1" }),
        env(5, { type: "text", text: "Fork answer.", itemId: "f-2", turnId: "turn-1" }),
        env(6, { type: "done", turnId: "turn-1", status: "completed" }),
      ];
      renderMessageList(forked, { sessionId: SESSION });

      const divider = () => screen.getByTestId("fork-history-divider");
      const rowOf = (node: Element) => node.closest("[data-chat-row-key]")?.getAttribute("data-chat-row-key");
      expect(screen.getAllByTestId("fork-history-divider")).toHaveLength(1);
      expect(rowOf(divider())).toBe("turn-fold:turn-1");
      const text = () => timelinePane().textContent ?? "";
      expect(text().indexOf("Earlier answer")).toBeLessThan(text().indexOf("Forked from the previous chat"));
      // turn-1 has no user message and no start event, so its fold reads a bare "Worked".
      expect(text().indexOf("Forked from the previous chat")).toBeLessThan(text().indexOf("Worked"));

      fireEvent.click(foldButton());
      expect(screen.getAllByTestId("fork-history-divider")).toHaveLength(1);
      expect(rowOf(divider())).toBe(rowKeyOf(forked, 3));
      expect(text().indexOf("Worked")).toBeLessThan(text().indexOf("Forked from the previous chat"));
      expect(text().indexOf("Forked from the previous chat")).toBeLessThan(text().indexOf("Picking up the fork."));
    });

    it("folds a cancelled turn whose subagent done arrived first and carried more tokens", () => {
      renderMessageList([
        ...liveTurn(),
        env(10, { type: "done", turnId: "sub-turn-1", status: "interrupted", usage: { inputTokens: 90_000, outputTokens: 9_000 } }),
        env(11, { type: "status", turnStatus: "interrupted", turnId: "turn-1" }),
        env(12, { type: "done", turnId: "turn-1", status: "interrupted", usage: { inputTokens: 10, outputTokens: 5 } }),
      ], { sessionId: SESSION });
      expect(foldButton().textContent).toMatch(/^Stopped after 12s/);
      expect(timelinePane().textContent).not.toContain("Checking the lockfile.");
    });

    it("moves the tool count to the fold row for a done without a turn id", () => {
      renderMessageList([
        ...liveTurn(),
        env(12, { type: "done", turnId: "", status: "completed" }),
      ], { sessionId: SESSION });
      expect(foldButton().textContent).toBe("Worked for 12s · 2 tools");
      expect(screen.queryByRole("button", { name: /^Show .+ from this turn$/ })).toBeNull();
    });
  });

  describe("Copy turn", () => {
    it("sits on the last text row, visible, when a final answer is followed by more text", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const turn: AgentChatEventEnvelope[] = [
        env(0, { type: "user_message", text: "Explain", turnId: "turn-1" }),
        env(1, { type: "text", text: "Looking into it.", itemId: "x-1", turnId: "turn-1", phase: "commentary" }),
        env(2, { type: "reasoning", text: "Thinking.", turnId: "turn-1" }),
        env(3, { type: "text", text: "Here is the answer.", itemId: "x-2", turnId: "turn-1", phase: "final_answer" }),
        env(4, { type: "text", text: "P.S. one caveat.", itemId: "x-3", turnId: "turn-1" }),
        env(5, { type: "done", turnId: "turn-1", status: "completed" }),
      ];
      const view = renderMessageList(turn, { sessionId: SESSION });
      const text = view.container.textContent ?? "";
      expect(text).not.toContain("Looking into it.");
      expect(text.indexOf("Worked for")).toBeLessThan(text.indexOf("Here is the answer."));
      const copy = screen.getByRole("button", { name: "Copy whole turn" });
      expect(copy.closest("[data-chat-row-key]")?.getAttribute("data-chat-row-key")).toBe(rowKeyOf(turn, 4));
      fireEvent.click(copy);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(
        "Looking into it.\n\nHere is the answer.\n\nP.S. one caveat.",
      ));
    });

    it("offers no whole-turn copy when the answer is the turn's only text", () => {
      const view = renderMessageList([
        env(0, { type: "user_message", text: "Explain", turnId: "turn-1" }),
        env(1, { type: "reasoning", text: "Thinking.", turnId: "turn-1" }),
        env(2, { type: "text", text: "Only answer.", itemId: "y-1", turnId: "turn-1" }),
        env(3, { type: "done", turnId: "turn-1", status: "completed" }),
      ], { sessionId: SESSION });
      expect(foldButton()).toBeTruthy();
      expect(view.container.textContent).toContain("Only answer.");
      expect(screen.queryByRole("button", { name: "Copy whole turn" })).toBeNull();
    });
  });
});


describe("AgentChatMessageList — stable row keys, list anchoring, and scroll restore", () => {
  let sessionCounter = 0;
  let SESSION = "anchor-session-0";
  beforeEach(() => {
    sessionCounter += 1;
    SESSION = `anchor-session-${sessionCounter}`;
    resetTurnFoldMemoryForTests();
  });
  afterEach(() => resetTurnFoldMemoryForTests());

  const GAP = CHAT_TIMELINE_ROW_GAP_PX;
  /** A one-line user message: its per-kind estimate, which a prepended row also measures at. */
  const OLDER_ROW = 51;

  const userEvents = (prefix: string, count: number, startMinute: number): AgentChatEventEnvelope[] => (
    Array.from({ length: count }, (_, index) => ({
      sessionId: SESSION,
      timestamp: new Date(Date.UTC(2026, 8, 23, 8, startMinute, 0) + index * 1_000).toISOString(),
      event: { type: "user_message" as const, text: `${prefix} ${index}`, messageId: `${prefix}-${index}`, deliveryState: "delivered" as const },
    }))
  );

  /**
   * A layout engine for jsdom, just enough for the transcript: every row has a
   * fixed height by key, rows stack with the row gap, the virtualized path's
   * top spacer and sizer are read from their inline heights, and every box is
   * placed against the pane's scrollTop. `offsetHeight` feeds the virtualizer's
   * row measurement; `getBoundingClientRect` feeds the DOM anchors.
   */
  function installFakeLayout(clientHeight: number, heightOf: (key: string) => number): () => void {
    const paneOf = () => document.querySelector<HTMLElement>(".ade-chat-timeline-pane");
    const keyOf = (el: Element): string | null => {
      if (!(el instanceof HTMLElement)) return null;
      if (el.dataset.chatRowKey !== undefined) return el.dataset.chatRowKey;
      if (el.dataset.chatVirtualizedRow === "true") {
        return el.querySelector<HTMLElement>("[data-chat-row-key]")?.dataset.chatRowKey ?? null;
      }
      return null;
    };
    const sentinelHeight = (pane: HTMLElement) => {
      const first = pane.firstElementChild?.firstElementChild;
      return first?.getAttribute("role") === "status" ? 28 : 0;
    };
    const boxTop = (pane: HTMLElement, box: HTMLElement): number => {
      const container = box.parentElement!;
      let y = sentinelHeight(pane);
      if (box.dataset.chatVirtualizedRow === "true") {
        const spacer = container.previousElementSibling as HTMLElement | null;
        y += Number.parseFloat(spacer?.style.height || "0");
      }
      for (const sibling of Array.from(container.children)) {
        if (sibling === box) break;
        const key = keyOf(sibling);
        if (key !== null) y += heightOf(key) + GAP;
      }
      return y;
    };
    const rect = (top: number, height: number) => ({
      top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}),
    }) as DOMRect;
    const saved = (["scrollHeight", "clientHeight"] as const)
      .map((prop) => [prop, Object.getOwnPropertyDescriptor(Element.prototype, prop)!] as const);
    const savedOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    const savedRect = Element.prototype.getBoundingClientRect;
    Object.defineProperty(Element.prototype, "clientHeight", {
      configurable: true,
      get(this: Element) { return this.classList.contains("ade-chat-timeline-pane") ? clientHeight : 0; },
    });
    Object.defineProperty(Element.prototype, "scrollHeight", {
      configurable: true,
      get(this: Element) {
        if (!this.classList.contains("ade-chat-timeline-pane")) return 0;
        const pane = this as HTMLElement;
        const sizer = Array.from(pane.querySelectorAll<HTMLElement>("div"))
          .find((el) => el.style.position === "relative" && el.style.height);
        if (sizer) return sentinelHeight(pane) + Number.parseFloat(sizer.style.height);
        const rows = Array.from(pane.querySelectorAll("[data-chat-row-key]"));
        const total = rows.reduce((sum, row) => sum + heightOf(keyOf(row)!) + GAP, 0);
        return sentinelHeight(pane) + Math.max(0, total - GAP);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        const key = keyOf(this);
        return key === null ? 0 : heightOf(key);
      },
    });
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const pane = paneOf();
      if (!pane) return savedRect.call(this);
      if (this === pane) return rect(0, clientHeight);
      const key = keyOf(this);
      if (key === null || !(this instanceof HTMLElement)) return rect(0, 0);
      const box = this.dataset.chatRowKey !== undefined
        ? ((this.closest("[data-chat-virtualized-row]") as HTMLElement | null) ?? this)
        : this;
      return rect(boxTop(pane, box) - pane.scrollTop, heightOf(key));
    };
    return () => {
      for (const [prop, descriptor] of saved) Object.defineProperty(Element.prototype, prop, descriptor);
      if (savedOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", savedOffsetHeight);
      else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
      Element.prototype.getBoundingClientRect = savedRect;
    };
  }

  const rowNodes = () => Array.from(timelinePane().querySelectorAll<HTMLElement>("[data-chat-row-key]"));
  const firstVisibleRow = () => {
    for (const node of rowNodes()) {
      const box = node.getBoundingClientRect();
      if (box.bottom > 1) return { key: node.dataset.chatRowKey!, top: box.top, node };
    }
    return null;
  };
  const sizerHeight = () => {
    const sizer = Array.from(timelinePane().querySelectorAll<HTMLElement>("div"))
      .find((el) => el.style.position === "relative" && el.style.height);
    return sizer ? Number.parseFloat(sizer.style.height) : null;
  };
  const listElement = (
    events: AgentChatEventEnvelope[],
    props: Partial<React.ComponentProps<typeof AgentChatMessageList>> = {},
  ) => (
    <MemoryRouter initialEntries={[{ pathname: "/" }]}>
      <AgentChatMessageList events={events} sessionId={SESSION} {...props} />
    </MemoryRouter>
  );

  /** Break bottom-follow and park the viewport at `scrollTop`, as a reader's wheel would. */
  async function readerScrollsTo(scrollTop: number) {
    const pane = timelinePane();
    fireEvent.wheel(pane, { deltaY: -120 });
    pane.scrollTop = scrollTop;
    fireEvent.scroll(pane);
    await nextFrame();
    await nextFrame();
  }

  describe.each([
    { path: "virtualized", tailRows: 80 },
    { path: "plain", tailRows: 12 },
  ])("an older page prepended on the $path path", ({ path, tailRows }) => {
    it("keeps measured heights and mounted rows, and moves scrollTop by exactly the inserted height", async () => {
      const TAIL_ROW = 120;
      const tail = userEvents("tail", tailRows, 30);
      const older = userEvents("older", 40, 10);
      const olderKeys = new Set(buildTranscriptEventRowKeys(older));
      const restoreLayout = installFakeLayout(600, (key) => (olderKeys.has(key) ? OLDER_ROW : TAIL_ROW));
      try {
        const view = render(listElement(tail, { hasOlderHistory: true }));
        await nextFrame();
        const middle = Math.floor(tailRows / 2) * (TAIL_ROW + GAP) + 30;
        await readerScrollsTo(middle);
        expect(Boolean(timelinePane().querySelector("[data-chat-virtualized-row]"))).toBe(path === "virtualized");

        const anchor = firstVisibleRow()!;
        expect(anchor).not.toBeNull();
        const mountedBefore = new Map(rowNodes().map((node) => [node.dataset.chatRowKey!, node]));
        const sizerBefore = sizerHeight();
        const scrollTopBefore = timelinePane().scrollTop;

        view.rerender(listElement([...older, ...tail], { hasOlderHistory: true }));

        const inserted = 40 * (OLDER_ROW + GAP);
        expect(timelinePane().scrollTop).toBe(scrollTopBefore + inserted);
        // The row the reader was on did not move on screen and was not remounted.
        const anchorNow = timelinePane().querySelector<HTMLElement>(`[data-chat-row-key="${anchor.key}"]`)!;
        expect(anchorNow).toBe(anchor.node);
        expect(anchorNow.getBoundingClientRect().top).toBe(anchor.top);
        // Every tail row still mounted is the same DOM node (no remount, so no
        // replayed fade-ins or re-highlighting).
        const survivors = rowNodes().filter((node) => mountedBefore.has(node.dataset.chatRowKey!));
        expect(survivors.length).toBeGreaterThan(0);
        for (const node of survivors) expect(node).toBe(mountedBefore.get(node.dataset.chatRowKey!));
        if (path === "virtualized") {
          // Measured tail heights survived: the sizer grew by the page alone.
          expect(sizerHeight()).toBe(sizerBefore! + inserted);
        }
      } finally {
        restoreLayout();
      }
    });
  });

  it("keeps the reader's rows in place when the task list moves from above them to a new turn", async () => {
    const TASK_ROW = 40;
    const ROW = 120;
    const at = (second: number) => new Date(Date.UTC(2026, 8, 23, 8, 0, second)).toISOString();
    const head: AgentChatEventEnvelope[] = [
      { sessionId: SESSION, timestamp: at(0), event: { type: "user_message", text: "Start", messageId: "start", deliveryState: "delivered", turnId: "turn-1" } },
      { sessionId: SESSION, timestamp: at(1), event: { type: "todo_update", turnId: "turn-1", items: [{ id: "a", description: "A", status: "in_progress" }] } },
    ];
    const tail = userEvents("tail", 12, 30);
    const moved: AgentChatEventEnvelope = {
      sessionId: SESSION,
      timestamp: new Date(Date.UTC(2026, 8, 23, 9, 0, 0)).toISOString(),
      event: {
        type: "todo_update",
        turnId: "turn-2",
        items: [
          { id: "a", description: "A", status: "completed" },
          { id: "b", description: "B", status: "in_progress" },
        ],
      },
    };
    const restoreLayout = installFakeLayout(600, (key) => (key.startsWith("task-list:") ? TASK_ROW : ROW));
    try {
      const view = render(listElement([...head, ...tail]));
      await nextFrame();
      const taskKey = `task-list:${SESSION}`;
      expect(rowNodes().map((node) => node.dataset.chatRowKey).indexOf(taskKey)).toBe(1);
      await readerScrollsTo(5 * (ROW + GAP) + 30);
      const anchor = firstVisibleRow()!;
      expect(anchor.key).not.toBe(taskKey);
      const scrollTopBefore = timelinePane().scrollTop;

      view.rerender(listElement([...head, ...tail, moved]));

      const keys = rowNodes().map((node) => node.dataset.chatRowKey);
      // Still exactly one task list, now last (the turn of its latest update).
      expect(keys.filter((key) => key === taskKey)).toHaveLength(1);
      expect(keys.at(-1)).toBe(taskKey);
      // The row the reader was on did not move on screen.
      const anchorNow = timelinePane().querySelector<HTMLElement>(`[data-chat-row-key="${anchor.key}"]`)!;
      expect(anchorNow.getBoundingClientRect().top).toBe(anchor.top);
      expect(timelinePane().scrollTop).toBe(scrollTopBefore - (TASK_ROW + GAP));
    } finally {
      restoreLayout();
    }
  });

  it("does not follow the task list down the thread when the reader is looking at it as it moves", async () => {
    const TASK_ROW = 40;
    const ROW = 120;
    const at = (second: number) => new Date(Date.UTC(2026, 8, 23, 8, 0, second)).toISOString();
    const head: AgentChatEventEnvelope[] = [
      { sessionId: SESSION, timestamp: at(0), event: { type: "user_message", text: "Start", messageId: "start", deliveryState: "delivered", turnId: "turn-1" } },
      { sessionId: SESSION, timestamp: at(1), event: { type: "todo_update", turnId: "turn-1", items: [{ id: "a", description: "A", status: "in_progress" }] } },
    ];
    const tail = userEvents("tail", 12, 30);
    const moved: AgentChatEventEnvelope = {
      sessionId: SESSION,
      timestamp: new Date(Date.UTC(2026, 8, 23, 9, 0, 0)).toISOString(),
      event: { type: "todo_update", turnId: "turn-2", items: [{ id: "a", description: "A", status: "completed" }] },
    };
    const restoreLayout = installFakeLayout(600, (key) => (key.startsWith("task-list:") ? TASK_ROW : ROW));
    try {
      const view = render(listElement([...head, ...tail]));
      await nextFrame();
      await readerScrollsTo(ROW + GAP + 10);
      const taskKey = `task-list:${SESSION}`;
      expect(firstVisibleRow()!.key).toBe(taskKey);
      const nextRow = rowNodes()[2]!;
      const nextKey = nextRow.dataset.chatRowKey!;
      const nextTop = nextRow.getBoundingClientRect().top;

      view.rerender(listElement([...head, ...tail, moved]));

      // The row under the card holds its place; the view did not ride the card
      // to the bottom of the thread.
      const nextNow = timelinePane().querySelector<HTMLElement>(`[data-chat-row-key="${nextKey}"]`)!;
      expect(nextNow.getBoundingClientRect().top).toBe(nextTop);
    } finally {
      restoreLayout();
    }
  });

  it("keeps an open fold, a jump into a fold, and the turn-end snapshot across a prepend", async () => {
    const at = (second: number) => new Date(Date.UTC(2026, 8, 23, 12, 0, second)).toISOString();
    const env = (second: number, event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
      sessionId: SESSION,
      timestamp: at(second),
      event,
    });
    const older = [
      env(0, { type: "user_message", text: "Earlier", turnId: "turn-0" }),
      env(1, { type: "text", text: "Earlier answer.", itemId: "o-1", turnId: "turn-0" }),
      env(2, { type: "done", turnId: "turn-0", status: "completed" }),
    ];
    const turn = [
      env(10, { type: "user_message", text: "Fix the build", turnId: "turn-1" }),
      env(11, { type: "reasoning", text: "Reading the error.", turnId: "turn-1" }),
      env(12, { type: "text", text: "Checking the config.", itemId: "i-1", turnId: "turn-1" }),
      env(13, { type: "scheduled_work_update", id: "background:job-1", kind: "background_task", status: "running", title: "npm run dev", sourceTaskId: "job-1", turnId: "turn-1" }),
      env(14, { type: "text", text: "The build is green again.", itemId: "a-1", turnId: "turn-1" }),
      env(15, { type: "done", turnId: "turn-1", status: "completed" }),
      // Settles after the turn ended: the snapshot keeps it visible anyway.
      env(16, { type: "scheduled_work_update", id: "background:job-1", kind: "background_task", status: "completed", title: "npm run dev", sourceTaskId: "job-1", turnId: "turn-1" }),
    ];
    const foldToggle = () => screen.getByRole("button", { name: /\. (Show|Hide) the work from this turn$/ });
    const text = () => timelinePane().textContent ?? "";

    const view = render(listElement(turn));
    expect(text()).toContain("npm run dev");
    expect(text()).not.toContain("Checking the config.");
    fireEvent.click(foldToggle());
    expect(foldToggle().getAttribute("aria-expanded")).toBe("true");

    view.rerender(listElement([...older, ...turn]));
    expect(text()).toContain("Earlier answer.");
    expect(foldToggle().getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("Checking the config.");

    fireEvent.click(foldToggle());
    expect(text()).not.toContain("Checking the config.");
    // The background job was live when the turn ended: still kept after the prepend.
    expect(text()).toContain("npm run dev");

    // A key taken from the pre-prepend window still names the same row.
    const interimKey = buildTranscriptEventRowKeys(turn)[2]!;
    view.rerender(listElement([...older, ...turn], { scrollToRowKeyRequest: { key: interimKey, requestId: 1 } }));
    await waitFor(() => {
      const row = timelinePane().querySelector(`[data-chat-row-key="${interimKey}"]`);
      expect(row?.getAttribute("data-chat-anchored-row")).toBe("true");
    });
    expect(foldToggle().getAttribute("aria-expanded")).toBe("true");
  });

  describe("scroll restore", () => {
    const heightOf = (key: string) => 60 + (key.length % 5) * 20;

    async function leaveAt(events: AgentChatEventEnvelope[], scrollTop: number) {
      const view = render(listElement(events, { hasOlderHistory: true }));
      await nextFrame();
      await readerScrollsTo(scrollTop);
      const saved = firstVisibleRow()!;
      const pane = timelinePane();
      const distanceFromBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      view.unmount();
      return { key: saved.key, top: saved.top, distanceFromBottom };
    }

    it("returns to the same row and offset after the window was trimmed to its last 1,000 events", async () => {
      const restoreLayout = installFakeLayout(600, heightOf);
      try {
        const events = userEvents("msg", 1_200, 0);
        const saved = await leaveAt(events, 70_000);

        const trimmed = events.slice(-1_000);
        const onLoadOlderHistory = vi.fn();
        render(listElement(trimmed, { hasOlderHistory: true, onLoadOlderHistory }));
        await waitFor(() => {
          const first = firstVisibleRow();
          expect(first?.key).toBe(saved.key);
          expect(first?.top).toBe(saved.top);
        });
        expect(onLoadOlderHistory).not.toHaveBeenCalled();
      } finally {
        restoreLayout();
      }
    });

    it("falls back to the saved distance from the bottom when the row is gone", async () => {
      const restoreLayout = installFakeLayout(600, heightOf);
      try {
        const events = userEvents("gone", 120, 0);
        const saved = await leaveAt(events, 4_000);

        const without = events.filter((_, index) => buildTranscriptEventRowKeys(events)[index] !== saved.key);
        render(listElement(without, { hasOlderHistory: true }));
        await waitFor(() => {
          const pane = timelinePane();
          expect(pane.scrollHeight - pane.scrollTop - pane.clientHeight).toBe(saved.distanceFromBottom);
        });
      } finally {
        restoreLayout();
      }
    });

    it("chains at most one older page on its own, and loads again once the reader scrolls", async () => {
      const restoreLayout = installFakeLayout(600, () => 60);
      try {
        const tail = userEvents("near-top", 40, 30);
        await leaveAt(tail, 200);

        const onLoadOlderHistory = vi.fn();
        const view = render(listElement(tail, { hasOlderHistory: true, onLoadOlderHistory }));
        // Held while the restore lands, then one automatic request.
        await waitFor(() => expect(onLoadOlderHistory).toHaveBeenCalledTimes(1));

        // The page lands (a small one: the reader is still inside the runway)
        // and the re-arm would ask again: capped.
        let events = tail;
        for (let page = 0; page < 3; page += 1) {
          view.rerender(listElement(events, { hasOlderHistory: true, loadingOlderHistory: true, onLoadOlderHistory }));
          events = [...userEvents(`page-${page}`, 2, 20 - page), ...events];
          view.rerender(listElement(events, { hasOlderHistory: true, loadingOlderHistory: false, onLoadOlderHistory }));
          await nextFrame();
          await nextFrame();
        }
        expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

        // The reader scrolls: loading resumes.
        await readerScrollsTo(100);
        expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
      } finally {
        restoreLayout();
      }
    });
  });

  describe("row heights", () => {
    it("corrects scrollTop for a row that straddles the viewport top when it grows", () => {
      const pitch = 80 + GAP;
      // Row 2 starts 10px above the viewport top and grows by 60.
      expect(reconcileMeasuredScrollTop({
        index: 2,
        previousHeight: 80,
        nextHeight: 140,
        scrollTop: 2 * pitch + 10,
        rowHeight: () => 80,
      })).toBe(2 * pitch + 70);
      // A row starting at or below the viewport top grows downward, away from what the reader sees.
      expect(reconcileMeasuredScrollTop({
        index: 2,
        previousHeight: 80,
        nextHeight: 140,
        scrollTop: 2 * pitch,
        rowHeight: () => 80,
      })).toBe(2 * pitch);
    });

    it("estimates unmeasured rows by kind, and prose by length across the column", () => {
      const row = (event: AgentChatEventEnvelope["event"] | { type: "turn_fold" }) => ({
        key: "k",
        timestamp: "2026-09-23T00:00:00.000Z",
        event,
      }) as Parameters<typeof estimateTranscriptRowHeight>[0];
      const fold = estimateTranscriptRowHeight(row({ type: "turn_fold" } as never), 720);
      const shortUser = estimateTranscriptRowHeight(row({ type: "user_message", text: "hi" }), 720);
      const longAnswer = estimateTranscriptRowHeight(row({ type: "text", text: "word ".repeat(600) }), 720);
      const longAnswerNarrow = estimateTranscriptRowHeight(row({ type: "text", text: "word ".repeat(600) }), 360);
      const card = estimateTranscriptRowHeight(row({ type: "approval_request", itemId: "a", kind: "tool_call", description: "Run?" }), 720);
      expect(fold).toBeLessThan(shortUser);
      expect(shortUser).toBe(OLDER_ROW);
      expect(longAnswer).toBeGreaterThan(300);
      expect(longAnswerNarrow).toBeGreaterThan(longAnswer * 1.8);
      expect(card).toBeGreaterThan(shortUser);
    });
  });
});

describe("AgentChatMessageList — the chat's one task list", () => {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 23, 12, 0, second)).toISOString();
  const env = (second: number, event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
    sessionId: "task-session",
    timestamp: at(second),
    event,
  });
  const taskRows = () => [...document.querySelectorAll<HTMLElement>("[data-chat-row-key^='task-list:']")];
  const turnOneList: AgentChatEventEnvelope[] = [
    env(0, { type: "user_message", text: "Plan the migration", turnId: "turn-1" }),
    env(1, {
      type: "plan",
      turnId: "turn-1",
      explanation: "Migrating billing",
      steps: [
        { text: "Read the schema", status: "completed" },
        { text: "Write the migration", status: "in_progress" },
        { text: "Deploy", status: "pending" },
      ],
    }),
    env(2, { type: "reasoning", text: "Checking columns.", turnId: "turn-1" }),
    env(3, { type: "text", text: "Migration drafted.", itemId: "a-1", turnId: "turn-1" }),
    env(4, { type: "done", turnId: "turn-1", status: "completed" }),
  ];

  it("renders one collapsed line: label · done/total · current item", () => {
    renderMessageList(turnOneList, { sessionId: "task-session" });
    expect(taskRows()).toHaveLength(1);
    expect(taskRows()[0]!.dataset.chatRowKey).toBe("task-list:task-session");
    const card = screen.getByTestId("chat-task-list-card");
    expect(card.dataset.open).toBe("false");
    expect(card.textContent).toBe("Migrating billing·1/3·Write the migration");
    expect(screen.queryByText("Deploy")).toBeNull();
  });

  it("expands to the full list on click, collapses on the next, and remembers per chat across remounts", () => {
    const view = renderMessageList(turnOneList, { sessionId: "task-session" });
    const toggle = () => within(screen.getByTestId("chat-task-list-card")).getAllByRole("button")[0]!;
    fireEvent.click(toggle());
    expect(screen.getByTestId("chat-task-list-card").dataset.open).toBe("true");
    const list = screen.getByTestId("chat-task-list");
    expect([...list.querySelectorAll<HTMLElement>("[data-task-status]")].map((row) => [row.textContent, row.dataset.taskStatus])).toEqual([
      ["Read the schema", "done"],
      ["Write the migration", "running"],
      ["Deploy", "pending"],
    ]);
    // Only the running row carries the travelling underline.
    expect(list.querySelectorAll("[data-task-running-line]")).toHaveLength(1);
    view.unmount();
    renderMessageList(turnOneList, { sessionId: "task-session" });
    expect(screen.getByTestId("chat-task-list-card").dataset.open).toBe("true");
    fireEvent.click(toggle());
    expect(screen.getByTestId("chat-task-list-card").dataset.open).toBe("false");
  });

  it("never folds: the card stays visible when the turn's work folds", () => {
    renderMessageList(turnOneList, { sessionId: "task-session" });
    expect(screen.getByRole("button", { name: /\. (Show|Hide) the work from this turn$/ })).toBeTruthy();
    // The thought folded away; the task list did not.
    expect(screen.queryByText("Checking columns.")).toBeNull();
    expect(taskRows()).toHaveLength(1);
  });

  it("moves to the turn of the latest update and leaves no card behind", () => {
    const view = renderMessageList(turnOneList, { sessionId: "task-session" });
    const next = [
      ...turnOneList,
      env(10, { type: "user_message", text: "Now deploy", turnId: "turn-2" }),
      env(11, {
        type: "todo_update",
        turnId: "turn-2",
        items: [{ id: "d", description: "Deploy to staging", status: "in_progress", activeForm: "Deploying to staging" }],
      }),
    ];
    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList events={next} sessionId="task-session" />
      </MemoryRouter>,
    );
    const keys = [...document.querySelectorAll<HTMLElement>("[data-chat-row-key]")].map((node) => node.dataset.chatRowKey);
    expect(keys.filter((key) => key?.startsWith("task-list:"))).toEqual(["task-list:task-session"]);
    expect(keys.at(-1)).toBe("task-list:task-session");
    // The running item reads in its present-continuous form.
    expect(screen.getByTestId("chat-task-list-card").textContent).toBe("Tasks·0/1·Deploying to staging");
  });
});
