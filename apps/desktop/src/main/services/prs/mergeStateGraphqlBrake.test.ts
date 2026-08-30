import { describe, expect, it } from "vitest";

import {
  createMergeStateGraphqlBrake,
  MERGE_STATE_GRAPHQL_FALLBACK_MIN_INTERVAL_MS,
  MERGE_STATE_GRAPHQL_RATE_LIMIT_COOLDOWN_MS,
} from "./mergeStateGraphqlBrake";

const REPO = "test-owner/test-repo";
const T0 = 1_800_000_000_000;

describe("mergeStateGraphqlBrake cooldown", () => {
  it("blocks every attempt until the reset instant GitHub named", () => {
    const brake = createMergeStateGraphqlBrake();
    const resetAtMs = T0 + 42 * 60_000;

    const untilMs = brake.armRateLimitCooldown(REPO, resetAtMs, T0);

    expect(untilMs).toBe(resetAtMs);
    expect(brake.cooldown(REPO, T0 + 1)).not.toBeNull();
    expect(brake.cooldown(REPO, resetAtMs - 1)).not.toBeNull();
    expect(brake.cooldown(REPO, resetAtMs)).toBeNull();
  });

  it("floors a reset-less rate limit at five minutes", () => {
    const brake = createMergeStateGraphqlBrake();

    const untilMs = brake.armRateLimitCooldown(REPO, null, T0);

    expect(untilMs).toBe(T0 + MERGE_STATE_GRAPHQL_RATE_LIMIT_COOLDOWN_MS);
    expect(brake.cooldown(REPO, untilMs - 1)).not.toBeNull();
    expect(brake.cooldown(REPO, untilMs)).toBeNull();
  });

  it("takes the floor when GitHub's reset is nearer than five minutes", () => {
    const brake = createMergeStateGraphqlBrake();

    const untilMs = brake.armRateLimitCooldown(REPO, T0 + 30_000, T0);

    expect(untilMs).toBe(T0 + MERGE_STATE_GRAPHQL_RATE_LIMIT_COOLDOWN_MS);
  });

  it("reports one log budget per armed window, however many callers short-circuit", () => {
    // 11,202 identical warn lines for one PR is itself the defect this caps.
    const brake = createMergeStateGraphqlBrake();
    brake.armRateLimitCooldown(REPO, null, T0);

    const shouldLog: boolean[] = [];
    for (let i = 0; i < 200; i += 1) {
      shouldLog.push(brake.cooldown(REPO, T0 + i * 1_000)?.shouldLog === true);
    }

    expect(shouldLog.filter(Boolean)).toHaveLength(1);
    expect(shouldLog[0]).toBe(true);
  });

  it("does not re-open the log budget when a second rate limit lands in the same window", () => {
    const brake = createMergeStateGraphqlBrake();
    brake.armRateLimitCooldown(REPO, null, T0);
    expect(brake.cooldown(REPO, T0 + 1)?.shouldLog).toBe(true);

    brake.armRateLimitCooldown(REPO, null, T0 + 10_000);

    expect(brake.cooldown(REPO, T0 + 11_000)?.shouldLog).toBe(false);
  });

  it("never shortens a live cooldown", () => {
    const brake = createMergeStateGraphqlBrake();
    const far = T0 + 60 * 60_000;
    brake.armRateLimitCooldown(REPO, far, T0);

    expect(brake.armRateLimitCooldown(REPO, null, T0 + 1_000)).toBe(far);
  });

  it("is scoped per repo", () => {
    const brake = createMergeStateGraphqlBrake();
    brake.armRateLimitCooldown(REPO, null, T0);

    expect(brake.cooldown("other-owner/other-repo", T0 + 1)).toBeNull();
  });
});

describe("mergeStateGraphqlBrake fallback throttle", () => {
  it("allows at most one fallback per PR per five minutes", () => {
    const brake = createMergeStateGraphqlBrake();
    const prKey = `${REPO}#490`;

    expect(brake.allowFallback(prKey, T0)).toBe(true);
    // 47 iterations/min — one every 1.28s — is what the unbraked loop did.
    for (let i = 1; i * 1_280 < MERGE_STATE_GRAPHQL_FALLBACK_MIN_INTERVAL_MS; i += 1) {
      expect(brake.allowFallback(prKey, T0 + i * 1_280)).toBe(false);
    }
    expect(brake.allowFallback(prKey, T0 + MERGE_STATE_GRAPHQL_FALLBACK_MIN_INTERVAL_MS)).toBe(true);
  });

  it("throttles per PR, not per repo", () => {
    const brake = createMergeStateGraphqlBrake();

    expect(brake.allowFallback(`${REPO}#490`, T0)).toBe(true);
    expect(brake.allowFallback(`${REPO}#491`, T0)).toBe(true);
  });
});

describe("mergeStateGraphqlBrake schema memo", () => {
  it("remembers that a repo's schema has no stack field", () => {
    const brake = createMergeStateGraphqlBrake();

    expect(brake.isStackFieldUnsupported(REPO)).toBe(false);
    brake.noteStackFieldUnsupported(REPO);

    expect(brake.isStackFieldUnsupported(REPO)).toBe(true);
    expect(brake.isStackFieldUnsupported("other-owner/other-repo")).toBe(false);
  });

  it("survives clear(), because losing a credential does not change a schema", () => {
    const brake = createMergeStateGraphqlBrake();
    brake.noteStackFieldUnsupported(REPO);
    brake.armRateLimitCooldown(REPO, null, T0);

    brake.clear();

    expect(brake.cooldown(REPO, T0 + 1)).toBeNull();
    expect(brake.isStackFieldUnsupported(REPO)).toBe(true);
  });

  it("clears one repo's cooldown and fallback stamps without touching another's", () => {
    const brake = createMergeStateGraphqlBrake();
    const other = "other-owner/other-repo";
    brake.armRateLimitCooldown(REPO, null, T0);
    brake.armRateLimitCooldown(other, null, T0);
    brake.allowFallback(`${REPO}#1`, T0);
    brake.allowFallback(`${other}#1`, T0);

    brake.clear(REPO);

    expect(brake.cooldown(REPO, T0 + 1)).toBeNull();
    expect(brake.cooldown(other, T0 + 1)).not.toBeNull();
    expect(brake.allowFallback(`${REPO}#1`, T0 + 1)).toBe(true);
    expect(brake.allowFallback(`${other}#1`, T0 + 1)).toBe(false);
  });
});
