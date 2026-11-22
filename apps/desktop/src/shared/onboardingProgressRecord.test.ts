import { describe, expect, it } from "vitest";
import {
  mergeOnboardingProgressRecords,
  normalizeOnboardingProgressRecord,
  sameOnboardingProgressRecord,
  type OnboardingProgressRecord,
} from "./onboardingProgressRecord";

/**
 * The account's onboarding record is merged from every computer and ADE Web.
 * A wrong merge brings a finished tour back on every device, or loses a
 * "Show me around again".
 */

const NOW = Date.UTC(2026, 10, 18, 12);
const at = (hours: number) => NOW - 48 * 3_600_000 + hours * 3_600_000;

describe("onboarding progress record", () => {
  it("merges copies forward only, a reset drops every older answer, and only valid remote values count", () => {
    const laptop: OnboardingProgressRecord = {
      startedAt: at(1),
      tourDoneAt: at(3),
      hints: { "needs-you": { doneAt: at(2) } },
      tipsDone: ["cto", "share-lane"],
      lastUnaskedAt: at(4),
    };
    const web: OnboardingProgressRecord = {
      startedAt: at(2),
      skippedAt: at(5),
      hints: { "needs-you": { dismissedAt: at(6) } },
      tipsDone: ["share-lane", "ade-cloud"],
      lastUnaskedAt: at(7),
    };

    // Forward only: the earlier start, the later answers, every tip; the same either way round.
    const merged = mergeOnboardingProgressRecords(laptop, web);
    expect(merged).toEqual({
      startedAt: at(1),
      skippedAt: at(5),
      tourDoneAt: at(3),
      hints: { "needs-you": { doneAt: at(2), dismissedAt: at(6) } },
      tipsDone: ["cto", "share-lane", "ade-cloud"],
      lastUnaskedAt: at(7),
    });
    expect(sameOnboardingProgressRecord(merged, mergeOnboardingProgressRecords(web, laptop))).toBe(true);
    // A copy that already holds everything needs no write.
    expect(sameOnboardingProgressRecord(mergeOnboardingProgressRecords(merged, laptop), merged)).toBe(true);

    // "Show me around again" on the phone at hour 8, then a new start there.
    const reset: OnboardingProgressRecord = { resetAt: at(8), startedAt: at(8) };
    const afterReset = mergeOnboardingProgressRecords(merged, reset);
    // The finished tour, the skip and the hint answers from before it no longer count; tips and the budget stay.
    expect(afterReset).toEqual({
      resetAt: at(8),
      startedAt: at(8),
      tipsDone: ["cto", "share-lane", "ade-cloud"],
      lastUnaskedAt: at(7),
    });
    // An old copy merged in later cannot bring the finished tour back.
    expect(mergeOnboardingProgressRecords(laptop, afterReset)).toMatchObject({ resetAt: at(8), startedAt: at(8) });
    expect(mergeOnboardingProgressRecords(laptop, afterReset).tourDoneAt).toBeUndefined();

    // A remote value is taken only in its valid part.
    expect(normalizeOnboardingProgressRecord(null, NOW)).toEqual({});
    expect(normalizeOnboardingProgressRecord("tour done", NOW)).toEqual({});
    expect(normalizeOnboardingProgressRecord({
      // Before ADE had onboarding, and far in the future: neither would ever move again.
      startedAt: Date.UTC(2020, 0, 1),
      tourDoneAt: NOW + 30 * 24 * 3_600_000,
      skippedAt: "yesterday",
      lastUnaskedAt: at(1),
      hints: { "": { doneAt: at(1) }, "needs-you": { doneAt: "soon" }, ok: { dismissedAt: at(2) } },
      tipsDone: ["cto", 7, "cto", ""],
    }, NOW)).toEqual({
      lastUnaskedAt: at(1),
      hints: { ok: { dismissedAt: at(2) } },
      tipsDone: ["cto"],
    });
  });
});
