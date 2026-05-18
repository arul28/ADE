import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { RightPane } from "../components/RightPane";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";

function stripAnsi(text: string): string {
  return text.replace(/\u001b(?:\[[0-9;]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "");
}

import type { ChatInfoSnapshot } from "../types";

function chatInfo(overrides: Partial<ChatInfoSnapshot> = {}): ChatInfoSnapshot {
  return {
    provider: "codex",
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
    expect(frame).toContain("↑↓ focus · ↵ swap · esc → main");
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
          selectedActionIndex: 0,
        }}
        focused
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("ACTIONS");
    expect(frame).toMatch(/\[a\]\s*stage all/);
    expect(frame).toContain("commit");
    expect(frame).not.toMatch(/\[c\]\s*commit/);
    expect(frame).not.toMatch(/\[p\]\s*push/);
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
          selectedActionIndex: 5,
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
