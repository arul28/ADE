/* @vitest-environment jsdom */

import fs from "node:fs/promises";
import path from "node:path";
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
  it("scopes monochrome logo inversion to the dark theme", async () => {
    const source = await fs.readFile(
      path.resolve(process.cwd(), "src/renderer/index.css"),
      "utf8",
    );
    const darkThemeRule = source.match(
      /\[data-theme="dark"\]\s+\.editor-target-logo--invert-in-dark\s*\{[^}]+\}/,
    )?.[0];

    expect(darkThemeRule).toContain("filter: invert(1)");
    const style = document.createElement("style");
    style.textContent = darkThemeRule ?? "";
    document.head.append(style);
    const logo = document.createElement("img");
    logo.className = "editor-target-logo--invert-in-dark";
    document.body.append(logo);

    document.documentElement.setAttribute("data-theme", "dark");
    expect(window.getComputedStyle(logo).filter).toBe("invert(1)");
    document.documentElement.setAttribute("data-theme", "light");
    expect(window.getComputedStyle(logo).filter).toBe("");

    style.remove();
    logo.remove();
  });

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
    expect(
      screen
        .getByTestId("editor-logo-cursor")
        .querySelector("img")
        ?.classList.contains("editor-target-logo--invert-in-dark"),
    ).toBe(true);
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });

  it("keeps monochrome marks unfiltered on light menus", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    render(<OpenInSubmenu rootPath="/tmp/lane" onClose={vi.fn()} />);

    fireEvent.pointerOver(screen.getByRole("button", { name: "Open in" }));
    act(() => {
      vi.advanceTimersByTime(SUBMENU_OPEN_DELAY_MS + 10);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const cursorLogo = screen
      .getByTestId("editor-logo-cursor")
      .querySelector("img");
    expect(cursorLogo).toBeTruthy();
    expect(
      cursorLogo?.classList.contains("editor-target-logo--invert-in-dark"),
    ).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
