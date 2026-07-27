import React, { useEffect, useState } from "react";
import {
  ArrowSquareOut,
  WarningCircle,
  Archive,
  Trash,
  CircleNotch,
  Palette,
  Terminal,
  ChatCircle,
  Cpu,
  Eye,
  Cube,
  CheckCircle,
  Check,
  Cloud,
  X,
  Minus,
  TreeStructure,
  PencilSimple,
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

/** Independent delete targets shown as a checklist. */
export type LaneDeleteSelection = {
  worktree: boolean;
  localBranch: boolean;
  remoteBranch: boolean;
};

export const EMPTY_LANE_DELETE_SELECTION: LaneDeleteSelection = {
  worktree: false,
  localBranch: false,
  remoteBranch: false,
};

function laneDeleteSelectionHasAny(selection: LaneDeleteSelection): boolean {
  return selection.worktree || selection.localBranch || selection.remoteBranch;
}
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
  stop_chats: "Closing chat sessions",
  stop_ptys: "Closing terminal sessions",
  stop_watchers: "Stopping file watchers",
  cleanup_env: "Cleaning environment",
  git_worktree_remove: "Removing worktree",
  git_branch_delete: "Deleting local branch",
  git_remote_branch_delete: "Deleting remote branch",
  pack_dir_remove: "Cleaning pack folder",
  database_cleanup: "Updating database"
};

function ManageLaneRenameControls({
  lane,
  allLanes,
  onRenamed,
}: {
  lane: LaneSummary;
  allLanes: LaneSummary[];
  onRenamed?: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(lane.name);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraftName(lane.name);
      setRenameError(null);
    }
  }, [editing, lane.name]);

  const trimmedDraft = draftName.trim();
  const unchanged = trimmedDraft === lane.name.trim();
  const duplicateLane = allLanes.find(
    (candidate) => candidate.id !== lane.id
      && candidate.archivedAt == null
      && candidate.name.trim().toLowerCase() === trimmedDraft.toLowerCase(),
  );
  const canSave = Boolean(trimmedDraft) && !unchanged && !duplicateLane && !renameBusy;
  const canRename = lane.laneType !== "primary";

  const cancelEdit = () => {
    setEditing(false);
    setDraftName(lane.name);
    setRenameError(null);
  };

  const saveRename = async () => {
    if (!canSave) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      await window.ade.lanes.rename({ laneId: lane.id, name: trimmedDraft });
      setEditing(false);
      await onRenamed?.();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "Failed to rename lane");
    } finally {
      setRenameBusy(false);
    }
  };

  if (!canRename) {
    return (
      <span className="text-base font-semibold tracking-tight text-accent">{lane.name}</span>
    );
  }

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-base font-semibold tracking-tight text-accent">{lane.name}</span>
        <button
          type="button"
          aria-label="Rename lane"
          title="Rename lane"
          data-tour="lanes.manageDialog.rename"
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted-fg/70 transition hover:bg-white/[0.06] hover:text-fg"
          onClick={() => setEditing(true)}
        >
          <PencilSimple size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          type="text"
          value={draftName}
          autoFocus
          aria-label="Lane name"
          className={`${INPUT_CLASS_NAME} min-w-[12rem] flex-1 text-sm`}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveRename();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            onClick={() => { void saveRename(); }}
          >
            {renameBusy ? <CircleNotch size={14} className="animate-spin" /> : "Save"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={renameBusy}
            onClick={cancelEdit}
          >
            Cancel
          </Button>
        </div>
      </div>
      {duplicateLane ? (
        <div className="text-xs text-red-300">A lane named &quot;{duplicateLane.name}&quot; already exists.</div>
      ) : null}
      {renameError ? (
        <div className="text-xs text-red-300">{renameError}</div>
      ) : null}
    </div>
  );
}

function ManageLaneHeaderDetails({
  lanes,
  isBatch,
  allLanes,
  onRenamed,
}: {
  lanes: LaneSummary[];
  isBatch: boolean;
  allLanes: LaneSummary[];
  onRenamed?: () => void | Promise<void>;
}) {
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
        <ManageLaneRenameControls lane={lane} allLanes={allLanes} onRenamed={onRenamed} />
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
  deleteSelection,
  setDeleteSelection,
  deleteForce,
  setDeleteForce,
  chatSessionCount,
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
  deleteSelection: LaneDeleteSelection;
  setDeleteSelection: (v: LaneDeleteSelection) => void;
  deleteForce: boolean;
  setDeleteForce: (v: boolean) => void;
  chatSessionCount?: number;
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
  const singleLaneId = singleLane?.id ?? null;
  const singleLaneType = singleLane?.laneType ?? null;
  const worktreeRowTitle = hasAttached ? "Unlink from ADE" : "Worktree";
  const worktreeRowHint = hasAttached
    ? "Stops ADE managing this lane. Keeps the folder + branch."
    : "Removes the working folder and ADE registration.";

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
  // Manage Lane always opens on Delete — it's the first tab and the action
  // users reach for most. Other tabs (appearance, restack, archive) are opt-in.
  const defaultTab = React.useMemo((): ManageLaneTab => {
    return tabDefs.some((tab) => tab.id === "delete") ? "delete" : tabDefs[0]?.id ?? "archive";
  }, [tabDefs]);

  // Reset transient state when dialog closes or active lane changes.
  useEffect(() => {
    if (!open) {
      setDeleteRisk(null);
      setDeleteProgress(null);
      return;
    }
    setActiveTab(defaultTab);
  }, [open, singleLaneId, isBatch, defaultTab]);

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

  const hasDeleteSelection = laneDeleteSelectionHasAny(deleteSelection);
  const showStaticBusy = laneActionBusy && !deleteProgress;

  // Local/remote branch deletion can't happen while the worktree still has the
  // branch checked out, and any delete here tears the worktree down regardless —
  // so picking a branch implies the worktree, and clearing the worktree clears
  // the branches. This keeps the checklist in a state git can actually execute.
  const toggleDeleteTarget = (key: keyof LaneDeleteSelection, next: boolean) => {
    if (key === "worktree") {
      setDeleteSelection(
        next
          ? { ...deleteSelection, worktree: true }
          : EMPTY_LANE_DELETE_SELECTION,
      );
      return;
    }
    setDeleteSelection({
      ...deleteSelection,
      [key]: next,
      worktree: next ? true : deleteSelection.worktree,
    });
  };

  const allTargetsSelected =
    deleteSelection.worktree && deleteSelection.localBranch && deleteSelection.remoteBranch;
  const toggleSelectAll = () => {
    setDeleteSelection(
      allTargetsSelected
        ? EMPTY_LANE_DELETE_SELECTION
        : { worktree: true, localBranch: true, remoteBranch: true },
    );
  };

  useEffect(() => {
    if (tabDefs.some((tab) => tab.id === activeTab)) return;
    setActiveTab(defaultTab);
  }, [activeTab, defaultTab, tabDefs]);

  useEffect(() => {
    if (laneActionKind === "delete") setActiveTab("delete");
    if (laneActionKind === "archive") setActiveTab("archive");
  }, [laneActionKind]);

  const headerExtra =
    lanes.length > 0 && !allPrimary
      ? <ManageLaneHeaderDetails lanes={lanes} isBatch={isBatch} allLanes={allLanes} onRenamed={onAppearanceChanged} />
      : undefined;

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

              <DeleteTargetChecklist
                selection={deleteSelection}
                allSelected={allTargetsSelected}
                disabled={laneActionBusy}
                onToggle={toggleDeleteTarget}
                onToggleAll={toggleSelectAll}
                worktreeTitle={worktreeRowTitle}
                worktreeHint={worktreeRowHint}
                risk={deleteRisk}
                lane={singleLane}
              />

              {singleLane ? (
                <PreflightPanel
                  risk={deleteRisk}
                  selection={deleteSelection}
                  lane={singleLane}
                  chatSessionCount={chatSessionCount}
                />
              ) : null}

              <label className="mt-3 flex items-center gap-2 text-xs text-muted-fg/80 cursor-pointer select-none">
                <input type="checkbox" checked={deleteForce} onChange={(event) => setDeleteForce(event.target.checked)} disabled={laneActionBusy} className="rounded accent-red-400" />
                Force delete
              </label>

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
                  disabled={laneActionBusy || !hasDeleteSelection}
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

function DeleteCheckbox({ checked, indeterminate = false }: { checked: boolean; indeterminate?: boolean }) {
  const active = checked || indeterminate;
  return (
    <span
      aria-hidden
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        active ? "border-red-400/70 bg-red-500/80 text-white" : "border-white/25 bg-white/[0.04]"
      }`}
    >
      {checked ? <Check size={12} weight="bold" /> : indeterminate ? <Minus size={12} weight="bold" /> : null}
    </span>
  );
}

function DeleteTargetChecklist({
  selection,
  allSelected,
  disabled,
  onToggle,
  onToggleAll,
  worktreeTitle,
  worktreeHint,
  risk,
  lane,
}: {
  selection: LaneDeleteSelection;
  allSelected: boolean;
  disabled: boolean;
  onToggle: (key: keyof LaneDeleteSelection, next: boolean) => void;
  onToggleAll: () => void;
  worktreeTitle: string;
  worktreeHint: string;
  risk: LaneDeleteRisk | null;
  lane: LaneSummary | null;
}) {
  const branchRef = risk?.branchRef ?? lane?.branchRef ?? null;
  const branchLabel = branchRef ? formatBranchLabel(branchRef) : null;
  const someSelected = selection.worktree || selection.localBranch || selection.remoteBranch;

  const rows: { key: keyof LaneDeleteSelection; icon: React.ReactNode; title: string; hint: string; mono?: boolean }[] = [
    {
      key: "worktree",
      icon: <Cube size={15} weight="duotone" />,
      title: worktreeTitle,
      hint: worktreeHint,
    },
    {
      key: "localBranch",
      icon: <BranchIcon size={14} />,
      title: "Local branch",
      hint: branchLabel ?? "Delete the git branch on this machine",
      mono: Boolean(branchLabel),
    },
    {
      key: "remoteBranch",
      icon: <Cloud size={15} weight="duotone" />,
      title: "Remote branch",
      hint: branchLabel ? `origin · ${branchLabel}` : "Delete the branch on the remote",
      mono: Boolean(branchLabel),
    },
  ];

  return (
    <div
      data-tour="lanes.manageDialog.tabs"
      className="mt-4 overflow-hidden rounded-xl border border-white/[0.08] bg-black/25"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onToggleAll}
        aria-pressed={allSelected}
        className="flex w-full items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <DeleteCheckbox checked={allSelected} indeterminate={someSelected && !allSelected} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-fg">Select everything</div>
          <div className="text-[11px] text-muted-fg/60">Worktree, local &amp; remote branch</div>
        </div>
        {allSelected ? (
          <span className="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-medium text-red-200">All</span>
        ) : null}
      </button>

      <div className="divide-y divide-white/[0.04]">
        {rows.map((row) => {
          const checked = selection[row.key];
          return (
            <button
              key={row.key}
              type="button"
              role="checkbox"
              aria-checked={checked}
              disabled={disabled}
              onClick={() => onToggle(row.key, !checked)}
              className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                checked ? "bg-red-500/[0.08]" : "hover:bg-white/[0.03]"
              }`}
            >
              <DeleteCheckbox checked={checked} />
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
                  checked
                    ? "border-red-400/30 bg-red-500/15 text-red-200"
                    : "border-white/[0.08] bg-white/[0.03] text-muted-fg/70"
                }`}
              >
                {row.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-xs font-medium ${checked ? "text-red-100" : "text-fg"}`}>{row.title}</span>
                <span className={`block truncate text-[11px] text-muted-fg/60 ${row.mono ? "font-mono" : ""}`}>{row.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type DeleteRemovalItem = { icon: React.ReactNode; label: React.ReactNode; hint?: string };

function buildDeleteRemovalPreview(
  selection: LaneDeleteSelection,
  lane: LaneSummary,
  risk: LaneDeleteRisk | null,
): DeleteRemovalItem[] {
  const items: DeleteRemovalItem[] = [];
  const branchRef = risk?.branchRef ?? lane.branchRef ?? null;
  const branchLabel = branchRef ? formatBranchLabel(branchRef) : null;
  const laneColor = lane.color ?? null;
  const laneColorStyle = laneColor ? { color: laneColor } : undefined;

  if (selection.worktree) {
    if (lane.laneType === "attached") {
      items.push({
        icon: <ArrowSquareOut size={12} className="text-red-300/80" />,
        label: "Unlink from ADE (keep branch)",
      });
    } else {
      items.push({
        icon: (
          <LaneIcon
            size={13}
            weight="duotone"
            className={laneColor ? "shrink-0" : "shrink-0 text-red-300/80"}
            style={laneColorStyle}
          />
        ),
        label: (
          <span className="flex min-w-0 flex-col">
            <span className="font-semibold" style={laneColorStyle}>
              {lane.name}
            </span>
            {lane.worktreePath ? (
              <span className="break-all text-[11px] text-muted-fg/55">{lane.worktreePath}</span>
            ) : null}
          </span>
        ),
      });
    }
  }

  if (selection.localBranch && branchLabel) {
    const unpushed =
      risk?.hasUnpushedCommits && risk.unpushedCommitCount > 0
        ? ` · ${risk.unpushedCommitCount} unpushed`
        : "";
    items.push({
      icon: <BranchIcon size={12} className="text-red-300/80" />,
      label: `Local branch · ${branchLabel}${unpushed}`,
    });
  }

  if (selection.remoteBranch && branchLabel) {
    items.push({
      icon: <Cloud size={12} className="text-red-300/80" />,
      label: `Remote · origin/${branchLabel}`,
      hint: risk && !risk.remoteBranchExists ? "Not on remote yet" : undefined,
    });
  }

  return items;
}

function PreflightPanel({
  risk,
  selection,
  lane,
  chatSessionCount,
}: {
  risk: LaneDeleteRisk | null;
  selection: LaneDeleteSelection;
  lane: LaneSummary;
  chatSessionCount?: number;
}) {
  const willStop: { icon: React.ReactNode; label: string }[] = [];
  const chatCount = chatSessionCount ?? 0;
  if (chatCount > 0) {
    willStop.push({
      icon: <ChatCircle size={12} className="text-accent" />,
      label: `${chatCount} chat ${chatCount === 1 ? "session" : "sessions"}`
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

  const willRemove = buildDeleteRemovalPreview(selection, lane, risk);

  if (willStop.length === 0 && willRemove.length === 0) return null;

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
      ) : null}
      {willRemove.length > 0 ? (
        <>
          <div className={`text-[10px] uppercase tracking-wide text-muted-fg/50 ${willStop.length > 0 ? "mt-2.5" : ""} mb-1.5`}>
            Will remove
          </div>
          <ul className="space-y-1.5">
            {willRemove.map((item, i) => (
              <li key={`remove-${i}`} className="flex items-start gap-2 text-xs text-red-200/85">
                <span className="mt-0.5 flex h-3.5 w-3.5 items-center justify-center">{item.icon}</span>
                <span className="flex min-w-0 flex-1 items-baseline gap-1 break-all">
                  {item.label}
                  {item.hint ? <span className="text-muted-fg/60">({item.hint})</span> : null}
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
