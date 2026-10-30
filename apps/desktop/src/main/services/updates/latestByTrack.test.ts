import { describe, expect, it } from "vitest";
import { BETA_FEED_MANIFEST_URL, LATEST_STABLE_MANIFEST_URL } from "../../../shared/updateTrack";
import { createLatestByTrackReader } from "./latestByTrack";

/**
 * The newest build of each track feeds what every other machine is offered
 * ("Update" on General and in the restart dialog). A read that goes wrong must
 * never take a known build away or put a build of the wrong track in its place.
 */
describe("createLatestByTrackReader", () => {
  it("keeps the last good build per track through failed, missing and wrong-track reads", async () => {
    let now = 0;
    // The network boundary: each read answers what the step below sets.
    let answers: Record<string, unknown | Error | null> = {};
    let stableFallback: string | null = null;
    const warnings: string[] = [];
    const reader = createLatestByTrackReader({
      fetchJson: async (url) => {
        const answer = answers[url];
        if (answer instanceof Error) throw answer;
        return answer ?? null;
      },
      fetchStableFallback: async () => stableFallback,
      logger: { warn: (event) => warnings.push(event) },
      minIntervalMs: 1_000,
      nowMs: () => now,
    });
    expect(reader.current()).toEqual({ stable: null, beta: null });

    // Both feeds answer.
    answers = {
      [LATEST_STABLE_MANIFEST_URL]: { version: "v1.2.127" },
      [BETA_FEED_MANIFEST_URL]: { version: "1.2.128-beta.2" },
    };
    expect(await reader.refresh()).toEqual({ stable: "1.2.127", beta: "1.2.128-beta.2" });

    // Offline, and the Beta feed is gone (404): nothing known is taken away.
    now += 2_000;
    answers = { [LATEST_STABLE_MANIFEST_URL]: new Error("getaddrinfo ENOTFOUND github.com") };
    expect(await reader.refresh()).toEqual({ stable: "1.2.127", beta: "1.2.128-beta.2" });
    expect(warnings).toEqual(["autoUpdate.latest_by_track_read_failed"]);

    // Each feed names a build of the other track: neither is believed.
    now += 2_000;
    answers = {
      [LATEST_STABLE_MANIFEST_URL]: { version: "1.2.129-beta.1" },
      [BETA_FEED_MANIFEST_URL]: { version: "1.2.129" },
    };
    expect(await reader.refresh()).toEqual({ stable: "1.2.127", beta: "1.2.128-beta.2" });

    // A Stable release older than the manifest asset (404) is read from the
    // release feed instead; a newer Beta replaces the old one.
    now += 2_000;
    stableFallback = "1.2.128";
    answers = { [BETA_FEED_MANIFEST_URL]: { version: "1.2.129-beta.3" } };
    expect(await reader.refresh()).toEqual({ stable: "1.2.128", beta: "1.2.129-beta.3" });
    expect(reader.current()).toEqual({ stable: "1.2.128", beta: "1.2.129-beta.3" });
  });
});
