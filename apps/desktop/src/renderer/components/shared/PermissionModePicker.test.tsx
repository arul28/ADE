/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionModePicker, type PermissionModePickerOption } from "./PermissionModePicker";

const OPTIONS: Array<PermissionModePickerOption<"edit" | "plan" | "full">> = [
  { value: "edit", label: "Edit mode", detail: "Edit", tone: "green", icon: "edit" },
  { value: "plan", label: "Plan mode", detail: "Plan", tone: "blue", icon: "plan" },
  { value: "full", label: "Full access", detail: "Full", tone: "red", icon: "full" },
];

describe("PermissionModePicker", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("places the menu with top + translateY instead of innerHeight-based bottom", () => {
    render(
      <PermissionModePicker
        ariaLabel="Permission mode"
        selectedValue="edit"
        options={OPTIONS}
        onSelect={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Permission mode" });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 180,
      y: 420,
      top: 420,
      left: 180,
      bottom: 444,
      right: 260,
      width: 80,
      height: 24,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);
    const menu = screen.getByRole("listbox", { name: "Permission mode" });
    expect(menu.style.top).toBe("420px");
    expect(menu.style.left).toBe("180px");
    expect(menu.style.width).toBe("240px");
    expect(menu.style.transform).toBe("translateY(calc(-100% - 8px))");
    expect(menu.style.bottom).toBe("");
  });
});
