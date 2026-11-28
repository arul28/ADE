import { useState } from "react";
import {
  formatCloudDate,
  idleCleanupWhen,
  ignoredFilesList,
  type CloudAccountState,
  type CloudIdleCleanupEntry,
} from "../../../../shared/adeCloud";
import { ipcErrorMessage } from "../../../lib/format";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { showToast } from "../../app/toast/toastStore";
import { Banner } from "../../ui/notice";
import { BRAND } from "../../../../shared/brand";
import { CloudIdleHeldBanner, heldIdleEntry, heldIdleSentences } from "../../cloudLane/cloudIdleHeld";

/**
 * The idle cleanup's notices on Settings › ADE Cloud, one per computer the
 * server warned about (`account.dueForDeletion`): when it is deleted, that
 * its lanes' work that isn't on GitHub is saved first (no wake, no push), which files
 * git ignores won't be kept, and "Keep it", which restarts the idle clock on
 * the server with no wake and no hours. A computer kept because its save
 * failed says what happened and what to do, with "Why?" and "Delete anyway"
 * (`CloudIdleHeldBanner`, the email's words). The facts are the emails' (the
 * same date, branch and ignored files), said in fewer words: a banner has a
 * title and one short detail.
 *
 * Account level (`keepIdleComputer` and the delete are by the computer's ADE Cloud id), so no pin.
 */

/** The lane or computer, as a person knows it. */
export function idleEntryName(entry: CloudIdleCleanupEntry): string {
  return entry.laneName ?? entry.name ?? "A computer without a lane";
}

/** "pricing-page's computer": the idle cleanup deletes the computer; the lane stays. */
function idleSubject(entry: CloudIdleCleanupEntry): string {
  return entry.laneName ? `${entry.laneName}'s computer` : idleEntryName(entry);
}

/** What the delete loses: the files git ignores, with a leading space, or "" when none were found. */
function ignoredDetail(entry: CloudIdleCleanupEntry): string {
  // Absent (an older server) reads like unknown: the warning still says ignored files aren't kept.
  if (entry.ignoredFiles == null) return " Files git ignores, such as .env, aren't saved.";
  const list = ignoredFilesList(entry.ignoredFiles);
  if (entry.ignoredFiles.incomplete) {
    return list
      ? ` Files git ignores aren't saved, so these won't be kept: ${list}. ${BRAND.NAME} couldn't read every lane, so there may be more.`
      : ` ${BRAND.NAME} couldn't read every lane to see which files git ignores, such as .env; those aren't saved.`;
  }
  return list ? ` Files git ignores aren't saved, so these won't be kept: ${list}.` : "";
}

function idleDetail(entry: CloudIdleCleanupEntry): string {
  const when = formatCloudDate(entry.deletesAt);
  const head = entry.idleDays
    ? `Computers unused for ${entry.idleDays} days are deleted; this one goes on ${when}.`
    : `It isn't used, so ${BRAND.CLOUD_NAME} deletes it on ${when}.`;
  const save = entry.laneName
    ? ` Its work that isn't on GitHub is saved in ${BRAND.CLOUD_NAME}, and the lane and its chats stay.`
    : ` Its work that isn't on GitHub is saved in ${BRAND.CLOUD_NAME} first.`;
  return `${head}${save}${ignoredDetail(entry)}`;
}

/** The lane row's short mark: "Deleted in 1 day", or "Not deleted" for a computer kept after a failed save. */
export function idleRowTag(entry: CloudIdleCleanupEntry, now: number): { label: string; title: string } {
  const held = heldIdleEntry(entry);
  if (held) return { label: "Not deleted", title: heldIdleSentences(held, now) };
  const when = idleCleanupWhen(entry.deletesAt, now);
  return { label: when.charAt(0).toUpperCase() + when.slice(1), title: `Unused, so ${BRAND.CLOUD_NAME} deletes its computer on ${formatCloudDate(entry.deletesAt)} unless you keep it. The lane stays.` };
}

export function CloudIdleCleanupNotices({ account, now, onChanged }: { account: CloudAccountState; now: number; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const entries = account.dueForDeletion ?? [];
  if (!entries.length) return null;
  const keep = async (entry: CloudIdleCleanupEntry) => {
    const bridge = window.ade.cloud?.keepIdleComputer;
    if (!isAdeAvailable(bridge)) {
      showToast({ tone: "error", title: `This version of ${BRAND.NAME} can't keep it from here`, message: "Open the lane or send a message in it to keep it." });
      return;
    }
    setBusy(entry.instanceId);
    try {
      const result = await bridge(entry.instanceId);
      if (!result.ok) throw new Error(result.message ?? `${BRAND.CLOUD_NAME} couldn't keep it.`);
      showToast({ tone: "success", title: `Kept ${idleSubject(entry)}`, message: `${BRAND.CLOUD_NAME} won't delete it. Its unused days count again from now.` });
      onChanged();
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't keep ${idleSubject(entry)}`, message: ipcErrorMessage(error) || "Try again in a moment, or open the lane." });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {entries.map((entry) => {
        const action = { label: busy === entry.instanceId ? "Keeping…" : "Keep it", variant: "primary" as const, disabled: busy != null, onClick: () => void keep(entry) };
        const held = heldIdleEntry(entry);
        if (held) {
          return (
            <CloudIdleHeldBanner
              key={`idle-held-${entry.instanceId}`}
              id={`cloud-idle-held-${entry.instanceId}`}
              entry={held}
              now={now}
              keep={{ busy: busy === entry.instanceId, disabled: busy != null, onClick: () => void keep(entry) }}
              onDeleted={onChanged}
            />
          );
        }
        return (
          <Banner
            key={`idle-${entry.instanceId}`}
            layout="inline"
            model={{
              id: `cloud-idle-${entry.instanceId}`,
              tone: "warning",
              title: `${idleSubject(entry)} will be ${idleCleanupWhen(entry.deletesAt, now)}`,
              detail: idleDetail(entry),
              actions: [action],
              report: false,
            }}
          />
        );
      })}
    </>
  );
}
