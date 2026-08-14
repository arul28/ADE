/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorCloudAdvancedMenu } from "./CursorCloudAdvancedMenu";

describe("CursorCloudAdvancedMenu", () => {
  afterEach(() => {
    cleanup();
  });

  it("toggles Open a PR when the branch has no PR", () => {
    const onAutoCreatePRChange = vi.fn();
    render(
      <CursorCloudAdvancedMenu
        autoCreatePR={false}
        onAutoCreatePRChange={onAutoCreatePRChange}
        existingPr={null}
        availableNames={[]}
        selectedNames={[]}
        remember={false}
        onSelectedNamesChange={vi.fn()}
        onRememberChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    const checkbox = screen.getByRole("menuitemcheckbox", { name: "Open a PR" }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(onAutoCreatePRChange).toHaveBeenCalledWith(true);
    expect(screen.getByLabelText("About Open a PR")).toBeTruthy();
  });

  it("shows attach-to-existing-PR instead of Open a PR", () => {
    render(
      <CursorCloudAdvancedMenu
        autoCreatePR={true}
        onAutoCreatePRChange={vi.fn()}
        existingPr={{
          prUrl: "https://github.com/acme/project/pull/12",
          prNumber: 12,
          title: "Fix flakes",
        }}
        availableNames={["NPM_TOKEN"]}
        selectedNames={[]}
        remember={false}
        onSelectedNamesChange={vi.fn()}
        onRememberChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByText("Attach to PR #12")).toBeTruthy();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Open a PR" })).toBeNull();
    expect(screen.getByText("Attach ADE secrets")).toBeTruthy();
  });
});
