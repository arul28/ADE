import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowRight,
  Clock,
  File as FileIcon,
  GitCommit,
  GitMerge,
  Path,
  Timer,
  Trash,
  XCircle,
  type Icon,
} from "@phosphor-icons/react";

import type {
  MergeMethod,
  PrCheck,
  PrCommit,
  PrReview,
  PrStatus,
  PrWithConflicts,
  UpdateBranchStrategy,
} from "../../../../shared/types/prs";
import { LaneDialogShell } from "../../lanes/LaneDialogShell";
import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { formatTimestampShort } from "./prFormatters";
import { canAttemptMerge } from "./prMergeRailUtils";
import { PrMergeChecklist } from "./PrMergeChecklist";
import { PrMergeDialog, type PrMergeDialogResult } from "./PrMergeDialog";
import { PrUserAvatar } from "./PrUserAvatar";
import { prFlatButton, prSectionAction, prSolidButton } from "./prSection";

/**
 * The rail's frame.
 *
 * Merging is the one irreversible act on this surface, so the rail gets the only
 * accent outline in the three-column detail view — an ADE-accent hairline and a
 * radius, nothing else. Deliberately NOT `floatingPane`: a fill plus a drop
 * shadow is what made this pane read as a blob, and a filled accent container
 * would also start competing with the merge button for "this is the action".
 * A hairline frames; only the solid button acts.
 */
/**
 * The accent frame around the merge rail.
 *
 * `marginTop` only — a symmetric margin inset the frame from the pane's own
 * edges, so the border traced a box narrower than the space available and read
 * as a floating card rather than as the bottom of the rail. The top margin is
 * the separation from the section above; the sides and bottom belong to the
 * pane's padding, not to this box.
 */
const RAIL_FRAME: CSSProperties = {
  width: "100%",
  // Content-sized on purpose. Filling the pane's leftover height wrapped a short
  // merged banner in a tall empty box — the border should trace the content, not
  // the space. Width still spans the rail, so it grows with the separator.
  flexShrink: 0,
  marginTop: 10,
  borderRadius: 10,
  border: `1px solid color-mix(in srgb, ${COLORS.accent} 38%, transparent)`,
  background: "transparent",
};

/** Hairline between the rail's state block and its action row. */
const RAIL_DIVIDER = `1px solid ${COLORS.borderMuted}`;

/**
 * A branch name in the merged banner. Same chip vocabulary the timeline and the
 * detail header use, so the pair reads as branches rather than as raw text.
 *
 * The head chip shrinks and ellipsises; the base chip never does. In a ~390px
 * rail that keeps a long lane branch on one line instead of pushing "main" onto
 * a second row, and the full name stays available on hover.
 */
function BranchChip({ label, accent = false }: { label: string; accent?: boolean }) {
  const color = accent ? COLORS.accent : COLORS.textSecondary;
  return (
    <span
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        minWidth: 0,
        // Only the head branch gives up room; "main" stays whole.
        flexShrink: accent ? 1 : 0,
        overflow: "hidden",
        padding: "2px 6px",
        borderRadius: 5,
        fontSize: 10,
        fontFamily: MONO_FONT,
        color,
        background: accent ? `color-mix(in srgb, ${COLORS.accent} 12%, transparent)` : COLORS.recessedBg,
        border: `1px solid ${accent ? COLORS.accentBorder : COLORS.border}`,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </span>
  );
}

/** One shipped figure: a glyph, the number, then the noun it counts. */
function ShippedStat({ icon: Glyph, value, label }: { icon: Icon; value: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" style={{ color: COLORS.textMuted }}>
      <Glyph size={11} style={{ color: COLORS.textDim, flexShrink: 0 }} />
      <span>
        <span style={{ color: COLORS.textSecondary, fontWeight: 600 }}>{value}</span> {label}
      </span>
    </span>
  );
}

/**
 * The record of how a PR shipped, shown under the merged banner.
 *
 * Three groups, in descending importance: who merged it and when (attribution),
 * how big it was (figures), and which ADE lane produced it (provenance). Every
 * group is independently omitted — PRs merged before ADE recorded merge metadata
 * show less rather than showing blanks or invented values.
 *
 * The lane group is the part GitHub cannot give you; it survives the lane's
 * deletion because the counts are frozen at detach time. It is marked as ADE's
 * own — accent label, lane colour, the word "ADE lane" — so it is never mistaken
 * for another line of GitHub metadata.
 */
function PrShippedSummary({ pr }: { pr: PrWithConflicts }) {
  const mergedBy = pr.mergedBy ?? null;
  const mergedOn = pr.mergedAt ? formatTimestampShort(pr.mergedAt) : null;
  const hasAttribution = Boolean(mergedBy?.login || mergedOn);

  const openFor = formatOpenDuration(pr.createdAt, pr.mergedAt);
  const stats: { key: string; icon: Icon; value: string; label: string }[] = [];
  if (pr.commitCount != null) {
    stats.push({ key: "commits", icon: GitCommit, value: String(pr.commitCount), label: pr.commitCount === 1 ? "commit" : "commits" });
  }
  if (pr.changedFiles != null) {
    stats.push({ key: "files", icon: FileIcon, value: String(pr.changedFiles), label: pr.changedFiles === 1 ? "file" : "files" });
  }
  if (openFor) stats.push({ key: "open", icon: Timer, value: openFor, label: "open" });

  const detached = pr.detached;
  const laneName = detached?.laneName ?? null;
  const laneCounts = detached
    ? ([
      detached.chats > 0 ? `${detached.chats} chat${detached.chats === 1 ? "" : "s"}` : null,
      detached.artifacts > 0 ? `${detached.artifacts} proof` : null,
    ].filter(Boolean) as string[])
    : [];

  if (!hasAttribution && stats.length === 0 && !laneName) return null;

  return (
    <div
      data-testid="pr-shipped-summary"
      className="mt-2 text-[10px] leading-snug"
      style={{ fontFamily: SANS_FONT }}
    >
      {hasAttribution ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1" style={{ color: COLORS.textMuted }}>
          {mergedBy?.login ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <PrUserAvatar user={{ login: mergedBy.login, avatarUrl: mergedBy.avatarUrl }} size={13} />
              <span className="min-w-0 truncate" style={{ color: COLORS.textSecondary }} title={mergedBy.login}>
                {mergedBy.login}
              </span>
            </span>
          ) : null}
          {mergedOn ? (
            <span className="inline-flex items-center gap-1.5">
              <Clock size={11} style={{ color: COLORS.textDim, flexShrink: 0 }} />
              {mergedOn}
            </span>
          ) : null}
        </div>
      ) : null}

      {stats.length > 0 ? (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1${hasAttribution ? " mt-1.5" : ""}`}>
          {stats.map((stat) => (
            <ShippedStat key={stat.key} icon={stat.icon} value={stat.value} label={stat.label} />
          ))}
        </div>
      ) : null}

      {laneName ? (
        <div
          data-testid="pr-shipped-lane"
          className="mt-2 min-w-0"
          style={{
            paddingLeft: 7,
            borderLeft: `2px solid color-mix(in srgb, ${detached?.laneColor || COLORS.accent} 55%, transparent)`,
          }}
        >
          <div className="flex items-center gap-1.5" style={{ color: COLORS.accent }}>
            <Path size={10} weight="bold" style={{ flexShrink: 0 }} />
            <span style={{ fontWeight: 600 }}>ADE lane</span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 truncate" style={{ color: COLORS.textSecondary }} title={laneName}>
              {laneName}
            </span>
            {laneCounts.length > 0 ? (
              <span className="shrink-0" style={{ color: COLORS.textMuted }}>
                · {laneCounts.join(" · ")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** "2d 4h" / "5h" / "12m" — how long the PR was open before it merged. */
function formatOpenDuration(createdAt: string | null | undefined, mergedAt: string | null | undefined): string | null {
  if (!createdAt || !mergedAt) return null;
  const start = new Date(createdAt).getTime();
  const end = new Date(mergedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours > 0 ? `${days}d ${remainderHours}h` : `${days}d`;
}

/** localStorage key for the remembered merge method (dialog default). */
const LAST_MERGE_METHOD_KEY = "ade:prs:lastMergeMethod";

function readLastMergeMethod(fallback: MergeMethod): MergeMethod {
  try {
    const raw = window.localStorage.getItem(LAST_MERGE_METHOD_KEY);
    if (raw === "squash" || raw === "merge" || raw === "rebase") return raw;
  } catch {
    // localStorage can be unavailable in private/test environments.
  }
  return fallback;
}

function writeLastMergeMethod(method: MergeMethod): void {
  try {
    window.localStorage.setItem(LAST_MERGE_METHOD_KEY, method);
  } catch {
    // ignore
  }
}

export type PrDetailMergeRailProps = {
  pr: PrWithConflicts;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  commits?: PrCommit[];
  mergeMethod: MergeMethod;
  actionBusy: boolean;
  onMerge: (method: MergeMethod, options?: {
    bypassRules?: boolean;
    commitTitle?: string;
    commitBody?: string;
    expectedHeadSha?: string;
  }) => void;
  onUpdateBranch?: (strategy: UpdateBranchStrategy) => void;
  updateBranchBusy?: boolean;
  updateBranchNotice?: { tone: "success" | "error"; text: string } | null;
  onDeleteBranch?: () => void;
  deleteBranchBusy?: boolean;
  onOpenManageLane?: () => void;
  onClose?: () => void;
  onReopen?: () => void;
};

export const PrDetailMergeRail = memo(function PrDetailMergeRail({
  pr,
  status,
  checks,
  reviews,
  commits = [],
  mergeMethod,
  actionBusy,
  onMerge,
  onUpdateBranch,
  updateBranchBusy = false,
  updateBranchNotice = null,
  onDeleteBranch,
  deleteBranchBusy = false,
  onOpenManageLane,
  onClose,
  onReopen,
}: PrDetailMergeRailProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [defaultMethod, setDefaultMethod] = useState<MergeMethod>(() => readLastMergeMethod(mergeMethod));
  const [deleteBranchArmed, setDeleteBranchArmed] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const deleteBranchArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDeleteBranchClick = useCallback(() => {
    if (!onDeleteBranch) return;
    if (deleteBranchArmed) {
      if (deleteBranchArmTimer.current) clearTimeout(deleteBranchArmTimer.current);
      setDeleteBranchArmed(false);
      onDeleteBranch();
      return;
    }
    setDeleteBranchArmed(true);
    if (deleteBranchArmTimer.current) clearTimeout(deleteBranchArmTimer.current);
    deleteBranchArmTimer.current = setTimeout(() => setDeleteBranchArmed(false), 4000);
  }, [deleteBranchArmed, onDeleteBranch]);

  const handleConfirmClosePr = useCallback(() => {
    if (!onClose) return;
    onClose();
    setCloseDialogOpen(false);
  }, [onClose]);

  useEffect(() => () => {
    if (deleteBranchArmTimer.current) clearTimeout(deleteBranchArmTimer.current);
  }, []);

  // Switching PRs disarms everything. A four-second arm that survives the switch
  // would leave "Click again to confirm" showing on a *different* PR's branch,
  // one click from deleting it.
  useEffect(() => {
    setCloseDialogOpen(false);
    setDeleteBranchArmed(false);
    if (deleteBranchArmTimer.current) clearTimeout(deleteBranchArmTimer.current);
  }, [pr.id]);

  // A merge that only becomes possible through an admin bypass is a different
  // act from a clean merge, so the button is toned differently — but the
  // enablement rule below is exactly the union it always was.
  const mergeAllowed = canAttemptMerge({ pr, status, bypassRules: false });
  const bypassOnly = !mergeAllowed && Boolean(status?.canBypass) && status?.mergeStateStatus === "blocked";
  const mergeEnabled = mergeAllowed || bypassOnly;
  const mergeTone = bypassOnly ? COLORS.danger : COLORS.success;
  // Draft counts as closeable: it is not a terminal state, and a draft that
  // turned out to be the wrong approach is exactly the PR you want to close.
  const showCloseAction = Boolean(onClose) && (pr.state === "open" || pr.state === "draft");
  const isMerged = pr.state === "merged";
  const isClosed = pr.state === "closed";
  const isTerminal = isMerged || isClosed;

  const handleRailClick = useCallback(() => {
    if (!onOpenManageLane || !pr.laneId) return;
    onOpenManageLane();
  }, [onOpenManageLane, pr.laneId]);

  const handleMethodChange = useCallback((method: MergeMethod) => {
    setDefaultMethod(method);
    writeLastMergeMethod(method);
  }, []);

  const handleDialogMerge = useCallback(
    (result: PrMergeDialogResult) => {
      writeLastMergeMethod(result.method);
      setDefaultMethod(result.method);
      onMerge(result.method, {
        bypassRules: result.bypassRules,
        commitTitle: result.commitTitle,
        commitBody: result.commitBody,
        expectedHeadSha: result.expectedHeadSha,
      });
      setDialogOpen(false);
    },
    [onMerge],
  );

  const showManageLane = Boolean(onOpenManageLane && pr.laneId);
  const showDeleteBranch = isMerged && Boolean(onDeleteBranch);

  if (isTerminal) {
    return (
      <div
        data-testid="pr-detail-merge-rail"
        className="overflow-hidden"
        style={RAIL_FRAME}
      >
        <div className="shrink-0">
          {isMerged ? (
            // Still flat inside the frame: no tinted card, no shadow. The merge
            // glyph and the branch pair carry the state, and a hairline separates
            // the record from the actions below.
            <div
              className="px-3 py-2.5"
              style={showManageLane || showDeleteBranch ? { borderBottom: RAIL_DIVIDER } : undefined}
              data-testid="pr-merge-merged-banner"
            >
              {/* Outcome: the strongest line, with how it merged kept quiet on the right. */}
              <div className="flex items-center gap-2">
                <GitMerge size={15} weight="fill" style={{ color: COLORS.accent, flexShrink: 0 }} />
                <span className="text-[11px] font-semibold leading-snug" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                  Merged and closed
                </span>
                {pr.mergeMethod ? (
                  <span className="ml-auto shrink-0 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}>
                    {pr.mergeMethod === "merge" ? "merge commit" : `${pr.mergeMethod} merge`}
                  </span>
                ) : null}
              </div>

              {/* Structure: which branch went where. */}
              <div className="mt-2 flex items-center gap-1.5">
                <BranchChip label={pr.headBranch} accent />
                <ArrowRight size={11} weight="bold" style={{ color: COLORS.textDim, flexShrink: 0 }} />
                <BranchChip label={pr.baseBranch} />
              </div>

              <PrShippedSummary pr={pr} />
            </div>
          ) : (
            <div
              className="px-3 py-2.5"
              style={showManageLane ? { borderBottom: RAIL_DIVIDER } : undefined}
            >
              <div
                className="flex items-center gap-2 text-[11px]"
                style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}
              >
                <XCircle size={14} style={{ flexShrink: 0 }} />
                <span>This pull request is closed.</span>
              </div>
              {onReopen ? (
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={onReopen}
                  className="mt-2"
                  style={prFlatButton({
                    tone: COLORS.success,
                    width: "100%",
                    opacity: actionBusy ? 0.6 : 1,
                  })}
                >
                  Reopen pull request
                </button>
              ) : null}
            </div>
          )}

          {/* Omitted entirely when neither action applies, so the frame never
              closes on an empty strip. */}
          {showManageLane || showDeleteBranch ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              {showManageLane ? (
                <button
                  type="button"
                  onClick={handleRailClick}
                  style={prSectionAction({ fontWeight: 500 })}
                >
                  Manage lane
                </button>
              ) : (
                <span />
              )}
              {showDeleteBranch ? (
                <button
                  type="button"
                  disabled={deleteBranchBusy}
                  onClick={handleDeleteBranchClick}
                  style={prFlatButton({
                    // Armed state switches the whole control to the danger tone;
                    // the label ("Click again to confirm") says it too.
                    tone: deleteBranchArmed ? COLORS.danger : undefined,
                    opacity: deleteBranchBusy ? 0.6 : 1,
                  })}
                >
                  <Trash size={12} />
                  {deleteBranchBusy
                    ? "Deleting…"
                    : deleteBranchArmed
                      ? "Click again to confirm"
                      : "Delete branch"}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="pr-detail-merge-rail"
      className="flex flex-col overflow-hidden"
      style={RAIL_FRAME}
    >
      <div className="overflow-y-auto">
        <PrMergeChecklist
          pr={pr}
          status={status}
          checks={checks}
          reviews={reviews}
          onUpdateBranch={onUpdateBranch}
          updateBranchBusy={updateBranchBusy}
          updateBranchNotice={updateBranchNotice}
        />

        {/* Merge takes the row; close is the narrow 30% escape hatch beside it. */}
        <div className="flex items-stretch gap-2 px-3 pb-3">
          {/* The only filled control on the pane. Green for a clean merge, red
              when the only way through is an admin bypass; disabled falls back
              to a recessed outline that still reads as a button. */}
          <button
            type="button"
            disabled={!mergeEnabled || actionBusy}
            onClick={() => setDialogOpen(true)}
            style={prSolidButton({
              tone: mergeTone,
              flex: 7,
              opacity: actionBusy ? 0.6 : 1,
              ...(mergeEnabled
                ? {}
                : {
                  color: COLORS.textMuted,
                  background: COLORS.recessedBg,
                  border: `1px solid ${COLORS.border}`,
                  cursor: "default",
                }),
            })}
            data-testid="pr-merge-open-dialog-button"
          >
            <GitMerge size={12} weight="bold" />
            {actionBusy ? "Merging…" : "Merge…"}
          </button>

          {showCloseAction ? (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => setCloseDialogOpen(true)}
              title="Close pull request"
              style={prFlatButton({
                tone: COLORS.danger,
                flex: 3,
                height: 30,
                padding: "0 8px",
                opacity: actionBusy ? 0.6 : 1,
              })}
              data-testid="pr-close-open-dialog-button"
            >
              <XCircle size={12} />
              Close
            </button>
          ) : null}
        </div>
      </div>

      <PrMergeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        pr={pr}
        status={status}
        commits={commits}
        defaultMethod={defaultMethod}
        actionBusy={actionBusy}
        onMerge={handleDialogMerge}
        onMethodChange={handleMethodChange}
      />

      <LaneDialogShell
        open={closeDialogOpen}
        onOpenChange={setCloseDialogOpen}
        title={`Close pull request #${pr.githubPrNumber}`}
        icon={XCircle}
        busy={actionBusy}
        widthClassName="w-[min(460px,calc(100vw-2rem))]"
      >
        <div
          className="text-[12px] leading-relaxed"
          style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }}
        >
          Closes <span style={{ color: COLORS.textPrimary }}>{pr.title}</span> on GitHub. The branch{" "}
          <span className="font-mono">{pr.headBranch}</span> is kept, and you can reopen the pull request later.
        </div>

        <div className="mt-4 flex items-center justify-end gap-2 border-t pt-4" style={{ borderColor: COLORS.border }}>
          <button
            type="button"
            onClick={() => setCloseDialogOpen(false)}
            disabled={actionBusy}
            style={prFlatButton({
              color: COLORS.textSecondary,
              height: 30,
              opacity: actionBusy ? 0.6 : 1,
            })}
          >
            Cancel
          </button>
          {/* The dialog is its own surface with its own single decisive action,
              so the solid fill belongs to this button while it is open. */}
          <button
            type="button"
            onClick={handleConfirmClosePr}
            disabled={actionBusy}
            data-testid="pr-close-confirm-button"
            style={prSolidButton({
              tone: COLORS.danger,
              opacity: actionBusy ? 0.6 : 1,
            })}
          >
            <XCircle size={12} weight="bold" />
            Close pull request
          </button>
        </div>
      </LaneDialogShell>
    </div>
  );
});

export default PrDetailMergeRail;
