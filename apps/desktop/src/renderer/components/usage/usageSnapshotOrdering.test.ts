import { describe, expect, it } from "vitest";
import type { UsageProviderStatus, UsageSnapshot } from "../../../shared/types";
import { shouldApplyUsageSnapshot } from "./usageSnapshotOrdering";

function providerStatus(updatedAt: string): UsageProviderStatus {
  return { state: "ok", lastSuccessAt: updatedAt, updatedAt };
}

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    windows: [],
    pacing: {
      status: "on-track",
      projectedWeeklyPercent: 0,
      weekElapsedPercent: 0,
      expectedPercent: 0,
      deltaPercent: 0,
      etaHours: null,
      willLastToReset: true,
      resetsInHours: 0,
    },
    costs: [],
    extraUsage: [],
    lastPolledAt: "2026-05-21T12:00:00.000Z",
    errors: [],
    ...overrides,
  };
}

describe("shouldApplyUsageSnapshot", () => {
  it("never applies a missing snapshot", () => {
    expect(shouldApplyUsageSnapshot(null, snapshot())).toBe(false);
    expect(shouldApplyUsageSnapshot(null, null)).toBe(false);
  });

  it("applies anything when nothing is on screen yet", () => {
    expect(shouldApplyUsageSnapshot(snapshot(), null)).toBe(true);
  });

  describe("both sides stamped", () => {
    it("advances within one producer", () => {
      const current = snapshot({ revision: { producerId: "brain-a", seq: 4 } });
      const next = snapshot({ revision: { producerId: "brain-a", seq: 5 } });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(true);
    });

    it("accepts a re-emitted snapshot at the same seq", () => {
      const current = snapshot({ revision: { producerId: "brain-a", seq: 4 } });
      const next = snapshot({ revision: { producerId: "brain-a", seq: 4 } });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(true);
    });

    it("rejects a lower seq from the same producer", () => {
      const current = snapshot({ revision: { producerId: "brain-a", seq: 9 } });
      const next = snapshot({ revision: { producerId: "brain-a", seq: 8 } });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(false);
    });

    it("always accepts a different producer, whatever its seq", () => {
      const current = snapshot({ revision: { producerId: "brain-a", seq: 900 } });
      const next = snapshot({ revision: { producerId: "remote-b", seq: 1 } });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(true);
    });

    /**
     * The concrete two-window failure. A local-clock snapshot stamped ahead of
     * the remote producer's clock used to latch the window: both remote
     * snapshots afterwards compared "older" and were dropped, so this window
     * sat on stale numbers while its sibling moved on.
     */
    it("accepts both remote snapshots after a future-stamped local one", () => {
      const local = snapshot({
        lastPolledAt: "2026-05-21T12:00:30.000Z",
        revision: { producerId: "local-main", seq: 3 },
      });
      const remoteEarly = snapshot({
        lastPolledAt: "2026-05-21T12:00:10.000Z",
        revision: { producerId: "remote-host", seq: 1 },
      });
      const remoteLate = snapshot({
        lastPolledAt: "2026-05-21T12:02:10.000Z",
        revision: { producerId: "remote-host", seq: 2 },
      });

      expect(shouldApplyUsageSnapshot(remoteEarly, local)).toBe(true);
      expect(shouldApplyUsageSnapshot(remoteLate, remoteEarly)).toBe(true);
    });
  });

  describe("one side stamped", () => {
    it("lets a stamped push replace an unstamped cache", () => {
      const current = snapshot({ lastPolledAt: "2026-05-21T23:00:00.000Z" });
      const next = snapshot({
        lastPolledAt: "2026-05-21T12:00:00.000Z",
        revision: { producerId: "brain-a", seq: 1 },
      });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(true);
    });

    it("rejects an unstamped cache once a stamped snapshot is on screen", () => {
      const current = snapshot({ revision: { producerId: "brain-a", seq: 7 } });
      const next = snapshot({ lastPolledAt: "2026-05-20T12:00:00.000Z" });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(false);
    });
  });

  describe("neither side stamped (legacy cache)", () => {
    it("applies a newer poll", () => {
      const current = snapshot({ lastPolledAt: "2026-05-21T12:00:00.000Z" });
      const next = snapshot({ lastPolledAt: "2026-05-21T12:05:00.000Z" });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(true);
    });

    it("applies an equal poll", () => {
      const current = snapshot({ lastPolledAt: "2026-05-21T12:00:00.000Z" });
      const next = snapshot({ lastPolledAt: "2026-05-21T12:00:00.000Z" });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(true);
    });

    it("rejects an older poll with nothing else moving", () => {
      const current = snapshot({ lastPolledAt: "2026-05-21T12:05:00.000Z" });
      const next = snapshot({ lastPolledAt: "2026-05-21T12:00:00.000Z" });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(false);
    });

    it("accepts an unparsable next stamp instead of freezing the meters", () => {
      const current = snapshot({ lastPolledAt: "2026-05-21T12:05:00.000Z" });
      const next = snapshot({ lastPolledAt: "not-a-date" });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(true);
    });

    it("accepts anything once the current stamp is unparsable", () => {
      const current = snapshot({ lastPolledAt: "not-a-date" });
      const next = snapshot({ lastPolledAt: "2026-05-21T12:00:00.000Z" });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(true);
    });

    it("accepts an older poll whose cost scan advanced", () => {
      const current = snapshot({
        lastPolledAt: "2026-05-21T12:05:00.000Z",
        costsLastPolledAt: "2026-05-21T11:00:00.000Z",
      });
      const next = snapshot({
        lastPolledAt: "2026-05-21T12:00:00.000Z",
        costsLastPolledAt: "2026-05-21T12:00:00.000Z",
      });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(true);
    });

    it("accepts an older poll that gained a cost scan the current one never had", () => {
      const current = snapshot({ lastPolledAt: "2026-05-21T12:05:00.000Z" });
      const next = snapshot({
        lastPolledAt: "2026-05-21T12:00:00.000Z",
        costsLastPolledAt: "2026-05-21T12:00:00.000Z",
      });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(true);
    });

    it("rejects an older poll whose cost scan did not move", () => {
      const current = snapshot({
        lastPolledAt: "2026-05-21T12:05:00.000Z",
        costsLastPolledAt: "2026-05-21T12:00:00.000Z",
      });
      const next = snapshot({
        lastPolledAt: "2026-05-21T12:00:00.000Z",
        costsLastPolledAt: "2026-05-21T12:00:00.000Z",
      });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(false);
    });

    it("accepts an older poll whose provider status advanced", () => {
      const current = snapshot({
        lastPolledAt: "2026-05-21T12:05:00.000Z",
        providerStatus: { claude: providerStatus("2026-05-21T11:00:00.000Z") },
      });
      const next = snapshot({
        lastPolledAt: "2026-05-21T12:00:00.000Z",
        providerStatus: {
          claude: providerStatus("2026-05-21T11:00:00.000Z"),
          codex: providerStatus("2026-05-21T12:04:00.000Z"),
        },
      });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(true);
    });

    it("rejects an older poll whose provider status is unchanged", () => {
      const status = { claude: providerStatus("2026-05-21T11:00:00.000Z") };
      const current = snapshot({ lastPolledAt: "2026-05-21T12:05:00.000Z", providerStatus: status });
      const next = snapshot({ lastPolledAt: "2026-05-21T12:00:00.000Z", providerStatus: status });
      expect(shouldApplyUsageSnapshot(next, current)).toBe(false);
    });
  });
});
