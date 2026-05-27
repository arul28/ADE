import React, { useEffect, useState } from "react";
import {
  ArrowSquareOut,
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
} from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import type {
  LaneDeleteProgress,
  LaneDeleteRisk,
  LaneDeleteStep,
  LaneDeleteStepName,
  LaneSummary
} from "../../../shared/types";
import { LaneDialogShell } from "./LaneDialogShell";
import {
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

function ManageLaneHeaderDetails({ lanes, isBatch }: { lanes: LaneSummary[]; isBatch: boolean }) {
  if (isBatch) {
    return (
      <div data-tour="lanes.manageDialog.laneInfo" className="space-y-2">
        <div className="text-xs text-muted-fg/80">{lanes.length} lanes selected</div>
        <div className="max-h-[min(28vh,160px)] space-y-1.5 overflow-y-auto pr-1">
          {lanes.map((lane) => (
            <div key={lane.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <LaneIcon size={11} className="shrink-0 text-muted-fg/60" />
              <span className="font-semibold text-fg">{lane.name}</span>
              <BranchIcon size={10} className="shrink-0 text-muted-fg/50" />
              <span className="truncate font-mono text-muted-fg/60">{lane.branchRef}</span>
              <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-fg">
                {lane.laneType}
              </span>
              {lane.status.dirty ? (
                <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-400">
                  dirty
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const lane = lanes[0];
  if (!lane) return null;

  return (
    <div data-tour="lanes.manageDialog.laneInfo" className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <LaneIcon size={14} weight="duotone" className="shrink-0 text-accent/80" />
        <span className="text-base font-semibold tracking-tight text-accent">{lane.name}</span>
        {lane.status.dirty ? (
          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-400">
            dirty
          </span>
        ) : null}
      </div>
      <dl className="mt-2.5 space-y-1.5 text-xs">
        <div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
          <dt className="text-muted-fg/60">Branch</dt>
          <dd className="min-w-0 truncate font-mono text-fg/85">{lane.branchRef}</dd>
        </div>
        <div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
          <dt className="text-muted-fg/60">Path</dt>
          <dd className="min-w-0 break-all text-fg/75">{lane.worktreePath}</dd>
        </div>
      </dl>
    </div>
  );
}

type ManageLaneTab = "appearance" | "stack" | "archive" | "delete";

type ManageLaneTabDef = {
  id: ManageLaneTab;
  label: string;
  icon: typeof Palette;
};

type ManageLaneTabTone = "delete" | "accent" | "stack" | "neutral";

const TAB_PANEL_TONE_CLASS: Record<ManageLaneTabTone, string> = {
  delete: "border-red-500/25 bg-gradient-to-br from-red-500/[0.1] via-red-950/20 to-transparent",
  accent: "border-accent/25 bg-gradient-to-br from-accent/[0.1] via-accent/[0.02] to-transparent",
  stack: "border-violet-500/25 bg-gradient-to-br from-violet-500/[0.1] via-violet-950/10 to-transparent",
  neutral: "border-white/[0.08] bg-gradient-to-br from-white/[0.06] via-white/[0.02] to-transparent",
};

function ManageLaneTabPanel({
  tone,
  children,
}: {
  tone: ManageLaneTabTone;
  children: React.ReactNode;
}) {
  const toneClass = TAB_PANEL_TONE_CLASS[tone];

  return (
    <section className={`relative overflow-hidden rounded-xl border p-4 shadow-card ${toneClass}`}>
      <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      {children}
    </section>
  );
}

function ManageLaneTabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: ManageLaneTabDef[];
  active: ManageLaneTab;
  onChange: (tab: ManageLaneTab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Manage lane actions"
      className="grid gap-1 rounded-xl border border-white/[0.08] bg-black/25 p-1"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        const Icon = tab.icon;
        const isDelete = tab.id === "delete";
        let activeStateClass: string;
        if (!isActive) {
          activeStateClass = "text-muted-fg/80 hover:bg-white/[0.04] hover:text-fg";
        } else if (isDelete) {
          activeStateClass = "bg-red-500/20 text-red-200 shadow-sm ring-1 ring-red-400/20";
        } else {
          activeStateClass = "bg-accent/20 text-accent shadow-sm ring-1 ring-accent/25";
        }
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-2 text-[11px] font-medium transition-all ${activeStateClass}`}
          >
            <Icon size={14} weight={isActive ? "fill" : "regular"} />
            <span className="truncate">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

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
  const singleLaneId = singleLane?.id ?? null;
  const singleLaneType = singleLane?.laneType ?? null;
  let worktreeDeleteLabel: string;
  let localDeleteLabel: string;
  let remoteDeleteLabel: string;
  if (isMixed) {
    worktreeDeleteLabel = "Unlink + folder";
    localDeleteLabel = "+ local branches";
    remoteDeleteLabel = "+ remote too";
  } else if (hasAttached) {
    worktreeDeleteLabel = "Unlink only";
    localDeleteLabel = "+ local branch";
    remoteDeleteLabel = "+ local & remote";
  } else {
    worktreeDeleteLabel = "Worktree only";
    localDeleteLabel = "+ local branch";
    remoteDeleteLabel = "+ remote too";
  }

  const [deleteRisk, setDeleteRisk] = useState<LaneDeleteRisk | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<LaneDeleteProgress | null>(null);
  const [activeTab, setActiveTab] = useState<ManageLaneTab>("delete");

  const tabDefs = React.useMemo((): ManageLaneTabDef[] => {
    return [
      { id: "delete" as const, label: "Delete", icon: Trash, show: true },
      { id: "appearance" as const, label: "Appearance", icon: Palette, show: !!singleLaneType },
      { id: "stack" as const, label: "Restack", icon: TreeStructure, show: !!singleLaneType && singleLaneType !== "primary" },
      { id: "archive" as const, label: "Archive", icon: Archive, show: true },
    ]
      .filter((t) => t.show)
      .map(({ show: _, ...tab }) => tab);
  }, [singleLaneType]);

  // Reset transient state when dialog closes or active lane changes.
  useEffect(() => {
    if (!open) {
      setDeleteRisk(null);
      setDeleteProgress(null);
      return;
    }
    setActiveTab(tabDefs[0]?.id ?? "archive");
  }, [open, singleLaneId, isBatch, tabDefs]);

  // Fetch pre-flight risk for the single-lane case.
  useEffect(() => {
    if (!open || !singleLaneId || singleLaneType === "primary") {
      setDeleteRisk(null);
      return;
    }
    let cancelled = false;
    void window.ade.lanes
      .getDeleteRisk({ laneId: singleLaneId })
      .then((risk) => {
        if (!cancelled) setDeleteRisk(risk);
      })
      .catch(() => {
        // best-effort — pre-flight is informational only
      });
    return () => {
      cancelled = true;
    };
  }, [open, singleLaneId, singleLaneType]);

  // Stream live delete progress for the active lane.
  useEffect(() => {
    if (!open || !singleLaneId) return;
    const unsubscribe = window.ade.lanes.onDeleteEvent((event) => {
      if (event.progress.laneId !== singleLaneId) return;
      setDeleteProgress(event.progress);
    });
    return () => {
      unsubscribe?.();
    };
  }, [open, singleLaneId]);

  const requiresTypeConfirm =
    isBatch ||
    !deleteRisk ||
    deleteForce ||
    deleteRisk.dirty ||
    deleteMode === "remote_branch" ||
    (deleteMode === "local_branch" && deleteRisk.hasUnpushedCommits);

  const confirmMatch = !requiresTypeConfirm || deleteConfirmText.trim().toLowerCase() === deletePhrase.toLowerCase();
  const showStaticBusy = laneActionBusy && !deleteProgress;

  useEffect(() => {
    if (tabDefs.some((tab) => tab.id === activeTab)) return;
    setActiveTab(tabDefs[0]?.id ?? "archive");
  }, [activeTab, tabDefs]);

  useEffect(() => {
    if (laneActionKind === "delete") setActiveTab("delete");
    if (laneActionKind === "archive") setActiveTab("archive");
  }, [laneActionKind]);

  const headerExtra =
    lanes.length > 0 && !allPrimary ? <ManageLaneHeaderDetails lanes={lanes} isBatch={isBatch} /> : undefined;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={isBatch ? `Manage ${lanes.length} Lanes` : "Manage Lane"}
      icon={LaneIcon}
      headerExtra={headerExtra}
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
          {!isBatch && isAttached ? (
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
          ) : null}

          <ManageLaneTabBar tabs={tabDefs} active={activeTab} onChange={setActiveTab} />

          {activeTab === "appearance" && singleLane ? (
            <ManageLaneTabPanel tone="accent">
              <AppearanceSection lane={singleLane} allLanes={allLanes} disabled={laneActionBusy} onChanged={onAppearanceChanged} />
            </ManageLaneTabPanel>
          ) : null}

          {activeTab === "stack" && singleLane && singleLane.laneType !== "primary" ? (
            <ManageLaneTabPanel tone="stack">
              <StackPositionSection
                lane={singleLane}
                allLanes={allLanes}
                disabled={laneActionBusy}
                onDone={onStackReorganized}
              />
            </ManageLaneTabPanel>
          ) : null}

          {activeTab === "archive" ? (
            <ManageLaneTabPanel tone="neutral">
              <div className="flex items-start gap-3">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-accent">
                  <Archive size={18} weight="duotone" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">
                    {isBatch ? `Hide ${lanes.length} lanes from ADE` : "Hide this lane from ADE"}
                  </p>
                  <p className="mt-1 text-xs text-muted-fg/70">
                    Files stay on disk until you delete them.
                  </p>
                </div>
              </div>
              <div className="mt-4">
                <Button size="sm" variant="outline" data-tour="lanes.manageDialog.archive" disabled={laneActionBusy} onClick={onArchive}>
                  {isBatch ? `Archive ${lanes.length} lanes` : "Archive lane"}
                </Button>
              </div>
            </ManageLaneTabPanel>
          ) : null}

          {activeTab === "delete" ? (
            <ManageLaneTabPanel tone="delete">
              <p className="text-xs text-red-200/70">
                Stops lane activity and removes what you pick below. Cannot be undone.
              </p>

              {hasAnyDirty ? (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-200">
                  <WarningCircle size={14} className="shrink-0" weight="fill" />
                  {isBatch ? "Uncommitted changes on some lanes." : "Uncommitted changes on this lane."}
                </div>
              ) : null}

              <div data-tour="lanes.manageDialog.tabs" className="mt-4 grid gap-2 sm:grid-cols-3">
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
                    className={`rounded-lg border px-3 py-2.5 text-left text-xs font-medium transition-all ${
                      deleteMode === opt.value
                        ? "border-red-400/35 bg-red-500/15 text-red-100 shadow-sm ring-1 ring-red-400/20"
                        : "border-white/[0.08] bg-black/20 text-muted-fg hover:border-white/[0.14] hover:text-fg"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {singleLane ? (
                <PreflightPanel
                  risk={deleteRisk}
                  deleteMode={deleteMode}
                  remoteName={deleteRemoteName}
                  lane={singleLane}
                />
              ) : null}

              {deleteMode === "remote_branch" ? (
                <div className="mt-3">
                  <span className={LABEL_CLASS_NAME}>Remote</span>
                  <input
                    value={deleteRemoteName}
                    onChange={(event) => setDeleteRemoteName(event.target.value)}
                    disabled={laneActionBusy}
                    className={INPUT_CLASS_NAME}
                    placeholder="origin"
                  />
                </div>
              ) : null}

              <label className="mt-3 flex items-center gap-2 text-xs text-muted-fg/80 cursor-pointer select-none">
                <input type="checkbox" checked={deleteForce} onChange={(event) => setDeleteForce(event.target.checked)} disabled={laneActionBusy} className="rounded accent-red-400" />
                Force delete
              </label>

              {requiresTypeConfirm ? (
                <div className="mt-3">
                  <span className={LABEL_CLASS_NAME}>
                    Confirm <span className="normal-case tracking-normal text-red-300">{deletePhrase}</span>
                  </span>
                  <input
                    data-tour="lanes.manageDialog.confirm"
                    value={deleteConfirmText}
                    onChange={(event) => setDeleteConfirmText(event.target.value)}
                    disabled={laneActionBusy}
                    className={`${INPUT_CLASS_NAME} ${confirmMatch ? "!border-red-500/30" : ""}`}
                    placeholder={deletePhrase}
                  />
                </div>
              ) : null}

              {deleteProgress ? (
                <DeleteProgressStrip progress={deleteProgress} />
              ) : showStaticBusy && (laneActionKind === "delete" || laneActionKind === "archive" || laneActionKind == null) ? (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-white/[0.08] bg-black/25 px-3 py-2 text-xs text-muted-fg" role="status" aria-live="polite">
                  <CircleNotch
                    size={14}
                    className={`shrink-0 animate-spin ${laneActionKind === "delete" ? "text-red-300" : "text-amber-300"}`}
                  />
                  <span>{laneActionStatus ?? "Working..."}</span>
                </div>
              ) : null}

              {laneActionError && (laneActionKind === "delete" || laneActionKind === "archive" || laneActionKind == null) ? (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.08] px-3 py-2 text-xs text-red-200">
                  <WarningCircle size={14} className="mt-0.5 shrink-0" weight="fill" />
                  <span className="whitespace-pre-wrap">{laneActionError}</span>
                </div>
              ) : null}

              <div className="mt-4 flex items-center gap-2">
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
            </ManageLaneTabPanel>
          ) : null}
        </div>
      )}
    </LaneDialogShell>
  );
}

function formatBranchLabel(ref: string): string {
  return ref.trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

function buildDeleteRemovalPreview(
  deleteMode: "worktree" | "local_branch" | "remote_branch",
  lane: LaneSummary,
  risk: LaneDeleteRisk | null,
  remoteName: string,
): { icon: React.ReactNode; label: string; hint?: string }[] {
  const items: { icon: React.ReactNode; label: string; hint?: string }[] = [];
  const branchRef = risk?.branchRef ?? lane.branchRef ?? null;
  const branchLabel = branchRef ? formatBranchLabel(branchRef) : null;

  if (lane.laneType === "attached") {
    if (deleteMode === "worktree") {
      items.push({
        icon: <ArrowSquareOut size={12} className="text-red-300/80" />,
        label: "Unlink from ADE (keep branch)",
      });
    }
  } else if (lane.worktreePath) {
    items.push({
      icon: <Cube size={12} className="text-red-300/80" />,
      label: lane.worktreePath,
    });
  }

  if ((deleteMode === "local_branch" || deleteMode === "remote_branch") && branchLabel) {
    const unpushed =
      risk?.hasUnpushedCommits && risk.unpushedCommitCount > 0
        ? ` · ${risk.unpushedCommitCount} unpushed`
        : "";
    items.push({
      icon: <BranchIcon size={12} className="text-red-300/80" />,
      label: `Local branch · ${branchLabel}${unpushed}`,
    });
  }

  if (deleteMode === "remote_branch" && branchLabel) {
    const remote = remoteName.trim() || "origin";
    items.push({
      icon: <BranchIcon size={12} className="text-red-300/80" />,
      label: `Remote · ${remote}/${branchLabel}`,
      hint: risk && !risk.remoteBranchExists ? "Not on remote yet" : undefined,
    });
  }

  return items;
}

function PreflightPanel({
  risk,
  deleteMode,
  remoteName,
  lane
}: {
  risk: LaneDeleteRisk | null;
  deleteMode: "worktree" | "local_branch" | "remote_branch";
  remoteName: string;
  lane: LaneSummary;
}) {
  const willStop: { icon: React.ReactNode; label: string }[] = [];
  if (risk && risk.runningProcessCount > 0) {
    willStop.push({
      icon: <Cpu size={12} className="text-accent" />,
      label: `${risk.runningProcessCount} running ${risk.runningProcessCount === 1 ? "process" : "processes"}`
    });
  }
  if (risk && risk.activePtyCount > 0) {
    willStop.push({
      icon: <Terminal size={12} className="text-accent" />,
      label: `${risk.activePtyCount} terminal ${risk.activePtyCount === 1 ? "session" : "sessions"}`
    });
  }
  if (risk && risk.activeWatcherCount > 0) {
    willStop.push({
      icon: <Eye size={12} className="text-accent" />,
      label: `${risk.activeWatcherCount} file ${risk.activeWatcherCount === 1 ? "watcher" : "watchers"}`
    });
  }

  const willRemove = buildDeleteRemovalPreview(deleteMode, lane, risk, remoteName);

  return (
    <div className="mt-3 rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2.5">
      {willStop.length > 0 ? (
        <ul className="space-y-1.5">
          {willStop.map((item, i) => (
            <li key={`stop-${i}`} className="flex items-center gap-2 text-xs text-fg/80">
              {item.icon}
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[11px] text-muted-fg/65">Nothing running on this lane.</div>
      )}
      {willRemove.length > 0 ? (
        <>
          <div className={`text-[10px] uppercase tracking-wide text-muted-fg/50 ${willStop.length > 0 ? "mt-2.5" : ""} mb-1.5`}>
            Will remove
          </div>
          <ul className="space-y-1.5">
            {willRemove.map((item, i) => (
              <li key={`remove-${i}`} className="flex items-start gap-2 text-xs text-red-200/85">
                {item.icon}
                <span className="min-w-0 break-all">
                  {item.label}
                  {item.hint ? <span className="text-muted-fg/60"> ({item.hint})</span> : null}
                </span>
              </li>
            ))}
          </ul>
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
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-fg/70">Lane color in tabs and stack. No git changes.</p>
        {currentName ? (
          <span className="shrink-0 rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
            {currentName}
          </span>
        ) : null}
      </div>
      <div className="mt-3">
        <LaneColorPicker
          value={lane.color}
          onChange={(next) => { void apply(next); }}
          usedColors={used}
          usedColorOwners={usedOwners}
        />
      </div>
      {error ? (
        <div className="mt-2 text-xs text-red-300">{error}</div>
      ) : null}
      {busy || disabled ? (
        <div className="sr-only" role="status">Updating</div>
      ) : null}
    </>
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
  const normalizedDefaultBase = normalizeBranchRefForCompare(defaultBaseBranch);
  const parentChanged = stackParentId !== effectiveCurrentParentId;
  // baseChanged covers two cases:
  //   1. User typed a non-empty override that resolves to a different effective
  //      branch than what is currently stored (after normalizing refs/heads/
  //      and origin/ prefixes consistent with the backend).
  //   2. User cleared the field while the lane's stored base actually diverges
  //      from the selected parent's current branch — clearing then removes the
  //      override and the backend will rebase onto the parent's branch.
  //      `lane.baseRef` is a non-nullable string so we can't gate on its mere
  //      presence; we must compare it against the effective default to avoid
  //      enabling Apply on initial open when nothing has actually changed.
  const baseChanged = normalizedOverride.length > 0
    ? normalizedOverride !== normalizedExistingBase
    : normalizedExistingBase.length > 0 &&
      normalizedExistingBase !== normalizedDefaultBase;
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
    <div data-tour="lanes.manageDialog.stack">
      <p className="text-xs text-muted-fg/70">
        Change parent lane and optional base branch. Runs <span className="font-mono text-fg/75">git rebase</span> on apply.
      </p>

      <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-amber-500/10 px-2.5 py-1 text-[10px] font-medium text-amber-200">
        <WarningCircle size={12} weight="fill" />
        Rebase on apply
      </div>

      {!primaryLane ? (
        <div className="mt-3 text-xs text-amber-300/90">No primary lane found.</div>
      ) : null}

      {lane.status.dirty ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-200">
          <WarningCircle size={14} className="shrink-0" weight="fill" />
          Commit or stash first.
        </div>
      ) : null}

      {lane.status.rebaseInProgress ? (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-200">
          <WarningCircle size={14} className="shrink-0" weight="fill" />
          Finish or abort the current rebase first.
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
        placeholder={defaultBaseBranch ? defaultBaseBranch.replace(/^refs\/heads\//, "") : "branch-name"}
      />

      {error ? <div className="mt-2 text-xs text-red-300">{error}</div> : null}
      {success ? <div className="mt-2 text-xs text-emerald-300">{success}</div> : null}

      <div className="mt-4">
        <Button size="sm" variant="outline" disabled={!canApply} onClick={() => { void apply(); }}>
          {busy ? <CircleNotch size={13} className="animate-spin" /> : null}
          {busy ? "Applying…" : "Apply restack"}
        </Button>
      </div>
    </div>
  );
}
