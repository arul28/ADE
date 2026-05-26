import { describe, expect, it } from "vitest";
import { shouldHydrateCommitShaFromUrl } from "./historyUrlHydration";

/**
 * Documents History URL hydration ordering: setFocusLaneId clears commit selection,
 * so commitSha must be applied after lane focus is settled (not followed by another setFocusLaneId).
 */
describe("history URL hydration ordering", () => {
  it("applies commitSha after lane focus without clearing it again", () => {
    type State = {
      focusLaneId: string | null;
      selectedCommitSha: string | null;
    };

    const setFocusLaneId = (state: State, laneId: string | null): State => ({
      focusLaneId: laneId,
      selectedCommitSha: null,
    });
    const setSelectedCommitSha = (state: State, sha: string): State => ({
      ...state,
      selectedCommitSha: sha,
    });

    let state: State = { focusLaneId: "lane-a", selectedCommitSha: null };
    const laneFromUrl = "lane-a";
    const commitSha = "abc123";

    if (laneFromUrl && state.focusLaneId !== laneFromUrl) {
      state = setFocusLaneId(state, laneFromUrl);
    }
    if (commitSha) {
      state = setSelectedCommitSha(state, commitSha);
    }

    expect(state.focusLaneId).toBe("lane-a");
    expect(state.selectedCommitSha).toBe("abc123");

    // Buggy path: set commit then unconditionally refocus lane.
    state = setSelectedCommitSha(state, commitSha);
    state = setFocusLaneId(state, laneFromUrl);
    expect(state.selectedCommitSha).toBeNull();
  });

  it("reapplies commitSha when the URL lane becomes known after initial lane load", () => {
    const commitSha = "abc123";

    expect(
      shouldHydrateCommitShaFromUrl({
        commitSha,
        requestedSurface: "commits",
        selectedCommitSha: commitSha,
        focusLaneChanged: true,
      }),
    ).toBe(true);
  });
});
