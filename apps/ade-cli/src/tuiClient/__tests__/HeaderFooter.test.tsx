import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../components/Header";
import { FooterControls } from "../components/FooterControls";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
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
  it("labels the right pane as info and keeps fast with model mode info", () => {
    const result = render(
      <FooterControls
        drawerOpen={true}
        rightOpen={true}
        drawerFocused={false}
        detailsFocused={false}
        footerControlActive={false}
        provider="codex"
        modelDisplay="GPT-5.5"
        permissionLabel="full-auto"
        fastMode
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("info");
    expect(frame).toContain("GPT-5.5");
    expect(frame).toContain("fast");
    expect(frame).toContain("full-auto");
    expect(frame).not.toContain("setup");
  });

  it("shows chat scroll controls when the transcript is focused", () => {
    const result = render(
      <FooterControls
        drawerOpen={true}
        rightOpen={true}
        activePane="chat"
        drawerFocused={false}
        detailsFocused={false}
        footerControlActive={false}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("scroll");
    expect(frame).toContain("Tab lanes");
    expect(frame).not.toContain("↑↓ lanes");
  });

  it("shows the clamped chat scroll position in the footer", () => {
    const result = render(
      <FooterControls
        drawerOpen={true}
        rightOpen={true}
        activePane="chat"
        drawerFocused={false}
        detailsFocused={false}
        footerControlActive={false}
        chatScrollOffset={999}
        chatScrollMaxOffset={42}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("42/42");
  });

  it("surfaces staged steer state in the footer", () => {
    const result = render(
      <FooterControls
        drawerOpen={true}
        rightOpen={true}
        activePane="chat"
        drawerFocused={false}
        detailsFocused={false}
        footerControlActive={false}
        pendingSteerCount={2}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("staged 2");
    expect(frame).toContain("/steer");
  });

  it("shows an agents pane toggle when the active chat has subagent history", () => {
    const result = render(
      <FooterControls
        drawerOpen={false}
        rightOpen={false}
        activePane="chat"
        drawerFocused={false}
        detailsFocused={false}
        footerControlActive={false}
        liveAgentCount={2}
        rightPaneShowsAgents={true}
        agentsAvailable={true}
        agentsOpen={true}
        agentsFocused={true}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("agents");
    expect(frame).toContain("^a");
    expect(frame.indexOf("agents")).toBeLessThan(frame.indexOf("lanes"));
    expect(frame.indexOf("lanes")).toBeLessThan(frame.indexOf("info"));
    expect(frame).not.toContain("● 2 agents");
  });

  it("shows lane navigation controls when the drawer lane list is focused", () => {
    const result = render(
      <FooterControls
        drawerOpen={true}
        rightOpen={true}
        activePane="drawer"
        drawerMode="lanes"
        drawerFocused={false}
        detailsFocused={false}
        footerControlActive={false}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("↑↓ lanes");
    expect(frame).toContain("↵ open");
    expect(frame).not.toContain("scroll");
  });

  it("shows chat list controls when drawer chats are focused", () => {
    const result = render(
      <FooterControls
        drawerOpen={true}
        rightOpen={true}
        activePane="drawer"
        drawerMode="chats"
        drawerFocused={false}
        detailsFocused={false}
        footerControlActive={false}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("↑↓ chats");
    expect(frame).toContain("Esc lanes");
    expect(frame).not.toContain("scroll");
  });
});
