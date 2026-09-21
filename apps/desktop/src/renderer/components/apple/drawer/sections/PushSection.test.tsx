/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PushSection } from "./PushSection";
import { installAdeMock, makeCtx } from "../drawerTestHarness";

afterEach(cleanup);

describe("PushSection", () => {
  it("renders the title, the Alert text input and Send", () => {
    installAdeMock();
    render(<PushSection ctx={makeCtx()} />);
    expect(screen.getByRole("heading", { name: "Push notification" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Alert text")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("sends to the foreground app through act and clears the field", async () => {
    const { iosSimulator } = installAdeMock();
    render(<PushSection ctx={makeCtx()} />);
    const input = screen.getByPlaceholderText("Alert text") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(iosSimulator.sendPushNotification).toHaveBeenCalledWith(
      { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null, bundleId: "com.acme.app", body: "Hello" },
      null,
    ));
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("disables the row with no foreground app and says why", () => {
    installAdeMock();
    render(<PushSection ctx={makeCtx({ foregroundApp: null })} />);
    expect((screen.getByPlaceholderText("Alert text") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Open an app first.")).toBeTruthy();
  });
});
