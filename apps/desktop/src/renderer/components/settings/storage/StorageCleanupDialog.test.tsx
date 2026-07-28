/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { StorageDialogFrame } from "./StorageCleanupDialog";

afterEach(cleanup);

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
