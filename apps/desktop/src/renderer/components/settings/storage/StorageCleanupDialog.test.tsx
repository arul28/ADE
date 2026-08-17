/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StorageCleanupDialog, StorageDialogFrame } from "./StorageCleanupDialog";

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("StorageDialogFrame", () => {
  it("lets only the topmost dialog close on Escape", () => {
    const closeBack = vi.fn();
    const closeFront = vi.fn();
    const { rerender } = render(
      <>
        <StorageDialogFrame title="Back dialog" onClose={closeBack}>
          <button type="button">Back action</button>
        </StorageDialogFrame>
        <StorageDialogFrame title="Front dialog" onClose={closeFront}>
          <button type="button">Front action</button>
        </StorageDialogFrame>
      </>,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(closeFront).toHaveBeenCalledTimes(1);
    expect(closeBack).not.toHaveBeenCalled();

    rerender(
      <StorageDialogFrame title="Back dialog" onClose={closeBack}>
        <button type="button">Back action</button>
      </StorageDialogFrame>,
    );
    fireEvent.keyDown(window, { key: "Escape" });

    expect(closeBack).toHaveBeenCalledTimes(1);
  });

  it("does not close an underlying dialog when the topmost dialog cannot close", () => {
    const closeBack = vi.fn();
    const closeFront = vi.fn();
    render(
      <>
        <StorageDialogFrame title="Back dialog" onClose={closeBack}>
          <button type="button">Back action</button>
        </StorageDialogFrame>
        <StorageDialogFrame title="Front dialog" canClose={false} onClose={closeFront}>
          <button type="button">Front action</button>
        </StorageDialogFrame>
      </>,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(closeFront).not.toHaveBeenCalled();
    expect(closeBack).not.toHaveBeenCalled();
  });
});

describe("StorageCleanupDialog failures", () => {
  it("says which half of the job failed and offers a way to run it again", async () => {
    const cleanupPreview = vi
      .fn()
      .mockRejectedValueOnce(new Error("EPERM: operation not permitted, scandir"))
      .mockResolvedValueOnce({ items: [], blocked: [], totalBytes: 0 });
    (window as unknown as { ade?: unknown }).ade = {
      storage: { cleanupPreview, cleanup: vi.fn() },
    };

    render(
      <StorageCleanupDialog
        open
        title="Free up space"
        targets={[]}
        onClose={vi.fn()}
        onCleaned={vi.fn()}
      />,
    );

    // Naming the failed half is the point: nothing was removed, so the person
    // should not go hunting for half-deleted files.
    expect(await screen.findByText("ADE couldn't check what's safe to remove.")).toBeTruthy();
    expect(screen.getByText(/Nothing was removed/)).toBeTruthy();
    // The raw errno stays behind the fold rather than on the main line.
    const fold = screen.getByText("Show technical details").closest("details");
    expect(fold?.textContent).toContain("EPERM");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(cleanupPreview).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("ADE couldn't check what's safe to remove.")).toBeNull(),
    );
  });
});
