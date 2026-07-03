import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_TERMINAL_SUBMIT_CONFIRM_DELAY_MS,
  clampChatScrollOffsetRows,
  cycleLaneDeleteScope,
  deletePromptBackward,
  deletePromptForKey,
  deletePromptForward,
  deletePreviousPromptLine,
  deletePreviousPromptWord,
  encodeTerminalPromptSubmit,
  encodeTerminalPromptSubmitConfirm,
  latestAuthFailedPrompt,
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
  shouldToggleLatestFailedLineOnBlankEnter,
  isTerminalControlToggle,
  isChatTextSelectionRange,
  isChatCopyShortcut,
  isCtrlCCopyPlatform,
  isCtrlInput,
  chatSelectionEdgeDirectionForMouseY,
  chatSelectionFromAnchor,
  chatSessionToOptimisticSummary,
  chatSelectionPointFromVisibleRows,
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
  planSessionStatePrune,
  planTerminalBufferPrune,
  isNewChatSetupPane,
  resolveContextDefault,
  resolveDrawerPaneWidth,
  resolvePromptChatSubmitTarget,
  shouldHandlePendingQuestionKey,
  resolveModelPickerEscape,
  nextModelPickerProviderTabKey,
  gridTabNavigationTarget,
  noticeScopeId,
  resolveChatWrapWidth,
  resolveTerminalPaneWidth,
  sameTerminalPreviewFrame,
  selectVisibleNotices,
  shouldBufferPtyDataForSession,
  splitTerminalControlInput,
  stableInkViewportRows,
  subagentSnapshotsFromEvents,
  terminalBracketedPasteDisableSequence,
  terminalBracketedPasteEnableSequence,
  terminalAlternateScreenDisableSequence,
  terminalAlternateScrollDisableSequence,
  terminalInteractiveRestoreSequence,
  terminalMouseTrackingDisableSequence,
  terminalMouseTrackingEnableSequence,
  terminalControlInputAction,
  isClaudePlaceholderTitle,
  isClipboardScratchTemp,
  mergeOptimisticTerminalSessions,
  promptTextForTerminal,
  clipboardImageCacheRootForRuntime,
  uploadClipboardImageAttachmentToRuntime,
} from "../app";
import { isTerminalSessionResumable } from "../closedCliSessions";
import {
  buildSetupRows,
  cliProviderForModelStateProvider,
  codexApprovalSandboxLabel,
  cursorModeIdsForState,
  cursorSourceForInterfaceMode,
  initialModelState,
  reconcileCursorModelStateForInterface,
  resolveCursorCliModelForLaunch,
} from "../modelState";
import { normalizeCatalogProvider } from "../providerMetadata";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  EMPTY_BRACKETED_PASTE_STATE,
  consumeBracketedPasteInput,
  formatTerminalControlForwardedInput,
  stripBracketedPasteMarkers,
} from "../bracketedPaste";
import { clampTerminalPaneCols } from "../components/TerminalPane";
import { clipboardScratchDir } from "../imageTargets";
import type { AdeCodeConnection, AdeCodeModelState, ChatInfoSnapshot, LocalNotice, RightPaneContent } from "../types";
import { resolveSubagentCapability } from "../../../../desktop/src/shared/subagentCapabilities";
import type { AgentChatEventEnvelope, AgentChatModelInfo, AgentChatSession, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { ChatTerminalSession } from "../../../../desktop/src/shared/types/sessions";
import type { ChatTerminalPreviewResult } from "../../../../desktop/src/shared/types";

function cursorModelState(overrides: Partial<AdeCodeModelState> = {}): AdeCodeModelState {
  return {
    provider: "cursor",
    interfaceMode: "chat",
    model: "sdk-only",
    modelId: "cursor/sdk-only",
    displayName: "SDK only",
    reasoningEffort: null,
    fastMode: false,
    permissionMode: "default",
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "never",
    codexSandbox: "workspace-write",
    codexConfigSource: "config-toml",
    opencodePermissionMode: "edit",
    droidPermissionMode: "auto-low",
    cursorModeId: "agent",
    cursorAvailableModeIds: ["agent"],
    cursorConfigValues: {},
    ...overrides,
  };
}

function setupPaneModelState(overrides: Partial<AdeCodeModelState> = {}): AdeCodeModelState {
  return {
    provider: "codex",
    interfaceMode: "chat",
    model: "gpt-5.5",
    modelId: null,
    displayName: "GPT-5.5",
    reasoningEffort: "medium",
    fastMode: false,
    permissionMode: "default",
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    opencodePermissionMode: "edit",
    droidPermissionMode: "auto-low",
    cursorModeId: "agent",
    cursorAvailableModeIds: [],
    cursorConfigValues: {},
    ...overrides,
  };
}

describe("session activity helpers", () => {
  it("keeps Ink output below the terminal height to avoid full-screen clears", () => {
    expect(stableInkViewportRows(40)).toBe(39);
    expect(stableInkViewportRows(2)).toBe(1);
    expect(stableInkViewportRows(1)).toBe(1);
  });

  it("does not animate idle or input-blocked chat sessions", () => {
    expect(isChatSessionAnimating({ status: "active", awaitingInput: false, idleSinceAt: null })).toBe(true);
    expect(isChatSessionAnimating({ status: "active", awaitingInput: true, idleSinceAt: null })).toBe(false);
    expect(isChatSessionAnimating({ status: "active", awaitingInput: false, idleSinceAt: "2026-05-20T07:00:00.000Z" })).toBe(false);
    expect(isChatSessionAnimating({ status: "idle", awaitingInput: false, idleSinceAt: null })).toBe(false);
  });

  it("routes prompt submission to an existing chat before starting a provider-specific fallback", () => {
    expect(resolvePromptChatSubmitTarget({
      draftChatActive: false,
      focusedSessionId: null,
      activeSessionId: "claude-sdk-chat",
    })).toBe("claude-sdk-chat");

    expect(resolvePromptChatSubmitTarget({
      draftChatActive: true,
      focusedSessionId: null,
      activeSessionId: "previous-chat",
    })).toBeNull();

    expect(resolvePromptChatSubmitTarget({
      draftChatActive: true,
      focusedSessionId: "grid-chat",
      activeSessionId: "previous-chat",
    })).toBe("grid-chat");
  });

  it("only captures pending question hotkeys in the blank chat prompt", () => {
    expect(shouldHandlePendingQuestionKey({
      pane: "chat",
      hasPendingQuestion: true,
      prompt: "",
      ctrl: false,
      meta: false,
    })).toBe(true);

    expect(shouldHandlePendingQuestionKey({
      pane: "details",
      hasPendingQuestion: true,
      prompt: "",
      ctrl: false,
      meta: false,
    })).toBe(false);
    expect(shouldHandlePendingQuestionKey({
      pane: "chat",
      hasPendingQuestion: true,
      prompt: "typed answer",
      ctrl: false,
      meta: false,
    })).toBe(false);
    expect(shouldHandlePendingQuestionKey({
      pane: "chat",
      hasPendingQuestion: true,
      prompt: "",
      ctrl: true,
      meta: false,
    })).toBe(false);
    expect(shouldHandlePendingQuestionKey({
      pane: "chat",
      hasPendingQuestion: false,
      prompt: "",
      ctrl: false,
      meta: false,
    })).toBe(false);
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

  it("only buffers live PTY bytes for visible terminal sessions", () => {
    expect(shouldBufferPtyDataForSession({
      sessionId: "term-1",
      activeSessionId: "term-1",
      multiView: null,
      gridViewActive: false,
    })).toBe(true);
    expect(shouldBufferPtyDataForSession({
      sessionId: "term-2",
      activeSessionId: "term-1",
      multiView: { tiles: [{ sessionId: "term-2" }] },
      gridViewActive: true,
    })).toBe(true);
    expect(shouldBufferPtyDataForSession({
      sessionId: "term-2",
      activeSessionId: "term-1",
      multiView: { tiles: [{ sessionId: "term-2" }] },
      gridViewActive: false,
    })).toBe(false);
  });

  it("treats unchanged terminal previews as the same render frame", () => {
    const makePreview = (
      text: string,
      capturedAt = "2026-05-13T12:00:00.000Z",
      cursorX = 0,
    ): ChatTerminalPreviewResult => ({
      terminalId: "term-1",
      source: "snapshot",
      snapshot: {
        version: 1,
        terminalId: "term-1",
        cols: 80,
        rows: 1,
        capturedAt,
        status: "running",
        runtimeState: "running",
        bufferType: "normal",
        cursorX,
        cursorY: 0,
        baseY: 0,
        viewportY: 0,
        serialized: "",
        visibleRows: [{ text, wrapped: false, cells: [] }],
      },
      transcript: null,
      capturedAt,
      session: {
        terminalId: "term-1",
        ptyId: "pty-1",
        chatSessionId: null,
        laneId: "lane-1",
        laneName: "Lane 1",
        title: "Claude Code",
        toolType: "claude",
        goal: null,
        status: "running",
        runtimeState: "running",
        active: true,
        startedAt: "2026-05-13T12:00:00.000Z",
        endedAt: null,
        exitCode: null,
        pid: process.pid,
        resumeCommand: null,
        lastOutputPreview: null,
        summary: null,
      },
    });

    expect(sameTerminalPreviewFrame(makePreview("same"), makePreview("same", "2026-05-13T12:00:01.000Z"))).toBe(true);
    expect(sameTerminalPreviewFrame(makePreview("same"), makePreview("changed"))).toBe(false);
    expect(sameTerminalPreviewFrame(makePreview("same"), makePreview("same", "2026-05-13T12:00:01.000Z", 1))).toBe(false);
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

  it("does not treat new-lane select/toggle/button rows as prompt text", () => {
    expect(formFieldUsesPromptInput("new-lane", "start")).toBe(false);
    expect(formFieldUsesPromptInput("new-lane", "color")).toBe(false);
    expect(formFieldUsesPromptInput("new-lane", "branchSource")).toBe(false);
    expect(formFieldUsesPromptInput("new-lane", "create")).toBe(false);
    expect(formFieldUsesPromptInput("new-lane", "name")).toBe(true);
    expect(formFieldUsesPromptInput("new-lane", "branch")).toBe(true);
    expect(formFieldUsesPromptInput("new-lane", "baseBranch")).toBe(true);
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
      resumableTerminal: false,
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

  // First-send draft commit: only the new-chat setup surface is swapped for
  // chat-info — panes the user opened deliberately mid-draft are untouched.
  it("isNewChatSetupPane matches exactly the new-chat model-picker surface", () => {
    const picker = (surface: "chat" | "new-chat"): RightPaneContent => ({
      kind: "model-picker",
      surface,
      query: "",
      searchMode: false,
      selection: { kind: "provider", provider: "claude" },
      focusedIndex: 0,
    });
    expect(isNewChatSetupPane(picker("new-chat"))).toBe(true);
    expect(isNewChatSetupPane(picker("chat"))).toBe(false);
    expect(isNewChatSetupPane({ kind: "chat-info", info: chatInfoForContext() })).toBe(false);
    expect(isNewChatSetupPane({ kind: "empty" })).toBe(false);
    expect(isNewChatSetupPane({
      kind: "form",
      title: "Rename",
      command: "rename",
      fields: [{ name: "name", label: "Name" }],
    })).toBe(false);
    expect(isNewChatSetupPane({ kind: "details", title: "Diff", body: "" })).toBe(false);
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

describe("planSessionStatePrune", () => {
  it("keeps previous session ids during transient empty lists while disconnected", () => {
    const previous = new Set(["chat-a", "chat-b"]);

    expect(planSessionStatePrune({
      previous,
      current: new Set(),
      connectionLost: true,
    })).toBeNull();
  });

  it("prunes stale session ids when the runtime reports a true empty list", () => {
    const plan = planSessionStatePrune({
      previous: new Set(["chat-a", "chat-b"]),
      current: new Set(),
      connectionLost: false,
    });

    expect(plan?.removed).toEqual(["chat-a", "chat-b"]);
    expect([...(plan?.nextSeen ?? [])]).toEqual([]);
  });

  it("diffs stable non-empty session lists", () => {
    const plan = planSessionStatePrune({
      previous: new Set(["chat-a", "chat-b"]),
      current: new Set(["chat-b", "chat-c"]),
      connectionLost: false,
    });

    expect(plan?.removed).toEqual(["chat-a"]);
    expect([...(plan?.nextSeen ?? [])]).toEqual(["chat-b", "chat-c"]);
  });
});

describe("planTerminalBufferPrune", () => {
  it("yields removed terminal ids for deletion while surviving keys remain", () => {
    const plan = planTerminalBufferPrune(
      new Set(["term-a", "term-b"]),
      new Set(["term-b", "term-c"]),
    );

    expect(plan.removed).toEqual(["term-a"]);
    expect([...plan.nextSeen]).toEqual(["term-b", "term-c"]);
  });

  it("prunes every previously-seen terminal when the list empties", () => {
    const plan = planTerminalBufferPrune(new Set(["term-a", "term-b"]), new Set());

    expect(plan.removed).toEqual(["term-a", "term-b"]);
    expect([...plan.nextSeen]).toEqual([]);
  });

  it("removes nothing when the terminal set is unchanged", () => {
    const plan = planTerminalBufferPrune(new Set(["term-a"]), new Set(["term-a"]));

    expect(plan.removed).toEqual([]);
  });
});

describe("status-line refresh trailing debounce", () => {
  it("coalesces N rapid triggers into a single spawn", () => {
    vi.useFakeTimers();
    try {
      let spawns = 0;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      // Mirrors the scheduleRefresh closure in app.tsx: clear + reset a 300ms
      // trailing timer before invoking the (shell-spawning) refresh.
      const scheduleRefresh = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          spawns += 1;
        }, 300);
      };

      for (let i = 0; i < 50; i += 1) {
        scheduleRefresh();
        vi.advanceTimersByTime(10);
      }
      expect(spawns).toBe(0);
      vi.advanceTimersByTime(300);
      expect(spawns).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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

  it("wraps model picker provider tabs in both directions", () => {
    const providerTabs = [
      { key: "chat" },
      { key: "agent" },
      { key: "composer" },
    ];

    expect(nextModelPickerProviderTabKey({ providerTabs, providerTabIndex: 0, delta: 1 })).toBe("agent");
    expect(nextModelPickerProviderTabKey({ providerTabs, providerTabIndex: 0, delta: -1 })).toBe("composer");
    expect(nextModelPickerProviderTabKey({ providerTabs: [{ key: "only" }], providerTabIndex: 0, delta: 1 })).toBeNull();
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

describe("grid tab navigation", () => {
  it("keeps Tab on grid tiles only when the grid is the only visible pane", () => {
    expect(gridTabNavigationTarget({ drawerOpen: false, rightOpen: false, tileCount: 2 })).toBe("tiles");
    expect(gridTabNavigationTarget({ drawerOpen: false, rightOpen: false, tileCount: 1 })).toBe("panes");
  });

  it("lets Tab escape the grid when side panes are visible", () => {
    expect(gridTabNavigationTarget({ drawerOpen: true, rightOpen: false, tileCount: 3 })).toBe("panes");
    expect(gridTabNavigationTarget({ drawerOpen: false, rightOpen: true, tileCount: 3 })).toBe("panes");
    expect(gridTabNavigationTarget({ drawerOpen: true, rightOpen: true, tileCount: 3 })).toBe("panes");
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

describe("interface draft setup", () => {
  function interfaceRows(interfaceMode: AdeCodeModelState["interfaceMode"], interfaceEditable: boolean) {
    return buildSetupRows({
      modelState: setupPaneModelState({ interfaceMode }),
      models: [],
      includeRefresh: false,
      includeApply: true,
      interfaceMode,
      interfaceEditable,
    });
  }

  it("maps tracked CLI providers and rejects chat-only providers", () => {
    for (const provider of ["claude", "codex", "cursor", "droid", "opencode"] as const) {
      expect(cliProviderForModelStateProvider(provider)).toBe(provider);
    }
    expect(cliProviderForModelStateProvider("ollama")).toBeNull();
    expect(cliProviderForModelStateProvider("lmstudio")).toBeNull();
  });

  it("keeps the Interface setup row after Provider and labels the active mode", () => {
    const chatRows = interfaceRows("chat", true);
    const cliRows = interfaceRows("cli", true);

    expect(chatRows.map((row) => row.kind).slice(0, 2)).toEqual(["provider", "interface"]);
    expect(chatRows.find((row) => row.kind === "interface")).toMatchObject({
      value: "Chat",
      disabled: false,
      cyclable: true,
      detail: "Chat · CLI",
    });
    expect(cliRows.find((row) => row.kind === "interface")?.value).toBe("CLI");
  });

  it("locks Interface after launch and remembers the draft default", () => {
    expect(interfaceRows("cli", false).find((row) => row.kind === "interface")).toMatchObject({
      value: "CLI",
      disabled: true,
      cyclable: false,
      detail: "tracked CLI session",
    });
    expect(initialModelState("cli").interfaceMode).toBe("cli");
    expect(initialModelState("chat").interfaceMode).toBe("chat");
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

  it("ignores arbitrary input while attached but still recognizes detach chords", () => {
    expect(terminalControlInputAction("x", {})).toBe("ignore");
    expect(terminalControlInputAction("\x1b[A", {})).toBe("ignore");
    expect(terminalControlInputAction("t", { ctrl: true })).toBe("detach");
    expect(terminalControlInputAction("\x14", {})).toBe("detach");
    expect(terminalControlInputAction("\x1d", {})).toBe("detach");
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

  it("wraps multiline forwarded terminal control input in bracketed paste", () => {
    expect(formatTerminalControlForwardedInput("one\ntwo")).toBe(
      `${BRACKETED_PASTE_START}one\ntwo${BRACKETED_PASTE_END}`,
    );
    expect(splitTerminalControlInput("one\r\ntwo")).toEqual({
      detach: false,
      forwarded: `${BRACKETED_PASTE_START}one\ntwo${BRACKETED_PASTE_END}`,
    });
    expect(splitTerminalControlInput(`\x14one\ntwo`)).toEqual({
      detach: true,
      forwarded: `${BRACKETED_PASTE_START}one\ntwo${BRACKETED_PASTE_END}`,
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
    expect(isPromptWordBackspace("\x1b\u007f", {})).toBe(true);
    expect(isPromptWordBackspace("\x1b\b", {})).toBe(true);
    expect(isPromptWordBackspace("\x1b[127;5u", {})).toBe(true);
    expect(isPromptWordBackspace("\x1b[127;9u", {})).toBe(true);
    expect(isPromptWordBackspace("\x1b[127;17u", {})).toBe(true);
    expect(isPromptWordBackspace("\x1b[3;5~", {})).toBe(true);
    expect(isPromptWordBackspace("\x1b[27;5;127~", {})).toBe(true);
    expect(isPromptWordBackspace("\x1b[127;2u", {})).toBe(false);
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
    expect(movePromptCursorVertical("a界bcde", 4, 2, 1)).toBe(6);
    expect(movePromptCursorVertical("a界bcde", 4, 6, -1)).toBe(2);
    expect(movePromptCursorVertical("a🙂bcde", 4, 3, 1)).toBe(7);
    expect(movePromptCursorVertical("a🙂bcde", 4, 7, -1)).toBe(3);
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
    expect(deletePromptForKey("hello world", 5, { backspace: true })).toEqual({ value: "hell world", cursor: 4 });
    expect(deletePromptForKey("hello world", 5, { delete: true })).toEqual({ value: "helloworld", cursor: 5 });
  });

  it("does not split multi-byte characters when editing or wrapping", () => {
    expect(promptDisplayRowsWithCursor("a🙂b", 2, 3).rows).toEqual([
      { text: "a", start: 0, end: 1, cursorColumn: null },
      { text: "🙂", start: 1, end: 3, cursorColumn: null },
      { text: "b", start: 3, end: 4, cursorColumn: 0 },
    ]);
    expect(deletePromptBackward("a🙂b", 3)).toEqual({ value: "ab", cursor: 1 });
    expect(deletePromptForward("a🙂b", 1)).toEqual({ value: "ab", cursor: 1 });
  });

  it("counts CJK and emoji prompt cursor columns in terminal cells", () => {
    const cjk = promptDisplayRowsWithCursor("a界bc", 4, 2);
    expect(cjk.rows[0]).toEqual({ text: "a界b", start: 0, end: 3, cursorColumn: 3 });
    expect(cjk.rows[1]).toEqual({ text: "c", start: 3, end: 4, cursorColumn: null });

    const emoji = promptDisplayRowsWithCursor("a🙂bc", 4, 3);
    expect(emoji.rows[0]).toEqual({ text: "a🙂b", start: 0, end: 4, cursorColumn: 3 });
    expect(emoji.rows[1]).toEqual({ text: "c", start: 4, end: 5, cursorColumn: null });
  });

  it("sources and validates Cursor models by TUI interface", () => {
    const sdkOnly: AgentChatModelInfo = {
      id: "cursor/sdk-only",
      modelId: "cursor/sdk-only",
      displayName: "SDK only",
      isDefault: true,
      cursorAvailability: { sdk: true, cli: false },
    };
    const cliOnly: AgentChatModelInfo = {
      id: "cursor/cli-only",
      modelId: "cursor/cli-only",
      displayName: "CLI only",
      isDefault: false,
      cursorAvailability: { sdk: false, cli: true },
      cursorCliVariants: [{ modelId: "cli-only-default" }],
    };
    const cliReady: AgentChatModelInfo = {
      id: "cursor/cli-ready",
      modelId: "cursor/cli-ready",
      displayName: "CLI ready",
      isDefault: false,
      reasoningEfforts: [{ effort: "high", description: "High" }],
      cursorAvailability: { sdk: true, cli: true },
      cursorCliVariants: [
        { modelId: "cli-ready-default" },
        { modelId: "cli-ready-high", reasoningEffort: "high" },
      ],
    };

    expect(cursorSourceForInterfaceMode("chat")).toBe("sdk");
    expect(cursorSourceForInterfaceMode("cli")).toBe("cli");

    const toggled = reconcileCursorModelStateForInterface(
      cursorModelState(),
      "cli",
      [sdkOnly, cliOnly],
    );
    expect(toggled).toMatchObject({
      interfaceMode: "cli",
      modelId: "cursor/cli-only",
      model: "cli-only-default",
      displayName: "CLI only",
    });

    expect(() => resolveCursorCliModelForLaunch(cursorModelState(), [sdkOnly]))
      .toThrow(/available for chat only/i);
    expect(resolveCursorCliModelForLaunch(
      cursorModelState({
        interfaceMode: "cli",
        model: "cli-ready",
        modelId: "cursor/cli-ready",
        displayName: "CLI ready",
        reasoningEffort: "high",
      }),
      [cliReady],
    )).toBe("cli-ready-high");
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

describe("latestAuthFailedPrompt", () => {
  it("restores the most recent prompt when the latest turn failed with auth", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "retry deploy", turnId: "turn-1" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "error", message: "Authentication failed: token expired", turnId: "turn-1" },
      },
    ];

    expect(latestAuthFailedPrompt(events)).toBe("retry deploy");
  });

  it("ignores older auth failures once a later user turn succeeds", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "first", turnId: "turn-1" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "error", message: "auth required", turnId: "turn-1" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:02.000Z",
        sequence: 3,
        event: { type: "user_message", text: "second", turnId: "turn-2" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:03.000Z",
        sequence: 4,
        event: { type: "done", status: "completed", turnId: "turn-2" },
      },
    ];

    expect(latestAuthFailedPrompt(events)).toBeNull();
  });
});

describe("terminal mouse tracking", () => {
  it("uses one conservative cross-terminal mouse baseline", () => {
    expect(terminalMouseTrackingEnableSequence()).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    expect(terminalMouseTrackingEnableSequence()).not.toContain("\x1b[?1003h");
    expect(terminalMouseTrackingEnableSequence()).not.toContain("\x1b[?1015h");

    expect(terminalMouseTrackingDisableSequence()).toContain("\x1b[?1003l");
    expect(terminalMouseTrackingDisableSequence()).toContain("\x1b[?1015l");
  });

  it("restores mouse tracking, alternate scroll, and the alt screen together", () => {
    expect(terminalInteractiveRestoreSequence()).toBe(
      `${terminalMouseTrackingDisableSequence()}${terminalAlternateScrollDisableSequence()}${terminalBracketedPasteDisableSequence()}${terminalAlternateScreenDisableSequence()}`,
    );
  });

  it("uses standard bracketed paste mode toggles for terminal control", () => {
    expect(terminalBracketedPasteEnableSequence()).toBe("\x1b[?2004h");
    expect(terminalBracketedPasteDisableSequence()).toBe("\x1b[?2004l");
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

describe("bracketed paste input", () => {
  it("buffers pasted text and keeps embedded newlines as literal input", () => {
    const result = consumeBracketedPasteInput(
      EMPTY_BRACKETED_PASTE_STATE,
      `${BRACKETED_PASTE_START}one\r\ntwo${BRACKETED_PASTE_END}`,
    );

    expect(result).toEqual({
      consumed: true,
      state: EMPTY_BRACKETED_PASTE_STATE,
      text: "one\ntwo",
    });
  });

  it("supports bracketed paste split across input chunks", () => {
    const first = consumeBracketedPasteInput(EMPTY_BRACKETED_PASTE_STATE, `${BRACKETED_PASTE_START}one`);
    expect(first).toEqual({
      consumed: true,
      state: { active: true, buffer: "one" },
      text: "",
    });

    const second = consumeBracketedPasteInput(first.state, `\ntwo${BRACKETED_PASTE_END}`);
    expect(second).toEqual({
      consumed: true,
      state: EMPTY_BRACKETED_PASTE_STATE,
      text: "one\ntwo",
    });
  });

  it("strips stray bracketed paste markers from printable prompt input", () => {
    expect(stripBracketedPasteMarkers(`${BRACKETED_PASTE_START}alpha${BRACKETED_PASTE_END}`)).toBe("alpha");
  });
});

describe("clipboard image attachment routing", () => {
  it("captures remote clipboard images into a local scratch root", () => {
    expect(clipboardImageCacheRootForRuntime({
      remoteLaunch: true,
      activeLaneWorktreePath: "/remote/repo/.ade/worktrees/lane",
      workspaceRoot: "/remote/repo",
      tmpDir: "/local/tmp",
    })).toBe("/local/tmp");

    expect(clipboardImageCacheRootForRuntime({
      remoteLaunch: false,
      activeLaneWorktreePath: "/repo/.ade/worktrees/lane",
      workspaceRoot: "/repo",
      tmpDir: "/local/tmp",
    })).toBe("/repo/.ade/worktrees/lane");

    expect(clipboardImageCacheRootForRuntime({
      remoteLaunch: false,
      activeLaneWorktreePath: null,
      workspaceRoot: "/repo",
      tmpDir: "/local/tmp",
    })).toBe("/repo");
  });

  it("uploads local clipboard image bytes through the runtime temp attachment API", async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-upload-"));
    const localImagePath = path.join(localRoot, "clipboard.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    fs.writeFileSync(localImagePath, bytes);
    const remotePath = "/remote/repo/.ade/attachments/clipboard.png";
    const calls: unknown[][] = [];
    const connection = {
      action: async (...args: unknown[]) => {
        calls.push(args);
        return { path: remotePath };
      },
    } as unknown as AdeCodeConnection;

    const result = await uploadClipboardImageAttachmentToRuntime(connection, localImagePath);

    expect(result).toEqual({ path: remotePath });
    expect(calls).toEqual([[
      "chat",
      "saveTempAttachment",
      { data: bytes.toString("base64"), filename: "clipboard.png" },
    ]]);
  });

  it("tracks scratch ownership without treating user image files as disposable", () => {
    const cacheRoot = path.join(os.tmpdir(), "ade-code-cache-root");
    const scratchImage = path.join(clipboardScratchDir(cacheRoot), "pasted-screenshot.png");
    const userImage = path.join(os.tmpdir(), "photo.png");

    expect(isClipboardScratchTemp(scratchImage, cacheRoot)).toBe(true);
    expect(isClipboardScratchTemp(userImage, cacheRoot)).toBe(false);
  });

  it("adds image paths to terminal prompts without inlining binary data", () => {
    const remotePath = "/remote/repo/.ade/attachments/clipboard.png";
    const prompt = promptTextForTerminal("describe this", [{ type: "image", path: remotePath }]);

    expect(prompt).toBe(`describe this\n\nAttached files:\n- ${remotePath}`);
    expect(prompt).not.toContain("data:image");
    expect(prompt).not.toContain(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString("base64"));
  });
});

describe("mergeOptimisticTerminalSessions", () => {
  const makeTerminal = (terminalId: string): ChatTerminalSession => ({
    terminalId,
    ptyId: null,
    chatSessionId: null,
    laneId: "lane-1",
    laneName: "Lane 1",
    title: "Claude Code",
    toolType: "claude",
    goal: null,
    status: "running",
    runtimeState: "running",
    active: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    exitCode: null,
    pid: null,
    resumeCommand: null,
    resumeMetadata: null,
    lastOutputPreview: null,
    summary: null,
  });

  it("returns the listed sessions unchanged when there are no optimistic entries", () => {
    const listed = [makeTerminal("a")];
    expect(mergeOptimisticTerminalSessions(listed, new Map())).toBe(listed);
  });

  it("prepends an optimistic terminal the runtime list has not surfaced yet", () => {
    // This is the new-chat reroute fix: a freshly-created Claude terminal must be
    // present so resolveTuiChatRefreshTarget keeps it selected.
    const optimistic = new Map([["new", makeTerminal("new")]]);
    const merged = mergeOptimisticTerminalSessions([makeTerminal("old")], optimistic);
    expect(merged.map((session) => session.terminalId)).toEqual(["new", "old"]);
  });

  it("self-cleans an optimistic entry once the real list reports it (no duplicate)", () => {
    const optimistic = new Map([["a", makeTerminal("a")]]);
    const merged = mergeOptimisticTerminalSessions([makeTerminal("a")], optimistic);
    expect(merged.map((session) => session.terminalId)).toEqual(["a"]);
    expect(optimistic.has("a")).toBe(false);
  });
});

describe("isClaudePlaceholderTitle", () => {
  it("treats generic/empty Claude titles as placeholders awaiting auto-naming", () => {
    for (const title of ["Claude Code", "claude", "Claude CLI", "claude session", "", "   "]) {
      expect(isClaudePlaceholderTitle(title)).toBe(true);
    }
  });

  it("treats a real generated title as named", () => {
    expect(isClaudePlaceholderTitle("Fix the sync race")).toBe(false);
  });
});

describe("notice scoping", () => {
  const notice = (text: string, sessionId: string | null): LocalNotice => ({
    id: text,
    timestamp: "2026-01-01T00:00:00.000Z",
    tone: "info",
    text,
    sessionId,
  });

  it("tags notices with the live chat, then the draft key, then null", () => {
    expect(noticeScopeId({ activeSessionId: "chat-1", draftChatActive: false, draftScopeKey: null })).toBe("chat-1");
    // An active chat always wins over a stale draft key.
    expect(noticeScopeId({ activeSessionId: "chat-1", draftChatActive: true, draftScopeKey: "draft:2" })).toBe("chat-1");
    expect(noticeScopeId({ activeSessionId: null, draftChatActive: true, draftScopeKey: "draft:2" })).toBe("draft:2");
    expect(noticeScopeId({ activeSessionId: null, draftChatActive: false, draftScopeKey: "draft:2" })).toBeNull();
  });

  it("shows a new-chat draft only the notices fired in that exact draft", () => {
    const notices = [
      notice("Created lane annoyin flicker.", null),
      notice("Model set to GPT-5.5.", "draft:1"),
      notice("Press Esc again to discard this chat draft.", "draft:2"),
      notice("Done.", "chat-9"),
    ];
    const visible = selectVisibleNotices({
      notices,
      hasSelectedAgentSnapshot: false,
      draftChatActive: true,
      draftScopeKey: "draft:2",
      activeSessionId: null,
    });
    // Global ("Created lane"), prior-draft ("draft:1"), and other-chat notices
    // must not bleed into a fresh draft — only this draft's own feedback.
    expect(visible.map((entry) => entry.text)).toEqual(["Press Esc again to discard this chat draft."]);
  });

  it("keeps the chat-or-global fallback when not in a draft", () => {
    const notices = [
      notice("Reconnected to the ADE runtime.", null),
      notice("Model set to Claude Opus 4.8 1M.", "chat-1"),
      notice("Other chat feedback.", "chat-2"),
    ];
    const visible = selectVisibleNotices({
      notices,
      hasSelectedAgentSnapshot: false,
      draftChatActive: false,
      draftScopeKey: null,
      activeSessionId: "chat-1",
    });
    expect(visible.map((entry) => entry.text)).toEqual([
      "Reconnected to the ADE runtime.",
      "Model set to Claude Opus 4.8 1M.",
    ]);
  });

  it("hides every notice while a subagent snapshot is selected", () => {
    const visible = selectVisibleNotices({
      notices: [notice("Created lane.", null)],
      hasSelectedAgentSnapshot: true,
      draftChatActive: true,
      draftScopeKey: "draft:1",
      activeSessionId: null,
    });
    expect(visible).toEqual([]);
  });
});
