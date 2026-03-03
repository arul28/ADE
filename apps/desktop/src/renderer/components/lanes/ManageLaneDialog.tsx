import * as Dialog from "@radix-ui/react-dialog";
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
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/5 backdrop-blur-md" />
        <Dialog.Content className="fixed left-1/2 top-[14%] z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded bg-card border border-border/40 p-3 shadow-float focus:outline-none">
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
              <div className="rounded shadow-card bg-bg/40 p-3 text-xs">
                <div><span className="text-muted-fg">Lane:</span> {managedLane.name}</div>
                <div><span className="text-muted-fg">Branch:</span> {managedLane.branchRef}</div>
                <div className="truncate"><span className="text-muted-fg">Worktree:</span> {managedLane.worktreePath}</div>
              </div>
              <div className="rounded shadow-card bg-bg/40 p-3">
                <div className="mb-2 text-xs font-semibold">Archive</div>
                <div className="mb-2 text-xs text-muted-fg">Hide lane from ADE without deleting worktree or branches.</div>
                <Button size="sm" variant="outline" disabled={laneActionBusy} onClick={onArchive}>
                  Archive lane from ADE
                </Button>
              </div>
              <div className="rounded shadow-card bg-red-500/10 p-3">
                <div className="mb-2 text-xs font-semibold text-red-300">Delete</div>
                <div className="mb-2 text-xs text-red-400">This removes the lane worktree from disk.</div>
                <div className="mb-2 grid gap-2 md:grid-cols-3">
                  <label className="inline-flex items-center gap-2 rounded bg-card/60 shadow-card px-2 py-1 text-xs">
                    <input type="radio" name="lane-delete-mode" checked={deleteMode === "worktree"} onChange={() => setDeleteMode("worktree")} />
                    Worktree only
                  </label>
                  <label className="inline-flex items-center gap-2 rounded bg-card/60 shadow-card px-2 py-1 text-xs">
                    <input type="radio" name="lane-delete-mode" checked={deleteMode === "local_branch"} onChange={() => setDeleteMode("local_branch")} />
                    + local branch
                  </label>
                  <label className="inline-flex items-center gap-2 rounded bg-card/60 shadow-card px-2 py-1 text-xs">
                    <input type="radio" name="lane-delete-mode" checked={deleteMode === "remote_branch"} onChange={() => setDeleteMode("remote_branch")} />
                    + local + remote
                  </label>
                </div>
                {deleteMode === "remote_branch" ? (
                  <div className="mb-2">
                    <label className="mb-1 block text-xs text-muted-fg">Remote name</label>
                    <input value={deleteRemoteName} onChange={(event) => setDeleteRemoteName(event.target.value)} className="h-8 w-full rounded bg-card/60 shadow-card px-2 text-xs outline-none" placeholder="origin" />
                  </div>
                ) : null}
                <label className="mb-2 inline-flex items-center gap-2 rounded bg-card/60 shadow-card px-2 py-1 text-xs">
                  <input type="checkbox" checked={deleteForce} onChange={(event) => setDeleteForce(event.target.checked)} />
                  Force delete
                </label>
                <div className="mb-2">
                  <label className="mb-1 block text-xs text-muted-fg">
                    Type <span className="font-semibold text-red-300">{deletePhrase}</span> to confirm
                  </label>
                  <input value={deleteConfirmText} onChange={(event) => setDeleteConfirmText(event.target.value)} className="h-8 w-full rounded bg-card/60 shadow-card px-2 text-xs outline-none" />
                </div>
                {laneActionError ? <div className="mb-2 rounded bg-red-500/10 shadow-card px-2 py-1 text-xs text-red-300">{laneActionError}</div> : null}
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
