import React from "react";
import {
  Alarm,
  CircleNotch,
  Clock,
  DesktopTower,
  DownloadSimple,
  GitPullRequest,
  GridFour,
  IdentificationBadge,
  PushPin,
  Tag,
  TreeStructure,
  UsersThree,
  XCircle,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type {
  GitHubPrStackMembership,
  LaneSummary,
  OpenProjectBinding,
  PrSummary,
  TerminalSessionSummary,
} from "../../../shared/types";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import type { OrchestrationRole } from "../../../shared/types/orchestration";
import {
  canonicalInputFromSummary,
  sanitizeTerminalInlineText,
  sessionCanonicalUiState,
  sessionStatusDisplay,
} from "../../lib/terminalAttention";
import {
  defaultSessionLabel,
  getStaleRunningCliSessionAgeHours,
  primarySessionLabel,
  preferredSessionLabel,
} from "../../lib/sessions";
import { relativeTimeCompact } from "../../lib/format";
import { GRID_SESSION_DND_MIME } from "../../lib/workGrid";
import { useAppStore } from "../../state/appStore";
import { useLaneNaming } from "../../state/laneNamingStore";
import { useSessionDelta } from "./useSessionDelta";
import { cn } from "../ui/cn";
import { MONO_FONT } from "../lanes/laneDesignTokens";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import { LanePrBadge, lanePrDeepLinkPath } from "./LanePrBadge";
import { branchNameFromRef } from "../prs/shared/laneBranchTargets";
import { lanePrStateColor, lanePrStateLabel } from "../../lib/lanePrBadge";
import {
  SessionHoverCard,
  useSessionHoverCard,
  type SessionHoverCardRow,
} from "./SessionHoverCard";
import { ToolLogo } from "./ToolLogos";
import { readImportedFrom, providerDisplayName } from "./importSessions/contract";
import { ClaudeCacheTtlBadge } from "../shared/ClaudeCacheTtlBadge";
import { shouldShowClaudeCacheTtl } from "../../lib/claudeCacheTtl";
import { ChatSubagentGlyph, chatSubagentColor } from "../chat/chatSubagentIdentity";
import { navigateToSpawnedChat } from "../chat/spawnNavigation";
import { requestLinearIssueQuickView } from "../../lib/linearIssueQuickViewNavigation";
import { isSessionSnoozed, sessionWokeMarker, snoozeWakeLabel } from "../../lib/sessionSnooze";
import { SessionStatusSlot } from "./SessionStatusSlot";
import { GitHubStackBadge } from "../prs/shared/GitHubStackBadge";

/* ──────────────────────────────────────────────────────────────────────────
   The Work-sidebar session card.

   ONE SURFACE MODEL. Background, border and shadow are reserved for
   interaction — hover, selection, multi-select. Nothing about a session's
   *state* is allowed to spend them. The row used to tint itself with the lane
   accent, outline itself when selected and glow when highlighted, which left
   hover with nothing to say and made every row look like it was asking for
   something.

   Status lives in the row's CONTENT instead, in exactly one place: the status
   slot on line 1 (`SessionStatusSlot`). Everything that used to compete with
   it on that line — role pills, spawn pills, Imported/grid badges, live-child
   counts, wake chips, the Claude tag — moved into the hover tooltip. They are
   real, they are just not worth a permanent seat.
   ────────────────────────────────────────────────────────────────────────── */

/* ── Full-bleed row geometry ───────────────────────────────────────────────
   The hovered/selected fill has to run to the sidebar's edges, and getting
   there means paying back every bit of horizontal inset between the pane and
   this card. Measured off the real ancestry in `SessionListPane`:

     scroll container   px-1    →  4px
     section stack      px-2    →  8px   (`by-lane`, the default view;
                                          the by-status / by-time stacks are
                                          `px-1.5`, i.e. 6px)
     ────────────────────────────────────
     total                         12px per side

   Two earlier passes assumed 4px and then bled the INNER row element — which
   could never have worked, because the outer wrapper carries
   `content-visibility: auto`, and that implies PAINT CONTAINMENT: anything the
   inner row painted outside the wrapper's box was clipped straight back off.
   So the bleed lives on the wrapper itself, and the inner layouts pay the
   space back as padding so no content moves.

   The amount is a variable, not a constant, for two reasons:
     • `--session-row-bleed` lets a container correct the total (the 6px stacks
       can set `10px`) without this file knowing which list it is in;
     • a card inside an indented lane group already owns the full group width.
       Its animated parent clips overflow, so bleeding either side would flatten
       the clipped corner. Any `[data-indented]` ancestor therefore zeroes both
       bleed terms and lets the row's own rounded box reach the group edges.

   Every class below is spelled out literally: Tailwind scans source text, so a
   class assembled from string constants would simply never be generated. */
/* The right side carries one extra term. `index.css` sets a CLASSIC 6px
   `::-webkit-scrollbar`, which consumes layout width rather than floating over
   it, so the list's content box already stops 6px short of the pane's visible
   edge. Measured in the running app: with a 12px bleed the left landed exactly
   flush and the right sat 5.9px in — the scrollbar track, not a padding error.
   Bleeding the extra 6px runs the row UNDER the track, which is what native
   macOS overlay scrollbars do anyway; the track is transparent and the thumb is
   18% alpha, so it reads as floating over the row. When the list is short
   enough that no scrollbar is reserved, the surplus is clipped by the scroll
   container's own `overflow-x: hidden`, so the row is flush either way. */
/** Wrapper: declare the two bleeds, then spend them as margin + width. */
export const SESSION_ROW_BLEED_CLASS = cn(
  "[--session-row-scrollbar:6px]",
  "[--session-row-bleed-left:var(--session-row-bleed,12px)]",
  "[--session-row-bleed-right:calc(var(--session-row-bleed,12px)_+_var(--session-row-scrollbar))]",
  "[[data-indented]_&]:[--session-row-bleed-left:0px]",
  "[[data-indented]_&]:[--session-row-bleed-right:0px]",
  "ml-[calc(-1*var(--session-row-bleed-left))]",
  "mr-[calc(-1*var(--session-row-bleed-right))]",
  "w-[calc(100%_+_var(--session-row-bleed-left)_+_var(--session-row-bleed-right))]",
);
/**
 * Inner layouts: 6px of content gutter plus whatever the wrapper took.
 * The lane header uses the same 6px inset, so a singleton's lane glyph now
 * lands on the exact column its full lane header would occupy.
 */
export const SESSION_ROW_INNER_PADDING_CLASS = cn(
  "pl-[calc(var(--session-row-bleed-left)_+_0.375rem)]",
  "pr-[calc(var(--session-row-bleed-right)_+_0.375rem)]",
);

const DELTA_CHIP_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  fontFamily: MONO_FONT,
  letterSpacing: "0",
  borderRadius: 4,
};

function orchestrationRoleA11yLabel(role: OrchestrationRole, tag?: string | null): string {
  if (role === "worker" && tag && tag.trim().length > 0) {
    return `Worker · ${tag.trim().toLowerCase()}`;
  }
  if (role === "lead") return "Lead";
  if (role === "validator") return "Validator";
  return role;
}

/**
 * The card's second line, in priority order:
 *   1. an escalated ask's question text (`ade chat ask`) — the row should read
 *      as the question while it blocks,
 *   2. the agent-authored statusNote (prefixed "done:" once settled — the
 *      outcome line),
 *   3. the sanitized terminal output tail,
 *   4. the AI session summary,
 *   5. the session goal.
 */
type SessionPreviewLine = {
  text: string;
  linkify: boolean;
  source: "ask" | "note" | "output" | "summary" | "goal";
};

function getPreviewLine(
  session: TerminalSessionSummary,
  primaryText: string,
  settled: boolean,
): SessionPreviewLine | null {
  if (session.attentionRequestedAt) {
    const ask = sanitizeTerminalInlineText(session.attentionMessage, 120);
    if (ask) return { text: ask, linkify: true, source: "ask" };
  }
  const note = sanitizeTerminalInlineText(session.statusNote, 120);
  if (note) {
    return {
      text: settled ? `done: ${note}` : note,
      linkify: true,
      source: "note",
    };
  }
  const output = sanitizeTerminalInlineText(session.lastOutputPreview, 120);
  if (output && output !== primaryText) {
    return { text: output, linkify: false, source: "output" };
  }
  const summary = preferredSessionLabel(session.summary);
  if (summary && summary !== primaryText) {
    return { text: summary, linkify: false, source: "summary" };
  }
  const goal = preferredSessionLabel(session.goal);
  if (goal && goal !== primaryText) {
    return { text: goal, linkify: false, source: "goal" };
  }
  return null;
}

const PREVIEW_LINK_TOKEN = /(#\d+|\b[A-Z]{2,6}-\d+\b)/g;
const PR_TOKEN = /^#(\d+)$/;
const LINEAR_TOKEN = /^[A-Z]{2,6}-\d+$/;

function LinkifiedPreviewLine({
  text,
  onOpenPr,
}: {
  text: string;
  onOpenPr: (prNumber: number) => void;
}) {
  return text.split(PREVIEW_LINK_TOKEN).map((part, index) => {
    const prMatch = PR_TOKEN.exec(part);
    const linearIssue = LINEAR_TOKEN.test(part) ? part : null;
    if (!prMatch && !linearIssue) return part;
    const activate = () => {
      if (prMatch) {
        onOpenPr(Number.parseInt(prMatch[1]!, 10));
      } else if (linearIssue) {
        requestLinearIssueQuickView({
          issueIdentifier: linearIssue,
          source: "manual",
        });
      }
    };
    return (
      <span
        key={`${part}:${index}`}
        role="link"
        tabIndex={0}
        className="cursor-pointer text-muted-fg/70 hover:underline"
        title={prMatch ? `Open PR ${part}` : `Open Linear issue ${part}`}
        onClick={(event) => {
          event.stopPropagation();
          activate();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          activate();
        }}
      >
        {part}
      </span>
    );
  });
}

function compactFutureDuration(timestampMs: number, nowMs: number): string | null {
  if (!Number.isFinite(timestampMs) || timestampMs <= nowMs) return null;
  const totalMinutes = Math.max(1, Math.ceil((timestampMs - nowMs) / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return minutes ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * Display-only trim of the `ade/` prefix every lane branch in this product
 * carries. Repeated once per row it is pure noise — the rows differ after the
 * slash, never before it. Only the rendered text is trimmed: the tooltip, the
 * `data-session-branch` anchor and every deep link keep the real branch name,
 * so nothing that has to match git ever sees the short form.
 */
function branchDisplayLabel(branchName: string): string {
  return branchName.startsWith("ade/") ? branchName.slice("ade/".length) : branchName;
}

/** `·` between the adaptive "where" line's parts. Decoration, never read out. */
function WhereSeparator() {
  return (
    <span aria-hidden className="shrink-0 text-muted-fg/25">
      ·
    </span>
  );
}

export const SessionCard = React.memo(function SessionCard({
  session,
  lane,
  isSelected,
  isMultiSelected,
  onSelect,
  onContextMenu,
  compact = false,
  gridBadge = null,
  liveChildrenCount = 0,
  parentSessionTitle = null,
  disabledReason = null,
  disabledBusy = true,
  runtimePin = null,
  deltaEnabled = true,
  githubStack = null,
  showLaneIdentity = false,
  lanePr = null,
  suppressMachineChip = false,
}: {
  session: TerminalSessionSummary;
  lane: LaneSummary | null;
  isSelected: boolean;
  isMultiSelected?: boolean;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  compact?: boolean;
  /** Grid membership indicator: "active" = in the currently-viewed grid, "inactive" = in another grid, null = not gridded. */
  gridBadge?: "active" | "inactive" | null;
  /** Count of this session's still-running spawned children (surfaced in the tooltip). */
  liveChildrenCount?: number;
  /** Title of the parent chat that spawned this session (drives the lineage glyph tooltip). */
  parentSessionTitle?: string | null;
  /** When present, blocks interaction while the owning lane is being removed. */
  disabledReason?: string | null;
  /** Busy rows spin; rows blocked on an unresolved binding show a machine glyph. */
  disabledBusy?: boolean;
  /** Runtime that owns this session when it differs from the active project. */
  runtimePin?: OpenProjectBinding | null;
  /** Foreign cards skip the active-project delta cache. */
  deltaEnabled?: boolean;
  /** Native GitHub stack context for chats running in this lane. */
  githubStack?: GitHubPrStackMembership | null;
  /**
   * Lane has exactly one session, so no lane divider renders above it — the
   * card carries the lane identity instead.
   */
  showLaneIdentity?: boolean;
  /**
   * The lane's primary PR, already resolved by the list (the card never fetches
   * PR data). Only meaningful alongside `showLaneIdentity`: elsewhere the lane
   * divider owns the PR badge and a second copy per row would be noise.
   */
  lanePr?: PrSummary | null;
  /**
   * The lane header above already names the machine, so the row's own chip
   * would just repeat it. Set by SessionListPane for children of a lane group
   * whose header renders a machine marker.
   */
  suppressMachineChip?: boolean;
}) {
  const navigate = useNavigate();
  // Hover INTENT, not hover: a one-second rest on the row, cancelled by any
  // pointer-leave or scroll. See `SessionHoverCard` for why this is not a
  // `SmartTooltip`.
  // The row id lets the hook re-find this row if React swaps the wrapper node
  // during the one-second wait — see `resolveTriggerElement`.
  const hoverCard = useSessionHoverCard({ rowId: session.id });
  const sessionAttentionInput = canonicalInputFromSummary(session);
  const canonicalPhase = sessionCanonicalUiState(sessionAttentionInput).phase;
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const delta = useSessionDelta(
    session.id,
    deltaEnabled && (!isRemoteProject || isSelected),
  );
  const primaryText = primarySessionLabel(session);
  const settled = canonicalPhase === "settled";
  const previewLine = getPreviewLine(session, primaryText, settled);

  // Snooze/woke never touch the canonical phase — they are read straight off
  // their own columns and handed to the presentation module as an overlay, so
  // where the row is filed and what it says can never disagree.
  const snoozed = isSessionSnoozed(session);
  const wokeMarker = sessionWokeMarker(session);
  const presentation = sessionStatusDisplay(sessionAttentionInput, {
    snoozed,
    woke: !snoozed && Boolean(wokeMarker),
    snoozeWakeLabel: snoozed ? snoozeWakeLabel(session.snoozedUntil) : null,
  });

  // Pulse once when an already-mounted row transitions into the loud Needs-you
  // state. First render stays calm, and motion-safe suppresses it for users who
  // prefer reduced motion.
  const previousCanonicalPhaseRef = React.useRef(canonicalPhase);
  const [needsYouJustChanged, setNeedsYouJustChanged] = React.useState(false);
  React.useEffect(() => {
    const previousPhase = previousCanonicalPhaseRef.current;
    previousCanonicalPhaseRef.current = canonicalPhase;
    if (canonicalPhase !== "needs_you" || previousPhase === "needs_you") {
      setNeedsYouJustChanged(false);
      return undefined;
    }
    setNeedsYouJustChanged(true);
    const timer = window.setTimeout(() => setNeedsYouJustChanged(false), 900);
    return () => window.clearTimeout(timer);
  }, [canonicalPhase]);

  // True while this lane's AI auto-name is being generated in the background.
  const isAutoNaming = useLaneNaming(lane?.id ?? null);
  // Brief warm highlight when the displayed title actually changes (e.g. the
  // deterministic/seed name is replaced by the AI name). Skipped on first mount.
  const [titleJustChanged, setTitleJustChanged] = React.useState(false);
  const prevTitleRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const prev = prevTitleRef.current;
    prevTitleRef.current = primaryText;
    if (prev === null || prev === primaryText) return undefined;
    setTitleJustChanged(true);
    const timer = setTimeout(() => setTitleJustChanged(false), 1100);
    return () => clearTimeout(timer);
  }, [primaryText]);

  const staleAgeHours = getStaleRunningCliSessionAgeHours(session);
  const importedFrom = readImportedFrom(session);
  const isHighlighted = Boolean(isSelected || isMultiSelected);
  // Lane accent survives the surface purge for exactly one job: the warm flash
  // when an AI-generated title lands. That is an event, not a state.
  const laneAccent = lane?.color ?? null;
  const showClaudeCacheTimer = shouldShowClaudeCacheTtl({
    provider: session.toolType === "claude-chat" ? "claude" : null,
    status: session.runtimeState === "idle" ? "idle" : "active",
    idleSinceAt: session.chatIdleSinceAt,
    awaitingInput: session.runtimeState === "waiting-input",
  });
  const hasDeltaChips = Boolean(delta && (delta.insertions > 0 || delta.deletions > 0));
  const orchestrationLabel = session.orchestrationRole
    ? orchestrationRoleA11yLabel(session.orchestrationRole, session.orchestrationTag ?? null)
    : null;

  /* ── The adaptive "where" slot (line 1, left) ──────────────────────────
     Identity, never status. Filled in this priority order and joined by `·`;
     whatever applies, applies, and everything truncates under `min-w-0`:

       1. cross-machine marker (unless `suppressMachineChip`)
       2. pin glyph
       3. lane identity (singleton rows only, `showLaneIdentity`)
       4. lineage — a Subagent/Peer badge, for sessions with a parent
       5. branch — ONLY when it differs from the lane's own branch
       6. the lane's PR badge (singleton rows only)
       7. the diff chips, else the last-activity time — the FLOOR. Every rule
          above can miss, and an empty slot reads as broken rather than minimal.

     The floor is signal, not filler. `+42 −8` is how much this chat has
     actually changed, which is exactly what separates several sessions sitting
     in one lane on one branch — and it used to sit on line 3, where it crowded
     the preview text into truncating mid-word. When there is no diff at all
     (a fresh chat that has touched nothing) the last-activity time stands in:
     the status slot's elapsed counter only runs while a turn is WORKING, so a
     Done / Stale / Stopped row otherwise says nowhere when it last moved.

     Because of (7) the slot is never empty, so line 1 needs no spacer.

     The HARD rule: lane is ALWAYS the lane accent with `LaneIcon`, branch is
     ALWAYS muted with `BranchIcon`. Colour is the only thing that tells the two
     concepts apart at a glance, so a muted lane name or an accented branch is a
     bug, not a style choice. */
  const machineName = runtimePin
    ? runtimePin.kind === "remote"
      ? runtimePin.runtimeName
      : THIS_MACHINE_NAME
    : null;
  /* The lane's DECLARED branch versus the one the worktree is actually sitting
     on. They agree for every healthy lane — which is exactly why the row stopped
     printing the branch unconditionally: the divider directly above already
     established it, and four identical branch labels under one header are the
     most repeated, least informative text in the sidebar. Drift (`branchDrift`,
     set when the worktree HEAD walks off `branchRef`) is the one case where a
     row's real branch is NOT its lane's, and that is genuinely worth a seat.
     Same "show only what is non-obvious" rule the machine chip and the lane
     identity already follow. Nothing is lost either way: the hover detail card
     carries the branch unconditionally. */
  const laneBranchName = lane?.branchRef ? branchNameFromRef(lane.branchRef) : "";
  const branchName = lane?.branchDrift?.headBranchRef
    ? branchNameFromRef(lane.branchDrift.headBranchRef)
    : laneBranchName;
  // Compared on the normalised refs, never the display labels: `ade/a` and `a`
  // are the same branch to git and would otherwise read as a difference.
  const branchDiffersFromLane = Boolean(branchName) && branchName !== laneBranchName;

  const whereParts: React.ReactNode[] = [];
  // `suppressMachineChip` only silences the CHIP. `machineName` still feeds the
  // tooltip below, because the fact is never the noise — the repetition is.
  if (machineName && !suppressMachineChip) {
    // Deliberately an inline chip rather than `LaneMachineMarker`: that
    // component wraps itself in its own SmartTooltip with a focusable trigger,
    // and this row already owns a tooltip and a click target. The visual
    // identity — amber tower glyph inside a NEUTRAL chip — is preserved
    // exactly; the marker is identity, so it never enters the status slot and
    // never borrows the status palette.
    whereParts.push(
      <span
        key="machine"
        data-session-machine={machineName}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/20 bg-amber-400/[0.06] px-1.5 py-px text-[10px] font-medium leading-none text-muted-fg/70"
      >
        <DesktopTower size={10} weight="duotone" className="shrink-0 text-amber-400/85" aria-hidden />
        <span className="max-w-24 truncate">{machineName}</span>
      </span>,
    );
  }
  if (session.pinned) {
    whereParts.push(
      <PushPin
        key="pinned"
        size={11}
        weight="fill"
        className="shrink-0 text-muted-fg/55"
        aria-label="Pinned"
      />,
    );
  }
  if (githubStack) {
    whereParts.push(
      <GitHubStackBadge key="github-stack" stack={githubStack} compact bare />,
    );
  }
  if (showLaneIdentity && lane) {
    whereParts.push(
      <span
        key="lane"
        data-session-lane-identity={lane.name}
        className="inline-flex min-w-0 shrink items-center gap-1.5 text-[12px] font-medium"
        // Inline style, not a class: the accent is per-lane user data.
        style={{ color: laneAccent ?? undefined }}
      >
        <span
          aria-hidden
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
        >
          <LaneIcon size={12} weight="regular" />
        </span>
        <span className={cn("truncate", laneAccent ? "" : "text-fg/80")}>{lane.name}</span>
      </span>,
    );
  }
  /* Lineage takes the slot the branch used to occupy. In a lane where three of
     four sessions were spawned by the fourth, "this is a spawned agent" is the
     fact that tells the rows apart — and until now it lived only in a small
     glyph next to the provider mark and in the hover card.

     It names ADE's OWN spawn primitive (Subagent / Peer, else the orchestration
     role) rather than the parent's title. The parent is very often not in the
     visible list, so the title branch degraded to the literal string "another
     chat" for most real users — a label that says nothing. `spawnKind` and
     `orchestrationRole` are projected onto every summary, so they are always
     known locally and always specific.

     The chip is also the keyboard path to the parent thread. The hover card
     repeats that action for pointer users, but a hover-only action would make
     lineage navigation undiscoverable to keyboard and assistive-tech users. */
  if (session.orchestrationParentSessionId) {
    const lineageLabel =
      session.spawnKind === "subagent"
        ? "Subagent"
        : session.spawnKind === "peer"
          ? "Peer"
          // No spawn kind recorded: the orchestration role is the next most
          // specific truth, and "Spawned" is the honest floor.
          : orchestrationLabel ?? "Spawned";
    whereParts.push(
      <button
        type="button"
        key="lineage"
        data-testid="session-spawn-lineage"
        aria-label="Open parent thread"
        title="Open parent thread"
        /* One pill, not a loose glyph beside loose text — same chip idiom as the
           machine marker. Neutral, never amber: lineage is identity, and amber
           means "your move" (see `sessionStatusPresentation.ts`). */
        className="inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-px text-[10px] font-medium leading-none text-muted-fg/70"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          navigateToSpawnedChat(session.orchestrationParentSessionId, null);
        }}
      >
        <ChatSubagentGlyph
          id={session.id}
          color={chatSubagentColor(session.id)}
          size={10}
        />
        <span className="truncate">{lineageLabel}</span>
      </button>,
    );
  }
  /* A singleton row shows its LANE and nothing else: with no divider above it,
     the lane name and its derived branch would both land on the busiest line
     saying nearly the same thing. The lane name wins because a human chose it —
     the branch is generated from it. Grouped rows only earn the branch when it
     is NOT the lane's own — see `branchDiffersFromLane`. Either way the full
     branch is one hover away in the detail card. */
  if (branchName && !showLaneIdentity && branchDiffersFromLane) {
    whereParts.push(
      <span
        key="branch"
        data-session-branch={branchName}
        className="inline-flex min-w-0 flex-1 items-center gap-1 text-[11px] text-muted-fg/70"
      >
        <BranchIcon size={11} />
        <span className="truncate">{branchDisplayLabel(branchName)}</span>
      </span>,
    );
  }
  if (showLaneIdentity && lanePr) {
    /* PR state has to survive everywhere a lane header is minimized or absent —
       it already does on quiet and collapsed dividers, and the singleton form
       has no divider at all. Same component as the divider's badge, so the two
       can never drift apart.

       It goes LAST and `shrink-0` on purpose: the lane name is the only elastic
       part of this slot, and a truncated "#95…" is unreadable while a truncated
       lane name is still recognisable. So the squeeze lands on the name and the
       PR chip keeps its full width. */
    whereParts.push(
      <LanePrBadge
        key="lane-pr"
        pr={lanePr}
        onOpen={() => navigate(lanePrDeepLinkPath(lanePr))}
      />,
    );
  }
  if (whereParts.length === 0) {
    /* The floor. `flex-1` on purpose — it is the elastic part that keeps the
       status slot hard right on an otherwise bare row. A pure relocation of the
       line-3 chips: same `useSessionDelta` data, same `DELTA_CHIP_STYLE`,
       emerald insertions and red deletions. */
    whereParts.push(
      hasDeltaChips && delta ? (
        <span key="delta-floor" data-session-delta="" className="flex-1 font-mono" style={DELTA_CHIP_STYLE}>
          {delta.insertions > 0 ? (
            <span className="text-emerald-400">+{delta.insertions}</span>
          ) : null}
          {delta.insertions > 0 && delta.deletions > 0 ? " " : null}
          {delta.deletions > 0 ? (
            <span className="text-red-400">−{delta.deletions}</span>
          ) : null}
        </span>
      ) : (
        <span
          key="last-activity-floor"
          data-session-last-activity=""
          className="flex-1 truncate tabular-nums text-[11px] text-muted-fg/55"
        >
          {relativeTimeCompact(session.lastActivityAt ?? session.startedAt)}
        </span>
      ),
    );
  }

  /* ── Hover detail card: everything that lost its seat on line 1 ─────────
     Icon-led rows, never `Label: value` — the icon IS the label. Two colour
     rules are enforced here and nowhere else:
       • lane is ALWAYS the lane accent with `LaneIcon`, branch is ALWAYS muted
         with `BranchIcon` — the same hard rule the row's line 1 obeys;
       • amber appears exactly once, on the machine tower, because that glyph is
         an identity mark and not a status (see `sessionStatusPresentation.ts`).
     Everything else is muted, or borrows a colour that already means something
     (PR state, red for a broken exit). */
  const hoverRows: SessionHoverCardRow[] = [];
  hoverRows.push({
    id: "lane",
    icon: <LaneIcon size={13} style={laneAccent ? { color: laneAccent } : undefined} />,
    value: (
      <span style={laneAccent ? { color: laneAccent } : undefined}>
        {lane?.name ?? session.laneName}
      </span>
    ),
  });
  if (machineName) {
    hoverRows.push({
      id: "machine",
      icon: <DesktopTower size={13} weight="duotone" className="text-amber-400/85" />,
      value: machineName,
    });
  }
  if (branchName) {
    hoverRows.push({
      id: "branch",
      icon: <BranchIcon size={13} className="text-muted-fg/60" />,
      // Display form only, exactly as the row trims it — the real ref still
      // lives on `data-session-branch` and in every deep link.
      value: <span className="text-muted-fg/75">{branchDisplayLabel(branchName)}</span>,
      mono: true,
    });
  }
  hoverRows.push({
    id: "provider",
    icon: <ToolLogo toolType={session.toolType} size={13} className="opacity-80" />,
    value: defaultSessionLabel(session.toolType),
  });
  if (lanePr) {
    /* Same two helpers `LanePrBadge` reads, so the state vocabulary and its
       colour cannot drift between the badge and this row. The badge's own dot
       is dropped: here the icon column already carries the state colour. */
    hoverRows.push({
      id: "pr",
      icon: <GitPullRequest size={13} style={{ color: lanePrStateColor(lanePr.state) }} />,
      value: (
        <span>
          <span className="tabular-nums">#{lanePr.githubPrNumber}</span>{" "}
          <span style={{ color: lanePrStateColor(lanePr.state) }}>
            {lanePrStateLabel(lanePr.state)}
          </span>
        </span>
      ),
      onActivate: () => navigate(lanePrDeepLinkPath(lanePr)),
      activateLabel: `Open pull request #${lanePr.githubPrNumber}`,
      testId: "session-hover-pr",
    });
  }
  if (session.orchestrationParentSessionId) {
    // The lineage affordance the old tooltip only DESCRIBED ("click the glyph").
    // The card can be hovered into, so the row itself is the affordance now.
    hoverRows.push({
      id: "parent-thread",
      icon: (
        <ChatSubagentGlyph
          id={session.id}
          color={chatSubagentColor(session.id)}
          size={12}
        />
      ),
      value: (
        <span>
          Spawned by{" "}
          <span className="text-fg/90">{parentSessionTitle ?? "another chat"}</span>
          <span className="text-muted-fg/50"> — open</span>
        </span>
      ),
      onActivate: () => navigateToSpawnedChat(session.orchestrationParentSessionId, null),
      activateLabel: "Open parent thread",
      testId: "session-hover-parent-thread",
    });
  }
  if (orchestrationLabel) {
    hoverRows.push({
      id: "role",
      icon: <IdentificationBadge size={13} className="text-muted-fg/60" />,
      value: orchestrationLabel,
    });
  }
  if (session.spawnKind && session.spawnKind !== "none") {
    hoverRows.push({
      id: "spawn",
      icon: <TreeStructure size={13} className="text-muted-fg/60" />,
      value: session.spawnKind === "subagent" ? "Subagent" : "Peer",
    });
  }
  if (liveChildrenCount > 0) {
    hoverRows.push({
      id: "live-children",
      icon: <UsersThree size={13} className="text-muted-fg/60" />,
      value: `${liveChildrenCount} spawned chat${liveChildrenCount === 1 ? "" : "s"} still running`,
    });
  }
  if (importedFrom) {
    hoverRows.push({
      id: "imported-from",
      icon: <DownloadSimple size={13} className="text-muted-fg/60" />,
      value: `Imported from ${providerDisplayName(importedFrom.provider)}`,
    });
  }
  if (gridBadge) {
    hoverRows.push({
      id: "grid",
      icon: <GridFour size={13} className="text-muted-fg/60" />,
      value: gridBadge === "active" ? "In the active grid" : "In another grid",
    });
  }
  if (session.claudeTag?.trim()) {
    hoverRows.push({
      id: "tag",
      icon: <Tag size={13} className="text-muted-fg/60" />,
      value: session.claudeTag.trim(),
      mono: true,
    });
  }
  if (session.nextWakeAt) {
    const wakeIn = compactFutureDuration(Date.parse(session.nextWakeAt), Date.now());
    // Neutral, never amber: a scheduled wake is the agent's move, not yours.
    if (wakeIn) {
      hoverRows.push({
        id: "next-wake",
        icon: <Alarm size={13} className="text-muted-fg/60" />,
        value: `Wakes in ${wakeIn}`,
      });
    }
  }
  if (session.exitCode != null && session.exitCode !== 0) {
    hoverRows.push({
      id: "exit-code",
      icon: <XCircle size={13} className="text-red-400/70" />,
      value: `Exit code ${session.exitCode}`,
    });
  }
  if (staleAgeHours != null) {
    // The old amber WarningCircle lived here. It said the same thing as the
    // "Stale" status label in the alarm hue, and amber is now reserved for
    // "your move" — a memory-hygiene nudge is advice, not a request. The advice
    // survives; the second alarm does not.
    hoverRows.push({
      id: "stale",
      icon: <Clock size={13} className="text-muted-fg/45" />,
      value: `No activity for about ${staleAgeHours}h — consider closing it to free memory.`,
      variant: "advice",
    });
  }

  const statusSlot = (
    <SessionStatusSlot
      session={session}
      presentation={presentation}
      timestampLabel={relativeTimeCompact(session.endedAt ?? session.startedAt)}
      snoozed={snoozed}
      settled={settled}
      actionsEnabled={!disabledReason}
      compact={compact}
      runtimePin={runtimePin}
    />
  );

  /* COMPACT ROWS ONLY. The full row carries lineage on line 1 now, and two
     lineage indicators on one row is exactly the duplication this pass removes.
     Compact rows have no line 1 at all — dropping the glyph there would delete
     the affordance rather than move it — so the single-glyph form survives
     here, and only here. */
  const compactLineageGlyph = session.orchestrationParentSessionId ? (
    <button
      type="button"
      data-testid="session-spawn-lineage"
      className="inline-flex shrink-0 cursor-pointer items-center opacity-70 transition-opacity hover:opacity-100"
      title={
        parentSessionTitle
          ? `Spawned by "${parentSessionTitle}" — click to open parent thread`
          : "Spawned by another chat — click to open parent thread"
      }
      aria-label="Open parent thread"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        navigateToSpawnedChat(session.orchestrationParentSessionId, null);
      }}
    >
      <ChatSubagentGlyph id={session.id} color={chatSubagentColor(session.id)} size={10} />
    </button>
  ) : null;

  const titleNode = (
    <span
      className={cn(
        "min-w-0 flex-1 truncate rounded px-1 -mx-1 text-fg/90",
        compact ? "text-[12px] font-medium" : "text-[14px] font-medium",
      )}
      style={{
        transition: "background-color 900ms ease-out, box-shadow 900ms ease-out",
        backgroundColor: titleJustChanged
          ? `color-mix(in srgb, ${laneAccent ?? "rgb(250, 204, 21)"} 22%, transparent)`
          : "transparent",
        boxShadow: titleJustChanged
          ? `0 0 0 2px color-mix(in srgb, ${laneAccent ?? "rgb(250, 204, 21)"} 16%, transparent)`
          : "none",
      }}
    >
      {primaryText}
    </span>
  );

  /* Recede rule (inbox-zero): rows the presentation marks non-prominent —
     Working, Starting, Stale, Stopped, Ended, Snoozed — and settled rows fade
     back so the handful that actually want a human stand out. The status label
     keeps its hue either way, so a working row is still findable. Selection
     always wins: whatever you are looking at renders at full strength. */
  const shouldRecede = !isHighlighted && !presentation?.prominent;

  const row = (
    <div
      role="button"
      tabIndex={disabledReason ? -1 : 0}
      aria-disabled={disabledReason ? true : undefined}
      /* A native <button> cannot legally host the status slot's snooze/settle
         buttons, and the swap only works with those controls in flow. t3code's
         row makes the same trade. */
      className={cn(
        // Both properties in ONE transition declaration: a second
        // `transition-opacity` on the recede branch would override
        // `transition-colors` outright and kill the hover fade.
        // Full-bleed row, not a floating card: this element is already the full
        // width of the widened wrapper (see SESSION_ROW_BLEED_CLASS), so the
        // hover/selected fill runs edge to edge and reads as "you are on this
        // ROW" rather than "you are hovering a card". A full-width band wants a
        // hairline corner, not a card's.
        "group/v2-row relative w-full select-none overflow-hidden rounded-md text-left outline-none transition-[background-color,opacity] duration-100",
        disabledReason ? "cursor-default" : "cursor-pointer",
        isHighlighted ? "bg-white/[0.06]" : "bg-transparent hover:bg-white/[0.035]",
        isMultiSelected && "ring-1 ring-accent/35",
        shouldRecede && "opacity-70 hover:opacity-100",
      )}
      data-session-recede={shouldRecede ? "true" : undefined}
      {...(disabledReason
        ? { "aria-label": `${primaryText}: ${disabledReason}` }
        : orchestrationLabel
          ? { "aria-label": `${orchestrationLabel}: ${primaryText}` }
          : { "aria-label": primaryText })}
      onClick={(event) => {
        // Selecting loads this session into the very area the card floats over,
        // so the card gets out of the way the moment the row is acted on.
        hoverCard.close();
        if (disabledReason) return;
        onSelect(session.id, event);
      }}
      onKeyDown={(event) => {
        // Only the row itself — a key pressed inside a nested control (settle,
        // snooze, a preview link) belongs to that control.
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.currentTarget.click();
      }}
    >
      {compact ? (
        <div className={cn("flex h-8 min-w-0 items-center gap-1.5", SESSION_ROW_INNER_PADDING_CLASS)}>
          {titleNode}
          {compactLineageGlyph}
          <ToolLogo toolType={session.toolType} size={14} className="shrink-0 opacity-75" />
          {statusSlot}
        </div>
      ) : (
        <div className={cn("h-[4.875rem] py-2", SESSION_ROW_INNER_PADDING_CLASS)}>
          {/* Line 1 — where this work lives, then the status slot. */}
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            {/* Never empty — the model floor guarantees at least one part, and
                that part is `flex-1`, which is what keeps the status slot
                right-anchored on an otherwise bare row. */}
            {whereParts.map((part, index) => (
              <React.Fragment key={index}>
                {index > 0 ? <WhereSeparator /> : null}
                {part}
              </React.Fragment>
            ))}
            {statusSlot}
          </div>

          {/* Line 2 — the title. The one prominent element in the row. */}
          <div className="mt-1 flex min-w-0">{titleNode}</div>

          {/* Line 3 — what it is doing, then the quiet meta. */}
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-fg/65">
            {isAutoNaming ? (
              <span className="min-w-0 flex-1 truncate italic text-muted-fg/45">
                Auto-naming lane underway…
              </span>
            ) : previewLine ? (
              <span
                key={`${previewLine.source}:${previewLine.text}`}
                /* Italic, deliberately: the title above is the thing you scan
                   for and this line is commentary about it. Italics separate
                   the two registers without spending another colour or weight
                   — and match the auto-naming line, which is the same voice. */
                className="min-w-0 flex-1 truncate italic motion-safe:animate-[ade-session-preview-in_180ms_ease-out_1]"
                data-session-preview-source={previewLine.source}
              >
                {previewLine.linkify ? (
                  <LinkifiedPreviewLine
                    text={previewLine.text}
                    onOpenPr={(prNumber) => navigate(`/prs?pr=${prNumber}`)}
                  />
                ) : previewLine.text}
              </span>
            ) : (
              <span className="flex-1" />
            )}

            {showClaudeCacheTimer ? (
              <ClaudeCacheTtlBadge idleSinceAt={session.chatIdleSinceAt} />
            ) : null}
            {/* The diff chips used to sit here. They moved to line 1's floor:
                on this line they were competing with the preview text for the
                same pixels, and the preview was the one that lost — real rows
                truncated mid-token. The preview keeps `min-w-0 flex-1` above,
                so the freed width goes to it and not to the trailing cluster. */}
            {/* A non-zero exit that is NOT a stop signal: the status slot
                already says "Failed", this carries the code it failed with.
                The old "STOPPED" chip is gone — the slot says that word now. */}
            {session.exitCode != null
              && session.exitCode !== 0
              && session.exitCode !== 130
              && session.exitCode !== 143 ? (
              <span
                className="shrink-0 border border-red-500/25 px-1 py-0.5 leading-none text-red-300/80"
                style={DELTA_CHIP_STYLE}
              >
                EXIT {session.exitCode}
              </span>
            ) : null}
            {/* The provider mark is the least informative thing in the row —
                most rows share a provider — so it sits in the least prominent
                slot rather than leading the card. */}
            <ToolLogo toolType={session.toolType} size={20} className="shrink-0 opacity-75" />
          </div>
        </div>
      )}

      {disabledReason ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 rounded-md bg-bg/70 text-[10px] font-semibold uppercase tracking-wide text-muted-fg backdrop-blur-[1px]">
          {disabledBusy ? (
            <CircleNotch size={12} className="animate-spin" />
          ) : (
            <DesktopTower size={12} weight="duotone" />
          )}
          {disabledReason}
        </span>
      ) : null}
    </div>
  );

  return (
    <div
      className={cn(
        "group relative",
        // The bleed HAS to live here, on the same element as
        // `content-visibility`: that property implies paint containment, so a
        // negative margin on anything inside would be clipped back to this box.
        SESSION_ROW_BLEED_CLASS,
        // Fixed height + intrinsic size: the sidebar can skip rendering
        // offscreen rows entirely without the scrollbar jumping.
        compact
          ? "[content-visibility:auto] [contain-intrinsic-size:auto_32px]"
          : "[content-visibility:auto] [contain-intrinsic-size:auto_78px]",
        disabledReason && "opacity-60",
        needsYouJustChanged && "motion-safe:animate-[ade-session-needs-you_900ms_ease-out_1]",
      )}
      data-needs-you-pulse={needsYouJustChanged ? "true" : undefined}
      // Stable row anchor. ADE Web mounts this same component and has to locate
      // the row from outside React — for its coarse-pointer styling and for the
      // long-press bridge that stands in for `contextmenu`, which iOS Safari
      // never fires. Without this it would have to walk up from an inner
      // testid, which silently breaks the moment the card's markup shifts.
      data-session-row=""
      data-session-id={session.id}
      /* The hover-intent trigger sits on the WRAPPER, not on the row: this is
         the element whose right edge is the sidebar's right edge, and it is the
         one box the card can measure without reaching into the pane. Mouse
         enter/leave carry no click, drag or context-menu semantics, so the
         row's own interactions are untouched. */
      {...hoverCard.triggerProps}
      onContextMenu={
        disabledReason
          ? undefined
          : (event) => {
            // The context menu is the other thing that opens next to this row;
            // two floating panels over the same spot is one too many.
            hoverCard.close();
            onContextMenu(event);
          }
      }
      draggable={!disabledReason}
      onDragStart={(event) => {
        // Source for the Cursor-style work grid: drop onto a session / the work
        // area to add this chat or CLI session to a grid.
        event.dataTransfer.setData(GRID_SESSION_DND_MIME, session.id);
        event.dataTransfer.effectAllowed = "copyMove";
      }}
    >
      {row}
      {hoverCard.anchor ? (
        <SessionHoverCard
          anchor={hoverCard.anchor}
          title={primaryText}
          rows={hoverRows}
          cardProps={hoverCard.cardProps}
        />
      ) : null}
    </div>
  );
});
