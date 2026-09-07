/**
 * The picker card gives a status ONE line, in a track that is 154px wide at two
 * columns. These tests are about length as much as content: every line here is
 * a fact, never a sentence, because the sentence version ("Shells attached to
 * this session", "3 ahead · uncommitted changes") is what truncated mid-word.
 */
import { describe, expect, it } from "vitest";
import type { BuiltInBrowserStatus, LaneSummary, PrSummary } from "../../../shared/types";
import {
  appControlStatusLine,
  browserStatusLine,
  gitStatusLine,
  iosStatusLine,
  prStatusLine,
  terminalStatusLine,
} from "./useWorkToolStatuses";

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
    expect(gitStatusLine(lane({})).line).toBe("clean");
    expect(gitStatusLine(lane({ ahead: 3, dirty: true })).line).toBe("3 ahead · dirty");
    expect(gitStatusLine(lane({ rebaseInProgress: true })).line).toBe("Rebasing");
  });

  it("keeps the other tools to a fact each", () => {
    expect(iosStatusLine(null).line).toBe("Not booted");
    expect(iosStatusLine({ deviceName: "iPhone 17 Pro" } as never).line).toBe("iPhone 17 Pro");
    expect(appControlStatusLine(null).line).toBe("No app");
    expect(appControlStatusLine({ label: "Zen", status: "running" } as never).line).toBe("Zen");
    expect(prStatusLine([]).line).toBe("No PR");
    expect(prStatusLine([{ githubPrNumber: 1230, checksStatus: "pending", state: "open" } as PrSummary]).line)
      .toBe("#1230 · checks");
  });

  it("keeps the fixed lines inside the one-line budget", () => {
    for (const line of ["No shells", "2 shells", "No tabs", "clean", "3 ahead · dirty", "Not booted", "No app", "No PR"]) {
      expect(line.length).toBeLessThanOrEqual(ONE_LINE_BUDGET);
    }
  });
});
