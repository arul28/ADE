/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type {
  AgentChatApprovalDecision,
  AgentChatEventEnvelope,
  AgentChatRecoverCodexTurnArgs,
  AgentChatRecoverCodexTurnResult,
  ComputerUseArtifactView,
} from "../../../shared/types";
import * as modelRegistry from "../../../shared/modelRegistry";
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
  findAnchoredChatEventIndex,
  formatElapsedSeconds,
  ChatInfoHostContext,
  getTranscriptCollapseCacheKeysForTests,
  reconcileMeasuredScrollTop,
  resetTranscriptCollapseCacheForTests,
  resolveAnchoredChatRowIndex,
  resolveOlderHistoryPrefetchTriggerPx,
  resolveWorkingIndicatorLabel,
  shouldAbsorbProgrammaticScrollEvent,
  stabilizeTranscriptToolActivity,
  shouldStickToBottomAfterScroll,
} from "./AgentChatMessageList";
import { looksLikeWireframe } from "./questionOptionPreview";
import {
  collapseChatTranscriptEvents,
  groupConsecutiveWorkLogRows,
} from "./chatTranscriptRows";
import { ChatPrPaneInsetContext } from "./chatPrPaneInset";
import { resetFilesWorkspaceCacheForTests } from "./chatWorkspacePaths";
import { mixedIdToolActivityBoundaryEvents } from "../../../shared/testFixtures/chatToolActivity";

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
    transcriptCollapseCacheKey?: string | null;
    laneId?: string | null;
    onInsertDraft?: (text: string) => void;
    onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
    onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => void;
    onCodexRecovery?: (args: AgentChatRecoverCodexTurnArgs) => Promise<AgentChatRecoverCodexTurnResult>;
    onRunUnprocessedMessage?: (event: Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>) => void | Promise<void>;
    onRestoreCancelledQueue?: (recoveryId: string) => Promise<boolean>;
    scrollToRowKeyRequest?: { key: string; requestId: number } | null;
    hasOlderHistory?: boolean;
    loadingOlderHistory?: boolean;
    olderHistoryError?: string | null;
    onLoadOlderHistory?: () => void;
    onRetryOlderHistory?: () => void;
    onReturnToLatest?: () => void;
    proofArtifacts?: ComputerUseArtifactView[];
    allowLocalProofArtifactProtocol?: boolean;
    onOpenProofDrawer?: () => void;
  },
) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/", state: options?.initialState }]}>
      <AgentChatMessageList
        events={events}
        assistantLabel={options?.assistantLabel}
        showStreamingIndicator={options?.showStreamingIndicator}
        sessionEnded={options?.sessionEnded}
        sessionId={options?.sessionId}
        transcriptCollapseCacheKey={options?.transcriptCollapseCacheKey}
        laneId={options?.laneId}
        onInsertDraft={options?.onInsertDraft}
        onRevealChatTerminal={options?.onRevealChatTerminal}
        onApproval={options?.onApproval as any}
        onCodexRecovery={options?.onCodexRecovery}
        onRunUnprocessedMessage={options?.onRunUnprocessedMessage}
        onRestoreCancelledQueue={options?.onRestoreCancelledQueue}
        scrollToRowKeyRequest={options?.scrollToRowKeyRequest}
        hasOlderHistory={options?.hasOlderHistory}
        loadingOlderHistory={options?.loadingOlderHistory}
        olderHistoryError={options?.olderHistoryError}
        onLoadOlderHistory={options?.onLoadOlderHistory}
        onRetryOlderHistory={options?.onRetryOlderHistory}
        onReturnToLatest={options?.onReturnToLatest}
        proofArtifacts={options?.proofArtifacts}
        allowLocalProofArtifactProtocol={options?.allowLocalProofArtifactProtocol}
        onOpenProofDrawer={options?.onOpenProofDrawer}
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

/** The message list under a floating PR pane publishing `prPaneBottomViewportPx`. */
function renderMessageListUnderPrPane(
  events: AgentChatEventEnvelope[],
  prPaneBottomViewportPx: number | null,
) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/" }]}>
      <ChatPrPaneInsetContext.Provider value={prPaneBottomViewportPx}>
        <AgentChatMessageList events={events} />
      </ChatPrPaneInsetContext.Provider>
    </MemoryRouter>,
  );
}

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
 * Y. Stub the two boxes the rail actually reads — the list root it is
 * positioned against, and its own hit strip.
 */
function stubMinimapLayout(options?: {
  listWidth?: number;
  listHeight?: number;
  /** Viewport-space top edge of the list root — the frame the PR pane converts into. */
  listTop?: number;
  railTop?: number;
  railHeight?: number;
}): { railTop: number; railHeight: number } {
  const listWidth = options?.listWidth ?? 960;
  const listHeight = options?.listHeight ?? 600;
  const listTop = options?.listTop ?? 0;
  const railTop = options?.railTop ?? 100;
  const railHeight = options?.railHeight ?? 400;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-chat-message-list-root")) {
      return makeRect({ width: listWidth, height: listHeight, top: listTop });
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
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Show activity from this turn" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Show activity from this turn" }));
    fireEvent.click(screen.getByRole("button", { name: "Open lane" }));

    expect(screen.getByTestId("location").textContent).toBe("/lanes?laneId=lane-1::null");
  });

});

describe("AgentChatMessageList transcript rendering", () => {
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
    expect(screen.queryByText("Context usage")).toBeNull();

    // The user-requested `/context` command still renders its breakdown card.
    rerender(
      <MemoryRouter initialEntries={[{ pathname: "/" }]}>
        <AgentChatMessageList
          events={[
            {
              sessionId: "session-1",
              timestamp: "2026-03-17T10:00:01.000Z",
              event: { type: "context_usage", origin: "command", usage, turnId: "turn-1" },
            },
          ]}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByText("Context usage")).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: "Show activity from this turn" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Show activity from this turn" }));
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
    expect(screen.getByText("not processed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run next" }));
    await waitFor(() => {
      expect(onRunUnprocessedMessage).toHaveBeenCalledWith(expect.objectContaining({
        steerId: "steer-1",
        deliveryState: "unprocessed",
      }));
    });
    expect(await screen.findByText("Started as the next turn")).toBeTruthy();
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
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);

    expect(screen.queryByText("Hook: PreToolUse:Bash error")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show activity from this turn" }));

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
    fireEvent.click(jumpButton);
    expect(onReturnToLatest).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
    });
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

  it("insets the rail by the PR pane's rect delta, not by its height", () => {
    // REGRESSION: the floating PR pane is positioned against the chat surface
    // while the rail is positioned against the message-list root, which sits
    // 200px lower (chat header + sync hairline). Converting a published HEIGHT
    // with the pane's `top-3` constant would read 12 + 240 + 12 = 264 here and
    // push the rail a whole header below where it belongs.
    stubMinimapLayout({ listTop: 200 });
    renderMessageListUnderPrPane(MINIMAP_TRANSCRIPT, 300);

    // 300 (pane bottom) - 200 (list root top) + 12 (gap).
    expect(screen.getByTestId("chat-user-minimap").style.top).toBe("112px");
  });

  it("drops the rail inset entirely when no PR pane is floating", () => {
    stubMinimapLayout({ listTop: 200 });
    renderMessageListUnderPrPane(MINIMAP_TRANSCRIPT, null);

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

    const pill = screen.getByRole("button", { name: "2 new · jump to latest" });
    expect(pill.textContent).toContain("2 new · jump to latest");

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

  it("clamps a long user prompt and remembers the expansion across a remount", () => {
    const longPrompt = `Migration checklist ${"detail ".repeat(120)}`;
    const events = userMessageEvents([longPrompt], "collapse-session");
    const view = renderMessageList(events, { sessionId: "collapse-session" });

    const body = () => screen.getByTestId("user-message-collapsible-body");
    expect(body().getAttribute("data-collapsed")).toBe("true");
    // A CSS mask, not line-clamp — markdown/code inside must still render.
    expect(body().className).toContain("max-h-44");
    expect(body().className).not.toContain("line-clamp");

    const toggle = screen.getByRole("button", { name: "Show full message" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(body().getAttribute("data-collapsed")).toBe("false");
    expect(body().className).not.toContain("max-h-44");
    expect(body().textContent).toContain(longPrompt);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");

    // Virtualization unmounts and remounts rows mid-scroll; the row key is
    // unchanged, so the expansion must survive.
    view.unmount();
    renderMessageList(events, { sessionId: "collapse-session" });
    expect(screen.getByTestId("user-message-collapsible-body").getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
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
    // rendering as heavier colour glyphs off the baseline of the rule line.
    // Status is carried by a Phosphor <svg>, never a text codepoint.
    expect(line.textContent).not.toMatch(/[⚙✓✗]/);
    expect(line.querySelector("svg")).toBeTruthy();
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

  it("keeps narration and file changes inline while completed tool activity moves behind the status line", () => {
    const rendered = renderMessageList([
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

    expect(rendered.container.textContent).toContain("I’ll inspect the renderer first.");
    expect(rendered.container.textContent).toContain("The focused tests pass.");
    expect(rendered.container.textContent).toContain("1 file changed");
    expect(rendered.container.textContent).not.toContain("npm test");
    expect(rendered.container.textContent).toContain("ran 5.0s");

    fireEvent.click(screen.getByRole("button", { name: "Show activity from this turn" }));
    expect(rendered.container.textContent).toContain("npm test");
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

    fireEvent.click(screen.getByRole("button", { name: "Show activity from this turn" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Show activity from this turn" }));
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
    expect(rendered.container.textContent).toMatch(/1\/2 complete/);
    expect(rendered.container.textContent).toMatch(/Inspect shared renderer/);
    expect(rendered.container.textContent).toMatch(/1 file changed/);

    fireEvent.click(screen.getByRole("button", { name: "Review in Files" }));
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

    const summaries = rendered.container.textContent?.match(/files? changed/g) ?? [];
    expect(summaries).toHaveLength(1);
    expect(rendered.container.textContent).toContain("2 files changed");
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
