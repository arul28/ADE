/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import {
  isProjectSurfacePathname,
  readStoredProjectRoute,
  readStoredProjectSettingsRoute,
  writeStoredProjectRoute,
} from "./projectRouteStorage";

/**
 * Which routes a project tab is allowed to remember, and what a remembered one
 * does when the thing it names is gone.
 *
 * The allowlist grew `/plugin` because omitting it made a plugin tab look like a
 * click that did nothing: `ProjectTabHost` dropped the route, so the URL and the
 * rail moved while the last Work route kept rendering. The doubt that came with
 * that change was whether the omission had been deliberate — whether restoring a
 * `/plugin/<id>` route could boot ADE into a dead tab.
 *
 * It cannot, and the reason is that this module is not the gate. A stored route
 * is replayed as-is; what answers for a surface that has gone away is the PAGE
 * at the other end. `/graph` without its plugin renders `BuiltinSurfaceUnavailable`
 * through `BuiltinRouteGuard`, and `/plugin/<id>` without its plugin renders
 * "Not installed here" from `PluginTabPage` — a stated empty state either way,
 * pinned in `plugins/PluginTabPage.test.tsx`. Adding `/plugin` here made the two
 * consistent rather than introducing a hazard.
 */

afterEach(() => {
  window.localStorage.clear();
});

describe("isProjectSurfacePathname", () => {
  it("includes plugin tabs so /plugin/<id> is a real project surface", () => {
    expect(isProjectSurfacePathname("/plugin/hn")).toBe(true);
    expect(isProjectSurfacePathname("/work")).toBe(true);
    expect(isProjectSurfacePathname("/plugins-dev")).toBe(false);
    expect(isProjectSurfacePathname("/marketplace")).toBe(false);
  });

  it("keeps the machine-level surfaces out, prefix lookalikes included", () => {
    // `/plugin` must not swallow `/plugins-dev` or `/plugin-store`: the roots are
    // matched on a whole segment, not on `startsWith` alone.
    for (const pathname of ["/plugins-dev", "/plugin-store", "/account", "/chats"]) {
      expect(isProjectSurfacePathname(pathname)).toBe(false);
    }
    expect(isProjectSurfacePathname("/plugin")).toBe(true);
  });
});

describe("stored project routes", () => {
  it("replays a stored plugin tab, query and all", () => {
    writeStoredProjectRoute("proj", "/plugin/hn?panel=stories");
    expect(readStoredProjectRoute("proj")).toBe("/plugin/hn?panel=stories");
  });

  it("replays a stored plugin tab whose plugin may since have gone", () => {
    // Deliberately NOT dropped here. This module cannot see the registry, and a
    // read that guessed would erase a good route on every cold start, when the
    // registry has not resolved yet. The page states the case instead.
    writeStoredProjectRoute("proj", "/plugin/uninstalled-since");
    expect(readStoredProjectRoute("proj")).toBe("/plugin/uninstalled-since");
  });

  it("drops and forgets a route that is not a project surface at all", () => {
    writeStoredProjectRoute("proj", "/marketplace");
    expect(readStoredProjectRoute("proj")).toBeNull();
    expect(window.localStorage.getItem("ade:project-route:proj")).toBeNull();
  });

  it("migrates the legacy /project route to /work", () => {
    writeStoredProjectRoute("proj", "/project");
    expect(readStoredProjectRoute("proj")).toBe("/work");
  });

  it("never restores a plugin tab as the settings route", () => {
    // `readStoredProjectSettingsRoute` is how the rail reopens Settings where the
    // reader left it. Now that `/plugin/<id>` is storable, it is also a value
    // this reader can meet — and answering with one would send a Settings click
    // into a plugin's tab.
    writeStoredProjectRoute("proj", "/plugin/hn?panel=stories");
    expect(readStoredProjectSettingsRoute("proj")).toBeNull();
    writeStoredProjectRoute("proj", "/settings?tab=stats");
    expect(readStoredProjectSettingsRoute("proj")).toBe("/settings?tab=stats");
  });

  it("keeps the last settings place after the project route moves to a plugin tab", () => {
    writeStoredProjectRoute("proj", "/settings?tab=integrations#plugin-section-ade-linear");
    writeStoredProjectRoute("proj", "/plugin/ade-linear");
    expect(readStoredProjectRoute("proj")).toBe("/plugin/ade-linear");
    expect(readStoredProjectSettingsRoute("proj")).toBe(
      "/settings?tab=integrations#plugin-section-ade-linear",
    );
  });
});
