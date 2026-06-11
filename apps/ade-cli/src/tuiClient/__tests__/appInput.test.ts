import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_TERMINAL_SUBMIT_CONFIRM_DELAY_MS,
  clampChatScrollOffsetRows,
  cycleLaneDeleteScope,
  deletePromptBackward,
  deletePromptForward,
  deletePreviousPromptLine,
  deletePreviousPromptWord,
  encodeTerminalPromptSubmit,
  encodeTerminalPromptSubmitConfirm,
  applyCoalescedPromptInput,
  firstUrlInText,
  footerControlsForAvailability,
  inlineRowCellOrder,
  formatGitConflictReport,
  formatLaneDeleteRisk,
  formFieldUsesPromptInput,
  isChatSessionAnimating,
  isPromptLineBackspace,
  isPromptWordBackspace,
  isTerminalSessionFastPollActive,
  isLaneWorktreeAvailable,
  isTerminalSessionWorking,
  isTerminalSessionResumable,
  shouldToggleLatestFailedLineOnBlankEnter,
  isTerminalControlToggle,
  isTerminalMouseTrackingEnabled,
  isChatTextSelectionRange,
  isChatCopyShortcut,
  isCtrlCCopyPlatform,
  isCtrlInput,
  chatSelectionEdgeDirectionForMouseY,
  chatSelectionFromAnchor,
  chatSessionToOptimisticSummary,
  chatSelectionPointFromVisibleRows,
  codexApprovalSandboxLabel,
  cursorModeIdsForState,
  moveChatSelectionFocusByRows,
  mergeOptimisticChatSessions,
  insertPromptText,
  isPromptCursorOnFirstVisualRow,
  isPromptCursorOnLastVisualRow,
  movePromptCursorVertical,
  parseTerminalMouseInput,
  promptDisplayRows,
  promptDisplayRowsWithCursor,
  promptHitLine,
  modelPickerPaneContentOrigin,
  modelPickerProviderSwitchBlocked,
  mergeNewChatModelPickerContext,
  normalizeCatalogProvider,
  resolveContextDefault,
  resolveDrawerPaneWidth,
  resolveModelPickerEscape,
  resolveChatWrapWidth,
  resolveTerminalPaneWidth,
  splitTerminalControlInput,
  subagentSnapshotsFromEvents,
} from "../app";
import { clampTerminalPaneCols } from "../components/TerminalPane";
import type { ChatInfoSnapshot } from "../types";
import { resolveSubagentCapability } from "../../../../desktop/src/shared/subagentCapabilities";
import type { AgentChatSession, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { ChatTerminalSession } from "../../../../desktop/src/shared/types/sessions";

describe("session activity helpers", () => {
  it("does not animate idle or input-blocked chat sessions", () => {
    expect(isChatSessionAnimating({ status: "active", awaitingInput: false, idleSinceAt: null })).toBe(true);
    expect(isChatSessionAnimating({ status: "active", awaitingInput: true, idleSinceAt: null })).toBe(false);
    expect(isChatSessionAnimating({ status: "active", awaitingInput: false, idleSinceAt: "2026-05-20T07:00:00.000Z" })).toBe(false);
    expect(isChatSessionAnimating({ status: "idle", awaitingInput: false, idleSinceAt: null })).toBe(false);
  });

  it("does not animate an idle terminal process but keeps fast polling while it is busy", () => {
    expect(isTerminalSessionWorking({ status: "running", runtimeState: "running", pid: process.pid })).toBe(true);
    expect(isTerminalSessionWorking({ status: "running", runtimeState: "running", pid: null })).toBe(false);
    expect(isTerminalSessionWorking({ status: "running", runtimeState: "idle", pid: process.pid })).toBe(false);
    expect(isTerminalSessionWorking({ status: "running", runtimeState: "waiting-input", pid: process.pid })).toBe(false);

    expect(isTerminalSessionFastPollActive({ status: "running", runtimeState: "running", pid: process.pid })).toBe(true);
    expect(isTerminalSessionFastPollActive({ status: "running", runtimeState: "waiting-input", pid: process.pid })).toBe(true);
    expect(isTerminalSessionFastPollActive({ status: "running", runtimeState: "running", pid: null })).toBe(false);
    expect(isTerminalSessionFastPollActive({ status: "running", runtimeState: "idle", pid: process.pid })).toBe(false);
    expect(isTerminalSessionFastPollActive({ status: "completed", runtimeState: "exited", pid: process.pid })).toBe(false);
  });

  it("recognizes closed resumable terminal sessions", () => {
    const session: ChatTerminalSession = {
      terminalId: "terminal-1",
      ptyId: null,
      chatSessionId: null,
      laneId: "lane-1",
      laneName: "Lane 1",
      title: "Claude Code",
      toolType: "claude",
      goal: null,
      status: "completed",
      runtimeState: "exited",
      active: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      exitCode: 0,
      pid: null,
      resumeCommand: "claude --resume session-1",
      lastOutputPreview: null,
      summary: null,
    };

    expect(isTerminalSessionResumable(session)).toBe(true);
    expect(isTerminalSessionResumable({ ...session, status: "running", runtimeState: "idle", active: true })).toBe(false);
    expect(isTerminalSessionResumable({ ...session, resumeCommand: null, resumeMetadata: null })).toBe(false);
    expect(isTerminalSessionResumable({ ...session, toolType: "shell" })).toBe(false);
    expect(isTerminalSessionResumable({
      ...session,
      toolType: "shell",
      resumeMetadata: { provider: "claude", targetKind: "session", targetId: "session-1", launch: {} },
    })).toBe(true);
  });

  it("lets blank Enter resume a closed terminal instead of toggling the latest failed line", () => {
    const terminal: ChatTerminalSession = {
      terminalId: "terminal-1",
      ptyId: null,
      chatSessionId: null,
      laneId: "lane-1",
      laneName: "Lane 1",
      title: "Claude Code",
      toolType: "claude",
      goal: null,
      status: "completed",
      runtimeState: "exited",
      active: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      exitCode: 0,
      pid: null,
      resumeCommand: "claude --resume session-1",
      lastOutputPreview: null,
      summary: null,
    };

    expect(shouldToggleLatestFailedLineOnBlankEnter({
      pane: "chat",
      prompt: "",
      latestFailedLineId: "1:command:2026-01-01T00:00:00.000Z",
      pendingApproval: null,
      rightPaneKind: "empty",
      slashRowCount: 0,
      activeTerminalSession: null,
    })).toBe(true);
    expect(shouldToggleLatestFailedLineOnBlankEnter({
      pane: "chat",
      prompt: "",
      latestFailedLineId: "1:command:2026-01-01T00:00:00.000Z",
      pendingApproval: null,
      rightPaneKind: "empty",
      slashRowCount: 0,
      activeTerminalSession: terminal,
    })).toBe(false);
  });
});

describe("parseTerminalMouseInput", () => {
  it("parses SGR mouse wheel events from Ink input", () => {
    expect(parseTerminalMouseInput("\x1b[<64;42;12M")).toEqual({
      kind: "wheel",
      direction: "up",
      x: 42,
      y: 12,
    });
    expect(parseTerminalMouseInput("[<64;42;12M")).toEqual({
      kind: "wheel",
      direction: "up",
      x: 42,
      y: 12,
    });
    expect(parseTerminalMouseInput("[<65;42;12M")).toEqual({
      kind: "wheel",
      direction: "down",
      x: 42,
      y: 12,
    });
  });

  it("parses rxvt mouse wheel events from terminals that do not emit SGR", () => {
    expect(parseTerminalMouseInput("[64;42;12M")).toEqual({
      kind: "wheel",
      direction: "up",
      x: 42,
      y: 12,
    });
  });

  it("parses X10 mouse wheel events from legacy terminal packets", () => {
    expect(parseTerminalMouseInput("\x1b[M`J,")).toEqual({
      kind: "wheel",
      direction: "up",
      x: 42,
      y: 12,
    });
  });

  it("parses primary clicks so panes can opt into mouse selection", () => {
    expect(parseTerminalMouseInput("[<0;5;6M")).toEqual({
      kind: "click",
      x: 5,
      y: 6,
    });
  });

  it("parses primary drags and releases for chat text selection", () => {
    expect(parseTerminalMouseInput("[<32;7;8M")).toEqual({
      kind: "drag",
      x: 7,
      y: 8,
    });
    expect(parseTerminalMouseInput("[<0;7;8m")).toEqual({
      kind: "release",
      x: 7,
      y: 8,
    });
  });

  it("parses any-event pointer moves for hover hit-testing", () => {
    expect(parseTerminalMouseInput("[<35;9;10M")).toEqual({
      kind: "move",
      x: 9,
      y: 10,
    });
  });

  it("parses mouse modifier bits", () => {
    expect(parseTerminalMouseInput("[<20;5;6M")).toEqual({
      kind: "click",
      x: 5,
      y: 6,
      shift: true,
      ctrl: true,
    });
    expect(parseTerminalMouseInput("[<88;5;6M")).toEqual({
      kind: "wheel",
      direction: "up",
      x: 5,
      y: 6,
      alt: true,
      ctrl: true,
    });
    expect(parseTerminalMouseInput("[<52;7;8M")).toEqual({
      kind: "drag",
      x: 7,
      y: 8,
      shift: true,
      ctrl: true,
    });
    expect(parseTerminalMouseInput("[<16;7;8m")).toEqual({
      kind: "release",
      x: 7,
      y: 8,
      ctrl: true,
    });
  });

  it("swallows batched SGR mouse events from fast scrolling", () => {
    expect(parseTerminalMouseInput("[<64;104;32M[<64;104;32M[<65;104;31M")).toEqual({
      kind: "wheel",
      direction: "up",
      x: 104,
      y: 32,
    });
  });

  it("keeps the actionable click when all-motion hover packets are batched before it", () => {
    expect(parseTerminalMouseInput("[<35;4;8M[<35;5;8M[<0;5;8M")).toEqual({
      kind: "click",
      x: 5,
      y: 8,
    });
  });

  it("ignores normal keyboard input", () => {
    expect(parseTerminalMouseInput("hello")).toBeNull();
  });
});

describe("control input normalization", () => {
  it("matches both Ink ctrl metadata and raw terminal control bytes", () => {
    expect(isCtrlInput("o", { ctrl: true }, "o")).toBe(true);
    expect(isCtrlInput("\x0f", {}, "o")).toBe(true);
    expect(isCtrlInput("\x10", {}, "p")).toBe(true);
    expect(isCtrlInput("o", { ctrl: true, meta: true }, "o")).toBe(false);
    expect(isCtrlInput("x", {}, "o")).toBe(false);
  });
});

describe("lane delete form helpers", () => {
  it("cycles lane delete scope through visible destructive choices", () => {
    expect(cycleLaneDeleteScope("worktree", 1)).toBe("local_branch");
    expect(cycleLaneDeleteScope("local_branch", 1)).toBe("remote_branch");
    expect(cycleLaneDeleteScope("remote_branch", 1)).toBe("worktree");
    expect(cycleLaneDeleteScope("worktree", -1)).toBe("remote_branch");
    expect(cycleLaneDeleteScope("nonsense", 1)).toBe("local_branch");
  });

  it("does not treat lane-delete select and toggle rows as prompt text", () => {
    expect(formFieldUsesPromptInput("lane-delete", "scope")).toBe(false);
    expect(formFieldUsesPromptInput("lane-delete", "force")).toBe(false);
    expect(formFieldUsesPromptInput("lane-delete", "confirm")).toBe(true);
    expect(formFieldUsesPromptInput("feedback", "body")).toBe(true);
  });
});

describe("lane worktree availability", () => {
  function laneAt(worktreePath: string): LaneSummary {
    return {
      id: "lane-1",
      name: "Lane one",
      laneType: "worktree",
      baseRef: "main",
      branchRef: "feature/lane-one",
      worktreePath,
      parentLaneId: null,
      childCount: 0,
      stackDepth: 0,
      parentStatus: null,
      isEditProtected: false,
      status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
      color: null,
      icon: null,
      tags: [],
      createdAt: "2026-05-20T00:00:00.000Z",
    };
  }

  it("rejects an existing stale directory that resolves to another git root", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tui-stale-lane-"));
    try {
      const init = spawnSync("git", ["init"], { cwd: repoRoot, encoding: "utf8" });
      const staleLanePath = path.join(repoRoot, ".ade", "worktrees", "stale-lane");
      fs.mkdirSync(staleLanePath, { recursive: true });

      if (init.status === 0) {
        expect(isLaneWorktreeAvailable(laneAt(repoRoot))).toBe(true);
      } else {
        fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
        expect(isLaneWorktreeAvailable(laneAt(repoRoot))).toBe(true);
      }
      expect(isLaneWorktreeAvailable(laneAt(staleLanePath))).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("right pane context defaults", () => {
  function laneForContext(overrides: Partial<LaneSummary> = {}): LaneSummary {
    return {
      id: "lane-1",
      name: "Lane one",
      laneType: "worktree",
      baseRef: "main",
      branchRef: "feature/lane-one",
      worktreePath: "/tmp/lane-one",
      parentLaneId: null,
      childCount: 0,
      stackDepth: 0,
      parentStatus: null,
      isEditProtected: false,
      status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
      color: null,
      icon: null,
      tags: [],
      createdAt: "2026-05-20T00:00:00.000Z",
      ...overrides,
    };
  }

  function chatInfoForContext(): ChatInfoSnapshot {
    return {
      provider: "claude",
      modelLabel: "Claude Sonnet 4.6",
      laneLabel: "Lane one",
      contextPercent: null,
      tokenSummary: null,
      goal: null,
      plan: { current: 0, total: 0, live: false, steps: [] },
      planExplanation: null,
      planStreamingText: null,
      todos: [],
      pr: null,
      snapshots: [],
      inspectedSubagentId: null,
      streaming: false,
      capability: resolveSubagentCapability("claude"),
      mission: null,
    };
  }

  it("keeps the new-chat setup pane ahead of stale lane drawer highlights", () => {
    const lane = laneForContext();
    const pane = resolveContextDefault({
      draftChatActive: true,
      activeSession: null,
      activeLane: lane,
      liveAgentCount: 0,
      highlightedDrawerLane: lane,
      drawerMode: "lanes",
      drawerNav: null,
      chatInfo: chatInfoForContext(),
      subagentSnapshots: [],
      provider: "claude",
      newChatSetup: {
        laneId: lane.id,
        laneLabel: lane.name,
        rows: [{ kind: "model", label: "Model", value: "Claude Sonnet 4.6", cyclable: true }],
      },
      unavailableLaneIds: new Set(),
    });

    expect(pane).toMatchObject({
      kind: "model-picker",
      surface: "new-chat",
      laneId: "lane-1",
      laneLabel: "Lane one",
      selection: { kind: "provider", provider: "claude" },
      // Two-stage nav: the picker opens in the model list (Stage 1), NOT focused
      // on the Confirm button — Enter is the gate into the settings.
      footerFocus: null,
      focusedIndex: 0,
    });
  });
});

describe("modelPickerPaneContentOrigin", () => {
  it("offsets past RightPane's border + MODEL title + paddingX so hit-rects match the paint", () => {
    // Outer pane top-left is (paneLeft, paneTop); ModelPickerPane's first painted
    // cell is 2 rows down (border + title) and 2 cols right (border + paddingX),
    // with 4 fewer usable columns.
    expect(modelPickerPaneContentOrigin({ paneTop: 5, paneLeft: 100, paneWidth: 38 }))
      .toEqual({ paneTop: 7, paneLeft: 102, paneWidth: 34 });
  });

  it("clamps the content width to a floor for very narrow panes", () => {
    expect(modelPickerPaneContentOrigin({ paneTop: 0, paneLeft: 0, paneWidth: 6 }).paneWidth).toBe(8);
  });
});

describe("model picker provider normalization and locking", () => {
  it("normalizes catalog provider aliases before committing a model", () => {
    expect(normalizeCatalogProvider("anthropic")).toBe("claude");
    expect(normalizeCatalogProvider("openai")).toBe("codex");
    expect(normalizeCatalogProvider("factory")).toBe("droid");
  });

  it("blocks provider switches only for locked existing chats", () => {
    expect(modelPickerProviderSwitchBlocked({
      providerLocked: true,
      surface: "chat",
      currentProvider: "codex",
      nextProvider: "claude",
    })).toBe(true);
    expect(modelPickerProviderSwitchBlocked({
      providerLocked: true,
      surface: "chat",
      currentProvider: "codex",
      nextProvider: "codex",
    })).toBe(false);
    expect(modelPickerProviderSwitchBlocked({
      providerLocked: true,
      surface: "new-chat",
      currentProvider: "codex",
      nextProvider: "claude",
    })).toBe(false);
  });

  it("preserves in-progress new-chat picker focus when context refreshes lane/settings rows", () => {
    const prev = {
      kind: "model-picker" as const,
      surface: "new-chat" as const,
      query: "sonnet",
      searchMode: true,
      selection: { kind: "provider" as const, provider: "claude" as const },
      focusedIndex: 4,
      railFocused: false,
      footerFocus: "reasoning" as const,
      settingsRows: [{ kind: "reasoning" as const, label: "Reasoning", value: "high" }],
      laneId: "lane-old",
      laneLabel: "Old lane",
    };
    const next = {
      ...prev,
      query: "",
      searchMode: false,
      selection: { kind: "provider" as const, provider: "codex" as const },
      focusedIndex: 0,
      railFocused: true,
      footerFocus: null,
      settingsRows: [{ kind: "permission" as const, label: "Permissions", value: "auto" }],
      laneId: "lane-new",
      laneLabel: "New lane",
    };

    expect(mergeNewChatModelPickerContext(prev, next)).toEqual({
      ...prev,
      laneId: "lane-new",
      laneLabel: "New lane",
      settingsRows: [{ kind: "permission", label: "Permissions", value: "auto" }],
    });
  });
});

describe("drawer mouse hit testing", () => {
  it("widens the drawer responsively on larger terminals", () => {
    expect(resolveDrawerPaneWidth(100, false)).toBe(0);
    expect(resolveDrawerPaneWidth(100, true)).toBe(32);
    expect(resolveDrawerPaneWidth(160, true)).toBe(38);
    expect(resolveDrawerPaneWidth(228, true)).toBe(43);
    expect(resolveDrawerPaneWidth(400, true)).toBe(48);
  });

  // Drawer mouse hit-testing now lives in drawerLayout.ts and is covered by
  // __tests__/drawerLayout.test.ts against the shared layout model.
});

describe("prompt mouse hit testing", () => {
  it("maps bottom prompt box lines back to chat focus", () => {
    expect(promptHitLine({ y: 84, rows: 88, promptRowCount: 1 })).toBe(true);
    expect(promptHitLine({ y: 87, rows: 88, promptRowCount: 1 })).toBe(true);
    expect(promptHitLine({ y: 83, rows: 88, promptRowCount: 1 })).toBe(false);
    expect(promptHitLine({ y: 82, rows: 88, promptRowCount: 3 })).toBe(true);
    expect(promptHitLine({ y: null, rows: 88, promptRowCount: 1 })).toBe(false);
  });
});

describe("chat text selection helpers", () => {
  it("resolves visible rows to absolute transcript rows", () => {
    const rows = [
      { sourceRow: null, text: "↑ older messages" },
      { sourceRow: 42, text: "hello" },
      { sourceRow: 43, text: "world" },
    ];

    expect(chatSelectionPointFromVisibleRows(rows, 1, 3, false)).toEqual({ row: 42, column: 3 });
    expect(chatSelectionPointFromVisibleRows(rows, 0, 2, false)).toBeNull();
    expect(chatSelectionPointFromVisibleRows(rows, 0, 2, true)).toEqual({ row: 42, column: 2 });
  });

  it("moves an active selection focus within transcript bounds", () => {
    expect(moveChatSelectionFocusByRows({
      startRow: 5,
      startColumn: 1,
      endRow: 5,
      endColumn: 3,
      active: true,
    }, -10, 20, 0)).toMatchObject({ endRow: 0, endColumn: 0 });

    expect(moveChatSelectionFocusByRows({
      startRow: 5,
      startColumn: 1,
      endRow: 18,
      endColumn: 3,
      active: true,
    }, 10, 20, 7)).toMatchObject({ endRow: 19, endColumn: 7 });
  });

  it("extends chat selection from a retained anchor", () => {
    expect(chatSelectionFromAnchor(
      { row: 4, column: 2 },
      { row: 9, column: 12 },
      true,
    )).toEqual({
      startRow: 4,
      startColumn: 2,
      endRow: 9,
      endColumn: 12,
      active: true,
    });
  });

  it("starts selection autoscroll after leaving reachable transcript edge rows", () => {
    expect(chatSelectionEdgeDirectionForMouseY({
      y: 1,
      topRow: 2,
      rowBudget: 8,
      scrollOffsetRows: 1,
      maxScrollOffsetRows: 4,
    })).toBe("older");
    expect(chatSelectionEdgeDirectionForMouseY({
      y: 10,
      topRow: 2,
      rowBudget: 8,
      scrollOffsetRows: 1,
      maxScrollOffsetRows: 4,
    })).toBe("newer");
    expect(chatSelectionEdgeDirectionForMouseY({
      y: 2,
      topRow: 2,
      rowBudget: 8,
      scrollOffsetRows: 1,
      maxScrollOffsetRows: 4,
    })).toBeNull();
    expect(chatSelectionEdgeDirectionForMouseY({
      y: 9,
      topRow: 2,
      rowBudget: 8,
      scrollOffsetRows: 1,
      maxScrollOffsetRows: 4,
    })).toBeNull();
    expect(chatSelectionEdgeDirectionForMouseY({
      y: 5,
      topRow: 2,
      rowBudget: 8,
      scrollOffsetRows: 1,
      maxScrollOffsetRows: 4,
    })).toBeNull();
  });

  it("detects non-collapsed chat selections", () => {
    expect(isChatTextSelectionRange(null)).toBe(false);
    expect(isChatTextSelectionRange({ startRow: 1, startColumn: 2, endRow: 1, endColumn: 2 })).toBe(false);
    expect(isChatTextSelectionRange({ startRow: 1, startColumn: 2, endRow: 2, endColumn: 0 })).toBe(true);
  });

  it("only lets Windows use Ctrl+C as copy when chat text is selected", () => {
    expect(isCtrlCCopyPlatform("win32")).toBe(true);
    expect(isCtrlCCopyPlatform("darwin")).toBe(false);
    expect(isCtrlCCopyPlatform("linux")).toBe(false);
  });

  it("recognizes command-copy for internal highlighted chat text", () => {
    expect(isChatCopyShortcut("c", { meta: true }, "darwin")).toBe(true);
    expect(isChatCopyShortcut("\x03", { meta: true }, "darwin")).toBe(true);
    expect(isChatCopyShortcut("c", { ctrl: true }, "darwin")).toBe(false);
    expect(isChatCopyShortcut("c", { ctrl: true }, "win32")).toBe(true);
  });
});

describe("footer control ordering", () => {
  it("puts chat info first when that pane is available", () => {
    expect(footerControlsForAvailability(true)).toEqual(["agents", "drawer", "details"]);
    expect(footerControlsForAvailability(false)).toEqual(["drawer", "details"]);
  });
});

describe("firstUrlInText", () => {
  it("finds a bare URL with its index + width and strips trailing punctuation", () => {
    const hit = firstUrlInText("see https://example.com/docs. thanks");
    expect(hit?.url).toBe("https://example.com/docs");
    expect(hit?.index).toBe(4);
    expect(hit?.width).toBe("https://example.com/docs".length);
  });
  it("resolves a markdown link to its href but spans the visible label", () => {
    const hit = firstUrlInText("[the docs](https://example.com/x)");
    expect(hit?.url).toBe("https://example.com/x");
    expect(hit?.index).toBe(0);
    expect(hit?.width).toBe("the docs".length);
  });
  it("returns null when there is no link", () => {
    expect(firstUrlInText("just some plain text")).toBeNull();
  });
});

describe("inlineRowCellOrder", () => {
  it("includes fast + reasoning only when supported, and provider/subagents per context", () => {
    expect(inlineRowCellOrder({ providerLocked: false, fastSupported: true, reasoningSupported: true, subagentsVisible: true }))
      .toEqual(["provider", "model", "fast", "reasoning", "permission", "subagents"]);
    // No fast/reasoning support → those cells are absent (not dead focus stops).
    expect(inlineRowCellOrder({ providerLocked: false, fastSupported: false, reasoningSupported: false, subagentsVisible: false }))
      .toEqual(["provider", "model", "permission"]);
    // Provider locked (chat underway) drops the provider cell.
    expect(inlineRowCellOrder({ providerLocked: true, fastSupported: true, reasoningSupported: false, subagentsVisible: false }))
      .toEqual(["model", "fast", "permission"]);
  });
});

describe("provider permission helpers", () => {
  it("summarizes Codex approval and sandbox as a footer detail", () => {
    expect(codexApprovalSandboxLabel({
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
    })).toBe("on-request · workspace-write");
  });

  it("uses Cursor runtime snapshot modes before falling back to static modes", () => {
    expect(cursorModeIdsForState({ cursorAvailableModeIds: ["ask", "plan"] })).toEqual(["ask", "plan"]);
    expect(cursorModeIdsForState({ cursorAvailableModeIds: [] })).toContain("agent");
  });
});

describe("formatGitConflictReport", () => {
  it("lists conflicted files and the continue/abort actions for a rebase", () => {
    const report = formatGitConflictReport({
      laneId: "lane-1",
      kind: "rebase",
      inProgress: true,
      conflictedFiles: ["src/a.ts", "src/b.ts"],
      canContinue: true,
      canAbort: true,
    });
    expect(report.title).toBe("Rebase conflict");
    expect(report.body).toContain("2 files need resolution");
    expect(report.body).toContain("src/a.ts");
    expect(report.body).toContain("/pull --continue");
    expect(report.body).toContain("/pull --abort");
    expect(report.summary).toContain("Rebase conflict — 2 files");
  });

  it("uses merge wording and falls back when no continue/abort is available", () => {
    const report = formatGitConflictReport({
      laneId: "lane-1",
      kind: "merge",
      inProgress: true,
      conflictedFiles: [],
      canContinue: false,
      canAbort: false,
    });
    expect(report.title).toBe("Merge conflict");
    expect(report.body).toContain("0 files need resolution");
    expect(report.body).toContain("git did not report specific files");
    expect(report.body).toContain("Resolve the conflicts in your editor");
    expect(report.body).not.toContain("/pull --continue");
  });
});

describe("applyCoalescedPromptInput", () => {
  const DEL = "\u007f";
  it("inserts pure printable input unchanged", () => {
    expect(applyCoalescedPromptInput("", 0, "abc")).toEqual({ value: "abc", cursor: 3 });
    expect(applyCoalescedPromptInput("ac", 1, "b")).toEqual({ value: "abc", cursor: 2 });
  });
  it("applies a backspace that was coalesced with a typed char (the bug)", () => {
    // "x" typed then immediately backspaced, delivered as one chunk.
    expect(applyCoalescedPromptInput("", 0, `x${DEL}`)).toEqual({ value: "", cursor: 0 });
  });
  it("applies multiple coalesced backspaces", () => {
    expect(applyCoalescedPromptInput("ab", 2, `${DEL}${DEL}`)).toEqual({ value: "", cursor: 0 });
  });
  it("interleaves deletes and inserts in order", () => {
    expect(applyCoalescedPromptInput("", 0, `a${DEL}b`)).toEqual({ value: "b", cursor: 1 });
    expect(applyCoalescedPromptInput("yz", 2, `${DEL}x`)).toEqual({ value: "yx", cursor: 2 });
  });
  it("strips other control bytes but keeps text", () => {
    expect(applyCoalescedPromptInput("", 0, "a\u0000b")).toEqual({ value: "ab", cursor: 2 });
  });
});

describe("formatLaneDeleteRisk", () => {
  const base = {
    laneId: "lane-1",
    branchRef: "feat/x",
    dirty: false,
    hasUnpushedCommits: false,
    unpushedCommitCount: 0,
    remoteBranchExists: false,
    runningProcessCount: 0,
    activeChatCount: 0,
    activePtyCount: 0,
    activeWatcherCount: 0,
    envInitialized: false,
  };

  it("summarizes everything that would be lost, pluralizing correctly", () => {
    const summary = formatLaneDeleteRisk({
      ...base,
      dirty: true,
      hasUnpushedCommits: true,
      unpushedCommitCount: 1,
      runningProcessCount: 2,
      activeChatCount: 1,
      activePtyCount: 1,
      remoteBranchExists: true,
    });
    expect(summary).toContain("uncommitted changes");
    expect(summary).toContain("1 unpushed commit");
    expect(summary).not.toContain("1 unpushed commits");
    expect(summary).toContain("2 running processes");
    expect(summary).toContain("1 chat session");
    expect(summary).toContain("1 terminal");
    expect(summary).toContain("remote branch exists");
    expect(summary.startsWith("⚠")).toBe(true);
  });

  it("reports a clean lane when there is nothing at risk", () => {
    expect(formatLaneDeleteRisk(base)).toBe("Clean — no unpushed work or running processes.");
  });
});

describe("model picker escape handling", () => {
  const picker = {
    kind: "model-picker" as const,
    surface: "chat" as const,
    query: "",
    searchMode: false,
    selection: { kind: "favorites" as const },
    focusedIndex: 3,
  };

  it("clears active search before closing the model picker", () => {
    expect(resolveModelPickerEscape({ ...picker, query: "sonnet", searchMode: true })).toEqual({
      kind: "clear-search",
      pane: {
        ...picker,
        query: "",
        searchMode: false,
        focusedIndex: 0,
      },
    });

    expect(resolveModelPickerEscape({ ...picker, query: "", searchMode: true })).toEqual({
      kind: "clear-search",
      pane: {
        ...picker,
        query: "",
        searchMode: false,
        focusedIndex: 0,
      },
    });
  });

  it("closes chat model pickers and returns new-chat model pickers to setup", () => {
    expect(resolveModelPickerEscape(picker)).toEqual({ kind: "close" });
    expect(resolveModelPickerEscape({ ...picker, surface: "new-chat" })).toEqual({ kind: "return-new-chat" });
  });
});

describe("terminal control toggle", () => {
  it("recognizes ctrl-t from Ink key data and raw terminal bytes", () => {
    expect(isTerminalControlToggle("t", { ctrl: true })).toBe(true);
    expect(isTerminalControlToggle("T", { ctrl: true })).toBe(true);
    expect(isTerminalControlToggle("\x14", {})).toBe(true);
    expect(isTerminalControlToggle("t", {})).toBe(false);
  });

  it("detaches from terminal control while preserving other raw input bytes", () => {
    expect(splitTerminalControlInput("a\x14b\x1dc")).toEqual({
      detach: true,
      forwarded: "abc",
    });
    expect(splitTerminalControlInput("\x1b[A")).toEqual({
      detach: false,
      forwarded: "\x1b[A",
    });
  });
});

describe("pane width helpers", () => {
  it("lets prose chat and embedded terminals use the full center pane", () => {
    expect(resolveChatWrapWidth(180, false, 0)).toBe(180);
    expect(resolveChatWrapWidth(Number.NaN, false, 0)).toBe(24);
    expect(resolveTerminalPaneWidth(180)).toBe(180);
    expect(resolveTerminalPaneWidth(Number.NaN)).toBe(24);
    expect(clampTerminalPaneCols(360)).toBe(360);
    expect(clampTerminalPaneCols(999)).toBe(400);
    expect(clampTerminalPaneCols(Number.POSITIVE_INFINITY)).toBe(20);
  });

  it("reserves a right gutter when the details pane is open so chat text does not hug the border", () => {
    expect(resolveChatWrapWidth(72, true, 34)).toBe(70); // open pane → 2-col gutter
    expect(resolveChatWrapWidth(72, true, 0)).toBe(72); // closed pane → no gutter
    expect(resolveChatWrapWidth(24, true, 34)).toBe(24); // gutter never underflows the min
  });
});

describe("subagentSnapshotsFromEvents", () => {
  it("uses agentId as the stable row id when runtimes provide both ids", () => {
    const snapshots = subagentSnapshotsFromEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "subagent_started",
          taskId: "task-1",
          agentId: "agent-1",
          parentToolUseId: null,
          description: "Investigate issue",
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: {
          type: "subagent_result",
          taskId: "task-1",
          agentId: "agent-1",
          parentToolUseId: null,
          status: "completed",
          summary: "done",
        },
      },
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      id: "agent-1",
      name: "Investigate issue",
      status: "completed",
      summary: "done",
    });
  });

  it("adopts the resolved task id when a runtime placeholder has the same parent tool id", () => {
    const snapshots = subagentSnapshotsFromEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "subagent_started",
          taskId: "spawn-1",
          parentToolUseId: "spawn-1",
          description: "Parallel agent",
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: {
          type: "subagent_progress",
          taskId: "thread-1",
          parentToolUseId: "spawn-1",
          summary: "working",
        },
      },
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      id: "thread-1",
      name: "Parallel agent",
      parentToolUseId: "spawn-1",
      status: "running",
      summary: "working",
    });
  });

  it("keeps sibling subagents separate when they share the same parent tool id", () => {
    const snapshots = subagentSnapshotsFromEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "subagent_started",
          taskId: "thread-1",
          parentToolUseId: "spawn-1",
          description: "Inspect renderer",
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: {
          type: "subagent_started",
          taskId: "thread-2",
          parentToolUseId: "spawn-1",
          description: "Inspect service",
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:02.000Z",
        sequence: 3,
        event: {
          type: "subagent_result",
          taskId: "thread-1",
          parentToolUseId: "spawn-1",
          status: "completed",
          summary: "renderer done",
        },
      },
    ]);

    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((snapshot) => snapshot.id).sort()).toEqual(["thread-1", "thread-2"]);
    expect(snapshots.find((snapshot) => snapshot.id === "thread-1")).toMatchObject({
      status: "completed",
      summary: "renderer done",
    });
    expect(snapshots.find((snapshot) => snapshot.id === "thread-2")).toMatchObject({
      status: "running",
      summary: "Inspect service",
    });
  });

  it("stops foreground subagents when their parent turn has ended", () => {
    const snapshots = subagentSnapshotsFromEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "subagent_started",
          taskId: "agent-1",
          description: "Foreground agent",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: {
          type: "subagent_started",
          taskId: "agent-bg",
          description: "Background agent",
          background: true,
          turnId: "turn-1",
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:02.000Z",
        sequence: 3,
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);

    expect(snapshots.find((snapshot) => snapshot.id === "agent-1")).toMatchObject({
      status: "stopped",
      summary: "Parent turn ended before ADE received a final subagent status",
    });
    expect(snapshots.find((snapshot) => snapshot.id === "agent-bg")).toMatchObject({
      status: "running",
      background: true,
    });
  });
});

describe("clampChatScrollOffsetRows", () => {
  it("clamps overscroll immediately so downward input can recover from the oldest rows", () => {
    const top = clampChatScrollOffsetRows(Number.MAX_SAFE_INTEGER, 12);
    expect(top).toBe(12);
    expect(clampChatScrollOffsetRows(top - 3, 12)).toBe(9);
  });

  it("clamps negative and invalid offsets to the bottom", () => {
    expect(clampChatScrollOffsetRows(-5, 12)).toBe(0);
    expect(clampChatScrollOffsetRows(Number.NaN, 12)).toBe(0);
  });
});

describe("prompt editing helpers", () => {
  it("deletes the previous whitespace-delimited word", () => {
    expect(deletePreviousPromptWord("hello world")).toBe("hello ");
    expect(deletePreviousPromptWord("hello world   ")).toBe("hello ");
    expect(deletePreviousPromptWord("single")).toBe("");
    expect(deletePreviousPromptWord("")).toBe("");
  });

  it("recognizes common word-backspace key encodings", () => {
    expect(isPromptWordBackspace("w", { ctrl: true })).toBe(true);
    expect(isPromptWordBackspace("", { ctrl: true, backspace: true })).toBe(true);
    expect(isPromptWordBackspace("", { meta: true, backspace: true })).toBe(true);
    expect(isPromptWordBackspace("\x1b\u007f", { meta: true })).toBe(true);
    expect(isPromptWordBackspace("x", {})).toBe(false);
  });

  it("deletes the current prompt line from the end", () => {
    expect(deletePreviousPromptLine("one two")).toBe("");
    expect(deletePreviousPromptLine("one\ntwo")).toBe("one\n");
    expect(deletePreviousPromptLine("one\ntwo\n")).toBe("one\ntwo");
    expect(deletePreviousPromptLine("")).toBe("");
  });

  it("recognizes common line-backspace key encodings", () => {
    expect(isPromptLineBackspace("u", { ctrl: true })).toBe(true);
    expect(isPromptLineBackspace("", { meta: true, backspace: true })).toBe(false);
    expect(isPromptLineBackspace("", { meta: true, delete: true })).toBe(false);
    expect(isPromptLineBackspace("\x1b\u007f", { meta: true })).toBe(false);
    expect(isPromptLineBackspace("\x1b[3;3~", { meta: true })).toBe(false);
    expect(isPromptLineBackspace("", { ctrl: true, backspace: true } as { ctrl: boolean; backspace: boolean })).toBe(false);
  });

  it("caps prompt display rows at the newest visual lines", () => {
    expect(promptDisplayRows("one\ntwo", 20)).toEqual(["one", "two"]);
    expect(promptDisplayRows("abcdef", 2, 5)).toEqual(["ab", "cd", "ef", ""]);
    expect(promptDisplayRows("1\n2\n3\n4\n5\n6", 20, 5)).toEqual(["2", "3", "4", "5", "6"]);
  });

  it("keeps the cursor on a fresh visual row when the prompt exactly fills a row", () => {
    expect(promptDisplayRows("abcd", 4)).toEqual(["abcd", ""]);
    expect(promptDisplayRows("abcde", 4)).toEqual(["abcd", "e"]);
  });

  it("reports the cursor row and column for wrapped prompt text", () => {
    expect(promptDisplayRowsWithCursor("abcdef", 3, 4).rows).toEqual([
      { text: "abc", start: 0, end: 3, cursorColumn: null },
      { text: "def", start: 3, end: 6, cursorColumn: 1 },
      { text: "", start: 6, end: 6, cursorColumn: null },
    ]);
  });

  it("moves vertically between prompt visual rows without jumping to the end", () => {
    expect(movePromptCursorVertical("abcdef", 3, 1, 1)).toBe(4);
    expect(movePromptCursorVertical("abcdef", 3, 4, -1)).toBe(1);
    expect(movePromptCursorVertical("abc", 3, 3, 1)).toBe(3);
  });

  it("detects prompt visual-row edges for attachment and model-row navigation", () => {
    expect(isPromptCursorOnFirstVisualRow("abcdef", 3, 1)).toBe(true);
    expect(isPromptCursorOnFirstVisualRow("abcdef", 3, 4)).toBe(false);
    expect(isPromptCursorOnLastVisualRow("abcdef", 3, 6)).toBe(true);
    expect(isPromptCursorOnLastVisualRow("abcdef", 3, 1)).toBe(false);
  });

  it("edits prompt text at the cursor", () => {
    expect(insertPromptText("hello world", 5, ",")).toEqual({ value: "hello, world", cursor: 6 });
    expect(deletePromptBackward("hello world", 5)).toEqual({ value: "hell world", cursor: 4 });
    expect(deletePromptBackward("hello world", 5, "word")).toEqual({ value: " world", cursor: 0 });
    expect(deletePromptForward("hello world", 5)).toEqual({ value: "helloworld", cursor: 5 });
  });

  it("does not split multi-byte characters when editing or wrapping", () => {
    expect(promptDisplayRowsWithCursor("a🙂b", 2, 3).rows).toEqual([
      { text: "a🙂", start: 0, end: 3, cursorColumn: null },
      { text: "b", start: 3, end: 4, cursorColumn: 0 },
    ]);
    expect(deletePromptBackward("a🙂b", 3)).toEqual({ value: "ab", cursor: 1 });
    expect(deletePromptForward("a🙂b", 1)).toEqual({ value: "ab", cursor: 1 });
  });
});

describe("optimistic chat summaries", () => {
  function createdSession(overrides: Partial<AgentChatSession> = {}): AgentChatSession {
    return {
      id: "chat-new",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.5",
      modelId: "openai/gpt-5.5",
      status: "idle",
      createdAt: "2026-05-25T12:00:00.000Z",
      lastActivityAt: "2026-05-25T12:00:00.000Z",
      ...overrides,
    };
  }

  function summary(sessionId: string): AgentChatSessionSummary {
    return {
      sessionId,
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.5",
      status: "idle",
      startedAt: "2026-05-25T11:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-05-25T11:00:00.000Z",
      lastOutputPreview: null,
      summary: null,
    };
  }

  it("keeps a newly created chat visible until listSessions catches up", () => {
    const optimistic = new Map<string, AgentChatSessionSummary>();
    const newSummary = chatSessionToOptimisticSummary(createdSession(), "Draft title");
    optimistic.set(newSummary.sessionId, newSummary);

    expect(mergeOptimisticChatSessions([summary("chat-old")], optimistic).map((session) => session.sessionId)).toEqual([
      "chat-new",
      "chat-old",
    ]);
    expect(optimistic.has("chat-new")).toBe(true);
  });

  it("drops the optimistic row once the runtime returns the created chat", () => {
    const optimistic = new Map<string, AgentChatSessionSummary>();
    optimistic.set("chat-new", chatSessionToOptimisticSummary(createdSession()));

    const merged = mergeOptimisticChatSessions([summary("chat-new")], optimistic);

    expect(merged.map((session) => session.sessionId)).toEqual(["chat-new"]);
    expect(optimistic.size).toBe(0);
  });
});

describe("terminal mouse tracking", () => {
  it("is enabled by default for pane-safe chat selection and can be disabled", () => {
    expect(isTerminalMouseTrackingEnabled(undefined)).toBe(true);
    expect(isTerminalMouseTrackingEnabled("")).toBe(true);
    expect(isTerminalMouseTrackingEnabled("0")).toBe(false);
    expect(isTerminalMouseTrackingEnabled("false")).toBe(false);
    expect(isTerminalMouseTrackingEnabled("1")).toBe(true);
    expect(isTerminalMouseTrackingEnabled("yes")).toBe(true);
  });
});

describe("encodeTerminalPromptSubmit", () => {
  it("submits single-line prompts with return", () => {
    expect(encodeTerminalPromptSubmit("hello")).toBe("hello\r");
  });

  it("uses bracketed paste for multiline prompts", () => {
    expect(encodeTerminalPromptSubmit("one\r\ntwo")).toBe("\x1b[200~one\ntwo\x1b[201~\r");
  });

  it("uses a delayed confirm enter for live Claude terminal submissions", () => {
    expect(encodeTerminalPromptSubmitConfirm()).toBe("\r");
    expect(CLAUDE_TERMINAL_SUBMIT_CONFIRM_DELAY_MS).toBeGreaterThanOrEqual(1000);
  });
});
