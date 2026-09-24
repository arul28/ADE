/* @vitest-environment jsdom */

import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeaderSheet } from "../../app/HeaderSheet";
import { LaneDialogShell } from "../../lanes/LaneDialogShell";
import { Dialog } from "./Dialog";
import {
  DialogHost,
  __resetDialogRequestsForTests,
  confirmDialog,
  promptDialog,
} from "./confirm";
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

describe("Dialog Escape", () => {
  it("closes only a confirm raised inside a HeaderSheet, not the sheet or a page listener", async () => {
    const user = userEvent.setup();
    const closeSheet = vi.fn();
    const pageEscape = vi.fn();
    const onWindowKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") pageEscape();
    };
    window.addEventListener("keydown", onWindowKey);

    function Sheet() {
      const panelRef = useRef<HTMLDivElement>(null);
      const [confirming, setConfirming] = useState(true);
      return (
        <HeaderSheet open panelRef={panelRef} title="Connections" onClose={closeSheet}>
          <button type="button">Revoke</button>
          {/* Mounted in the sheet's React tree: its events bubble through the sheet's handlers. */}
          <Dialog open={confirming} onOpenChange={setConfirming} role="alertdialog" title="Revoke access?">
            <button type="button">Inside confirm</button>
          </Dialog>
        </HeaderSheet>
      );
    }

    try {
      render(<Sheet />);
      await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Revoke access?" }).contains(document.activeElement)).toBe(true));
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(closeSheet).not.toHaveBeenCalled();
      expect(pageEscape).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();

      // With the confirm gone, Escape in the sheet still closes the sheet.
      screen.getByRole("button", { name: "Revoke" }).focus();
      await user.keyboard("{Escape}");
      expect(closeSheet).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("lets Escape through to an inner handler when the caller prevents default", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const innerEscape = vi.fn();
    render(
      <Dialog
        open
        onOpenChange={onOpenChange}
        title="With picker"
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <button type="button" onKeyDown={(event) => { if (event.key === "Escape") innerEscape(); }}>
          Picker
        </button>
      </Dialog>,
    );
    screen.getByRole("button", { name: "Picker" }).focus();
    await user.keyboard("{Escape}");
    expect(innerEscape).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("LaneDialogShell adapter", () => {
  it("uses the shared dialog surface and blocks dismissal while busy", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <LaneDialogShell
        open
        onOpenChange={onOpenChange}
        title="Create lane"
        description="Choose a branch."
        titleContent={<span>Custom lane heading</span>}
        headerExtra={<div>Lane details</div>}
        busy
        footer={<button type="button">Create</button>}
      >
        <button type="button">Choose branch</button>
      </LaneDialogShell>,
    );

    const dialog = screen.getByRole("dialog", { name: "Create lane" });
    expect(dialog.classList.contains("ade-dialog-panel")).toBe(true);
    expect(dialog.style.zIndex).toBe(String(Z_LAYERS.dialog));
    expect(screen.getByText("Custom lane heading")).toBeTruthy();
    expect(screen.getByText("Lane details")).toBeTruthy();

    const close = screen.getByRole("button", { name: "Close Create lane" });
    expect((close as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    await user.click(close);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("HeaderSheet placement", () => {
  it("portals the click-away layer to the viewport root", () => {
    const closeSheet = vi.fn();

    function Sheet() {
      const panelRef = useRef<HTMLDivElement>(null);
      return (
        <div style={{ position: "relative", zIndex: 20 }}>
          <HeaderSheet open panelRef={panelRef} title="Activity" bare onClose={closeSheet}>
            <button type="button">Open history</button>
          </HeaderSheet>
          <aside style={{ position: "relative", zIndex: 100 }}>Sidebar</aside>
        </div>
      );
    }

    render(<Sheet />);
    const panel = screen.getByRole("dialog", { name: "Activity" });
    const clickAwayLayer = panel.parentElement;

    expect(clickAwayLayer?.parentElement).toBe(document.body);
    fireEvent.click(clickAwayLayer!);
    expect(closeSheet).toHaveBeenCalledTimes(1);
  });
});

describe("Dialog outside interactions", () => {
  it("stays open when the user clicks a toast above it", async () => {
    const onOpenChange = vi.fn();
    const toasts = document.createElement("div");
    toasts.setAttribute("data-ade-toast-viewport", "");
    const toastAction = document.createElement("button");
    toasts.appendChild(toastAction);
    const elsewhere = document.createElement("button");
    document.body.append(toasts, elsewhere);

    try {
      render(
        <Dialog open onOpenChange={onOpenChange} title="Sign in">
          <button type="button">Continue</button>
        </Dialog>,
      );
      await screen.findByRole("dialog", { name: "Sign in" });

      fireEvent.pointerDown(toastAction);
      fireEvent.focusIn(toastAction);
      expect(onOpenChange).not.toHaveBeenCalled();

      fireEvent.pointerDown(elsewhere);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      toasts.remove();
      elsewhere.remove();
    }
  });
});

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

  it("withdraws the question when its signal aborts", async () => {
    render(<DialogHost />);
    const abort = new AbortController();
    const { result } = await open(() => confirmDialog({ title: "Cancel this launch?", signal: abort.signal }));
    expect(screen.getByRole("alertdialog", { name: "Cancel this launch?" })).toBeTruthy();
    act(() => abort.abort());
    await expect(result).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await expect(confirmDialog({ title: "Too late", signal: abort.signal })).resolves.toBe(false);
  });

  it("keeps an early request on the fallback until it settles", async () => {
    const user = userEvent.setup();
    const { result } = await open(() => confirmDialog({ title: "Startup confirmation?" }));

    const fallbackContainer = document.querySelector<HTMLElement>("[data-ade-dialog-host]");
    expect(fallbackContainer).not.toBeNull();
    expect(screen.getByRole("alertdialog", { name: "Startup confirmation?" })).toBeTruthy();

    const appHost = render(<DialogHost />);
    expect(fallbackContainer?.isConnected).toBe(true);
    expect(screen.getByRole("alertdialog", { name: "Startup confirmation?" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "OK" }));
    await expect(result).resolves.toBe(true);
    await waitFor(() => expect(fallbackContainer?.isConnected).toBe(false));
    appHost.unmount();
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
    const outer = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(outer?.getAttribute("aria-hidden")).toBe("true");
    expect(outer?.style.zIndex).toBe(String(Z_LAYERS.dialog));

    await user.keyboard("{Escape}");
    await expect(result).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
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

  it("preserves a prompt draft when the app host unmounts during a request", async () => {
    const user = userEvent.setup();
    const appHost = render(<DialogHost />);
    const { result } = await open(() => promptDialog({ title: "Branch name", defaultValue: "old" }));
    const input = screen.getByRole("textbox", { name: "Branch name" }) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "new branch");

    await act(async () => {
      appHost.unmount();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });
    const fallbackContainer = document.querySelector<HTMLElement>("[data-ade-dialog-host]");
    expect(fallbackContainer).not.toBeNull();
    const restoredInput = screen.getByRole("textbox", { name: "Branch name" }) as HTMLInputElement;
    expect(restoredInput.value).toBe("new branch");

    render(<DialogHost />);
    expect(fallbackContainer?.isConnected).toBe(true);
    const stillRestoredInput = screen.getByRole("textbox", { name: "Branch name" }) as HTMLInputElement;
    expect(stillRestoredInput.value).toBe("new branch");

    await user.click(screen.getByRole("button", { name: "OK" }));
    await expect(result).resolves.toBe("new branch");
    await waitFor(() => expect(fallbackContainer?.isConnected).toBe(false));
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

describe("host fallback", () => {
  it("mounts its own host when none is mounted", async () => {
    const user = userEvent.setup();
    const { result } = await open(() => confirmDialog({ title: "Cherry-pick abc123 onto this lane?" }));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Cherry-pick abc123 onto this lane?" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "OK" }));
    await expect(result).resolves.toBe(true);
  });
});
