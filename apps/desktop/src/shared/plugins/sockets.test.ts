import { describe, expect, it } from "vitest";
import {
  comparePluginContributions,
  isPluginEntityKind,
  isPluginSocketKind,
  isPluginSurfaceId,
  parsePluginContributionPayload,
  splitPluginRowBadges,
  type PluginContribution,
} from "./sockets";

function badge(id: string, order?: number, pluginId = "a"): PluginContribution<"row-badge"> {
  return {
    pluginId,
    socket: "row-badge",
    surface: "lanes",
    id,
    ...(order === undefined ? {} : { order }),
    payload: { text: id, tone: "neutral" },
  };
}

describe("parsePluginContributionPayload", () => {
  it("accepts a well-formed payload for each kind", () => {
    expect(parsePluginContributionPayload("toolbar-action", { label: "Sync", actionId: "sync" }))
      .toEqual({ label: "Sync", actionId: "sync" });
    expect(parsePluginContributionPayload("row-menu-item", { label: "Open", actionId: "open", danger: true }))
      .toEqual({ label: "Open", actionId: "open", danger: true });
    expect(parsePluginContributionPayload("filter-chip", { label: "Mine", filterKey: "mine", count: 3.7 }))
      .toEqual({ label: "Mine", filterKey: "mine", count: 3 });
    expect(parsePluginContributionPayload("file-viewer", { panelId: "player", extensions: [".MP4", "mov"] }))
      .toEqual({ panelId: "player", extensions: [".mp4"] });
  });

  // A contribution missing its action or label is a plugin bug; rendering a
  // blank button would hide it, so the payload is refused outright.
  it("refuses a payload missing the field that makes it actionable", () => {
    expect(parsePluginContributionPayload("toolbar-action", { label: "Sync" })).toBeNull();
    expect(parsePluginContributionPayload("row-menu-item", { actionId: "open" })).toBeNull();
    expect(parsePluginContributionPayload("detail-section", {})).toBeNull();
    expect(parsePluginContributionPayload("row-badge", { text: "   " })).toBeNull();
    expect(parsePluginContributionPayload("row-badge", "nope")).toBeNull();
  });

  // House rule, same as `normalizeAdeCardTone`: failure is amber, never red.
  it("folds any red-ish tone a plugin invents into warning", () => {
    for (const tone of ["danger", "error", "critical"]) {
      expect(parsePluginContributionPayload("row-badge", { text: "x", tone })).toMatchObject({ tone: "warning" });
    }
    expect(parsePluginContributionPayload("row-badge", { text: "x", tone: "nonsense" }))
      .toMatchObject({ tone: "neutral" });
  });

  it("truncates nothing and instead rejects over-long text", () => {
    expect(parsePluginContributionPayload("row-badge", { text: "x".repeat(33) })).toBeNull();
  });
});

describe("contribution placement", () => {
  it("orders by explicit order, then plugin, then contribution id", () => {
    const sorted = [badge("z", 2), badge("a"), badge("b", 1), badge("c", 1, "b")]
      .sort(comparePluginContributions)
      .map((entry) => `${entry.pluginId}:${entry.id}`);
    expect(sorted).toEqual(["a:b", "b:c", "a:z", "a:a"]);
  });

  it("caps visible row badges and reports the overflow", () => {
    const split = splitPluginRowBadges([badge("d", 4), badge("a", 1), badge("b", 2), badge("c", 3)]);
    expect(split.visible.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(split.overflowCount).toBe(2);
  });

  it("reports no overflow when everything fits", () => {
    const split = splitPluginRowBadges([badge("a", 1)]);
    expect(split.visible).toHaveLength(1);
    expect(split.overflowCount).toBe(0);
  });
});

describe("closed-list guards", () => {
  it("narrows only a member of each list, and rejects everything else (NEW-B2)", () => {
    expect(isPluginSocketKind("row-badge")).toBe(true);
    expect(isPluginSocketKind("row-badges")).toBe(false);
    expect(isPluginSocketKind(undefined)).toBe(false);
    expect(isPluginSocketKind(42)).toBe(false);

    expect(isPluginSurfaceId("lanes")).toBe(true);
    expect(isPluginSurfaceId("lane")).toBe(false);

    expect(isPluginEntityKind("pr")).toBe(true);
    expect(isPluginEntityKind("pull_request")).toBe(false);
    expect(isPluginEntityKind(null)).toBe(false);
  });
});
