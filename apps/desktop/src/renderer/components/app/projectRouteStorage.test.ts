/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { readStoredProjectRoute, writeStoredProjectRoute } from "./projectRouteStorage";

const BINDING_KEY = "local:/Users/arul/ADE";
const STORAGE_KEY = `ade:project-route:${BINDING_KEY}`;

describe("project route memory", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("never remembers a machine-scoped settings page, and restores a stale one to the default", () => {
    writeStoredProjectRoute(BINDING_KEY, "/lanes");
    writeStoredProjectRoute(BINDING_KEY, "/settings?tab=storage#diagnostics");
    // `#diagnostics` names a This computer card, so it wins over `?tab=chat`.
    writeStoredProjectRoute(BINDING_KEY, "/settings?tab=chat#diagnostics");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("/lanes");

    // A project settings page is still remembered.
    writeStoredProjectRoute(BINDING_KEY, "/settings?tab=secrets");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("/settings?tab=secrets");

    // A value stored before machine pages were excluded restores to the default and is replaced.
    window.localStorage.setItem(STORAGE_KEY, "/settings?tab=storage#diagnostics");
    expect(readStoredProjectRoute(BINDING_KEY)).toBe("/work");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("/work");
  });
});
