import React, { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Archive, ExternalLink, GitBranch, GitMerge, Layers3, Pencil, TerminalSquare, Trash2 } from "lucide-react";
import type { ConflictChip, ConflictStatus, LaneSummary } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../state/appStore";
import { MergeSimulationPanel } from "../conflicts/MergeSimulationPanel";

function conflictDotClass(status: ConflictStatus["status"] | null | undefined): string {
  if (status === "conflict-active") return "bg-red-600";
  if (status === "conflict-predicted") return "bg-orange-500";
  if (status === "behind-base") return "bg-amber-500";
  if (status === "merge-ready") return "bg-emerald-500";
  return "bg-muted-fg";
}

function conflictSeverity(status: ConflictStatus["status"] | null | undefined): number {
  if (status === "conflict-active") return 5;
  if (status === "conflict-predicted") return 4;
  if (status === "behind-base") return 3;
  if (status === "unknown") return 2;
  return 1;
}

function chipText(kind: ConflictChip["kind"]): string {
  return kind === "new-overlap" ? "new overlap" : "high risk";
}

export function LaneRow({
  lane,
  selected,
  primary,
  onSelect,
  isLastSibling,
  conflictStatus,
  conflictChips
}: {
  lane: LaneSummary;
  selected: boolean;
  primary?: boolean;
  onSelect: (args: { extend: boolean }) => void;
  isLastSibling?: boolean;
  conflictStatus?: ConflictStatus | null;
  conflictChips?: ConflictChip[];
}) {
  const navigate = useNavigate();
  const focusSession = useAppStore((s) => s.focusSession);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const lanes = useAppStore((s) => s.lanes);

  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);

  const [draftName, setDraftName] = useState(lane.name);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteForce, setDeleteForce] = useState(false);
  const [statusAnimClass, setStatusAnimClass] = useState<string | null>(null);
  const previousStatusRef = useRef<ConflictStatus["status"] | null>(conflictStatus?.status ?? null);

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const isPrimaryLane = lane.laneType === "primary";
  const stackIndentPx = lane.stackDepth * 16;
  const connectorLeft = 8 + Math.max(0, lane.stackDepth - 1) * 16;

  const confirmationPhrase = `delete ${lane.name}`;

  useEffect(() => {
    const prev = previousStatusRef.current;
    const next = conflictStatus?.status ?? null;
    previousStatusRef.current = next;
    if (!prev || !next || prev === next) return;
    const nextSeverity = conflictSeverity(next);
    const prevSeverity = conflictSeverity(prev);
    if (nextSeverity > prevSeverity) {
      setStatusAnimClass("ade-conflict-badge-worse");
      const timer = window.setTimeout(() => setStatusAnimClass(null), 1900);
      return () => window.clearTimeout(timer);
    }
    if (nextSeverity < prevSeverity) {
      setStatusAnimClass("ade-conflict-badge-better");
      const timer = window.setTimeout(() => setStatusAnimClass(null), 420);
      return () => window.clearTimeout(timer);
    }
  }, [conflictStatus?.status]);

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1 rounded shadow-card bg-card/70 p-3 transition-all hover:shadow-card-hover",
        primary && "bg-card/90 shadow-card-hover",
        selected && !primary && "bg-card/85 shadow-card-hover"
      )}
      style={{ paddingLeft: `${12 + stackIndentPx}px` }}
      onClick={(event) => onSelect({ extend: event.shiftKey })}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect({ extend: e.shiftKey });
      }}
    >
      {lane.parentLaneId ? (
        <>
          <div
            className="pointer-events-none absolute w-px bg-border/25"
            style={
              isLastSibling
                ? { left: `${connectorLeft}px`, top: "0px", bottom: "50%" }
                : { left: `${connectorLeft}px`, top: "0px", bottom: "0px" }
            }
          />
          <div
            className="pointer-events-none absolute h-px bg-border/25"
            style={{ left: `${connectorLeft}px`, top: "20px", width: "10px" }}
          />
        </>
      ) : null}
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitBranch className={cn("h-3.5 w-3.5", selected ? "text-accent" : "text-muted-fg")} />
            <span className="truncate font-serif text-base font-semibold tracking-tight text-fg">{lane.name}</span>
            <span className="rounded-lg bg-muted/40 px-1.5 py-0.5 text-xs text-muted-fg/70">{lane.laneType}</span>
            {lane.parentLaneId ? (
              <span className="inline-flex items-center gap-1 rounded-lg bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase text-muted-fg">
                <Layers3 className="h-3 w-3" />
                d{lane.stackDepth}
              </span>
            ) : null}
            {isPrimaryLane ? <span className="rounded-lg bg-emerald-500/15 px-1.5 py-0.5 text-[10px] uppercase text-emerald-700">home</span> : null}
            <span className={cn("inline-flex items-center gap-1 rounded-lg bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase text-muted-fg transition-colors duration-400", statusAnimClass)}>
              <span className={cn("inline-block h-2 w-2 rounded-full", conflictDotClass(conflictStatus?.status))} />
              {conflictStatus?.status ?? "unknown"}
            </span>
          </div>
          {lane.description ? (
            <div className="mt-0.5 truncate pl-6 font-mono text-xs text-muted-fg opacity-80">{lane.description}</div>
          ) : null}
          {conflictChips && conflictChips.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1 pl-6">
              {conflictChips.slice(0, 2).map((chip, index) => (
                <span
                  key={`${chip.kind}:${chip.peerId ?? "base"}:${index}`}
                  className={cn(
                    "rounded-lg px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                    chip.kind === "high-risk"
                      ? "bg-red-900/30 text-red-200"
                      : "bg-amber-900/20 text-amber-200"
                  )}
                >
                  {chipText(chip.kind)}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className={cn("flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100", selected && "opacity-100")}>
          <Dialog.Root open={simulateOpen} onOpenChange={setSimulateOpen}>
            <Dialog.Trigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 hover:text-accent"
                title="Simulate merge"
                onClick={(e) => e.stopPropagation()}
              >
                <GitMerge className="h-3.5 w-3.5" />
              </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
              <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(860px,calc(100vw-24px))] -translate-x-1/2 rounded bg-bg border border-border/40 p-3 shadow-float focus:outline-none">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <Dialog.Title className="text-lg font-serif font-bold">Merge Simulation</Dialog.Title>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="sm">
                      Esc
                    </Button>
                  </Dialog.Close>
                </div>
                <MergeSimulationPanel lanes={lanes} initialLaneAId={lane.id} initialLaneBId={""} />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

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
              <Dialog.Content className="fixed left-1/2 top-[22%] z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded bg-bg border border-border/40 p-3 shadow-float focus:outline-none">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <Dialog.Title className="text-lg font-semibold">Rename Lane</Dialog.Title>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="sm">
                      Esc
                    </Button>
                  </Dialog.Close>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-xs text-muted-fg">Name</label>
                    <input
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      className="block w-full rounded bg-muted/30 shadow-card px-3 py-2 text-lg focus:outline-none"
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
                <Dialog.Content className="fixed left-1/2 top-[22%] z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded bg-bg border border-border/40 p-3 shadow-float focus:outline-none">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <Dialog.Title className="text-lg font-semibold">Archive Lane</Dialog.Title>
                    <Dialog.Close asChild>
                      <Button variant="ghost" size="sm">
                        Esc
                      </Button>
                    </Dialog.Close>
                  </div>
                  <div className="mb-6 text-sm text-muted-fg">Are you sure? This will hide the lane from the list.</div>
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
                <Dialog.Content className="fixed left-1/2 top-[14%] z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded bg-bg border border-border/40 p-3 shadow-float focus:outline-none">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <Dialog.Title className="flex items-center gap-2 text-lg font-semibold text-red-300">
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
                  <div className="rounded bg-red-950/30 p-3 text-red-200">
                    This action permanently deletes this lane from your computer and git.
                  </div>

                  <div className="rounded bg-card/70 shadow-card p-3 font-mono text-xs">
                    <div>Lane: {lane.name}</div>
                    <div>Branch to delete: {lane.branchRef}</div>
                    <div className="truncate">Worktree to remove: {lane.worktreePath}</div>
                    {lane.status.dirty ? (
                      <div className="mt-2 text-red-300">Warning: this lane currently has uncommitted changes.</div>
                    ) : null}
                  </div>

                  <label className="flex items-center gap-2 rounded bg-card/70 shadow-card p-2 text-xs">
                    <input
                      type="checkbox"
                      checked={deleteForce}
                      onChange={(event) => setDeleteForce(event.target.checked)}
                    />
                    Force delete (required if worktree is dirty or protected)
                  </label>

                  <div>
                    <label className="mb-1 block text-xs text-muted-fg">
                      Type <span className="text-red-300">{confirmationPhrase}</span> to confirm
                    </label>
                    <input
                      value={deleteConfirmText}
                      onChange={(event) => setDeleteConfirmText(event.target.value)}
                      className="h-9 w-full rounded bg-card/70 shadow-card px-2 text-sm outline-none"
                      autoFocus
                    />
                  </div>

                  {deleteError ? <div className="rounded bg-red-950/20 p-2 text-xs text-red-300">{deleteError}</div> : null}

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

      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-border/10 pt-2 text-[10px] font-mono uppercase tracking-wider text-muted-fg">
        <div className="flex flex-col">
          <span className="opacity-50">{lane.parentLaneId ? "Vs Parent" : "Pull"}</span>
          <span className={cn("font-bold", lane.status.ahead > 0 || lane.status.behind > 0 ? "text-accent" : "text-fg")}>
            {lane.status.ahead}↑ {lane.status.behind}↓
          </span>
        </div>
        <div className="flex flex-col pl-2">
          <span className="opacity-50">State</span>
          <span className={cn("font-bold", lane.status.dirty ? "text-accent" : "text-fg")}>{lane.status.dirty ? "DIRTY" : "CLEAN"}</span>
        </div>
        <div className="flex flex-col pl-2">
          <span className="opacity-50">Last Active</span>
          <span className="text-fg">{isPrimaryLane ? "Pinned" : "Just now"}</span>
        </div>
      </div>
    </div>
  );
}
