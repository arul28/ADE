/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalRuntimeStatus } from "../../../shared/types";
import { AppFallbackBanner } from "./AppFallbackBanner";
import { AppBannerHost } from "../ui/notice";
import { resetAppBannersForTests } from "../ui/notice/appBannerStore";

describe("AppFallbackBanner", () => {
  const originalAde = globalThis.window.ade;

  afterEach(() => {
    cleanup();
    resetAppBannersForTests();
    window.localStorage.clear();
    if (originalAde === undefined) delete (globalThis.window as any).ade;
    else globalThis.window.ade = originalAde;
  });

  // While the desktop runs its own brain, the banner offers what can actually
  // end it. Reinstalling cannot flip macOS's "Allow in the Background", so that
  // cause has to lead with System Settings.
  it.each([
    { reason: "background_item_blocked", firstAction: "Open System Settings", opensSettings: true },
    { reason: "launchd_register", firstAction: "Fix it", opensSettings: false },
  ] as const)("offers the way out for $reason", async ({ reason, firstAction, opensSettings }) => {
    let pushStatus: ((status: LocalRuntimeStatus) => void) | null = null;
    const openBackgroundSettings = vi.fn(async () => ({ opened: true }));
    const restartBackgroundService = vi.fn(async () => undefined);
    (globalThis.window as any).ade = {
      app: {
        getInfo: vi.fn(async () => ({ localRuntime: { appFallback: null } })),
        onRuntimeStatusChanged: (listener: (status: LocalRuntimeStatus) => void) => {
          pushStatus = listener;
          return () => { pushStatus = null; };
        },
        restartBackgroundService,
      },
      recovery: { openBackgroundSettings },
    };

    render(<><AppFallbackBanner /><AppBannerHost /></>);
    expect(screen.queryByText("Phone sync is off")).toBeNull();
    await act(async () => {
      pushStatus!({ appFallback: { reason, since: "2026-10-07T08:00:00.000Z" } } as LocalRuntimeStatus);
    });

    expect(await screen.findByText("Phone sync is off")).toBeTruthy();
    const buttons = screen.getAllByRole("button").map((button) => button.textContent?.trim());
    expect(buttons).toContain(firstAction);
    expect(buttons.includes("Open System Settings")).toBe(opensSettings);

    fireEvent.click(screen.getByRole("button", { name: firstAction }));
    expect(openBackgroundSettings).toHaveBeenCalledTimes(opensSettings ? 1 : 0);
    expect(restartBackgroundService).toHaveBeenCalledTimes(opensSettings ? 0 : 1);
  });
});
