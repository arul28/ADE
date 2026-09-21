/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IosScreenElement } from "../../../shared/types/iosSimulator";
import { AppleInspectPanel } from "./AppleInspectPanel";
import { commandFor, inspectContextFor, type IosSimulatorSnapshotElement } from "./appleInspectGeometry";

function makeElement(overrides: Partial<IosScreenElement> & Pick<IosScreenElement, "id" | "frame">): IosSimulatorSnapshotElement {
  const frame = overrides.frame;
  return {
    source: "ade-inspector",
    layer: "app",
    label: "Sign in",
    value: null,
    role: "button",
    elementType: "Button",
    identifier: "signInButton",
    pixelFrame: {
      x: frame.x * 3,
      y: frame.y * 3,
      width: frame.width * 3,
      height: frame.height * 3,
    },
    componentId: "SignInButton",
    sourceFile: "SignInView.swift",
    sourceLine: 42,
    metadata: {},
    ...overrides,
    frame,
  };
}

const form = makeElement({
  id: "form",
  label: "Form",
  role: "form",
  identifier: null,
  componentId: null,
  sourceFile: null,
  sourceLine: null,
  frame: { x: 0, y: 0, width: 390, height: 400 },
});

const signIn = makeElement({
  id: "sign-in",
  frame: { x: 24, y: 200, width: 327, height: 50 },
});

afterEach(() => {
  cleanup();
});

describe("AppleInspectPanel", () => {
  it("copies the command and inserts inspect context for the selected node", () => {
    const onCopyCommand = vi.fn();
    const onInsertIntoChat = vi.fn();
    const onRefresh = vi.fn();
    const onSelect = vi.fn();

    render(
      <AppleInspectPanel
        elements={[form, signIn]}
        selectedRef="sign-in"
        onSelect={onSelect}
        onCopyCommand={onCopyCommand}
        onInsertIntoChat={onInsertIntoChat}
        refreshing={false}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByTestId("apple-inspect-copy"));
    expect(onCopyCommand).toHaveBeenCalledWith(commandFor(signIn));

    fireEvent.click(screen.getByTestId("apple-inspect-insert"));
    expect(onInsertIntoChat).toHaveBeenCalledWith(inspectContextFor(signIn, [form, signIn]));

    fireEvent.click(screen.getByTestId("apple-inspect-refresh"));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("treeitem", { name: "Form" }));
    expect(onSelect).toHaveBeenCalledWith("form");
  });

  it("spins Refresh while a snapshot is in flight and holds actions with no selection", () => {
    render(
      <AppleInspectPanel
        elements={[signIn]}
        selectedRef={null}
        onSelect={vi.fn()}
        onCopyCommand={vi.fn()}
        onInsertIntoChat={vi.fn()}
        refreshing
        onRefresh={vi.fn()}
      />,
    );

    expect((screen.getByTestId("apple-inspect-refresh") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("apple-inspect-copy") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("apple-inspect-insert") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("apple-inspect-refresh").querySelector(".animate-spin")).not.toBeNull();
  });
});
