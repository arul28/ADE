import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { RightPane } from "../components/RightPane";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { ProviderReadinessRow, RightPaneContent, SetupPaneRow } from "../types";

const setupRows: SetupPaneRow[] = [
  { kind: "provider", label: "Provider", value: "Codex", cyclable: true },
  { kind: "model", label: "Model", value: "GPT-5.5", cyclable: true, detail: "5 available" },
  { kind: "reasoning", label: "Reasoning", value: "medium", cyclable: true, detail: "low, medium, high" },
  { kind: "permission", label: "Permissions", value: "default", cyclable: true },
  { kind: "codex-fast", label: "Fast mode", value: "off", cyclable: true, detail: "Codex service tier" },
  { kind: "refresh-status", label: "Refresh status", value: "run", detail: "checks provider auth/runtime state" },
  { kind: "open-settings", label: "Full settings", value: "open desktop", detail: "Settings > AI Providers" },
];

const providerRows: ProviderReadinessRow[] = [
  { provider: "codex", label: "Codex", status: "ready", detail: "ready at /usr/local/bin/codex", modelCount: 6 },
  { provider: "claude", label: "Claude", status: "ready", detail: "ready at /usr/local/bin/claude", modelCount: 4 },
  { provider: "cursor", label: "Cursor", status: "unknown", detail: "API key store not yet readable", modelCount: 0 },
  { provider: "droid", label: "Droid", status: "unavailable", detail: "no Factory Droid CLI or FACTORY_API_KEY", modelCount: 0 },
  { provider: "opencode", label: "OpenCode", status: "ready", detail: "user-installed · 0 shared runtime", modelCount: 4442 },
];

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function content(overrides: Partial<Extract<RightPaneContent, { kind: "model-setup" }>> = {}): RightPaneContent {
  return {
    kind: "model-setup",
    rows: setupRows,
    providerRows,
    activeProvider: "codex",
    checkedAt: "2026-05-09T19:57:09.000Z",
    desktopAttached: true,
    ...overrides,
  };
}

function renderModelSetup(selectedIndex: number, overrides: Partial<Extract<RightPaneContent, { kind: "model-setup" }>> = {}): string {
  const result = render(
    <RightPane content={content(overrides)} selectedIndex={selectedIndex} focused />,
  );
  return result.lastFrame() ?? "";
}

describe("RightPane model-setup", () => {
  it("renders PROVIDER tab strip + MODEL section header", () => {
    const frame = renderModelSetup(0);
    expect(frame).toContain("PROVIDER");
    expect(frame).toContain("MODEL");
  });

  it("renders all five providers as compact brand chips", () => {
    const frame = stripAnsi(renderModelSetup(0));
    expect(frame).toContain("[● Codex]");
    expect(frame).toContain("[● Claude]");
    expect(frame).toContain("[● Cursor]");
    expect(frame).toContain("[● Droid]");
    expect(frame).toContain("[● OpenCode]");
    expect(frame).not.toContain("◇ Codex");
    expect(frame).not.toContain("◆ Claude");
  });

  it("renders the STATUS readiness section for the active provider", () => {
    const frame = renderModelSetup(0);
    expect(frame).toContain("STATUS · CODEX");
  });

  it("uses the compact target title and active-first provider order in wide mode", () => {
    const result = render(
      <RightPane
        content={content({ activeProvider: "claude" })}
        selectedIndex={0}
        focused
        width={84}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("SETUP · MODEL");
    expect(frame.indexOf("Claude")).toBeLessThan(frame.indexOf("Codex"));
  });

  it("renders output style as a model setup row when provided", () => {
    const result = render(
      <RightPane
        content={content({
          activeProvider: "claude",
          rows: [
            ...setupRows,
            {
              kind: "output-style",
              label: "Output style",
              value: "default",
              detail: "default · concise · verbose",
              cyclable: true,
            },
          ],
        })}
        selectedIndex={5}
        focused
        width={84}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("Output style");
    expect(frame).toContain("default · concise · verbose");
  });

  it("renders provider tab readiness legend", () => {
    const frame = renderModelSetup(0);
    expect(frame).toContain("ready");
    expect(frame).toContain("active");
    expect(frame).toContain("needs login");
  });

  it("renders the footer hint row", () => {
    const frame = renderModelSetup(0);
    expect(frame).toContain("provider");
    expect(frame).toContain("apply");
    expect(frame).toContain("login");
  });
});

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
