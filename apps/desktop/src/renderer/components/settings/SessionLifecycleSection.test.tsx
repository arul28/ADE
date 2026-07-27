/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionLifecycleSection } from "./SessionLifecycleSection";

afterEach(() => {
  cleanup();
  delete (window as any).ade;
});

describe("SessionLifecycleSection", () => {
  it("loads the persisted default and saves an explicit opt-out", async () => {
    const sessions = {
      getLifecycleSettings: vi.fn(async () => ({
        autoSettleLaneSessionsOnPrMerge: true,
      })),
      updateLifecycleSettings: vi.fn(async () => ({
        autoSettleLaneSessionsOnPrMerge: false,
      })),
    };
    (window as any).ade = { sessions };

    render(<SessionLifecycleSection />);

    const toggle = await screen.findByRole("switch", {
      name: "Auto-settle sessions when lane PR merges",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    await waitFor(() => expect(sessions.updateLifecycleSettings).toHaveBeenCalledWith({
      autoSettleLaneSessionsOnPrMerge: false,
    }));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
