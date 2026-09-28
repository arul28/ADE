/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";

/* ---------------------------------------------------------------------------
 * Picking a machine in the create-lane dialog only chooses where the lane
 * goes (every lane API call after that carries that machine's pin); it never
 * rebinds the app or window. These tests cover
 * what is left with no UI of its own: the configure-for-chat path, which
 * hands a validated recipe back instead of creating, and offers no machine
 * picker at all.
 * ------------------------------------------------------------------------- */

const localBinding: OpenProjectBinding = {
  kind: "local",
  key: "/Users/admin/Projects/ADE",
  rootPath: "/Users/admin/Projects/ADE",
  displayName: "ADE",
};

const storeState: Record<string, unknown> = {};

function resetStore() {
  Object.assign(storeState, {
    lanes: [],
    refreshLanes: vi.fn(async () => {}),
    project: { rootPath: localBinding.rootPath, displayName: "ADE" },
    projectBinding: localBinding,
    openProjectTabRoots: [localBinding.rootPath],
  });
}

vi.mock("../../state/appStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
  selectActiveProjectRoot: (state: Record<string, unknown>) =>
    (state.project as { rootPath?: string } | null)?.rootPath ?? null,
  // useLaneMachineChoice reads the cross-machine lane union off the root
  // store. Nothing here pins a machine ahead of the picker, so the empty map
  // is the honest fixture.
  useRootAppStore: (selector: (state: { crossMachineLanesByMachineId: Record<string, unknown> }) => unknown) =>
    selector({ crossMachineLanesByMachineId: {} }),
}));

vi.mock("./CreateLaneDialog", () => ({
  CreateLaneDialog: (props: {
    onSelectMachine?: (machineId: string) => void;
    machines?: { id: string; name: string }[];
    error?: string | null;
    onSubmit?: () => void;
    submitLabelOverride?: string | null;
  }) => (
    <div>
      {(props.machines ?? []).map((machine) => (
        <button
          key={machine.id}
          type="button"
          onClick={() => props.onSelectMachine?.(machine.id)}
        >
          {`pick:${machine.name}`}
        </button>
      ))}
      {props.error ? <span>{`error:${props.error}`}</span> : null}
      <button type="button" onClick={() => props.onSubmit?.()}>
        {props.submitLabelOverride ?? "submit"}
      </button>
    </div>
  ),
}));

import { CreateLaneDialogHost } from "./CreateLaneDialogHost";

beforeEach(() => {
  resetStore();
  (globalThis as { window: Window & { ade?: unknown } }).window.ade = {
    lanes: {
      onEnvEvent: () => () => {},
      listTemplates: async () => [],
      getDefaultTemplate: async () => null,
    },
    remoteRuntime: {
      getConnectionSnapshot: async () => ({
        updatedAt: 1,
        connections: [
          {
            state: "connected",
            target: { id: "target-1", name: "MacBook Pro (97)", hostname: "mbp" },
            version: "1.0.0",
            projects: [
              {
                projectId: "project-ade",
                rootPath: "/Users/other/Projects/ADE",
                displayName: "ADE",
                gitOriginUrl: null,
              },
            ],
          },
        ],
      }),
      onConnectionSnapshotChanged: () => () => {},
    },
  } as never;
});

afterEach(cleanup);

describe("CreateLaneDialogHost configure-for-chat", () => {
  it("hands the validated recipe back instead of creating a lane", async () => {
    const onConfigured = vi.fn();
    render(
      <CreateLaneDialogHost
        open
        onOpenChange={vi.fn()}
        behavior="configure-for-chat"
        prefill={{ name: "Payments cleanup" }}
        onConfigured={onConfigured}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Use this setup" }));

    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1));
    expect(onConfigured).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "root", name: "Payments cleanup" }),
    );
  });

  it("offers no machine picker while configuring a draft", async () => {
    render(<CreateLaneDialogHost open onOpenChange={vi.fn()} behavior="configure-for-chat" />);
    await screen.findByRole("button", { name: "Use this setup" });
    expect(screen.queryByText("pick:MacBook Pro (97)")).toBeNull();
  });
});
