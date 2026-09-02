/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { BuiltinRouteGuard } from "./BuiltinRouteGuard";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";

/**
 * The route half of the gate.
 *
 * A hidden rail item is a signpost, not access control: `/graph` is reachable
 * by typed URL, by deeplink, and by the persisted last-route on project open.
 * These assert that the page itself refuses — and, just as importantly, that it
 * does not refuse before it knows.
 */

function Page() {
  return <div>the real page</div>;
}

afterEach(() => {
  cleanup();
  resetBuiltinSurfacePlugins();
});

describe("BuiltinRouteGuard", () => {
  it("refuses the route when the owning plugin is not installed", () => {
    seedBuiltinSurfacePlugins([]);

    render(<BuiltinRouteGuard route="/graph" pending={<div>loading</div>}><Page /></BuiltinRouteGuard>);

    expect(screen.queryByText("the real page")).toBeNull();
    expect(screen.getByText("Graph isn't part of this ADE")).toBeTruthy();
    // No way back in from here. Offering the Marketplace would advertise the
    // thing the user removed, which is the state this round exists to end.
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the page when the owning plugin is installed", () => {
    seedBuiltinSurfacePlugins(["graph"]);

    render(<BuiltinRouteGuard route="/graph" pending={<div>loading</div>}><Page /></BuiltinRouteGuard>);

    expect(screen.getByText("the real page")).toBeTruthy();
  });

  it("waits rather than refusing while the registry is still resolving", () => {
    // The cold-start case. Refusing here would tell every user who HAS the
    // plugin that their tab is gone, for the moment before the registry lands.
    seedBuiltinSurfacePlugins(["graph"]);
    resetBuiltinSurfacePlugins();
    Object.defineProperty(window, "ade", { configurable: true, writable: true, value: { plugins: {} } });

    render(<BuiltinRouteGuard route="/graph" pending={<div>loading</div>}><Page /></BuiltinRouteGuard>);

    expect(screen.getByText("loading")).toBeTruthy();
    expect(screen.queryByText("Graph isn't part of this ADE")).toBeNull();
    expect(screen.queryByText("the real page")).toBeNull();
  });

  it("names the surface that is missing, not the plugin that provides it", () => {
    seedBuiltinSurfacePlugins([]);

    render(<BuiltinRouteGuard route="/graph" pending={null}><Page /></BuiltinRouteGuard>);

    expect(screen.getByText("Graph isn't part of this ADE")).toBeTruthy();
  });

  it("leaves a route no plugin owns alone", () => {
    seedBuiltinSurfacePlugins([]);

    render(<BuiltinRouteGuard route="/lanes" pending={null}><Page /></BuiltinRouteGuard>);

    expect(screen.getByText("the real page")).toBeTruthy();
  });

  it("renders compiled Review while its plugin is absent", () => {
    seedBuiltinSurfacePlugins([]);

    render(<BuiltinRouteGuard route="/review" pending={null}><Page /></BuiltinRouteGuard>);

    expect(screen.getByText("the real page")).toBeTruthy();
  });

  it("sends compiled Review to the plugin tab once ade-review is installed", () => {
    seedBuiltinSurfacePlugins(["review"]);

    render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes>
          <Route
            path="/review"
            element={<BuiltinRouteGuard route="/review" pending={null}><Page /></BuiltinRouteGuard>}
          />
          <Route path="/plugin/ade-review" element={<div>plugin review</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByText("the real page")).toBeNull();
    expect(screen.getByText("plugin review")).toBeTruthy();
  });

  it("renders compiled History while its plugin is absent", () => {
    seedBuiltinSurfacePlugins([]);

    render(<BuiltinRouteGuard route="/history" pending={null}><Page /></BuiltinRouteGuard>);

    expect(screen.getByText("the real page")).toBeTruthy();
  });

  it("sends compiled History to the plugin tab once ade-history is installed", () => {
    seedBuiltinSurfacePlugins(["history"]);

    render(
      <MemoryRouter initialEntries={["/history"]}>
        <Routes>
          <Route
            path="/history"
            element={<BuiltinRouteGuard route="/history" pending={null}><Page /></BuiltinRouteGuard>}
          />
          <Route path="/plugin/ade-history" element={<div>plugin history</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByText("the real page")).toBeNull();
    expect(screen.getByText("plugin history")).toBeTruthy();
  });
});
