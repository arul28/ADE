import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowClockwise, CaretDown, CaretRight, CircleNotch, Desktop, Funnel, MagnifyingGlass, Moon, NotePencil, Plus, PushPin, Square, Terminal, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import type { LaneSummary, OpenProjectBinding, PrSummary, TerminalSessionSummary } from "../../../shared/types";
import { selectPrimaryLanePr } from "../../lib/lanePrBadge";
import { LanePrBadge, lanePrDeepLinkPath } from "./LanePrBadge";
import type { SessionContextMenuLaneActions } from "./SessionContextMenu";
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
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { resolveLaneAccentColor } from "../../../shared/laneColorPalette";
import { LaneMachineMarker } from "./LaneMachineMarker";
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
import { getEffectiveBinding } from "../../lib/keybindings";
import { laneRailTint, laneSurfaceTint } from "../lanes/laneDesignTokens";
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
/**
 * One button idiom, top and bottom of the column: no border, no fill, no accent
 * outline — just a muted glyph that picks up a surface on hover, exactly like
 * the group headers between them.
 */
const SIDEBAR_BARE_BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-md text-muted-fg transition-colors hover:bg-white/[0.04] hover:text-fg";
const BULK_ACTION_BUTTON_CLASS =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-muted-fg transition-colors hover:bg-white/[0.04] hover:text-fg";
const BULK_DESTRUCTIVE_BUTTON_CLASS =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-red-300/75 transition-colors hover:bg-red-500/10 hover:text-red-200";

/**
 * Proximity, the only grouping cue left once the borders came off.
 *
 * Everything used to sit on one uniform `gap-2`, which is most of why the column
 * read as a single undifferentiated stream with headers floating in it: a
 * singleton lane's card and a card *inside* an expanded group were the same
 * distance apart, so nothing said which rows belonged together.
 *
 * Two gaps now, and the ratio between them is the whole point — rows inside a
 * group sit ~4px apart, groups sit ~18px apart, so a gap you can see is always a
 * boundary and a gap you can't is always membership.
 */
const GROUP_STACK_CLASS = "flex flex-col gap-[18px]";
const ROW_STACK_CLASS = "flex flex-col gap-1";
/**
 * A card's hover fill bleeds past the pane's gutter so the row reaches the edge;
 * it defaults to 12px, which is the by-lane inset (scroll `px-1` + stack `px-2`).
 * Every stack now uses a 4px inset and the scroll pane contributes another 2px,
 * for a 6px outer gutter. Keeping the value explicit pins the real ancestry
 * rather than letting a future padding change quietly shorten the hover fill.
 */
const SESSION_LIST_BLEED_CLASS = "[--session-row-bleed:6px]";
/** The two shelves are one zone, so they sit closer to each other than to it. */
const QUIET_ZONE_STACK_CLASS = "flex flex-col gap-2";
/**
 * A shelf's INTERIOR is not a stack of groups, even though its children are
 * lane groups. A shelved lane is collapsed by default, so it renders as a
 * single header row — and two one-line rows 18px apart read as two sections
 * rather than one list, which is exactly the "spacing looks weird" report. So
 * the shelf body carries the ROW gap, and only a lane that is actually
 * EXPANDED (it has a body of cards under it) buys the group gap back.
 *
 * Half the difference goes on each side of an expanded child, so the rhythm
 * stays symmetric: 4 + 7 + 7 = 18px between two expanded groups (the same as
 * `GROUP_STACK_CLASS` elsewhere), 4 + 7 = 11px where a collapsed row meets an
 * expanded group, and a flat 4px between collapsed rows — identical to sibling
 * cards in a lane group, which is the point.
 *
 * `first:`/`last:` zero it at the ends so an expanded child never pushes the
 * first row off its shelf label or leaves dead space above the footer.
 */
const SHELF_BODY_STACK_CLASS = ROW_STACK_CLASS;
const SHELF_EXPANDED_ROW_CLASS = "my-[7px] first:mt-0 last:mb-0";

/**
 * The quiet shelf's label idiom: small, uppercase, letter-spaced, grey — and
 * with NO hairline rule, which is the cue that separates it from a lane divider
 * (coloured sentence-case name + hairline + count). Two folding rows of the same
 * shape in one list is exactly what made "is this a lane or a shelf?" unanswerable.
 *
 * Shared verbatim with the in-lane snoozed/settled tails, one step smaller, so
 * "quiet" reads the same everywhere while staying subordinate inside a group.
 */
const QUIET_LABEL_CLASS = "font-semibold uppercase tracking-[0.09em] text-muted-fg/45";

type PaletteCombo = { key: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean };

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
}

/**
 * First alternative of a keybinding string ("Mod+K", "Mod+K,Ctrl+P"), resolved
 * against the platform the way `lib/keybindings` resolves it when matching.
 * Parsed here rather than imported because that module exposes only a matcher
 * and a resolver — nothing that hands back the combo itself.
 */
function parsePrimaryCombo(binding: string): PaletteCombo | null {
  const first = binding.split(",")[0]?.trim();
  if (!first) return null;
  const mac = isMacPlatform();
  const combo: PaletteCombo = { key: "", ctrl: false, meta: false, alt: false, shift: false };
  for (const raw of first.split("+")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token === "mod") {
      if (mac) combo.meta = true;
      else combo.ctrl = true;
      continue;
    }
    if (token === "ctrl" || token === "control") { combo.ctrl = true; continue; }
    if (token === "meta" || token === "cmd" || token === "command") { combo.meta = true; continue; }
    if (token === "alt" || token === "option") { combo.alt = true; continue; }
    if (token === "shift") { combo.shift = true; continue; }
    combo.key = raw.trim();
  }
  return combo.key ? combo : null;
}

/** `⌘K` on macOS, `Ctrl+K` elsewhere — display only. */
function shortcutChipLabel(binding: string): string | null {
  const combo = parsePrimaryCombo(binding);
  if (!combo) return null;
  const mac = isMacPlatform();
  const parts: string[] = [];
  if (combo.ctrl) parts.push(mac ? "⌃" : "Ctrl");
  if (combo.alt) parts.push(mac ? "⌥" : "Alt");
  if (combo.shift) parts.push(mac ? "⇧" : "Shift");
  if (combo.meta) parts.push(mac ? "⌘" : "Meta");
  parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  return mac ? parts.join("") : parts.join("+");
}

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

/**
 * Whether a foreign lane has work actually in flight. An offline machine's chats
 * can still read as running — that is only the last thing it reported — so both
 * the collapse default and the auto-collapse effect must ask this, not the
 * partition alone, or expanding a dropped machine's group slams it shut again.
 */
function foreignRowHasLiveWork(
  row: CrossMachineLaneRow,
  active: readonly TerminalSessionSummary[],
): boolean {
  return row.online && active.length > 0;
}

/**
 * A cross-machine lane row resolved for rendering: its composite id, its quiet
 * partition, and the shelf it files into (null = stays in the inbox). Bundled
 * so the main list and the two shelves render foreign lanes through ONE
 * function, the way local lanes go through `renderLaneGroup`.
 */
type ForeignLaneEntry = {
  row: CrossMachineLaneRow;
  compositeLaneId: string;
  quiet: ReturnType<typeof partitionQuietSessions>;
  shelf: "snoozed" | "settled" | null;
};

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

/**
 * Non-lane shelf tones, following t3's Sidebar V2 convention: Snoozed is blue
 * (hidden for now, still yours), Settled is muted (done, out of the way).
 * Everything else is the neutral hairline.
 */
type GroupShelfTone = "default" | "snoozed" | "settled";

const SHELF_TONE_LABEL_CLASS: Record<GroupShelfTone, string> = {
  default: "text-fg/75",
  snoozed: "text-blue-400",
  settled: "text-muted-fg/50",
};

/**
 * The rule that replaces the old bordered pill. It carries the shelf's colour
 * at a fraction of the label's strength, so the hue is legible without the row
 * ever painting a surface.
 */
const SHELF_TONE_RULE_CLASS: Record<GroupShelfTone, string> = {
  default: "bg-white/[0.06]",
  snoozed: "bg-blue-400/15",
  settled: "bg-white/[0.06]",
};

/**
 * The quiet shelves — Snoozed and Settled, as `status:*` in the by-status and
 * by-time columns and as `lane-shelf:*` in the by-lane one. They are the only
 * sections in this pane whose DEFAULT is collapsed: the whole point of snoozing
 * or settling a row is to stop looking at it, so a freshly opened sidebar that
 * greets you with the rows you told it to hide has undone the gesture that put
 * them there. Every other section keeps the plain default (expanded).
 *
 * `workCollapsedSectionIds` is a list of sections that ARE collapsed, so absence
 * means expanded — a shape that cannot express "closed until you say
 * otherwise". The quiet shelves therefore record the OPPOSITE fact: an explicit
 * expand writes `shelf-open:<sectionId>`, exactly like the per-lane `lane-open:`
 * and `snoozed-open:` markers further down. That keeps three states apart where
 * the plain list only had two — never touched (no marker, closed), explicitly
 * opened (marker present, and it survives a reload), explicitly closed again
 * (marker removed). A legacy `status:settled` entry left over from when the
 * shelf defaulted to open is inert now: it said "collapsed", which is what the
 * shelf does anyway.
 */
function quietShelfOpenMarker(sectionId: string): string {
  return `shelf-open:${sectionId}`;
}

function isQuietShelfCollapsed(collapsedSectionIds: string[], sectionId: string): boolean {
  return !collapsedSectionIds.includes(quietShelfOpenMarker(sectionId));
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
  tone = "default",
  busyLabel = null,
  heading = false,
  dimmed = false,
  quietCounts = null,
  pinned = false,
  headerless = false,
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
  /**
   * `lane` carries the lane accent on its name and indents its nested session
   * list behind a lane-tinted rail. `quiet-shelf` is the Snoozed/Settled zone at
   * the foot of the column: a grey uppercase label with no rule at all, so it
   * cannot be mistaken for a lane divider.
   */
  variant?: "default" | "lane" | "quiet-shelf";
  /** Shelf colour for non-lane headers (Snoozed blue, Settled muted). */
  tone?: GroupShelfTone;
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
  /**
   * Render the group WITHOUT its divider — the singleton form. The body still
   * renders (and the group still files into whatever shelf holds it); only the
   * header is gone, because a divider describing a group of one is pure chrome
   * and the lone card carries the lane identity instead.
   */
  headerless?: boolean;
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
  const isQuietShelf = variant === "quiet-shelf";
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
  // `laneSurfaceTint` is now consulted for its TEXT channel only. The background,
  // border, and left-accent it also returns are deliberately unused here: surface
  // is reserved for interaction, so the lane accent moved onto the lane NAME.
  // Lane = accent colour + LaneIcon, branch = muted + BranchIcon, never crossed.
  const laneTint = laneSurfaceTint(accentColor, "pastel");
  const laneLabelColor = isLane ? laneTint.text ?? accentColor ?? undefined : undefined;
  // Count placement. Every disclosure follows the same rule: collapsed folds
  // the hidden item count into the label (`Settled (12)`, `Lane name (3)`),
  // expanded shows the bare label because the rows themselves are visible.
  const showInlineCount = collapsed;
  const labelText = showInlineCount ? `${label} (${count})` : label;
  // The chevron is a second hit target for the SAME toggle, never decoration —
  // it looks like the control, so it has to behave like it. It cannot live
  // inside the label button: it sits at the far end of the trailing cluster,
  // right of the PR badge, and the row deliberately is not one big <button>
  // (see below — the badge is itself interactive). So it gets its own button
  // wired to the same handler.
  //
  // Hidden from assistive tech and out of the tab order on purpose: the label
  // button already carries this group's accessible name and `aria-expanded`,
  // and a second stop announcing the same state twice is noise, not access.
  const chevron = (
    <button
      type="button"
      aria-hidden
      tabIndex={-1}
      data-testid={`section-chevron-${sectionId}`}
      className="flex shrink-0 cursor-pointer items-center rounded-sm p-0.5 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed"
      onClick={onToggleCollapsed}
      disabled={Boolean(busyLabel)}
    >
      <CaretDown
        size={11}
        aria-hidden
        // One glyph that rotates, not two glyphs that swap: the rotation reads as
        // the same control changing state instead of the row re-rendering.
        className={cn(
          "shrink-0 transition-transform",
          isLane ? "text-muted-fg/35" : "text-muted-fg/30",
          !collapsed && "rotate-180",
        )}
      />
    </button>
  );
  return (
    // One rhythm: the gap between groups belongs to the list container, not to
    // per-variant margins here. Mixing `space-y-1` with `mb-1.5` / `mb-px` gave
    // active lanes a 10px gap and quiet ones 5px, which is what made the column
    // read as broken wherever the two met.
    <motion.div
      // A lane that goes quiet sinks immediately; `layout="position"` makes it
      // slide there. NOT full `layout` — size correction fights the collapse
      // body's height animation below and squashes the row.
      //
      // The same transition carries the singleton threshold: a lane gaining its
      // second session gains a header, and every group below it slides down on
      // this 0.24s ease instead of snapping (the caller folds headerlessness
      // into `layoutDependency` so the measurement actually happens).
      layout={layoutDependency ? "position" : false}
      layoutDependency={layoutDependency}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      onLayoutAnimationStart={() => setSliding(true)}
      onLayoutAnimationComplete={() => setSliding(false)}
      className={cn("relative", dimmed && "opacity-55")}
      data-dimmed={dimmed ? "true" : undefined}
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
      {headerless ? null : (
        // ONE header shape for every group in this column — active lane, quiet
        // lane, and Snoozed/Settled/time/status shelf alike. Two row heights in
        // one list is most of why the sidebar used to read as two lists stitched
        // together; the quiet variant now differs from the active one by opacity
        // and its inline counts, nothing else.
        //
        // The outer element owns the sticky position and an OPAQUE pane-coloured
        // fill — not a surface treatment, just the thing that stops scrolled
        // cards showing through a pinned row now that the blur is gone. The inner
        // row paints the only surface this header ever has: hover.
        //
        // It is a flex row, NOT one big <button>: the PR badge is itself
        // interactive, and nesting interactive elements inside a native button is
        // invalid HTML (breaks focus order / assistive tech). The collapse toggle
        // spans everything left of the badge cluster, hairline included.
        <div
          className={cn(
            "ade-lane-group-header z-10 w-full rounded-md select-none",
            stickyClass,
            isQuietLane && "opacity-60",
            busyLabel && "opacity-70",
          )}
          style={{ background: "var(--work-session-sidebar-bg, var(--work-sidebar-bg))" }}
          data-section-id={sectionId}
          data-lane-quiet={isQuietLane ? "true" : undefined}
          aria-busy={busyLabel ? "true" : undefined}
          onContextMenu={onContextMenu}
          // Drag lives on the header, NOT the wrapper: the wrapper is an
          // ancestor of every SessionCard, which is itself draggable for the
          // work-grid drop. The header is a sibling of the collapse body, so the
          // two drag sources never nest.
          {...(busyLabel ? {} : isLane ? dragProps ?? {} : {})}
          {...(heading
            ? { role: "heading" as const, "aria-level": 3, "aria-label": `${label} (${count})` }
            : {})}
        >
          <div className="relative flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-white/[0.03]">
            <button
              type="button"
              // `overflow-hidden` is load-bearing: without it, unshrinkable
              // children spill past the button's box and render on top of the
              // trailing PR badge / count cluster, which the sidebar then clips.
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden text-left"
              onClick={onToggleCollapsed}
              disabled={Boolean(busyLabel)}
              // Every variant of this row is a disclosure, so every variant says
              // so — the chevron beside it is deliberately silent to assistive
              // tech, which leaves this button as the only place the state is
              // announced.
              aria-expanded={!collapsed}
              {...(isQuietLane
                ? { "aria-label": `${label} (${count} quiet)` }
                : heading
                  ? { "aria-label": `${label} (${count})` }
                  : {})}
            >
              {icon}
              <span
                className={cn(
                  "min-w-0 shrink truncate leading-tight",
                  isLane
                    ? "ade-lane-group-header-lane ade-lane-branch-inline-lane text-[12px] font-medium text-fg/85"
                    // A quiet shelf ignores the shelf tone on purpose: colour is
                    // the lane divider's channel, and the whole reason Snoozed
                    // stopped being blue is that a coloured folding label with a
                    // rule was indistinguishable from a lane.
                    : isQuietShelf
                      ? cn("text-[10px]", QUIET_LABEL_CLASS)
                      : cn("text-[11px] font-medium", SHELF_TONE_LABEL_CLASS[tone]),
                )}
                style={laneLabelColor ? { color: laneLabelColor } : undefined}
                title={laneHeaderTitle}
              >
                {labelText}
              </span>
              {/* Branch sits immediately right of the label and expands to fill
                  whatever space is free, truncating only when it runs out. */}
              {showBranchCluster ? (
                <div
                  className="ade-lane-group-header-branch ade-lane-branch-inline-branch flex min-w-0 items-center gap-0.5 overflow-hidden"
                  style={{ color: "var(--color-muted-fg)" }}
                >
                  <BranchIcon size={10} weight="regular" className="shrink-0 opacity-55" />
                  <span className="min-w-0 truncate text-[10px] font-medium leading-tight text-muted-fg/70" title={branchText}>
                    {branchText}
                  </span>
                </div>
              ) : null}
              {/* The divider itself. It replaces the pill's border and fill: the
                  rule separates, the label names, and nothing paints a box.
                  A quiet shelf gets NO rule — it is already fenced off by the
                  heavier separator above the zone, and a second hairline here is
                  precisely what made it read as one more lane. */}
              {isQuietShelf ? (
                <span aria-hidden className="min-w-2 flex-1" />
              ) : (
                <span aria-hidden className={cn("h-px min-w-2 flex-1", SHELF_TONE_RULE_CLASS[tone])} />
              )}
            </button>
            {/* Trailing cluster. The machine marker and PR badge survive EVERY
                form of this row — quiet, collapsed, shelf — because "there is an
                open PR on this" is not redundant with the lane name. Counts live
                only in collapsed labels, never as a separate trailing element. */}
            <div className="flex shrink-0 items-center gap-1.5">
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
              {headerAction}
              {quietCounts && isQuietLane && quietCounts.snoozed > 0 ? (
                <span
                  className="flex items-center gap-0.5 text-[9px] font-medium tabular-nums text-muted-fg/40"
                  title={`${quietCounts.snoozed} snoozed`}
                >
                  <Moon size={9} weight="fill" aria-hidden />
                  {quietCounts.snoozed}
                </span>
              ) : null}
              {quietCounts && isQuietLane && quietCounts.settled > 0 ? (
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
              {chevron}
            </div>
            {busyLabel ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 rounded-md bg-bg/75 text-[10px] font-semibold uppercase tracking-wide text-muted-fg backdrop-blur-[1px]">
                <CircleNotch size={12} className="animate-spin" />
                {busyLabel}
              </div>
            ) : null}
          </div>
        </div>
      )}
      {/* Children slide out/retract smoothly; the header stays put (no reflow jump).
          A headerless group has no toggle to collapse it with, so it is always open. */}
      <AnimatePresence initial={false}>
        {(!collapsed || headerless) && count > 0 ? (
          <motion.div
            key="lane-group-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "hidden" }}
          >
            {/* The hierarchy cue. A grouped child is INDENTED and sits beside a
                rail running the full height of the group; a singleton's card
                stays flush-left with no rail at all. Without this the two were
                identical — same indent, same size — and the only thing telling
                them apart was a coloured dot in a header floating above.
                Indentation is the clearest cue available and the rail binds the
                rows into one object; a headerless group gets neither, because
                with no divider above it the lone card IS the group and inset
                rows under nothing would read as orphaned. */}
            <div
              className={cn(
                "relative",
                ROW_STACK_CLASS,
                isLane && !headerless && "mt-1 pl-2",
                // A shelf label is a section heading, not a peer of the rows
                // under it — but it had no gap at all, so the first row sat
                // flush against it. One row-gap (4px) is enough: the label is
                // already set apart by being uppercase, grey and letter-spaced,
                // and anything larger detaches it from what it labels.
                isQuietShelf && "mt-1",
                busyLabel && "pointer-events-none opacity-50",
              )}
              data-lane-group-body={sectionId}
              data-indented={isLane && !headerless ? "true" : undefined}
            >
              {isLane && !headerless ? (
                <span
                  aria-hidden
                  data-testid={`lane-group-rail-${sectionId}`}
                  // 4px keeps the rail centred in the tighter 8px
                  // child indent while staying visually tied to the glyph.
                  // tracks the lane glyph closely, so the group reads as
                  // hanging off its own header rather than off the pane edge.
                  className="pointer-events-none absolute bottom-0 left-1 top-0 w-px rounded-full"
                  style={{ background: laneRailTint(accentColor) }}
                />
              ) : null}
              {children}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

/*
 * The lane divider's PR badge is `LanePrBadge` (./LanePrBadge) — shared with
 * the singleton lane's card, which has no divider to hang it on.
 *
 * (`useLanePrsByLaneId` moved to ./useLanePrs so the Work session hook can
 * answer the "Has PR" chip filter from the same PR data that badge renders.)
 */
export const SessionListPane = React.memo(function SessionListPane({
  lanes: lanesProp,
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
  // The inline input is gone (search now opens the command palette), but the
  // query itself still drives every filter in this file and the setter stays in
  // the contract so the parent can keep restoring/clearing it.
  setQ: _setQ,
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
    /**
     * Set only for a singleton lane's card. That row has no lane divider above
     * it, so its session menu is the only surface left that can reach lane
     * management — the menu appends a lane section when this is present.
     */
    laneActions?: SessionContextMenuLaneActions | null,
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
  /**
   * Primary's accent is locked to ADE purple here, once, rather than at each of
   * the half-dozen places a lane colour is read: the header, the singleton
   * card's lane identity, the lane combobox and the shelves all take it from
   * this list, and a primary lane created before the colour was reserved still
   * stores null.
   */
  const lanes = useMemo(
    () => (lanesProp.some((lane) => lane.laneType === "primary")
      ? lanesProp.map((lane) => (
        lane.laneType === "primary" && lane.color !== resolveLaneAccentColor(lane)
          ? { ...lane, color: resolveLaneAccentColor(lane) }
          : lane
      ))
      : lanesProp),
    [lanesProp],
  );
  const prsByLaneId = useLanePrsByLaneId();
  const deleteProgressByLaneId = useAppStore((state) => state.laneDeleteProgressByLaneId);
  // Names the machine this tab's own lanes live on — this Mac, unless the tab is
  // bound to a remote runtime. Only read for the Primary machine badge.
  const projectBinding = useAppStore((state) => state.projectBinding);
  const keybindings = useAppStore((state) => state.keybindings);
  const commandPaletteBinding = useMemo(
    () => getEffectiveBinding(keybindings, "commandPalette.open", "Mod+K"),
    [keybindings],
  );
  const commandPaletteShortcut = useMemo(
    () => shortcutChipLabel(commandPaletteBinding),
    [commandPaletteBinding],
  );
  /**
   * The palette's `open` state lives in `AppShell`'s local state and has no
   * programmatic entry point — the only way in is the global `keydown` listener
   * AppShell installs for `commandPalette.open`. So the search button re-plays
   * exactly that key rather than reaching across the tree, and it plays the
   * user's OWN binding, so a rebound palette still opens from here.
   */
  const openCommandPalette = useCallback(() => {
    const combo = parsePrimaryCombo(commandPaletteBinding);
    if (!combo) return;
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: combo.key,
      ctrlKey: combo.ctrl,
      metaKey: combo.meta,
      altKey: combo.alt,
      shiftKey: combo.shift,
      bubbles: true,
      cancelable: true,
    }));
  }, [commandPaletteBinding]);
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
  //
  // Split per bucket, not just unioned: deciding WHICH bottom shelf a fully
  // quiet lane files into needs "all snoozed" and "all settled" separately.
  // Both come from `sessionFilingBucket`, which routes through
  // `isSessionFiledAsSnoozed` — so a lane where everything is snoozed but one
  // row has raised its hand is not snoozed here either, for free.
  const unfilteredQuietBuckets = useMemo(() => {
    const nowMs = Date.now();
    const snoozed = new Set<string>();
    const settled = new Set<string>();
    const all = new Set<string>();
    for (const session of allSessionsUnfiltered) {
      const bucket = sessionFilingBucket(session, nowMs);
      if (bucket === "snoozed") {
        snoozed.add(session.id);
        all.add(session.id);
      } else if (bucket === "settled") {
        settled.add(session.id);
        all.add(session.id);
      }
    }
    return { snoozed, settled, all };
    // Snooze expiry changes `snoozedFiltered`, forcing this full-roster
    // classification to re-evaluate even when the session array is reused.
  }, [allSessionsUnfiltered, snoozedFiltered]);
  const unfilteredQuietIdSet = unfilteredQuietBuckets.all;
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

  // Foreign lanes worth a row: ones with chats, after the same search, lane, and
  // chip filters the local list applies. Lanes elsewhere with nothing running
  // stay out of the sidebar — the union is about work in flight, not an inventory.
  //
  // Resolved before the lane ordering below because the Primary machine badge
  // counts VISIBLE primaries, foreign ones included, and a lane whose every chat
  // has been filtered out renders nothing and so must not count.
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
      // Another machine's Primary is still a Primary: it takes the same reserved
      // purple as this machine's, which is what makes "purple = Primary" hold
      // across the whole union.
      const lane = row.lane.laneType === "primary" && row.lane.color !== resolveLaneAccentColor(row.lane)
        ? { ...row.lane, color: resolveLaneAccentColor(row.lane) }
        : row.lane;
      rows.push(sessions === row.sessions && lane === row.lane ? row : { ...row, lane, sessions });
    }
    return rows.length > 0 ? rows : EMPTY_FOREIGN_ROWS;
  }, [chipFiltersActive, foreignRows, laneFilterActive, normalizedFilterLaneId, q, workSessionFilters]);

  /**
   * Which shelf a CROSS-MACHINE lane files into, or null to stay in the inbox.
   *
   * The shelving rule has to be one rule — "a lane whose sessions are all quiet
   * goes to the shelf" — or it silently becomes "…unless the work happens to
   * live on another machine", which is exactly the bug this fixes. So the quiet
   * test is not re-implemented here: `partitionQuietSessions` runs the same
   * `sessionFilingBucket` derivation the local path runs through, which is what
   * gives foreign lanes the yield-to-`needs_you` and settled-beats-ended
   * precedence for free.
   *
   * Offline is deliberately NOT consulted. A dropped machine's rows can still
   * report "running" — that is only the last thing that machine said before it
   * went away — so reachability is orthogonal to whether the work is done.
   * Both halves of that:
   *   - offline must not BLOCK a demotion: if every row is quiet the lane files
   *     exactly as it would with the machine awake, because the sleeping Mac
   *     has no opinion about work already settled;
   *   - offline must not FORCE one either: a row last reported as running keeps
   *     its lane upstairs. Hence this reads `quiet.active` rather than
   *     `foreignRowHasLiveWork`, which folds `online` in on purpose — but only
   *     for the COLLAPSE default, where "unreachable" really does mean "not
   *     live right now".
   *
   * Recomputed per render rather than memoized, like the partition it replaced:
   * quietness is a function of `Date.now()` (snooze windows lapse), and a memo
   * keyed on the row array would keep serving a verdict taken before expiry.
   */
  const foreignLaneShelving: ForeignLaneEntry[] = visibleForeignRows.map((row) => {
    const compositeLaneId = `${row.machineId}:${row.lane.id}`;
    const quiet = partitionQuietSessions(row.sessions);
    const shelf = ((): "snoozed" | "settled" | null => {
      // The same two exemptions `laneShelfByLaneId` grants. A pin is an explicit
      // "keep this where I can see it"; a Primary is the column's fixed landmark
      // and must not migrate to the bottom on a quiet afternoon. Both pin keys
      // are checked because a foreign lane is addressed by its composite id
      // everywhere in this pane, while the pin store only ever writes lane ids.
      if (workPinnedLaneIdSet.has(compositeLaneId) || workPinnedLaneIdSet.has(row.lane.id)) return null;
      if (row.lane.laneType === "primary") return null;
      if (row.sessions.length === 0 || quiet.active.length > 0) return null;
      const quietRows = quiet.snoozed.length + quiet.settled.length;
      if (quietRows === 0) return null;
      // Dominant kind, ties to Snoozed — the more visible shelf. Identical to
      // the local rule, and safe for the same reason: the body renders flat and
      // every card still states its own status.
      return quiet.settled.length > quiet.snoozed.length ? "settled" : "snoozed";
    })();
    return { row, compositeLaneId, quiet, shelf };
  });

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

  /**
   * The Primary machine badge, or null.
   *
   * Every ADE machine has a Primary, so with two machines connected the sidebar
   * shows two lanes called "Primary" in the same purple and neither says which
   * machine it is. Foreign ones already answer that through `LaneMachineMarker`;
   * the LOCAL one has no marker at all, because "not here" is the only thing the
   * marker normally means.
   *
   * So this follows `LaneMachineMarker`'s own adaptive rule rather than inventing
   * a parallel mechanism: promote the machine name only when the row would
   * otherwise be ambiguous. One Primary on screen — the overwhelmingly common
   * case — is unambiguous and pays nothing.
   *
   * "This machine" is the machine the tab is BOUND to, which is not necessarily
   * this Mac: a remote-bound tab's local list is that runtime's lanes.
   */
  const primaryLaneMachineMarker = useMemo((): CrossMachineLaneMarker | null => {
    const localPrimaries = orderedLanes.filter((lane) => lane.laneType === "primary").length;
    if (localPrimaries === 0) return null;
    const foreignPrimaries = visibleForeignRows
      .filter((row) => row.lane.laneType === "primary").length;
    if (localPrimaries + foreignPrimaries < 2) return null;
    const remote = projectBinding?.kind === "remote" ? projectBinding : null;
    return {
      machineId: remote?.targetId ?? THIS_MACHINE_ID,
      machineName: remote?.runtimeName ?? THIS_MACHINE_NAME,
      online: true,
      mode: "name",
      title: remote?.runtimeName ?? THIS_MACHINE_NAME,
      sameBranchElsewhere: false,
    };
  }, [orderedLanes, projectBinding, visibleForeignRows]);

  /**
   * Which bottom shelf a fully-quiet lane files into, or null to stay in place.
   *
   * A lane whose rows are ALL settled belongs under Settled; one whose rows are
   * ALL snoozed belongs under Snoozed, which sits above it. A lane mixing the
   * two quiet kinds files by the DOMINANT kind rather than staying upstairs:
   * it is fully quiet either way, so leaving it in the inbox spends a prime row
   * on work nobody is waiting for, and the shelf is only a filing decision —
   * its rows render flat (see `renderLaneSessionLists`) and each one still
   * states its own status, so the minority kind is never mislabelled. A tie
   * goes to Snoozed, the more visible of the two shelves.
   *
   * A lane that is quiet only in part is untouched here: `isLaneQuiet` gates
   * every demotion, so anything holding live or asking work keeps its place and
   * its in-lane tails.
   *
   * Read from the unfiltered roster for the same reason `isLaneQuiet` is: the
   * shelf a lane lives on must not change as the user types in search.
   */
  // Memoized rather than recomputed per call: this list re-renders on every
  // session tick, and the shelf split is read once per lane per section.
  const laneShelfByLaneId = useMemo(() => {
    const map = new Map<string, "snoozed" | "settled">();
    for (const [laneId, roster] of unfilteredSessionsByLane) {
      // A pin is an explicit "keep this where I can see it", which outranks
      // every automatic demotion — the same exemption the quiet header grants.
      if (workPinnedLaneIdSet.has(laneId)) continue;
      // Primary is pinned to the very top of the column, above every tier. A
      // shelf demotion would move it to the bottom on a quiet afternoon, which
      // is exactly the fixed landmark this lane is supposed to be.
      if (laneById.get(laneId)?.laneType === "primary") continue;
      if (roster.length === 0 || !isLaneQuiet(laneId)) continue;
      let snoozedRows = 0;
      let settledRows = 0;
      for (const session of roster) {
        if (unfilteredQuietBuckets.settled.has(session.id)) settledRows += 1;
        else if (unfilteredQuietBuckets.snoozed.has(session.id)) snoozedRows += 1;
      }
      if (snoozedRows + settledRows === 0) continue;
      map.set(laneId, settledRows > snoozedRows ? "settled" : "snoozed");
    }
    return map;
  }, [isLaneQuiet, laneById, unfilteredQuietBuckets, unfilteredSessionsByLane, workPinnedLaneIdSet]);
  const laneShelfFor = useCallback(
    (laneId: string): "snoozed" | "settled" | null => laneShelfByLaneId.get(laneId) ?? null,
    [laneShelfByLaneId],
  );

  /**
   * Lanes that render their group WITHOUT a divider — the singleton form.
   *
   * One chat per lane is the common workflow, and it used to produce
   * divider/card/divider/card with the lane name usually duplicating the chat
   * title. The lone card carries the lane identity instead (`showLaneIdentity`).
   *
   * Four rules keep the threshold from jittering:
   *   1. It reads the UNFILTERED roster, so the column does not reshape while
   *      the user types in search — same precedent as `isLaneQuiet`.
   *   2. It counts TOP-LEVEL rows only. A chat with terminal-drawer children is
   *      one unit and must not summon a divider.
   *   3. Manual sort opts out entirely: a singleton has no header to grab, and
   *      the card's drag gesture is already claimed by the work-grid DnD.
   *   4. A pending handoff placeholder counts as a second row, so a lane does
   *      not lose its header for the second it takes the real session to land.
   * A pinned lane also keeps its header — the pin glyph lives there. So does a
   * Primary that is currently showing a machine badge: the badge hangs off the
   * header, and dropping the header would drop the one thing distinguishing two
   * identically-named, identically-coloured Primaries.
   */
  const headerlessLaneIds = useMemo(() => {
    const ids = new Set<string>();
    if (workLaneSortMode === "manual") return ids;
    for (const lane of orderedLanes) {
      if (workPinnedLaneIdSet.has(lane.id)) continue;
      if (lane.laneType === "primary" && primaryLaneMachineMarker) continue;
      if ((unfilteredHandoffCountByLaneId.get(lane.id) ?? 0) > 0) continue;
      const roster = unfilteredSessionsByLane.get(lane.id) ?? [];
      const rosterIds = new Set(roster.map((session) => session.id));
      const topLevel = roster.filter((session) => {
        const parentId = session.chatSessionId;
        return !(parentId && parentId !== session.id && rosterIds.has(parentId));
      });
      if (topLevel.length === 1) ids.add(lane.id);
    }
    return ids;
  }, [
    orderedLanes,
    primaryLaneMachineMarker,
    unfilteredHandoffCountByLaneId,
    unfilteredSessionsByLane,
    workLaneSortMode,
    workPinnedLaneIdSet,
  ]);

  // Cheap order signature for the sink animation: without it `layout` would
  // re-measure every lane on every session tick, and this list ticks constantly.
  // Headerlessness is part of the signature because gaining a header is exactly
  // the moment the rows below must slide rather than snap.
  const laneOrderSignature = useMemo(
    () => orderedLanes
      .map((lane) => `${lane.id}${headerlessLaneIds.has(lane.id) ? "~" : ""}`)
      .join(","),
    [headerlessLaneIds, orderedLanes],
  );
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
        const shelf = laneShelfFor(lane.id);
        if (shelf && isQuietShelfCollapsed(workCollapsedSectionIds, `lane-shelf:${shelf}`)) continue;
        const list = sessionsGroupedByLane?.get(lane.id) ?? [];
        if (headerlessLaneIds.has(lane.id)) {
          // No header means no collapse toggle and no quiet tail: the one row is
          // always on screen, so it is always in range-selection order.
          ids.push(...collectVisibleIds(list));
          continue;
        }
        if (shelf) {
          // A shelf lane renders flat, so there is no per-tail marker to consult:
          // once its own quiet header is expanded, every row in it is on screen.
          // (Quiet lanes record only the explicit expand, hence `lane-open:`.)
          if (!workCollapsedSectionIds.includes(`lane-open:${lane.id}`)) continue;
          ids.push(...collectVisibleIds(list));
          continue;
        }
        if (workCollapsedLaneIds.includes(lane.id)) continue;
        ids.push(...laneVisibleIds(lane.id, list));
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
      if (!isQuietShelfCollapsed(workCollapsedSectionIds, "status:snoozed")) ids.push(...collectVisibleIds(visibleSnoozed));
      if (!isQuietShelfCollapsed(workCollapsedSectionIds, "status:settled")) ids.push(...collectVisibleIds(visibleSettled));
      return ids;
    }
    const ids: string[] = [];
    if (!workCollapsedSectionIds.includes("status:running")) ids.push(...collectVisibleIds(runningFiltered));
    if (!workCollapsedSectionIds.includes("status:awaiting")) ids.push(...collectVisibleIds(awaitingInputFiltered));
    if (!workCollapsedSectionIds.includes("status:ended")) ids.push(...collectVisibleIds(endedFiltered));
    if (!isQuietShelfCollapsed(workCollapsedSectionIds, "status:snoozed")) ids.push(...collectVisibleIds(visibleSnoozed));
    if (!isQuietShelfCollapsed(workCollapsedSectionIds, "status:settled")) ids.push(...collectVisibleIds(visibleSettled));
    return ids;
  }, [
    awaitingInputFiltered,
    collectVisibleIds,
    endedFiltered,
    headerlessLaneIds,
    isByLane,
    isByTime,
    laneShelfFor,
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
    /**
     * Set only where the lane's divider was omitted (the singleton form). The
     * card then leads its "where" slot with the lane accent + name, so the lane
     * identity the header used to carry is not simply lost.
     */
    showLaneIdentity?: boolean;
    /**
     * The other two things the omitted divider used to carry: its PR badge and
     * its context menu. Both ride along with `showLaneIdentity` so a singleton
     * lane loses no capability, only chrome.
     */
    lanePr?: PrSummary | null;
    laneActions?: SessionContextMenuLaneActions | null;
    /**
     * Set for cards rendered UNDER a lane header that already shows a machine
     * marker. Every row in that group is on that machine by construction, so the
     * row's own chip is the header's label repeated once per card. Never set for
     * the singleton/headerless form: with no header above it, the chip is the
     * only place the machine is named at all.
     */
    suppressMachineChip?: boolean;
  };
  const renderCardCore = (session: TerminalSessionSummary, options?: RenderCardOptions) => {
    const isFirst = !sessionItemAnchorEmitted;
    if (isFirst) sessionItemAnchorEmitted = true;
    const foreignRow = options?.foreignRow;
    // A card on an unreachable machine is shown as last reported and every
    // action on it would fail, so it is inert and says which machine is gone.
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
          onContextMenu(
            session,
            e,
            foreignRow?.binding,
            foreignRow?.machineName,
            options?.laneActions,
          );
        }}
        compact={options?.compact}
        showLaneIdentity={options?.showLaneIdentity}
        lanePr={options?.lanePr}
        gridBadge={foreignRow ? null : gridBadgeFor(session.id)}
        runtimePin={foreignRow?.binding}
        suppressMachineChip={options?.suppressMachineChip}
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
      // `data-indented` for the card's bleed rule, same as a lane group body:
      // these rows hang off their own rail, so a left bleed would cross it.
      <div
        key={`children-${parentId}`}
        className="ml-3 mt-1 border-l border-white/[0.06] pl-1.5"
        data-indented="true"
      >
        <button
          type="button"
          onClick={() => toggleChildSection(parentId)}
          className={cn(
            "flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[9px] transition-colors hover:bg-white/[0.03] hover:text-muted-fg/70",
            QUIET_LABEL_CLASS,
          )}
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
          <div className={cn(ROW_STACK_CLASS, "mt-1")}>
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
      // The in-lane tail is the quiet shelf's idiom one step down: same uppercase
      // grey label with no rule, smaller, so "quiet" reads the same everywhere
      // while staying subordinate inside its group.
      <div className="mt-1">
        <button
          type="button"
          onClick={() => toggleWorkSectionCollapsed(openMarker)}
          className={cn(
            "flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[9px] transition-colors hover:bg-white/[0.03] hover:text-muted-fg/70",
            QUIET_LABEL_CLASS,
          )}
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
        {!collapsed ? <div className={cn(ROW_STACK_CLASS, "mt-1")}>{renderCards(list, options)}</div> : null}
      </div>
    );
  };

  /**
   * Lane folder body: active rows first, then quiet collapsible snoozed and
   * settled tails so hidden work stays openable in-stream without occupying the
   * folder's prime rows.
   *
   * `flat` drops the tails entirely — see below; it is set only for lanes that
   * already live inside a quiet shelf.
   */
  const renderLaneSessionLists = (
    laneKey: string,
    list: TerminalSessionSummary[],
    options?: { quiet?: boolean; flat?: boolean; cardOptions?: RenderCardOptions },
  ) => {
    const cardOptions = options?.cardOptions;
    // An expanded quiet lane holds nothing but quiet rows, so render them
    // compact — the full card's preview line and meta row are all about work in
    // flight, which by definition there isn't any of here.
    if (options?.flat) {
      // Inside the Snoozed/Settled shelf, and therefore flat. The shelf header
      // already asserts the state of everything beneath it, so re-grouping the
      // same rows under a per-lane SETTLED/SNOOZED label repeats the one fact
      // the user already has — and a disclosure level that reveals a LABEL
      // rather than content is a level that should not exist. It cost three
      // expands (shelf → lane → subsection) to reach a row whose state was
      // stated at the first one. Expanding the lane now shows its sessions.
      //
      // A lane that mixes both quiet kinds renders flat here too: it was filed
      // by its dominant kind (`laneShelfByLaneId`) and each card still carries
      // its own status, so the minority rows are labelled, not mislabelled.
      return <>{renderCards(list, { compact: true, ...cardOptions })}</>;
    }
    const active = list.filter((session) => !quietIdSet.has(session.id));
    const snoozed = list.filter((session) => snoozedIdSet.has(session.id));
    const settled = list.filter((session) => settledIdSet.has(session.id));
    // A lane that stayed upstairs is genuinely mixed — quiet rows AND live ones
    // — which is exactly where the subsection carries information, so its tails
    // are untouched.
    const tailOptions = options?.quiet || cardOptions
      ? { ...(options?.quiet ? { compact: true } : {}), ...cardOptions }
      : undefined;
    return (
      <>
        {renderCards(active, cardOptions)}
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
      if (
        foreignRow
        && foreignRowHasLiveWork(foreignRow, partitionQuietSessions(foreignRow.sessions).active)
      ) {
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

  /**
   * The quiet region at the foot of the column.
   *
   * ONE heavier rule fences the whole zone off, and the shelves inside it carry
   * none of their own. That is the separation that was missing: a lane divider
   * and a Snoozed/Settled row used to be the same shape — hairline, chevron,
   * coloured label — in a list that has both, so neither could be read at a
   * glance. Now the rule says "below here is quiet" once, and everything inside
   * is grey uppercase with no rule at all.
   */
  const renderQuietZone = (present: boolean, children: React.ReactNode) => (present ? (
    <div className={QUIET_ZONE_STACK_CLASS} data-testid="work-quiet-zone">
      <div aria-hidden data-testid="work-quiet-zone-separator" className="h-px bg-white/[0.13]" />
      {children}
    </div>
  ) : null);

  // Snoozed sits directly ABOVE Settled: hidden-for-now ranks above done.
  const snoozedStatusSection = visibleSnoozed.length > 0 ? (
    <StickyGroupHeader
      sectionId="status:snoozed"
      icon={snoozedSectionIcon}
      label="Snoozed"
      variant="quiet-shelf"
      tone="snoozed"
      heading
      count={visibleSnoozed.length}
      // Collapsed unless explicitly opened — see `quietShelfOpenMarker`.
      collapsed={isQuietShelfCollapsed(workCollapsedSectionIds, "status:snoozed")}
      onToggleCollapsed={() => toggleWorkSectionCollapsed(quietShelfOpenMarker("status:snoozed"))}
    >
      {renderCards(visibleSnoozed)}
    </StickyGroupHeader>
  ) : null;

  const settledStatusSection = visibleSettled.length > 0 ? (
    <StickyGroupHeader
      sectionId="status:settled"
      icon={settledSectionIcon}
      label="Settled"
      variant="quiet-shelf"
      tone="settled"
      count={visibleSettled.length}
      collapsed={isQuietShelfCollapsed(workCollapsedSectionIds, "status:settled")}
      onToggleCollapsed={() => toggleWorkSectionCollapsed(quietShelfOpenMarker("status:settled"))}
    >
      {renderCards(visibleSettled)}
    </StickyGroupHeader>
  ) : null;

  const groupedByStatusList = (
    // Single rhythm, container-owned (see StickyGroupHeader): with the borders
    // gone, whitespace IS the grouping, so the gap between groups is the large
    // one and active and quiet groups get the SAME air.
    <div className={cn(GROUP_STACK_CLASS, SESSION_LIST_BLEED_CLASS, "px-1 pb-2")}>
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
      {renderQuietZone(visibleSnoozed.length + visibleSettled.length > 0, (
        <>
          {snoozedStatusSection}
          {settledStatusSection}
        </>
      ))}
    </div>
  );

  // "No sessions" must not claim an empty machine when another machine is busy.
  const hasForeignSessions = visibleForeignRows.length > 0;

  const renderLaneGroup = (lane: LaneSummary) => {
    const list = sessionsGroupedByLane?.get(lane.id) ?? [];
    const laneHandoffJobs = handoffJobsByLaneId.get(lane.id) ?? [];
    const lanePinned = workPinnedLaneIdSet.has(lane.id);
    // A pinned lane keeps the full header even when everything in it has
    // settled; only its position is exempt from the sink.
    const laneQuiet = isLaneQuiet(lane.id) && !lanePinned;
    const deleteProgress = deleteProgressByLaneId[lane.id] ?? null;
    // A lane being torn down keeps its divider: the busy overlay lives on the
    // header, and "Deleting lane" is the one thing worth reading at that moment.
    const headerless = headerlessLaneIds.has(lane.id) && !deleteProgress;
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
      <LanePrBadge pr={primaryPr} onOpen={() => navigate(lanePrDeepLinkPath(primaryPr))} />
    ) : null;
    // Never populated for a lane on this machine — the marker exists only to
    // say "this work isn't here". The one exception is a Primary competing with
    // another machine's Primary, where naming THIS machine is the only thing
    // that disambiguates the pair (see `primaryLaneMachineMarker`).
    const resolvedMachineMarker = markersByLaneId.get(lane.id)
      ?? (lane.laneType === "primary" ? primaryLaneMachineMarker : null);
    const machineMarker = resolvedMachineMarker
      ? {
          ...resolvedMachineMarker,
          mode: lane.laneType === "primary" ? "name" as const : "glyph" as const,
        }
      : null;
    // Both marker sources count: the cross-machine marker and the local-Primary
    // badge say the same thing to the reader, so either one makes the rows'
    // own machine chips a repetition. A headerless lane keeps its chip — there
    // is no header above it doing the naming.
    const suppressMachineChip = Boolean(machineMarker) && !headerless;
    // A lane already filed into a quiet shelf renders its rows flat: the shelf
    // states the tier once, for everything under it.
    const inQuietShelf = laneShelfFor(lane.id) !== null;
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
        headerless={headerless}
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
        {headerless
          // A singleton skips the snoozed/settled tails entirely: wrapping one
          // row in a "1 settled" disclosure under no header is more chrome than
          // the row it hides, and the shelf this group files into already says
          // which tier it is in.
          //
          // The lone card inherits everything the divider would have carried:
          // the lane identity, the PR badge, and — via the session context menu
          // — the lane menu, which would otherwise have no right-click target.
          ? renderCards(list, {
              showLaneIdentity: true,
              lanePr: primaryPr,
              laneActions: {
                laneId: lane.id,
                laneName: lane.name,
                // Anchored at the session menu's own position, so the lane menu
                // opens where the user right-clicked rather than jumping.
                open: ({ x, y }) => triggerLaneContextMenu(lane.id, {
                  preventDefault: () => {},
                  clientX: x,
                  clientY: y,
                }),
              },
            })
          : renderLaneSessionLists(lane.id, list, {
              quiet: laneQuiet,
              flat: inQuietShelf,
              cardOptions: suppressMachineChip ? { suppressMachineChip: true } : undefined,
            })}
      </StickyGroupHeader>
    );
  };

  /**
   * The cross-machine counterpart of `renderLaneGroup`. One function, called
   * from the main list AND from both shelves, so a foreign lane is filed by the
   * same rule and rendered in the same shape wherever it ends up — the two
   * render paths used to be separate, which is why a foreign lane could never
   * shelve at all.
   */
  const renderForeignLaneGroup = (entry: ForeignLaneEntry) => {
    const { row, compositeLaneId, quiet, shelf } = entry;
    const marker = markersByLaneId.get(compositeLaneId) ?? null;
    // Primary is the only lane whose machine NAME is promoted permanently.
    // Every machine owns a Primary, so an icon alone leaves otherwise identical
    // headers ambiguous. Other lane headers keep the adaptive glyph/name marker
    // chosen by the cross-machine union.
    const headerMarker: CrossMachineLaneMarker | null = row.lane.laneType === "primary"
      ? {
          machineId: row.machineId,
          machineName: row.machineName,
          online: row.online,
          mode: "name",
          title: row.machineName,
          sameBranchElsewhere: marker?.sameBranchElsewhere ?? false,
        }
      : marker
        ? { ...marker, mode: "glyph" }
        : null;
    // An offline machine's group folds shut like a quiet one: retained and
    // inspectable, not presented as live work. Note this is NOT the shelving
    // test (see `foreignLaneShelving`) — an offline machine's last-reported
    // running row collapses the group but keeps the lane in the inbox.
    const laneQuiet = !foreignRowHasLiveWork(row, quiet.active);
    const laneOpenMarker = `lane-open:${compositeLaneId}`;
    const collapsed = laneQuiet
      ? !workCollapsedSectionIds.includes(laneOpenMarker)
      : workCollapsedLaneIds.includes(compositeLaneId);
    // A shelved lane shows nothing but its header, so the header has to keep
    // carrying everything that identifies the lane — the machine marker below,
    // and the PR badge here. PR records are local to this runtime, so a lane
    // that exists only elsewhere simply has none; when the local runtime does
    // know the lane's PR, it is the same lane and the same badge.
    const primaryPr = selectPrimaryLanePr(row.lane, prsByLaneId.get(row.lane.id) ?? []);
    // A foreign group always has a header, so its sessions never repeat machine
    // identity. Primary spells the name out on the rail; other lanes retain the
    // compact header marker when the cross-machine resolver says one is useful.
    const cardOptions: RenderCardOptions = { foreignRow: row, suppressMachineChip: true };
    return (
      <StickyGroupHeader
        key={compositeLaneId}
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
        prBadge={primaryPr ? (
          <LanePrBadge pr={primaryPr} onOpen={() => navigate(lanePrDeepLinkPath(primaryPr))} />
        ) : null}
        machineMarker={headerMarker ? <LaneMachineMarker marker={headerMarker} /> : null}
        quietCounts={laneQuiet && collapsed
          ? {
              snoozed: quiet.snoozed.length,
              settled: quiet.settled.length,
            }
          : null}
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
            row.machineId,
            event,
          )
          : undefined}
      >
        {shelf
          // Inside a shelf, and therefore flat — the same rule as
          // `renderLaneSessionLists`'s `flat` branch: the shelf header already
          // states the tier for everything under it, so a further per-lane
          // SNOOZED/SETTLED disclosure would reveal a label rather than content.
          ? renderCards(row.sessions, { compact: true, ...cardOptions })
          : (
            <>
              {renderCards(quiet.active, cardOptions)}
              {renderLaneQuietTail(
                `snoozed-open:${compositeLaneId}`,
                snoozedSectionIcon,
                "snoozed",
                quiet.snoozed,
                { compact: laneQuiet, ...cardOptions },
              )}
              {renderLaneQuietTail(
                `settled-open:${compositeLaneId}`,
                settledSectionIcon,
                "settled",
                quiet.settled,
                { compact: laneQuiet, ...cardOptions },
              )}
            </>
          )}
      </StickyGroupHeader>
    );
  };

  /**
   * Fully-quiet lanes leave the inbox for a shelf at the bottom, in t3's order:
   * inbox → Snoozed → Settled. A lane is demoted only when EVERY row agrees on
   * one tier (`laneShelfFor`); anything mixed keeps its place upstairs.
   *
   * Cross-machine lanes split the same three ways (`foreignLaneShelving`) and
   * join the same three destinations: the shelf is about how quiet the work is,
   * never about which machine it happens to be sitting on.
   */
  const snoozedShelfLanes = orderedLanes.filter((lane) => laneShelfFor(lane.id) === "snoozed");
  const settledShelfLanes = orderedLanes.filter((lane) => laneShelfFor(lane.id) === "settled");
  const mainLanes = orderedLanes.filter((lane) => laneShelfFor(lane.id) === null);
  const mainForeignRows = foreignLaneShelving.filter((entry) => entry.shelf === null);
  const snoozedShelfForeignRows = foreignLaneShelving.filter((entry) => entry.shelf === "snoozed");
  const settledShelfForeignRows = foreignLaneShelving.filter((entry) => entry.shelf === "settled");
  // A lane filtered down to nothing renders nothing, so it must not inflate the
  // shelf's count either. Foreign rows need no such guard: `visibleForeignRows`
  // has already dropped any row the filters emptied out.
  const shelfLaneCount = (laneList: LaneSummary[]) => laneList.filter(
    (lane) => (sessionsGroupedByLane?.get(lane.id)?.length ?? 0)
      + (handoffJobsByLaneId.get(lane.id)?.length ?? 0) > 0,
  ).length;
  const snoozedShelfCount = shelfLaneCount(snoozedShelfLanes) + snoozedShelfForeignRows.length;
  const settledShelfCount = shelfLaneCount(settledShelfLanes) + settledShelfForeignRows.length;

  /**
   * Is this shelved row actually showing cards? A shelved lane is quiet by
   * construction, so its collapse state is the explicit-expand marker (the same
   * rule `renderLaneGroup`/`renderForeignLaneGroup` apply). A headerless
   * singleton is "open", but it is one flat card with no header above it — a
   * row, not a group — so it keeps the row rhythm.
   */
  const isShelfRowExpanded = (rowId: string, headerless = false) => (
    !headerless && workCollapsedSectionIds.includes(`lane-open:${rowId}`)
  );
  /** Wraps a shelf child so the gap around it can depend on its own state. */
  const shelfRow = (rowId: string, expanded: boolean, node: React.ReactNode) => (
    <div
      key={rowId}
      data-shelf-row={rowId}
      data-shelf-row-expanded={expanded ? "true" : undefined}
      className={expanded ? SHELF_EXPANDED_ROW_CLASS : undefined}
    >
      {node}
    </div>
  );

  const byLaneList = (
    // `pb-2` matches the status/time stacks: the quiet zone closes this column,
    // so any extra bottom padding reads as dead space under the last shelf row
    // rather than as the deliberate breathing room above the footer rule.
    <div className={cn(GROUP_STACK_CLASS, SESSION_LIST_BLEED_CLASS, "px-1 pb-2")}>
      {mainLanes.map(renderLaneGroup)}
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
      {mainForeignRows.map(renderForeignLaneGroup)}
      {/* The two shelves close the column, hidden-for-now above done, inside the
          quiet zone's single heavier rule. A demoted lane keeps its group — a
          quiet header, or none at all for a singleton — so it is filed, not
          flattened; only its BODY goes flat, because the shelf above it has
          already said what tier every row in it is in. */}
      {renderQuietZone(
        snoozedShelfCount + settledShelfCount > 0,
        (
          <>
            <StickyGroupHeader
              sectionId="lane-shelf:snoozed"
              icon={snoozedSectionIcon}
              label="Snoozed"
              variant="quiet-shelf"
              tone="snoozed"
              heading
              count={snoozedShelfCount}
              // Collapsed unless explicitly opened — see `quietShelfOpenMarker`.
              collapsed={isQuietShelfCollapsed(workCollapsedSectionIds, "lane-shelf:snoozed")}
              onToggleCollapsed={() => toggleWorkSectionCollapsed(quietShelfOpenMarker("lane-shelf:snoozed"))}
            >
              {/* Row rhythm, not group rhythm — see `SHELF_BODY_STACK_CLASS`;
                  a collapsed shelved lane is a one-line row and only an
                  expanded one earns the group gap. Local lanes first, then
                  cross-machine ones — the shelf is one list, but "here" still
                  reads before "elsewhere". */}
              <div className={SHELF_BODY_STACK_CLASS} data-testid="shelf-body-snoozed">
                {snoozedShelfLanes.map((lane) => shelfRow(
                  lane.id,
                  isShelfRowExpanded(lane.id, headerlessLaneIds.has(lane.id)),
                  renderLaneGroup(lane),
                ))}
                {snoozedShelfForeignRows.map((entry) => shelfRow(
                  entry.compositeLaneId,
                  isShelfRowExpanded(entry.compositeLaneId),
                  renderForeignLaneGroup(entry),
                ))}
              </div>
            </StickyGroupHeader>
            <StickyGroupHeader
              sectionId="lane-shelf:settled"
              icon={settledSectionIcon}
              label="Settled"
              variant="quiet-shelf"
              tone="settled"
              heading
              count={settledShelfCount}
              collapsed={isQuietShelfCollapsed(workCollapsedSectionIds, "lane-shelf:settled")}
              onToggleCollapsed={() => toggleWorkSectionCollapsed(quietShelfOpenMarker("lane-shelf:settled"))}
            >
              <div className={SHELF_BODY_STACK_CLASS} data-testid="shelf-body-settled">
                {settledShelfLanes.map((lane) => shelfRow(
                  lane.id,
                  isShelfRowExpanded(lane.id, headerlessLaneIds.has(lane.id)),
                  renderLaneGroup(lane),
                ))}
                {settledShelfForeignRows.map((entry) => shelfRow(
                  entry.compositeLaneId,
                  isShelfRowExpanded(entry.compositeLaneId),
                  renderForeignLaneGroup(entry),
                ))}
              </div>
            </StickyGroupHeader>
          </>
        ),
      )}
    </div>
  );

  const byTimeList = (
    <div className={cn(GROUP_STACK_CLASS, SESSION_LIST_BLEED_CLASS, "px-1 pb-2")}>
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
      {renderQuietZone(visibleSnoozed.length + visibleSettled.length > 0, (
        <>
          {snoozedStatusSection}
          {settledStatusSection}
        </>
      ))}
    </div>
  );

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      style={{ background: "var(--work-session-sidebar-bg, var(--work-sidebar-bg))" }}
    >
      {/* Compact toolbar */}
      <div className="ade-session-list-toolbar shrink-0 border-b border-white/[0.06]">
        {/* Three borderless controls and no rule beneath them. The strip used to
            spend four boundaries — input, funnel, outlined button, divider —
            before the first chat, which left hover nothing to say. */}
        <div
          className="ade-session-list-toolbar-row flex h-8 min-w-0 items-center gap-1 overflow-hidden px-2"
          data-testid="work-session-list-header"
        >
          <SmartTooltip
            content={{
              label: "Search",
              description: "Open the command palette to search chats, lanes, files, and commands.",
              shortcut: commandPaletteShortcut ?? undefined,
            }}
            wrapperClassName="ade-session-list-toolbar-search min-w-0 flex-1"
            wrapperStyle={{ display: "flex" }}
          >
            <button
              type="button"
              className={cn(SIDEBAR_BARE_BUTTON_CLASS, "h-6 min-w-0 flex-1 px-1.5 text-[11px]")}
              onClick={openCommandPalette}
              aria-label="Search chats and commands"
              data-testid="work-sidebar-search"
            >
              <MagnifyingGlass size={12} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left">Search</span>
              {commandPaletteShortcut ? (
                <kbd className="shrink-0 rounded-sm bg-white/[0.05] px-1 py-px text-[9px] font-medium text-muted-fg/60">
                  {commandPaletteShortcut}
                </kbd>
              ) : null}
            </button>
          </SmartTooltip>
          <SmartTooltip content={{ label: "Filters", description: "Toggle the filter panel to organize sessions by lane or time." }}>
            <button
              type="button"
              className={cn(
                SIDEBAR_BARE_BUTTON_CLASS,
                "ade-session-list-toolbar-filter relative h-6 w-6 shrink-0 justify-center",
                (filterOpen || laneFilterActive) && "bg-white/[0.04] text-fg",
              )}
              onClick={() => setFilterOpen(!filterOpen)}
              aria-label={laneFilterActive ? "Filters, lane filter active" : "Filters"}
              data-tour="work.laneFilter"
            >
              <Funnel size={13} weight={filterOpen ? "fill" : "regular"} />
              {laneFilterActive || chipFiltersActive ? (
                <span
                  data-testid="work-lane-filter-active-indicator"
                  className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] shadow-[0_0_8px_var(--color-accent)]"
                />
              ) : null}
            </button>
          </SmartTooltip>
          <SmartTooltip content={{ label: "New chat", description: "Start a new AI chat session." }}>
            <button
              type="button"
              className={cn(
                SIDEBAR_BARE_BUTTON_CLASS,
                "ade-session-list-toolbar-new-chat h-6 w-6 shrink-0 justify-center",
              )}
              onClick={() => onShowDraftKind("chat")}
              aria-label="Start a new chat"
              data-tour="work.newSession"
            >
              <NotePencil size={13} weight="regular" />
            </button>
          </SmartTooltip>
        </div>

        {/* Expandable filter panel */}
        {filterOpen ? (
          <div className="ade-chat-drawer-glass mx-2 mt-1.5 mb-1.5 space-y-1.5 p-2">
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
          <div
            className="mx-2 mt-1.5 mb-1.5 flex min-h-8 flex-wrap items-center gap-0.5 border-t border-white/[0.06] px-1 py-0.5"
            data-testid="work-session-selection-toolbar"
          >
            <span className="min-w-0 flex-1 truncate px-1 text-[10px] font-medium tabular-nums text-muted-fg/70">
              {selectedCount} selected
            </span>
            {selectedRunningCount > 0 ? (
              <SmartTooltip content={{ label: "Stop runtimes", description: "Terminate selected running CLI and shell processes." }}>
                <button
                  type="button"
                  className={BULK_ACTION_BUTTON_CLASS}
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
                  className={BULK_ACTION_BUTTON_CLASS}
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
                  className={BULK_DESTRUCTIVE_BUTTON_CLASS}
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
                  className={BULK_DESTRUCTIVE_BUTTON_CLASS}
                  onClick={onBulkStopAndDelete}
                >
                  <Trash size={10} />
                  Stop &amp; delete {selectedCount}
                </button>
              </SmartTooltip>
            ) : null}
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-fg/50 transition-colors hover:bg-white/[0.04] hover:text-fg"
              onClick={onClearSelection}
              aria-label="Clear selected sessions"
              title="Clear selection"
            >
              <X size={10} />
            </button>
          </div>
        ) : null}
      </div>

      {/* No rule under the strip: the toolbar's own bottom padding separates it
          from the list, and one fewer boundary before the first chat. */}

      {/* Session list */}
      <div
        ref={listScrollRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-0.5 pt-2"
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

      {/* New lane. Left-aligned so it lines up with the lane names above rather
          than floating centered, and borderless so the column has ONE button
          idiom top and bottom instead of a pill at the foot of a list that has
          none. The separator survives as a hairline. */}
      <div className="shrink-0 px-2 pb-2 pt-1">
        <div aria-hidden className="mb-1 h-px bg-white/[0.06]" />
        <SmartTooltip content={{ label: "New lane", description: "Create a new lane without leaving Work." }}>
          <button
            type="button"
            className={cn(SIDEBAR_BARE_BUTTON_CLASS, "h-7 cursor-pointer px-1.5 text-[11px] font-medium")}
            onClick={() => setCreateLaneOpen(true)}
          >
            <Plus size={11} weight="bold" aria-hidden />
            New lane
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
