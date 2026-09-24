import { useEffect, useState } from "react";
import { FolderOpen } from "@phosphor-icons/react";
import type { LaneDeleteLeftoverWorktree } from "../../../shared/types";
import { revealLabel } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";
import { Dialog } from "../ui/dialog";

type LeftoverPrompt = LaneDeleteLeftoverWorktree & { laneId: string };

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
      setQueue((existing) => {
        if (existing.some((entry) => entry.laneId === progress.laneId && entry.path === leftover.path)) {
          return existing;
        }
        return [...existing, { ...leftover, laneId: progress.laneId }];
      });
    });
    return unsubscribe;
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
    void window.ade.lanes.revealLeftoverWorktree({ laneId: current.laneId }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  const remove = () => {
    setDeleting(true);
    setError(null);
    void window.ade.lanes.deleteLeftoverWorktree({ laneId: current.laneId })
      .then(() => dismiss())
      .catch((reason: unknown) => {
        setDeleting(false);
        setError(reason instanceof Error ? reason.message : String(reason));
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
      {error ? <p className="mt-2 text-[12px] text-[var(--color-danger,#F87171)]">{error}</p> : null}
    </Dialog>
  );
}
