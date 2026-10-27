import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_MAX_REQUESTS_IN_FLIGHT, acquireGithubRequestSlot } from "./githubRequestGate";

describe("acquireGithubRequestSlot", () => {
  const releases: Array<() => void> = [];

  afterEach(() => {
    // Every slot taken in a test goes back, so one test cannot starve the next.
    for (const release of releases.splice(0)) release();
  });

  it("lets an aborted waiter leave the line and hands its slot to the next caller", async () => {
    const held = await Promise.all(
      Array.from({ length: GITHUB_MAX_REQUESTS_IN_FLIGHT }, () => acquireGithubRequestSlot()),
    );
    releases.push(...held);

    const controller = new AbortController();
    const aborted = acquireGithubRequestSlot(controller.signal);
    // Queued behind the caller that is about to go away.
    const next = acquireGithubRequestSlot();
    controller.abort(new Error("caller went away"));

    await expect(aborted).rejects.toThrow("caller went away");

    // The freed slot goes to the caller still waiting, not to the one that
    // left. A waiter left in the line would take that slot for an answer
    // nobody reads, and `next` would wait forever.
    held[0]!();
    const releaseNext = await next;
    releaseNext();

    // With the slot returned, a new caller is served without waiting.
    releases.push(await acquireGithubRequestSlot());
  });
});
