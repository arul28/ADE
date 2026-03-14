import { describe, expect, it } from "vitest";
import { shouldShowDelegationOverride } from "./LinearSyncPanel";

describe("LinearSyncPanel", () => {
  it("shows delegation overrides for queue states that still need manual routing or recovery", () => {
    expect(shouldShowDelegationOverride("queued")).toBe(true);
    expect(shouldShowDelegationOverride("retry_wait")).toBe(true);
    expect(shouldShowDelegationOverride("escalated")).toBe(true);
    expect(shouldShowDelegationOverride("dispatched")).toBe(false);
    expect(shouldShowDelegationOverride("failed")).toBe(false);
    expect(shouldShowDelegationOverride("resolved")).toBe(false);
    expect(shouldShowDelegationOverride("cancelled")).toBe(false);
  });
});
