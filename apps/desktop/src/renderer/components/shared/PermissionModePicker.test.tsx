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

  it("selects the chosen permission mode", () => {
    const onSelect = vi.fn();
    render(
      <PermissionModePicker
        ariaLabel="Permission mode"
        selectedValue="edit"
        options={OPTIONS}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(screen.getByRole("option", { name: "Plan mode" }));
    expect(onSelect).toHaveBeenCalledWith("plan");
  });
});
