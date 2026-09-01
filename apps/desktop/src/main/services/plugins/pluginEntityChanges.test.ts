import { describe, expect, it } from "vitest";

import { prTransitionsFromChanges } from "./pluginEntityChanges";

/**
 * The producer half of `pr.changed`'s transitions.
 *
 * `pr.changed` used to be ids and nothing else, so "this PR just merged" — the
 * trigger behind every PR→Done rule — could only be recovered by reading each
 * named PR back and comparing it against whatever the consumer last remembered.
 * The poll already holds the previous state, so it says so.
 */
describe("prTransitionsFromChanges", () => {
  it("reports a merge as from-not-merged to-merged", () => {
    expect(prTransitionsFromChanges([
      { pr: { id: "pr-1", state: "merged" }, previousState: "open" },
    ])).toEqual([{
      id: "pr-1",
      from: { state: "open", merged: false },
      to: { state: "merged", merged: true },
    }]);
  });

  it("reports a PR that was ALREADY merged as merged on both sides", () => {
    // Not filtered out here. The producer's job is to say what moved, and
    // deciding that a re-poll of an already-merged PR is not a merge is the
    // consumer's — it is the same `previousState !== "merged"` test core makes,
    // and putting it here would leave a consumer unable to see the difference.
    expect(prTransitionsFromChanges([
      { pr: { id: "pr-1", state: "merged" }, previousState: "merged" },
    ])[0]).toEqual({
      id: "pr-1",
      from: { state: "merged", merged: true },
      to: { state: "merged", merged: true },
    });
  });

  it("drops a change whose previous state the poller never saw", () => {
    // The first tick after a restart, and the tick that discovers a PR. Filling
    // `from` with the current state would read as "it did not move" and would
    // suppress exactly the merge a plugin is waiting for.
    expect(prTransitionsFromChanges([
      { pr: { id: "pr-1", state: "merged" }, previousState: null },
    ])).toEqual([]);
  });

  it("keeps the changes that have history when only some do", () => {
    expect(prTransitionsFromChanges([
      { pr: { id: "pr-1", state: "merged" }, previousState: null },
      { pr: { id: "pr-2", state: "merged" }, previousState: "open" },
    ]).map((transition) => transition.id)).toEqual(["pr-2"]);
  });

  it("carries a non-merge transition too, so a consumer can watch any state", () => {
    expect(prTransitionsFromChanges([
      { pr: { id: "pr-1", state: "closed" }, previousState: "open" },
    ])).toEqual([{
      id: "pr-1",
      from: { state: "open", merged: false },
      to: { state: "closed", merged: false },
    }]);
  });

  it("drops a change with no id rather than emitting an unaddressable transition", () => {
    expect(prTransitionsFromChanges([
      { pr: { id: "   ", state: "merged" }, previousState: "open" },
    ])).toEqual([]);
  });
});
