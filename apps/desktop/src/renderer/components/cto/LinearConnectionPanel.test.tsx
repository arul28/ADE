// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LinearConnectionPanel } from "./LinearConnectionPanel";

function buildBridge() {
  return {
    cto: {
      getLinearConnectionStatus: vi.fn(async () => ({
        tokenStored: true,
        connected: false,
        viewerId: null,
        viewerName: null,
        checkedAt: "2026-03-05T00:00:00.000Z",
        message: "Linear connection lost.",
      })),
      getLinearProjects: vi.fn(async () => [
        { id: "project-1", name: "My Project", slug: "my-project", teamName: "Platform" },
      ]),
      setLinearToken: vi.fn(async () => ({
        tokenStored: true,
        connected: true,
        viewerId: "viewer-1",
        viewerName: "Alex",
        checkedAt: "2026-03-05T00:00:00.000Z",
        message: null,
      })),
      clearLinearToken: vi.fn(async () => ({
        tokenStored: false,
        connected: false,
        viewerId: null,
        viewerName: null,
        checkedAt: "2026-03-05T00:00:00.000Z",
        message: "Disconnected.",
      })),
    },
  };
}

describe("LinearConnectionPanel", () => {
  beforeEach(() => {
    (window as any).ade = buildBridge();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows reconnect state when a stored token is degraded", async () => {
    render(<LinearConnectionPanel />);

    await waitFor(() => {
      expect(screen.getByText("Linear connection lost.")).toBeTruthy();
    });
    expect(screen.getByText("Degraded")).toBeTruthy();
  });

  it("validates a token and loads projects", async () => {
    render(<LinearConnectionPanel />);

    await waitFor(() => expect(screen.getByPlaceholderText("lin_api_...")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("lin_api_..."), { target: { value: "lin_api_test" } });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));

    await waitFor(() => {
      expect((window as any).ade.cto.setLinearToken).toHaveBeenCalledWith({ token: "lin_api_test" });
      expect(screen.getByText(/Connected as/)).toBeTruthy();
      expect(screen.getByText("My Project")).toBeTruthy();
    });
  });
});
