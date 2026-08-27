/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rootAppStoreApi } from "../../state/appStore";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";
import { CursorCloudQuickViewButton } from "./CursorCloudQuickViewButton";

/**
 * ADE's own Cursor Cloud entry point in the top bar, and the one thing the
 * `ade-cursor-cloud` plugin must do to it.
 *
 * The plugin ships its own header button. If ADE kept drawing this one as well,
 * the user would be looking at two Cursor Cloud buttons that open two different
 * fleet surfaces — which is the report this change came from. So the button
 * carries the gate itself rather than trusting the two places `TopBar` renders
 * it, and both directions are pinned here: gone once the plugin owns the
 * surface, and untouched on every machine that does not have it.
 *
 * The component only appears at all once a delayed, cached Cursor-connection
 * probe answers, so each case drives that timer forward before asserting.
 */

const BUTTON = "Cursor Cloud fleet";

function mockAdeBridge(): void {
  const existing = (window as unknown as { ade?: Record<string, unknown> }).ade;
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: {
      ...(existing ?? {}),
      ai: {
        cursorCloudFleet: vi.fn(),
        getStatus: vi.fn(async () => ({
          availableProviders: { cursor: true },
          providerConnections: { cursor: { authAvailable: true } },
        })),
        onCursorCloudFleetEvent: vi.fn(() => () => {}),
      },
    },
  });
}

/** Run the button's delayed connection probe and let its promise settle. */
async function settleVisibilityProbe(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(10_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockAdeBridge();
  rootAppStoreApi.setState({
    project: { rootPath: "/repo", displayName: "repo" } as never,
    projectBinding: null,
  });
  resetBuiltinSurfacePlugins();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetBuiltinSurfacePlugins();
});

describe("CursorCloudQuickViewButton", () => {
  it("draws ADE's fleet button on a machine without the plugin", async () => {
    render(<CursorCloudQuickViewButton />);
    await settleVisibilityProbe();
    expect(screen.getByLabelText(BUTTON)).toBeTruthy();
  });

  it("keeps drawing it while the plugin registry has not resolved", async () => {
    // The unknown case, and the reason a superseded surface reads the opposite
    // way from every other gated one: hiding here would blink the button off on
    // every launch of a machine that has no Cursor Cloud plugin at all.
    rootAppStoreApi.setState({ installedPlugins: [], pluginsLoaded: false });
    render(<CursorCloudQuickViewButton />);
    await settleVisibilityProbe();
    expect(screen.getByLabelText(BUTTON)).toBeTruthy();
  });

  it("disappears once ade-cursor-cloud is installed and enabled", async () => {
    seedBuiltinSurfacePlugins(["cursor-cloud"]);
    mockAdeBridge();
    render(<CursorCloudQuickViewButton />);
    await settleVisibilityProbe();
    expect(screen.queryByLabelText(BUTTON)).toBeNull();
  });

  it("is unaffected by an unrelated plugin owning a different surface", async () => {
    seedBuiltinSurfacePlugins(["linear"]);
    mockAdeBridge();
    render(<CursorCloudQuickViewButton />);
    await settleVisibilityProbe();
    expect(screen.getByLabelText(BUTTON)).toBeTruthy();
  });
});
