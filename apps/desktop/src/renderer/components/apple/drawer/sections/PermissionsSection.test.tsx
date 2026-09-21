/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PermissionsSection } from "./PermissionsSection";
import { installAdeMock, makeActions, makeCtx } from "../drawerTestHarness";

afterEach(cleanup);

describe("PermissionsSection", () => {
  it("renders the title, the app id input, the permission menu and Grant / Revoke / Reset", () => {
    installAdeMock();
    render(<PermissionsSection ctx={makeCtx()} />);
    expect(screen.getByRole("heading", { name: "Permissions" })).toBeTruthy();
    expect((screen.getByLabelText("App ID") as HTMLInputElement).placeholder).toBe("com.acme.app");
    expect(screen.getByRole("button", { name: "Permission" }).textContent).toContain("Photos");
    expect(screen.getByRole("button", { name: "Grant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
  });

  it("falls back to the foreground app and sends the decision through act", async () => {
    const { iosSimulator } = installAdeMock();
    render(<PermissionsSection ctx={makeCtx()} />);
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    await waitFor(() => expect(iosSimulator.setPermission).toHaveBeenCalledWith(
      { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null, bundleId: "com.acme.app", service: "photos", action: "grant" },
      null,
    ));
    fireEvent.change(screen.getByLabelText("App ID"), { target: { value: "com.other" } });
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(iosSimulator.setPermission).toHaveBeenLastCalledWith(
      expect.objectContaining({ bundleId: "com.other", action: "revoke" }),
      null,
    ));
  });

  it("disables Grant and Revoke with no app but keeps Reset, which is device-wide", () => {
    installAdeMock();
    render(<PermissionsSection ctx={makeCtx({ foregroundApp: null })} />);
    expect((screen.getByLabelText("App ID") as HTMLInputElement).placeholder).toBe("App ID");
    expect((screen.getByRole("button", { name: "Grant" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Revoke" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables everything while pending", () => {
    installAdeMock();
    render(<PermissionsSection ctx={makeCtx({ actions: makeActions({ disabled: true }) })} />);
    for (const name of ["Grant", "Revoke", "Reset", "Permission"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
