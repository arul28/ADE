/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { openExternalMcpSettings } from "./chatNavigation";

describe("openExternalMcpSettings", () => {
  it("pushes the integrations settings URL onto history", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState");

    openExternalMcpSettings();

    expect(pushStateSpy).toHaveBeenCalledWith(
      {},
      "",
      "/settings?tab=integrations&integration=managed-mcp",
    );

    pushStateSpy.mockRestore();
  });

  it("dispatches a popstate event so listeners can react", () => {
    const listener = vi.fn();
    window.addEventListener("popstate", listener);

    openExternalMcpSettings();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toBeInstanceOf(PopStateEvent);

    window.removeEventListener("popstate", listener);
  });
});
