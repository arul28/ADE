/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InspectSection } from "./InspectSection";
import { installAdeMock, makeCtx } from "../drawerTestHarness";
import type { IosSimulatorSnapshotElement } from "../../appleInspectGeometry";

afterEach(cleanup);

const NODE = {
  id: "el-1",
  identifier: "signin-button",
  label: "Sign in",
  role: "button",
  elementType: "Button",
  frame: { x: 10, y: 20, width: 100, height: 44 },
  sourceFile: "Views/SignIn.swift",
  sourceLine: 12,
} as unknown as IosSimulatorSnapshotElement;

describe("InspectSection", () => {
  it("renders the title and the one switch, off with a hint", () => {
    installAdeMock();
    render(<InspectSection ctx={makeCtx()} enabled={false} setEnabled={vi.fn()} selected={null} />);
    expect(screen.getByRole("heading", { name: "Inspect" })).toBeTruthy();
    const overlay = screen.getByRole("switch", { name: "Overlay element frames" });
    expect(overlay.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Turn the overlay on, then click a frame.")).toBeTruthy();
    expect(screen.queryByTestId("apple-drawer-inspect-details")).toBeNull();
  });

  it("toggles the overlay through the pane's setter", () => {
    installAdeMock();
    const setEnabled = vi.fn();
    render(<InspectSection ctx={makeCtx()} enabled={false} setEnabled={setEnabled} selected={null} />);
    fireEvent.click(screen.getByRole("switch", { name: "Overlay element frames" }));
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("shows the selected node's details in the row grid and offers the two verbs", () => {
    const { app } = installAdeMock();
    const onInsertDraft = vi.fn();
    render(<InspectSection ctx={makeCtx()} enabled setEnabled={vi.fn()} selected={NODE} onInsertDraft={onInsertDraft} />);
    const details = screen.getByTestId("apple-drawer-inspect-details");
    for (const label of ["Label", "Role", "Identifier", "Ref", "Frame", "Source"]) {
      expect(details.textContent).toContain(label);
    }
    expect(details.textContent).toContain("Sign in");
    expect(details.textContent).toContain("signin-button");
    expect(details.textContent).toContain("10,20 100×44");
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(app.writeClipboardText).toHaveBeenCalledWith(expect.stringContaining("signin-button"));
    fireEvent.click(screen.getByRole("button", { name: "Insert into chat" }));
    expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("Sign in"));
  });

  it("disables Insert into chat when the host has no composer, never hiding it", () => {
    installAdeMock();
    render(<InspectSection ctx={makeCtx()} enabled setEnabled={vi.fn()} selected={NODE} />);
    expect((screen.getByRole("button", { name: "Insert into chat" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables the switch when the drawer is hidden", () => {
    installAdeMock();
    render(<InspectSection ctx={makeCtx({ visible: false })} enabled={false} setEnabled={vi.fn()} selected={null} />);
    expect((screen.getByRole("switch", { name: "Overlay element frames" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
