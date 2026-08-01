/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";

/* ---------------------------------------------------------------------------
 * The dialog host rebinds the whole app when a machine is picked. These tests
 * pin the part of that contract that has no UI of its own: closing the dialog
 * without creating a lane must put the binding back.
 * ------------------------------------------------------------------------- */

const localBinding: OpenProjectBinding = {
  kind: "local",
  key: "/Users/admin/Projects/ADE",
  rootPath: "/Users/admin/Projects/ADE",
  displayName: "ADE",
};

const remoteBinding: OpenProjectBinding = {
  kind: "remote",
  key: "remote:target-1:project-ade",
  targetId: "target-1",
  runtimeName: "MacBook Pro (97)",
  projectId: "project-ade",
  rootPath: "/Users/other/Projects/ADE",
  displayName: "ADE",
};

const switchRemoteProject = vi.fn(async () => ({}) as never);
const switchProjectToPath = vi.fn(async () => {});

const storeState: Record<string, unknown> = {};

function resetStore() {
  Object.assign(storeState, {
    lanes: [],
    refreshLanes: vi.fn(async () => {}),
    project: { rootPath: localBinding.rootPath, displayName: "ADE" },
    projectBinding: localBinding,
    openProjectTabRoots: [localBinding.rootPath],
    switchRemoteProject,
    switchProjectToPath,
  });
}

vi.mock("../../state/appStore", () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
  selectActiveProjectRoot: (state: Record<string, unknown>) =>
    (state.project as { rootPath?: string } | null)?.rootPath ?? null,
}));

vi.mock("./CreateLaneDialog", () => ({
  CreateLaneDialog: (props: {
    onSelectMachine?: (machineId: string) => void;
    machines?: { id: string; name: string }[];
    error?: string | null;
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
    </div>
  ),
}));

import { CreateLaneDialogHost } from "./CreateLaneDialogHost";

beforeEach(() => {
  resetStore();
  switchRemoteProject.mockClear();
  switchProjectToPath.mockClear();
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

describe("CreateLaneDialogHost machine binding", () => {
  it("restores the binding when the dialog is closed without creating a lane", async () => {
    const view = render(
      <CreateLaneDialogHost open onOpenChange={vi.fn()} behavior="close-on-create" />,
    );

    fireEvent.click(await screen.findByText("pick:MacBook Pro (97)"));
    await waitFor(() =>
      expect(switchRemoteProject).toHaveBeenCalledWith("target-1", "project-ade"),
    );

    // The rebind landed: the app is now on the other machine.
    storeState.projectBinding = remoteBinding;
    view.rerender(
      <CreateLaneDialogHost open={false} onOpenChange={vi.fn()} behavior="close-on-create" />,
    );

    await waitFor(() =>
      expect(switchProjectToPath).toHaveBeenCalledWith(localBinding.rootPath),
    );
  });

  it("leaves the binding alone when the dialog is closed without switching machines", async () => {
    const view = render(
      <CreateLaneDialogHost open onOpenChange={vi.fn()} behavior="close-on-create" />,
    );
    await screen.findByText("pick:This computer");

    view.rerender(
      <CreateLaneDialogHost open={false} onOpenChange={vi.fn()} behavior="close-on-create" />,
    );

    expect(switchProjectToPath).not.toHaveBeenCalled();
    expect(switchRemoteProject).not.toHaveBeenCalled();
  });

  it("restores after an in-flight machine switch settles after close", async () => {
    let resolveSwitch!: () => void;
    switchRemoteProject.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSwitch = resolve; }) as never,
    );
    const view = render(
      <CreateLaneDialogHost open onOpenChange={vi.fn()} behavior="close-on-create" />,
    );
    fireEvent.click(await screen.findByText("pick:MacBook Pro (97)"));
    view.rerender(
      <CreateLaneDialogHost open={false} onOpenChange={vi.fn()} behavior="close-on-create" />,
    );
    expect(switchProjectToPath).not.toHaveBeenCalled();

    storeState.projectBinding = remoteBinding;
    view.rerender(
      <CreateLaneDialogHost open={false} onOpenChange={vi.fn()} behavior="close-on-create" />,
    );
    resolveSwitch();

    await waitFor(() =>
      expect(switchProjectToPath).toHaveBeenCalledWith(localBinding.rootPath),
    );
  });
});
