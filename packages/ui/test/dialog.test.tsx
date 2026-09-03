import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LaneDialogShell } from "../src/dialog";

// `border-beam` reads `prefers-reduced-motion` through `window.matchMedia`, which
// jsdom does not implement. Stub it rather than mocking the component away: the
// shell's job is to mount the real frame.
beforeAll(() => {
  if (typeof window.matchMedia === "function") return;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(cleanup);

describe("LaneDialogShell", () => {
  it("renders the title, description and children when open", () => {
    render(
      <LaneDialogShell open onOpenChange={() => {}} title="Create lane" description="Pick a base">
        <p>Body content</p>
      </LaneDialogShell>,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Create lane")).toBeTruthy();
    expect(screen.getByText("Pick a base")).toBeTruthy();
    expect(screen.getByText("Body content")).toBeTruthy();
  });

  it("renders a footer when one is given", () => {
    render(
      <LaneDialogShell
        open
        onOpenChange={() => {}}
        title="Create lane"
        footer={<button type="button">Create</button>}
      >
        <p>Body content</p>
      </LaneDialogShell>,
    );
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });

  it("renders nothing when closed", () => {
    render(
      <LaneDialogShell open={false} onOpenChange={() => {}} title="Create lane">
        <p>Body content</p>
      </LaneDialogShell>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Body content")).toBeNull();
  });

  it("closes through Esc when idle", async () => {
    const onOpenChange = vi.fn();
    render(
      <LaneDialogShell open onOpenChange={onOpenChange} title="Create lane">
        <p>Body content</p>
      </LaneDialogShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("blocks the close path while busy", async () => {
    const onOpenChange = vi.fn();
    render(
      <LaneDialogShell open busy onOpenChange={onOpenChange} title="Create lane">
        <p>Body content</p>
      </LaneDialogShell>,
    );
    const esc = screen.getByRole("button", { name: "Esc" });
    expect(esc.hasAttribute("disabled")).toBe(true);
    // Even the keyboard route is refused: `busy` gates `onOpenChange(false)`.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
