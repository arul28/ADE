// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddCommandDialog, type AddCommandInitialValues } from "./AddCommandDialog";
import type { ProcessGroupDefinition } from "../../../shared/types";

afterEach(cleanup);

function deferredPromise() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const sampleGroups: ProcessGroupDefinition[] = [
  { id: "g-auto", name: "Automation" },
  { id: "g-local", name: "Local dev" },
  { id: "g-test", name: "Tests" },
];

function renderDialog(props: {
  onClose?: () => void;
  onSubmit?: Parameters<typeof AddCommandDialog>[0]["onSubmit"];
  groups?: ProcessGroupDefinition[];
  initialValues?: AddCommandInitialValues | null;
} = {}) {
  const onClose = props.onClose ?? vi.fn();
  const onSubmit = props.onSubmit ?? vi.fn();
  render(
    <AddCommandDialog
      groups={props.groups ?? []}
      lanes={[]}
      defaultLaneId={null}
      open
      onClose={onClose}
      onSubmit={onSubmit}
      initialValues={props.initialValues}
    />,
  );
  return { onClose, onSubmit };
}

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText("e.g. Dev server"), {
    target: { value: "Dev server" },
  });
  fireEvent.change(screen.getByPlaceholderText("e.g. npm run dev"), {
    target: { value: "npm run dev" },
  });
}

describe("AddCommandDialog", () => {
  it("waits for the async save before closing", async () => {
    const save = deferredPromise();
    const onSubmit = vi.fn(() => save.promise);
    const { onClose } = renderDialog({ onSubmit });

    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Add command" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Saving..." })).toBeTruthy();

    save.resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps the dialog open and shows the save error when submit fails", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("Could not save run configuration.");
    });
    const { onClose } = renderDialog({ onSubmit });

    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Add command" }));

    await waitFor(() => expect(screen.getByText("Could not save run configuration.")).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add command" })).toBeTruthy();
  });

  it("does not treat a text-selection click ending on the backdrop as a dismiss", () => {
    const { onClose } = renderDialog();
    const commandInput = screen.getByPlaceholderText("e.g. npm run dev");
    const backdrop = screen.getByTestId("add-command-dialog-backdrop");

    fireEvent.mouseDown(commandInput);
    fireEvent.click(backdrop);

    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lists current groups as chips when editing with groupIds", () => {
    const initialValues: AddCommandInitialValues = {
      name: "Server",
      command: "npm start",
      cwd: ".",
      env: "",
      autostart: false,
      gracefulShutdownMs: "7000",
      dependsOn: "",
      groupIds: ["g-auto", "g-local"],
    };
    renderDialog({ groups: sampleGroups, initialValues });

    expect(screen.getByText("Automation")).toBeTruthy();
    expect(screen.getByText("Local dev")).toBeTruthy();
    expect(screen.queryByText("Tests")).toBeNull();
  });

  it("adds an unassigned group via Add to group and submits groupIds", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initialValues: AddCommandInitialValues = {
      name: "Server",
      command: "npm start",
      cwd: ".",
      env: "",
      autostart: false,
      gracefulShutdownMs: "7000",
      dependsOn: "",
      groupIds: ["g-auto"],
    };
    renderDialog({ groups: sampleGroups, initialValues, onSubmit });

    fireEvent.click(screen.getByRole("button", { name: "Add to group" }));
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));

    fireEvent.click(screen.getByRole("button", { name: "Add command" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.groupIds).toEqual(["g-auto", "g-test"]);
  });

  it("removes a group when the chip remove control is used", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initialValues: AddCommandInitialValues = {
      name: "Server",
      command: "npm start",
      cwd: ".",
      env: "",
      autostart: false,
      gracefulShutdownMs: "7000",
      dependsOn: "",
      groupIds: ["g-auto", "g-local"],
    };
    renderDialog({ groups: sampleGroups, initialValues, onSubmit });

    fireEvent.click(screen.getByRole("button", { name: "Remove from Automation" }));

    fireEvent.click(screen.getByRole("button", { name: "Add command" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].groupIds).toEqual(["g-local"]);
  });
});
