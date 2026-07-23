import { describe, expect, it } from "vitest";
import {
  PUBLISH_FAILING_ALARM_MS,
  describePublishHealth,
  type LocalPublishHealth,
} from "./remoteMachineModel";

const NOW = 1_700_000_000_000;

function health(overrides: Partial<LocalPublishHealth>): LocalPublishHealth {
  return { state: "published", failingSinceMs: null, ...overrides };
}

describe("describePublishHealth", () => {
  it("reports none when there is no publish health", () => {
    expect(describePublishHealth(null, NOW)).toEqual({ kind: "none" });
    expect(describePublishHealth(undefined, NOW)).toEqual({ kind: "none" });
  });

  it("reports healthy when routes are published", () => {
    expect(describePublishHealth(health({ state: "published" }), NOW)).toEqual({
      kind: "healthy",
    });
  });

  it("stays silent for non-publishing states", () => {
    for (const state of [
      "sync_disabled",
      "no_active_sync_scope",
      "not_host",
      "account_signed_out",
      "machine_key_unavailable",
      "missing_pairing_connect_info",
    ] as const) {
      expect(
        describePublishHealth(health({ state, failingSinceMs: NOW - 60 * 60_000 }), NOW),
      ).toEqual({ kind: "none" });
    }
  });

  it("does not alarm on a failure without a start time", () => {
    expect(
      describePublishHealth(health({ state: "http_error", failingSinceMs: null }), NOW),
    ).toEqual({ kind: "none" });
  });

  it("does not alarm before the failure has persisted two minutes", () => {
    const failingSinceMs = NOW - (PUBLISH_FAILING_ALARM_MS - 1);
    expect(
      describePublishHealth(health({ state: "timeout", failingSinceMs }), NOW),
    ).toEqual({ kind: "none" });
  });

  it("alarms once a failure has persisted at least two minutes", () => {
    const failingSinceMs = NOW - 12 * 60_000;
    expect(
      describePublishHealth(health({ state: "transport_error", failingSinceMs }), NOW),
    ).toEqual({ kind: "failing", minutes: 12 });
  });

  it("floors the failing minutes", () => {
    const failingSinceMs = NOW - (5 * 60_000 + 59_000);
    expect(
      describePublishHealth(health({ state: "http_timeout", failingSinceMs }), NOW),
    ).toEqual({ kind: "failing", minutes: 5 });
  });
});
