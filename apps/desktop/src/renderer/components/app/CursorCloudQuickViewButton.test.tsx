/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/appStore";
import { CursorCloudQuickViewButton } from "./CursorCloudQuickViewButton";

vi.mock("./CursorCloudFleetModal", () => ({
  CursorCloudFleetModal: () => <div data-testid="cursor-cloud-fleet-modal" />,
}));

function cursorStatus(authAvailable: boolean) {
  return {
    providerConnections: {
      cursor: { authAvailable },
    },
  };
}

describe("Cursor Cloud connection-gated shell entry point", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState({
      project: { rootPath: "/tmp/cursor-cloud-project", displayName: "Project" } as any,
      projectBinding: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hides every Cursor Cloud shell entry until the Cursor connection is authenticated", async () => {
    const getStatus = vi.fn().mockResolvedValue(cursorStatus(false));
    (window as any).ade = {
      ai: {
        getStatus,
        cursorCloudFleet: vi.fn(),
        onCursorCloudFleetEvent: vi.fn(() => () => {}),
      },
    };

    render(<CursorCloudQuickViewButton />);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Cursor Cloud fleet" })).toBeNull();
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("matches Linear's 20px top-bar shell size, padding, and active-state contract", async () => {
    const getStatus = vi.fn().mockResolvedValue(cursorStatus(true));
    (window as any).ade = {
      ai: {
        getStatus,
        cursorCloudFleet: vi.fn(),
        onCursorCloudFleetEvent: vi.fn(() => () => {}),
      },
    };

    render(<CursorCloudQuickViewButton />);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const button = screen.getByRole("button", { name: "Cursor Cloud fleet" });
    expect(button.className).toContain("h-[20px]");
    expect(button.className).toContain("w-[20px]");
    expect(button.className).toContain("ade-shell-control");
    expect(button.className).toContain("transition-[background-color,color,border-color,box-shadow]");
  });

  it("exposes the connected fleet through the left sidebar", async () => {
    const getStatus = vi.fn().mockResolvedValue(cursorStatus(true));
    (window as any).ade = {
      ai: {
        getStatus,
        cursorCloudFleet: vi.fn(),
        onCursorCloudFleetEvent: vi.fn(() => () => {}),
      },
    };

    render(<CursorCloudQuickViewButton variant="sidebar-row" />);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const button = screen.getByRole("button", { name: "Cursor Cloud fleet" });
    expect(button.className).toContain("ade-shell-sidebar-item");
    expect(screen.getByText("Cursor Cloud")).toBeTruthy();
  });
});
