/* @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { dialogBus } from "./dialogBus";
import { useDialogBus } from "./useDialogBus";

describe("useDialogBus", () => {
  it("invokes onOpen when matching id fires", () => {
    const onOpen = vi.fn();
    renderHook(() => useDialogBus("lanes.create", { onOpen }));
    dialogBus.open("lanes.create", { foo: "bar" });
    expect(onOpen).toHaveBeenCalledWith({ foo: "bar" });
  });

  it("ignores events for a different id", () => {
    const onOpen = vi.fn();
    renderHook(() => useDialogBus("prs.create", { onOpen }));
    dialogBus.open("lanes.create");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("invokes onClose when close event fires", () => {
    const onClose = vi.fn();
    renderHook(() => useDialogBus("cto.onboarding", { onClose }));
    dialogBus.close("cto.onboarding");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on unmount", () => {
    const onOpen = vi.fn();
    const { unmount } = renderHook(() =>
      useDialogBus("automations.createTrigger", { onOpen }),
    );
    unmount();
    dialogBus.open("automations.createTrigger");
    expect(onOpen).not.toHaveBeenCalled();
  });
});
