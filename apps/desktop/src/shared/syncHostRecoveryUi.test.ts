import { describe, expect, it } from "vitest";
import {
  nextProjectHostPhase,
  parseSyncHostReadinessSnapshot,
  projectHostBlockedReason,
  projectHostShouldTakeOverImmediately,
  readHostUnavailableDetails,
} from "./syncHostRecoveryUi";
import { SYNC_HOST_REDACTED_CONFLICT_DETAIL } from "./types/syncHostRecovery";

const conflictSnapshot = {
  state: "conflict",
  headline: "Another ADE is blocking this machine",
  body: "A development runtime is using the connection your phone needs.",
  recoveryEligible: true,
  conflict: {
    reason: "listener",
    ownerKind: "development",
    ownerLabel: "Development runtime",
    projectLabel: "improving-browser lane",
    impact: "May interrupt improving-browser lane.",
    recoveryEligible: true,
    technicalDetail: "pid: 4242",
  },
};

describe("syncHostRecoveryUi", () => {
  it("parses a conflict snapshot without exposing the pid in the body", () => {
    const snapshot = parseSyncHostReadinessSnapshot(conflictSnapshot);
    expect(snapshot?.state).toBe("conflict");
    expect(snapshot?.body).not.toMatch(/4242/);
    expect(snapshot?.conflict?.technicalDetail).toContain("pid: 4242");
    expect(projectHostShouldTakeOverImmediately(snapshot)).toBe(true);
  });

  it("retries generic starting, then takes over after retries", () => {
    const starting = parseSyncHostReadinessSnapshot({
      state: "starting",
      headline: "Starting services",
      body: "This machine is starting its project connection.",
      conflict: null,
      recoveryEligible: false,
    });
    expect(nextProjectHostPhase({ current: "ready", snapshot: starting })).toBe("retrying");
    expect(nextProjectHostPhase({
      current: "retrying",
      snapshot: starting,
      retriesExhausted: true,
    })).toBe("takeover");
  });

  it("separates an unauthorized conflict from an unidentifiable one", () => {
    expect(projectHostBlockedReason(parseSyncHostReadinessSnapshot(conflictSnapshot))).toBeNull();
    expect(projectHostBlockedReason(parseSyncHostReadinessSnapshot({
      ...conflictSnapshot,
      recoveryEligible: false,
      conflict: {
        ...conflictSnapshot.conflict,
        ownerKind: "unknown",
        ownerLabel: "Another ADE runtime",
        recoveryEligible: false,
        technicalDetail: SYNC_HOST_REDACTED_CONFLICT_DETAIL,
      },
    }))).toBe("unauthorized");
    expect(projectHostBlockedReason(parseSyncHostReadinessSnapshot({
      ...conflictSnapshot,
      recoveryEligible: false,
      conflict: { ...conflictSnapshot.conflict, recoveryEligible: false },
    }))).toBe("unidentified");
  });

  it("reads host_unavailable details off AdeSyncError-shaped objects", () => {
    expect(readHostUnavailableDetails({
      code: "host_unavailable",
      message: conflictSnapshot.body,
      details: {
        code: "host_unavailable",
        message: conflictSnapshot.body,
        reason: "conflict",
        snapshot: conflictSnapshot,
      },
    })?.reason).toBe("conflict");
  });
});
