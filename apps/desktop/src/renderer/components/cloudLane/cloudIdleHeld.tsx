import { useState, type CSSProperties, type ReactNode } from "react";
import { idleHeldWords, type CloudIdleCleanupEntry } from "../../../shared/adeCloud";
import { ipcErrorMessage } from "../../lib/format";
import { READABLE_TOAST_DURATION_MS, showToast } from "../app/toast/toastStore";
import { refreshCloudMachines } from "../remoteTargets/useCloudMachines";
import { confirmDialog } from "../ui/dialog";
import { Banner, type NoticeAction } from "../ui/notice";
import { cloudLaneLifeAvailable, deleteCloudLane } from "./cloudLaneActions";
import { refreshCloudLanesWithoutComputer } from "./cloudLaneStores";

/**
 * A computer the idle cleanup kept because ADE couldn't save its lane's work:
 * the same words (`idleHeldWords`, shared with the server's email) and the
 * same two ways out on Settings › ADE Cloud, the lane's band, its menu and its
 * Computer tab. "Keep it" restarts the idle clock; "Delete anyway" deletes the
 * computer and keeps the lane (if it has one) and its chats, after one confirm
 * that says what is lost. Both are account calls by the computer's ADE Cloud id, so no pin,
 * and neither wakes the computer.
 */
export type HeldIdleEntry = CloudIdleCleanupEntry & { held: NonNullable<CloudIdleCleanupEntry["held"]> };

export function heldIdleEntry(entry: CloudIdleCleanupEntry | null | undefined): HeldIdleEntry | null {
  return entry?.held ? entry as HeldIdleEntry : null;
}

/** The two sentences in one line, for a tooltip or a row's hint: what happened, then what to do. */
export function heldIdleSentences(entry: HeldIdleEntry, now: number): string {
  const words = idleHeldWords(entry, now);
  return `${words.title} ${words.action}`;
}

/** Whether this window can delete it (the desktop and ADE Web both can). */
export function canDeleteIdleComputerAnyway(): boolean {
  return cloudLaneLifeAvailable();
}

/** "Delete anyway": one confirm, then only the computer goes. True when it went. */
export async function deleteIdleComputerAnyway(entry: HeldIdleEntry): Promise<boolean> {
  const words = idleHeldWords(entry, Date.now());
  const ok = await confirmDialog({
    title: words.confirm.title,
    message: words.confirm.body,
    confirmLabel: words.confirm.confirmLabel,
    cancelLabel: "Cancel",
    destructive: true,
  });
  if (!ok) return false;
  const subject = entry.laneName ? `${entry.laneName}'s computer` : entry.name || "the computer";
  try {
    // A computer with no lane has no lane to keep (the server refuses `keepLane` there): a plain delete that keeps its saved chats.
    const done = await deleteCloudLane(entry.instanceId, entry.laneName ? { skipCheck: true, keepLane: true } : { skipCheck: true, keepChats: true });
    showToast(done.ok
      ? { tone: "success", title: `Deleted ${subject}`, message: entry.laneName ? "The lane and its chats stay. Your next message makes a new computer." : undefined }
      : { tone: "error", title: `Couldn't delete ${subject}`, message: done.message || "Try again in a moment.", durationMs: READABLE_TOAST_DURATION_MS });
    return done.ok;
  } catch (error) {
    showToast({ tone: "error", title: `Couldn't delete ${subject}`, message: ipcErrorMessage(error) || "Try again in a moment.", durationMs: READABLE_TOAST_DURATION_MS });
    return false;
  } finally {
    refreshCloudMachines();
    refreshCloudLanesWithoutComputer();
  }
}

/**
 * The banner: what happened, then what to do (two short sentences), "Why?"
 * with the rule, the reason and when ADE checks again, then "Keep it" and
 * "Delete anyway". `keep` is null where this window can't keep it.
 */
export function CloudIdleHeldBanner({
  id,
  entry,
  now,
  keep,
  icon,
  style,
  onDeleted,
}: {
  id: string;
  entry: HeldIdleEntry;
  now: number;
  keep: { busy: boolean; disabled?: boolean; onClick: () => void } | null;
  icon?: ReactNode;
  style?: CSSProperties;
  onDeleted?: () => void;
}) {
  const [whyOpen, setWhyOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const words = idleHeldWords(entry, now);
  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      if (await deleteIdleComputerAnyway(entry)) onDeleted?.();
    } finally {
      setDeleting(false);
    }
  };
  const actions: NoticeAction[] = [];
  if (keep) actions.push({ label: keep.busy ? "Keeping…" : "Keep it", variant: "primary", busy: keep.busy, disabled: keep.disabled || deleting, onClick: keep.onClick });
  if (canDeleteIdleComputerAnyway()) actions.push({ label: deleting ? "Deleting…" : "Delete anyway", variant: "secondary", busy: deleting, disabled: keep?.busy, onClick: () => void remove() });
  actions.push({ label: "Why?", variant: "link", expanded: whyOpen, onClick: () => setWhyOpen((open) => !open) });
  return (
    <Banner
      layout="inline"
      style={style}
      model={{
        id,
        // At risk: the work is saved nowhere else.
        tone: "warning",
        icon,
        title: words.title,
        detail: words.action,
        actions,
        extra: whyOpen ? (
          <ul style={{ margin: 0, paddingLeft: 16, listStyle: "disc", display: "grid", gap: 2, fontSize: 12, color: "var(--kit-text-2, var(--color-muted-fg))" }}>
            {words.why.map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : null,
        report: false,
      }}
    />
  );
}
