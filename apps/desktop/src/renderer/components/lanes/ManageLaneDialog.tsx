import React, { useEffect, useState } from "react";
import {
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
  FolderDashed,
  CheckCircle,
  Check,
  Cloud,
  X,
  Minus,
  PencilSimple,
} from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import { Banner, type BannerModel } from "../ui/notice/Banner";
import { noticeKindModel, type NoticeKind } from "../ui/notice/noticeKind";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import { LaneEmojiGlyph } from "./LaneEmojiGlyph";
import type {
  LaneDeleteEvent,
  LaneDeleteProgress,
  LaneDeleteRisk,
  LaneReclaimRisk,
  LaneDeleteStep,
  LaneDeleteStepName,
  LaneSummary,
  OpenProjectBinding,
} from "../../../shared/types";
import { LaneDialogShell } from "./LaneDialogShell";
import { LinearMark } from "./linearBrand";
import { showToast } from "../app/toast/toastStore";
import {
  LABEL_CLASS_NAME,
  INPUT_CLASS_NAME,
  SELECT_CLASS_NAME
} from "./laneDialogTokens";
import { LaneColorPicker } from "./LaneColorPicker";
import { colorsInUse, getLaneAccent, laneColorName } from "./laneColorPalette";
import { laneEmojiForDisplay } from "../../../shared/laneEmoji";
import { LaneEmojiPicker } from "./LaneEmojiPicker";
import { isImeComposing } from "../../lib/imeComposition";

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

function formatBytesCompact(bytes: number): string {
  const safe = Math.max(0, bytes);
  if (safe < 1024) return `${safe} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = safe / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

const STEP_LABELS: Record<LaneDeleteStepName, string> = {
  git_status: "Checking dirty state",
  stop_chats: "Closing chat sessions",
  stop_ptys: "Closing terminal sessions",
  stop_watchers: "Stopping file watchers",
  destroy_mac_desktop: "Releasing the Mac Desktop display",
  cleanup_env: "Cleaning environment",
  git_worktree_remove: "Removing worktree",
  git_branch_delete: "Deleting local branch",
  git_remote_branch_delete: "Deleting remote branch",
  pack_dir_remove: "Cleaning pack folder",
  database_cleanup: "Updating database"
};

const MANAGE_LANE_TITLE_CLASS = "truncate text-xl font-semibold tracking-tight sm:text-2xl";

function ManageLaneRenameControls({
  lane,
  allLanes,
  onRenamed,
  runtimePin,
  nameColor,
}: {
  lane: LaneSummary;
  allLanes: LaneSummary[];
  onRenamed?: () => void | Promise<void>;
  runtimePin?: OpenProjectBinding | null;
  nameColor: string;
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

  const setLaneEmoji = async (emoji: string | null) => {
    setRenameBusy(true);
    setRenameError(null);
    try {
      const args = { laneId: lane.id, emoji };
      await (runtimePin
        ? window.ade.lanes.updateAppearance(args, runtimePin)
        : window.ade.lanes.updateAppearance(args));
      await onRenamed?.();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "Failed to update lane emoji");
    } finally {
      setRenameBusy(false);
    }
  };

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
      const args = { laneId: lane.id, name: trimmedDraft };
      await (runtimePin
        ? window.ade.lanes.rename(args, runtimePin)
        : window.ade.lanes.rename(args));
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
      <span className={MANAGE_LANE_TITLE_CLASS} style={{ color: nameColor }}>{lane.name}</span>
    );
  }

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={MANAGE_LANE_TITLE_CLASS} style={{ color: nameColor }}>{lane.name}</span>
        <button
          type="button"
          aria-label="Rename lane"
          title="Rename lane"
          data-tour="lanes.manageDialog.rename"
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted-fg/70 transition hover:bg-fg/[0.06] hover:text-fg"
          onClick={() => setEditing(true)}
        >
          <PencilSimple size={14} />
        </button>
      </div>
    );
  }

  const laneEmoji = laneEmojiForDisplay(lane.emoji, lane.icon);
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="mt-2 flex h-11 min-w-[12rem] flex-1 items-center gap-1 rounded-lg border border-fg/[0.06] bg-fg/[0.03] px-2 transition-colors focus-within:border-accent/40">
          <LaneEmojiPicker
            value={laneEmoji}
            onChange={(emoji) => { void setLaneEmoji(emoji); }}
            disabled={renameBusy}
            label="Lane emoji"
            trigger={(
              <button
                type="button"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-base text-fg transition hover:bg-fg/[0.08] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-45"
                aria-label={laneEmoji
                  ? `Change lane emoji, current ${laneEmoji}`
                  : "Choose lane emoji"}
                title="Lane emoji"
                disabled={renameBusy}
              >
                {laneEmoji || <span className="text-sm text-muted-fg">＋</span>}
              </button>
            )}
          />
          <input
            type="text"
            value={draftName}
            autoFocus
            aria-label="Lane name"
            className="h-full min-w-0 flex-1 bg-transparent px-1 text-sm text-fg outline-none"
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return;
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
        </div>
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
        <Banner
          layout="inline"
          model={{
            id: "manage-lane-rename-error",
            tone: "error",
            title: renameError,
            report: { surface: "manage_lane_rename" },
            dismiss: { onDismiss: () => setRenameError(null) },
          }}
        />
      ) : null}
    </div>
  );
}

function ManageLaneHeaderDetails({
  lanes,
  isBatch,
}: {
  lanes: LaneSummary[];
  isBatch: boolean;
}) {
  if (isBatch) {
    return (
      <div data-tour="lanes.manageDialog.laneInfo" className="space-y-2">
        <div className="max-h-[min(28vh,160px)] space-y-1.5 overflow-y-auto pr-1">
          {lanes.map((lane) => (
            <div key={lane.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <LaneEmojiGlyph
                emoji={lane.emoji}
                icon={lane.icon}
                className="shrink-0 text-[11px] leading-none"
                fallback={<LaneIcon size={11} className="shrink-0 text-muted-fg/60" />}
              />
              <span className="font-semibold text-fg">{lane.name}</span>
              <BranchIcon size={10} className="shrink-0 text-muted-fg/50" />
              <span className="truncate font-mono text-muted-fg/60">{formatBranchLabel(lane.branchRef)}</span>
              <span className="rounded-md bg-fg/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-fg">
                {lane.laneType}
              </span>
              {lane.status.dirty ? (
                <span className="whitespace-nowrap rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                  Uncommitted changes
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
      <dl className="space-y-1 text-xs">
        <div className="grid grid-cols-[48px_1fr] items-center gap-x-3">
          <dt className="text-muted-fg/60">Branch</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-fg/85">{formatBranchLabel(lane.branchRef)}</span>
            {lane.status.dirty ? (
              <span className="shrink-0 whitespace-nowrap rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                Uncommitted changes
              </span>
            ) : null}
          </dd>
        </div>
        <div className="grid grid-cols-[48px_1fr] items-center gap-x-3">
          <dt className="text-muted-fg/60">Path</dt>
          <dd className="min-w-0 truncate text-fg/75" title={lane.worktreePath}>{lane.worktreePath}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * What a lane archive/delete left to say: ADE failing (`failure`), or the
 * person's or the machine's state (`status`: a cancelled delete, an offline
 * machine). A delete that finished with leftovers is a `status` that still
 * offers Report (`reportable`).
 */
export type LaneActionError = { message: string; kind: NoticeKind; reportable?: boolean };

export function laneActionErrorTone(error: LaneActionError): Pick<BannerModel, "tone" | "report"> {
  const report = { surface: "lane_action", technicalDetail: error.message };
  return noticeKindModel(error.kind, error.kind === "failure" || error.reportable ? report : undefined);
}

export type ManageLaneTab = "appearance" | "archive" | "delete";

type ManageLaneTabDef = {
  id: ManageLaneTab;
  label: string;
  icon: typeof Palette;
};

type ManageLaneTabTone = "delete" | "accent" | "neutral";

const TAB_PANEL_TONE_CLASS: Record<ManageLaneTabTone, string> = {
  delete: "border-red-500/25 bg-gradient-to-br from-red-500/[0.1] via-red-950/20 to-transparent",
  accent: "border-accent/25 bg-gradient-to-br from-accent/[0.1] via-accent/[0.02] to-transparent",
  neutral: "border-fg/[0.08] bg-gradient-to-br from-fg/[0.06] via-fg/[0.02] to-transparent",
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
      <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-fg/15 to-transparent" />
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
      className="grid gap-1 rounded-xl border border-fg/[0.08] bg-black/25 p-1"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        const Icon = tab.icon;
        const isDelete = tab.id === "delete";
        let activeStateClass: string;
        if (!isActive) {
          activeStateClass = "text-muted-fg/80 hover:bg-fg/[0.04] hover:text-fg";
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
  onArchive,
  onDelete,
  onAppearanceChanged,
  runtimePin,
  initialTab,
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
  laneActionError: LaneActionError | null;
  laneActionKind?: "delete" | "archive" | null;
  /** Resolves true when every lane was archived. */
  onArchive: () => Promise<boolean>;
  onDelete: () => void;
  onAppearanceChanged?: () => void | Promise<void>;
  runtimePin?: OpenProjectBinding | null;
  /** Tab to open on, e.g. "archive" for the sidebar's "Archive all". Defaults to Delete. */
  initialTab?: ManageLaneTab | null;
}) {
  const lanes = managedLanes?.length ? managedLanes : managedLane ? [managedLane] : [];
  const isBatch = lanes.length > 1;
  const allPrimary = lanes.length > 0 && lanes.every((l) => l.laneType === "primary");
  const hasAnyDirty = lanes.some((l) => l.status.dirty);
  const singleLane = !isBatch ? lanes[0] ?? null : null;

  const singleLaneId = singleLane?.id ?? null;
  const singleLaneType = singleLane?.laneType ?? null;
  const [deleteRisk, setDeleteRisk] = useState<LaneDeleteRisk | null>(null);
  const [reclaimRisk, setReclaimRisk] = useState<LaneReclaimRisk | null>(null);
  const [reclaimConfirm, setReclaimConfirm] = useState("");
  const [discardDirtyConfirmed, setDiscardDirtyConfirmed] = useState(false);
  const [reclaimBusy, setReclaimBusy] = useState(false);
  const [reclaimError, setReclaimError] = useState<string | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<LaneDeleteProgress | null>(null);
  const [activeTab, setActiveTab] = useState<ManageLaneTab>("delete");
  // Archiving a lane whose Linear issue is still open can also cancel the issue.
  const openLinearIssue = singleLane?.linearIssue
    && singleLane.linearIssue.stateType !== "completed"
    && singleLane.linearIssue.stateType !== "canceled"
    ? singleLane.linearIssue
    : null;
  const [cancelLinearIssue, setCancelLinearIssue] = useState(false);
  useEffect(() => {
    setCancelLinearIssue(false);
  }, [singleLaneId]);
  // Runs only after the archive succeeded.
  const cancelLinkedIssueIfAsked = async (): Promise<void> => {
    if (!openLinearIssue || !cancelLinearIssue) return;
    try {
      const cancel = window.ade?.cto?.cancelLinearIssue;
      if (!cancel) throw new Error("Linear is not available in this window.");
      const result = await cancel(openLinearIssue.id);
      if (result.canceled) showToast({ tone: "success", title: `${openLinearIssue.identifier} canceled in Linear` });
    } catch (err) {
      showToast({
        tone: "warning",
        title: `Could not cancel ${openLinearIssue.identifier}`,
        message: err instanceof Error ? err.message : "Linear request failed. The lane was still archived.",
      });
    }
  };

  const tabDefs = React.useMemo((): ManageLaneTabDef[] => {
    return [
      { id: "delete" as const, label: "Delete", icon: Trash, show: true },
      { id: "appearance" as const, label: "Appearance", icon: Palette, show: !!singleLaneType },
      { id: "archive" as const, label: "Archive", icon: Archive, show: true },
    ]
      .filter((t) => t.show)
      .map(({ show: _, ...tab }) => tab);
  }, [singleLaneType]);
  // Manage Lane opens on Delete, the first tab and the action users reach for
  // most, with nothing ticked (the hosts start with an empty selection and
  // Force delete off). Callers can pick another tab ("Archive all" opens on Archive).
  const defaultTab = React.useMemo((): ManageLaneTab => {
    if (initialTab && tabDefs.some((tab) => tab.id === initialTab)) return initialTab;
    return tabDefs.some((tab) => tab.id === "delete") ? "delete" : tabDefs[0]?.id ?? "archive";
  }, [initialTab, tabDefs]);

  // Reset transient state when dialog closes or active lane changes.
  useEffect(() => {
    if (!open) {
      setDeleteRisk(null);
      setReclaimRisk(null);
      setReclaimConfirm("");
      setDiscardDirtyConfirmed(false);
      setReclaimError(null);
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
    const getReclaimRisk = window.ade.lanes.getReclaimRisk;
    const deleteRiskPromise = runtimePin
      ? window.ade.lanes.getDeleteRisk({ laneId: singleLaneId }, runtimePin)
      : window.ade.lanes.getDeleteRisk({ laneId: singleLaneId });
    const reclaimRiskPromise = typeof getReclaimRisk === "function"
      ? runtimePin
        ? getReclaimRisk({ laneId: singleLaneId }, runtimePin)
        : getReclaimRisk({ laneId: singleLaneId })
      : Promise.resolve(null);
    void Promise.all([
      deleteRiskPromise,
      reclaimRiskPromise,
    ])
      .then(([deleteResult, reclaimResult]) => {
        if (!cancelled) {
          setDeleteRisk(deleteResult);
          setReclaimRisk(reclaimResult);
          setDiscardDirtyConfirmed(false);
        }
      })
      .catch(() => {
        // best-effort — pre-flight is informational only
      });
    return () => {
      cancelled = true;
    };
  }, [open, runtimePin, singleLaneId, singleLaneType]);

  // Stream live delete progress for the active lane.
  useEffect(() => {
    if (!open || !singleLaneId) return;
    const handleDeleteEvent = (event: LaneDeleteEvent) => {
      if (event.progress.laneId !== singleLaneId) return;
      setDeleteProgress(event.progress);
    };
    const unsubscribe = runtimePin
      ? window.ade.lanes.onDeleteEvent(handleDeleteEvent, runtimePin)
      : window.ade.lanes.onDeleteEvent(handleDeleteEvent);
    return () => {
      unsubscribe?.();
    };
  }, [open, runtimePin, singleLaneId]);

  const hasDeleteSelection = laneDeleteSelectionHasAny(deleteSelection);
  // A lane with uncommitted work only deletes with Force on; say so at the button.
  const needsForce = hasAnyDirty && !deleteForce;
  const deleteDisabledReason = !hasDeleteSelection
    ? "Pick what to delete"
    : needsForce
      ? "Tick Force delete to discard uncommitted work"
      : null;
  const deleteDisabled = laneActionBusy || deleteDisabledReason != null;
  const showStaticBusy = laneActionBusy && !deleteProgress;
  const reclaimBlocked = reclaimRisk?.blockedReasons.some((reason) => reason.disposition === "blocked") ?? false;

  const archiveAndReclaim = async () => {
    if (
      !singleLane
      || !reclaimRisk
      || reclaimConfirm !== "RECLAIM"
      || (reclaimRisk.dirty && !discardDirtyConfirmed)
    ) return;
    setReclaimBusy(true);
    setReclaimError(null);
    try {
      const args = {
        laneId: singleLane.id,
        confirmation: "RECLAIM" as const,
        ...(reclaimRisk.dirty && discardDirtyConfirmed ? { forceDirty: true } : {}),
      };
      await (runtimePin
        ? window.ade.lanes.archiveAndReclaim(args, runtimePin)
        : window.ade.lanes.archiveAndReclaim(args));
      void cancelLinkedIssueIfAsked();
      await onAppearanceChanged?.();
      onOpenChange(false);
    } catch (error) {
      setReclaimError(error instanceof Error ? error.message : "Could not reclaim this lane");
    } finally {
      setReclaimBusy(false);
    }
  };

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

  // A branch that was never pushed has no remote copy to delete.
  const remoteBranchMissing = deleteRisk != null && !deleteRisk.remoteBranchExists;
  const allTargetsSelected =
    deleteSelection.worktree && deleteSelection.localBranch && (deleteSelection.remoteBranch || remoteBranchMissing);
  const toggleSelectAll = () => {
    setDeleteSelection(
      allTargetsSelected
        ? EMPTY_LANE_DELETE_SELECTION
        : { worktree: true, localBranch: true, remoteBranch: !remoteBranchMissing },
    );
  };
  useEffect(() => {
    if (remoteBranchMissing && deleteSelection.remoteBranch) {
      setDeleteSelection({ ...deleteSelection, remoteBranch: false });
    }
  }, [remoteBranchMissing, deleteSelection, setDeleteSelection]);

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
      ? (
          <ManageLaneHeaderDetails
            lanes={lanes}
            isBatch={isBatch}
          />
        )
      : undefined;

  const laneAccent = singleLane
    ? getLaneAccent(singleLane, Math.max(0, allLanes.findIndex((candidate) => candidate.id === singleLane.id)))
    : undefined;
  const dialogTitle = isBatch
    ? `${lanes.length} lanes`
    : singleLane?.name ?? "Lane";
  const titleContent = isBatch
    ? (
        <span className={MANAGE_LANE_TITLE_CLASS}>{dialogTitle}</span>
      )
    : singleLane && laneAccent
      ? (
          <ManageLaneRenameControls
            lane={singleLane}
            allLanes={allLanes}
            onRenamed={onAppearanceChanged}
            runtimePin={runtimePin}
            nameColor={laneAccent}
          />
        )
      : undefined;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={dialogTitle}
      titleContent={titleContent}
      headerExtra={headerExtra}
      width="min(720px, calc(100vw - 1rem))"
      busy={laneActionBusy}
      // The rename pencil is the first control; focusing it on open drew a ring.
      preventAutoFocus
    >
      {lanes.length === 0 ? (
        <div className="py-4 text-sm text-muted-fg">Select a lane first.</div>
      ) : allPrimary ? (
        <div className="rounded-lg border border-fg/[0.06] bg-fg/[0.02] px-3 py-3 text-sm text-muted-fg">
          Primary lane cannot be archived or deleted. Close this dialog or pick another lane.
        </div>
      ) : (
        <div className="space-y-4" data-tour="lanes.manageDialog">
          <ManageLaneTabBar tabs={tabDefs} active={activeTab} onChange={setActiveTab} />

          {activeTab === "appearance" && singleLane ? (
            <ManageLaneTabPanel tone="accent">
              <AppearanceSection
                lane={singleLane}
                allLanes={allLanes}
                disabled={laneActionBusy}
                onChanged={onAppearanceChanged}
                runtimePin={runtimePin}
              />
            </ManageLaneTabPanel>
          ) : null}

          {activeTab === "archive" ? (
            <ManageLaneTabPanel tone="neutral">
              <p className="text-xs leading-relaxed text-muted-fg/75">
                Choose whether to keep the local files or reclaim their disk space. Both choices keep the lane, branch, chats, and metadata.
              </p>
              {openLinearIssue ? (
                <label className="mt-3 flex items-center gap-2 rounded-lg border border-fg/[0.08] bg-fg/[0.02] px-3 py-2 text-xs text-muted-fg/80">
                  <input
                    type="checkbox"
                    checked={cancelLinearIssue}
                    onChange={(event) => setCancelLinearIssue(event.target.checked)}
                    disabled={laneActionBusy || reclaimBusy}
                  />
                  <LinearMark size={12} />
                  <span>
                    Also cancel <span className="font-mono text-fg/85">{openLinearIssue.identifier}</span> in Linear
                    <span className="text-muted-fg/55"> · it is {openLinearIssue.stateName} now</span>
                  </span>
                </label>
              ) : null}
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded-xl border border-fg/[0.08] bg-fg/[0.025] p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                    <Archive size={16} className="text-accent" />
                    Archive
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-fg/70">
                    Hides the lane from active work. Its worktree and generated files stay on disk.
                  </p>
                  <div className="mt-3">
                    <Button
                      size="sm"
                      variant="outline"
                      data-tour="lanes.manageDialog.archive"
                      disabled={laneActionBusy || reclaimBusy}
                      onClick={() => {
                        void onArchive().then((archived) => (archived ? cancelLinkedIssueIfAsked() : undefined));
                      }}
                    >
                      {isBatch ? `Archive ${lanes.length} lanes` : "Archive and keep files"}
                    </Button>
                  </div>
                </div>
                {!isBatch && singleLane?.laneType === "worktree" ? (
                  <div className="rounded-xl border border-fg/[0.08] bg-fg/[0.025] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                        <FolderDashed size={16} className="text-accent" />
                        Archive &amp; reclaim
                      </div>
                      <span className="text-xs font-semibold tabular-nums text-muted-fg">
                        {reclaimRisk ? formatBytesCompact(reclaimRisk.reclaimableBytes) : "Measuring…"}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-fg/70">
                      Removes the local worktree and ADE-generated lane data. Restoring the lane recreates its worktree.
                    </p>
                    {reclaimRisk?.blockedReasons.map((reason) => (
                      <Banner
                        key={reason.code}
                        model={{ id: `lane-reclaim-blocked-${reason.code}`, tone: "warning", title: reason.message }}
                        layout="inline"
                        style={{ marginTop: 8 }}
                      />
                    ))}
                    {reclaimRisk?.dirty ? (
                      <label className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-amber-100/80">
                        <input
                          type="checkbox"
                          checked={discardDirtyConfirmed}
                          onChange={(event) => setDiscardDirtyConfirmed(event.target.checked)}
                          disabled={reclaimBusy || laneActionBusy}
                          className="mt-0.5"
                        />
                        <span>Discard uncommitted changes in this lane. These file changes cannot be restored.</span>
                      </label>
                    ) : null}
                    <label className="mt-3 block text-[11px] text-muted-fg/80">
                      Type <strong className="text-fg">RECLAIM</strong> to confirm
                      <input
                        value={reclaimConfirm}
                        onChange={(event) => setReclaimConfirm(event.target.value)}
                        disabled={reclaimBusy || laneActionBusy}
                        className={`${INPUT_CLASS_NAME} mt-1.5 w-full text-xs`}
                      />
                    </label>
                    {reclaimError ? (
                      <Banner
                        model={{ id: "lane-reclaim-error", tone: "error", title: reclaimError }}
                        layout="inline"
                        style={{ marginTop: 8 }}
                      />
                    ) : null}
                    <div className="mt-3">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={
                          !reclaimRisk
                          || laneActionBusy
                          || reclaimBusy
                          || reclaimBlocked
                          || (reclaimRisk.dirty && !discardDirtyConfirmed)
                          || reclaimConfirm !== "RECLAIM"
                        }
                        onClick={() => { void archiveAndReclaim(); }}
                      >
                        {reclaimBusy ? <CircleNotch size={13} className="animate-spin" /> : <FolderDashed size={13} />}
                        {reclaimBusy
                          ? "Reclaiming…"
                          : !reclaimRisk
                            ? "Measuring…"
                            : reclaimBlocked
                              ? "Cannot reclaim this folder"
                              : reclaimRisk.dirty && !discardDirtyConfirmed
                                ? "Confirm discarded changes"
                                : `Reclaim ${formatBytesCompact(reclaimRisk.reclaimableBytes)}`}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </ManageLaneTabPanel>
          ) : null}

          {activeTab === "delete" ? (
            <ManageLaneTabPanel tone="delete">
              <p className="whitespace-nowrap text-xs text-red-200/70">
                Stops lane activity and removes what you pick. Cannot be undone.
                {!isBatch && reclaimRisk && reclaimRisk.reclaimableBytes > 0 ? (
                  <span className="text-muted-fg/70"> Frees about <strong className="text-fg">{formatBytesCompact(reclaimRisk.reclaimableBytes)}</strong>.</span>
                ) : null}
              </p>

              {/* Uncommitted changes are named once, by the header chip; the
                  Force delete row and the button's reason carry the rest. */}
              <DeleteTargetChecklist
                selection={deleteSelection}
                // A row that cannot be picked leaves "Select everything" mixed, not ticked.
                allSelected={allTargetsSelected && !remoteBranchMissing}
                disabled={laneActionBusy}
                onToggle={toggleDeleteTarget}
                onToggleAll={toggleSelectAll}
                risk={deleteRisk}
                lane={singleLane}
                remoteBranchMissing={remoteBranchMissing}
              />

              {singleLane ? (
                <PreflightPanel
                  risk={deleteRisk}
                  chatSessionCount={chatSessionCount}
                />
              ) : null}

              <label className="mt-3 flex items-center gap-2 whitespace-nowrap text-xs text-muted-fg/80 cursor-pointer select-none">
                <input type="checkbox" checked={deleteForce} onChange={(event) => setDeleteForce(event.target.checked)} disabled={laneActionBusy} className="rounded accent-red-400" />
                Force delete
                <span className="text-muted-fg/50">· discards uncommitted work</span>
              </label>

              {deleteProgress ? (
                <DeleteProgressStrip progress={deleteProgress} />
              ) : showStaticBusy && (laneActionKind === "delete" || laneActionKind === "archive" || laneActionKind == null) ? (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-fg/[0.08] bg-black/25 px-3 py-2 text-xs text-muted-fg" role="status" aria-live="polite">
                  <CircleNotch
                    size={14}
                    className={`shrink-0 animate-spin ${laneActionKind === "delete" ? "text-red-300" : "text-amber-300"}`}
                  />
                  <span>{laneActionStatus ?? "Working..."}</span>
                </div>
              ) : null}

              {laneActionError && (laneActionKind === "delete" || laneActionKind === "archive" || laneActionKind == null) ? (
                <Banner
                  model={{
                    id: "lane-action-error",
                    ...laneActionErrorTone(laneActionError),
                    ariaLabel: laneActionError.message,
                    title: <span style={{ whiteSpace: "pre-wrap" }}>{laneActionError.message}</span>,
                  }}
                  layout="inline"
                  style={{ marginTop: 12 }}
                />
              ) : null}

              <div className="mt-4 flex items-center gap-3">
                <Button
                  size="sm"
                  variant="danger"
                  casing="sentence"
                  data-tour="lanes.manageDialog.delete"
                  disabled={deleteDisabled}
                  onClick={onDelete}
                  className={deleteDisabled
                    ? "!border-fg/[0.1] !bg-fg/[0.05] !text-muted-fg disabled:!opacity-100"
                    : "!border-red-600 !bg-red-600 !text-white hover:!bg-red-500"}
                >
                  {laneActionBusy && laneActionKind === "delete" ? <CircleNotch size={13} className="animate-spin" /> : <Trash size={13} />}
                  {laneActionBusy && laneActionKind === "delete"
                    ? "Deleting..."
                    : isBatch
                      ? `Delete ${lanes.length} lanes`
                      : "Delete lane"}
                </Button>
                {deleteDisabledReason && !laneActionBusy ? (
                  <span className="whitespace-nowrap text-xs text-muted-fg/70">{deleteDisabledReason}</span>
                ) : null}
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
        active ? "border-red-400/70 bg-red-500/80 text-white" : "border-white/25 bg-fg/[0.04]"
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
  risk,
  lane,
  remoteBranchMissing,
}: {
  selection: LaneDeleteSelection;
  allSelected: boolean;
  disabled: boolean;
  onToggle: (key: keyof LaneDeleteSelection, next: boolean) => void;
  onToggleAll: () => void;
  risk: LaneDeleteRisk | null;
  lane: LaneSummary | null;
  /** The branch was never pushed, so the remote row has nothing to delete. */
  remoteBranchMissing: boolean;
}) {
  const branchRef = risk?.branchRef ?? lane?.branchRef ?? null;
  const branchLabel = branchRef ? formatBranchLabel(branchRef) : null;
  const someSelected = selection.worktree || selection.localBranch || selection.remoteBranch;

  const rows: { key: keyof LaneDeleteSelection; icon: React.ReactNode; title: string; hint: string; mono?: boolean; unavailable?: boolean }[] = [
    {
      key: "worktree",
      icon: <Cube size={15} weight="duotone" />,
      title: "Worktree",
      hint: "Removes the working folder and ADE registration.",
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
      hint: remoteBranchMissing ? "Not on remote" : branchLabel ? `origin · ${branchLabel}` : "Delete the branch on the remote",
      mono: Boolean(branchLabel) && !remoteBranchMissing,
      unavailable: remoteBranchMissing,
    },
  ];

  return (
    <div data-tour="lanes.manageDialog.tabs" className="mt-4 space-y-2">
      <button
        type="button"
        disabled={disabled}
        onClick={onToggleAll}
        aria-pressed={allSelected}
        className="flex h-8 w-full items-center gap-2 rounded-lg border border-fg/[0.08] bg-fg/[0.03] px-2.5 text-left transition-colors hover:bg-fg/[0.05] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <DeleteCheckbox checked={allSelected} indeterminate={someSelected && !allSelected} />
        <div className="min-w-0 flex-1 text-[11px] font-medium text-fg">Select everything</div>
      </button>

      <div className="ml-3 overflow-hidden rounded-xl border border-fg/[0.08] bg-black/25">
        <div className="divide-y divide-fg/[0.04]">
          {rows.map((row) => {
            const checked = selection[row.key] && !row.unavailable;
            return (
              <button
                key={row.key}
                type="button"
                role="checkbox"
                aria-checked={checked}
                disabled={disabled || row.unavailable}
                onClick={() => onToggle(row.key, !checked)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed ${row.unavailable ? "disabled:opacity-40" : "disabled:opacity-60"} ${
                  checked ? "bg-red-500/[0.08]" : "hover:bg-fg/[0.03]"
                }`}
              >
                <DeleteCheckbox checked={checked} />
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
                    checked
                      ? "border-red-400/30 bg-red-500/15 text-red-200"
                      : "border-fg/[0.08] bg-fg/[0.03] text-muted-fg/70"
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
    </div>
  );
}

function PreflightPanel({
  risk,
  chatSessionCount,
}: {
  risk: LaneDeleteRisk | null;
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

  // What gets removed is the checklist above; this panel names only what stops.
  if (willStop.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg/80">
      <span className="text-muted-fg/60">Stops</span>
      {willStop.map((item, i) => (
        <span key={`stop-${i}`} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {item.icon}
          {item.label}
        </span>
      ))}
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
      tone = "border-fg/[0.08] bg-fg/[0.04]";
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
        <div className="mt-2 text-[11px] text-amber-300">Delete stopped. The lane is still here; delete it again to finish.</div>
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
  runtimePin,
}: {
  lane: LaneSummary;
  allLanes: LaneSummary[];
  disabled: boolean;
  onChanged?: () => void | Promise<void>;
  runtimePin?: OpenProjectBinding | null;
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
      const args = { laneId: lane.id, color: next };
      await (runtimePin
        ? window.ade.lanes.updateAppearance(args, runtimePin)
        : window.ade.lanes.updateAppearance(args));
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set color");
    } finally {
      setBusy(false);
    }
  };

  const applyEmoji = async (next: string | null) => {
    setError(null);
    setBusy(true);
    try {
      const args = { laneId: lane.id, emoji: next };
      await (runtimePin
        ? window.ade.lanes.updateAppearance(args, runtimePin)
        : window.ade.lanes.updateAppearance(args));
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set emoji");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-fg/70">Lane color in tabs and the lane list. No git changes.</p>
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
      <div className="mt-4 flex items-center gap-2">
        <LaneEmojiPicker
          value={laneEmojiForDisplay(lane.emoji, lane.icon)}
          label="Lane emoji"
          disabled={disabled || busy}
          onChange={(next) => { void applyEmoji(next); }}
        />
        <div>
          <div className="text-xs font-medium text-fg/80">Lane emoji</div>
          <div className="text-[11px] text-muted-fg/65">Shown beside the lane name.</div>
        </div>
      </div>
      {error ? (
        <Banner
          layout="inline"
          style={{ marginTop: 8 }}
          model={{
            id: "manage-lane-appearance-error",
            tone: "error",
            title: error,
            report: { surface: "manage_lane_appearance" },
            dismiss: { onDismiss: () => setError(null) },
          }}
        />
      ) : null}
      {busy || disabled ? (
        <div className="sr-only" role="status">Updating</div>
      ) : null}
    </>
  );
}
