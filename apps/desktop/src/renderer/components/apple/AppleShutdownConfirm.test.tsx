/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AppleShutdownConfirmHost,
  askAppleShutdownConfirm,
  confirmAppleToolClose,
  getAppleShutdownConfirmRequest,
  resetAppleShutdownConfirmForTests,
} from "./AppleShutdownConfirm";

function installDeviceList(result: unknown) {
  const deviceList = vi.fn(async () => result);
  (window as unknown as { ade: unknown }).ade = { iosSimulator: { deviceList } };
  return deviceList;
}

const BOOTED = {
  lane: { udid: "UDID-1", name: "ADE Repro", runtime: "iOS 26.2", family: "iphone" },
  installed: [{ udid: "UDID-1", state: "Booted" }],
};

beforeEach(() => {
  resetAppleShutdownConfirmForTests();
  (window as unknown as { ade?: unknown }).ade = undefined;
});

afterEach(() => {
  cleanup();
  resetAppleShutdownConfirmForTests();
});

describe("confirmAppleToolClose", () => {
  it("asks nothing, and resolves true, when there is nothing booted to power off", async () => {
    installDeviceList({ ...BOOTED, installed: [{ udid: "UDID-1", state: "Shutdown" }] });
    await expect(confirmAppleToolClose({ laneId: "lane-1" })).resolves.toBe(true);
    expect(getAppleShutdownConfirmRequest()).toBeNull();
  });

  it("asks nothing with no lane, no device and no simulator API", async () => {
    await expect(confirmAppleToolClose({ laneId: null })).resolves.toBe(true);
    await expect(confirmAppleToolClose({ laneId: "lane-1" })).resolves.toBe(true);
    installDeviceList({ lane: null, installed: [] });
    await expect(confirmAppleToolClose({ laneId: "lane-1" })).resolves.toBe(true);
    expect(getAppleShutdownConfirmRequest()).toBeNull();
  });

  it("closes anyway when the runtime cannot answer: an unreachable Mac must not pin a tab open", async () => {
    const deviceList = vi.fn(async () => { throw new Error("offline"); });
    (window as unknown as { ade: unknown }).ade = { iosSimulator: { deviceList } };
    await expect(confirmAppleToolClose({ laneId: "lane-1" })).resolves.toBe(true);
    expect(getAppleShutdownConfirmRequest()).toBeNull();
  });

  it("asks, by name, when the lane's device is booted", async () => {
    installDeviceList(BOOTED);
    const answer = confirmAppleToolClose({ laneId: "lane-1" });
    await waitFor(() => expect(getAppleShutdownConfirmRequest()?.deviceName).toBe("ADE Repro"));
    act(() => { getAppleShutdownConfirmRequest()?.resolve(false); resetAppleShutdownConfirmForTests(); });
    await expect(answer).resolves.toBe(false);
  });

  it("refuses a second question rather than stacking two dialogs", async () => {
    void askAppleShutdownConfirm("ADE Repro");
    await expect(askAppleShutdownConfirm("Other")).resolves.toBe(false);
    expect(getAppleShutdownConfirmRequest()?.deviceName).toBe("ADE Repro");
  });
});

describe("AppleShutdownConfirmHost", () => {
  it("renders nothing until something asks", () => {
    const { container } = render(<AppleShutdownConfirmHost />);
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("apple-shutdown-confirm")).toBeNull();
  });

  it("is ADE's own dialog, with the copy §B3 specifies", async () => {
    render(<AppleShutdownConfirmHost />);
    const answer = askAppleShutdownConfirm("ADE Repro");
    const dialog = await screen.findByTestId("apple-shutdown-confirm");
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { name: "Shut down ADE Repro?" })).toBeTruthy();
    expect(screen.getByText("Closing this tab powers off the simulator.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close and shut down" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await answer;
  });

  it("resolves true on Close and shut down, and takes itself off screen", async () => {
    render(<AppleShutdownConfirmHost />);
    const answer = askAppleShutdownConfirm("ADE Repro");
    await screen.findByTestId("apple-shutdown-confirm");
    fireEvent.click(screen.getByRole("button", { name: "Close and shut down" }));
    await expect(answer).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByTestId("apple-shutdown-confirm")).toBeNull());
  });

  it("resolves false on Cancel, on Escape, and on a click outside", async () => {
    render(<AppleShutdownConfirmHost />);

    const cancelled = askAppleShutdownConfirm("ADE Repro");
    await screen.findByTestId("apple-shutdown-confirm");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(cancelled).resolves.toBe(false);

    const escaped = askAppleShutdownConfirm("ADE Repro");
    await screen.findByTestId("apple-shutdown-confirm");
    fireEvent.keyDown(window, { key: "Escape" });
    await expect(escaped).resolves.toBe(false);

    const dismissed = askAppleShutdownConfirm("ADE Repro");
    await screen.findByTestId("apple-shutdown-confirm");
    // The shared Dialog's scrim: a pointer-down outside the panel dismisses.
    fireEvent.pointerDown(document.body);
    await expect(dismissed).resolves.toBe(false);
  });

  it("puts focus on the answer the user came to give", async () => {
    render(<AppleShutdownConfirmHost />);
    const answer = askAppleShutdownConfirm("ADE Repro");
    await screen.findByTestId("apple-shutdown-confirm");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Close and shut down"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await answer;
  });
});
