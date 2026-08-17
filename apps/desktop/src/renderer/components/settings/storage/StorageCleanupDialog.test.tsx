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

  it("shows the reopened dialog's preview when the abandoned read lands last", async () => {
    const deferred: Array<(value: unknown) => void> = [];
    const cleanupPreview = vi.fn(
      () => new Promise((resolve) => { deferred.push(resolve); }),
    );
    (window as unknown as { ade?: unknown }).ade = {
      storage: { cleanupPreview, cleanup: vi.fn() },
    };

    const props = {
      title: "Free up space",
      targets: [] as never[],
      onClose: vi.fn(),
      onCleaned: vi.fn(),
    };
    const { rerender } = render(<StorageCleanupDialog open {...props} />);
    await waitFor(() => expect(cleanupPreview).toHaveBeenCalledTimes(1));

    // Close before the first read answers, then reopen: a second read starts.
    rerender(<StorageCleanupDialog open={false} {...props} />);
    rerender(<StorageCleanupDialog open {...props} />);
    await waitFor(() => expect(cleanupPreview).toHaveBeenCalledTimes(2));

    // The reopened dialog's read answers first, the abandoned one answers last.
    deferred[1]({
      items: [{ path: "/tmp/fresh.log", label: "fresh.log", bytes: 10 }],
      blocked: [],
      totalBytes: 10,
    });
    await screen.findByText("fresh.log");

    deferred[0]({
      items: [{ path: "/tmp/stale.log", label: "stale.log", bytes: 99 }],
      blocked: [],
      totalBytes: 99,
    });

    // The stale answer must not repaint the dialog — it stays on the fresh
    // review rather than falling back to a spinner or the abandoned list.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Remove 1 item/ })).toBeTruthy(),
    );
    expect(screen.queryByText("stale.log")).toBeNull();
    expect(screen.getByText("fresh.log")).toBeTruthy();
  });

  it("ignores a cleanup completion after close and reopen", async () => {
    const previews: Array<(value: unknown) => void> = [];
    const cleanupPreview = vi.fn(() => new Promise((resolve) => { previews.push(resolve); }));
    const cleanups: Array<(value: unknown) => void> = [];
    const cleanupCall = vi.fn(() => new Promise((resolve) => { cleanups.push(resolve); }));
    (window as unknown as { ade?: unknown }).ade = {
      storage: { cleanupPreview, cleanup: cleanupCall },
    };

    const onCleaned = vi.fn();
    const props = {
      title: "Free up space",
      targets: [] as never[],
      onClose: vi.fn(),
      onCleaned,
    };
    const { rerender } = render(<StorageCleanupDialog open {...props} />);
    await waitFor(() => expect(cleanupPreview).toHaveBeenCalledTimes(1));
    previews[0]({
      items: [{ path: "/tmp/first.log", label: "first.log", bytes: 10 }],
      blocked: [],
      totalBytes: 10,
    });
    await screen.findByText("first.log");

    // Start the removal, then close and reopen before it answers.
    fireEvent.click(screen.getByRole("button", { name: /Remove 1 item/ }));
    await waitFor(() => expect(cleanupCall).toHaveBeenCalledTimes(1));
    rerender(<StorageCleanupDialog open={false} {...props} />);
    rerender(<StorageCleanupDialog open {...props} />);
    await waitFor(() => expect(cleanupPreview).toHaveBeenCalledTimes(2));
    previews[1]({
      items: [{ path: "/tmp/second.log", label: "second.log", bytes: 20 }],
      blocked: [],
      totalBytes: 20,
    });
    await screen.findByText("second.log");

    // The abandoned removal answers last: it must not settle the reopened
    // dialog to "done", and must not report a result for a job nobody is
    // looking at any more.
    cleanups[0]({ removed: ["/tmp/first.log"], failed: [], freedBytes: 10 });
    await waitFor(() => expect(cleanupCall).toHaveBeenCalledTimes(1));

    expect(onCleaned).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Remove 1 item/ })).toBeTruthy();
    expect(screen.getByText("second.log")).toBeTruthy();
  });
});
