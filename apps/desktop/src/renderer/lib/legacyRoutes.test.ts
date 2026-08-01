import { describe, expect, it } from "vitest";

import {
  isActivityRoute,
  LEGACY_ROUTE_ALIASES,
  resolveLegacyRoute,
} from "./legacyRoutes";

describe("legacy routes", () => {
  it("resolves every alias to a route the app serves today", () => {
    for (const [legacy, target] of Object.entries(LEGACY_ROUTE_ALIASES)) {
      expect(resolveLegacyRoute(legacy)).toBe(target);
      expect(LEGACY_ROUTE_ALIASES[target]).toBeUndefined();
    }
  });

  it("carries a sub-path across the rename", () => {
    expect(resolveLegacyRoute("/attention/inbox")).toBe("/activity/inbox");
  });

  it("tolerates a trailing slash", () => {
    expect(resolveLegacyRoute("/attention/")).toBe("/activity");
  });

  it("leaves an unknown path alone", () => {
    expect(resolveLegacyRoute("/work")).toBe("/work");
    expect(resolveLegacyRoute("/attentiveness")).toBe("/attentiveness");
  });

  it("recognises Activity under either of its names", () => {
    expect(isActivityRoute("/activity")).toBe(true);
    expect(isActivityRoute("/attention")).toBe(true);
    expect(isActivityRoute("/attention/inbox")).toBe(true);
    // The prefix check must not catch a route that merely starts the same way.
    expect(isActivityRoute("/attentiveness")).toBe(false);
    expect(isActivityRoute("/work")).toBe(false);
  });
});
