import React, { useEffect, useState } from "react";
import {
  ArrowSquareOut,
  GitBranch,
  WarningCircle,
  Archive,
  Trash,
  CircleNotch,
  Palette,
  Terminal,
  Cpu,
  Eye,
  Cube,
  CheckCircle,
  X,
  Minus
} from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import type {
  LaneDeleteProgress,
  LaneDeleteRisk,
  LaneDeleteStep,
  LaneDeleteStepName,
  LaneSummary
} from "../../../shared/types";
import { LaneDialogShell } from "./LaneDialogShell";
import { SECTION_CLASS_NAME, LABEL_CLASS_NAME, INPUT_CLASS_NAME } from "./laneDialogTokens";
import { LaneColorPicker } from "./LaneColorPicker";
import { colorsInUse, laneColorName } from "./laneColorPalette";

const STEP_LABELS: Record<LaneDeleteStepName, string> = {
  git_status: "Checking dirty state",
  cancel_auto_rebase: "Cancelling auto-rebase",
  stop_processes: "Stopping processes",
  stop_ptys: "Closing terminal sessions",
  stop_watchers: "Stopping file watchers",
  cleanup_env: "Cleaning environment",
  git_worktree_remove: "Removing worktree",
  git_branch_delete: "Deleting local branch",
  git_remote_branch_delete: "Deleting remote branch",
  pack_dir_remove: "Cleaning pack folder",
  database_cleanup: "Updating database"
};

export function ManageLaneDialog({
  open,
  onOpenChange,
  managedLane,
  managedLanes,
  allLanes,
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
  laneActionStatus,
  laneActionError,
  laneActionKind,
  onAdoptAttached,
  onArchive,
  onDelete,
  onAppearanceChanged
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  managedLane: LaneSummary | null;
  managedLanes?: LaneSummary[];
  allLanes: LaneSummary[];
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
  laneActionStatus: string | null;
  laneActionError: string | null;
  laneActionKind?: "delete" | "archive" | "adopt" | null;
  onAdoptAttached: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onAppearanceChanged?: () => void | Promise<void>;
}) {
  const lanes = managedLanes?.length ? managedLanes : managedLane ? [managedLane] : [];
  const isBatch = lanes.length > 1;
  const allPrimary = lanes.length > 0 && lanes.every((l) => l.laneType === "primary");
  const hasAttached = lanes.some((l) => l.laneType === "attached");
  const hasAnyDirty = lanes.some((l) => l.status.dirty);
  const singleLane = !isBatch ? lanes[0] ?? null : null;

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

  const [deleteRisk, setDeleteRisk] = useState<LaneDeleteRisk | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<LaneDeleteProgress | null>(null);

  // Reset transient state when dialog closes or active lane changes.
  useEffect(() => {
    if (!open) {
      setDeleteRisk(null);
      setDeleteProgress(null);
    }
  }, [open]);

  // Fetch pre-flight risk for the single-lane case.
  useEffect(() => {
    if (!open || !singleLane || singleLane.laneType === "primary") {
      setDeleteRisk(null);
      return;
    }
    let cancelled = false;
    void window.ade.lanes
      .getDeleteRisk({ laneId: singleLane.id })
      .then((risk) => {
        if (!cancelled) setDeleteRisk(risk);
      })
      .catch(() => {
        // best-effort — pre-flight is informational only
      });
    return () => {
      cancelled = true;
    };
  }, [open, singleLane?.id]);

  // Stream live delete progress for the active lane.
  useEffect(() => {
    if (!open || !singleLane) return;
    const unsubscribe = window.ade.lanes.onDeleteEvent((event) => {
      if (event.progress.laneId !== singleLane.id) return;
      setDeleteProgress(event.progress);
    });
    return () => {
      unsubscribe?.();
    };
  }, [open, singleLane?.id]);

  const requiresTypeConfirm =
    isBatch ||
    !deleteRisk ||
    deleteForce ||
    deleteRisk.dirty ||
    deleteMode === "remote_branch" ||
    (deleteMode === "local_branch" && deleteRisk.hasUnpushedCommits);

  const confirmMatch = !requiresTypeConfirm || deleteConfirmText.trim().toLowerCase() === deletePhrase.toLowerCase();
  const showStaticBusy = laneActionBusy && !deleteProgress;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={isBatch ? `Manage ${lanes.length} Lanes` : "Manage Lane"}
      icon={GitBranch}
      widthClassName="w-[min(680px,calc(100vw-24px))]"
      busy={laneActionBusy}
    >
      {lanes.length === 0 ? (
        <div className="py-4 text-sm text-muted-fg">Select a lane first.</div>
      ) : allPrimary ? (
        <div className="py-4 text-sm text-muted-fg">Primary lane cannot be archived or deleted.</div>
      ) : (
        <div className="max-h-[65vh] space-y-3 overflow-auto" data-tour="lanes.manageDialog">
          {/* Lane info */}
          <section data-tour="lanes.manageDialog.laneInfo" className={SECTION_CLASS_NAME}>
            <span className={LABEL_CLASS_NAME}>{isBatch ? "Selected lanes" : "Lane"}</span>
            {isBatch ? (
              <div className="mt-2 max-h-[120px] space-y-1.5 overflow-auto">
                {lanes.map((lane) => (
                  <div key={lane.id} className="flex items-center gap-2 text-xs">
                    <GitBranch size={11} className="shrink-0 text-muted-fg/60" />
                    <span className="font-semibold text-fg">{lane.name}</span>
                    <span className="truncate text-muted-fg/60">{lane.branchRef}</span>
                    <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-fg">{lane.laneType}</span>
                    {lane.status.dirty && <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-400">dirty</span>}
                    {lane.laneType === "primary" && <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-400">protected</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-fg">{lanes[0].name}</span>
                  <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-fg">{lanes[0].laneType}</span>
                </div>
                <div className="mt-1.5 space-y-0.5 text-xs text-muted-fg/60">
                  <div>Branch: <span className="text-fg/80">{lanes[0].branchRef}</span></div>
                  <div className="truncate">Path: <span className="text-fg/80">{lanes[0].worktreePath}</span></div>
                </div>
              </div>
            )}
          </section>

          {/* Adopt attached — single lane only */}
          {!isBatch && isAttached && (
            <section className="rounded-xl border border-blue-400/15 bg-blue-400/[0.04] p-4 shadow-card">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-blue-300">
                    <ArrowSquareOut size={15} />
                    Move to ADE-Managed Worktree
                  </div>
                  <div className="mt-1 text-xs text-blue-300/70">
                    Move this attached worktree into <span className="font-mono text-blue-200/80">.ade/worktrees</span> for full lifecycle management.
                  </div>
                </div>
                <Button size="sm" variant="outline" data-tour="lanes.manageDialog.adopt" disabled={laneActionBusy} onClick={onAdoptAttached}>
                  Move
                </Button>
              </div>
            </section>
          )}

          {/* Appearance — single lane only */}
          {!isBatch && lanes[0] ? (
            <AppearanceSection lane={lanes[0]} allLanes={allLanes} disabled={laneActionBusy} onChanged={onAppearanceChanged} />
          ) : null}

          {/* Archive */}
          <section className={SECTION_CLASS_NAME}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <Archive size={15} className="text-accent" />
                  Archive
                </div>
                <div className="mt-1 text-xs text-muted-fg/60">
                  {isBatch
                    ? `Hide ${lanes.length} lanes from ADE without deleting worktrees or branches.`
                    : "Hide from ADE without deleting worktree or branches."}
                </div>
              </div>
              <Button size="sm" variant="outline" data-tour="lanes.manageDialog.archive" disabled={laneActionBusy} onClick={onArchive}>
                {isBatch ? `Archive ${lanes.length}` : "Archive"}
              </Button>
            </div>
          </section>

          {/* Delete */}
          <section className="rounded-xl border border-red-500/15 bg-red-500/[0.04] p-4 shadow-card">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-red-400">
              <Trash size={15} />
              {hasAttached && !isBatch ? "Detach / Delete" : "Delete"}
            </div>

            {hasAnyDirty && (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-300">
                <WarningCircle size={14} className="shrink-0" />
                {isBatch ? "Some lanes have uncommitted changes." : "This lane has uncommitted changes."}
              </div>
            )}

            {/* Delete mode selector */}
            <span className={LABEL_CLASS_NAME}>Scope</span>
            <div data-tour="lanes.manageDialog.tabs" className="mt-2 mb-3 inline-flex rounded-lg border border-white/[0.06] bg-white/[0.02] p-0.5">
              {([
                { value: "worktree" as const, label: worktreeDeleteLabel },
                { value: "local_branch" as const, label: localDeleteLabel },
                { value: "remote_branch" as const, label: remoteDeleteLabel },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={laneActionBusy}
                  onClick={() => setDeleteMode(opt.value)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    deleteMode === opt.value
                      ? "bg-red-500/15 text-red-300 shadow-sm"
                      : "text-muted-fg hover:text-fg"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Pre-flight panel — single lane only, after risk loads */}
            {singleLane && deleteRisk ? (
              <PreflightPanel
                risk={deleteRisk}
                deleteMode={deleteMode}
                remoteName={deleteRemoteName}
                lane={singleLane}
              />
            ) : null}

            {/* Remote name */}
            {deleteMode === "remote_branch" && (
              <div className="mb-3">
                <span className={LABEL_CLASS_NAME}>Remote name</span>
                <input
                  value={deleteRemoteName}
                  onChange={(event) => setDeleteRemoteName(event.target.value)}
                  disabled={laneActionBusy}
                  className={INPUT_CLASS_NAME}
                  placeholder="origin"
                />
              </div>
            )}

            {/* Force delete */}
            <label className="mb-3 flex items-center gap-2 text-xs text-muted-fg cursor-pointer select-none">
              <input type="checkbox" checked={deleteForce} onChange={(event) => setDeleteForce(event.target.checked)} disabled={laneActionBusy} className="rounded" />
              Force delete (skip safety checks)
            </label>

            {/* Confirmation — only required when risk is non-trivial */}
            {requiresTypeConfirm ? (
              <div className="mb-3">
                <span className={LABEL_CLASS_NAME}>
                  Type <span className="normal-case tracking-normal text-red-400">{deletePhrase}</span> to confirm
                </span>
                <input
                  data-tour="lanes.manageDialog.confirm"
                  value={deleteConfirmText}
                  onChange={(event) => setDeleteConfirmText(event.target.value)}
                  disabled={laneActionBusy}
                  className={`${INPUT_CLASS_NAME} ${confirmMatch ? "!border-red-500/30" : ""}`}
                />
              </div>
            ) : null}

            {/* Live progress strip — replaces the static busy indicator while delete is streaming */}
            {deleteProgress ? (
              <DeleteProgressStrip progress={deleteProgress} />
            ) : showStaticBusy && (laneActionKind === "delete" || laneActionKind === "archive" || laneActionKind == null) ? (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-muted-fg" role="status" aria-live="polite">
                <CircleNotch
                  size={14}
                  className={`shrink-0 animate-spin ${laneActionKind === "delete" ? "text-red-300" : "text-amber-300"}`}
                />
                <span>{laneActionStatus ?? "Working..."}</span>
              </div>
            ) : null}

            {/* Error */}
            {laneActionError && (laneActionKind === "delete" || laneActionKind === "archive" || laneActionKind == null) && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/15 bg-red-500/[0.06] px-3 py-2 text-xs text-red-300">
                <WarningCircle size={14} className="mt-0.5 shrink-0" />
                <span className="whitespace-pre-wrap">{laneActionError}</span>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                data-tour="lanes.manageDialog.delete"
                className="bg-red-600 hover:bg-red-500"
                disabled={laneActionBusy || !confirmMatch}
                onClick={onDelete}
              >
                {laneActionBusy && laneActionKind === "delete" ? <CircleNotch size={13} className="animate-spin" /> : <Trash size={13} />}
                {laneActionBusy && laneActionKind === "delete"
                  ? "Deleting..."
                  : isBatch
                    ? `Delete ${lanes.length} lanes`
                    : "Delete lane"}
              </Button>
            </div>
          </section>
        </div>
      )}
    </LaneDialogShell>
  );
}

function PreflightPanel({
  risk,
  deleteMode,
  remoteName,
  lane
}: {
  risk: LaneDeleteRisk;
  deleteMode: "worktree" | "local_branch" | "remote_branch";
  remoteName: string;
  lane: LaneSummary;
}) {
  const willStop: { icon: React.ReactNode; label: string }[] = [];
  if (risk.runningProcessCount > 0) {
    willStop.push({
      icon: <Cpu size={12} className="text-accent" />,
      label: `${risk.runningProcessCount} running ${risk.runningProcessCount === 1 ? "process" : "processes"}`
    });
  }
  if (risk.activePtyCount > 0) {
    willStop.push({
      icon: <Terminal size={12} className="text-accent" />,
      label: `${risk.activePtyCount} terminal ${risk.activePtyCount === 1 ? "session" : "sessions"}`
    });
  }
  if (risk.activeWatcherCount > 0) {
    willStop.push({
      icon: <Eye size={12} className="text-accent" />,
      label: `${risk.activeWatcherCount} file ${risk.activeWatcherCount === 1 ? "watcher" : "watchers"}`
    });
  }

  const willRemove: { icon: React.ReactNode; label: string }[] = [];
  if (lane.laneType === "worktree") {
    willRemove.push({
      icon: <Cube size={12} className="text-red-300/80" />,
      label: `Worktree at ${lane.worktreePath}`
    });
  }
  if (deleteMode !== "worktree" && risk.branchRef) {
    const unpushed = risk.hasUnpushedCommits ? ` (${risk.unpushedCommitCount} unpushed)` : "";
    willRemove.push({
      icon: <GitBranch size={12} className="text-red-300/80" />,
      label: `Local branch: ${risk.branchRef}${unpushed}`
    });
  }
  if (deleteMode === "remote_branch" && risk.branchRef && risk.remoteBranchExists) {
    willRemove.push({
      icon: <GitBranch size={12} className="text-red-300/80" />,
      label: `Remote branch: ${remoteName.trim() || "origin"}/${risk.branchRef}`
    });
  }

  const idle = willStop.length === 0;

  return (
    <div className="mb-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      {idle ? (
        <div className="text-[11px] text-muted-fg/70">Nothing running on this lane.</div>
      ) : (
        <>
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-fg/70">What will be stopped</div>
          <div className="mt-1.5 space-y-1">
            {willStop.map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-fg/85">
                {item.icon}
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {willRemove.length > 0 ? (
        <>
          <div className={`text-[10px] font-medium uppercase tracking-wide text-muted-fg/70 ${idle ? "" : "mt-3"}`}>What will be removed</div>
          <div className="mt-1.5 space-y-1">
            {willRemove.map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-fg/85">
                {item.icon}
                <span className="truncate">{item.label}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function DeleteProgressStrip({ progress }: { progress: LaneDeleteProgress }) {
  let tone: string;
  switch (progress.overallStatus) {
    case "completed":
      tone = "border-emerald-500/15 bg-emerald-500/[0.04]";
      break;
    case "completed_with_warnings":
      tone = "border-amber-500/15 bg-amber-500/[0.04]";
      break;
    case "failed":
      tone = "border-red-500/15 bg-red-500/[0.06]";
      break;
    case "cancelled":
      tone = "border-amber-500/15 bg-amber-500/[0.04]";
      break;
    default:
      tone = "border-white/[0.08] bg-white/[0.04]";
      break;
  }
  return (
    <div className={`mb-3 rounded-lg border px-3 py-2 ${tone}`} role="status" aria-live="polite">
      <div className="space-y-1">
        {progress.steps.map((step) => (
          <ProgressStepRow key={step.name} step={step} />
        ))}
      </div>
      {progress.overallStatus === "cancelled" ? (
        <div className="mt-2 text-[11px] text-amber-300">Delete cancelled. The lane was not removed.</div>
      ) : null}
      {progress.overallStatus === "completed" ? (
        <div className="mt-2 text-[11px] text-emerald-300">Delete completed. Refreshing lane list...</div>
      ) : null}
      {progress.overallStatus === "completed_with_warnings" ? (
        <div className="mt-2 text-[11px] text-amber-300">Lane deleted. Some branch cleanup needs attention.</div>
      ) : null}
    </div>
  );
}

function ProgressStepRow({ step }: { step: LaneDeleteStep }) {
  const label = STEP_LABELS[step.name] ?? step.name;
  let icon: React.ReactNode;
  let textTone: string;
  switch (step.status) {
    case "completed":
      icon = <CheckCircle size={12} className="text-emerald-400" weight="fill" />;
      textTone = "text-fg/85";
      break;
    case "warning":
      icon = <WarningCircle size={12} className="text-amber-400" weight="fill" />;
      textTone = "text-amber-300";
      break;
    case "failed":
      icon = <X size={12} className="text-red-400" weight="bold" />;
      textTone = "text-red-300";
      break;
    case "running":
      icon = <CircleNotch size={12} className="animate-spin text-accent" />;
      textTone = "text-fg";
      break;
    case "skipped":
      icon = <Minus size={12} className="text-muted-fg/60" />;
      textTone = "text-muted-fg/60";
      break;
    default:
      icon = <span className="inline-block h-2 w-2 rounded-full bg-muted-fg/30" />;
      textTone = "text-muted-fg/70";
      break;
  }
  const duration = step.durationMs != null ? `${(step.durationMs / 1000).toFixed(1)}s` : null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="flex h-3 w-3 items-center justify-center">{icon}</span>
      <span className={`flex-1 ${textTone}`}>{label}</span>
      {step.errorMessage ? (
        <span
          className={`max-w-[50%] truncate text-[11px] ${step.status === "warning" ? "text-amber-300/80" : "text-red-300/80"}`}
          title={step.errorMessage}
        >
          {step.errorMessage}
        </span>
      ) : null}
      {step.detail ? <span className="text-[11px] text-muted-fg/60">{step.detail}</span> : null}
      {duration ? <span className="text-[11px] text-muted-fg/50 tabular-nums">{duration}</span> : null}
    </div>
  );
}

function AppearanceSection({
  lane,
  allLanes,
  disabled,
  onChanged,
}: {
  lane: LaneSummary;
  allLanes: LaneSummary[];
  disabled: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const used = React.useMemo(() => colorsInUse(allLanes, lane.id), [allLanes, lane.id]);
  const currentName = laneColorName(lane.color);

  const apply = async (next: string | null) => {
    setError(null);
    setBusy(true);
    try {
      await window.ade.lanes.updateAppearance({ laneId: lane.id, color: next });
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set color");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={SECTION_CLASS_NAME}>
      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Palette size={15} className="text-accent" />
        Appearance
      </div>
      <div className="mt-1 mb-2 text-xs text-muted-fg/60">
        {currentName ? `Color: ${currentName}` : "Pick a color to identify this lane across the app."}
      </div>
      <LaneColorPicker
        value={lane.color}
        onChange={(next) => { void apply(next); }}
        usedColors={used}
      />
      {error ? (
        <div className="mt-2 text-xs text-red-300">{error}</div>
      ) : null}
      {busy || disabled ? (
        <div className="sr-only" role="status">Updating</div>
      ) : null}
    </section>
  );
}
