/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppleToolCardMenu } from "./AppleToolCardMenu";
import type { AppleLaneDeviceCard } from "./useAppleLaneDeviceCard";

const OFF_CLONE: AppleLaneDeviceCard = {
  name: "iPhone 17e",
  state: "off",
  laneId: "lane-1",
  udid: "udid-e",
  origin: "clone",
};

let ios: {
  deviceStart: ReturnType<typeof vi.fn>;
  deviceDetach: ReturnType<typeof vi.fn>;
  deviceDelete: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  ios = {
    deviceStart: vi.fn(async () => ({})),
    deviceDetach: vi.fn(async () => null),
    deviceDelete: vi.fn(async () => undefined),
  };
  (window as unknown as { ade: unknown }).ade = { iosSimulator: ios };
});

afterEach(cleanup);

function renderMenu(over: Partial<AppleLaneDeviceCard> = {}) {
  const onOpenTool = vi.fn();
  const onMutated = vi.fn();
  const { container } = render(
    <AppleToolCardMenu
      device={{ ...OFF_CLONE, ...over }}
      laneId="lane-1"
      chatSessionId="chat-1"
      runtimePin={null}
      onOpenTool={onOpenTool}
      onMutated={onMutated}
    />,
  );
  const trigger = container.querySelector("[data-apple-tool-card-menu]") as HTMLElement;
  // jsdom has no PointerEvent, so Radix's pointerdown open never fires; Enter
  // is the same open (the picker's own menu test does the same).
  const open = () => fireEvent.keyDown(trigger, { key: "Enter" });
  return { trigger, open, onOpenTool, onMutated };
}

/** The Radix menu item wrapping a label — the element `disabled` actually lives on. */
const menuItem = (label: string): HTMLElement =>
  screen.getByText(label).closest("[role='menuitem']") as HTMLElement;

describe("AppleToolCardMenu", () => {
  it("offers boot, release and clone-only delete on an off clone", () => {
    const { open } = renderMenu();
    open();

    expect(screen.getByText("Boot device")).toBeTruthy();
    expect(screen.getByText("Release device")).toBeTruthy();
    expect(screen.getByText("Delete device…")).toBeTruthy();
  });

  it("boots the lane's device, opens the tool, and asks the card to re-read", async () => {
    const { open, onOpenTool, onMutated } = renderMenu();
    open();

    fireEvent.click(screen.getByText("Boot device"));

    await waitFor(() => expect(ios.deviceStart).toHaveBeenCalledTimes(1));
    expect(ios.deviceStart).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: "chat-1", udid: "udid-e" },
      null,
    );
    await waitFor(() => expect(onOpenTool).toHaveBeenCalledTimes(1));
    expect(onMutated).toHaveBeenCalledTimes(1);
  });

  it("releases an off device in one click, lane-scoped", async () => {
    const { open } = renderMenu();
    open();

    fireEvent.click(screen.getByText("Release device"));

    await waitFor(() => expect(ios.deviceDetach).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: "chat-1", ignoreOwnership: true },
      null,
    ));
  });

  it("deletes a clone only after the confirmation row; a second click on the disabled row cannot delete", async () => {
    const { open } = renderMenu();
    open();

    fireEvent.click(screen.getByText("Delete device…"));
    expect(ios.deviceDelete).not.toHaveBeenCalled();
    // The idle row is disabled in place and the confirmation appears beneath
    // it, so a double-click's second click lands on the disabled row.
    expect(menuItem("Delete device…").getAttribute("data-disabled")).toBe("");
    fireEvent.click(menuItem("Delete device…"));
    expect(ios.deviceDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Delete for good"));
    await waitFor(() => expect(ios.deviceDelete).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: "chat-1", ignoreOwnership: true },
      null,
    ));
  });

  it("opens a running device instead of booting, and confirms before releasing a live session", async () => {
    const { open } = renderMenu({ state: "running" });
    open();

    expect(screen.getByText("Open in Apple Development")).toBeTruthy();
    expect(screen.queryByText("Boot device")).toBeNull();

    fireEvent.click(screen.getByText("Release device…"));
    expect(ios.deviceDetach).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("End session and release"));
    await waitFor(() => expect(ios.deviceDetach).toHaveBeenCalledTimes(1));
  });

  it("never offers delete for an attached simulator", () => {
    const { open } = renderMenu({ origin: "attached" });
    open();

    expect(screen.getByText("Release device")).toBeTruthy();
    expect(screen.queryByText("Delete device…")).toBeNull();
  });

  it("re-enables the trigger when a mutation rejects", async () => {
    ios.deviceDetach.mockRejectedValueOnce(new Error("owned by another session"));
    const { open, trigger } = renderMenu();
    open();

    fireEvent.click(screen.getByText("Release device"));

    await waitFor(() => expect(ios.deviceDetach).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
  });
});
