/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { House } from "@phosphor-icons/react";
import {
  APPLE_COLUMN_DOCK_DRAWER_WIDTH,
  APPLE_COLUMN_HEADER_TOOLBAR_WIDTH,
  APPLE_COLUMN_QUICK_STRIP_WIDTH,
  AppleDeviceToolbar,
  resolveAppleDeviceToolbarLayout,
  type AppleToolbarAction,
} from "./AppleDeviceToolbar";

function action(overrides: Partial<AppleToolbarAction> = {}): AppleToolbarAction {
  return {
    id: "home",
    label: "Home",
    icon: House,
    onSelect: vi.fn(),
    ...overrides,
  };
}

describe("resolveAppleDeviceToolbarLayout", () => {
  it("docks the drawer beside the stage only at 700px and above", () => {
    expect(resolveAppleDeviceToolbarLayout(APPLE_COLUMN_DOCK_DRAWER_WIDTH).drawer).toBe("docked");
    expect(resolveAppleDeviceToolbarLayout(APPLE_COLUMN_DOCK_DRAWER_WIDTH - 1).drawer).toBe("overlay");
  });

  it("moves the toolbar into the header below 420px", () => {
    expect(resolveAppleDeviceToolbarLayout(APPLE_COLUMN_HEADER_TOOLBAR_WIDTH).toolbar).toBe("rail");
    expect(resolveAppleDeviceToolbarLayout(APPLE_COLUMN_HEADER_TOOLBAR_WIDTH - 1).toolbar).toBe("header");
  });

  it("collapses the 3D/Flat pair and refuses 3D exactly where the toolbar moves", () => {
    const narrow = resolveAppleDeviceToolbarLayout(APPLE_COLUMN_HEADER_TOOLBAR_WIDTH - 1);
    expect(narrow.collapseViewToggle).toBe(true);
    expect(narrow.allows3d).toBe(false);
    const wide = resolveAppleDeviceToolbarLayout(APPLE_COLUMN_HEADER_TOOLBAR_WIDTH);
    expect(wide.collapseViewToggle).toBe(false);
    expect(wide.allows3d).toBe(true);
  });

  it("hides the quick strip below 280px", () => {
    expect(resolveAppleDeviceToolbarLayout(APPLE_COLUMN_QUICK_STRIP_WIDTH).quickStrip).toBe(true);
    expect(resolveAppleDeviceToolbarLayout(APPLE_COLUMN_QUICK_STRIP_WIDTH - 1).quickStrip).toBe(false);
  });

  it("hides the toolbar and the strip entirely when the lane owns no device", () => {
    const layout = resolveAppleDeviceToolbarLayout(1200, { hasDevice: false });
    expect(layout.toolbar).toBe("hidden");
    expect(layout.quickStrip).toBe(false);
  });
});

afterEach(cleanup);

describe("AppleDeviceToolbar", () => {
  it("renders the rail as an overlay that reserves no gutter", () => {
    const { container } = render(
      <AppleDeviceToolbar placement="rail" groups={[[action()]]} />,
    );
    const rail = container.querySelector("[data-apple-toolbar='rail']");
    expect(rail?.className).toContain("pointer-events-none");
    expect(rail?.className).toContain("absolute");
  });

  it("renders the header fallback as one scrollable row", () => {
    const { container } = render(
      <AppleDeviceToolbar placement="header" groups={[[action()]]} />,
    );
    const row = container.querySelector("[data-apple-toolbar='header']");
    expect(row?.className).toContain("overflow-x-auto");
  });

  it("shows the reason instead of the name on a disabled button", () => {
    render(
      <AppleDeviceToolbar
        placement="rail"
        groups={[[action({ id: "view-3d", label: "3D view", disabledReason: "3D view needs WebGL" })]]}
      />,
    );
    // The accessible name stays the action; the tooltip label is the reason,
    // which is the whole point of the pattern — a greyed "3D" explains nothing.
    const button = screen.getByRole("button", { name: "3D view" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("data-apple-toolbar-action")).toBe("view-3d");
  });

  it("drops empty groups rather than drawing a divider around nothing", () => {
    const { container } = render(
      <AppleDeviceToolbar placement="rail" groups={[[], [action()], []]} />,
    );
    expect(container.querySelectorAll("[data-apple-toolbar-action]")).toHaveLength(1);
    expect(container.querySelectorAll(".bg-white\\/\\[0\\.10\\]")).toHaveLength(0);
  });
});
