import { describe, expect, it, vi } from "vitest";
import { sanitizeProductAnalyticsProperties } from "./productAnalyticsPolicy";
import {
  captureNewLaneLaunchAnalytics,
  captureSessionImportAnalytics,
  providerAccountAnalyticsCapture,
  coarseProviderFamily,
  type FeatureAnalytics,
} from "./featureProductAnalytics";

function recorder(): { analytics: FeatureAnalytics; captured: Array<Record<string, unknown>> } {
  const captured: Array<Record<string, unknown>> = [];
  return {
    captured,
    analytics: { captureInternal: vi.fn((input) => { captured.push(input as Record<string, unknown>); }) },
  };
}

/**
 * The Accounts panel talks to the provider-instance store over local IPC, not
 * through the ADE actions domain. When only the actions domain captured, the
 * primary UI entry point was invisible in the funnel: every desktop click
 * looked like it never happened. Both paths must capture, each under its own
 * surface, and neither may capture twice for one call.
 */
describe("providerAccountAnalyticsCapture", () => {
  it("captures exactly once per call under the bound surface", () => {
    const { analytics, captured } = recorder();
    const capture = providerAccountAnalyticsCapture(analytics, "desktop");
    capture("account_created", "completed", "codex");
    capture("balance_changed", "enabled", "claude");
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      event: "ade_feature_used",
      surface: "desktop",
      properties: { feature: "provider_accounts", action: "account_created", outcome: "completed" },
    });
    expect(captured[1]).toMatchObject({
      surface: "desktop",
      properties: { action: "balance_changed", outcome: "enabled" },
    });
  });

  it("keeps the actions domain on its own surface", () => {
    const { analytics, captured } = recorder();
    providerAccountAnalyticsCapture(analytics, "api")("default_selected", "completed", "codex");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ surface: "api" });
  });

  it("coarsens the provider and never carries an account label", () => {
    const { analytics, captured } = recorder();
    providerAccountAnalyticsCapture(analytics, "desktop")(
      "account_removed",
      "completed",
      "Work (EU) \u00b7 anthropic",
    );
    expect((captured[0] as { properties: Record<string, unknown> }).properties.provider).toBe("other");
    expect(JSON.stringify(captured[0])).not.toContain("Work (EU)");
    expect(coarseProviderFamily("anthropic")).toBe("claude");
  });

  it("is safe when analytics is not configured", () => {
    const capture = providerAccountAnalyticsCapture(null, "desktop");
    expect(() => capture("auto_start_changed", "disabled", "codex")).not.toThrow();
  });
});

describe("captureNewLaneLaunchAnalytics", () => {
  it("records one coarse outcome per new-lane launch, deduped per outcome and provider family", () => {
    const { analytics, captured } = recorder();
    captureNewLaneLaunchAnalytics({ analytics, surface: "api", outcome: "cancelled", provider: "codex" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      event: "ade_feature_used",
      surface: "api",
      dedupeKey: "feature:chat:new_lane_launch:cancelled:codex",
      properties: { feature: "chat", action: "new_lane_launch", outcome: "cancelled", provider: "codex" },
    });
    // The allowlist keeps every value: nothing is silently dropped at the boundary.
    const sanitized = sanitizeProductAnalyticsProperties("ade_feature_used", (captured[0] as { properties: Record<string, unknown> }).properties as never);
    expect(sanitized).toMatchObject({ feature: "chat", action: "new_lane_launch", outcome: "cancelled", provider: "codex" });
  });
});

describe("captureSessionImportAnalytics", () => {
  it("records how an external session came in, with only closed values that survive the allowlist", () => {
    const { analytics, captured } = recorder();
    captureSessionImportAnalytics({ analytics, surface: "desktop", target: "chat", mode: "resume", outcome: "completed", provider: "claude" });
    captureSessionImportAnalytics({ analytics, surface: "api", target: "cli", mode: "fork", outcome: "failed", provider: "copilot" });
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      event: "ade_feature_used",
      surface: "desktop",
      dedupeKey: "feature:work:session_continue_chat:completed:claude",
      properties: { feature: "work", action: "session_continue_chat", outcome: "completed", provider: "claude" },
    });
    // An ACP provider has no family of its own: it is reported as "other".
    expect(captured[1]).toMatchObject({
      properties: { feature: "work", action: "session_copy_cli", outcome: "failed", provider: "other" },
    });
    for (const entry of captured) {
      const properties = (entry as { properties: Record<string, unknown> }).properties;
      expect(sanitizeProductAnalyticsProperties("ade_feature_used", properties as never)).toEqual(properties);
    }
  });
});
