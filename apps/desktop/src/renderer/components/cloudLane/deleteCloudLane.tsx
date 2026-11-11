import { CloudArrowUp } from "@phosphor-icons/react";
import type { CloudLaneWorkLane, CloudLaneWorkState } from "../../../shared/cloudLaneLife";
import { ipcErrorMessage } from "../../lib/format";
import { showToast } from "../app/toast/toastStore";
import { CloudMark, ADE_CLOUD_NAME } from "../remoteTargets/cloudBrand";
import { confirmDialog } from "../ui/dialog";
import { CLOUD_LANE_LIFE_UNAVAILABLE, cloudLaneLifeAvailable, cloudLaneWorkState, deleteCloudLane, pushCloudLaneWork } from "./cloudLaneActions";
import "./cloudLane.css";

/**
 * Delete a cloud lane: the lane and its computer go together. It is direct,
 * with one exception: when the computer holds work that isn't on GitHub (or
 * ADE couldn't check), it warns first, with "Push all work to GitHub" and
 * "Delete anyway". Its chats stay readable from the saved copy.
 *
 * Every place that deletes a cloud lane calls this: the dashboard, the Lanes
 * tab, the lane menus on the Work and PRs tabs. Account level, by ADE Cloud
 * id (no pin), through this app's main process.
 *
 * `askFirst`: the caller has no confirm of its own (the dashboard), so a
 * clean lane still gets one plain question. A lane menu already asked.
 *
 * Resolves true when the lane was deleted.
 */
export async function deleteCloudLaneWithCheck(input: {
  instanceId: string;
  laneName: string;
  askFirst: boolean;
  /** Runs after a delete that worked (a list refresh, a selection clear). */
  onDeleted?: () => void;
}): Promise<boolean> {
  const { instanceId, laneName } = input;
  const fail = (error: unknown) => {
    showToast({ tone: "error", title: `Couldn't delete ${laneName}`, message: ipcErrorMessage(error) || `${ADE_CLOUD_NAME} didn't answer. Try again in a moment.` });
    return false;
  };
  // The web app (and an older preload) can't delete a lane's computer: say so before any dialog.
  if (!cloudLaneLifeAvailable()) return fail(new Error(CLOUD_LANE_LIFE_UNAVAILABLE));

  let work: CloudLaneWorkState;
  try {
    work = await cloudLaneWorkState(instanceId);
  } catch (error) {
    // The check itself failed: warn as if there were work, never delete blind.
    work = { unpushed: null, unpushedLanes: [], message: ipcErrorMessage(error) || null };
  }

  if (work.unpushed !== false) {
    let pushFirst = false;
    const confirmed = await confirmDialog({
      title: work.unpushed ? `${laneName} has work that isn't on GitHub` : `ADE couldn't check ${laneName} for unpushed work`,
      message: work.unpushed
        ? "Deleting the lane deletes its computer, and this work goes with it. Push it first, or delete anyway."
        : `${work.message ? `${work.message} ` : ""}Deleting the lane deletes its computer. Work that isn't pushed goes with it.`,
      icon: <CloudMark size={16} brand />,
      tone: "warning",
      size: "md",
      confirmLabel: "Delete anyway",
      destructive: true,
      children: ({ dismiss }) => (
        <div className="adecl-delete-body">
          {work.unpushedLanes.length ? <UnpushedList lanes={work.unpushedLanes} /> : null}
          <button
            type="button"
            className="kit-btn"
            data-size="sm"
            onClick={() => {
              pushFirst = true;
              dismiss();
            }}
          >
            <CloudArrowUp size={13} />
            Push all work to GitHub
          </button>
          <p className="adecl-delete-note">ADE pushes every lane&apos;s work on this computer, then deletes the lane. Its chats stay readable.</p>
        </div>
      ),
    });
    if (pushFirst) {
      try {
        const message = await pushCloudLaneWork(instanceId);
        showToast({ tone: "success", title: `Pushed ${laneName}'s work`, message });
      } catch (error) {
        showToast({ tone: "error", title: `Kept ${laneName}`, message: `${ipcErrorMessage(error) || "ADE couldn't push the work."} The lane and its computer stay.` });
        return false;
      }
      // Pushed: check once more, so nothing new since slips through.
      return await deleteCloudLaneWithCheck({ ...input, askFirst: false });
    }
    if (!confirmed) return false;
  } else if (input.askFirst) {
    const confirmed = await confirmDialog({
      title: `Delete ${laneName}?`,
      message: "Its work is on GitHub. ADE deletes the lane and its computer. Its chats stay readable.",
      confirmLabel: "Delete lane",
      destructive: true,
    });
    if (!confirmed) return false;
  }

  try {
    const done = await deleteCloudLane(instanceId, { skipCheck: true });
    if (!done.ok) {
      showToast({ tone: "error", title: `Couldn't delete ${laneName}`, message: done.message });
      return false;
    }
    showToast({ tone: "success", title: `Deleted ${laneName}`, message: "The lane and its computer are gone. Its chats stay readable." });
    input.onDeleted?.();
    return true;
  } catch (error) {
    return fail(error);
  }
}

function UnpushedList({ lanes }: { lanes: readonly CloudLaneWorkLane[] }) {
  return (
    <ul className="adecl-unpushed">
      {lanes.map((lane) => (
        <li key={lane.laneId}>
          <b>{lane.laneName}</b>
          <span>{unpushedText(lane)}</span>
        </li>
      ))}
    </ul>
  );
}

function unpushedText(lane: CloudLaneWorkLane): string {
  const parts: string[] = [];
  if (lane.dirty) parts.push("changes not committed");
  if (lane.ahead > 0) parts.push(`${lane.ahead} commit${lane.ahead === 1 ? "" : "s"} not pushed`);
  if (lane.state === "failed") parts.push("the last push failed");
  return parts.length ? parts.join(", ") : "work not pushed";
}
