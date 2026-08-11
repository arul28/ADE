import { describe, expect, it } from "vitest";

import { DEFAULT_DID_YOU_KNOW_HINTS, visibleDidYouKnowHints } from "./DidYouKnow";
import type { PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";

/**
 * A tip is an advertisement, and the ones pitching Graph or the iOS Simulator
 * describe tabs a machine without those plugins does not have. Filtering them
 * changes nothing about what the app can do — there is no capability behind a
 * "Did you know?" card — which is why this suite only asserts on the pool.
 */
describe("visibleDidYouKnowHints", () => {
  const installed = (...ids: PluginBuiltinSurfaceId[]) => {
    const set = new Set<PluginBuiltinSurfaceId>(ids);
    return (builtinId: PluginBuiltinSurfaceId) => set.has(builtinId);
  };
  const ids = (hints: readonly { id: string }[]) => hints.map((hint) => hint.id);

  it("drops the tips selling a surface this machine does not have", () => {
    const visible = ids(visibleDidYouKnowHints(DEFAULT_DID_YOU_KNOW_HINTS, installed()));

    expect(visible).not.toContain("graph-projection");
    expect(visible).not.toContain("graph-risk");
    expect(visible).not.toContain("ios-simulator-owner");
    expect(visible).not.toContain("simulator-preview");
    // The tips that describe core ADE are untouched, so the pool is never empty.
    expect(visible).toContain("lanes-parallel");
    expect(visible).toContain("sync-local-first");
    expect(visible.length).toBeGreaterThan(0);
  });

  it("restores each tip when its owning surface is installed", () => {
    const visible = ids(visibleDidYouKnowHints(DEFAULT_DID_YOU_KNOW_HINTS, installed("graph")));

    expect(visible).toContain("graph-projection");
    expect(visible).toContain("graph-risk");
    expect(visible).not.toContain("ios-simulator-owner");
  });

  it("leaves caller-supplied hints alone when they name no surface", () => {
    const custom = [{ id: "custom", body: "Anything." }];

    expect(visibleDidYouKnowHints(custom, installed())).toEqual(custom);
  });
});
