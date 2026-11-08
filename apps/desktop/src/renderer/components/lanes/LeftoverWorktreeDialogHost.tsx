import { useEffect, useState } from "react";
import { FolderOpen } from "@phosphor-icons/react";
import type { LaneDeleteLeftoverWorktree, OpenProjectBinding } from "../../../shared/types";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { revealLabel } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";
import { extractError } from "../../lib/format";
import { useAppStore } from "../../state/appStore";
import { READABLE_TOAST_DURATION_MS, showToast } from "../app/toast/toastStore";
import { navigateToAppTarget } from "../../lib/openExternal";
import { machineIdForBinding } from "../../../shared/machineIdentity";
import { Dialog } from "../ui/dialog";
import { Banner } from "../ui/notice";

/**
 * Where the delete ran: the user can switch tabs while a delete runs and
 * before answering, so the folder's actions must not follow the active tab.
 * The event's `origin` (the binding the delete started with) names it; the
 * active tab is only the fallback for a delete this window did not start.
 * `pin` is set only for a project on another machine; a project on this one is
 * named by `rootPath` and keeps the unpinned route.
 */
type LeftoverPrompt = LaneDeleteLeftoverWorktree & {
  laneId: string;
  pin: OpenProjectBinding | null;
  rootPath: string | null;
};

function leftoverArgs(prompt: LeftoverPrompt): { laneId: string; rootPath?: string } {
  return prompt.rootPath ? { laneId: prompt.laneId, rootPath: prompt.rootPath } : { laneId: prompt.laneId };
}

/**
 * After a lane delete leaves an external folder on disk, ask once what to do
 * with it. Close keeps the folder. Delete folder removes that directory only.
 */
export function LeftoverWorktreeDialogHost(): JSX.Element | null {
  const [queue, setQueue] = useState<LeftoverPrompt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const current = queue[0] ?? null;

  useEffect(() => {
    const subscribe = window.ade?.lanes?.onDeleteEvent;
    if (!subscribe) return;
    const unsubscribe = subscribe((event) => {
      const progress = event.progress;
      const leftover = progress.leftoverWorktree;
      const finished = progress.overallStatus === "completed" || progress.overallStatus === "completed_with_warnings";
      if (!finished || !leftover?.path) return;
      const binding = event.origin !== undefined ? event.origin : useAppStore.getState().projectBinding ?? null;
      setQueue((existing) => {
        if (existing.some((entry) => entry.laneId === progress.laneId && entry.path === leftover.path)) {
          return existing;
        }
        const pin = binding?.kind === "remote" ? binding : null;
        const rootPath = binding?.kind === "local" ? binding.rootPath : null;
        return [...existing, { ...leftover, laneId: progress.laneId, pin, rootPath }];
      });
    });
    return unsubscribe;
  }, []);

  // A delete that kept unsaved work says so once, on the machine it ran on,
  // with a way back: Restore now, or the list in Recently deleted.
  useEffect(() => {
    const subscribe = window.ade?.lanes?.onDeleteEvent;
    if (!subscribe) return;
    const announced = new Set<string>();
    return subscribe((event) => {
      const progress = event.progress;
      const saved = progress.savedWork;
      const finished = progress.overallStatus === "completed" || progress.overallStatus === "completed_with_warnings";
      if (!finished || !saved || announced.has(saved.id)) return;
      announced.add(saved.id);
      const binding = event.origin !== undefined ? event.origin : useAppStore.getState().projectBinding ?? null;
      const pin = binding?.kind === "remote" ? binding : null;
      const toastId = `lane-work-saved:${saved.id}`;
      const openRecentlyDeleted = () => navigateToAppTarget({
        kind: "settings",
        entryId: "storage.recentlyDeleted",
        ...(pin ? { machineId: machineIdForBinding(pin) } : {}),
      });
      const restore = () => {
        showToast({ id: toastId, tone: "info", title: `Restoring ${saved.laneName}…` });
        void window.ade.lanes.restoreDeleted({ id: saved.id }, pin)
          .then((result) => {
            showToast({
              id: toastId,
              tone: result.restoredUncommitted ? "success" : "warning",
              title: `${saved.laneName} is back`,
              message: result.restoredUncommitted
                ? `On branch ${result.branchName}, with its uncommitted files.`
                : `On branch ${result.branchName}. Its uncommitted files did not apply and stay saved: ${result.warning ?? "unknown error"}`,
            });
          })
          .catch((reason: unknown) => {
            showToast({
              id: toastId,
              tone: "error",
              title: `Couldn't restore ${saved.laneName}`,
              message: stripElectronErrorWrapper(extractError(reason)),
              actions: [{ label: "Recently deleted", onClick: openRecentlyDeleted }],
            });
          });
      };
      showToast({
        id: toastId,
        tone: "info",
        title: saved.uncommitted ? `Kept ${saved.laneName}'s uncommitted work` : `Kept ${saved.laneName}'s unpushed commits`,
        message: "ADE keeps it for 30 days.",
        durationMs: READABLE_TOAST_DURATION_MS,
        actions: [
          { label: "Restore lane", onClick: restore },
          { label: "Recently deleted", onClick: openRecentlyDeleted },
        ],
      });
    });
  }, []);

  useEffect(() => {
    setError(null);
    setDeleting(false);
  }, [current?.laneId, current?.path]);

  if (!current) return null;

  const dismiss = () => {
    setQueue((existing) => existing.slice(1));
  };

  const reveal = () => {
    void window.ade.lanes.revealLeftoverWorktree(leftoverArgs(current), current.pin).catch((reason: unknown) => {
      setError(extractError(reason));
    });
  };

  const remove = () => {
    setDeleting(true);
    setError(null);
    void window.ade.lanes.deleteLeftoverWorktree(leftoverArgs(current), current.pin)
      .then(() => dismiss())
      .catch((reason: unknown) => {
        setDeleting(false);
        setError(stripElectronErrorWrapper(extractError(reason)));
      });
  };

  const showReveal = !isWebClientMode();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) dismiss();
      }}
      title="Folder left on disk"
      description={
        current.canDelete
          ? `${current.laneName} was deleted. Git no longer has this folder as a worktree, so it was left in place.`
          : `${current.laneName} was deleted. This path is a symbolic link, so the folder it points at was left in place.`
      }
      tone="warning"
      icon={<FolderOpen size={18} weight="duotone" />}
      testId="leftover-worktree-dialog"
      actions={[
        ...(showReveal
          ? [{ label: revealLabel, variant: "secondary" as const, onClick: reveal, disabled: deleting }]
          : []),
        ...(current.canDelete
          ? [{
              label: "Delete folder",
              variant: "solid" as const,
              onClick: remove,
              busy: deleting,
              autoFocus: true,
            }]
          : []),
        { label: "Close", variant: "secondary" as const, onClick: dismiss, disabled: deleting },
      ]}
    >
      <p className="break-all font-mono text-[12px] text-fg/80">{current.path}</p>
      {error ? (
        <Banner
          layout="inline"
          style={{ marginTop: 8 }}
          model={{
            id: "leftover-worktree-error",
            tone: "error",
            title: error,
            report: { surface: "leftover_worktree" },
            dismiss: { onDismiss: () => setError(null) },
          }}
        />
      ) : null}
    </Dialog>
  );
}
