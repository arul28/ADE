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
  Minus,
  TreeStructure,
  Info
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
import {
  SECTION_CLASS_NAME,
  SECTION_ACCENT_CLASS_NAME,
  SECTION_HERO_CLASS_NAME,
  LABEL_CLASS_NAME,
  INPUT_CLASS_NAME,
  SELECT_CLASS_NAME
} from "./laneDialogTokens";
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

const SHELL_DESCRIPTION_BATCH =
  "Archive or delete the selected lanes. Stack position, color, and adopt are only available when you manage one lane at a time.";

const SHELL_DESCRIPTION_SINGLE =
  "Review lane details, then use the sections below. Stack and appearance only change this lane; archive and delete are separate flows with their own confirmations.";

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
  onAppearanceChanged,
  onStackReorganized
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
  onStackReorganized?: () => void | Promise<void>;
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

  let shellDescription: string | undefined;
  if (lanes.length > 0 && !allPrimary) {
    shellDescription = isBatch ? SHELL_DESCRIPTION_BATCH : SHELL_DESCRIPTION_SINGLE;
  }

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={isBatch ? `Manage ${lanes.length} Lanes` : "Manage Lane"}
      icon={GitBranch}
      description={shellDescription}
      widthClassName="w-[calc(100vw-1rem)] max-w-[720px] sm:max-w-[min(720px,calc(100vw-2rem))]"
      busy={laneActionBusy}
    >
      {lanes.length === 0 ? (
        <div className="py-4 text-sm text-muted-fg">Select a lane first.</div>
      ) : allPrimary ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-3 text-sm text-muted-fg">
          Primary lane cannot be archived or deleted. Close this dialog or pick another lane.
        </div>
      ) : (
        <div className="space-y-4" data-tour="lanes.manageDialog">
          {!isBatch ? (
            <section
              className={`${SECTION_ACCENT_CLASS_NAME} border-violet-500/15 bg-gradient-to-br from-violet-500/[0.08] via-accent/[0.04] to-transparent`}
              aria-label="What you can do in this dialog"
            >
              <div className="flex items-start gap-2.5">
                <Info size={16} className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0">
                  <div className={LABEL_CLASS_NAME}>What each section does</div>
                  <ul className="mt-2 list-none space-y-2 text-xs leading-snug text-muted-fg/90">
                    <li>
                      <span className="font-semibold text-fg/90">Stack position</span>
                      {" — "}
                      Change which lane is above you in the stack and optionally which branch name to stack onto. Applying updates ADE and runs{" "}
                      <span className="font-mono text-fg/75">git rebase</span> in this worktree (blocked while dirty or mid-rebase).
                    </li>
                    <li>
                      <span className="font-semibold text-fg/90">Appearance</span>
                      {" — "}
                      Lane color for tabs and lists only; does not change branches or git state.
                    </li>
                    <li>
                      <span className="font-semibold text-fg/90">Archive</span>
                      {" — "}
                      Hides the lane from ADE; worktree and branches stay on disk until you delete them elsewhere.
                    </li>
                    <li>
                      <span className="font-semibold text-fg/90">Delete</span>
                      {" — "}
                      Destructive: remove worktree folder and optionally local and/or remote branches, with typed confirmation when risk is high.
                    </li>
                  </ul>
                </div>
              </div>
            </section>
          ) : (
            <section className={SECTION_CLASS_NAME}>
              <div className={LABEL_CLASS_NAME}>Batch mode</div>
              <p className="mt-2 text-xs leading-relaxed text-muted-fg/85">
                You are managing {lanes.length} lanes together. Only <strong className="text-fg/90">archive</strong> and{" "}
                <strong className="text-fg/90">delete</strong> apply to the whole selection. Open Manage Lane on one lane for stack position, color, or adopt.
              </p>
            </section>
          )}

          {/* Lane info */}
          <section
            data-tour="lanes.manageDialog.laneInfo"
            className={isBatch ? SECTION_CLASS_NAME : SECTION_HERO_CLASS_NAME}
          >
            <span className={LABEL_CLASS_NAME}>{isBatch ? "Selected lanes" : "Lane"}</span>
            {isBatch ? (
              <div className="mt-2 max-h-[min(28vh,200px)] space-y-1.5 overflow-y-auto pr-1">
                {lanes.map((lane) => (
                  <div key={lane.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
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
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-fg">{lanes[0].name}</span>
                  <span className="rounded-md border border-white/[0.06] bg-white/[0.05] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-fg">
                    {lanes[0].laneType}
                  </span>
                </div>
                <div className="mt-2 space-y-1 text-xs text-muted-fg/70">
                  <div>
                    Branch: <span className="font-mono text-fg/85">{lanes[0].branchRef}</span>
                  </div>
                  <div className="break-all">
                    Path: <span className="text-fg/80">{lanes[0].worktreePath}</span>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Adopt attached — single lane only */}
          {!isBatch && isAttached && (
            <section className="rounded-xl border border-sky-400/20 bg-gradient-to-br from-sky-500/[0.1] via-sky-500/[0.03] to-white/[0.02] p-4 shadow-card">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-sky-200">
                    <ArrowSquareOut size={15} className="shrink-0" />
                    Move to ADE-managed worktree
                  </div>
                  <div className="mt-1.5 text-xs leading-relaxed text-sky-100/75">
                    Copies registration into <span className="font-mono text-sky-100/90">.ade/worktrees</span> so ADE can manage lifecycle
                    (open, env, delete) the same way as other lanes. Does not rewrite git history.
                  </div>
                </div>
                <Button size="sm" variant="outline" className="shrink-0 border-sky-400/25 text-sky-100" data-tour="lanes.manageDialog.adopt" disabled={laneActionBusy} onClick={onAdoptAttached}>
                  Move
                </Button>
              </div>
            </section>
          )}

          {/* Appearance — single lane only */}
          {singleLane ? (
            <AppearanceSection lane={singleLane} allLanes={allLanes} disabled={laneActionBusy} onChanged={onAppearanceChanged} />
          ) : null}

          {singleLane && singleLane.laneType !== "primary" ? (
            <StackPositionSection
              lane={singleLane}
              allLanes={allLanes}
              disabled={laneActionBusy}
              onDone={onStackReorganized}
            />
          ) : null}

          {/* Archive */}
          <section className={SECTION_CLASS_NAME}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <Archive size={15} className="shrink-0 text-accent" />
                  Archive
                </div>
                <div className="mt-1.5 text-xs leading-relaxed text-muted-fg/75">
                  {isBatch
                    ? `Hides all ${lanes.length} lanes from ADE. Worktrees and branches stay on disk until you delete them with the section below or outside ADE.`
                    : "Hides this lane from ADE lists and the stack view. Worktrees and branches stay on disk until you delete them here or outside ADE."}
                </div>
              </div>
              <Button size="sm" variant="outline" className="shrink-0" data-tour="lanes.manageDialog.archive" disabled={laneActionBusy} onClick={onArchive}>
                {isBatch ? `Archive ${lanes.length}` : "Archive"}
              </Button>
            </div>
          </section>

          {/* Delete */}
          <section className="rounded-xl border border-red-500/20 bg-gradient-to-br from-red-500/[0.07] to-white/[0.02] p-4 shadow-card">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-300">
              <Trash size={15} className="shrink-0" />
              {hasAttached && !isBatch ? "Detach / delete" : "Delete"}
            </div>
            <p className="mb-3 text-xs leading-relaxed text-red-100/50">
              ADE stops processes, terminals, and watchers on this lane, then removes the worktree folder and optionally deletes branches locally and/or on the remote you name. This cannot be undone from ADE.
            </p>

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
  const usedOwners = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const candidate of allLanes) {
      if (candidate.archivedAt || candidate.id === lane.id || !candidate.color) continue;
      map.set(candidate.color.toLowerCase(), candidate.name);
    }
    return map;
  }, [allLanes, lane.id]);
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
      <div className="mt-1.5 text-xs leading-relaxed text-muted-fg/70">
        Pick a color for this lane in tabs, the stack strip, and headers. This is visual only and does not rename branches or run git.
      </div>
      <div className="mt-2 mb-2 text-xs text-muted-fg/55">
        {currentName ? `Current: ${currentName}` : "No color set yet."}
      </div>
      <LaneColorPicker
        value={lane.color}
        onChange={(next) => { void apply(next); }}
        usedColors={used}
        usedColorOwners={usedOwners}
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

// Mirror the backend's normalization (apps/desktop/src/main/services/shared/utils.ts
// `normalizeBranchName`) so the frontend `baseChanged` check matches what the
// IPC handler will actually compare against. Without this, typing
// `refs/heads/main` or `origin/main` when the stored ref is already `main` would
// flip `baseChanged` to true but the backend would no-op the rebase.
function normalizeBranchRefForCompare(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "");
}

function collectDescendantLaneIds(rootId: string, all: LaneSummary[]): Set<string> {
  const childrenByParent = new Map<string, LaneSummary[]>();
  for (const row of all) {
    if (!row.parentLaneId) continue;
    const list = childrenByParent.get(row.parentLaneId) ?? [];
    list.push(row);
    childrenByParent.set(row.parentLaneId, list);
  }
  const out = new Set<string>();
  const stack = [...(childrenByParent.get(rootId) ?? [])];
  while (stack.length) {
    const row = stack.pop()!;
    if (out.has(row.id)) continue;
    out.add(row.id);
    const kids = childrenByParent.get(row.id);
    if (kids) stack.push(...kids);
  }
  return out;
}

function StackPositionSection({
  lane,
  allLanes,
  disabled,
  onDone,
}: {
  lane: LaneSummary;
  allLanes: LaneSummary[];
  disabled: boolean;
  onDone?: () => void | Promise<void>;
}) {
  const primaryLane = React.useMemo(
    () => allLanes.find((l) => l.laneType === "primary" && !l.archivedAt) ?? null,
    [allLanes],
  );

  const effectiveCurrentParentId = lane.parentLaneId ?? primaryLane?.id ?? "";

  const candidates = React.useMemo(() => {
    const descendants = collectDescendantLaneIds(lane.id, allLanes);
    const list = allLanes.filter(
      (l) => !l.archivedAt && l.id !== lane.id && !descendants.has(l.id),
    );
    list.sort((a, b) => {
      const ap = a.laneType === "primary" ? 0 : 1;
      const bp = b.laneType === "primary" ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [allLanes, lane.id]);

  const [stackParentId, setStackParentId] = React.useState(effectiveCurrentParentId);
  const [baseBranchInput, setBaseBranchInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  React.useEffect(() => {
    setStackParentId(effectiveCurrentParentId);
    setBaseBranchInput("");
    setError(null);
    setSuccess(null);
  }, [lane.id, lane.parentLaneId, lane.baseRef, effectiveCurrentParentId]);

  const defaultBaseBranch = candidates.find((c) => c.id === stackParentId)?.branchRef ?? "";

  const baseOverrideTrim = baseBranchInput.trim();
  const normalizedOverride = normalizeBranchRefForCompare(baseOverrideTrim);
  const normalizedExistingBase = normalizeBranchRefForCompare(lane.baseRef ?? "");
  const parentChanged = stackParentId !== effectiveCurrentParentId;
  // baseChanged covers two cases:
  //   1. User typed a non-empty override that resolves to a different effective
  //      branch than what is currently stored (after normalizing refs/heads/
  //      and origin/ prefixes consistent with the backend).
  //   2. User cleared the field while a stored base override still exists —
  //      clearing should remove the override.
  const baseChanged = normalizedOverride.length > 0
    ? normalizedOverride !== normalizedExistingBase
    : normalizedExistingBase.length > 0;
  const canApply =
    !lane.status.dirty &&
    !lane.status.rebaseInProgress &&
    !busy &&
    !disabled &&
    Boolean(stackParentId) &&
    (parentChanged || baseChanged);

  const apply = async () => {
    if (!canApply || !stackParentId) return;
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      await window.ade.lanes.reparent({
        laneId: lane.id,
        newParentLaneId: stackParentId,
        stackBaseBranchRef: baseOverrideTrim || null,
      });
      setSuccess("Stack position updated.");
      await onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update stack position.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={SECTION_ACCENT_CLASS_NAME} data-tour="lanes.manageDialog.stack">
      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
        <TreeStructure size={15} className="text-accent" />
        Stack position
      </div>
      <div className="mt-1.5 text-xs leading-relaxed text-muted-fg/75">
        Parent lane is where this lane sits in the stack (primary is the root). Base branch is the ref ADE uses for ahead/behind. Leave it blank to use the parent lane's current branch.
      </div>

      <div className="mt-3 rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2.5 text-xs leading-relaxed text-muted-fg/85">
        <span className="font-semibold text-amber-200/95">Runs git rebase.</span> When you apply, ADE updates stack metadata then runs{" "}
        <span className="font-mono text-fg/80">git rebase</span> in this lane's worktree onto the resolved base commit. If rebase fails, ADE aborts the rebase and restores the previous parent and base branch; the error appears below.
      </div>

      {!primaryLane ? (
        <div className="mt-3 text-xs text-amber-300/90">No primary lane found; stack changes may be limited.</div>
      ) : null}

      {lane.status.dirty ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-300">
          <WarningCircle size={14} className="shrink-0" />
          Commit or stash changes before changing stack position.
        </div>
      ) : null}

      {lane.status.rebaseInProgress ? (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-300">
          <WarningCircle size={14} className="shrink-0" />
          Finish or abort the in-progress rebase before changing stack position.
        </div>
      ) : null}

      <span className={`${LABEL_CLASS_NAME} mt-4 block`}>Parent lane</span>
      <select
        className={SELECT_CLASS_NAME}
        value={stackParentId}
        disabled={busy || disabled || candidates.length === 0}
        onChange={(e) => {
          setStackParentId(e.target.value);
          setBaseBranchInput("");
          setSuccess(null);
        }}
      >
        {candidates.length === 0 ? (
          <option value="">No valid parent</option>
        ) : (
          candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.laneType === "primary" ? `${c.name} (primary)` : `${c.name} · ${c.branchRef}`}
            </option>
          ))
        )}
      </select>

      <span className={`${LABEL_CLASS_NAME} mt-3 block`}>Base branch (optional)</span>
      <input
        className={`${INPUT_CLASS_NAME} mt-1.5`}
        value={baseBranchInput}
        disabled={busy || disabled}
        onChange={(e) => {
          setBaseBranchInput(e.target.value);
          setSuccess(null);
        }}
        placeholder={defaultBaseBranch ? `Default: ${defaultBaseBranch}` : "branch-name"}
      />
      {defaultBaseBranch ? (
        <div className="mt-1 text-[11px] text-muted-fg/55">
          Selected parent is on <span className="font-mono text-fg/70">{defaultBaseBranch}</span> right now; that is used when the field above is empty.
        </div>
      ) : null}

      {error ? <div className="mt-2 text-xs text-red-300">{error}</div> : null}
      {success ? <div className="mt-2 text-xs text-emerald-300">{success}</div> : null}

      <div className="mt-3">
        <Button size="sm" variant="outline" disabled={!canApply} onClick={() => { void apply(); }}>
          {busy ? <CircleNotch size={13} className="animate-spin" /> : null}
          {busy ? "Applying…" : "Apply stack change"}
        </Button>
      </div>
    </section>
  );
}
