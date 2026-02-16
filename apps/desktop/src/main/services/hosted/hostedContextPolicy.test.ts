import { describe, expect, it } from "vitest";
import { buildInlineFallbackParams, decideHostedContextDelivery, estimateUtf8Bytes, stableJsonStringify } from "./hostedContextPolicy";

describe("hostedContextPolicy", () => {
  it("decides inline for small narrative payloads in auto mode", () => {
    const json = stableJsonStringify({ packBody: "hello" });
    const decision = decideHostedContextDelivery({
      mode: "auto",
      jobType: "NarrativeGeneration",
      estimatedBytes: estimateUtf8Bytes(json)
    });
    expect(decision.mode).toBe("inline");
  });

  it("forces mirror for conflict jobs even when policy mode is inline", () => {
    const json = stableJsonStringify({ laneExportLite: "x".repeat(2000), files: [] });
    const decision = decideHostedContextDelivery({
      mode: "inline",
      jobType: "ProposeConflictResolution",
      estimatedBytes: estimateUtf8Bytes(json)
    });
    expect(decision.mode).toBe("mirror");
    expect(decision.reasonCode).toContain("AUTO_MIRROR");
  });

  it("forces mirror when mode is mirror_preferred", () => {
    const json = stableJsonStringify({ any: "thing" });
    const decision = decideHostedContextDelivery({
      mode: "mirror_preferred",
      jobType: "NarrativeGeneration",
      estimatedBytes: estimateUtf8Bytes(json)
    });
    expect(decision.mode).toBe("mirror");
  });

  it("uses mirror when payload is over auto threshold", () => {
    const json = stableJsonStringify({ payload: "x".repeat(80_000) });
    const decision = decideHostedContextDelivery({
      mode: "auto",
      jobType: "NarrativeGeneration",
      estimatedBytes: estimateUtf8Bytes(json)
    });
    expect(decision.mode).toBe("mirror");
    expect(decision.reasonCode).toBe("AUTO_MIRROR_PARAMS_LARGE");
  });

  it("uses mirror when staleness policy is exceeded in auto mode", () => {
    const json = stableJsonStringify({ small: true });
    const decision = decideHostedContextDelivery({
      mode: "auto",
      jobType: "NarrativeGeneration",
      estimatedBytes: estimateUtf8Bytes(json),
      mirrorLastSuccessAt: "2001-01-01T00:00:00.000Z",
      policyTtlMs: 1_000
    });
    expect(decision.mode).toBe("mirror");
    expect(decision.reasonCode).toBe("POLICY_STALE_CONTEXT_REQUIRED");
  });

  it("builds a compact inline fallback for large params", () => {
    const huge = {
      laneId: "lane-1",
      blob: "x".repeat(200_000),
      files: Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.ts`, diff: "y".repeat(8000) }))
    };
    const res = buildInlineFallbackParams({ params: huge, maxBytes: 12_000 });
    const bytes = estimateUtf8Bytes(stableJsonStringify(res.fallback));
    expect(bytes).toBeLessThanOrEqual(12_000);
    expect(res.approxOriginalBytes).toBeGreaterThan(res.approxBytes);
    expect(res.clipReasonTags.length).toBeGreaterThan(0);
  });

  it("falls back to tiny envelope when params cannot fit inline budget", () => {
    const huge = {
      laneId: "lane-1",
      blob: "x".repeat(500_000),
      files: Array.from({ length: 500 }, (_, i) => ({ path: `f${i}.ts`, diff: "y".repeat(9000) }))
    };
    const res = buildInlineFallbackParams({ params: huge, maxBytes: 1_200 });
    expect(res.clipReasonTags).toContain("clipped:envelope");
    expect(JSON.stringify(res.fallback)).toContain("Inline fallback clipped aggressively");
  });
});
