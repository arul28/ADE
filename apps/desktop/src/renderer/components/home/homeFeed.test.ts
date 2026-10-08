import { describe, expect, it } from "vitest";
import { groupFeed, mergeFeed, type HomeFeedEvent } from "./homeFeed";

function event(id: string, at: number, title = id): HomeFeedEvent {
  return { id, kind: "pr_merged", at, title, detail: null, project: null, target: { kind: "prs" } };
}

describe("home feed", () => {
  it("keeps one row per event, the first source's copy, newest first", () => {
    const activity = [event("pr:1", 300, "From Activity"), event("chat:2", 100)];
    const snapshot = [event("pr:1", 300, "From the PR snapshot"), event("pr:3", 200)];

    const merged = mergeFeed(activity, snapshot);

    expect(merged.map((entry) => entry.id)).toEqual(["pr:1", "pr:3", "chat:2"]);
    expect(merged[0]!.title).toBe("From Activity");
  });

  it("groups by local day into Today, Yesterday and the rest of the week, and drops older events", () => {
    const now = new Date(2026, 9, 8, 9, 30).getTime();
    const at = (daysAgo: number, hour: number) => new Date(2026, 9, 8 - daysAgo, hour, 0).getTime();
    const events = [
      event("today-early", at(0, 0)),
      event("yesterday-late", at(1, 23)),
      event("six-days", at(6, 1)),
      event("seven-days", at(7, 23)),
    ];

    const groups = groupFeed(events, now);

    expect(groups.map((group) => [group.id, group.events.map((entry) => entry.id)])).toEqual([
      ["today", ["today-early"]],
      ["yesterday", ["yesterday-late"]],
      ["week", ["six-days"]],
    ]);
    expect(groupFeed([event("old", at(9, 12))], now)).toEqual([]);
  });
});
