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
  document.documentElement.setAttribute("data-theme", "dark");
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
  document.documentElement.removeAttribute("data-theme");
});

describe("OpenInSubmenu", () => {
  it("lists installed editors in the submenu", async () => {
    render(<OpenInSubmenu rootPath="/tmp/lane" onClose={vi.fn()} />);

    fireEvent.pointerOver(screen.getByRole("button", { name: "Open in" }));
    act(() => {
      vi.advanceTimersByTime(SUBMENU_OPEN_DELAY_MS + 10);
    });
    await act(async () => {
      await Promise.resolve();
    });

    for (const editor of ["Cursor", "Zed", "Antigravity", "Xcode"]) {
      expect(screen.queryByRole("menuitem", { name: editor })).not.toBeNull();
    }
  });
});
