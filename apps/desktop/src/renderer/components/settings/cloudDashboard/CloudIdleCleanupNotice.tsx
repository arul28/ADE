import { useState } from "react";
import {
  formatCloudDate,
  idleCleanupHeldNext,
  idleCleanupSaveSentence,
  idleCleanupWhen,
  ignoredFilesSentence,
  type CloudAccountState,
  type CloudIdleCleanupEntry,
} from "../../../../shared/adeCloud";
import { ipcErrorMessage } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { Banner } from "../../ui/notice";

/**
 * The idle cleanup's notices on Settings › ADE Cloud, one per computer the
 * server warned about (`account.dueForDeletion`): when it is deleted, that
 * its work is committed and pushed to the lane's branch first, which files
 * git ignores won't be kept, and "Keep it", which restarts the idle clock on
 * the server with no wake and no hours. A computer kept because its save
 * failed says why and what to do. The words are the server's shared
 * sentences, so ADE and the emails say the same.
 *
 * Account level (`keepIdleComputer` is by the computer's ADE Cloud id), so no pin.
 */

/** The lane or computer, as a person knows it. */
export function idleEntryName(entry: CloudIdleCleanupEntry): string {
  return entry.laneName ?? entry.name ?? `Computer ${entry.instanceId.slice(0, 6)}`;
}

/** The lane row's short mark: "Deleted in 1 day", or "Not deleted" for a computer kept after a failed save. */
export function idleRowTag(entry: CloudIdleCleanupEntry, now: number): { label: string; title: string } {
  if (entry.held) return { label: "Not deleted", title: `ADE didn't delete it: ${entry.held.reason}` };
  const when = idleCleanupWhen(entry.deletesAt, now);
  return { label: when.charAt(0).toUpperCase() + when.slice(1), title: `Unused, so ADE Cloud deletes it on ${formatCloudDate(entry.deletesAt)} unless you keep it.` };
}

export function CloudIdleCleanupNotices({ account, now, onChanged }: { account: CloudAccountState; now: number; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const entries = account.dueForDeletion ?? [];
  if (!entries.length) return null;
  const keep = async (entry: CloudIdleCleanupEntry) => {
    const bridge = window.ade.cloud?.keepIdleComputer;
    if (!bridge) {
      showToast({ tone: "error", title: "This version of ADE can't keep it from here", message: "Open the lane or send a message in it to keep it." });
      return;
    }
    setBusy(entry.instanceId);
    try {
      const result = await bridge(entry.instanceId);
      if (!result.ok) throw new Error(result.message ?? "ADE Cloud couldn't keep it.");
      showToast({ tone: "success", title: `Kept ${idleEntryName(entry)}`, message: "ADE Cloud won't delete it. The clock starts again from now." });
      onChanged();
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't keep ${idleEntryName(entry)}`, message: ipcErrorMessage(error) || "Try again in a moment, or open the lane." });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {entries.map((entry) => {
        const name = idleEntryName(entry);
        const action = { label: busy === entry.instanceId ? "Keeping…" : "Keep it", variant: "primary" as const, disabled: busy != null, onClick: () => void keep(entry) };
        if (entry.held) {
          return (
            <Banner
              key={`idle-held-${entry.instanceId}`}
              layout="inline"
              model={{
                id: `cloud-idle-held-${entry.instanceId}`,
                tone: "warning",
                title: `ADE didn't delete ${name}: its work couldn't be saved`,
                detail: `${entry.held.reason} ${idleCleanupHeldNext(entry.held.retryAt ?? entry.deletesAt, now)}`,
                actions: [action],
                report: false,
              }}
            />
          );
        }
        const days = entry.idleDays ? ` after ${entry.idleDays} days unused` : " because it isn't used";
        return (
          <Banner
            key={`idle-${entry.instanceId}`}
            layout="inline"
            model={{
              id: `cloud-idle-${entry.instanceId}`,
              tone: "warning",
              title: `${name} will be ${idleCleanupWhen(entry.deletesAt, now)}`,
              detail: `ADE Cloud deletes its computer on ${formatCloudDate(entry.deletesAt)}${days}. ${idleCleanupSaveSentence(entry.branch)} ${ignoredFilesSentence(entry.ignoredFiles)}`,
              actions: [action],
              report: false,
            }}
          />
        );
      })}
    </>
  );
}
