import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../components/Header";
import { FooterControls } from "../components/FooterControls";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";

function stripAnsi(text: string): string {
  return text.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

function lane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "TUI polish",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/tui-polish",
    worktreePath: "/tmp/lane",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: {
      dirty: false,
      ahead: 0,
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

describe("Header", () => {
  it("does not duplicate ADE when the project itself is ADE", () => {
    const result = render(<Header projectName="ADE" lane={null} />);
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame.match(/ADE/g)).toHaveLength(1);
  });

  it("shows concise lane and branch context without model details", () => {
    const result = render(<Header projectName="Project" lane={lane()} chatTitle="Design pass" />);
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("lane");
    expect(frame).toContain("TUI polish");
    expect(frame).toContain("branch");
    expect(frame).toContain("feature/tui-polish");
    expect(frame).toContain("chat");
    expect(frame).toContain("Design pass");
    expect(frame).not.toContain("GPT");
  });

  it("suppresses the project label when it repeats the branch basename", () => {
    const result = render(
      <Header
        projectName="feature-a"
        lane={lane({
          branchRef: "ade/feature-a",
          worktreePath: "/repo/.ade/worktrees/feature-a",
        })}
        chatTitle="Review"
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("chat Review");
    expect(frame).toContain("branch ade/feature-a");
    expect(frame.match(/feature-a/g)).toHaveLength(1);
  });
});

describe("FooterControls", () => {
  it("renders the flat picker cells with provider, model, permission, and fast indicator", () => {
    const result = render(
      <FooterControls
        provider="codex"
        modelDisplay="GPT-5.5"
        permissionLabel="full-auto"
        fastMode
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("GPT-5.5");
    expect(frame).toContain("fast");
    expect(frame).toContain("full-auto");
  });

  it("renders the resting hint strip with lanes/info/subagents/cmds/help", () => {
    const result = render(
      <FooterControls
        provider="codex"
        modelDisplay="GPT-5.5"
        permissionLabel="default"
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("^o");
    expect(frame).toContain("lanes");
    expect(frame).toContain("^p");
    expect(frame).toContain("info");
    expect(frame).toContain("^a");
    expect(frame).toContain("subagents");
    expect(frame).toContain("cmds");
    expect(frame).toContain("help");
  });

  it("adds the Claude terminal control toggle when a Claude terminal is active", () => {
    const result = render(
      <FooterControls
        provider="claude"
        modelDisplay="claude-opus"
        permissionLabel="default"
        terminalControlAvailable
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("^t");
    expect(frame).toContain("Claude");
  });

  it("renders dedicated Claude control hints while the terminal owns input", () => {
    const result = render(
      <FooterControls
        provider="claude"
        modelDisplay="claude-opus"
        permissionLabel="default"
        terminalControlAvailable
        terminalControlActive
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("CLAUDE CONTROL");
    expect(frame).toContain("^t");
    expect(frame).toContain("ADE");
    expect(frame).toContain("^]");
    expect(frame).not.toContain("^o lanes");
  });

  it("renders a focus indicator and cell hints when the inline row is focused", () => {
    const result = render(
      <FooterControls
        provider="codex"
        modelDisplay="GPT-5.5"
        reasoningEffort="medium"
        permissionLabel="default"
        inlineRowFocused
        inlineRowCell="model"
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("▸");
    // The focused cell is wrapped in brackets.
    expect(frame).toContain("[GPT-5.5]");
    // Focused row shows up/cells/cycle hints instead of the resting strip.
    expect(frame).toContain("prompt");
    expect(frame).toContain("cells");
    expect(frame).toContain("cycle");
    expect(frame).not.toContain("^o lanes");
  });

  it("renders reasoning and permission picker cells", () => {
    const result = render(
      <FooterControls
        provider="claude"
        modelDisplay="claude-opus"
        reasoningEffort="high"
        permissionLabel="acceptEdits"
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("claude-opus");
    expect(frame).toContain("high");
    expect(frame).toContain("acceptEdits");
  });

  it("renders the subagents button when visible and counts agents", () => {
    const result = render(
      <FooterControls
        provider="claude"
        modelDisplay="claude-opus"
        permissionLabel="default"
        liveAgentCount={2}
        subagentsButtonVisible
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("2 subagents");
  });

  it("renders the approval prompt hints when an approval is active", () => {
    const result = render(
      <FooterControls
        provider="codex"
        modelDisplay="GPT-5.5"
        permissionLabel="default"
        approvalActive
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("approve");
    expect(frame).toContain("deny");
    expect(frame).not.toContain("^o lanes");
  });
});
