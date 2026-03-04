import * as Dialog from "@radix-ui/react-dialog";
import { ArrowSquareOut, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import type { LaneSummary } from "../../../shared/types";

export function ManageLaneDialog({
  open,
  onOpenChange,
  managedLane,
  deleteMode,
  setDeleteMode,
  deleteRemoteName,
  setDeleteRemoteName,
  deleteForce,
  setDeleteForce,
  deleteConfirmText,
  setDeleteConfirmText,
  deletePhrase,
  laneActionBusy,
  laneActionError,
  onAdoptAttached,
  onArchive,
  onDelete
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  managedLane: LaneSummary | null;
  deleteMode: "worktree" | "local_branch" | "remote_branch";
  setDeleteMode: (v: "worktree" | "local_branch" | "remote_branch") => void;
  deleteRemoteName: string;
  setDeleteRemoteName: (v: string) => void;
  deleteForce: boolean;
  setDeleteForce: (v: boolean) => void;
  deleteConfirmText: string;
  setDeleteConfirmText: (v: string) => void;
  deletePhrase: string;
  laneActionBusy: boolean;
  laneActionError: string | null;
  onAdoptAttached: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const isAttached = managedLane?.laneType === "attached";
  const worktreeDeleteLabel = isAttached ? "Detach from ADE only" : "Worktree only";
  const localDeleteLabel = isAttached ? "Detach + local branch" : "+ local branch";
  const remoteDeleteLabel = isAttached ? "Detach + local + remote" : "+ local + remote";
  const destructiveMessage = isAttached
    ? "Detaching keeps files on disk. ADE just stops tracking this path."
    : "This removes the lane worktree from disk.";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/5 backdrop-blur-md" />
        <Dialog.Content className="fixed left-1/2 top-[14%] z-50 w-[min(760px,calc(100vw-24px))] -translate-x-1/2 rounded border border-border/40 bg-card p-4 shadow-float focus:outline-none">
          <div className="mb-4 flex items-center justify-between gap-3">
            <Dialog.Title className="text-lg font-semibold">Manage lane</Dialog.Title>
            <Dialog.Close asChild><Button variant="ghost" size="sm">Esc</Button></Dialog.Close>
          </div>
          {!managedLane ? (
            <div className="text-sm text-muted-fg">Select a lane first.</div>
          ) : managedLane.laneType === "primary" ? (
            <div className="text-sm text-muted-fg">Primary lane cannot be archived or deleted.</div>
          ) : (
            <div className="space-y-3">
              <div className="rounded border border-border/20 bg-bg/40 p-3 text-xs">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-semibold">{managedLane.name}</span>
                  <span className="rounded bg-muted/30 px-1.5 py-0.5 text-[11px] uppercase text-muted-fg">
                    {managedLane.laneType}
                  </span>
                </div>
                <div><span className="text-muted-fg">Branch:</span> {managedLane.branchRef}</div>
                <div className="truncate"><span className="text-muted-fg">Path:</span> {managedLane.worktreePath}</div>
              </div>

              {isAttached ? (
                <div className="rounded border border-blue-500/30 bg-blue-500/10 p-3">
                  <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-blue-200">
                    <ArrowSquareOut size={14} />
                    Move To ADE-Managed Worktree
                  </div>
                  <div className="mb-2 text-xs text-blue-200/90">
                    Move this attached worktree into <span className="font-mono">.ade/worktrees</span> so ADE can fully manage cleanup and lane lifecycle.
                  </div>
                  <Button size="sm" variant="outline" disabled={laneActionBusy} onClick={onAdoptAttached}>
                    Move to .ade/worktrees
                  </Button>
                </div>
              ) : null}

              <div className="rounded border border-border/20 bg-bg/40 p-3">
                <div className="mb-2 text-xs font-semibold">Archive</div>
                <div className="mb-2 text-xs text-muted-fg">Hide lane from ADE without deleting worktree or branches.</div>
                <Button size="sm" variant="outline" disabled={laneActionBusy} onClick={onArchive}>
                  Archive lane from ADE
                </Button>
              </div>

              <div className="rounded border border-red-500/30 bg-red-500/10 p-3">
                <div className="mb-2 text-xs font-semibold text-red-300">{isAttached ? "Detach / Delete" : "Delete"}</div>
                <div className="mb-2 text-xs text-red-300">{destructiveMessage}</div>
                <div className="mb-2 grid gap-2 md:grid-cols-3">
                  <label className="inline-flex items-center gap-2 rounded bg-card/60 px-2 py-1 text-xs">
                    <input type="radio" name="lane-delete-mode" checked={deleteMode === "worktree"} onChange={() => setDeleteMode("worktree")} />
                    {worktreeDeleteLabel}
                  </label>
                  <label className="inline-flex items-center gap-2 rounded bg-card/60 px-2 py-1 text-xs">
                    <input type="radio" name="lane-delete-mode" checked={deleteMode === "local_branch"} onChange={() => setDeleteMode("local_branch")} />
                    {localDeleteLabel}
                  </label>
                  <label className="inline-flex items-center gap-2 rounded bg-card/60 px-2 py-1 text-xs">
                    <input type="radio" name="lane-delete-mode" checked={deleteMode === "remote_branch"} onChange={() => setDeleteMode("remote_branch")} />
                    {remoteDeleteLabel}
                  </label>
                </div>
                {deleteMode === "remote_branch" ? (
                  <div className="mb-2">
                    <label className="mb-1 block text-xs text-muted-fg">Remote name</label>
                    <input value={deleteRemoteName} onChange={(event) => setDeleteRemoteName(event.target.value)} className="h-8 w-full rounded bg-card/60 px-2 text-xs outline-none" placeholder="origin" />
                  </div>
                ) : null}
                <label className="mb-2 inline-flex items-center gap-2 rounded bg-card/60 px-2 py-1 text-xs">
                  <input type="checkbox" checked={deleteForce} onChange={(event) => setDeleteForce(event.target.checked)} />
                  Force delete
                </label>
                <div className="mb-2">
                  <label className="mb-1 block text-xs text-muted-fg">
                    Type <span className="font-semibold text-red-300">{deletePhrase}</span> to confirm
                  </label>
                  <input value={deleteConfirmText} onChange={(event) => setDeleteConfirmText(event.target.value)} className="h-8 w-full rounded bg-card/60 px-2 text-xs outline-none" />
                </div>
                {laneActionError ? (
                  <div className="mb-2 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300">
                    <WarningCircle size={14} className="mt-0.5 shrink-0" />
                    <span>{laneActionError}</span>
                  </div>
                ) : null}
                <Button size="sm" variant="primary" disabled={laneActionBusy || deleteConfirmText.trim().toLowerCase() !== deletePhrase.toLowerCase()} onClick={onDelete}>
                  {laneActionBusy ? "Working..." : "Delete lane"}
                </Button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
