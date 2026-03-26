import * as Dialog from "@radix-ui/react-dialog";
import { ArrowSquareOut, GitBranch, WarningCircle, Archive, Trash, X } from "@phosphor-icons/react";
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
  const hasNonAttached = lanes.some((l) => l.laneType !== "attached" && l.laneType !== "primary");
  const isMixed = hasAttached && hasNonAttached;
  const worktreeDeleteLabel = isMixed
    ? "Unlink attached lanes & remove worktree files"
    : hasAttached
      ? "Unlink lane (keep branch)"
      : "Remove worktree files only";
  const localDeleteLabel = isMixed
    ? "Unlink attached & delete local branches"
    : hasAttached
      ? "Unlink + delete local branch"
      : "+ local branch";
  const remoteDeleteLabel = isMixed
    ? "Unlink attached & delete local + remote branches"
    : hasAttached
      ? "Unlink + delete local and remote branch"
      : "Delete local and remote branch";
  const confirmMatch = deleteConfirmText.trim().toLowerCase() === deletePhrase.toLowerCase();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-[12%] z-50 w-[min(720px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border/30 bg-card shadow-2xl focus:outline-none">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/20 px-5 py-3.5">
            <Dialog.Title className="flex items-center gap-2.5 text-sm font-semibold text-fg">
              <GitBranch size={16} className="text-accent" />
              {isBatch ? `Manage ${lanes.length} Lanes` : "Manage Lane"}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-fg transition-colors hover:bg-muted/20 hover:text-fg">
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          {lanes.length === 0 ? (
            <div className="p-5 text-sm text-muted-fg">Select a lane first.</div>
          ) : allPrimary ? (
            <div className="p-5 text-sm text-muted-fg">Primary lane cannot be archived or deleted.</div>
          ) : (
            <div className="max-h-[70vh] overflow-auto p-5 space-y-4">
              {/* Lane info */}
              {isBatch ? (
                <div className="max-h-[140px] overflow-auto rounded-lg border border-border/15 bg-surface-recessed p-3 space-y-1.5">
                  {lanes.map((lane) => (
                    <div key={lane.id} className="flex items-center gap-2 text-xs">
                      <GitBranch size={11} className="shrink-0 text-muted-fg" />
                      <span className="font-semibold text-fg">{lane.name}</span>
                      <span className="truncate text-muted-fg">{lane.branchRef}</span>
                      <span className="rounded-md bg-muted/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-fg">{lane.laneType}</span>
                      {lane.status.dirty && <span className="rounded-md bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-400">dirty</span>}
                      {lane.laneType === "primary" && <span className="rounded-md bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-400">protected</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-border/15 bg-surface-recessed p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-fg">{lanes[0].name}</span>
                    <span className="rounded-md bg-muted/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-fg">{lanes[0].laneType}</span>
                  </div>
                  <div className="mt-1.5 space-y-0.5 text-xs text-muted-fg">
                    <div>Branch: <span className="font-mono text-fg/80">{lanes[0].branchRef}</span></div>
                    <div className="truncate">Path: <span className="font-mono text-fg/80">{lanes[0].worktreePath}</span></div>
                  </div>
                </div>
              )}

              {/* Adopt attached — single lane only */}
              {!isBatch && isAttached && (
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/6 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-blue-300">
                        <ArrowSquareOut size={15} />
                        Move to ADE-Managed Worktree
                      </div>
                      <div className="mt-1 text-xs text-blue-300/80">
                        Move this attached worktree into <span className="font-mono">.ade/worktrees</span> for full lifecycle management.
                      </div>
                    </div>
                    <Button size="sm" variant="outline" disabled={laneActionBusy} onClick={onAdoptAttached}>
                      Move
                    </Button>
                  </div>
                </div>
              )}

              {/* Archive */}
              <div className="rounded-lg border border-accent/15 bg-accent/4 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                      <Archive size={15} className="text-accent" />
                      Archive
                    </div>
                    <div className="mt-1 text-xs text-muted-fg">
                      {isBatch
                        ? `Hide ${lanes.length} lanes from ADE without deleting worktrees or branches.`
                        : "Hide from ADE without deleting worktree or branches."}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" disabled={laneActionBusy} onClick={onArchive}>
                    {isBatch ? `Archive ${lanes.length}` : "Archive"}
                  </Button>
                </div>
              </div>

              {/* Delete */}
              <div className="rounded-lg border border-red-500/20 bg-red-500/4 p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-red-400">
                  <Trash size={15} />
                  {hasAttached && !isBatch ? "Detach / Delete" : "Delete"}
                </div>

                {hasAnyDirty && (
                  <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs text-amber-300">
                    <WarningCircle size={14} className="shrink-0" />
                    {isBatch ? "Some lanes have uncommitted changes." : "This lane has uncommitted changes."}
                  </div>
                )}

                {/* Delete mode selector */}
                <div className="mb-3 grid gap-2 md:grid-cols-3">
                  {([
                    { value: "worktree" as const, label: worktreeDeleteLabel },
                    { value: "local_branch" as const, label: localDeleteLabel },
                    { value: "remote_branch" as const, label: remoteDeleteLabel },
                  ]).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setDeleteMode(opt.value)}
                      className={`rounded-lg border px-3 py-2.5 text-left text-xs transition-all ${
                        deleteMode === opt.value
                          ? "border-red-500/30 bg-red-500/10 font-semibold text-red-300"
                          : "border-border/15 bg-surface-recessed text-muted-fg hover:border-border/30 hover:text-fg"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {/* Remote name */}
                {deleteMode === "remote_branch" && (
                  <div className="mb-3">
                    <label className="mb-1 block text-xs text-muted-fg">Remote name</label>
                    <input
                      value={deleteRemoteName}
                      onChange={(event) => setDeleteRemoteName(event.target.value)}
                      className="h-8 w-full rounded-lg border border-border/15 bg-surface-recessed px-3 font-mono text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                      placeholder="origin"
                    />
                  </div>
                )}

                {/* Force delete */}
                <label className="mb-1 flex items-center gap-2 text-xs text-muted-fg cursor-pointer select-none">
                  <input type="checkbox" checked={deleteForce} onChange={(event) => setDeleteForce(event.target.checked)} className="rounded" />
                  Force delete (skip safety checks)
                </label>
                <p className="text-xs text-yellow-400/70 mt-1 mb-3">
                  Force delete will remove the lane even if it has uncommitted changes.
                </p>

                {/* Confirmation */}
                <div className="mb-3">
                  <label className="mb-1 block text-xs text-muted-fg">
                    Type <span className="font-semibold text-red-400">{deletePhrase}</span> to confirm
                  </label>
                  <input
                    value={deleteConfirmText}
                    onChange={(event) => setDeleteConfirmText(event.target.value)}
                    className={`h-8 w-full rounded-lg border bg-surface-recessed px-3 font-mono text-xs text-fg outline-none transition-colors ${
                      confirmMatch ? "border-red-500/40" : "border-border/15"
                    } focus:ring-1 focus:ring-red-500/20`}
                  />
                </div>

                {/* Error */}
                {laneActionError && (
                  <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs text-red-300">
                    <WarningCircle size={14} className="mt-0.5 shrink-0" />
                    <span className="whitespace-pre-wrap">{laneActionError}</span>
                  </div>
                )}

                <Button
                  size="sm"
                  variant="primary"
                  className="bg-red-600 hover:bg-red-500"
                  disabled={laneActionBusy || !confirmMatch}
                  onClick={onDelete}
                >
                  <Trash size={13} />
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
