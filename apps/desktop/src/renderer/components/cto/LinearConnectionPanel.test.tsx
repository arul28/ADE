/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { LinearConnectionPanel } from "./LinearConnectionPanel";

describe("LinearConnectionPanel", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    globalThis.window.ade = {
      cto: {
        getLinearConnectionStatus: vi.fn().mockResolvedValue({
          connected: true,
          tokenStored: true,
          authMode: "oauth",
          viewerName: "Taylor",
          message: null,
        }),
        getLinearProjects: vi.fn().mockRejectedValue(new Error("project list unavailable")),
      },
      app: {
        openExternal: vi.fn(),
      },
    } as any;
  });

  afterEach(() => {
    globalThis.window.ade = originalAde;
  });

  it("keeps a healthy connection state visible even when project loading fails", async () => {
    render(<LinearConnectionPanel />);
    const ade = window.ade as any;

    await waitFor(() => {
      expect(ade.cto.getLinearConnectionStatus).toHaveBeenCalledTimes(1);
      expect(ade.cto.getLinearProjects).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByText("Taylor (oauth)")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByText("Disconnected")).toBeNull();
  });
});
