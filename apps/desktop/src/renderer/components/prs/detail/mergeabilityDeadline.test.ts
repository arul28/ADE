import { describe, expect, it } from "vitest";

import {
  MERGEABILITY_POLL_WINDOW_MS,
  resolveMergeabilityDeadline,
} from "./mergeabilityDeadline";

describe("resolveMergeabilityDeadline", () => {
  it("mints a fresh deadline when there is no carried value", () => {
    const resolved = resolveMergeabilityDeadline(null, "pr-1", 1_000);
    expect(resolved).toEqual({ prId: "pr-1", deadlineAtMs: 1_000 + MERGEABILITY_POLL_WINDOW_MS });
  });

  it("carries the deadline across re-runs for the same PR (governor generation churn)", () => {
    const first = resolveMergeabilityDeadline(null, "pr-1", 1_000);
    // Re-runs seconds later — e.g. the governor generation changed — must not
    // extend the ceiling, or an outage keeps the 2.5s loop alive forever.
    const second = resolveMergeabilityDeadline(first, "pr-1", 31_000);
    const third = resolveMergeabilityDeadline(second, "pr-1", 59_999);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("keeps carrying an already-expired deadline for the same PR", () => {
    const first = resolveMergeabilityDeadline(null, "pr-1", 1_000);
    const afterExpiry = resolveMergeabilityDeadline(first, "pr-1", 1_000 + MERGEABILITY_POLL_WINDOW_MS + 5_000);
    expect(afterExpiry).toBe(first);
  });

  it("re-mints when the polled PR changes", () => {
    const first = resolveMergeabilityDeadline(null, "pr-1", 1_000);
    const other = resolveMergeabilityDeadline(first, "pr-2", 40_000);
    expect(other).toEqual({ prId: "pr-2", deadlineAtMs: 40_000 + MERGEABILITY_POLL_WINDOW_MS });
  });
});
