/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";
import { rootAppStoreApi } from "../../state/appStore";
import { LinearIntegrationSection } from "./LinearIntegrationSection";

// The gate is the subject here, not the connection form: `LinearSection` opens
// credential IPC on mount, and stubbing it keeps this test about whether the
// card — heading included — is in the product at all.
vi.mock("./LinearSection", () => ({
  LinearSection: () => <div data-testid="linear-connection-form" />,
}));

function setHost() {
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: { plugins: {} },
  });
}

describe("LinearIntegrationSection", () => {
  beforeEach(() => {
    setHost();
  });

  afterEach(() => {
    cleanup();
    resetBuiltinSurfacePlugins();
    Reflect.deleteProperty(window, "ade");
  });

  it("renders the connection card when the Linear plugin is not installed", () => {
    seedBuiltinSurfacePlugins([]);

    const { container } = render(<LinearIntegrationSection />);

    expect(screen.getByText("Linear integration")).toBeTruthy();
    expect(screen.getByTestId("linear-connection-form")).toBeTruthy();
    expect(container.querySelector("[data-settings-anchor='linear-connection']")).toBeTruthy();
  });

  it("keeps the connection card while the plugin registry has not resolved", () => {
    // The state that matters most for a superseded surface. ADE has always
    // shipped this card. An unresolved registry must not remove it for the
    // moment before the answer arrives, on a machine that has no Linear plugin
    // at all.
    resetBuiltinSurfacePlugins();

    const { container } = render(<LinearIntegrationSection />);

    expect(screen.getByText("Linear integration")).toBeTruthy();
    expect(container.querySelector("[data-settings-anchor='linear-connection']")).toBeTruthy();
  });

  it("renders nothing — card and heading — once the Linear plugin is installed and enabled", () => {
    seedBuiltinSurfacePlugins(["linear"]);

    const { container } = render(<LinearIntegrationSection />);

    expect(container.textContent).toBe("");
    expect(screen.queryByText("Linear integration")).toBeNull();
    expect(screen.queryByTestId("linear-connection-form")).toBeNull();
    // No orphan anchor left behind for settings search to land on either.
    expect(container.querySelector("[data-settings-anchor='linear-connection']")).toBeNull();
  });

  it("shows the card again when the installed Linear plugin is disabled", () => {
    seedBuiltinSurfacePlugins(["linear"]);
    rootAppStoreApi.setState({
      installedPlugins: rootAppStoreApi.getState().installedPlugins.map((plugin) => ({
        ...plugin,
        enabled: false,
      })),
    });

    render(<LinearIntegrationSection />);

    expect(screen.getByText("Linear integration")).toBeTruthy();
  });
});
