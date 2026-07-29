import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowClockwise, CaretDown, CaretRight, CircleNotch, Desktop, DesktopTower, Funnel, MagnifyingGlass, Moon, Plus, PushPin, Square, Terminal, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import type { LaneSummary, OpenProjectBinding, PrSummary, TerminalSessionSummary } from "../../../shared/types";
import { selectPrimaryLanePr, lanePrStateColor, lanePrStateLabel } from "../../lib/lanePrBadge";
import { useLanePrsByLaneId } from "./useLanePrs";
import {
  canonicalInputFromSummary,
  sessionFilingBucket,
  sessionNeedsYou,
  sessionStatusBucket,
} from "../../lib/terminalAttention";
import { useAppStore } from "../../state/appStore";
import {
  useCrossMachineLaneUnion,
  type CrossMachineLaneMarker,
  type CrossMachineLaneRow,
} from "../../state/crossMachineLanes";
import { SessionCard } from "./SessionCard";
import { ToolLogo } from "./ToolLogos";
import { LaneCombobox } from "./LaneCombobox";
import { CreateLaneDialogHost } from "../lanes/CreateLaneDialogHost";
import {
  orderWorkLanes,
  workLaneTier,
  WORK_LANE_SORT_MODES,
  type WorkLaneSortMode,
} from "./workLaneOrder";
import { useWorkLaneReorder } from "./useWorkLaneReorder";
import {
  EMPTY_WORK_SESSION_FILTERS,
  WORK_STATUS_FILTERS,
  WORK_TOOL_FAMILIES,
  activeWorkSessionFilterLabels,
  isWorkSessionFilterEmpty,
  matchesWorkSessionFilters,
  workStatusFilterLabel,
  workToolFamily,
  workToolFamilyLabel,
  type WorkSessionFilters,
  type WorkToolFamily,
} from "./workSessionFilters";
import type { WorkDraftKind, WorkGridSet, WorkSessionListOrganization } from "../../state/appStore";
import { findGridSetForSession } from "../../lib/workGrid";
import { iconGlyph } from "../graph/graphHelpers";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import { branchNameFromRef } from "../prs/shared/laneBranchTargets";
import { laneSurfaceTint } from "../lanes/laneDesignTokens";
import { canBulkDeleteSession, canBulkStopSession, isChatToolType, primarySessionLabel } from "../../lib/sessions";
import { useWorkLaneContextMenu } from "./useWorkLaneContextMenu";
import { relativeTimeCompact } from "../../lib/format";
import { getLaneDeleteStatusLabel } from "../../lib/laneDeleteProgress";
import {
  handoffJobLikelyMaterialized,
  handoffLaunchMatchesQuery,
  handoffLaunchStatusMessage,
  handoffLaunchTitle,
  type HandoffLaunchJob,
} from "../../lib/handoffLaunchJobs";


const EMPTY_GRID_SETS: WorkGridSet[] = [];
const EMPTY_SESSIONS: TerminalSessionSummary[] = [];
const EMPTY_LANE_IDS: string[] = [];
const WORK_LANE_SORT_LABELS: Record<WorkLaneSortMode, string> = {
  activity: "Recent",
  name: "Name",
  created: "New",
  manual: "Manual",
};
const EMPTY_FOREIGN_ROWS: CrossMachineLaneRow[] = [];
const FILTER_OPTION_GRID_CLASS = "grid min-w-0 flex-1 gap-0.5 [grid-template-columns:repeat(auto-fit,minmax(2.4rem,1fr))]";
const FILTER_OPTION_BUTTON_CLASS = "ade-chat-drawer-row min-w-0 truncate rounded-md px-1.5 py-1 text-center text-[10px] font-medium";

function bucketByTime(sessions: TerminalSessionSummary[]) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const today: TerminalSessionSummary[] = [];
  const yesterday: TerminalSessionSummary[] = [];
  const older: TerminalSessionSummary[] = [];
  const sorted = [...sessions].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  for (const s of sorted) {
    const t = new Date(s.startedAt).getTime();
    if (t >= todayStart) today.push(s);
    else if (t >= yesterdayStart) yesterday.push(s);
    else older.push(s);
  }
  return { today, yesterday, older };
}

function bucketHandoffJobsByTime(jobs: HandoffLaunchJob[]) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const today: HandoffLaunchJob[] = [];
  const yesterday: HandoffLaunchJob[] = [];
  const older: HandoffLaunchJob[] = [];
  const sorted = [...jobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  for (const job of sorted) {
    if (job.createdAtMs >= todayStart) today.push(job);
    else if (job.createdAtMs >= yesterdayStart) yesterday.push(job);
    else older.push(job);
  }
  return { today, yesterday, older };
}

function partitionQuietSessions(sessions: readonly TerminalSessionSummary[]): {
  active: TerminalSessionSummary[];
  snoozed: TerminalSessionSummary[];
  settled: TerminalSessionSummary[];
} {
  const active: TerminalSessionSummary[] = [];
  const snoozed: TerminalSessionSummary[] = [];
  const settled: TerminalSessionSummary[] = [];
  const nowMs = Date.now();
  for (const session of sessions) {
    const bucket = sessionFilingBucket(session, nowMs);
    if (bucket === "snoozed") {
      snoozed.push(session);
    } else if (bucket === "settled") {
      settled.push(session);
    } else {
      active.push(session);
    }
  }
  return { active, snoozed, settled };
}

function HandoffSessionPlaceholderCard({ job }: { job: HandoffLaunchJob }) {
  const title = handoffLaunchTitle(job);
  const status = handoffLaunchStatusMessage(job.status);
  return (
    <motion.div
      key={job.id}
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="group relative"
      data-testid="handoff-launch-placeholder"
    >
      <div
        className="relative w-full overflow-hidden rounded-lg text-left"
        style={{
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.035)",
        }}
        aria-label={`${title}: ${status}`}
      >
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          animate={{ opacity: [0.2, 0.42, 0.2] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          style={{
            background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)",
          }}
        />
        <div className="relative flex items-stretch gap-2.5 px-2.5 py-2">
          <div className="flex shrink-0 self-stretch items-center justify-center">
            <ToolLogo toolType={job.targetToolType} size={26} className="opacity-90" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg/90" title={title}>
                {title}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <CircleNotch size={11} className="animate-spin text-muted-fg/55" />
                <span className="shrink-0 text-[10px] tabular-nums text-muted-fg/45">
                  {relativeTimeCompact(new Date(job.createdAtMs).toISOString())}
                </span>
              </div>
            </div>
            <div className="mt-0.5 min-w-0">
              <span className="block truncate text-[10px] leading-snug text-muted-fg/55">
                {status}
              </span>
            </div>
            <div className="mt-0.5 min-w-0">
              <span className="block truncate text-[10px] leading-snug text-muted-fg/40">
                First message: Chat handoff from previous session
              </span>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function QuietLaneGroupHeader({
  sectionId,
  icon,
  label,
  count,
  collapsed,
  onToggleCollapsed,
  onContextMenu,
  laneHeaderTitle,
  prBadge,
  machineMarker,
  busyLabel,
  quietCounts,
  stickyClass,
  dragProps,
}: {
  sectionId: string;
  icon: React.ReactNode;
  label: string;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void;
  laneHeaderTitle: string;
  prBadge: React.ReactNode;
  machineMarker: React.ReactNode;
  busyLabel: string | null;
  quietCounts: { snoozed: number; settled: number };
  /** `sticky top-0`, or `relative` while the row is mid-sink (see StickyGroupHeader). */
  stickyClass: string;
  /** Quiet lanes stay draggable and droppable — they are still lanes. */
  dragProps: React.HTMLAttributes<HTMLDivElement> | null;
}) {
  return (
    <div
      className={cn(
        "ade-lane-group-header z-10 flex h-6 w-full items-center gap-1.5 rounded-md px-2 transition-colors select-none",
        stickyClass,
        "hover:bg-white/[0.04]",
        busyLabel && "opacity-70",
      )}
      style={{ border: "1px solid rgba(255, 255, 255, 0.05)" }}
      data-section-id={sectionId}
      data-lane-quiet="true"
      aria-busy={busyLabel ? "true" : undefined}
      onContextMenu={onContextMenu}
      {...(busyLabel ? {} : dragProps ?? {})}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden text-left"
        onClick={onToggleCollapsed}
        disabled={Boolean(busyLabel)}
        aria-expanded={!collapsed}
        aria-label={`${label} (${count} quiet)`}
      >
        <CaretRight size={10} className="shrink-0 text-muted-fg/25" />
        {icon}
        <span
          className="ade-lane-group-header-lane ade-lane-branch-inline-lane min-w-0 flex-1 shrink truncate text-[11px] font-medium leading-tight text-fg/55"
          title={laneHeaderTitle}
        >
          {label}
        </span>
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {machineMarker}
        {prBadge}
        {quietCounts.snoozed > 0 ? (
          <span
            className="flex items-center gap-0.5 text-[9px] font-medium tabular-nums text-muted-fg/40"
            title={`${quietCounts.snoozed} snoozed`}
          >
            <Moon size={9} weight="fill" aria-hidden />
            {quietCounts.snoozed}
          </span>
        ) : null}
        {quietCounts.settled > 0 ? (
          <span
            className="flex items-center gap-0.5 text-[9px] font-medium tabular-nums text-muted-fg/40"
            title={`${quietCounts.settled} settled`}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full border bg-transparent"
              style={{ borderColor: "rgba(255,255,255,0.3)" }}
              aria-hidden
            />
            {quietCounts.settled}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function StickyGroupHeader({
  sectionId,
  icon,
  label,
  count,
  collapsed,
  onToggleCollapsed,
  onContextMenu,
  accentColor,
  children,
  subLabel,
  prBadge = null,
  machineMarker = null,
  headerAction = null,
  variant = "default",
  busyLabel = null,
  heading = false,
  dimmed = false,
  quietCounts = null,
  pinned = false,
  dragProps = null,
  dropIndicatorEdge = null,
  layoutDependency,
}: {
  sectionId: string;
  icon: React.ReactNode;
  label: string;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void;
  accentColor?: string | null;
  children: React.ReactNode;
  /**
   * Expose the row as a real section heading with an explicit "<label> (<count>)"
   * accessible name, so a screen reader can navigate to the group rather than
   * inferring it from a bare toggle button.
   */
  heading?: boolean;
  /** Branch label shown on the right for `variant="lane"` (e.g. from `branchNameFromRef`). */
  subLabel?: string | null;
  /** Compact PR badge shown left of the count for `variant="lane"`. */
  prBadge?: React.ReactNode;
  /**
   * Cross-machine marker for `variant="lane"`. Present only when the lane is NOT
   * on this machine, so local-only setups never render one.
   */
  machineMarker?: React.ReactNode;
  /** Dims the whole group — used for lanes on a machine that has gone offline. */
  dimmed?: boolean;
  /** Compact action shown next to the count for non-lane headers. */
  headerAction?: React.ReactNode;
  /** `lane` uses a larger header and pads the nested session list. */
  variant?: "default" | "lane";
  /** Disables the lane group and overlays lifecycle progress. */
  busyLabel?: string | null;
  /** Quiet-lane mode plus inline `☾n ○n` counts replacing the total pill. */
  quietCounts?: { snoozed: number; settled: number } | null;
  /**
   * Pinned lanes sort to the top AND opt out of the quiet treatment entirely —
   * a 24px dimmed row above a stack of 32px bright ones reads as broken, so a
   * pin keeps the full-height header and adds a glyph instead.
   */
  pinned?: boolean;
  /** Native drag wiring for manual reorder; null disables dragging this row. */
  dragProps?: React.HTMLAttributes<HTMLDivElement> | null;
  /** Which side of this lane a pending drop would land on. */
  dropIndicatorEdge?: "before" | "after" | null;
  /**
   * Order signature. `layout` re-measures on every render and this list
   * re-renders on every session tick, so measurement is pinned to actual order
   * changes. When undefined, the row does not animate at all.
   */
  layoutDependency?: string;
}) {
  // Toggled off for the duration of a sink: a `position: sticky` element inside
  // a transformed ancestor sticks to the transformed box, so the header visibly
  // detaches from the top of the list mid-slide.
  const [sliding, setSliding] = useState(false);
  if (count === 0) return null;
  const isLane = variant === "lane";
  const isQuietLane = isLane && quietCounts != null && !pinned;
  const stickyClass = sliding ? "relative" : "sticky top-0";
  const branchText = subLabel?.trim() ?? "";
  // The lane header no longer renders the branch. The lane name is already
  // derived from the branch (CreateLaneDialog seeds one from the other), so
  // showing both spent a whole column on a duplicate — and, worse, put two
  // flexible text nodes in one row competing for width, which is what pushed the
  // PR badge off the edge. Non-lane group headers keep their sub-label.
  const showBranchCluster = !isLane && branchText.length > 0;
  const laneHeaderTitle = branchText ? `${label} · ${branchText}` : label;
  const laneTint = laneSurfaceTint(accentColor, isLane ? "pastel" : "soft");
  const laneLabelColor = isLane && laneTint.text ? laneTint.text : accentColor ?? undefined;
  return (
    // One rhythm: the gap between groups belongs to the list container, not to
    // per-variant margins here. Mixing `space-y-1` with `mb-1.5` / `mb-px` gave
    // active lanes a 10px gap and quiet ones 5px, which is what made the column
    // read as broken wherever the two met.
    <motion.div
      // A lane that goes quiet sinks immediately; `layout="position"` makes it
      // slide there. NOT full `layout` — size correction fights the collapse
      // body's height animation below and squashes the row.
      layout={layoutDependency ? "position" : false}
      layoutDependency={layoutDependency}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      onLayoutAnimationStart={() => setSliding(true)}
      onLayoutAnimationComplete={() => setSliding(false)}
      className={cn("relative", !isLane && "mt-0.5 first:mt-0", dimmed && "opacity-55")}
    >
      {dropIndicatorEdge ? (
        <div
          aria-hidden
          data-testid={`lane-drop-indicator-${dropIndicatorEdge}`}
          // `pointer-events-none` is load-bearing: an indicator that swallows
          // dragover makes the drop target flicker between neighbours.
          className="pointer-events-none absolute inset-x-0 z-20 h-0.5 rounded-full"
          style={{
            background: "var(--color-accent)",
            ...(dropIndicatorEdge === "before" ? { top: -3 } : { bottom: -3 }),
          }}
        />
      ) : null}
      {isQuietLane ? (
        <QuietLaneGroupHeader
          sectionId={sectionId}
          icon={icon}
          label={label}
          count={count}
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
          onContextMenu={onContextMenu}
          laneHeaderTitle={laneHeaderTitle}
          prBadge={prBadge}
          machineMarker={machineMarker}
          busyLabel={busyLabel}
          quietCounts={quietCounts}
          stickyClass={stickyClass}
          dragProps={dragProps}
        />
      ) : isLane ? (
        // The lane header is a flex row, NOT one big <button>: the PR badge is
        // itself interactive, and nesting interactive elements inside a native
        // button is invalid HTML (breaks focus order / assistive tech). The
        // collapse toggle button spans everything left of the badge cluster.
        <div
          className={cn(
            "ade-lane-group-header z-10 flex h-8 w-full items-center gap-1.5 rounded-lg px-3 transition-colors backdrop-blur-xl select-none",
            stickyClass,
            laneTint.text ? "hover:brightness-[1.03]" : "hover:bg-white/[0.04]",
            busyLabel && "opacity-70",
          )}
          style={{
            background: laneTint.background,
            border: laneTint.border ?? "1px solid rgba(255, 255, 255, 0.08)",
            boxShadow: "0 1px 6px -2px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
          }}
          data-section-id={sectionId}
          aria-busy={busyLabel ? "true" : undefined}
          onContextMenu={onContextMenu}
          // Drag lives on the header, NOT the wrapper: the wrapper is an
          // ancestor of every SessionCard, which is itself draggable for the
          // work-grid drop. The header is a sibling of the collapse body, so the
          // two drag sources never nest.
          {...(busyLabel ? {} : dragProps ?? {})}
        >
          <button
            type="button"
            // `overflow-hidden` is load-bearing: without it, unshrinkable
            // children spill past the button's box and render on top of the
            // trailing PR badge / count cluster, which the sidebar then clips.
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden text-left"
            onClick={onToggleCollapsed}
            disabled={Boolean(busyLabel)}
          >
            {collapsed ? (
              <CaretRight size={12} className="shrink-0 text-muted-fg/35" />
            ) : (
              <CaretDown size={12} className="shrink-0 text-muted-fg/35" />
            )}
            {icon}
            <span
              className="ade-lane-group-header-lane ade-lane-branch-inline-lane min-w-0 flex-1 shrink truncate text-[13px] font-semibold leading-tight text-fg/90"
              style={laneLabelColor ? { color: laneLabelColor } : undefined}
              title={laneHeaderTitle}
            >
              {label}
            </span>
            {/* Branch sits immediately right of the lane name and expands to fill
                whatever space is free, truncating only when it runs out. */}
            {showBranchCluster ? (
              <div
                className="ade-lane-group-header-branch ade-lane-branch-inline-branch flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
                style={{ color: "var(--color-muted-fg)" }}
              >
                <BranchIcon size={10} weight="regular" className="shrink-0 opacity-55" />
                <span className="min-w-0 truncate text-[10px] font-medium leading-tight text-muted-fg/70" title={branchText}>
                  {branchText}
                </span>
              </div>
            ) : null}
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {pinned ? (
              <PushPin
                size={11}
                weight="fill"
                aria-label="Pinned lane"
                className="shrink-0 text-muted-fg/45"
              />
            ) : null}
            {machineMarker}
            {prBadge}
            <span className="rounded-full bg-white/[0.08] px-1.5 py-px text-[10px] font-semibold tabular-nums text-muted-fg/60">
              {count}
            </span>
          </div>
          {busyLabel ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 rounded-lg bg-bg/75 text-[10px] font-semibold uppercase tracking-wide text-muted-fg backdrop-blur-[1px]">
              <CircleNotch size={12} className="animate-spin" />
              {busyLabel}
            </div>
          ) : null}
        </div>
      ) : (
        <div
          className={cn(
            // Status/time section labels adopt the quiet-lane height: they are
            // labels, not lanes, so they must not introduce a third row height.
            "ade-lane-group-header z-10 flex h-6 w-full items-center gap-1.5 rounded-md px-2 text-left transition-colors backdrop-blur-xl select-none",
            stickyClass,
            laneTint.text ? "hover:brightness-[1.03]" : "hover:bg-white/[0.04]",
          )}
          style={{
            background: laneTint.background,
            borderBottom: "1px solid rgba(255, 255, 255, 0.04)",
          }}
          data-section-id={sectionId}
          onContextMenu={onContextMenu}
          {...(heading
            ? { role: "heading" as const, "aria-level": 3, "aria-label": `${label} (${count})` }
            : {})}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
            onClick={onToggleCollapsed}
            {...(heading
              ? { "aria-label": `${label} (${count})`, "aria-expanded": !collapsed }
              : {})}
          >
            {collapsed ? (
              <CaretRight size={10} className="shrink-0 text-muted-fg/30" />
            ) : (
              <CaretDown size={10} className="shrink-0 text-muted-fg/30" />
            )}
            {icon}
            <span
              className="min-w-0 flex-1 truncate text-[11px] font-semibold text-fg/90"
              style={accentColor ? { color: accentColor } : undefined}
            >
              {label}
            </span>
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {headerAction}
            <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-muted-fg/50">
              {count}
            </span>
          </div>
        </div>
      )}
      {/* Children slide out/retract smoothly; the header stays put (no reflow jump). */}
      <AnimatePresence initial={false}>
        {!collapsed && count > 0 ? (
          <motion.div
            key="lane-group-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div className={cn("flex flex-col gap-0.5", isLane && "mt-1 pl-2.5", busyLabel && "pointer-events-none opacity-50")}>
              {children}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * Compact PR status badge on a lane divider: state-colored dot + `#<number>` +
 * one-word state. Clicking deep-links into the PRs tab. Rendered inside the
 * header button, so it stops propagation to avoid also toggling the section.
 *
 * (`useLanePrsByLaneId` moved to ./useLanePrs so the Work session hook can
 * answer the "Has PR" chip filter from the same PR data this badge renders.)
 */
function LanePrHeaderBadge({ pr, onOpen }: { pr: PrSummary; onOpen: () => void }) {
  const color = lanePrStateColor(pr.state);
  const label = lanePrStateLabel(pr.state);
  const open = (event: React.SyntheticEvent) => {
    event.stopPropagation();
    onOpen();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open(event);
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-px text-[10px] font-medium leading-none text-muted-fg/70 transition-colors hover:bg-white/[0.09]"
      title={`Pull request #${pr.githubPrNumber} · ${label}`}
      aria-label={`Pull request #${pr.githubPrNumber}, ${label}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="tabular-nums">#{pr.githubPrNumber}</span>
      <span style={{ color }}>{label}</span>
    </span>
  );
}

/**
 * Adaptive machine marker on a lane header.
 *
 * Rendered ONLY for lanes that are not on the machine you're sitting at — the
 * common single-machine case pays nothing. Default form is a bare monochrome
 * glyph; the name is promoted into the row when a glyph alone would be
 * ambiguous (machine offline, two or more foreign machines on screen, or the
 * branch also exists elsewhere). The lane accent owns the color channel, so this
 * stays monochrome: a tint here would read as a second lane color.
 */
function LaneMachineMarker({ marker }: { marker: CrossMachineLaneMarker }) {
  const description = marker.online
    ? "This lane lives on another connected machine."
    : "This lane is retained here while its machine is offline.";
  return (
    <SmartTooltip
      forceEnabled
      content={{
        label: marker.machineName,
        description,
      }}
    >
      <span
        role="img"
        tabIndex={0}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/20 bg-amber-400/[0.06] px-1.5 py-px text-[10px] font-medium leading-none",
          marker.online ? "text-muted-fg/70" : "text-muted-fg/45",
        )}
        aria-label={`${marker.machineName}${marker.online ? "" : ", offline"}`}
        data-machine-id={marker.machineId}
        data-machine-marker-mode={marker.mode}
      >
        <DesktopTower size={10} weight="duotone" className="shrink-0 text-amber-400/85" />
        {marker.mode === "name" ? <span className="max-w-24 truncate">{marker.machineName}</span> : null}
      </span>
    </SmartTooltip>
  );
}

export const SessionListPane = React.memo(function SessionListPane({
  lanes,
  runningFiltered,
  awaitingInputFiltered,
  endedFiltered,
  settledFiltered,
  snoozedFiltered = EMPTY_SESSIONS,
  allSessionsUnfiltered,
  loading: _loading,
  filterLaneId,
  setFilterLaneId,
  q,
  setQ,
  selectedSessionId,
  selectedSessionIds,
  draftKind: _draftKind,
  showingDraft: _showingDraft,
  onShowDraftKind,
  onSelectSession,
  onSelectForeignRuntimeSession,
  onClearSelection,
  onBulkClose,
  onBulkDelete,
  onBulkStopAndDelete,
  onRefreshOrphanSessions,
  onContextMenu,
  sessionListOrganization,
  setSessionListOrganization,
  workCollapsedLaneIds,
  toggleWorkLaneCollapsed,
  workCollapsedSectionIds,
  toggleWorkSectionCollapsed,
  sessionsGroupedByLane,
  workSessionFilters = EMPTY_WORK_SESSION_FILTERS,
  setWorkSessionFilters,
  workPinnedLaneIds = EMPTY_LANE_IDS,
  toggleWorkLanePinned,
  workLaneSortMode = "created",
  setWorkLaneSortMode,
  workLaneOrder = EMPTY_LANE_IDS,
  reorderWorkLanes,
  gridSets = EMPTY_GRID_SETS,
  activeItemId = null,
  handoffJobs = [],
  crossMachineSyncActive = true,
}: {
  lanes: LaneSummary[];
  runningFiltered: TerminalSessionSummary[];
  awaitingInputFiltered: TerminalSessionSummary[];
  endedFiltered: TerminalSessionSummary[];
  settledFiltered: TerminalSessionSummary[];
  /**
   * Rows currently under a snooze, already pulled out of every other partition
   * by `useWorkSessions` (snooze is a visibility overlay, not a status).
   */
  snoozedFiltered?: TerminalSessionSummary[];
  /** All sessions before the search/lane filter — the live-children badge counts
   * from this so a filtered-out running child doesn't undercount its parent. */
  allSessionsUnfiltered: TerminalSessionSummary[];
  loading: boolean;
  filterLaneId: string;
  setFilterLaneId: (v: string) => void;
  q: string;
  setQ: (v: string) => void;
  selectedSessionId: string | null;
  selectedSessionIds?: Set<string>;
  gridSets?: WorkGridSet[];
  activeItemId?: string | null;
  draftKind: WorkDraftKind;
  showingDraft: boolean;
  onShowDraftKind: (kind: WorkDraftKind) => void;
  onSelectSession: (
    id: string,
    event: React.MouseEvent,
    visibleSessionIds: string[],
    binding?: OpenProjectBinding | null,
  ) => void;
  onSelectForeignRuntimeSession?: (
    session: TerminalSessionSummary,
    binding: OpenProjectBinding,
    event: React.MouseEvent,
    visibleSessionIds: string[],
  ) => void;
  onClearSelection?: () => void;
  onBulkClose?: () => void;
  onBulkDelete?: () => void;
  onBulkStopAndDelete?: () => void;
  onRefreshOrphanSessions?: () => void;
  onContextMenu: (
    session: TerminalSessionSummary,
    e: React.MouseEvent,
    binding?: OpenProjectBinding | null,
    machineName?: string | null,
  ) => void;
  sessionListOrganization: WorkSessionListOrganization;
  setSessionListOrganization: (v: WorkSessionListOrganization) => void;
  workCollapsedLaneIds: string[];
  toggleWorkLaneCollapsed: (laneId: string) => void;
  workCollapsedSectionIds: string[];
  toggleWorkSectionCollapsed: (
    sectionId: string,
    options?: { preserveDeeplink?: boolean },
  ) => void;
  sessionsGroupedByLane: Map<string, TerminalSessionSummary[]> | null;
  /** Funnel-panel chip selections. OR within an axis, AND across axes. */
  workSessionFilters?: WorkSessionFilters;
  setWorkSessionFilters?: (
    next: WorkSessionFilters | ((prev: WorkSessionFilters) => WorkSessionFilters),
  ) => void;
  /** Lanes pinned to the top of the Work sidebar (not the Lanes tab's pins). */
  workPinnedLaneIds?: string[];
  toggleWorkLanePinned?: (laneId: string) => void;
  workLaneSortMode?: WorkLaneSortMode;
  setWorkLaneSortMode?: (mode: WorkLaneSortMode) => void;
  workLaneOrder?: string[];
  reorderWorkLanes?: (args: {
    movedLaneId: string;
    targetLaneId: string;
    edge: "before" | "after";
    renderedLaneIds: readonly string[];
  }) => void;
  handoffJobs?: HandoffLaunchJob[];
  crossMachineSyncActive?: boolean;
}) {
  const navigate = useNavigate();
  const prsByLaneId = useLanePrsByLaneId();
  const deleteProgressByLaneId = useAppStore((state) => state.laneDeleteProgressByLaneId);
  // The Work sidebar is a union across every connected machine, always —
  // independent of which machine this tab is bound to. That is the whole point:
  // you see work in flight anywhere without switching tabs.
  const { foreignRows, markersByLaneId } = useCrossMachineLaneUnion(crossMachineSyncActive);
  const [createLaneOpen, setCreateLaneOpen] = useState(false);
  const [settleUndo, setSettleUndo] = useState<{ ids: string[]; count: number } | null>(null);
  const {
    trigger: triggerLaneContextMenu,
    triggerForeign: triggerForeignLaneContextMenu,
    menu: laneContextMenuPortal,
  } = useWorkLaneContextMenu({
    onToggleWorkPin: toggleWorkLanePinned,
    workPinnedLaneIds,
  });

  const isByLane = sessionListOrganization === "by-lane";
  const isByTime = sessionListOrganization === "by-time";
  const normalizedFilterLaneId = filterLaneId.trim();
  const laneFilterActive = normalizedFilterLaneId.length > 0 && normalizedFilterLaneId !== "all";
  const chipFiltersActive = !isWorkSessionFilterEmpty(workSessionFilters);
  const [filterOpen, setFilterOpen] = useState(false);

  /** Toggle one value inside an OR-ed chip axis. */
  const toggleStatusFilter = useCallback((value: WorkSessionFilters["status"][number]) => {
    setWorkSessionFilters?.((prev) => {
      const status = prev.status.includes(value)
        ? prev.status.filter((entry) => entry !== value)
        : [...prev.status, value];
      return { ...prev, status };
    });
  }, [setWorkSessionFilters]);
  const toggleToolFilter = useCallback((value: WorkSessionFilters["tool"][number]) => {
    setWorkSessionFilters?.((prev) => {
      const tool = prev.tool.includes(value)
        ? prev.tool.filter((entry) => entry !== value)
        : [...prev.tool, value];
      return { ...prev, tool };
    });
  }, [setWorkSessionFilters]);
  const filteredHandoffJobs = useMemo(() => {
    const filtered = handoffJobs.filter((job) => {
      // Once the real session this job is creating is visible in the list, the
      // placeholder must go — otherwise a handoff briefly reads as two new
      // sessions with one vanishing when the RPC settles (ADE-122).
      if (allSessionsUnfiltered.some((session) => handoffJobLikelyMaterialized(job, session))) {
        return false;
      }
      if (laneFilterActive && job.laneId !== normalizedFilterLaneId) return false;
      if (!handoffLaunchMatchesQuery(job, q)) return false;
      // A pending handoff is work in flight, so it belongs to the Running chip
      // and its target tool family. Apply lane-scoped chips too so placeholders
      // never escape a filter that hides the session they are about to become.
      if (workSessionFilters.status.length > 0 && !workSessionFilters.status.includes("running")) {
        return false;
      }
      if (
        workSessionFilters.tool.length > 0
        && !workSessionFilters.tool.includes(workToolFamily(job.targetToolType))
      ) return false;
      if (workSessionFilters.hasPr && (prsByLaneId.get(job.laneId)?.length ?? 0) === 0) return false;
      if (workSessionFilters.dirtyLane && !lanes.find((lane) => lane.id === job.laneId)?.status.dirty) {
        return false;
      }
      return true;
    });
    return filtered.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [
    allSessionsUnfiltered,
    handoffJobs,
    laneFilterActive,
    lanes,
    normalizedFilterLaneId,
    prsByLaneId,
    q,
    workSessionFilters,
  ]);

  const visibleSettled = settledFiltered;
  const visibleSnoozed = snoozedFiltered;
  const hasAnySessions =
    runningFiltered.length + awaitingInputFiltered.length + endedFiltered.length
      + visibleSettled.length + visibleSnoozed.length + filteredHandoffJobs.length > 0;

  const allSessions = useMemo(
    () => [...runningFiltered, ...awaitingInputFiltered, ...endedFiltered, ...visibleSnoozed, ...visibleSettled],
    [runningFiltered, awaitingInputFiltered, endedFiltered, visibleSnoozed, visibleSettled],
  );
  // Settled rows live in their own quiet tier: excluded from lane folders' main
  // run and from time buckets, rendered in a per-group settled tail instead.
  const settledIdSet = useMemo(
    () => new Set(settledFiltered.map((session) => session.id)),
    [settledFiltered],
  );
  // Snoozed rows get the same treatment one tier above settled: out of the main
  // run, into their own group/tail, so a snooze actually removes noise.
  const snoozedIdSet = useMemo(
    () => new Set(snoozedFiltered.map((session) => session.id)),
    [snoozedFiltered],
  );
  const quietIdSet = useMemo(() => {
    if (snoozedIdSet.size === 0) return settledIdSet;
    return new Set([...settledIdSet, ...snoozedIdSet]);
  }, [settledIdSet, snoozedIdSet]);
  // Quietness is a property of the full lane roster, not the search/filter
  // subset. Otherwise a filtered-out needs-you row can disappear from this
  // check and let the lane fold into a thin quiet header.
  const unfilteredQuietIdSet = useMemo(() => {
    const nowMs = Date.now();
    const ids = new Set<string>();
    for (const session of allSessionsUnfiltered) {
      const bucket = sessionFilingBucket(session, nowMs);
      if (bucket === "snoozed" || bucket === "settled") {
        ids.add(session.id);
      }
    }
    return ids;
    // Snooze expiry changes `snoozedFiltered`, forcing this full-roster
    // classification to re-evaluate even when the session array is reused.
  }, [allSessionsUnfiltered, snoozedFiltered]);
  const unfilteredSessionsByLane = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary[]>();
    for (const session of allSessionsUnfiltered) {
      const list = map.get(session.laneId) ?? [];
      list.push(session);
      map.set(session.laneId, list);
    }
    return map;
  }, [allSessionsUnfiltered]);
  const visibleSessionIdSet = useMemo(
    () => new Set(allSessions.map((session) => session.id)),
    [allSessions],
  );
  // Build parent → children index. A child is a tracked terminal that records the
  // chat session id of its parent (e.g. App Control launches, in-chat terminal
  // drawer tabs). Children render indented under the parent when the parent is
  // also visible. If the parent is filtered out, the child still renders at the
  // top level so users do not lose access.
  const childrenByParentId = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary[]>();
    for (const session of allSessions) {
      const parentId = session.chatSessionId;
      if (!parentId || parentId === session.id) continue;
      if (!visibleSessionIdSet.has(parentId)) continue;
      const list = map.get(parentId) ?? [];
      list.push(session);
      map.set(parentId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    }
    return map;
  }, [allSessions, visibleSessionIdSet]);
  const excludedTopLevelIds = useMemo(() => {
    const set = new Set<string>();
    for (const list of childrenByParentId.values()) {
      for (const child of list) set.add(child.id);
    }
    return set;
  }, [childrenByParentId]);
  // Live-children badge: count, per spawner id, its still-running spawned chats.
  // Counts from the UNFILTERED session list (not `allSessions`, which is already
  // search/lane-filtered) so hiding a running child by filter does not undercount
  // its visible parent's badge. No extra fetch; clears as children go terminal.
  const liveChildrenByParentId = useMemo(() => {
    const map = new Map<string, number>();
    for (const session of allSessionsUnfiltered) {
      const parentId = session.orchestrationParentSessionId;
      if (!parentId || parentId === session.id) continue;
      if (session.status !== "running") continue;
      map.set(parentId, (map.get(parentId) ?? 0) + 1);
    }
    return map;
  }, [allSessionsUnfiltered]);
  // Parent-title lookup for the sidebar lineage glyph tooltip. Keyed off the
  // UNFILTERED list so a spawned child can still name its parent even when the
  // parent is hidden by the current search/lane filter.
  const sessionTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of allSessionsUnfiltered) {
      map.set(session.id, primarySessionLabel(session));
    }
    return map;
  }, [allSessionsUnfiltered]);
  const isChildSectionCollapsed = useCallback(
    (parentId: string) => workCollapsedSectionIds.includes(`chat:${parentId}`),
    [workCollapsedSectionIds],
  );
  const toggleChildSection = useCallback(
    (parentId: string) => toggleWorkSectionCollapsed(`chat:${parentId}`),
    [toggleWorkSectionCollapsed],
  );
  const timeBuckets = useMemo(
    () => bucketByTime(allSessions.filter((session) => !quietIdSet.has(session.id))),
    [allSessions, quietIdSet],
  );
  const handoffTimeBuckets = useMemo(() => bucketHandoffJobsByTime(filteredHandoffJobs), [filteredHandoffJobs]);
  const selectedCount = selectedSessionIds?.size ?? 0;
  const selectedSessions = useMemo(
    () => allSessions.filter((session) => selectedSessionIds?.has(session.id)),
    [allSessions, selectedSessionIds],
  );
  const selectedRunningCount = selectedSessions.filter(canBulkStopSession).length;
  const selectedDeletableCount = selectedSessions.filter(canBulkDeleteSession).length;
  // Bulk settle targets at-rest rows only — actively working sessions are not
  // "done" merely because they lack a settled marker.
  const selectedSettleableSessions = useMemo(
    () => selectedSessions.filter((session) =>
      !session.settledAt
      && sessionStatusBucket(canonicalInputFromSummary(session)) !== "running"
      && !sessionNeedsYou(canonicalInputFromSummary(session))),
    [selectedSessions],
  );
  const quietlyAwaitingSessions = useMemo(
    () => awaitingInputFiltered.filter(
      (session) => !sessionNeedsYou(canonicalInputFromSummary(session)),
    ),
    [awaitingInputFiltered],
  );
  const selectedSettleCount = selectedSettleableSessions.length;
  const settleSessions = useCallback(async (sessionIds: string[]) => {
    try {
      const newlySettled = await window.ade.sessions.settleMany(sessionIds);
      if (newlySettled.length > 0) {
        setSettleUndo({ ids: newlySettled, count: newlySettled.length });
      }
    } catch (error) {
      console.error("[SessionListPane] bulk settle failed", { sessionIds, error });
    }
  }, []);
  const undoSettle = useCallback(async () => {
    const ids = settleUndo?.ids ?? [];
    if (!ids.length) return;
    setSettleUndo(null);
    try {
      await window.ade.sessions.unsettleMany(ids);
    } catch (error) {
      console.error("[SessionListPane] undo settle failed", { sessionIds: ids, error });
    }
  }, [settleUndo]);
  useEffect(() => {
    if (!settleUndo) return;
    const timeout = window.setTimeout(() => setSettleUndo(null), 8_000);
    return () => window.clearTimeout(timeout);
  }, [settleUndo]);
  const laneById = useMemo(() => {
    const map = new Map<string, LaneSummary>();
    for (const lane of lanes) map.set(lane.id, lane);
    return map;
  }, [lanes]);
  const handoffJobsByLaneId = useMemo(() => {
    const map = new Map<string, HandoffLaunchJob[]>();
    for (const job of filteredHandoffJobs) {
      const list = map.get(job.laneId) ?? [];
      list.push(job);
      map.set(job.laneId, list);
    }
    return map;
  }, [filteredHandoffJobs]);
  const unfilteredHandoffCountByLaneId = useMemo(() => {
    const map = new Map<string, number>();
    for (const job of handoffJobs) {
      if (allSessionsUnfiltered.some((session) => handoffJobLikelyMaterialized(job, session))) continue;
      map.set(job.laneId, (map.get(job.laneId) ?? 0) + 1);
    }
    return map;
  }, [allSessionsUnfiltered, handoffJobs]);

  /**
   * A lane whose every session is snoozed or settled. `sessionFilingBucket`
   * already yields to `needs_you`, so a lane can never read as quiet while
   * something in it is waiting on the user.
   *
   * Deliberately computed from the UNFILTERED roster: quietness describes the
   * lane, not the current search/chip view, or a filtered-out needs-you row
   * would let a busy lane collapse into a thin quiet header.
   */
  const isLaneQuiet = useCallback((laneId: string) => {
    const fullList = unfilteredSessionsByLane.get(laneId) ?? [];
    return fullList.length > 0
    && (unfilteredHandoffCountByLaneId.get(laneId) ?? 0) === 0
    && fullList.every((session) => unfilteredQuietIdSet.has(session.id));
  }, [unfilteredHandoffCountByLaneId, unfilteredQuietIdSet, unfilteredSessionsByLane]);

  const workPinnedLaneIdSet = useMemo(
    () => new Set(workPinnedLaneIds),
    [workPinnedLaneIds],
  );

  /**
   * Render order for the by-lane list: primary first, then pinned → active →
   * quiet, with the chosen sort mode applied inside each tier.
   *
   * This is also the order the visible-id walk below uses, so shift-range
   * selection follows what is actually on screen.
   */
  const orderedLanes = useMemo(() => {
    const lastActivityMsForLane = (laneId: string): number | null => {
      let latest: number | null = null;
      for (const session of unfilteredSessionsByLane.get(laneId) ?? []) {
        const stamp = Date.parse(session.lastActivityAt ?? session.startedAt);
        if (Number.isNaN(stamp)) continue;
        if (latest === null || stamp > latest) latest = stamp;
      }
      return latest;
    };
    const ordered = orderWorkLanes(
      lanes.map((lane) => ({
        id: lane.id,
        name: lane.name,
        laneType: lane.laneType,
        createdAt: lane.createdAt,
        lastActivityMs: lastActivityMsForLane(lane.id),
        quiet: isLaneQuiet(lane.id),
        pinned: workPinnedLaneIdSet.has(lane.id),
        lane,
      })),
      workLaneSortMode,
      workLaneOrder,
    );
    return ordered.map((entry) => entry.lane);
  }, [isLaneQuiet, lanes, unfilteredSessionsByLane, workLaneOrder, workLaneSortMode, workPinnedLaneIdSet]);

  const renderedLaneIds = useMemo(() => orderedLanes.map((lane) => lane.id), [orderedLanes]);
  // Cheap order signature for the sink animation: without it `layout` would
  // re-measure every lane on every session tick, and this list ticks constantly.
  const laneOrderSignature = useMemo(() => renderedLaneIds.join(","), [renderedLaneIds]);
  const canStartLaneDrag = useCallback(
    (laneId: string) => laneById.get(laneId)?.laneType !== "primary",
    [laneById],
  );
  const canDropLane = useCallback((movedLaneId: string, targetLaneId: string) => {
    const movedLane = laneById.get(movedLaneId);
    const targetLane = laneById.get(targetLaneId);
    if (!movedLane || !targetLane) return false;
    if (movedLane.laneType === "primary" || targetLane.laneType === "primary") return false;
    const tierFor = (lane: LaneSummary) => workLaneTier({
      pinned: workPinnedLaneIdSet.has(lane.id),
      quiet: isLaneQuiet(lane.id),
    });
    // Pins stay at the top and quiet lanes stay in their compact tail. Manual
    // order applies within those visible tiers, so every accepted drop moves.
    return tierFor(movedLane) === tierFor(targetLane);
  }, [isLaneQuiet, laneById, workPinnedLaneIdSet]);
  const { listScrollRef, laneDrop, laneDragProps } = useWorkLaneReorder(
    reorderWorkLanes,
    renderedLaneIds,
    canDropLane,
    canStartLaneDrag,
  );

  const missingLaneSessionGroups = useMemo(() => {
    if (!sessionsGroupedByLane) return [];
    const knownLaneIds = new Set(lanes.map((lane) => lane.id));
    const latestStartedAt = (sessions: TerminalSessionSummary[]): number => {
      const times = sessions
        .map((session) => new Date(session.startedAt).getTime())
        .filter(Number.isFinite);
      return times.length > 0 ? Math.max(...times) : -Infinity;
    };
    const orphanLabel = (name: string | null | undefined, fallback: string): string => {
      const trimmed = (name ?? "").trim();
      return trimmed.length > 0 ? trimmed : fallback;
    };
    return [...sessionsGroupedByLane.entries()]
      .filter(([laneId, sessions]) => !knownLaneIds.has(laneId) && sessions.length > 0)
      .sort(([leftLaneId, leftSessions], [rightLaneId, rightSessions]) => {
        const leftLatest = latestStartedAt(leftSessions);
        const rightLatest = latestStartedAt(rightSessions);
        if (leftLatest !== rightLatest) return rightLatest - leftLatest;
        const leftName = orphanLabel(leftSessions[0]?.laneName, leftLaneId);
        const rightName = orphanLabel(rightSessions[0]?.laneName, rightLaneId);
        return leftName.localeCompare(rightName);
      });
  }, [lanes, sessionsGroupedByLane]);
  const handoffOnlyMissingLaneGroups = useMemo(() => {
    const knownLaneIds = new Set(lanes.map((lane) => lane.id));
    const missingSessionLaneIds = new Set(missingLaneSessionGroups.map(([laneId]) => laneId));
    return [...handoffJobsByLaneId.entries()]
      .filter(([laneId, jobs]) => !knownLaneIds.has(laneId) && !missingSessionLaneIds.has(laneId) && jobs.length > 0)
      .sort(([leftLaneId, leftJobs], [rightLaneId, rightJobs]) => {
        const leftLatest = Math.max(...leftJobs.map((job) => job.createdAtMs));
        const rightLatest = Math.max(...rightJobs.map((job) => job.createdAtMs));
        if (leftLatest !== rightLatest) return rightLatest - leftLatest;
        const leftName = leftJobs[0]?.laneName ?? leftLaneId;
        const rightName = rightJobs[0]?.laneName ?? rightLaneId;
        return leftName.localeCompare(rightName);
      });
  }, [handoffJobsByLaneId, lanes, missingLaneSessionGroups]);
  const expandSessionWithChildren = useCallback((session: TerminalSessionSummary): string[] => {
    const children = childrenByParentId.get(session.id) ?? [];
    if (children.length === 0) return [session.id];
    if (isChildSectionCollapsed(session.id)) return [session.id];
    return [session.id, ...children.map((child) => child.id)];
  }, [childrenByParentId, isChildSectionCollapsed]);
  const collectVisibleIds = useCallback((sessions: TerminalSessionSummary[]): string[] => {
    const ids: string[] = [];
    for (const session of sessions) {
      if (excludedTopLevelIds.has(session.id)) continue;
      ids.push(...expandSessionWithChildren(session));
    }
    return ids;
  }, [excludedTopLevelIds, expandSessionWithChildren]);
  const renderedSessionIds = useMemo(() => {
    if (isByLane) {
      const ids: string[] = [];
      const laneVisibleIds = (laneId: string, list: TerminalSessionSummary[]): string[] => {
        const active = list.filter((session) => !quietIdSet.has(session.id));
        const ids = collectVisibleIds(active);
        if (workCollapsedSectionIds.includes(`snoozed-open:${laneId}`)) {
          ids.push(...collectVisibleIds(list.filter((session) => snoozedIdSet.has(session.id))));
        }
        if (workCollapsedSectionIds.includes(`settled-open:${laneId}`)) {
          ids.push(...collectVisibleIds(list.filter((session) => settledIdSet.has(session.id))));
        }
        return ids;
      };
      for (const lane of orderedLanes) {
        if (workCollapsedLaneIds.includes(lane.id)) continue;
        ids.push(...laneVisibleIds(lane.id, sessionsGroupedByLane?.get(lane.id) ?? []));
      }
      for (const [laneId, list] of missingLaneSessionGroups) {
        if (workCollapsedLaneIds.includes(laneId)) continue;
        ids.push(...laneVisibleIds(laneId, list));
      }
      return ids;
    }
    if (isByTime) {
      const ids: string[] = [];
      if (!workCollapsedSectionIds.includes("time:today")) ids.push(...collectVisibleIds(timeBuckets.today));
      if (!workCollapsedSectionIds.includes("time:yesterday")) ids.push(...collectVisibleIds(timeBuckets.yesterday));
      if (!workCollapsedSectionIds.includes("time:older")) ids.push(...collectVisibleIds(timeBuckets.older));
      if (!workCollapsedSectionIds.includes("status:snoozed")) ids.push(...collectVisibleIds(visibleSnoozed));
      if (!workCollapsedSectionIds.includes("status:settled")) ids.push(...collectVisibleIds(visibleSettled));
      return ids;
    }
    const ids: string[] = [];
    if (!workCollapsedSectionIds.includes("status:running")) ids.push(...collectVisibleIds(runningFiltered));
    if (!workCollapsedSectionIds.includes("status:awaiting")) ids.push(...collectVisibleIds(awaitingInputFiltered));
    if (!workCollapsedSectionIds.includes("status:ended")) ids.push(...collectVisibleIds(endedFiltered));
    if (!workCollapsedSectionIds.includes("status:snoozed")) ids.push(...collectVisibleIds(visibleSnoozed));
    if (!workCollapsedSectionIds.includes("status:settled")) ids.push(...collectVisibleIds(visibleSettled));
    return ids;
  }, [
    awaitingInputFiltered,
    collectVisibleIds,
    endedFiltered,
    isByLane,
    isByTime,
    missingLaneSessionGroups,
    orderedLanes,
    quietIdSet,
    runningFiltered,
    sessionsGroupedByLane,
    settledIdSet,
    snoozedIdSet,
    timeBuckets.older,
    timeBuckets.today,
    timeBuckets.yesterday,
    visibleSettled,
    visibleSnoozed,
    workCollapsedLaneIds,
    workCollapsedSectionIds,
  ]);

  // First-rendered card carries a stable automation anchor at a real session.
  // We track whether we've already emitted it across the whole list (not per-section).
  let sessionItemAnchorEmitted = false;
  // The "active" grid is the set containing the focused session; its members'
  // badges are highlighted, members of other grids are greyed.
  const activeGridSetId = findGridSetForSession(gridSets, activeItemId)?.id ?? null;
  const gridBadgeFor = (sessionId: string): "active" | "inactive" | null => {
    const set = findGridSetForSession(gridSets, sessionId);
    if (!set) return null;
    return set.id === activeGridSetId ? "active" : "inactive";
  };

  type RenderCardOptions = {
    compact?: boolean;
    foreignRow?: CrossMachineLaneRow;
    visibleSessionIds?: string[];
  };
  const renderCardCore = (session: TerminalSessionSummary, options?: RenderCardOptions) => {
    const isFirst = !sessionItemAnchorEmitted;
    if (isFirst) sessionItemAnchorEmitted = true;
    const foreignRow = options?.foreignRow;
    const disabledReason = foreignRow
      ? !foreignRow.online
        ? `${foreignRow.machineName} is offline`
        : !foreignRow.binding
          ? `${foreignRow.machineName} is unavailable`
          : null
      : deleteProgressByLaneId[session.laneId]
        ? `${getLaneDeleteStatusLabel(deleteProgressByLaneId[session.laneId])} lane`
        : null;
    const card = (
      <SessionCard
        key={session.id}
        session={session}
        lane={foreignRow?.lane ?? laneById.get(session.laneId) ?? null}
        liveChildrenCount={foreignRow ? 0 : liveChildrenByParentId.get(session.id) ?? 0}
        parentSessionTitle={
          !foreignRow && session.orchestrationParentSessionId
            ? sessionTitleById.get(session.orchestrationParentSessionId) ?? null
            : null
        }
        isSelected={selectedSessionId === session.id}
        isMultiSelected={selectedSessionIds?.has(session.id) ?? false}
        onSelect={(id, event) => {
          if (!foreignRow) {
            onSelectSession(id, event, renderedSessionIds);
          } else if (isChatToolType(session.toolType)) {
            onSelectSession(id, event, options?.visibleSessionIds ?? [], foreignRow.binding);
          } else if (foreignRow.binding && onSelectForeignRuntimeSession) {
            onSelectForeignRuntimeSession(
              session,
              foreignRow.binding,
              event,
              options?.visibleSessionIds ?? [],
            );
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(session, e, foreignRow?.binding, foreignRow?.machineName);
        }}
        compact={options?.compact}
        gridBadge={foreignRow ? null : gridBadgeFor(session.id)}
        runtimePin={foreignRow?.binding}
        deltaEnabled={!foreignRow}
        disabledReason={disabledReason}
        disabledBusy={!foreignRow}
      />
    );
    if (!isFirst) return card;
    return (
      <div key={`tour-${session.id}`} data-tour="work.sessionItem">
        {card}
      </div>
    );
  };

  const renderChildSection = (parentId: string, children: TerminalSessionSummary[]) => {
    if (children.length === 0) return null;
    const collapsed = isChildSectionCollapsed(parentId);
    return (
      <div key={`children-${parentId}`} className="ml-3 mt-0.5 border-l border-white/[0.06] pl-1.5">
        <button
          type="button"
          onClick={() => toggleChildSection(parentId)}
          className="flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[9px] font-medium uppercase tracking-wide text-muted-fg/40 transition-colors hover:bg-white/[0.03] hover:text-muted-fg/70"
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <CaretRight size={9} weight="bold" className="shrink-0 text-muted-fg/40" />
          ) : (
            <CaretDown size={9} weight="bold" className="shrink-0 text-muted-fg/40" />
          )}
          <Terminal size={9} weight="regular" className="shrink-0 text-muted-fg/40" />
          <span className="truncate">
            {children.length === 1 ? "1 shell" : `${children.length} shells`}
          </span>
        </button>
        {!collapsed ? (
          <div className="flex flex-col gap-0.5">
            {children.map((child) => (
              <div key={child.id}>{renderCardCore(child, { compact: true })}</div>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const renderCards = (list: TerminalSessionSummary[], options?: RenderCardOptions) => {
    if (options?.foreignRow) {
      const visibleSessionIds = list.map((session) => session.id);
      return list.map((session) =>
        renderCardCore(session, { ...options, visibleSessionIds }));
    }
    return list
      .filter((session) => !excludedTopLevelIds.has(session.id))
      .map((session) => {
        const children = childrenByParentId.get(session.id) ?? [];
        const card = renderCardCore(session, options);
        if (children.length === 0) return card;
        return (
          <div key={`group-${session.id}`}>
            {card}
            {renderChildSection(session.id, children)}
          </div>
        );
      });
  };

  const renderHandoffCards = (jobs: HandoffLaunchJob[]) => (
    <AnimatePresence initial={false}>
      {jobs.map((job) => (
        <HandoffSessionPlaceholderCard key={job.id} job={job} />
      ))}
    </AnimatePresence>
  );

  // Hollow ring — the settled tier's dot language (visually "less than" every
  // filled status dot).
  const settledSectionIcon = (
    <span
      className="h-2 w-2 shrink-0 rounded-full border bg-transparent"
      style={{ borderColor: "rgba(255,255,255,0.35)" }}
    />
  );
  // A moon, not another dot: snoozed and settled are both quiet tiers, so the
  // difference must be readable from shape alone, never from colour.
  const snoozedSectionIcon = (
    <Moon size={10} weight="fill" className="shrink-0 text-muted-fg/45" aria-hidden />
  );

  /** Shared collapsible tail used for a lane folder's quiet snoozed/settled rows. */
  const renderLaneQuietTail = (
    openMarker: string,
    icon: React.ReactNode,
    label: string,
    list: TerminalSessionSummary[],
    options?: RenderCardOptions,
  ) => {
    if (list.length === 0) return null;
    // Quiet tails start collapsed without needing to persist one entry per lane.
    // Presence of the open marker means the user explicitly expanded it.
    const collapsed = !workCollapsedSectionIds.includes(openMarker);
    return (
      <div className="mt-0.5">
        <button
          type="button"
          onClick={() => toggleWorkSectionCollapsed(openMarker)}
          className="flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[9px] font-medium uppercase tracking-wide text-muted-fg/40 transition-colors hover:bg-white/[0.03] hover:text-muted-fg/70"
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <CaretRight size={9} weight="bold" className="shrink-0 text-muted-fg/40" />
          ) : (
            <CaretDown size={9} weight="bold" className="shrink-0 text-muted-fg/40" />
          )}
          {icon}
          <span className="truncate">
            {list.length} {label}
          </span>
        </button>
        {!collapsed ? <div className="flex flex-col gap-0.5">{renderCards(list, options)}</div> : null}
      </div>
    );
  };

  /**
   * Lane folder body: active rows first, then quiet collapsible snoozed and
   * settled tails so hidden work stays openable in-stream without occupying the
   * folder's prime rows.
   */
  const renderLaneSessionLists = (
    laneKey: string,
    list: TerminalSessionSummary[],
    options?: { quiet?: boolean },
  ) => {
    const active = list.filter((session) => !quietIdSet.has(session.id));
    const snoozed = list.filter((session) => snoozedIdSet.has(session.id));
    const settled = list.filter((session) => settledIdSet.has(session.id));
    // An expanded quiet lane holds nothing but quiet rows, so render them
    // compact — the full card's preview line and meta row are all about work in
    // flight, which by definition there isn't any of here.
    const tailOptions = options?.quiet ? { compact: true } : undefined;
    return (
      <>
        {renderCards(active)}
        {renderLaneQuietTail(`snoozed-open:${laneKey}`, snoozedSectionIcon, "snoozed", snoozed, tailOptions)}
        {renderLaneQuietTail(`settled-open:${laneKey}`, settledSectionIcon, "settled", settled, tailOptions)}
      </>
    );
  };

  // An explicit quiet expansion belongs only to the current quiet spell. Once
  // real work returns, discard it so the next all-quiet transition defaults
  // back to the thin collapsed row.
  useEffect(() => {
    for (const marker of workCollapsedSectionIds) {
      if (!marker.startsWith("lane-open:")) continue;
      const laneId = marker.slice("lane-open:".length);
      const hasLaneEvidence =
        (unfilteredSessionsByLane.get(laneId)?.length ?? 0) > 0
        || (unfilteredHandoffCountByLaneId.get(laneId) ?? 0) > 0;
      if (hasLaneEvidence && !isLaneQuiet(laneId)) {
        toggleWorkSectionCollapsed(marker, { preserveDeeplink: true });
        continue;
      }
      const foreignRow = foreignRows.find(
        (row) => `${row.machineId}:${row.lane.id}` === laneId,
      );
      if (foreignRow && partitionQuietSessions(foreignRow.sessions).active.length > 0) {
        toggleWorkSectionCollapsed(marker, { preserveDeeplink: true });
      }
    }
  }, [
    foreignRows,
    isLaneQuiet,
    toggleWorkSectionCollapsed,
    unfilteredSessionsByLane,
    unfilteredHandoffCountByLaneId,
    workCollapsedSectionIds,
  ]);

  // Snoozed sits directly ABOVE Settled: hidden-for-now ranks above done.
  const snoozedStatusSection = visibleSnoozed.length > 0 ? (
    <StickyGroupHeader
      sectionId="status:snoozed"
      icon={snoozedSectionIcon}
      label="Snoozed"
      heading
      count={visibleSnoozed.length}
      collapsed={workCollapsedSectionIds.includes("status:snoozed")}
      onToggleCollapsed={() => toggleWorkSectionCollapsed("status:snoozed")}
    >
      {renderCards(visibleSnoozed)}
    </StickyGroupHeader>
  ) : null;

  const settledStatusSection = visibleSettled.length > 0 ? (
    <StickyGroupHeader
      sectionId="status:settled"
      icon={settledSectionIcon}
      label="Settled"
      count={visibleSettled.length}
      collapsed={workCollapsedSectionIds.includes("status:settled")}
      onToggleCollapsed={() => toggleWorkSectionCollapsed("status:settled")}
    >
      {renderCards(visibleSettled)}
    </StickyGroupHeader>
  ) : null;

  const groupedByStatusList = (
    <div className="px-1.5 pb-2">
      <StickyGroupHeader
        sectionId="status:running"
        icon={<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--color-success)" }} />}
        label="Running"
        count={runningFiltered.length + filteredHandoffJobs.length}
        collapsed={workCollapsedSectionIds.includes("status:running")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("status:running")}
      >
        {renderHandoffCards(filteredHandoffJobs)}
        {renderCards(runningFiltered)}
      </StickyGroupHeader>
      <StickyGroupHeader
        sectionId="status:awaiting"
        icon={<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--color-warning)" }} />}
        label="Your move"
        count={awaitingInputFiltered.length}
        collapsed={workCollapsedSectionIds.includes("status:awaiting")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("status:awaiting")}
        headerAction={quietlyAwaitingSessions.length > 0 ? (
          <button
            type="button"
            className="rounded px-1 py-0.5 text-[9px] font-medium text-muted-fg/55 transition-colors hover:bg-white/[0.06] hover:text-fg"
            onClick={(event) => {
              event.stopPropagation();
              void settleSessions(quietlyAwaitingSessions.map((session) => session.id));
            }}
          >
            Settle all
          </button>
        ) : null}
      >
        {renderCards(awaitingInputFiltered)}
      </StickyGroupHeader>
      <StickyGroupHeader
        sectionId="status:ended"
        icon={<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--color-error)" }} />}
        label="Ended"
        count={endedFiltered.length}
        collapsed={workCollapsedSectionIds.includes("status:ended")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("status:ended")}
        headerAction={(
          <button
            type="button"
            className="rounded px-1 py-0.5 text-[9px] font-medium text-muted-fg/55 transition-colors hover:bg-white/[0.06] hover:text-fg"
            onClick={(event) => {
              event.stopPropagation();
              void settleSessions(endedFiltered.map((session) => session.id));
            }}
          >
            Settle all
          </button>
        )}
      >
        {renderCards(endedFiltered)}
      </StickyGroupHeader>
      {snoozedStatusSection}
      {settledStatusSection}
    </div>
  );

  // Foreign lanes worth a row: ones with chats, after the same search, lane, and
  // chip filters the local list applies. Lanes elsewhere with nothing running
  // stay out of the sidebar — the union is about work in flight, not an inventory.
  const visibleForeignRows = useMemo(() => {
    if (foreignRows.length === 0) return EMPTY_FOREIGN_ROWS;
    const query = q.trim().toLowerCase();
    const nowMs = Date.now();
    const rows: CrossMachineLaneRow[] = [];
    for (const row of foreignRows) {
      if (laneFilterActive && row.lane.id !== normalizedFilterLaneId) continue;
      const sessions = query || chipFiltersActive
        ? row.sessions.filter((session) => {
            if (query && !`${primarySessionLabel(session)} ${row.lane.name}`.toLowerCase().includes(query)) {
              return false;
            }
            return !chipFiltersActive || matchesWorkSessionFilters(session, workSessionFilters, {
              nowMs,
              // PR summaries are local to the active runtime. Fail closed for a
              // remote lane instead of incorrectly treating an unknown PR as open.
              laneHasPr: () => false,
              laneIsDirty: (laneId) => laneId === row.lane.id && row.lane.status.dirty,
            });
          })
        : row.sessions;
      if (sessions.length === 0) continue;
      rows.push(sessions === row.sessions ? row : { ...row, sessions });
    }
    return rows.length > 0 ? rows : EMPTY_FOREIGN_ROWS;
  }, [chipFiltersActive, foreignRows, laneFilterActive, normalizedFilterLaneId, q, workSessionFilters]);

  // "No sessions" must not claim an empty machine when another machine is busy.
  const hasForeignSessions = visibleForeignRows.length > 0;

  const byLaneList = (
    <div className="flex flex-col gap-1.5 px-2 pb-3">
      {orderedLanes.map((lane) => {
        const list = sessionsGroupedByLane?.get(lane.id) ?? [];
        const laneHandoffJobs = handoffJobsByLaneId.get(lane.id) ?? [];
        const lanePinned = workPinnedLaneIdSet.has(lane.id);
        // A pinned lane keeps the full-height header even when everything in it
        // has settled; only its position is exempt from the sink.
        const laneQuiet = isLaneQuiet(lane.id) && !lanePinned;
        // A quiet lane starts collapsed, and — like the quiet tails — records
        // only the *explicit expand*, so it re-quiets on its own once the user
        // moves on instead of leaving a stale "expanded" entry behind forever.
        const laneOpenMarker = `lane-open:${lane.id}`;
        const collapsed = laneQuiet
          ? !workCollapsedSectionIds.includes(laneOpenMarker)
          : workCollapsedLaneIds.includes(lane.id);
        const total = list.length + laneHandoffJobs.length;
        const laneAccent = lane.color ?? null;
        const laneHeaderTint = laneSurfaceTint(laneAccent, "pastel");
        const laneIcon = (
          <span
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
            style={{ color: laneHeaderTint.text ?? laneAccent ?? "var(--color-muted-fg)" }}
          >
            {lane.icon ? iconGlyph(lane.icon) : <LaneIcon size={12} weight="regular" />}
          </span>
        );
        const primaryPr = selectPrimaryLanePr(lane, prsByLaneId.get(lane.id) ?? []);
        const prBadge = primaryPr ? (
          <LanePrHeaderBadge
            pr={primaryPr}
            onOpen={() => navigate(`/prs?tab=normal&prId=${encodeURIComponent(primaryPr.id)}`)}
          />
        ) : null;
        const deleteProgress = deleteProgressByLaneId[lane.id] ?? null;
        // Never populated for a lane on this machine — the marker exists only to
        // say "this work isn't here".
        const machineMarker = markersByLaneId.get(lane.id) ?? null;
        return (
          <StickyGroupHeader
            key={lane.id}
            sectionId={lane.id}
            icon={laneIcon}
            label={lane.name}
            subLabel={branchNameFromRef(lane.branchRef)}
            variant="lane"
            count={total}
            collapsed={collapsed}
            accentColor={laneAccent}
            prBadge={prBadge}
            machineMarker={machineMarker ? <LaneMachineMarker marker={machineMarker} /> : null}
            busyLabel={deleteProgress ? getLaneDeleteStatusLabel(deleteProgress) : null}
            pinned={lanePinned}
            dragProps={laneDragProps(lane.id)}
            dropIndicatorEdge={laneDrop?.laneId === lane.id ? laneDrop.edge : null}
            layoutDependency={laneOrderSignature}
            quietCounts={laneQuiet && collapsed
              ? {
                  snoozed: list.filter((session) => snoozedIdSet.has(session.id)).length,
                  settled: list.filter((session) => settledIdSet.has(session.id)).length,
                }
              : null}
            onToggleCollapsed={() => {
              if (deleteProgress) return;
              if (laneQuiet) toggleWorkSectionCollapsed(laneOpenMarker);
              else toggleWorkLaneCollapsed(lane.id);
            }}
            onContextMenu={deleteProgress ? undefined : (e) => triggerLaneContextMenu(lane.id, e)}
          >
            {renderHandoffCards(laneHandoffJobs)}
            {renderLaneSessionLists(lane.id, list, { quiet: laneQuiet })}
          </StickyGroupHeader>
        );
      })}
      {missingLaneSessionGroups.map(([laneId, list]) => {
        const laneHandoffJobs = handoffJobsByLaneId.get(laneId) ?? [];
        const collapsed = workCollapsedLaneIds.includes(laneId);
        const trimmedLaneName = (list[0]?.laneName ?? "").trim();
        const label = trimmedLaneName.length > 0 ? trimmedLaneName : laneHandoffJobs[0]?.laneName ?? laneId;
        const canRefreshRecords = Boolean(onRefreshOrphanSessions);
        return (
          <StickyGroupHeader
            key={laneId}
            sectionId={`orphan:${laneId}`}
            icon={<WarningCircle size={12} weight="regular" className="h-3.5 w-3.5 shrink-0 text-muted-fg/55" />}
            label={`Orphaned sessions: ${label}`}
            count={list.length + laneHandoffJobs.length}
            collapsed={collapsed}
            heading
            headerAction={(
              <SmartTooltip
                forceEnabled
                content={{
                  label: "Refresh lane and session records",
                  description: "Reconcile this group with its owning runtime. Nothing is deleted.",
                }}
              >
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-fg/55 transition-colors hover:bg-white/[0.06] hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
                  aria-label={`Refresh lane and session records for ${label}`}
                  disabled={!canRefreshRecords}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRefreshOrphanSessions?.();
                  }}
                >
                  <ArrowClockwise size={12} aria-hidden />
                </button>
              </SmartTooltip>
            )}
            onToggleCollapsed={() => toggleWorkLaneCollapsed(laneId)}
          >
            <div
              className="mx-1.5 mb-1.5 border-l border-white/[0.08] px-2 py-1 text-[10px] leading-relaxed text-muted-fg/65"
              data-testid="orphan-session-explanation"
            >
              The lane record is missing from the latest runtime snapshot. Refresh to reconcile this group with its
              owning machine. ADE will not delete sessions, Git branches, worktrees, commits, or pull requests.
            </div>
            {renderHandoffCards(laneHandoffJobs)}
            {renderLaneSessionLists(laneId, list)}
          </StickyGroupHeader>
        );
      })}
      {handoffOnlyMissingLaneGroups.map(([laneId, jobs]) => {
        const collapsed = workCollapsedLaneIds.includes(laneId);
        const label = jobs[0]?.laneName ?? laneId;
        return (
          <StickyGroupHeader
            key={laneId}
            sectionId={laneId}
            icon={<LaneIcon size={12} weight="regular" className="h-3.5 w-3.5 shrink-0 text-muted-fg/55" />}
            label={label}
            variant="lane"
            count={jobs.length}
            collapsed={collapsed}
            onToggleCollapsed={() => toggleWorkLaneCollapsed(laneId)}
          >
            {renderHandoffCards(jobs)}
          </StickyGroupHeader>
        );
      })}
      {visibleForeignRows.map((row) => {
        const compositeLaneId = `${row.machineId}:${row.lane.id}`;
        const marker = markersByLaneId.get(compositeLaneId) ?? null;
        const quiet = partitionQuietSessions(row.sessions);
        const laneQuiet = quiet.active.length === 0;
        const laneOpenMarker = `lane-open:${compositeLaneId}`;
        const collapsed = laneQuiet
          ? !workCollapsedSectionIds.includes(laneOpenMarker)
          : workCollapsedLaneIds.includes(compositeLaneId);
        return (
          <StickyGroupHeader
            key={`${row.machineId}:${row.lane.id}`}
            sectionId={compositeLaneId}
            icon={
              <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-fg/55">
                <LaneIcon size={12} weight="regular" />
              </span>
            }
            label={row.lane.name}
            subLabel={branchNameFromRef(row.lane.branchRef)}
            variant="lane"
            count={row.sessions.length}
            collapsed={collapsed}
            accentColor={row.lane.color ?? null}
            machineMarker={marker ? <LaneMachineMarker marker={marker} /> : null}
            quietCounts={laneQuiet && collapsed
              ? {
                  snoozed: quiet.snoozed.length,
                  settled: quiet.settled.length,
                }
              : null}
            // Offline machines keep every lane they last reported, dimmed and
            // read-only. A wifi blip must never reflow the sidebar.
            dimmed={!row.online}
            onToggleCollapsed={() => {
              if (laneQuiet) toggleWorkSectionCollapsed(laneOpenMarker);
              else toggleWorkLaneCollapsed(compositeLaneId);
            }}
            onContextMenu={row.binding
              ? (event) => triggerForeignLaneContextMenu(
                row.lane,
                row.binding!,
                row.machineName,
                row.online,
                event,
              )
              : undefined}
          >
            {renderCards(quiet.active, { foreignRow: row })}
            {renderLaneQuietTail(
              `snoozed-open:${compositeLaneId}`,
              snoozedSectionIcon,
              "snoozed",
              quiet.snoozed,
              { compact: laneQuiet, foreignRow: row },
            )}
            {renderLaneQuietTail(
              `settled-open:${compositeLaneId}`,
              settledSectionIcon,
              "settled",
              quiet.settled,
              { compact: laneQuiet, foreignRow: row },
            )}
          </StickyGroupHeader>
        );
      })}
    </div>
  );

  const byTimeList = (
    <div className="px-1.5 pb-2">
      <StickyGroupHeader
        sectionId="time:today"
        icon={null}
        label="Today"
        count={timeBuckets.today.length + handoffTimeBuckets.today.length}
        collapsed={workCollapsedSectionIds.includes("time:today")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("time:today")}
      >
        {renderHandoffCards(handoffTimeBuckets.today)}
        {renderCards(timeBuckets.today)}
      </StickyGroupHeader>
      <StickyGroupHeader
        sectionId="time:yesterday"
        icon={null}
        label="Yesterday"
        count={timeBuckets.yesterday.length + handoffTimeBuckets.yesterday.length}
        collapsed={workCollapsedSectionIds.includes("time:yesterday")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("time:yesterday")}
      >
        {renderHandoffCards(handoffTimeBuckets.yesterday)}
        {renderCards(timeBuckets.yesterday)}
      </StickyGroupHeader>
      <StickyGroupHeader
        sectionId="time:older"
        icon={null}
        label="Older"
        count={timeBuckets.older.length + handoffTimeBuckets.older.length}
        collapsed={workCollapsedSectionIds.includes("time:older")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("time:older")}
      >
        {renderHandoffCards(handoffTimeBuckets.older)}
        {renderCards(timeBuckets.older)}
      </StickyGroupHeader>
      {snoozedStatusSection}
      {settledStatusSection}
    </div>
  );

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      style={{ background: "var(--work-sidebar-bg)" }}
    >
      {/* Compact toolbar */}
      <div className="ade-session-list-toolbar shrink-0 space-y-1.5 px-2 pt-2 pb-1.5">
        <div className="ade-session-list-toolbar-row flex min-w-0 items-center gap-1.5 overflow-hidden">
          <div className="ade-session-list-toolbar-search relative min-w-0 flex-1">
            <MagnifyingGlass size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-fg/40" />
            <input
              className="h-7 w-full min-w-0 rounded-lg border pl-7 pr-2 text-[11px] text-fg outline-none placeholder:text-muted-fg/30"
              style={{
                borderColor: "rgba(255,255,255,0.06)",
                background: "rgba(255,255,255,0.03)",
              }}
              placeholder="Search..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <SmartTooltip content={{ label: "Filters", description: "Toggle the filter panel to organize sessions by lane or time." }}>
            <button
              type="button"
              className="ade-session-list-toolbar-filter relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors"
              style={{
                border: "1px solid rgba(255,255,255,0.06)",
                background: filterOpen || laneFilterActive ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.03)",
                color: filterOpen || laneFilterActive ? "var(--color-fg)" : "var(--color-muted-fg)",
              }}
              onClick={() => setFilterOpen(!filterOpen)}
              aria-label={laneFilterActive ? "Filters, lane filter active" : "Filters"}
              data-tour="work.laneFilter"
            >
              <Funnel size={12} weight={filterOpen ? "fill" : "regular"} />
              {laneFilterActive || chipFiltersActive ? (
                <span
                  data-testid="work-lane-filter-active-indicator"
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] shadow-[0_0_8px_var(--color-accent)]"
                />
              ) : null}
            </button>
          </SmartTooltip>
          <SmartTooltip content={{ label: "New Chat", description: "Start a new AI chat session." }}>
            <button
              type="button"
              className="ade-session-list-toolbar-new-chat inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-medium transition-colors"
              style={{
                border: "1px solid rgba(168,130,255,0.35)",
                background: "rgba(168,130,255,0.08)",
                color: "rgba(168,130,255,0.9)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
              onClick={() => onShowDraftKind("chat")}
              aria-label="Start a new chat"
              data-tour="work.newSession"
            >
              <Plus size={10} weight="bold" />
              <span className="ade-session-list-toolbar-new-chat-label">New Chat</span>
            </button>
          </SmartTooltip>
        </div>

        {/* Expandable filter panel */}
        {filterOpen ? (
          <div className="ade-chat-drawer-glass space-y-1.5 p-2">
            <div className="flex items-start gap-1">
              <span className="w-10 shrink-0 pt-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-fg/50">Group</span>
              <div className={FILTER_OPTION_GRID_CLASS}>
                {([
                  { key: "by-lane" as const, label: "Lane" },
                  { key: "all-lanes-by-status" as const, label: "Status" },
                  { key: "by-time" as const, label: "Time" },
                ] as const).map((opt) => (
                  <SmartTooltip
                    key={opt.key}
                    content={{
                      label: opt.label,
                      description:
                        opt.key === "by-lane"
                          ? "Group sessions by the lane they belong to."
                          : opt.key === "all-lanes-by-status"
                            ? "Group by status: running, your move, ended, or settled."
                            : "Group by when sessions were started.",
                    }}
                  >
                    <button
                      type="button"
                      className={FILTER_OPTION_BUTTON_CLASS}
                      data-active={sessionListOrganization === opt.key ? "true" : undefined}
                      style={{
                        color: sessionListOrganization === opt.key ? "var(--color-fg)" : "var(--color-muted-fg)",
                      }}
                      onClick={() => setSessionListOrganization(opt.key)}
                    >
                      {opt.label}
                    </button>
                  </SmartTooltip>
                ))}
              </div>
            </div>
            {setWorkLaneSortMode && isByLane ? (
              <div className="flex items-start gap-1">
                <span className="w-10 shrink-0 pt-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-fg/50">Sort</span>
                <div className={FILTER_OPTION_GRID_CLASS}>
                  {WORK_LANE_SORT_MODES.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={FILTER_OPTION_BUTTON_CLASS}
                      data-active={workLaneSortMode === mode ? "true" : undefined}
                      style={{
                        color: workLaneSortMode === mode ? "var(--color-fg)" : "var(--color-muted-fg)",
                      }}
                      onClick={() => setWorkLaneSortMode(mode)}
                    >
                      {WORK_LANE_SORT_LABELS[mode]}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {/* Chip axes: OR within a row, AND across rows. */}
            {setWorkSessionFilters ? (
              <>
                <div className="flex items-start gap-1">
                  <span className="w-10 shrink-0 pt-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-fg/50">Status</span>
                  <div className={FILTER_OPTION_GRID_CLASS}>
                    {WORK_STATUS_FILTERS.map((bucket) => {
                      const active = workSessionFilters.status.includes(bucket);
                      return (
                        <button
                          key={bucket}
                          type="button"
                          aria-pressed={active}
                          className={FILTER_OPTION_BUTTON_CLASS}
                          data-active={active ? "true" : undefined}
                          style={{ color: active ? "var(--color-fg)" : "var(--color-muted-fg)" }}
                          onClick={() => toggleStatusFilter(bucket)}
                        >
                          {workStatusFilterLabel(bucket)}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-start gap-1">
                  <span className="w-10 shrink-0 pt-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-fg/50">Tool</span>
                  <div className={FILTER_OPTION_GRID_CLASS}>
                    {WORK_TOOL_FAMILIES.map((family: WorkToolFamily) => {
                      const active = workSessionFilters.tool.includes(family);
                      return (
                        <button
                          key={family}
                          type="button"
                          aria-pressed={active}
                          className={FILTER_OPTION_BUTTON_CLASS}
                          data-active={active ? "true" : undefined}
                          style={{ color: active ? "var(--color-fg)" : "var(--color-muted-fg)" }}
                          onClick={() => toggleToolFilter(family)}
                        >
                          {workToolFamilyLabel(family)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : null}
            <div className="flex items-start gap-1">
              <span className="w-10 shrink-0 pt-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-fg/50">Lane</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {setWorkSessionFilters ? (
                  <div className={FILTER_OPTION_GRID_CLASS}>
                    {([
                      { key: "hasPr" as const, label: "Has PR" },
                      { key: "dirtyLane" as const, label: "Dirty" },
                    ]).map((opt) => {
                      const active = workSessionFilters[opt.key];
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          aria-pressed={active}
                          className={FILTER_OPTION_BUTTON_CLASS}
                          data-active={active ? "true" : undefined}
                          style={{ color: active ? "var(--color-fg)" : "var(--color-muted-fg)" }}
                          onClick={() => setWorkSessionFilters((prev) => ({
                            ...prev,
                            [opt.key]: !prev[opt.key],
                          }))}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <LaneCombobox
                  lanes={orderedLanes}
                  value={filterLaneId}
                  onChange={setFilterLaneId}
                  showAllOption
                  fullWidth
                />
              </div>
            </div>
          </div>
        ) : null}

        {selectedCount > 0 ? (
          <div className="ade-chat-drawer-glass flex flex-wrap items-center gap-1.5 p-1.5">
            <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-fg/80">
              {selectedCount} selected
            </span>
            {selectedRunningCount > 0 ? (
              <SmartTooltip content={{ label: "Stop runtimes", description: "Terminate selected running CLI and shell processes." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-200"
                  onClick={onBulkClose}
                >
                  <Square size={10} />
                  Stop {selectedRunningCount}
                </button>
              </SmartTooltip>
            ) : null}
            {selectedSettleCount > 0 ? (
              <SmartTooltip content={{ label: "Settle selected", description: "Move selected sessions into the quiet Settled tier." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-white/10 bg-white/[0.05] px-2 text-[10px] font-medium text-fg/80"
                  onClick={() => {
                    void settleSessions(selectedSettleableSessions.map((session) => session.id));
                  }}
                >
                  Settle {selectedSettleCount}
                </button>
              </SmartTooltip>
            ) : null}
            {selectedDeletableCount > 0 ? (
              <SmartTooltip content={{ label: "Delete selected", description: "Permanently delete selected sessions." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-red-500/25 bg-red-500/10 px-2 text-[10px] font-medium text-red-200"
                  onClick={onBulkDelete}
                >
                  <Trash size={10} />
                  Delete {selectedDeletableCount}
                </button>
              </SmartTooltip>
            ) : null}
            {selectedRunningCount > 0 ? (
              <SmartTooltip content={{ label: "Stop & delete selected", description: "Stop running runtimes, then permanently delete every selected session." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-red-500/30 bg-red-500/15 px-2 text-[10px] font-medium text-red-200"
                  onClick={onBulkStopAndDelete}
                >
                  <Trash size={10} />
                  Stop &amp; delete {selectedCount}
                </button>
              </SmartTooltip>
            ) : null}
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-fg/60 hover:bg-white/[0.06] hover:text-fg"
              onClick={onClearSelection}
              aria-label="Clear selected sessions"
              title="Clear selection"
            >
              <X size={10} />
            </button>
          </div>
        ) : null}
      </div>

      {/* Divider */}
      <div className="shrink-0 h-px" style={{ background: "var(--work-pane-border)" }} />

      {/* Session list */}
      <div
        ref={listScrollRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pt-2"
        data-tour="work.crossLaneSwitch"
      >
        {!hasAnySessions && chipFiltersActive ? (
          // Chip filters persist across restarts, so an empty list has to say
          // WHY it is empty — otherwise a filter left on last week reads as
          // "all my work is gone".
          <div className="flex flex-col items-center justify-center h-full px-3 py-10 text-center">
            <Funnel size={16} weight="regular" className="mb-2 text-muted-fg/25" />
            <div className="text-[11px] font-medium text-fg/70">No sessions match</div>
            <div className="mt-1 max-w-[190px] text-[10px] leading-relaxed text-muted-fg/45">
              {activeWorkSessionFilterLabels(workSessionFilters).join(" · ")}
            </div>
            <button
              type="button"
              className="mt-2.5 rounded-md px-2 py-1 text-[10px] font-medium text-muted-fg/70 transition-colors hover:bg-white/[0.06] hover:text-fg"
              onClick={() => setWorkSessionFilters?.(EMPTY_WORK_SESSION_FILTERS)}
            >
              Clear filters
            </button>
          </div>
        ) : !hasAnySessions && !hasForeignSessions ? (
          <div className="flex flex-col items-center justify-center h-full px-3 py-10 text-center">
            <Terminal size={16} weight="regular" className="text-muted-fg/15 mb-2" />
            <div className="text-[11px] font-medium text-fg/70">No sessions</div>
            <div className="mt-1 text-[10px] text-muted-fg/40 leading-relaxed max-w-[180px]">
              Start a new session above.
            </div>
          </div>
        ) : !isByLane && hasForeignSessions && !hasAnySessions ? (
          <div className="flex h-full flex-col items-center justify-center px-3 py-10 text-center">
            <Desktop size={16} weight="regular" className="mb-2 text-muted-fg/30" />
            <div className="text-[11px] font-medium text-fg/70">Sessions are active on another machine</div>
            <div className="mt-1 max-w-[210px] text-[10px] leading-relaxed text-muted-fg/45">
              Group by lane to open cross-machine sessions.
            </div>
          </div>
        ) : isByTime ? (
          byTimeList
        ) : isByLane ? (
          byLaneList
        ) : (
          groupedByStatusList
        )}
      </div>

      {/* Add Lane button */}
      <div className="shrink-0 px-2 pb-2 pt-1" style={{ borderTop: "1px solid var(--work-pane-border)" }}>
        <SmartTooltip content={{ label: "Add Lane", description: "Create a new lane without leaving Work." }}>
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors hover:bg-white/[0.06]"
            style={{
              color: "var(--color-muted-fg)",
              border: "1px solid rgba(255,255,255,0.06)",
              background: "rgba(255,255,255,0.02)",
              cursor: "pointer",
            }}
            onClick={() => setCreateLaneOpen(true)}
          >
            <Plus size={11} weight="bold" />
            Add Lane
          </button>
        </SmartTooltip>
      </div>
      {createLaneOpen ? (
        <CreateLaneDialogHost
          open={createLaneOpen}
          onOpenChange={setCreateLaneOpen}
          behavior="close-on-create"
          onNavigateToTemplates={() => navigate("/settings?tab=lane-templates")}
          onOpenLinearSettings={() => navigate("/settings?tab=general#linear-connection")}
        />
      ) : null}
      {settleUndo ? (
        <div
          className="ade-chat-drawer-glass absolute bottom-12 left-2 right-2 z-30 flex items-center gap-2 px-2.5 py-2 text-[10px] text-fg/85 shadow-lg"
          role="status"
        >
          <span className="min-w-0 flex-1 truncate">Settled {settleUndo.count}</span>
          <button
            type="button"
            className="shrink-0 font-semibold text-[var(--color-accent)] hover:underline"
            onClick={() => void undoSettle()}
          >
            Undo
          </button>
        </div>
      ) : null}
      {laneContextMenuPortal}
    </div>
  );
});
