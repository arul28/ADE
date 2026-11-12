import type { DeletedLaneSnapshot, RestoreDeletedLaneResult } from "../../../../shared/types";
import { READABLE_TOAST_DURATION_MS, type ToastInput } from "./toastStore";

/** What a finished lane restore says, wherever it was started. */
export function restoredLaneToast(
  lane: Pick<DeletedLaneSnapshot, "laneName" | "uncommitted" | "kind">,
  result: RestoreDeletedLaneResult,
  nextStep?: string,
): Pick<ToastInput, "tone" | "title" | "message" | "durationMs" | "replayMask"> {
  const onBranch = `On branch ${result.branchName}`;
  const body = !result.restoredUncommitted
    ? `${onBranch}. Its uncommitted files did not apply and stay saved: ${result.warning ?? "unknown error"}`
    : `${onBranch}${lane.uncommitted ? ", with its uncommitted files" : ""}.${nextStep ? ` ${nextStep}` : ""}`;
  const other = result.extraBranches.length > 0 ? ` Other commits it kept are on ${result.extraBranches.join(", ")}.` : "";
  return {
    tone: result.restoredUncommitted ? "success" : "warning",
    title: lane.kind === "freed" ? `${lane.laneName}'s files are back` : `${lane.laneName} is back`,
    message: `${body}${other}`,
    durationMs: READABLE_TOAST_DURATION_MS,
    replayMask: { title: true, message: true },
  };
}
