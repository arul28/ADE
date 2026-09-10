/* @vitest-environment jsdom */

/**
 * The picker card gives a status ONE line, in a track that is 154px wide at two
 * columns. These tests are about length as much as content: every line here is
 * a fact, never a sentence, because the sentence version ("Shells attached to
 * this session", "3 ahead · uncommitted changes") is what truncated mid-word.
 */
import { createElement, type ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuiltInBrowserStatus, LaneSummary } from "../../../shared/types";
import {
  appControlStatusLine,
  browserStatusLine,
  filesStatusLine,
  gitStatusLine,
  iosStatusLine,
  terminalStatusLine,
  workToolDotState,
  workToolSummary,
  useWorkToolStatuses,
} from "./useWorkToolStatuses";
import { NativeToolFeedsProvider } from "./NativeToolFeedsContext";
import {
  publishWorkTerminalShellCount,
  clearWorkTerminalShellCount,
  resetWorkTerminalShellCounts,
} from "./workTerminalShells";
import { asBuiltInBrowserStatus, isAppControlSessionAttached } from "./useNativeToolSessions";
import {
  EMPTY_WORK_TOOL_ERRORS,
  pruneWorkToolBrowserErrors,
  workToolBrowserErrorCount,
} from "./workToolErrors";

/** The longest a status can be before the two-column card cuts it. */
const ONE_LINE_BUDGET = 22;

function browserStatus(partial: Partial<BuiltInBrowserStatus>): BuiltInBrowserStatus {
  return {
    tabs: [],
    activeTabId: null,
    url: null,
    ownerLaneId: null,
    ...partial,
  } as BuiltInBrowserStatus;
}

function tab(partial: Record<string, unknown>) {
  return { id: "t1", url: "https://example.com/", title: "Example", ownerLaneId: null, ...partial } as never;
}

describe("work tool status lines", () => {
  it("counts shells instead of naming them", () => {
    expect(terminalStatusLine([]).line).toBe("No shells");
    expect(terminalStatusLine(["zsh"]).line).toBe("1 shell");
    expect(terminalStatusLine(["zsh", "npm run dev -w apps/desktop"]).line).toBe("2 shells");
    expect(terminalStatusLine(null).line).toBeNull();
  });

  it("prefers the panel's own shell count over the pane's list read", () => {
    // The regression: a split opens a second shell that the daemon's list can
    // report as finished, so the pane said "1 shell" over two live panes. What
    // the panel RENDERS is the count, whenever a panel is mounted.
    expect(terminalStatusLine(["zsh"], 2).line).toBe("2 shells");
    // And a shell the list has not caught up with yet is still a shell.
    expect(terminalStatusLine([], 1).line).toBe("1 shell");
    expect(terminalStatusLine(null, 0).line).toBe("No shells");
    // With no panel mounted the pane falls back to its own read.
    expect(terminalStatusLine(["zsh"], null).line).toBe("1 shell");
  });

  it("shows the cached file total and changed-entry count", () => {
    const lane = (
      status: Partial<NonNullable<LaneSummary["status"]>>,
      extra: Partial<LaneSummary> = {},
    ) => ({
      ...extra,
      status: {
        ahead: 0,
        behind: 0,
        dirty: false,
        rebaseInProgress: false,
        trackedFileCount: null,
        changedFileCount: 0,
        ...status,
      },
    } as LaneSummary);
    expect(filesStatusLine(lane({ changedFileCount: 3 }, { trackedFileCount: 1_240 })).line)
      .toBe("1,240 files · 3 changed");
    expect(filesStatusLine(lane({}, { trackedFileCount: 12 })).line).toBe("12 files");
    expect(filesStatusLine(lane({ dirty: true, staged: 1, unstaged: 2, untracked: 1 })).line)
      .toBe("Browse");
    expect(filesStatusLine(null).line).toBe("Browse");
    // Never "live": a worktree with edits in it is not a running tool, and an
    // activity dot for one would be a dot that never goes out.
    expect(filesStatusLine(lane({ changedFileCount: 3 }, { trackedFileCount: 12 })).live).toBe(false);
  });

  it("says how many tabs and who holds them, in two words", () => {
    expect(browserStatusLine(null, null).line).toBe("No tabs");
    expect(browserStatusLine(
      browserStatus({ tabs: [tab({}), tab({ id: "t2" }), tab({ id: "t3", ownerLaneId: "lane-1" })], activeTabId: "t1" }),
      "lane-1",
    ).line).toBe("3 tabs · agent");
    expect(browserStatusLine(
      browserStatus({ tabs: [tab({ ownerLaneId: "lane-2" })], activeTabId: "t1" }),
      "lane-1",
    ).line).toBe("example.com · other lane");
    // A handoff is the one state that outranks ownership.
    const handoff = browserStatusLine(
      browserStatus({ tabs: [tab({ ownerLaneId: "lane-1", handoff: { reason: "login" } })], activeTabId: "t1" }),
      "lane-1",
    );
    expect(handoff.line).toBe("example.com · you");
    expect(handoff.attention).toBe(true);
  });

  it("prioritizes useful git state and keeps each line short", () => {
    const lane = (
      status: Partial<NonNullable<LaneSummary["status"]>>,
      extra: Partial<LaneSummary> = {},
    ) => ({
      ...extra,
      status: {
        ahead: 0,
        behind: 0,
        dirty: false,
        remoteBehind: -1,
        rebaseInProgress: false,
        lastCommitAt: null,
        ...status,
      },
    } as LaneSummary);
    const commitAt = "2026-09-09T16:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T18:00:00.000Z"));
    try {
      expect(gitStatusLine(null).line).toBeNull();
      expect(gitStatusLine(lane({})).line).toBe("Unpublished");
      expect(gitStatusLine(lane({ dirty: true, unstaged: 3 }, { lastCommitAt: commitAt })).line)
        .toBe("3 unstaged");
      expect(gitStatusLine(lane({ dirty: true, staged: 1 }, { lastCommitAt: commitAt })).line)
        .toBe("1 staged");
      expect(gitStatusLine(lane({ dirty: true, untracked: 2 }, { lastCommitAt: commitAt })).line)
        .toBe("2 untracked");
      expect(gitStatusLine(lane({ dirty: true, unstaged: 3, staged: 1, untracked: 4 }, { lastCommitAt: commitAt })).line)
        .toBe("3 unstaged · 1 staged");
      expect(gitStatusLine(lane({ ahead: 2 }, { lastCommitAt: commitAt })).line).toBe("2 ahead");
      expect(gitStatusLine(lane({ behind: 1 }, { lastCommitAt: commitAt })).line).toBe("1 behind");
      expect(gitStatusLine(lane({ ahead: 2, behind: 1 }, { lastCommitAt: commitAt })).line)
        .toBe("2 ahead · 1 behind");
      expect(gitStatusLine(lane({ remoteBehind: 0 }, { lastCommitAt: commitAt })).line).toBe("Pushed 2h ago");
      expect(gitStatusLine(lane({}, { lastCommitAt: commitAt })).line).toBe("Committed 2h ago");
      expect(gitStatusLine(lane({ rebaseInProgress: true })).line).toBe("Rebasing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the other tools to a fact each", () => {
    expect(iosStatusLine(null).line).toBe("Not booted");
    expect(iosStatusLine({ deviceName: "iPhone 17 Pro" } as never).line).toBe("iPhone 17 Pro");
    expect(appControlStatusLine(null).line).toBe("No app");
    expect(appControlStatusLine({ label: "Zen", status: "running" } as never).line).toBe("Zen");
  });

  it("keeps the fixed lines inside the one-line budget", () => {
    for (const line of ["No shells", "2 shells", "No tabs", "Unpublished", "3 unstaged · 1 staged", "Not booted", "No app"]) {
      expect(line.length).toBeLessThanOrEqual(ONE_LINE_BUDGET);
    }
  });
});

/**
 * The hosted web client answers `builtInBrowser.getStatus` from a stub that has
 * no `tabs`, cast into the real type by the adapter — so `tsc` never sees the
 * mismatch and every consumer that dereferences `status.tabs` throws during
 * render. These lock the boundary check, not the stub.
 */
describe("non-conforming browser status (web client stub)", () => {
  const unsupportedStub = {
    supported: false,
    available: false,
    state: "unsupported",
  } as unknown as BuiltInBrowserStatus;

  it("is rejected by the boundary guard", () => {
    expect(asBuiltInBrowserStatus(unsupportedStub)).toBeNull();
    expect(asBuiltInBrowserStatus(null)).toBeNull();
    expect(asBuiltInBrowserStatus(browserStatus({ tabs: [] }))).not.toBeNull();
  });

  it("does not throw from the status line", () => {
    expect(() => browserStatusLine(unsupportedStub, "lane-1")).not.toThrow();
    expect(browserStatusLine(unsupportedStub, "lane-1").line).toBe("No tabs");
  });

  it("does not throw from the error tally", () => {
    expect(() => workToolBrowserErrorCount(EMPTY_WORK_TOOL_ERRORS, unsupportedStub)).not.toThrow();
    expect(workToolBrowserErrorCount(EMPTY_WORK_TOOL_ERRORS, unsupportedStub)).toBe(0);
    expect(() => pruneWorkToolBrowserErrors({ "tab-1": { consoleErrorCount: 1, failedRequestCount: 0 } }, unsupportedStub))
      .not.toThrow();
  });
});

describe("isAppControlSessionAttached", () => {
  it("means an app is on the other end, not just that a session exists", () => {
    expect(isAppControlSessionAttached(null)).toBe(false);
    expect(isAppControlSessionAttached({ status: "connected" } as never)).toBe(true);
    expect(isAppControlSessionAttached({ status: "running", cdpEndpoint: "ws://x" } as never)).toBe(true);
    // The launch terminal is up but nothing has attached (or it quit).
    expect(isAppControlSessionAttached({ status: "running", cdpEndpoint: null } as never)).toBe(false);
    expect(isAppControlSessionAttached({ status: "starting" } as never)).toBe(false);
    expect(isAppControlSessionAttached({ status: "failed" } as never)).toBe(false);
    expect(isAppControlSessionAttached({ status: "stopped" } as never)).toBe(false);
    expect(isAppControlSessionAttached({ status: "exited" } as never)).toBe(false);
  });
});

describe("app control dot states", () => {
  /**
   * The regression: the header painted a green "live" dot for any session that
   * had not been stopped, so a launch terminal with no app attached showed
   * green beside a context line that read "No app".
   */
  it("is green only when an app is attached", () => {
    expect(workToolDotState(appControlStatusLine(null))).toBe("idle");
    expect(workToolDotState(appControlStatusLine({ label: "Zen", status: "connected" } as never)))
      .toBe("live");
    expect(workToolDotState(
      appControlStatusLine({ label: "Zen", status: "running", cdpEndpoint: "ws://x" } as never),
    )).toBe("live");
  });

  it("is amber for a session that exists but is not driving anything", () => {
    for (const status of ["starting", "running", "stopping"]) {
      expect(workToolDotState(appControlStatusLine({ label: "Zen", status } as never)))
        .toBe("attention");
    }
  });

  it("keeps red for failed and no dot at all once the session is over", () => {
    expect(workToolDotState(appControlStatusLine({ label: "Zen", status: "failed" } as never)))
      .toBe("error");
    for (const status of ["stopped", "exited"]) {
      expect(workToolDotState(appControlStatusLine({ label: "Zen", status } as never))).toBe("idle");
    }
  });
});

describe("workToolSummary", () => {
  const definition = { id: "browser", label: "Browser", hint: "Drive a real browser" } as never;
  const hintless = { id: "files", label: "Files" } as never;
  const available = { available: true, reason: null } as const;

  it("gives the picker and the header the same line", () => {
    const summary = workToolSummary(definition, { line: "3 tabs", live: true, errorCount: 2 }, available);
    expect(summary.line).toBe("3 tabs · 2 errors");
    expect(summary.tooltipLabel).toBe("Browser — 3 tabs · 2 errors");
  });

  it("falls back to the catalogue hint when nothing has been measured", () => {
    // The picker used to own this string, so a clipped card's tooltip — whose
    // whole job is to be the rest of the sentence — said less than the card.
    // One resolution, so both read the same words.
    const summary = workToolSummary(definition, undefined, available);
    expect(summary.line).toBe("Drive a real browser");
    expect(summary.tooltipLabel).toBe("Browser — Drive a real browser");
  });

  it("says nothing at all for a tool with no hint and no measurement", () => {
    const summary = workToolSummary(hintless, undefined, available);
    expect(summary.line).toBeNull();
    // …and the tooltip is then the tool's name, not "Files — ".
    expect(summary.tooltipLabel).toBe("Files");
  });

  it("prefers a measured status over the hint", () => {
    const summary = workToolSummary(definition, { line: "3 tabs", live: true }, available);
    expect(summary.line).toBe("3 tabs");
  });

  it("states the reason instead when the tool cannot run here", () => {
    const summary = workToolSummary(definition, { line: "3 tabs", live: true }, {
      available: false,
      reason: "Not available on this machine",
    });
    expect(summary.line).toBe("Not available on this machine");
  });
});

/**
 * The shell count the pane falls back to when no terminal panel is mounted.
 *
 * The regression: `terminal.list` was read once and then only re-read on a
 * session change or a PTY exit, so starting a shell and switching away from the
 * terminal left the header and the picker card saying "No shells" over a shell
 * that was still running — the panel's published count had gone back to null
 * and the stale list was all that was left.
 */
describe("useWorkToolStatuses shell re-reads", () => {
  const OWNER = "chat-1";

  afterEach(() => {
    cleanup();
    resetWorkTerminalShellCounts();
    delete (window as unknown as { ade?: unknown }).ade;
  });

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(NativeToolFeedsProvider, { active: true, runtimePin: null, children });
  }

  it("re-reads terminal.list when the panel's published count changes", async () => {
    let shells: Array<{ title: string; status: string; active: boolean }> = [];
    const list = vi.fn(async () => shells);
    (window as unknown as { ade?: unknown }).ade = {
      terminal: { list },
      sessions: { onChanged: () => () => {} },
      pty: { onExit: () => () => {} },
    };

    const { result } = renderHook(
      () => useWorkToolStatuses({
        enabled: true,
        laneId: null,
        lane: null,
        runtimePin: null,
        terminalOwnerSessionId: OWNER,
        activeTool: "terminal",
      }),
      { wrapper },
    );

    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(result.current.statuses.terminal?.line).toBe("No shells");

    // A panel mounts and reports a live shell; the daemon's list now has it too.
    shells = [{ title: "zsh", status: "running", active: true }];
    publishWorkTerminalShellCount(OWNER, 1);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    // …and the panel unmounts. The published count is gone, so the pane's own
    // read is the only answer left — and it has to be a FRESH one.
    clearWorkTerminalShellCount(OWNER);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.statuses.terminal?.line).toBe("1 shell"));
  });
});
