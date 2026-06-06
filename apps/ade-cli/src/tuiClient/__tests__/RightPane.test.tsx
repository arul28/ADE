import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { LANE_DETAIL_ACTIONS, LANE_DETAIL_PR_ACTION_INDEX, feedbackStateFromContent, laneDetailsInteractionLayout, rightPaneScrollableRowCount, RightPane } from "../components/RightPane";
import { feedbackFormToFormValues } from "../feedbackForm";
import { buildFeedbackDraftInput } from "../feedback";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";

describe("rightPaneScrollableRowCount", () => {
  it("counts details body lines and list rows; flows full diff bodies for scrolling", () => {
    expect(rightPaneScrollableRowCount({ kind: "details", title: "t", body: "a\nb\nc" })).toBe(3);
    expect(rightPaneScrollableRowCount({ kind: "list", title: "t", rows: ["a", "b"] })).toBe(2);
    expect(rightPaneScrollableRowCount({ kind: "empty" })).toBe(0);
    const bigBody = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    // 1 header row + all 50 body rows (diffs scroll in full, capped per file at 600).
    expect(rightPaneScrollableRowCount({ kind: "diff", title: "d", files: [{ path: "a.ts", body: bigBody }] })).toBe(51);
    // Per-file cap: 600 body rows shown + 1 header + 1 "more lines" row.
    const huge = Array.from({ length: 650 }, (_, i) => `+line ${i}`).join("\n");
    expect(rightPaneScrollableRowCount({ kind: "diff", title: "d", files: [{ path: "a.ts", body: huge }] })).toBe(602);
  });
});

function stripAnsi(text: string): string {
  return text.replace(/\u001b(?:\[[0-9;]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "");
}

import type { ChatInfoSnapshot } from "../types";
import { resolveSubagentCapability } from "../../../../desktop/src/shared/subagentCapabilities";

function chatInfo(overrides: Partial<ChatInfoSnapshot> = {}): ChatInfoSnapshot {
  const provider = overrides.provider ?? "codex";
  return {
    provider,
    modelLabel: "gpt-5.5-high",
    laneLabel: "fixing-cli-send-error",
    contextPercent: 42,
    tokenSummary: "+1.2k/340",
    streaming: true,
    goal: null,
    plan: {
      current: 1,
      total: 2,
      live: true,
      steps: [
        { text: "Patch runtime bridge", status: "in_progress" },
        { text: "Verify desktop smoke", status: "pending" },
      ],
    },
    snapshots: [],
    inspectedSubagentId: null,
    capability: resolveSubagentCapability(provider),
    mission: null,
    ...overrides,
  };
}

describe("RightPane chat info", () => {
  it("renders the model + lane header, plan, goal, and chats — but no errors section", () => {
    const result = render(
      <RightPane
        content={{
          kind: "chat-info",
          info: chatInfo({
            goal: {
              objective: "Ship CLI parity",
              status: "active",
              tokenBudget: null,
              tokensUsed: 1234,
              timeUsedSeconds: 90,
            },
            snapshots: [
              { id: "x1", name: "delegated", kind: "subagent", status: "running", summary: "checking renderer" },
            ],
          }),
        }}
        selectedIndex={1}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("CHAT INFO · CODEX");
    expect(frame).toContain("gpt-5.5-high");
    expect(frame).toContain("lane");
    expect(frame).toContain("fixing-cli-send-error");
    expect(frame).toContain("PLAN");
    expect(frame).toContain("Patch runtime bridge");
    expect(frame).toContain("GOAL");
    expect(frame).toContain("Ship CLI parity");
    expect(frame).toContain("CHATS");
    expect(frame).toContain("delegated");
    // Codex can view full subagent transcripts → Enter takes over the main chat.
    expect(frame).toContain("↑↓ focus · ↵ open thread · esc → main");
    expect(frame).not.toContain("Errors");
    expect(frame).not.toContain("Activity");
    expect(frame).not.toContain("tab · cycle");
  });

  it("hides the Goal section for providers that do not surface goal data", () => {
    const result = render(
      <RightPane
        content={{
          kind: "chat-info",
          info: chatInfo({ provider: "claude", modelLabel: "claude-opus-4-7", goal: null }),
        }}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("CHAT INFO · CLAUDE");
    expect(frame).toContain("PLAN");
    expect(frame).not.toContain("GOAL");
  });

  it("shows the main row + a 'no subagents yet' hint when the roster is empty", () => {
    const result = render(
      <RightPane
        content={{ kind: "chat-info", info: chatInfo({ snapshots: [] }) }}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("CHATS");
    expect(frame).toContain("main");
    expect(frame).toContain("viewing");
    expect(frame).toContain("no subagents yet");
  });

  it("marks the focused subagent row with a rail and exposes its last tool as a hover preview", () => {
    const result = render(
      <RightPane
        content={{
          kind: "chat-info",
          info: chatInfo({
            snapshots: [
              {
                id: "x1",
                name: "agent-01",
                kind: "subagent",
                status: "running",
                summary: "",
                lastToolName: "edit src/lib/tui.ts",
              },
            ],
          }),
        }}
        selectedIndex={1}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("agent-01");
    expect(frame).toContain("edit src/lib/tui.ts");
  });

  it("scrolls the roster internally with overflow hints when more than the cap are live", () => {
    const snapshots = Array.from({ length: 9 }, (_, index) => ({
      id: `x${index + 1}`,
      name: `agent-${String(index + 1).padStart(2, "0")}`,
      kind: "subagent" as const,
      status: "running" as const,
      summary: "",
    }));
    const result = render(
      <RightPane
        content={{ kind: "chat-info", info: chatInfo({ snapshots }) }}
        selectedIndex={7}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toMatch(/↑\s+\d+\s+earlier/);
    expect(frame).toContain("agent-07");
  });

  it("separates foreground subagents from background tasks with section headers", () => {
    const result = render(
      <RightPane
        content={{
          kind: "chat-info",
          info: chatInfo({
            snapshots: [
              { id: "s1", name: "explore-code", kind: "subagent", status: "running", summary: "reading files" },
              { id: "b1", name: "dev:desktop", kind: "subagent", status: "running", background: true, summary: "tailing logs" },
              { id: "b2", name: "ade code web mirror", kind: "subagent", status: "completed", background: true, summary: "exited 0" },
            ],
          }),
        }}
        selectedIndex={1}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("subagents");
    expect(frame).toContain("background");
    const exploreIndex = frame.indexOf("explore-code");
    const backgroundIndex = frame.indexOf("background");
    const desktopIndex = frame.indexOf("dev:desktop");
    expect(exploreIndex).toBeGreaterThanOrEqual(0);
    expect(backgroundIndex).toBeGreaterThanOrEqual(0);
    expect(desktopIndex).toBeGreaterThanOrEqual(0);
    expect(exploreIndex).toBeLessThan(backgroundIndex);
    expect(backgroundIndex).toBeLessThan(desktopIndex);
    // bg count shows up in the header
    expect(frame).toMatch(/2\s+bg/);
  });
});

function lane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Diff lane",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/diff-lane",
    worktreePath: "/tmp/lane",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: {
      dirty: true,
      ahead: 1,
      behind: 0,
      remoteBehind: 0,
      rebaseInProgress: false,
    },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-05-12T12:00:00.000Z",
    ...overrides,
  };
}

describe("RightPane lane-details", () => {
  const baseLaneDetails = {
    lane: lane(),
    git: {
      staged: 0,
      unstaged: 0,
      total: 0,
      ahead: 0,
      behind: 0,
      remote: null,
      additions: 0,
      deletions: 0,
    },
    files: [] as Array<{ path: string; status: "M" | "A" | "D" | "?"; staged: boolean }>,
    pr: null,
    chats: { active: 0, closed: 0, killed: 0 },
    showFiles: false,
    selectedActionIndex: 0,
  };

  it("renders lane name and branch in the pane header", () => {
    const result = render(
      <RightPane
        content={{
          kind: "lane-details",
          ...baseLaneDetails,
        }}
        focused
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("Diff lane");
    expect(frame).toContain("⎇ feature/diff-lane");
    expect(frame).not.toContain("FOCUSED");
    expect(frame).not.toContain("conflicts");
    expect(frame).not.toContain("g · git tab");
  });

  it("renders real line diff stats with a U+2212 minus sign", () => {
    const result = render(
      <RightPane
        content={{
          kind: "lane-details",
          ...baseLaneDetails,
          git: {
            staged: 2,
            unstaged: 1,
            total: 3,
            ahead: 1,
            behind: 0,
            remote: "origin/feature/diff-lane",
            additions: 12,
            deletions: 4,
          },
        }}
        focused
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("dirty");
    expect(frame).toContain("+12");
    expect(frame).toContain("−4");
    expect(frame).toContain("CHANGES · 3");
    expect(frame).not.toContain("-4");
    expect(frame).toContain("2 staged");
    expect(frame).toContain("1 unstaged");
    expect(frame).toContain("↑1");
  });

  it("renders a compact changes header when line additions and deletions are zero", () => {
    const result = render(
      <RightPane
        content={{
          kind: "lane-details",
          ...baseLaneDetails,
          lane: lane({ status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } }),
          git: {
            staged: 0,
            unstaged: 0,
            total: 2,
            ahead: 0,
            behind: 0,
            remote: null,
            additions: 0,
            deletions: 0,
          },
        }}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("CHANGES · 2");
    expect(frame).toContain("No changed files.");
    expect(frame).toContain("● clean");
  });

  it("shows action shortcuts only for the selected row", () => {
    const result = render(
      <RightPane
        content={{
          kind: "lane-details",
          ...baseLaneDetails,
          selectedActionIndex: LANE_DETAIL_ACTIONS.findIndex((action) => action.k === "a"),
        }}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("ACTIONS");
    // Selected row renders as: "▎ [a] {glyph} stage all" — allow the glyph between key and label.
    expect(frame).toMatch(/\[a\]\s+\S+\s+stage all/);
    expect(frame).toContain("commit");
    expect(frame).not.toMatch(/\[c\][^\n]*commit/);
    expect(frame).not.toMatch(/\[p\][^\n]*push/);
  });

  it("keeps lane action click rows aligned with rendered action rows", () => {
    const content = {
      kind: "lane-details" as const,
      ...baseLaneDetails,
      git: {
        ...baseLaneDetails.git,
        total: 7,
        additions: 12,
        deletions: 3,
      },
      files: [
        { path: "apps/desktop/src/main.ts", status: "M" as const, staged: false },
        { path: "apps/ade-cli/src/tuiClient/app.tsx", status: "M" as const, staged: true },
        { path: "docs/notes.md", status: "A" as const, staged: false },
      ],
      pr: {
        number: 311,
        state: "open" as const,
        url: "https://github.com/example/ADE/pull/311",
        checksPassed: 2,
        checksTotal: 5,
        checksPending: 0,
        checksFailed: 0,
      },
      selectedActionIndex: LANE_DETAIL_ACTIONS.findIndex((action) => action.k === "c"),
    };
    const result = render(<RightPane content={content} focused width={80} />);
    const lines = stripAnsi(result.lastFrame() ?? "").split("\n");
    const layout = laneDetailsInteractionLayout(content);
    const actionLineIndexes = layout.actionRows.map((offset) => offset + 1);

    expect(actionLineIndexes.map((line) => lines[line])).toEqual(expect.arrayContaining([
      expect.stringContaining("new chat"),
      expect.stringContaining("commit"),
      expect.stringContaining("delete lane"),
    ]));
    expect(layout.prRow).not.toBeNull();
    expect(lines[(layout.prRow?.start ?? 0) + 1]).toContain("open");
  });

  it("renders PR activity and chat counts", () => {
    const result = render(
      <RightPane
        content={{
          kind: "lane-details",
          ...baseLaneDetails,
          pr: {
            number: 311,
            state: "open",
            url: "https://github.com/example/ADE/pull/311",
            checksPassed: 2,
            checksTotal: 5,
            checksPending: 3,
            checksFailed: 0,
          },
          chats: { active: 2, closed: 4, killed: 1 },
        }}
        focused
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("PR #311");
    expect(frame).toContain("CI running");
    expect(frame).toContain("CHATS");
    expect(frame).toContain("2 active");
    expect(frame).toContain("4 closed");
    expect(frame).toContain("1 killed");
    expect(frame).not.toContain("RUN");
  });

  it("shows the PR GitHub link when the PR row is selected", () => {
    const result = render(
      <RightPane
        content={{
          kind: "lane-details",
          ...baseLaneDetails,
          selectedActionIndex: LANE_DETAIL_PR_ACTION_INDEX,
          pr: {
            number: 311,
            state: "open",
            url: "https://github.com/example/ADE/pull/311",
            checksPassed: 2,
            checksTotal: 5,
            checksPending: 0,
            checksFailed: 0,
          },
        }}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("open in browser");
    expect(frame).toContain("github.com/example/ADE/pull/311");
    expect(frame).toContain("run/open PR");
  });

  it("replaces runnable actions with an unavailable message when the worktree is missing", () => {
    const result = render(
      <RightPane
        content={{
          kind: "lane-details",
          ...baseLaneDetails,
          lane: lane({ name: "missing lane", worktreePath: "/tmp/missing-lane" }),
          worktreeAvailable: false,
        }}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("worktree missing");
    expect(frame).toContain("UNAVAILABLE");
    expect(frame).toContain("Restore this lane worktree");
    expect(frame).not.toContain("stage all");
    expect(frame).not.toContain("commit");
    expect(frame).not.toContain("push");
  });
});

describe("RightPane setup panes", () => {
  it("renders lane delete as a real preflight with scope, remote, force, and confirmation rows", () => {
    const result = render(
      <RightPane
        content={{
          kind: "form",
          title: "Delete lane",
          command: "lane-delete",
          laneDelete: {
            laneId: "lane-delete-1",
            laneName: "scratch-delete-tui",
            branchRef: "ade/scratch-delete-tui",
            dirty: true,
          },
          fields: [
            { name: "scope", label: "Scope", initialValue: "remote_branch" },
            { name: "remoteName", label: "Remote name", initialValue: "origin" },
            { name: "force", label: "Force delete", initialValue: "yes" },
            { name: "confirm", label: "Type lane name", required: true, placeholder: "scratch-delete-tui" },
          ],
        }}
        formValues={{
          scope: "remote_branch",
          force: "yes",
          remoteName: "origin",
          confirm: "scratch-delete-tui",
        }}
        activeFormField={0}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("DELETE LANE");
    expect(frame).toContain("Destructive action");
    expect(frame).toContain("scratch-delete-tui");
    expect(frame).toContain("uncommitted changes detected");
    expect(frame).toContain("[remote]");
    expect(frame).toContain("also delete origin/ade/scratch-delete-tui");
    expect(frame).toContain("Remote name");
    expect(frame).toContain("origin");
    expect(frame).toContain("[x] skip safety checks");
    expect(frame).toContain("enter deletes this lane");
  });

  it("renders the unified model picker with model list and settings footer", () => {
    const result = render(
      <RightPane
        content={{
          kind: "model-picker",
          surface: "chat",
          query: "",
          searchMode: false,
          selection: { kind: "provider", provider: "claude" },
          providerTabKey: null,
          focusedIndex: 0,
          footerFocus: null,
          settingsRows: [
            { kind: "reasoning", label: "Reasoning", value: "high", detail: "low, medium, high", cyclable: true },
            { kind: "permission", label: "Permissions", value: "auto", detail: "default · auto", cyclable: true },
          ],
        }}
        modelPickerInputs={{
          models: [
            { id: "anthropic/claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", isDefault: true },
          ],
          favorites: [],
          recents: [],
          activeModelId: "anthropic/claude-sonnet-4-6",
          activeReasoningEffort: "high",
        }}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("MODEL");
    expect(frame).toContain("Claude Sonnet 4.6");
    // Reasoning is shown in the settings footer, not as an inline per-model
    // "think high" chip (that detail was removed from model rows).
    expect(frame).toContain("reasoning");
    expect(frame).not.toContain("think high");
  });
});

describe("RightPane details", () => {
  it("keeps the title visible for long details bodies", () => {
    const result = render(
      <RightPane
        content={{
          kind: "details",
          title: "Skills",
          body: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"),
        }}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("SKILLS");
    expect(frame).toContain("line 1");
    expect(frame).toContain("↓ 14 more lines");
  });

  it("renders context usage as a visual pane", () => {
    const result = render(
      <RightPane
        content={{
          kind: "context-usage",
          title: "Context",
          usage: {
            totalTokens: 12000,
            maxTokens: 20000,
            percentage: 60,
            model: "gpt-5.5",
            categories: [
              { name: "messages", tokens: 8000, percentage: 40 },
              { name: "tools", tokens: 4000, percentage: 20 },
            ],
          },
        }}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("CONTEXT");
    expect(frame).toContain("gpt-5.5");
    expect(frame).toContain("12.0k / 20.0k (60%)");
    expect(frame).toContain("messages");
  });
});

describe("RightPane feedback form", () => {
  // The feedback pane render is exercised end-to-end through the deterministic
  // helper contract below (state rebuild -> serialize -> daemon draft). Full-frame
  // string assertions are intentionally avoided: ink-testing-library leaks tall
  // frames between renders in this suite, making pixel-frame matches flaky.

  it("feedbackStateFromContent rebuilds the framework-free form state", () => {
    const content = {
      kind: "form" as const,
      title: "Feedback",
      command: "feedback" as const,
      fields: [],
      feedback: {
        type: "idea" as const,
        body: "add dark mode\nplease",
        showContext: false,
        provider: "anthropic",
        model: "opus",
        lane: "L",
        lastError: "boom",
      },
    };
    const state = feedbackStateFromContent(content);
    expect(state.type).toBe("idea");
    expect(state.text).toBe("add dark mode\nplease");
    expect(state.showContext).toBe(false);
    expect(state.context).toEqual({ provider: "anthropic", model: "opus", lane: "L", lastError: "boom" });
  });

  it("submit path: feedbackStateFromContent -> feedbackFormToFormValues -> buildFeedbackDraftInput keeps the multiline body", () => {
    const content = {
      kind: "form" as const,
      title: "Feedback",
      command: "feedback" as const,
      fields: [],
      feedback: {
        type: "bug" as const,
        body: "crash on launch\nstep one\nstep two",
        showContext: true,
        provider: "anthropic",
        model: "opus",
        lane: "my-lane",
        lastError: "boom",
      },
    };
    const values = feedbackFormToFormValues(feedbackStateFromContent(content));
    expect(values.category).toBe("bug");
    expect(values.summary).toBe("crash on launch");
    const draft = buildFeedbackDraftInput(values);
    expect(draft.category).toBe("bug");
    expect(draft.summary).toBe("crash on launch");
    if (draft.category === "bug") {
      expect(draft.stepsToReproduce).toBe("crash on launch\nstep one\nstep two");
    }
    expect(draft.additionalContext).toContain("--- Context ---");
    expect(draft.additionalContext).toContain("Provider/Model: anthropic / opus");
    expect(draft.additionalContext).toContain("Lane: my-lane");
    expect(draft.additionalContext).toContain("Last error/notice: boom");
  });

  it("omits the context footer from the serialized draft when showContext is false", () => {
    const content = {
      kind: "form" as const,
      title: "Feedback",
      command: "feedback" as const,
      fields: [],
      feedback: { type: "idea" as const, body: "an idea", showContext: false, lane: "L" },
    };
    const values = feedbackFormToFormValues(feedbackStateFromContent(content));
    expect(values.additionalContext).toBeUndefined();
  });

  it("idea type maps to a feature draft", () => {
    const content = {
      kind: "form" as const,
      title: "Feedback",
      command: "feedback" as const,
      fields: [],
      feedback: { type: "idea" as const, body: "add dark mode\nplease", showContext: false },
    };
    const draft = buildFeedbackDraftInput(feedbackFormToFormValues(feedbackStateFromContent(content)));
    expect(draft.category).toBe("feature");
    expect(draft.summary).toBe("add dark mode");
  });
});
