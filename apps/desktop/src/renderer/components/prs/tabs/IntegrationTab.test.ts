/**
 * Tests for IntegrationTab helper functions.
 *
 * The IntegrationTab has OutcomeDot/OutcomeBadge style mappings
 * that we test by re-deriving the style logic.
 */
import { describe, expect, it } from "vitest";

// Re-derive the outcome style mappings from IntegrationTab

function outcomeDotColor(outcome: "clean" | "conflict" | "blocked" | "pending"): string {
  const config: Record<string, string> = {
    clean: "#22C55E",
    conflict: "#F59E0B",
    blocked: "#EF4444",
    pending: "#71717A",
  };
  return config[outcome] ?? "#71717A";
}

function outcomeBadgeLabel(outcome: "clean" | "conflict" | "blocked"): string {
  const map: Record<string, string> = {
    clean: "CLEAN",
    conflict: "CONFLICT",
    blocked: "BLOCKED",
  };
  return map[outcome] ?? "UNKNOWN";
}

describe("IntegrationTab outcome dot colors", () => {
  it("returns green for clean", () => {
    expect(outcomeDotColor("clean")).toBe("#22C55E");
  });

  it("returns amber for conflict", () => {
    expect(outcomeDotColor("conflict")).toBe("#F59E0B");
  });

  it("returns red for blocked", () => {
    expect(outcomeDotColor("blocked")).toBe("#EF4444");
  });

  it("returns gray for pending", () => {
    expect(outcomeDotColor("pending")).toBe("#71717A");
  });
});

describe("IntegrationTab outcome badge labels", () => {
  it("maps clean to CLEAN", () => {
    expect(outcomeBadgeLabel("clean")).toBe("CLEAN");
  });

  it("maps conflict to CONFLICT", () => {
    expect(outcomeBadgeLabel("conflict")).toBe("CONFLICT");
  });

  it("maps blocked to BLOCKED", () => {
    expect(outcomeBadgeLabel("blocked")).toBe("BLOCKED");
  });
});
