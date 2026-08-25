import { describe, expect, it } from "vitest";
import {
  adeCardDeeplink,
  adeCardFallbackText,
  adeCardFingerprint,
  adeCardProgressTotal,
  adeCardRowKey,
  describeAdeCard,
  adeCardIsHiddenAfterDismiss,
  isKnownAdeCardVariant,
  normalizeAdeCardTone,
  readAdeCardPluginInstall,
  type AdeCardPayload,
} from "./adeCard";

function card(over: Partial<AdeCardPayload> = {}): AdeCardPayload {
  return {
    cardId: "run-42",
    variant: "proof_artifact",
    state: "terminal",
    title: "Cloud artifacts pulled",
    fallbackText: "3 cloud artifacts pulled into the lane",
    ...over,
  };
}

describe("adeCard", () => {
  it("folds every red-ish tone onto warning — there is no danger tone", () => {
    for (const red of ["danger", "error", "failed", "fail", "red", "DANGER"]) {
      expect(normalizeAdeCardTone(red)).toBe("warning");
    }
    expect(normalizeAdeCardTone("success")).toBe("success");
    expect(normalizeAdeCardTone("accent")).toBe("accent");
    expect(normalizeAdeCardTone(undefined)).toBe("neutral");
    expect(normalizeAdeCardTone("something new")).toBe("neutral");
  });

  it("hides a dismissed Claude session-quota card on every surface", () => {
    expect(adeCardIsHiddenAfterDismiss(card({
      variant: "claude_session_quota",
      state: "terminal",
    }))).toBe(true);
    expect(adeCardIsHiddenAfterDismiss(card({
      variant: "claude_session_quota",
      state: "terminal",
      actions: [{ id: "fork-local", label: "Fork in this lane", kind: "primary" }],
    }))).toBe(true);
    expect(adeCardIsHiddenAfterDismiss(card({
      variant: "claude_session_quota",
      state: "live",
      actions: [{ id: "fork-local", label: "Fork in this lane", kind: "primary" }],
    }))).toBe(false);
    expect(adeCardIsHiddenAfterDismiss(card({
      variant: "pr_ci",
      state: "terminal",
    }))).toBe(false);
  });

  it("treats only shipped variants as known", () => {
    for (const variant of [
      "proof_artifact",
      "pr_ci",
      "pr_review",
      "claude_session_quota",
      "pr_merged",
      "pr_merge_ready",
      "pr_conflict",
    ]) {
      expect(isKnownAdeCardVariant(variant)).toBe(true);
    }
    expect(isKnownAdeCardVariant("future_card")).toBe(false);
    expect(isKnownAdeCardVariant("")).toBe(false);
    expect(isKnownAdeCardVariant(null)).toBe(false);
  });

  it("derives row keys from identity, never from position", () => {
    expect(adeCardRowKey("run-42")).toBe("ade-card:run-42");
  });

  it("builds an ade:// deeplink for addressable nav targets and null for the rest", () => {
    expect(adeCardDeeplink({ kind: "pr", repoOwner: "arul28", repoName: "ADE", prNumber: 916 }))
      .toContain("ade://");
    expect(adeCardDeeplink({ kind: "file", path: "src/main.ts", line: 12 })).toContain("ade://");
    expect(adeCardDeeplink({ kind: "route", route: "/lanes" })).toBeNull();
    expect(adeCardDeeplink(null)).toBeNull();
    // A PR target missing its repo identity has no URL form.
    expect(adeCardDeeplink({ kind: "pr", prNumber: 916 })).toBeNull();
  });

  it("describes a card as one line, including the deeplink when there is one", () => {
    const described = describeAdeCard(card({
      subtitle: "run-42",
      metrics: [{ label: "files", value: "3" }],
      navTarget: { kind: "pr", repoOwner: "arul28", repoName: "ADE", prNumber: 916 },
    }));
    expect(described).toContain("Cloud artifacts pulled — run-42");
    expect(described).toContain("3 files");
    expect(described).toContain("ade://");
    expect(described.includes("\n")).toBe(false);
  });

  it("substitutes a description when fallbackText is blank, so degradation is never empty", () => {
    expect(adeCardFallbackText(card())).toBe("3 cloud artifacts pulled into the lane");
    const blank = card({ fallbackText: "   " });
    expect(adeCardFallbackText(blank)).toBe(describeAdeCard(blank));
    expect(adeCardFallbackText(blank).length).toBeGreaterThan(0);
  });

  it("fingerprints by content, ignoring key order and the clocks", () => {
    const a = card({ metrics: [{ label: "files", value: "3" }], createdAt: "a", updatedAt: "b" });
    const b = card({ metrics: [{ value: "3", label: "files" }], createdAt: "x", updatedAt: "y" });
    expect(adeCardFingerprint(a)).toBe(adeCardFingerprint(b));

    // A nested change must change the fingerprint — the reason this is not
    // JSON.stringify with an array replacer.
    const c = card({ metrics: [{ label: "files", value: "4" }] });
    expect(adeCardFingerprint(a)).not.toBe(adeCardFingerprint(c));
  });

  it("ignores the transcript envelope type on a persisted card", () => {
    const payload = card();
    expect(adeCardFingerprint({ type: "ade_card", ...payload } as typeof payload & { type: string }))
      .toBe(adeCardFingerprint(payload));
  });

  it("sums progress buckets defensively", () => {
    expect(adeCardProgressTotal({ passed: 3, failed: 1, running: 2, queued: 4 })).toBe(10);
    expect(adeCardProgressTotal({ passed: -3, failed: 0, running: 0, queued: 0 })).toBe(0);
    expect(adeCardProgressTotal(null)).toBe(0);
  });

  describe("plugin_install", () => {
    const install = (over: Record<string, unknown> = {}) => card({
      variant: "plugin_install",
      plugin: { pluginId: "graph", displayName: "Graph", source: "https://example.test/graph", ...over },
    });

    it("reads a complete payload", () => {
      expect(readAdeCardPluginInstall(install({ version: "1.2.0", adds: ["Graph tab", ""] }))).toEqual({
        pluginId: "graph",
        displayName: "Graph",
        source: "https://example.test/graph",
        version: "1.2.0",
        adds: ["Graph tab"],
      });
    });

    it("refuses a payload that cannot name what it would install", () => {
      // The card offers an Install button; without an id AND a source there is
      // nothing for that button to act on, so it must fall back to the ordinary
      // card rather than render a consent surface with a hole in it.
      expect(readAdeCardPluginInstall(install({ source: "  " }))).toBeNull();
      expect(readAdeCardPluginInstall(install({ pluginId: "" }))).toBeNull();
      expect(readAdeCardPluginInstall(card({ variant: "plugin_install" }))).toBeNull();
    });

    it("falls back to the id when no display name is given", () => {
      expect(readAdeCardPluginInstall(install({ displayName: "  " }))?.displayName).toBe("graph");
    });
  });
});
