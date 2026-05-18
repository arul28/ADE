import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { RightPane } from "../components/RightPane";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";

function stripAnsi(text: string): string {
  return text.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
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
  it("renders lane identity and branch as a focused lane detail header", () => {
    const result = render(
      <RightPane
        content={{
          kind: "lane-details",
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
          files: [],
          pr: null,
          showFiles: false,
          selectedActionIndex: 0,
        }}
        focused
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("DIFF LANE · FOCUSED");
    expect(frame).toContain("Diff lane");
    expect(frame).toContain("⎇ feature/diff-lane");
    expect(frame).not.toContain("name");
    expect(frame).not.toContain("branch");
    expect(frame).not.toContain("tracking");
    expect(frame).not.toContain("model");
  });

  it("renders real line diff stats with a U+2212 minus sign", () => {
    const result = render(
      <RightPane
        content={{
          kind: "lane-details",
          lane: lane(),
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
          files: [],
          pr: null,
          showFiles: false,
          selectedActionIndex: 0,
        }}
        focused
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("diff");
    expect(frame).toContain("+12");
    expect(frame).toContain("−4");
    expect(frame).toContain("CHANGES · 3");
    expect(frame).not.toContain("-4");
    expect(frame).toContain("2 staged");
    expect(frame).toContain("1 unstaged");
    expect(frame).not.toContain("tracking");
  });

  it("renders a compact changes header when line additions and deletions are zero", () => {
    const result = render(
      <RightPane
        content={{
          kind: "lane-details",
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
          files: [],
          pr: null,
          showFiles: false,
          selectedActionIndex: 0,
        }}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("CHANGES · 2");
    expect(frame).toContain("No changed files.");
    expect(frame).not.toContain("— · 2 files");
  });

  it("replaces runnable actions with an unavailable message when the worktree is missing", () => {
    const result = render(
      <RightPane
        content={{
          kind: "lane-details",
          lane: lane({ name: "missing lane", worktreePath: "/tmp/missing-lane" }),
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
          files: [],
          pr: null,
          showFiles: false,
          selectedActionIndex: 0,
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
