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
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Cursor Cloud fleet" })).toBeNull();
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("rechecks when two remote hosts expose the same project root", async () => {
    const getStatus = vi.fn()
      .mockResolvedValueOnce(cursorStatus(false))
      .mockResolvedValueOnce(cursorStatus(true));
    (window as any).ade = {
      ai: {
        getStatus,
        cursorCloudFleet: vi.fn(),
        onCursorCloudFleetEvent: vi.fn(() => () => {}),
      },
    };
    useAppStore.setState({
      projectBinding: {
        kind: "remote",
        key: "remote:host-a:project",
        rootPath: "/tmp/cursor-cloud-project",
      },
    } as any);

    render(<CursorCloudQuickViewButton />);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Cursor Cloud fleet" })).toBeNull();

    await act(async () => {
      useAppStore.setState({
        projectBinding: {
          kind: "remote",
          key: "remote:host-b:project",
          rootPath: "/tmp/cursor-cloud-project",
        },
      } as any);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Cursor Cloud fleet" })).toBeTruthy();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});
