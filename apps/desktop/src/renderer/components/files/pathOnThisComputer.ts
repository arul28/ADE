import { machineLabelForBinding } from "../../state/adeCloudLaneIndex";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { showToast } from "../app/toast/toastStore";

/**
 * Path actions that only this computer can do: open a file in Finder or in an
 * app, reveal it, read its bytes for the clipboard.
 *
 * The pin says where the path is. A path on another computer is refused here,
 * with that computer's name, and no call goes out: a local path of the same
 * name must never open in its place.
 */

/** The refusal for a path on another computer, or null when the path is here. */
export function pathElsewhereMessage(pin: OpenProjectBinding, what = "This file"): string | null {
  if (pin.kind !== "remote") return null;
  return `${what} is on ${machineLabelForBinding(pin)}. Open it from ADE on that computer.`;
}

/**
 * Run a path action on this computer. A path on another computer shows the
 * refusal instead; a failure shows its reason. Neither is silent.
 */
export function runPathActionHere(
  pin: OpenProjectBinding,
  action: () => Promise<unknown>,
  options: { what?: string; failTitle: string },
): void {
  const refusal = pathElsewhereMessage(pin, options.what);
  if (refusal) {
    showToast({ tone: "info", title: refusal, report: false });
    return;
  }
  void action().catch((error: unknown) => {
    showToast({
      tone: "error",
      title: options.failTitle,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}
