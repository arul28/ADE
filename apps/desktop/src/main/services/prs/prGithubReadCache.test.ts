import { describe, expect, it } from "vitest";
import type { GitHubRepoRef } from "../../../shared/types";
import { createPrGithubReadCache } from "./prGithubReadCache";

const REPO: GitHubRepoRef = { owner: "acme", name: "app" };

/** A settled pull: it fingerprints the quiet reuse without hiding it. */
const PULL = {
  updated_at: "2026-01-02T00:00:00Z",
  head: { sha: "head-sha" },
  base: { sha: "base-sha" },
  mergeable: true,
  mergeable_state: "clean",
};

describe("createPrGithubReadCache quiet reuse", () => {
  it("does not keep a read that started before a write cleared its repo", async () => {
    const cache = createPrGithubReadCache(() => 1_000);
    let answer: (value: { mergeStateStatus: string }) => void = () => {};
    const loaded = new Promise<{ mergeStateStatus: string }>((resolve) => {
      answer = resolve;
    });
    const inFlight = cache.whileQuiet(REPO, "merge:42", PULL, () => loaded);

    // A write lands while GitHub is still answering a read that began before it.
    cache.forgetRepo(REPO);
    answer({ mergeStateStatus: "STALE" });
    // The read that was already on the wire still answers its caller.
    await expect(inFlight).resolves.toEqual({ mergeStateStatus: "STALE" });

    // ...but its pre-write answer must not be kept: the next read asks GitHub.
    let loads = 0;
    const fresh = await cache.whileQuiet(REPO, "merge:42", PULL, async () => {
      loads += 1;
      return { mergeStateStatus: "FRESH" };
    });
    expect(loads).toBe(1);
    expect(fresh).toEqual({ mergeStateStatus: "FRESH" });
  });
});
