import type { AppleLaneDeviceOrigin } from "../../../shared/types/iosSimulator";
import { APPLE_RELEASED_DEVICE_GRACE_MS, isAdeOwnedLaneDevice } from "../../../shared/types/iosSimulator";
import { checkboxConfirmDialog } from "../ui/dialog/confirm";

/**
 * Ask before a UI path gives up a lane's device.
 *
 * A simulator the user attached stays installed when the lane lets go, so
 * there is nothing to ask. A device ADE MADE becomes a leftover, and the
 * cleanup pass deletes it, apps and data included, a few minutes later unless
 * a lane picks it again. Releasing one used to say nothing about that. The
 * confirm says it, and offers the one alternative that holds against the
 * cleanup rules: keep it as a free simulator (`keep`, which stamps the marker
 * kept instead of detached, so the pass neither deletes it nor hands it back).
 *
 * Resolves null when the person cancels; otherwise whether to keep it.
 */
export async function confirmAppleDeviceRelease(device: {
  name: string;
  origin: AppleLaneDeviceOrigin;
  /** A live session ends with the release: say so. */
  endsSession?: boolean;
}): Promise<{ keep: boolean } | null> {
  if (!isAdeOwnedLaneDevice(device.origin)) return { keep: false };
  const result = await checkboxConfirmDialog({
    title: `Release ${device.name}?`,
    tone: "warning",
    size: "md",
    message: `ADE made this simulator. Once no lane holds it, ADE deletes it, with its apps and data, in about ${Math.round(APPLE_RELEASED_DEVICE_GRACE_MS / 60_000)} minutes unless a lane picks it again from the device picker.`
      + (device.endsSession ? " Releasing also ends the live session." : ""),
    checkboxes: [{
      key: "keep",
      label: "Keep it as a free simulator instead. ADE will not delete it; delete it from the device picker when you are done.",
      defaultChecked: false,
    }],
    confirmLabel: "Release",
  });
  if (!result.confirmed) return null;
  return { keep: result.checked.keep === true };
}
