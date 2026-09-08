/**
 * The picker card gives a status ONE line, in a track that is 154px wide at two
 * columns. These tests are about length as much as content: every line here is
 * a fact, never a sentence, because the sentence version ("Shells attached to
 * this session", "3 ahead · uncommitted changes") is what truncated mid-word.
 */
import { describe, expect, it } from "vitest";
import type { BuiltInBrowserStatus, LaneSummary } from "../../../shared/types";
import {
  appControlStatusLine,
  browserStatusLine,
  gitStatusLine,
  iosStatusLine,
  terminalStatusLine,
  workToolSummary,
} from "./useWorkToolStatuses";
import { asBuiltInBrowserStatus, isAppControlSessionLive } from "./useNativeToolSessions";
import {
  EMPTY_WORK_TOOL_ERRORS,
  pruneWorkToolBrowserErrors,
  workToolBrowserErrorCount,
} from "./workToolErrors";

/** The longest a status can be before the two-column card cuts it. */
const ONE_LINE_BUDGET = 16;

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

  it("keeps git to counts and one word of state", () => {
    const lane = (status: Partial<NonNullable<LaneSummary["status"]>>) => ({
      status: { ahead: 0, behind: 0, dirty: false, rebaseInProgress: false, ...status },
    } as LaneSummary);
    // Capitalised like every other tool's line, so a column of cards does not
    // read as five sentences and one typo.
    expect(gitStatusLine(lane({})).line).toBe("Clean");
    expect(gitStatusLine(lane({ dirty: true })).line).toBe("Dirty");
    // Only the FIRST character: a line that already opens with a count is left
    // exactly as it was, and the state word stays lowercase mid-line.
    expect(gitStatusLine(lane({ ahead: 3, dirty: true })).line).toBe("3 ahead · dirty");
    expect(gitStatusLine(lane({ rebaseInProgress: true })).line).toBe("Rebasing");
  });

  it("keeps the other tools to a fact each", () => {
    expect(iosStatusLine(null).line).toBe("Not booted");
    expect(iosStatusLine({ deviceName: "iPhone 17 Pro" } as never).line).toBe("iPhone 17 Pro");
    expect(appControlStatusLine(null).line).toBe("No app");
    expect(appControlStatusLine({ label: "Zen", status: "running" } as never).line).toBe("Zen");
  });

  it("keeps the fixed lines inside the one-line budget", () => {
    for (const line of ["No shells", "2 shells", "No tabs", "Clean", "3 ahead · dirty", "Not booted", "No app"]) {
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

describe("isAppControlSessionLive", () => {
  it("is the one rule both the pane and the corner card read", () => {
    expect(isAppControlSessionLive(null)).toBe(false);
    expect(isAppControlSessionLive({ status: "connected" } as never)).toBe(true);
    // `failed` is still attached — that is what makes the dot red, not absent.
    expect(isAppControlSessionLive({ status: "failed" } as never)).toBe(true);
    expect(isAppControlSessionLive({ status: "stopped" } as never)).toBe(false);
    expect(isAppControlSessionLive({ status: "exited" } as never)).toBe(false);
  });
});

describe("workToolSummary", () => {
  const definition = { id: "browser", label: "Browser" } as never;
  const available = { available: true, reason: null } as const;

  it("gives the picker and the header the same line", () => {
    const summary = workToolSummary(definition, { line: "3 tabs", live: true, errorCount: 2 }, available);
    expect(summary.line).toBe("3 tabs · 2 errors");
    expect(summary.tooltipLabel).toBe("Browser — 3 tabs · 2 errors");
  });

  it("says nothing at all when nothing has been measured", () => {
    const summary = workToolSummary(definition, undefined, available);
    expect(summary.line).toBe("");
    // …and the tooltip is then the tool's name, not "Browser — ".
    expect(summary.tooltipLabel).toBe("Browser");
  });

  it("states the reason instead when the tool cannot run here", () => {
    const summary = workToolSummary(definition, { line: "3 tabs", live: true }, {
      available: false,
      reason: "Not available on this machine",
    });
    expect(summary.line).toBe("Not available on this machine");
  });
});
