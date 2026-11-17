/**
 * A failed call to another machine, as a person reads it: the machine's own
 * sentence ("Can't reach … — it may be asleep or ADE may be stopped there."),
 * without Electron's "Error invoking remote method …" wrapper, and with an
 * ADE Cloud computer named the way the rest of ADE names it ("Cloud · <lane>",
 * or "Cloud"), never by the id its provider generated ("gfuzrbefvm").
 *
 * The main process builds the sentence from the saved connection's name, which
 * for a cloud computer is that id; the lane a computer serves is known only
 * here, from the lane computer index, so the name is mapped where it is shown.
 */

import type { CloudMachine } from "../../shared/adeCloud";
import { watchedCloudMachines } from "../components/remoteTargets/useCloudMachines";
import { adeCloudLaneComputersNow, type AdeCloudLaneComputer } from "../state/adeCloudLaneIndex";
import { ADE_CLOUD_NAME } from "../../shared/adeCloudMachine";
import { extractError, ipcErrorMessage } from "./format";
import { formatSessionActionError } from "./sessions";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `text` with every cloud computer id this window knows replaced by its label:
 * a lane computer's "Cloud · <lane>", any other of the account's cloud
 * computers "Cloud". Text that names no cloud computer comes back unchanged.
 */
export function withCloudComputerLabels(
  text: string,
  computers: readonly AdeCloudLaneComputer[] = adeCloudLaneComputersNow(),
  boxes: readonly CloudMachine[] | null = (() => {
    const watched = watchedCloudMachines();
    return watched?.state === "ok" ? watched.machines : null;
  })(),
): string {
  if (!text) return text;
  const labels = new Map<string, string>();
  for (const box of boxes ?? []) {
    if (box.instanceId.trim()) labels.set(box.instanceId.trim().toLowerCase(), ADE_CLOUD_NAME);
  }
  for (const computer of computers) {
    const id = computer.instanceId.trim().toLowerCase();
    if (id) labels.set(id, ADE_CLOUD_NAME);
  }
  let out = text;
  for (const [id, label] of labels) {
    // Whole words only: an id is never part of a longer word in a sentence.
    // A function, so a lane name's "$&" or "$'" is shown, not expanded.
    out = out.replace(new RegExp(`(?<![\\w-])${escapeRegExp(id)}(?![\\w-])`, "gi"), () => label);
  }
  return out;
}

/** A thrown runtime failure as the sentence a toast or banner shows (see the module note). */
export function machineErrorText(error: unknown): string {
  return withCloudComputerLabels(ipcErrorMessage(error) || extractError(error));
}

/** `formatSessionActionError` ("Delete failed: …") with the machine named as above. */
export function formatMachineActionError(error: unknown, action: string): string {
  return formatSessionActionError(machineErrorText(error), action);
}
