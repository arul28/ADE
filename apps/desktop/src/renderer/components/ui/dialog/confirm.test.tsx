/* @vitest-environment jsdom */

import { useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog } from "./Dialog";
import { DialogHost, __resetDialogRequestsForTests, confirmDialog, promptDialog } from "./confirm";
import { Z_LAYERS } from "../zLayers";

afterEach(() => {
  act(() => __resetDialogRequestsForTests());
  cleanup();
});

/** Raise a dialog and let it render; returns its (still pending) result. */
async function open<T>(start: () => Promise<T>): Promise<{ result: Promise<T> }> {
  let result!: Promise<T>;
  await act(async () => {
    result = start();
  });
  return { result };
}

describe("confirmDialog", () => {
  it("resolves true when confirmed and false when cancelled", async () => {
    const user = userEvent.setup();
    render(<DialogHost />);

    const { result: accepted } = await open(() => confirmDialog({ title: "Delete lane?", message: "This cannot be undone.", confirmLabel: "Delete", destructive: true }));
    expect(screen.getByRole("alertdialog", { name: "Delete lane?" })).toBeTruthy();
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await expect(accepted).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    const { result: declined } = await open(() => confirmDialog({ title: "Continue?" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(declined).resolves.toBe(false);
  });

  it("cancels on Escape and confirms on Enter", async () => {
    const user = userEvent.setup();
    render(<DialogHost />);

    const { result: escaped } = await open(() => confirmDialog({ title: "Discard changes?" }));
    await user.keyboard("{Escape}");
    await expect(escaped).resolves.toBe(false);

    const { result: entered } = await open(() => confirmDialog({ title: "Reset lane?" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "OK" })));
    await user.keyboard("{Enter}");
    await expect(entered).resolves.toBe(true);
  });

  it("stacks above an open dialog and returns focus to it", async () => {
    const user = userEvent.setup();
    function Outer() {
      const [isOpen, setOpen] = useState(true);
      return (
        <Dialog open={isOpen} onOpenChange={setOpen} title="Outer">
          <button type="button">Inner action</button>
        </Dialog>
      );
    }
    render(
      <>
        <Outer />
        <DialogHost />
      </>,
    );
    const inner = screen.getByRole("button", { name: "Inner action" });
    inner.focus();

    const { result } = await open(() => confirmDialog({ title: "Nested?" }));
    const nested = screen.getByRole("alertdialog", { name: "Nested?" });
    expect(nested.style.zIndex).toBe(String(Z_LAYERS.nestedDialog));
    // The outer dialog is aria-hidden while the nested one is up.
    const outer = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(outer?.getAttribute("aria-hidden")).toBe("true");
    expect(outer?.style.zIndex).toBe(String(Z_LAYERS.dialog));

    await user.keyboard("{Escape}");
    await expect(result).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // Escape closed only the top layer.
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(inner));
  });
});

describe("promptDialog", () => {
  it("returns the typed value, or null when cancelled", async () => {
    const user = userEvent.setup();
    render(<DialogHost />);

    const { result: named } = await open(() => promptDialog({ title: "Rename session", defaultValue: "Old" }));
    const input = screen.getByRole("textbox", { name: "Rename session" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.clear(input);
    await user.type(input, "New name{Enter}");
    await expect(named).resolves.toBe("New name");

    const { result: cancelled } = await open(() => promptDialog({ title: "Lane name" }));
    await user.keyboard("{Escape}");
    await expect(cancelled).resolves.toBeNull();
  });

  it("blocks submit while empty or invalid", async () => {
    const user = userEvent.setup();
    render(<DialogHost />);

    const { result } = await open(() =>
      promptDialog({
        title: "Create tag",
        validate: (value) => (/\s/.test(value) ? "Tag names cannot contain spaces" : null),
      }),
    );
    const ok = screen.getByRole("button", { name: "OK" }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);

    const input = screen.getByRole("textbox", { name: "Create tag" });
    await user.type(input, "v 1{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("Tag names cannot contain spaces");
    expect(ok.disabled).toBe(true);
    expect(screen.getByRole("dialog", { name: "Create tag" })).toBeTruthy();

    await user.clear(input);
    await user.type(input, "v1");
    expect(ok.disabled).toBe(false);
    await user.click(ok);
    await expect(result).resolves.toBe("v1");
  });

  it("can submit an empty value when allowed", async () => {
    const user = userEvent.setup();
    render(<DialogHost />);
    const { result } = await open(() => promptDialog({ title: "Tag message (optional)", allowEmpty: true }));
    await user.keyboard("{Enter}");
    await expect(result).resolves.toBe("");
  });
});

// Last: the fallback host stays mounted for the rest of the file.
describe("host fallback", () => {
  it("mounts its own host when none is mounted", async () => {
    const user = userEvent.setup();
    const { result } = await open(() => confirmDialog({ title: "Cherry-pick abc123 onto this lane?" }));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Cherry-pick abc123 onto this lane?" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "OK" }));
    await expect(result).resolves.toBe(true);
  });
});
