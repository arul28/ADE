/* @vitest-environment jsdom */

import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeaderSheet } from "../../app/HeaderSheet";
import { Dialog } from "./Dialog";
import { __resetDialogRequestsForTests } from "./confirm";

afterEach(() => {
  act(() => __resetDialogRequestsForTests());
  cleanup();
});

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
