/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppSection } from "./AppSection";
import { controlsIn, installAdeMock, makeActions, makeCtx } from "../drawerTestHarness";

afterEach(cleanup);

describe("AppSection", () => {
  it("renders the title, the foreground row, both verbs and both submit rows", () => {
    installAdeMock();
    render(<AppSection ctx={makeCtx()} />);
    expect(screen.getByRole("heading", { name: "App" })).toBeTruthy();
    expect(screen.getByText("Foreground")).toBeTruthy();
    expect(screen.getByTestId("apple-drawer-foreground").textContent).toBe("com.acme.app");
    expect(screen.getByRole("button", { name: "Relaunch" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Terminate" })).toBeTruthy();
    expect(screen.getByPlaceholderText("https://… or myapp://")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Bundle ID")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Launch" })).toBeTruthy();
  });

  it("shows — and disables Relaunch/Terminate with no foreground app, never hiding them", () => {
    installAdeMock();
    render(<AppSection ctx={makeCtx({ foregroundApp: null })} />);
    expect(screen.getByTestId("apple-drawer-foreground").textContent).toBe("—");
    expect((screen.getByRole("button", { name: "Relaunch" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Terminate" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText("https://… or myapp://") as HTMLInputElement).disabled).toBe(false);
  });

  it("disables every control while an action is pending", () => {
    installAdeMock();
    render(<AppSection ctx={makeCtx({ actions: makeActions({ disabled: true, pending: true }) })} />);
    for (const control of controlsIn(screen.getByTestId("apple-drawer-app"))) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("opens a URL through act and clears the field on success", async () => {
    const { iosSimulator } = installAdeMock();
    const ctx = makeCtx();
    render(<AppSection ctx={ctx} />);
    const input = screen.getByPlaceholderText("https://… or myapp://") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "myapp://home" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(iosSimulator.openUrl).toHaveBeenCalledWith(
      { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null, url: "myapp://home" },
      null,
    ));
    await waitFor(() => expect(input.value).toBe(""));
    expect(ctx.actions.act).toHaveBeenCalledTimes(1);
  });

  it("launching a bundle id makes it the foreground app", async () => {
    const { iosSimulator } = installAdeMock();
    const ctx = makeCtx({ foregroundApp: null });
    render(<AppSection ctx={ctx} />);
    fireEvent.change(screen.getByPlaceholderText("Bundle ID"), { target: { value: "com.acme.two" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(iosSimulator.launch).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-1", bundleId: "com.acme.two", build: false, openDrawer: false }),
      null,
    ));
    await waitFor(() => expect(ctx.setForegroundApp).toHaveBeenCalledWith("com.acme.two"));
  });

  it("relaunches and terminates the foreground app", async () => {
    const { iosSimulator } = installAdeMock();
    render(<AppSection ctx={makeCtx()} />);
    fireEvent.click(screen.getByRole("button", { name: "Relaunch" }));
    await waitFor(() => expect(iosSimulator.relaunchApp).toHaveBeenCalledWith(expect.objectContaining({ bundleId: "com.acme.app" }), null));
    fireEvent.click(screen.getByRole("button", { name: "Terminate" }));
    await waitFor(() => expect(iosSimulator.terminateApp).toHaveBeenCalledWith(expect.objectContaining({ bundleId: "com.acme.app" }), null));
    vi.clearAllMocks();
  });
});
