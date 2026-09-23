/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalImagePasteNotice } from "./TerminalImagePasteNotice";

describe("TerminalImagePasteNotice", () => {
  afterEach(cleanup);

  it("shows the message as a status and dismisses on the button", () => {
    const onDismiss = vi.fn();
    render(<TerminalImagePasteNotice notice="Couldn't attach the image: no reason was given." onDismiss={onDismiss} />);

    expect(screen.getByRole("status").textContent).toContain("Couldn't attach the image: no reason was given.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss image paste message" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
