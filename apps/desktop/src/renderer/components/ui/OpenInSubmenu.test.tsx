/* @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenInSubmenu } from "./OpenInSubmenu";
import { SUBMENU_OPEN_DELAY_MS } from "./MenuSubmenu";

const getInstalledEditors = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  getInstalledEditors.mockResolvedValue([
    "cursor",
    "zed",
    "antigravity",
    "xcode",
  ]);
  (window as unknown as { ade: unknown }).ade = {
    app: { getInstalledEditors, openPathInEditor: vi.fn() },
  };
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("OpenInSubmenu", () => {
  it("shows the real brand mark beside every installed editor", async () => {
    render(<OpenInSubmenu rootPath="/tmp/lane" onClose={vi.fn()} />);

    fireEvent.pointerOver(screen.getByRole("button", { name: "Open in" }));
    act(() => {
      vi.advanceTimersByTime(SUBMENU_OPEN_DELAY_MS + 10);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("menuitem", { name: "Cursor" })).toBeTruthy();

    const expectedAssetNames = {
      cursor: "cursor",
      zed: "zed.svg",
      antigravity: "antigravity-color",
      xcode: "xcode.svg",
    } as const;
    for (const [target, assetName] of Object.entries(expectedAssetNames)) {
      const logo = screen
        .getByTestId(`editor-logo-${target}`)
        .querySelector("img");
      expect(logo).toBeTruthy();
      expect(logo?.getAttribute("src")).toContain(assetName);
    }
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });
});
