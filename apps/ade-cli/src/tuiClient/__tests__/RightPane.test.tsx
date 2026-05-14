import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { RightPane } from "../components/RightPane";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";

function stripAnsi(text: string): string {
  return text.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("RightPane subagents", () => {
  it("renders an agents process table with main, subagents, and teammates", () => {
    const result = render(
      <RightPane
        content={{
          kind: "subagents",
          tab: "subagents",
          provider: "claude",
          snapshots: [
            { id: "a1", name: "research", kind: "subagent", status: "running", summary: "checking files", tokens: 2300, durationMs: 14000 },
            { id: "b1", name: "mate-x", kind: "teammate", status: "completed", summary: "done" },
          ],
        }}
        focused
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("AGENTS · CLAUDE");
    expect(frame).toContain("Subagents · 1");
    expect(frame).toContain("Teammates · 1");
    expect(frame).toContain("Background · 0");
    expect(frame).toContain("main");
    expect(frame).toContain("research");
    expect(frame).toContain("TEAMMATES");
    expect(frame).toContain("mate-x");
    expect(frame).toContain("transcript follows");
  });

  it("renders the empty-state copy when no subagents have run yet", () => {
    const result = render(
      <RightPane
        content={{
          kind: "subagents",
          tab: "subagents",
          provider: "claude",
          snapshots: [],
        }}
        focused
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("No subagents yet.");
  });

  it("renders a single tab + placeholder for Droid (no subagents in ACP)", () => {
    const result = render(
      <RightPane
        content={{ kind: "subagents", tab: "subagents", provider: "droid", snapshots: [] }}
        focused
      />,
    );
    const frame = result.lastFrame() ?? "";

    expect(frame).toContain("AGENTS · DROID");
    expect(frame).toContain("agentclientprotocol.com");
    // Droid does not show the Teammates tab.
    expect(frame).not.toContain("Teammates");
  });

  it("renders only the Subagents tab for Codex/Cursor/OpenCode", () => {
    const result = render(
      <RightPane
        content={{
          kind: "subagents",
          tab: "subagents",
          provider: "codex",
          snapshots: [
            { id: "x1", name: "delegated", kind: "subagent", status: "running", summary: "" },
          ],
        }}
        focused
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("AGENTS · CODEX");
    expect(frame).toContain("Subagents · 1");
    expect(frame).toContain("Teammates · 0");
    expect(frame).toContain("delegated");
  });

  it("uses a spinning frame for running subagents at or below the cap", () => {
    const result = render(
      <RightPane
        content={{
          kind: "subagents",
          tab: "subagents",
          provider: "codex",
          snapshots: [
            { id: "x1", name: "delegated", kind: "subagent", status: "running", summary: "" },
          ],
        }}
        focused
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toMatch(/[◐◓◑◒] 01/);
  });

  it("falls back to the static running glyph when more than twelve subagents are running", () => {
    const snapshots = Array.from({ length: 13 }, (_, index) => ({
      id: `x${index + 1}`,
      name: `agent-${index + 1}`,
      kind: "subagent" as const,
      status: "running" as const,
      summary: "",
    }));
    const result = render(
      <RightPane
        content={{
          kind: "subagents",
          tab: "subagents",
          provider: "codex",
          snapshots,
        }}
        focused
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("● 01");
    expect(frame).not.toMatch(/[◐◓◑◒] 01/);
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
