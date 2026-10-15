import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { FolderSimple } from "@phosphor-icons/react";
import type { ProjectMoveRecord } from "../../../shared/types/projectMove";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";
import { isMacPlatform } from "../../lib/platform";
import { arePathsEqual } from "../../lib/pathUtils";
import { useAppStore } from "../../state/appStore";
import { MoveProjectDialog } from "./MoveProjectDialog";
import { chooseOldCopy } from "./oldCopyActions";
import { displayPath, formatBytes, PROJECT_MOVE_CHANGED_EVENT, REMINDER_CHOICES } from "./projectMoveModel";

/**
 * The move dialog lives here, at the app shell, not in Settings: a finished
 * move reopens the project from its new folder, which remounts the page that
 * opened the dialog, and the Done step has to survive that.
 */
type DialogTarget = { projectRoot: string; projectName: string } | null;

let dialogTarget: DialogTarget = null;
const listeners = new Set<() => void>();

export function openMoveProjectDialog(target: NonNullable<DialogTarget>): void {
  dialogTarget = target;
  for (const listener of listeners) listener();
}

function closeMoveProjectDialog(): void {
  dialogTarget = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-read on open, focus, when a reminder falls due, every 10 minutes, and whenever a move surface changes something. */
const REFRESH_MS = 10 * 60_000;

export function ProjectMoveHost() {
  const target = useSyncExternalStore(subscribe, () => dialogTarget, () => null);
  const [attention, setAttention] = useState<ProjectMoveRecord[]>([]);
  // Moving projects is macOS-only; elsewhere there is nothing to poll for.
  const api = isMacPlatform() ? window.ade?.projectMove : undefined;

  const [nextReminderAt, setNextReminderAt] = useState<number | null>(null);

  const refresh = useCallback(() => {
    if (!api) return;
    void api.attention().then((next) => {
      setAttention(next.records);
      setNextReminderAt(next.nextReminderAt);
    }).catch((error) => {
      console.warn("[project-move] reading kept copies failed", error);
      setAttention([]);
    });
  }, [api]);

  // Wake exactly when the next reminder falls due (capped: a timer longer than
  // ~24 days overflows, and the regular refresh covers anything later).
  useEffect(() => {
    if (nextReminderAt == null) return undefined;
    const delay = Math.min(Math.max(nextReminderAt - Date.now(), 0) + 500, 24 * 60 * 60_000);
    const timer = window.setTimeout(refresh, delay);
    return () => window.clearTimeout(timer);
  }, [nextReminderAt, refresh]);

  useEffect(() => {
    if (!api) return undefined;
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener(PROJECT_MOVE_CHANGED_EVENT, refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(PROJECT_MOVE_CHANGED_EVENT, refresh);
    };
  }, [api, refresh]);

  // The old copy belongs to the project that moved: its banner shows only in
  // that project's tab, never over another project the window has open.
  const projectRoot = useAppStore((s) => (s.projectBinding?.kind === "remote" ? null : s.project?.rootPath ?? null));
  const record = target || !projectRoot
    ? null
    : attention.find((entry) => arePathsEqual(entry.destinationRoot, projectRoot)) ?? null;

  useAppBanner(
    record && {
      id: `project-move-old-copy:${record.moveId}`,
      tone: "info",
      icon: <FolderSimple size={16} />,
      title: `An old copy of ${record.projectName} is still kept`,
      detail: `${displayPath(record.originalParkedAt ?? "")} · ${formatBytes(record.originalBytes)}`,
      actions: [
        { label: `Remind me ${REMINDER_CHOICES[0]!.label.toLowerCase()}`, onClick: () => void chooseOldCopy(record, { remindInMs: REMINDER_CHOICES[0]!.ms }) },
        { label: "Delete…", variant: "secondary", onClick: () => void chooseOldCopy(record, "delete") },
        { label: "Keep", variant: "link", onClick: () => void chooseOldCopy(record, "keep") },
      ],
    },
    { priority: APP_BANNER_PRIORITY.default },
  );

  if (!target) return null;
  return (
    <MoveProjectDialog
      open
      onClose={() => {
        closeMoveProjectDialog();
        refresh();
      }}
      projectRoot={target.projectRoot}
      projectName={target.projectName}
    />
  );
}
