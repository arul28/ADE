import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Warning, Archive, ArrowSquareOut, ArrowDown, GitBranch, GitMerge, Stack, PencilSimple, Terminal, Trash } from "@phosphor-icons/react";
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

function RemotePullBanner({ laneId, behindCount }: { laneId: string; behindCount: number }) {
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const handlePull = async () => {
    setPulling(true);
    setError(null);
    try {
      await window.ade.git.pull({ laneId });
      refreshLanes?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPulling(false);
    }
  };

  return (
    <div
      className="mt-2 flex items-center gap-2 px-3 py-2 text-[11px] font-mono"
      style={{
        background: "rgba(59,130,246,0.06)",
        border: "1px solid rgba(59,130,246,0.20)",
        borderRadius: 4,
      }}
    >
      <ArrowDown size={13} weight="bold" className="text-blue-400 shrink-0" />
      <span className="text-blue-300">
        {behindCount} commit{behindCount > 1 ? "s" : ""} behind remote
      </span>
      <button
        type="button"
        disabled={pulling}
        onClick={(e) => { e.stopPropagation(); void handlePull(); }}
        className="ml-auto font-bold uppercase tracking-[1px] text-[10px] px-2.5 py-1 transition-colors"
        style={{
          background: "rgba(59,130,246,0.15)",
          border: "1px solid rgba(59,130,246,0.30)",
          color: "#60A5FA",
          cursor: pulling ? "not-allowed" : "pointer",
          opacity: pulling ? 0.5 : 1,
        }}
      >
        {pulling ? "PULLING..." : "PULL"}
      </button>
      {error && <span className="text-red-400 text-[10px] truncate max-w-[200px]" title={error}>{error}</span>}
    </div>
  );
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
        "group relative flex flex-col gap-1 rounded-lg bg-card/50 backdrop-blur-sm py-2.5 px-3 mb-1.5 transition-all duration-200 border border-border/10",
        "hover:bg-card/70 hover:shadow-[0_4px_20px_-4px_rgba(0,0,0,0.4)] hover:-translate-y-[1px]",
        "shadow-[0_2px_8px_-2px_rgba(0,0,0,0.3)]",
        primary && "bg-card/80 shadow-[0_0_16px_-4px_rgba(16,185,129,0.15)] border-emerald-500/15 hover:border-emerald-500/25 hover:shadow-[0_0_20px_-4px_rgba(16,185,129,0.2)]",
        selected && !primary && "bg-card/75 shadow-[0_0_16px_-4px_rgba(245,158,11,0.2)] ring-1 ring-amber-500/15 border-amber-500/15 hover:shadow-[0_0_20px_-4px_rgba(245,158,11,0.25)]"
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
            <GitBranch size={14} className={cn(selected ? "text-accent" : "text-muted-fg")} />
            <span className="truncate font-sans text-base font-semibold tracking-tight text-fg">{lane.name}</span>
            <span className="rounded-lg bg-muted/30 px-1.5 py-0.5 text-xs text-muted-fg/70 border border-border/10">{lane.laneType}</span>
            {lane.parentLaneId ? (
              <span className="inline-flex items-center gap-1 rounded-lg bg-muted/40 px-1.5 py-0.5 text-[11px] uppercase text-muted-fg">
                <Stack size={12} />
                d{lane.stackDepth}
              </span>
            ) : null}
            {isPrimaryLane ? <span className="rounded-lg bg-emerald-500/15 px-1.5 py-0.5 text-[11px] uppercase text-emerald-700 shadow-[0_0_6px_-1px_rgba(16,185,129,0.3)]">home</span> : null}
            <span className={cn(
              "inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] uppercase text-muted-fg transition-all duration-400 border border-border/10",
              conflictStatus?.status === "conflict-active" && "bg-red-500/10 text-red-300 border-red-500/20 shadow-[0_0_8px_-2px_rgba(239,68,68,0.25)]",
              conflictStatus?.status === "conflict-predicted" && "bg-orange-500/10 text-orange-300 border-orange-500/20 shadow-[0_0_8px_-2px_rgba(249,115,22,0.2)]",
              conflictStatus?.status === "behind-base" && "bg-amber-500/10 text-amber-300 border-amber-500/20 shadow-[0_0_6px_-2px_rgba(245,158,11,0.2)]",
              conflictStatus?.status === "merge-ready" && "bg-emerald-500/10 text-emerald-300 border-emerald-500/20 shadow-[0_0_6px_-2px_rgba(16,185,129,0.2)]",
              !conflictStatus?.status && "bg-muted/30",
              statusAnimClass
            )}>
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
                    "rounded-lg px-1.5 py-0.5 text-[11px] uppercase tracking-wide",
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
                <GitMerge size={14} />
              </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
              <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(860px,calc(100vw-24px))] -translate-x-1/2 rounded bg-bg border border-border/40 p-3 shadow-float focus:outline-none">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <Dialog.Title className="text-lg font-sans font-bold">Merge Simulation</Dialog.Title>
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
            <Terminal size={14} />
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
            <ArrowSquareOut size={14} />
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
                <PencilSimple size={14} />
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
                      className="block w-full rounded border border-border/15 bg-surface-recessed shadow-card px-3 py-2 text-lg focus:outline-none"
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
                  <Archive size={14} />
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
                  <Trash size={14} />
                </Button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
                <Dialog.Content className="fixed left-1/2 top-[14%] z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded bg-bg border border-border/40 p-3 shadow-float focus:outline-none">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <Dialog.Title className="flex items-center gap-2 text-lg font-semibold text-red-300">
                      <Warning size={20} />
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

      {/* Pull from remote suggestion */}
      {lane.status.remoteBehind > 0 && (
        <RemotePullBanner laneId={lane.id} behindCount={lane.status.remoteBehind} />
      )}

      <div className="mt-2 grid grid-cols-3 gap-2 pt-2 border-t border-border/5 text-[11px] font-mono uppercase tracking-wider text-muted-fg">
        <div className="flex flex-col rounded-md bg-card/30 p-1.5">
          <span className="opacity-50">{lane.parentLaneId ? "Vs Parent" : "Pull"}</span>
          <span className="font-bold">
            <span className={cn(lane.status.ahead > 0 ? "text-emerald-400" : "text-fg")}>{lane.status.ahead}↑</span>{" "}
            <span className={cn(lane.status.behind > 0 ? "text-red-400" : "text-fg")}>{lane.status.behind}↓</span>
          </span>
        </div>
        <div className="flex flex-col rounded-md bg-card/30 p-1.5">
          <span className="opacity-50">State</span>
          <span className={cn("font-bold", lane.status.dirty ? "text-accent" : "text-fg")}>{lane.status.dirty ? "DIRTY" : "CLEAN"}</span>
        </div>
        <div className="flex flex-col rounded-md bg-card/30 p-1.5">
          <span className="opacity-50">Last Active</span>
          <span className="text-fg">{isPrimaryLane ? "Pinned" : "--"}</span>
        </div>
      </div>
    </div>
  );
}
