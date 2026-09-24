import type { AutoUpdateSnapshot } from "../../../shared/types";
import { confirmDialog } from "../ui/dialog/confirm";
import { captureUpdatePromptDecision } from "./captureUpdatePromptDecision";

function versionLabel(version: string | null): string {
  return version ? `v${version}` : "the latest update";
}

/** Shared confirmation and install action for every manual update affordance. */
export async function requestDownloadedUpdateInstall(
  snapshot: AutoUpdateSnapshot,
  onAccepted?: () => void,
): Promise<boolean> {
  const impact = await Promise.resolve()
    .then(() => window.ade.updateGetInstallImpact())
    .catch(() => null);
  const phones = impact?.connectedPhones ?? [];
  const title = `ADE will quit and reopen automatically to install ${versionLabel(snapshot.version)}.`;
  const lines: string[] = [];
  if (phones.length === 1) {
    lines.push(
      `${phones[0].deviceName} is connected through ADE phone sync. It will disconnect during the update and reconnect automatically once ADE is back.`,
    );
  } else if (phones.length > 1) {
    lines.push(
      `Connected phones (${phones.map((phone) => phone.deviceName).join(", ")}) will disconnect during the update and reconnect automatically once ADE is back.`,
    );
  }
  lines.push(
    "Open ADE Code terminals and running agent sessions on this machine will disconnect while the ADE service restarts — you can reopen them right after the update.",
    "",
    "You do not need to restart ADE yourself. Any unsaved work may be lost. Continue?",
  );
  const confirmed = await confirmDialog({ title, message: lines.join("\n"), confirmLabel: "Continue" });
  if (!confirmed) {
    captureUpdatePromptDecision(snapshot, "deferred");
    return false;
  }

  captureUpdatePromptDecision(snapshot, "accepted");
  onAccepted?.();
  try {
    return await window.ade.updateQuitAndInstall();
  } catch {
    // The main process logs updater failures.
    return false;
  }
}
