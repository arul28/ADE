import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Archive, ExternalLink, GitBranch, Pencil, TerminalSquare, Trash2 } from "lucide-react";
import type { LaneSummary } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../state/appStore";

export function LaneRow({
  lane,
  selected,
  primary,
  onSelect
}: {
  lane: LaneSummary;
  selected: boolean;
  primary?: boolean;
  onSelect: (args: { extend: boolean }) => void;
}) {
  const navigate = useNavigate();
  const focusSession = useAppStore((s) => s.focusSession);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const [draftName, setDraftName] = useState(lane.name);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteForce, setDeleteForce] = useState(false);

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const isPrimaryLane = lane.laneType === "primary";

  const confirmationPhrase = `delete ${lane.name}`;

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1 rounded-sm border border-border bg-card p-3 transition-all hover:border-muted-fg/40",
        primary && "border-accent ring-1 ring-accent bg-accent/8",
        selected && !primary && "border-accent/50 bg-accent/5"
      )}
      onClick={(event) => onSelect({ extend: event.shiftKey })}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect({ extend: e.shiftKey });
      }}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitBranch className={cn("h-3.5 w-3.5", selected ? "text-accent" : "text-muted-fg")} />
            <span className="truncate font-serif text-base font-semibold tracking-tight text-fg">{lane.name}</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-fg">{lane.laneType}</span>
            {isPrimaryLane ? <span className="rounded border border-emerald-400 px-1.5 py-0.5 text-[10px] uppercase text-emerald-700">home</span> : null}
          </div>
          {lane.description ? (
            <div className="mt-0.5 truncate pl-6 font-mono text-xs text-muted-fg opacity-80">{lane.description}</div>
          ) : null}
        </div>

        <div className={cn("flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100", selected && "opacity-100")}>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 hover:text-accent"
            title="New terminal"
            onClick={(e) => {
              e.stopPropagation();
              window.ade.pty
                .create({ laneId: lane.id, cols: 100, rows: 30, title: "Shell" })
                .then(({ sessionId }) => {
                  focusSession(sessionId);
                  navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}&sessionId=${encodeURIComponent(sessionId)}`);
                })
                .catch(() => { });
            }}
          >
            <TerminalSquare className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 hover:text-accent"
            title="Open folder"
            onClick={(e) => {
              e.stopPropagation();
              window.ade.lanes.openFolder({ laneId: lane.id }).catch(() => { });
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>

          <Dialog.Root
            open={renameOpen}
            onOpenChange={(value) => {
              setRenameOpen(value);
              if (value) setDraftName(lane.name);
            }}
          >
            <Dialog.Trigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 hover:text-accent"
                title="Rename lane"
                onClick={(e) => e.stopPropagation()}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
              <Dialog.Content className="fixed left-1/2 top-[22%] z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-none border border-fg bg-bg p-4 shadow-2xl focus:outline-none">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <Dialog.Title className="text-lg font-serif font-bold">Rename Lane</Dialog.Title>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="sm">
                      Esc
                    </Button>
                  </Dialog.Close>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-xs font-mono uppercase text-muted-fg">Name</label>
                    <input
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      className="block w-full border-b border-border bg-transparent py-1 text-lg font-serif focus:border-accent focus:outline-none"
                      autoFocus
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" onClick={() => setRenameOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      disabled={!draftName.trim().length || draftName.trim() === lane.name}
                      onClick={() => {
                        window.ade.lanes
                          .rename({ laneId: lane.id, name: draftName.trim() })
                          .then(async () => {
                            await refreshLanes();
                            setRenameOpen(false);
                          })
                          .catch(() => { });
                      }}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          {!isPrimaryLane ? (
            <Dialog.Root open={archiveOpen} onOpenChange={setArchiveOpen}>
              <Dialog.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 hover:text-accent"
                  title="Archive lane"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Archive className="h-3.5 w-3.5" />
                </Button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
                <Dialog.Content className="fixed left-1/2 top-[22%] z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-none border border-fg bg-bg p-4 shadow-2xl focus:outline-none">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <Dialog.Title className="text-lg font-serif font-bold">Archive Lane</Dialog.Title>
                    <Dialog.Close asChild>
                      <Button variant="ghost" size="sm">
                        Esc
                      </Button>
                    </Dialog.Close>
                  </div>
                  <div className="mb-6 font-mono text-sm text-muted-fg">Are you sure? This will hide the lane from the list.</div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setArchiveOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => {
                        window.ade.lanes
                          .archive({ laneId: lane.id })
                          .then(async () => {
                            await refreshLanes();
                            setArchiveOpen(false);
                          })
                          .catch(() => { });
                      }}
                    >
                      Confirm Archive
                    </Button>
                  </div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          ) : null}

          {!isPrimaryLane ? (
            <Dialog.Root
              open={deleteOpen}
              onOpenChange={(value) => {
                setDeleteOpen(value);
                if (value) {
                  setDeleteConfirmText("");
                  setDeleteForce(false);
                  setDeleteError(null);
                }
              }}
            >
              <Dialog.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-red-500 hover:text-red-400"
                  title="Delete lane from disk and git"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
                <Dialog.Content className="fixed left-1/2 top-[14%] z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded-none border border-red-700 bg-bg p-4 shadow-2xl focus:outline-none">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <Dialog.Title className="flex items-center gap-2 text-lg font-serif font-bold text-red-300">
                      <AlertTriangle className="h-5 w-5" />
                      Delete Lane Permanently
                    </Dialog.Title>
                    <Dialog.Close asChild>
                      <Button variant="ghost" size="sm">
                        Esc
                      </Button>
                    </Dialog.Close>
                  </div>

                <div className="space-y-3 text-sm">
                  <div className="rounded border border-red-900 bg-red-950/30 p-3 text-red-200">
                    This action permanently deletes this lane from your computer and git.
                  </div>

                  <div className="rounded border border-border bg-card/70 p-3 font-mono text-xs">
                    <div>Lane: {lane.name}</div>
                    <div>Branch to delete: {lane.branchRef}</div>
                    <div className="truncate">Worktree to remove: {lane.worktreePath}</div>
                    {lane.status.dirty ? (
                      <div className="mt-2 text-red-300">Warning: this lane currently has uncommitted changes.</div>
                    ) : null}
                  </div>

                  <label className="flex items-center gap-2 rounded border border-border bg-card/70 p-2 text-xs">
                    <input
                      type="checkbox"
                      checked={deleteForce}
                      onChange={(event) => setDeleteForce(event.target.checked)}
                    />
                    Force delete (required if worktree is dirty or protected)
                  </label>

                  <div>
                    <label className="mb-1 block text-xs font-mono uppercase text-muted-fg">
                      Type <span className="text-red-300">{confirmationPhrase}</span> to confirm
                    </label>
                    <input
                      value={deleteConfirmText}
                      onChange={(event) => setDeleteConfirmText(event.target.value)}
                      className="h-9 w-full rounded border border-border bg-card/70 px-2 text-sm outline-none"
                      autoFocus
                    />
                  </div>

                  {deleteError ? <div className="rounded border border-red-900 bg-red-950/20 p-2 text-xs text-red-300">{deleteError}</div> : null}

                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleteBusy}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      disabled={deleteBusy || deleteConfirmText.trim().toLowerCase() !== confirmationPhrase.toLowerCase()}
                      onClick={() => {
                        setDeleteBusy(true);
                        setDeleteError(null);
                        window.ade.lanes
                          .delete({ laneId: lane.id, deleteBranch: true, force: deleteForce })
                          .then(async () => {
                            await refreshLanes();
                            setDeleteOpen(false);
                          })
                          .catch((err) => {
                            console.error("Delete lane failed:", err);
                            setDeleteError(err instanceof Error ? err.message : String(err));
                          })
                          .finally(() => setDeleteBusy(false));
                      }}
                    >
                      {deleteBusy ? "Deleting…" : "Delete Lane + Branch"}
                    </Button>
                  </div>
                </div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          ) : null}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-border pt-2 text-[10px] font-mono uppercase tracking-wider text-muted-fg">
        <div className="flex flex-col">
          <span className="opacity-50">Sync</span>
          <span className={cn("font-bold", lane.status.ahead > 0 || lane.status.behind > 0 ? "text-accent" : "text-fg")}>
            {lane.status.ahead}↑ {lane.status.behind}↓
          </span>
        </div>
        <div className="flex flex-col border-l border-border pl-2">
          <span className="opacity-50">State</span>
          <span className={cn("font-bold", lane.status.dirty ? "text-accent" : "text-fg")}>{lane.status.dirty ? "DIRTY" : "CLEAN"}</span>
        </div>
        <div className="flex flex-col border-l border-border pl-2">
          <span className="opacity-50">Last Active</span>
          <span className="text-fg">{isPrimaryLane ? "Pinned" : "Just now"}</span>
        </div>
      </div>
    </div>
  );
}
