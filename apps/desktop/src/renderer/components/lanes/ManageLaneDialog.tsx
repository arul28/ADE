import * as Dialog from "@radix-ui/react-dialog";
import { ArrowSquareOut, GitBranch, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import type { LaneSummary } from "../../../shared/types";

export function ManageLaneDialog({
  open,
  onOpenChange,
  managedLane,
  managedLanes,
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
  managedLanes?: LaneSummary[];
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
  const lanes = managedLanes?.length ? managedLanes : managedLane ? [managedLane] : [];
  const isBatch = lanes.length > 1;
  const allPrimary = lanes.length > 0 && lanes.every((l) => l.laneType === "primary");
  const hasAttached = lanes.some((l) => l.laneType === "attached");
  const hasAnyDirty = lanes.some((l) => l.status.dirty);

  const isAttached = !isBatch && lanes[0]?.laneType === "attached";
  const worktreeDeleteLabel = hasAttached ? "Detach from ADE only" : "Worktree only";
  const localDeleteLabel = hasAttached ? "Detach + local branch" : "+ local branch";
  const remoteDeleteLabel = hasAttached ? "Detach + local + remote" : "+ local + remote";
  const destructiveMessage = isBatch
    ? `This will remove ${lanes.length} lane worktrees from disk.`
    : isAttached
      ? "Detaching keeps files on disk. ADE just stops tracking this path."
      : "This removes the lane worktree from disk.";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/5 backdrop-blur-md" />
        <Dialog.Content className="fixed left-1/2 top-[14%] z-50 w-[min(760px,calc(100vw-24px))] -translate-x-1/2 rounded border border-border/40 bg-card p-4 shadow-float focus:outline-none">
          <div className="mb-4 flex items-center justify-between gap-3">
            <Dialog.Title className="text-lg font-semibold">
              {isBatch ? `Manage ${lanes.length} lanes` : "Manage lane"}
            </Dialog.Title>
            <Dialog.Close asChild><Button variant="ghost" size="sm">Esc</Button></Dialog.Close>
          </div>
          {lanes.length === 0 ? (
            <div className="text-sm text-muted-fg">Select a lane first.</div>
          ) : allPrimary ? (
            <div className="text-sm text-muted-fg">Primary lane cannot be archived or deleted.</div>
          ) : (
            <div className="space-y-3">
              {/* Lane info cards */}
              {isBatch ? (
                <div className="max-h-[180px] overflow-auto rounded border border-border/20 bg-bg/40 p-3 space-y-1.5">
                  {lanes.map((lane) => (
                    <div key={lane.id} className="flex items-center gap-2 text-xs">
                      <GitBranch size={12} className="shrink-0 text-muted-fg" />
                      <span className="font-semibold">{lane.name}</span>
                      <span className="text-muted-fg">{lane.branchRef}</span>
                      <span className="rounded bg-muted/30 px-1.5 py-0.5 text-[10px] uppercase text-muted-fg">
                        {lane.laneType}
                      </span>
                      {lane.status.dirty ? (
                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase text-amber-400">dirty</span>
                      ) : null}
                      {lane.laneType === "primary" ? (
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] uppercase text-emerald-400">protected</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded border border-border/20 bg-bg/40 p-3 text-xs">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-semibold">{lanes[0].name}</span>
                    <span className="rounded bg-muted/30 px-1.5 py-0.5 text-[11px] uppercase text-muted-fg">
                      {lanes[0].laneType}
                    </span>
                  </div>
                  <div><span className="text-muted-fg">Branch:</span> {lanes[0].branchRef}</div>
                  <div className="truncate"><span className="text-muted-fg">Path:</span> {lanes[0].worktreePath}</div>
                </div>
              )}

              {/* Adopt attached — single lane only */}
              {!isBatch && isAttached ? (
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

              {/* Archive */}
              <div className="rounded border border-border/20 bg-bg/40 p-3">
                <div className="mb-2 text-xs font-semibold">Archive</div>
                <div className="mb-2 text-xs text-muted-fg">
                  {isBatch
                    ? `Hide ${lanes.length} lanes from ADE without deleting worktrees or branches.`
                    : "Hide lane from ADE without deleting worktree or branches."}
                </div>
                <Button size="sm" variant="outline" disabled={laneActionBusy} onClick={onArchive}>
                  {isBatch ? `Archive ${lanes.length} lanes` : "Archive lane from ADE"}
                </Button>
              </div>

              {/* Delete */}
              <div className="rounded border border-red-500/30 bg-red-500/10 p-3">
                <div className="mb-2 text-xs font-semibold text-red-300">
                  {hasAttached && !isBatch ? "Detach / Delete" : "Delete"}
                </div>
                <div className="mb-2 text-xs text-red-300">{destructiveMessage}</div>
                {hasAnyDirty ? (
                  <div className="mb-2 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
                    <WarningCircle size={14} className="mt-0.5 shrink-0" />
                    <span>{isBatch ? "Some lanes have uncommitted changes." : "This lane has uncommitted changes."}</span>
                  </div>
                ) : null}
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
                    <span className="whitespace-pre-wrap">{laneActionError}</span>
                  </div>
                ) : null}
                <Button size="sm" variant="primary" disabled={laneActionBusy || deleteConfirmText.trim().toLowerCase() !== deletePhrase.toLowerCase()} onClick={onDelete}>
                  {laneActionBusy
                    ? "Working..."
                    : isBatch
                      ? `Delete ${lanes.length} lanes`
                      : "Delete lane"}
                </Button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
