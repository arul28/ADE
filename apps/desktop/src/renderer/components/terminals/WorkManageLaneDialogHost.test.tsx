/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { useAppStore, type CrossMachineMachineLanes } from "../../state/appStore";
import { foreignLaneKey } from "../../state/laneMachineRouting";
import type * as ManageLaneDialogModule from "../lanes/ManageLaneDialog";
import { WorkManageLaneDialogHost } from "./WorkManageLaneDialogHost";

// The dialog's own form is out of scope here. The host only needs a way to pick
// what to delete and press Delete, so the stub calls the same props the real
// dialog calls.
vi.mock("../lanes/ManageLaneDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof ManageLaneDialogModule>()),
  ManageLaneDialog: (props: ComponentProps<typeof ManageLaneDialogModule.ManageLaneDialog>) => (
    <div>
      <button
        type="button"
        onClick={() => props.setDeleteSelection({ worktree: true, localBranch: false, remoteBranch: false })}
      >
        Select worktree
      </button>
      <button type="button" onClick={() => props.onDelete()}>Delete lane</button>
    </div>
  ),
}));

const STUDIO_TARGET_ID = "target-mac-studio";
const studioPin: OpenProjectBinding = {
  kind: "remote",
  key: `remote:${STUDIO_TARGET_ID}:project-1`,
  targetId: STUDIO_TARGET_ID,
  runtimeName: "Mac Studio",
  projectId: "project-1",
  rootPath: "/Users/studio/ADE",
  displayName: "ADE",
};

const studioLane: LaneSummary = {
  id: "lane-feature",
  name: "Feature",
  laneType: "worktree",
  baseRef: "main",
  branchRef: "feature",
  worktreePath: "/Users/studio/ADE/.ade/worktrees/feature",
  isEditProtected: false,
  status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
  color: null,
  icon: null,
  tags: [],
  createdAt: "2026-04-22T10:00:00.000Z",
};

function studioEntry(lanes: LaneSummary[]): CrossMachineMachineLanes {
  return {
    machineId: STUDIO_TARGET_ID,
    machineName: "Mac Studio",
    targetId: STUDIO_TARGET_ID,
    projectId: "project-1",
    binding: studioPin,
    online: true,
    lanes,
    sessions: [],
    prs: [],
    lastSyncedAtMs: null,
    lanesSyncedAtMs: null,
    error: null,
  };
}

/** What the Work sidebar's union holds for the Studio: its lane list as last read. */
function setStudioLaneList(lanes: LaneSummary[]) {
  useAppStore.setState({ crossMachineLanesByMachineId: { [STUDIO_TARGET_ID]: studioEntry(lanes) } });
}

function startDeleteOnStudio(deleteLane: () => Promise<void>) {
  const deleteMock = vi.fn(deleteLane);
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: { lanes: { list: vi.fn(async () => [studioLane]), delete: deleteMock } },
  });
  render(
    <WorkManageLaneDialogHost laneId={studioLane.id} lane={studioLane} runtimePin={studioPin} onClose={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Select worktree" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete lane" }));
  return deleteMock;
}

// Keyed the way the Work sidebar names a lane on another machine. The bare lane id
// belongs to this machine's lane, so nothing may land there.
const studioDeleteState = () =>
  useAppStore.getState().laneDeleteProgressByLaneId[foreignLaneKey(STUDIO_TARGET_ID, studioLane.id)]?.overallStatus;

describe("WorkManageLaneDialogHost delete on another machine", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useAppStore.setState({ laneDeleteProgressByLaneId: {}, crossMachineLanesByMachineId: {} });
    Reflect.deleteProperty(window, "ade");
  });

  it("keeps the lane deleting after its delete returns until the Studio's re-read no longer lists it", async () => {
    setStudioLaneList([studioLane]);
    let finishDelete: () => void = () => {};
    const deleteLane = startDeleteOnStudio(() => new Promise<void>((resolve) => {
      finishDelete = resolve;
    }));

    expect(deleteLane).toHaveBeenCalledWith(expect.objectContaining({ laneId: studioLane.id }), studioPin);
    expect(studioDeleteState()).toBe("running");

    await act(async () => {
      finishDelete();
    });
    // The delete has returned, but the Studio's list still has the lane, so the card
    // and the open chat must keep saying "Deleting" rather than flashing back to normal.
    expect(studioDeleteState()).toBe("running");

    await act(async () => {
      setStudioLaneList([studioLane]);
    });
    expect(studioDeleteState()).toBe("running");

    await act(async () => {
      setStudioLaneList([]);
    });
    expect(studioDeleteState()).toBeUndefined();
  });

  it("clears the deleting state as soon as the delete fails", async () => {
    setStudioLaneList([studioLane]);
    let failDelete: () => void = () => {};
    startDeleteOnStudio(() => new Promise<void>((_resolve, reject) => {
      failDelete = () => reject(new Error("worktree is locked"));
    }));
    expect(studioDeleteState()).toBe("running");

    await act(async () => {
      failDelete();
    });
    expect(studioDeleteState()).toBeUndefined();
  });

  it("stops waiting on the Studio's re-read after 15 seconds even if the lane is still listed", async () => {
    vi.useFakeTimers();
    setStudioLaneList([studioLane]);
    startDeleteOnStudio(async () => undefined);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(studioDeleteState()).toBe("running");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(studioDeleteState()).toBeUndefined();
  });
});
