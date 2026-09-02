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
 * Graph SUPERSEDES now: the compiled page stays until `ade-graph` is installed,
 * then `/graph` sends the reader to the plugin tab.
 */

function Page() {
  return <div>the real page</div>;
}

afterEach(() => {
  cleanup();
  resetBuiltinSurfacePlugins();
});

describe("BuiltinRouteGuard", () => {
  it("renders compiled Graph while its plugin is absent", () => {
    seedBuiltinSurfacePlugins([]);

    render(<BuiltinRouteGuard route="/graph" pending={<div>loading</div>}><Page /></BuiltinRouteGuard>);

    expect(screen.getByText("the real page")).toBeTruthy();
  });

  it("sends compiled Graph to the plugin tab once ade-graph is installed", () => {
    seedBuiltinSurfacePlugins(["graph"]);

    render(
      <MemoryRouter initialEntries={["/graph"]}>
        <Routes>
          <Route
            path="/graph"
            element={<BuiltinRouteGuard route="/graph" pending={null}><Page /></BuiltinRouteGuard>}
          />
          <Route path="/plugin/ade-graph" element={<div>plugin graph</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByText("the real page")).toBeNull();
    expect(screen.getByText("plugin graph")).toBeTruthy();
  });

  it("renders compiled Graph while the registry is still resolving", () => {
    resetBuiltinSurfacePlugins();
    Object.defineProperty(window, "ade", { configurable: true, writable: true, value: { plugins: {} } });

    render(<BuiltinRouteGuard route="/graph" pending={<div>loading</div>}><Page /></BuiltinRouteGuard>);

    expect(screen.getByText("the real page")).toBeTruthy();
    expect(screen.queryByText("Graph isn't part of this ADE")).toBeNull();
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
