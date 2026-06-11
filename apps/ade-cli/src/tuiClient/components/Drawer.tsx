import React from "react";
import { Box, Text, useStdout } from "ink";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { DiffLineStats } from "../../../../desktop/src/shared/types/git";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import { formatSessionLabel } from "../format";
import { computeStackRowMeta, sortLanesForStackGraph } from "../laneTree";
import { useSpinFrame } from "../spinTick";
import { theme, type LaneStatusKind } from "../theme";
import type { AdeCodeProvider } from "../types";
import { useHoveredHitId } from "../hitTestRegistry";
import {
  computeDrawerLayout,
  drawerLaneWindow,
  visibleDrawerChatCount,
  visibleDrawerLaneCount,
  type DrawerLaneInput,
} from "../drawerLayout";
import { Rail, statusGlyph, type StatusKind } from "./designKit";

export { visibleDrawerChatCount, visibleDrawerLaneCount };

type DrawerDensity = "full" | "mini";
type DrawerMode = "lanes" | "chats";

const DRAWER_WIDTH_FULL = 32;
const DRAWER_WIDTH_MAX = 48;
const DRAWER_WIDTH_MINI = 22;

export type DrawerPrSummary = {
  number: number;
  state: "open" | "closed" | "merged";
  checksPassed: number;
  checksTotal: number;
};

/** Derive a wireframe-bucket status for a lane from its data + active session. */
function deriveLaneStatus(
  lane: LaneSummary,
  sessions: AgentChatSessionSummary[],
  activeLaneId: string | null,
  unavailableLaneIds: ReadonlySet<string>,
): LaneStatusKind {
  if (lane.laneType === "primary") return "primary";
  if (unavailableLaneIds.has(lane.id)) return "failed";
  const laneSessions = sessions.filter((s) => s.laneId === lane.id);
  const hasActive = laneSessions.some((s) => s.status === "active");
  const awaiting = laneSessions.some((s) => s.awaitingInput);
  if (lane.status?.rebaseInProgress) return "failed";
  if (awaiting) return "attention";
  if (hasActive || lane.id === activeLaneId) return "running";
  return "idle";
}

/** Map a lane's wireframe status onto the shared design-kit status glyph set. */
function laneStatusDot(status: LaneStatusKind): StatusKind {
  switch (status) {
    case "running":
      return "live";
    case "attention":
      return "pending";
    case "failed":
      return "failed";
    case "primary":
      return "info";
    case "idle":
    default:
      return "idle";
  }
}

/** Map a chat session onto the shared design-kit status glyph set. */
function chatStatusDot(session: AgentChatSessionSummary): StatusKind {
  if (session.status === "active") return "live";
  if (session.awaitingInput) return "pending";
  if (session.status === "ended" || session.endedAt) return "done";
  return "idle";
}

function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, max);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

function formatAgeMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatLaneAge(lane: LaneSummary): string {
  const ts = Date.parse(lane.createdAt);
  if (Number.isNaN(ts)) return "";
  return formatAgeMs(Date.now() - ts);
}

function formatSessionAge(session: AgentChatSessionSummary): string {
  const ref = session.endedAt ?? session.idleSinceAt ?? session.startedAt;
  if (!ref) return "";
  const ts = Date.parse(ref);
  if (Number.isNaN(ts)) return "";
  if (session.status === "active") return "now";
  return formatAgeMs(Date.now() - ts);
}

function laneDetailSuffix(lane: LaneSummary, diffStats: DiffLineStats | null, worktreeAvailable: boolean): {
  diff: { add: number; del: number } | null;
  hint: string | null;
} {
  if (!worktreeAvailable) {
    return { diff: null, hint: "missing worktree" };
  }
  if (diffStats) {
    return { diff: { add: diffStats.additions, del: diffStats.deletions }, hint: null };
  }
  if (lane.status?.rebaseInProgress) {
    return { diff: null, hint: "rebase in progress" };
  }
  if (lane.status?.dirty) {
    return { diff: null, hint: "dirty" };
  }
  return { diff: null, hint: `checkpoint ${formatLaneAge(lane)}` };
}

export function Drawer({
  lanes,
  sessions,
  activeLaneId,
  activeSessionId,
  browsingLaneId,
  selectedLaneIndex,
  selectedChatIndex,
  panelHeight,
  focused = false,
  addMode = false,
  density = "full",
  mode = "lanes",
  prByLaneId = {},
  diffByLaneId = {},
  loading = false,
  unavailableLaneIds = new Set<string>(),
  width: requestedWidth,
  scrollOffsetRows = 0,
}: {
  lanes: LaneSummary[];
  sessions: AgentChatSessionSummary[];
  activeLaneId: string | null;
  activeSessionId: string | null;
  browsingLaneId: string | null;
  selectedLaneIndex: number;
  selectedChatIndex: number;
  panelHeight?: number;
  focused?: boolean;
  addMode?: boolean;
  density?: DrawerDensity;
  mode?: DrawerMode;
  prByLaneId?: Record<string, DrawerPrSummary>;
  diffByLaneId?: Record<string, DiffLineStats>;
  loading?: boolean;
  unavailableLaneIds?: ReadonlySet<string>;
  width?: number;
  scrollOffsetRows?: number;
}) {
  const { stdout } = useStdout();
  const resolvedPanelHeight = panelHeight ?? stdout?.rows ?? 40;
  const ordered = React.useMemo(() => sortLanesForStackGraph(lanes), [lanes]);
  const rowMeta = React.useMemo(() => computeStackRowMeta(ordered), [ordered]);

  const browsing = browsingLaneId ?? activeLaneId;
  // selectedLaneIndex is relative to the visible window (app.tsx derives it
  // from the sliced lane rows); convert to an absolute index into `ordered`
  // for the shared layout. An index at/past the window count means the
  // "+ new lane" row is selected.
  const { start: windowStart, count: windowCount } = drawerLaneWindow(
    resolvedPanelHeight,
    ordered.length,
    scrollOffsetRows,
  );
  const selectedAbsoluteIndex = selectedLaneIndex >= 0 && selectedLaneIndex < windowCount
    ? windowStart + selectedLaneIndex
    : null;
  // The expanded card (full chat block) tracks the selected lane in lanes mode
  // and the browsing lane in chats mode — app.tsx mirrors this for the mouse
  // hit-test via the same computeDrawerLayout inputs.
  const expandedAbsoluteIndex = mode === "chats"
    ? (() => {
        const index = ordered.findIndex((l) => l.id === browsing);
        return index >= 0 ? index : null;
      })()
    : selectedAbsoluteIndex;
  const layout = computeDrawerLayout({
    panelHeight: resolvedPanelHeight,
    lanes: ordered.map((lane): DrawerLaneInput => ({
      laneId: lane.id,
      chatCount: sessions.filter((s) => s.laneId === lane.id).length,
      worktreeAvailable: !unavailableLaneIds.has(lane.id),
      hasDiffRow: Boolean(diffByLaneId[lane.id]),
    })),
    expandedLaneIndex: expandedAbsoluteIndex,
    selectedLaneIndex: selectedAbsoluteIndex,
    scrollOffsetRows,
  });
  const laneStart = layout.laneStart;
  const laneRows = layout.lanes.map((plan) => ordered[plan.laneIndex]!);
  const visibleRowMeta = layout.lanes.map((plan) => rowMeta[plan.laneIndex]!);
  const browsingLane = laneRows.find((l) => l.id === browsing) ?? null;
  const expandedPlan = layout.lanes.find((plan) => plan.expanded) ?? null;
  const laneSessions = expandedPlan
    ? sessions
        .filter((s) => s.laneId === expandedPlan.laneId)
        .slice(0, expandedPlan.visibleChatCount)
    : [];

  const width = density === "mini"
    ? DRAWER_WIDTH_MINI
    : Math.max(DRAWER_WIDTH_FULL, Math.min(DRAWER_WIDTH_MAX, Math.floor(requestedWidth ?? DRAWER_WIDTH_FULL)));
  const emphasisColor = addMode ? theme.color.attention2 : theme.color.violet;
  let borderColor: string;
  if (addMode) borderColor = emphasisColor;
  else if (focused) borderColor = theme.color.violet;
  else borderColor = theme.color.border;
  const hoveredId = useHoveredHitId();

  if (density === "mini") {
    return (
      <MiniDrawer
        width={width}
        borderColor={borderColor}
        addMode={addMode}
        emphasisColor={emphasisColor}
        lanes={laneRows}
        laneStart={laneStart}
        laneTotal={ordered.length}
        sessions={laneSessions}
        activeLaneId={activeLaneId}
        activeSessionId={activeSessionId}
        browsingLaneId={browsing}
        selectedLaneIndex={selectedLaneIndex}
        selectedChatIndex={selectedChatIndex}
        rowMeta={visibleRowMeta}
        rawSessions={sessions}
        focused={focused}
        mode={mode}
        loading={loading}
        unavailableLaneIds={unavailableLaneIds}
      />
    );
  }

  const headerTitle = addMode ? "PICK CHAT" : "LANES";
  const headerCount = addMode ? null : loading && lanes.length === 0 ? "…" : String(lanes.length);
  return (
    <Box width={width} flexDirection="column" borderStyle="single" borderColor={borderColor}>
      <Box paddingX={1} flexShrink={0}>
        <DrawerSectionRule
          title={headerTitle}
          count={headerCount}
          color={emphasisColor}
          glyph={theme.rail}
          width={width - 4}
        />
      </Box>

      <Box flexDirection="column" paddingX={1} flexGrow={1} flexShrink={1} overflow="hidden">
        {loading && laneRows.length === 0 ? (
          <Box paddingX={1}>
            <Text dimColor>Loading lanes…</Text>
          </Box>
        ) : null}
        {laneRows.map((lane, index) => {
          // laneRows is sliced by laneStart for scrolling; selection is tracked
          // as an absolute index resolved above so the highlight stays on the
          // right lane once the list is scrolled.
          const plan = layout.lanes[index]!;
          const isSelected = plan.laneIndex === selectedAbsoluteIndex;
          const isHovered = hoveredId?.startsWith(`drawer:lane:${lane.id}:`) ?? false;
          const meta = visibleRowMeta[index] ?? { depth: 0, isLast: false, prefix: "" };
          const worktreeAvailable = plan.worktreeAvailable;
          const status = deriveLaneStatus(lane, sessions, activeLaneId, unavailableLaneIds);
          const sessionsInLane = sessions.filter((session) => session.laneId === lane.id);
          const laneChatSessions = sessionsInLane.slice(0, plan.visibleChatCount);
          const showChatBlock = plan.expanded;
          // Flat rows: no side borders or per-card padding, so content uses the
          // full drawer width. Only the outer drawer border (2) + the lane
          // container paddingX (2) inset the content now.
          const cardInnerWidth = width - 4;
          // The top edge is a faint hairline separator for every card except the
          // first (whose top would otherwise double up the header rule). It tints
          // violet on the selected card to reinforce the selection rail.
          // Each lane is a rounded card. The box border IS the single selection
          // indicator — violet when selected, neutral otherwise — so there's no
          // second inner rail (that was the confusing "two lines"). Same two
          // border rows as before, so the mouse hit-test cadence is unchanged.
          const cardBorderColor = isSelected ? theme.color.violet : theme.color.border;
          const laneContentWidth = Math.max(10, cardInnerWidth - 4);
          return (
            <Box
              key={lane.id}
              borderStyle="round"
              borderColor={cardBorderColor}
              width={cardInnerWidth}
              paddingX={1}
              flexDirection="column"
              marginTop={index > 0 ? 1 : 0}
            >
              <LaneCard
                lane={lane}
                status={status}
                prefix={meta.prefix}
                width={laneContentWidth}
                selected={isSelected}
                hovered={isHovered}
                active={lane.id === activeLaneId}
                provider={sessionProviderFor(lane, sessions)}
                pr={prByLaneId[lane.id] ?? null}
                diffStats={diffByLaneId[lane.id] ?? null}
                worktreeAvailable={worktreeAvailable}
              />
              {showChatBlock ? (
                <ChatBlock
                  sessions={laneChatSessions}
                  activeSessionId={activeSessionId}
                  selectedChatIndex={selectedChatIndex}
                  width={laneContentWidth}
                  worktreeAvailable={worktreeAvailable}
                  interactive={mode === "chats"}
                  hoveredId={hoveredId}
                />
              ) : (
                <CompactChatPreview
                  sessions={laneChatSessions}
                  moreCount={plan.moreCount}
                  activeSessionId={activeSessionId}
                  width={laneContentWidth}
                  hoveredId={hoveredId}
                />
              )}
            </Box>
          );
        })}
      </Box>

      <DrawerFooter
        focused={focused}
        addMode={addMode}
        mode={mode}
        emphasisColor={emphasisColor}
        laneUnavailable={Boolean(browsingLane && unavailableLaneIds.has(browsingLane.id))}
      />
      <Box paddingX={1} flexShrink={0}>
        <Text
          color={focused && mode === "lanes" && selectedLaneIndex >= windowCount ? theme.color.violet : theme.color.t4}
          bold={focused && mode === "lanes" && selectedLaneIndex >= windowCount}
        >
          + new lane
        </Text>
      </Box>
    </Box>
  );
}

// Lane-card chrome note: the drawer's mouse hit-test (drawerMouseHitForLayout
// in drawerLayout.ts) models exactly two border rows per lane card (top +
// bottom) plus a 1-row margin between cards. The rounded box used per lane
// keeps exactly those two border rows, so the shared layout stays correct.

/**
 * A single-row titled hairline-rule section header (glyph + bold title + count
 * chip, then a rule that fills the remaining width). Stays exactly one row so
 * the parent's mouse hit-test row math is preserved. Mirrors the SectionHeader
 * primitive's look while keeping the literal "TITLE · N" string that callers and
 * tests rely on.
 */
function DrawerSectionRule({
  title,
  count,
  color,
  glyph,
  width,
}: {
  title: string;
  count: string | null;
  color: string;
  glyph?: string;
  width: number;
}) {
  const inner = Math.max(6, Math.floor(width));
  const countText = count != null ? ` · ${count}` : "";
  const used = (glyph ? glyph.length + 1 : 0) + title.length + countText.length + 1;
  const ruleLen = Math.max(0, inner - used);
  return (
    <Text wrap="truncate-end">
      {glyph ? <Text color={color}>{`${glyph} `}</Text> : null}
      <Text bold color={color}>{title}</Text>
      {countText ? <Text color={theme.color.t4} dimColor>{countText}</Text> : null}
      {ruleLen > 0 ? <Text color={theme.color.borderSoft}>{` ${"─".repeat(ruleLen)}`}</Text> : null}
    </Text>
  );
}

/**
 * Dim key-hint footer for the drawer. Mirrors the KeyHints design-kit look (keys
 * in accent, actions dim, `·` separators) but takes a per-mode accent so add
 * mode can stay amber. Renders a single truncating row; the surrounding region
 * is flexible and not part of the parent's row hit-test.
 */
function DrawerFooter({
  focused,
  addMode,
  mode,
  emphasisColor,
  laneUnavailable,
}: {
  focused: boolean;
  addMode: boolean;
  mode: DrawerMode;
  emphasisColor: string;
  laneUnavailable: boolean;
}) {
  // Two dim hint rows (mirrors the KeyHints look: keys in accent, actions dim,
  // `·` separators) so the full hint set fits a narrow drawer without
  // truncating the escape/confirm keys. The footer region is flexible and is
  // not part of the parent's mouse hit-test, so row count here is cosmetic.
  let primary: Array<[string, string]> = [];
  let secondary: Array<[string, string]> = [];
  let keyColor: string = theme.color.accent;
  if (!focused) {
    // keep two blank rows for stable vertical rhythm
  } else if (addMode) {
    keyColor = emphasisColor;
    primary = [["↑↓", "select chat in left pane"]];
    secondary = [["↵/click", "add"], ["esc", "cancel"]];
  } else if (mode === "chats") {
    primary = [["↑↓", laneUnavailable ? "lane unavailable" : "select chat"]];
    secondary = [["↵", "open"], ["esc", "lanes"], ["tab", "section"]];
  } else {
    primary = [["↑↓", "lanes"]];
    secondary = [["↵", "enter chats"], ["tab", "section"]];
  }
  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      <DrawerHintLine items={primary} keyColor={keyColor} />
      <DrawerHintLine items={secondary} keyColor={keyColor} />
    </Box>
  );
}

/** One dim key-hint row: `key action · key action · …`, truncating on overflow. */
function DrawerHintLine({ items, keyColor }: { items: Array<[string, string]>; keyColor: string }) {
  if (items.length === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate-end">
      {items.map(([key, action], index) => (
        <Text key={`${key}:${action}`}>
          {index > 0 ? <Text color={theme.color.t5} dimColor>{" · "}</Text> : null}
          <Text color={keyColor}>{key}</Text>
          <Text color={theme.color.t4} dimColor>{` ${action}`}</Text>
        </Text>
      ))}
    </Text>
  );
}

/**
 * Full two-line lane row rendered inside a per-lane card:
 *   line 1: [tree-prefix] name [chip if active state] [PR pill if any]
 *   line 2: [indent] exec branch · detail · age
 *
 * The card's border color already conveys the lane status, so we drop the rail
 * glyph and the redundant "idle" / "PRIMARY" chips.
 */
function LaneCard({
  lane,
  status,
  prefix,
  width,
  selected,
  active,
  provider,
  pr,
  diffStats,
  worktreeAvailable,
  hovered,
}: {
  lane: LaneSummary;
  status: LaneStatusKind;
  prefix: string;
  width: number;
  selected: boolean;
  active: boolean;
  provider: AdeCodeProvider | null;
  pr: DrawerPrSummary | null;
  diffStats: DiffLineStats | null;
  worktreeAvailable: boolean;
  hovered?: boolean;
}) {
  // Lane identity is now conveyed by tinting the NAME with the user-assigned
  // lane color (when set) instead of stacking a second vertical accent bar next
  // to the selection rail. Selection/active/hover/primary still win with violet
  // so the highlighted lane always reads as violet.
  const highlighted = selected || active || hovered || status === "primary";
  const nameColor = highlighted
    ? theme.color.violet
    : lane.color ?? theme.color.t1;
  const detail = laneDetailSuffix(lane, diffStats, worktreeAvailable);
  const exec = theme.provider(provider);
  const age = formatLaneAge(lane);
  const contentWidth = Math.max(10, width);

  // Hide the chip for idle (default) and primary (the lane is literally named
  // "Primary" — chip would just repeat it). Surface every other transient
  // state in plain text.
  const chipText = ((): string | null => {
    switch (status) {
      case "primary":
      case "idle":
        return null;
      case "running": return "run";
      case "attention": return "wait";
      case "failed": return worktreeAvailable ? "fail" : "no worktree";
      default: return null;
    }
  })();
  const chipColor = ((): string => {
    switch (status) {
      case "running": return theme.color.running;
      case "attention": return theme.color.attention;
      case "failed": return theme.color.error;
      default: return theme.color.t4;
    }
  })();

  // Status dot leads line 1 so a running/awaiting/failed lane pops at a glance
  // without parsing the chip text. Green is reserved for the live dot, amber for
  // awaiting, red for failed; idle stays a dim hollow ○, primary an info dot.
  const dot = statusGlyph(laneStatusDot(status));
  // Leading chrome on line 1: the status dot (1 cell) + space. (The selection
  // rail is gone — the card's box border now indicates selection.)
  const LEAD_WIDTH = 2;

  const indicatorWidth = prefix.length;
  const chipWidth = chipText ? chipText.length : 0;
  const prPillText = pr?.state === "open" ? formatPrPillText(pr) : null;
  const prPillWidth = prPillText?.length ?? 0;
  const chipReservation = chipWidth ? chipWidth + 1 : 0;
  const canShowPrPill = Boolean(prPillText)
    && contentWidth >= 22
    && contentWidth - indicatorWidth - chipReservation - prPillWidth - 1 >= 4;
  // VM lanes live on the Mac VM, not the host worktree path. Surface a small
  // badge so users in the TUI know `/commit`, `/push`, etc. operate against
  // the VM-attached lane (not a normal local worktree).
  const isVmLane = lane.runtimePlacement === "macos-vm";
  const VM_BADGE_WIDTH = 2;
  const rightReservationWithoutVm = chipReservation + (canShowPrPill ? prPillWidth + 1 : 0);
  const canShowVmBadge = isVmLane
    && contentWidth - indicatorWidth - rightReservationWithoutVm - VM_BADGE_WIDTH - 1 >= 3;
  const reservedRight = rightReservationWithoutVm + (canShowVmBadge ? VM_BADGE_WIDTH + 1 : 0);
  const nameMax = Math.max(3, contentWidth - indicatorWidth - LEAD_WIDTH - reservedRight);
  const name = truncate(lane.name, nameMax);

  // Line 2 indents under the name (past prefix + lead chrome), capped so deep
  // stacks don't push the meta line off a narrow drawer. The branch ref is
  // deliberately NOT rendered here — it was clutter; lane details / the header
  // still surface it when needed.
  const line2Indent = " ".repeat(Math.min(indicatorWidth + LEAD_WIDTH, 6));
  // Diff is rendered on its own third line under selected cards; never inline
  // on line 2. Hints (missing worktree, dirty, rebase, checkpoint Xd) appear
  // before the age on line 2.
  const inlineHint = detail.hint ?? "";
  const canShowAge = Boolean(age) && contentWidth >= 22;
  const metaWidth = contentWidth - line2Indent.length - 2 - (canShowAge ? age.length + 3 : 0);
  const truncHint = inlineHint ? truncate(inlineHint, Math.max(3, metaWidth)) : "";
  // Diff renders only when the card is selected — otherwise the line list stays
  // calm. Selected cards get an extra row under the branch with +adds/−dels.
  const showDiffLine = selected && detail.diff !== null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          {prefix ? <Text color={theme.color.t4}>{prefix}</Text> : null}
          <Text color={dot.color} bold={status === "running" || status === "attention"}>{dot.glyph} </Text>
          <Text color={nameColor} bold={selected || status === "primary"}>
            {pad(name, nameMax)}
          </Text>
          {chipText ? (
            <>
              <Text> </Text>
              <Text color={chipColor}>{chipText}</Text>
            </>
          ) : null}
          {canShowPrPill && pr ? (
            <>
              <Text> </Text>
              <PrPill pr={pr} />
            </>
          ) : null}
          {canShowVmBadge ? (
            <>
              <Text> </Text>
              <Text color={theme.color.info} bold>
                VM
              </Text>
            </>
          ) : null}
        </Text>
      </Box>
      <Box>
        <Text>
          <Text>{line2Indent}</Text>
          {provider ? (
            <Text color={exec.color}>{exec.glyph} </Text>
          ) : (
            <Text color={theme.color.t5}>· </Text>
          )}
          {truncHint ? (
            <Text color={theme.color.t3}>{truncHint}</Text>
          ) : null}
          {canShowAge && age ? (
            <>
              {truncHint ? <Text color={theme.color.t5}> · </Text> : null}
              <Text color={theme.color.t3}>{age}</Text>
            </>
          ) : null}
        </Text>
      </Box>
      {showDiffLine && detail.diff ? (
        <Box>
          <Text>
            <Text>{line2Indent}</Text>
            <Text color={theme.color.running}>+{detail.diff.add}</Text>
            <Text> </Text>
            <Text color={theme.color.error}>−{detail.diff.del}</Text>
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function formatPrPillText(pr: DrawerPrSummary): string {
  return `[#${pr.number} ·${pr.checksPassed}/${pr.checksTotal}]`;
}

function PrPill({ pr }: { pr: DrawerPrSummary }) {
  const checksColor = pr.checksPassed === pr.checksTotal ? theme.color.running : theme.color.attention;
  return (
    <Text>
      <Text color={theme.color.violet}>[#</Text>
      <Text color={theme.color.t1}>{pr.number}</Text>
      <Text color={theme.color.t3}> ·</Text>
      <Text color={checksColor}>{pr.checksPassed}</Text>
      <Text color={theme.color.t3}>/{pr.checksTotal}</Text>
      <Text color={theme.color.violet}>]</Text>
    </Text>
  );
}

/** Chat block rendered beneath the browsing lane row as a compact subsection. */
function ChatBlock({
  sessions,
  activeSessionId,
  selectedChatIndex,
  width,
  worktreeAvailable,
  interactive = true,
  hoveredId,
}: {
  sessions: AgentChatSessionSummary[];
  activeSessionId: string | null;
  selectedChatIndex: number;
  width: number;
  worktreeAvailable: boolean;
  interactive?: boolean;
  hoveredId?: string | null;
}) {
  if (!worktreeAvailable) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <DrawerSectionRule title="CHATS" count="unavailable" color={theme.color.t4} width={width} />
        </Box>
        <Box>
          <Text color={theme.color.error}>worktree missing</Text>
        </Box>
      </Box>
    );
  }
  // An empty lane still falls through to the normal render below, which shows
  // the "CHATS · 0" header and a working "+ new chat" row — matching the
  // hit-test, which always expects a new-chat row at the block start. (Returning
  // early here used to drop the button, leaving chatless lanes with no way to
  // start a chat.)
  const max = Math.max(8, width - 4);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <DrawerSectionRule title="CHATS" count={String(sessions.length)} color={theme.color.t3} width={width} />
      </Box>
      {sessions.map((session, index) => {
        const running = session.status === "active";
        const selected = interactive && index === selectedChatIndex;
        const hovered = hoveredId?.startsWith(`drawer:chat:${session.sessionId}:`) ?? false;
        const provider = (session.provider as AdeCodeProvider) ?? null;
        const exec = theme.provider(provider);
        const when = formatSessionAge(session);
        // Status dot leads each chat row so live/awaiting/ended state pops at a
        // glance: live ● (the running spinner takes over for the active chat),
        // awaiting ◔ amber, ended ✓, otherwise an idle ○. The provider brand
        // glyph follows to keep the agent identity, then the title.
        const dot = statusGlyph(chatStatusDot(session));
        const label = truncate(formatSessionLabel(session), max - 8);
        // White by default. Violet on selection (the only highlight state in a
        // TUI). The running spinner + activeSession dot already convey activity
        // — no need to also recolor the title, and bold is avoided because some
        // xterm builds render bold characters slightly wider, which makes the
        // selected row look outdented next to its neighbours.
        // Awaiting-input chats tint amber (a calm "needs you" signal) when not
        // selected; selection/hover still wins with violet. Running activity is
        // conveyed by the spinner, not a recolor.
        const titleColor: string = selected || hovered
          ? theme.color.violet
          : session.awaitingInput && !running
            ? theme.color.attention
            : theme.color.t1;
        return (
          <Box key={session.sessionId} marginTop={index > 0 ? 1 : 0}>
            {running ? (
              // Running chats carry their live signal via the trailing spinner
              // (kept adjacent to the age); lead with a blank so names stay
              // aligned with the idle/awaiting/done rows above and below.
              <Text>{"  "}</Text>
            ) : (
              <Text color={dot.color} bold={session.awaitingInput}>{dot.glyph} </Text>
            )}
            <Text color={exec.color}>{exec.glyph} </Text>
            <Text color={titleColor}>
              {label}
            </Text>
            <Text> </Text>
            {running ? <ActiveChatSpin /> : null}
            <Text color={theme.color.t4}>{when}</Text>
            {session.sessionId === activeSessionId ? (
              <Text color={theme.color.violet}> ●</Text>
            ) : null}
          </Box>
        );
      })}
      <Box>
        <Text color={(interactive && selectedChatIndex === sessions.length) || (hoveredId?.startsWith("drawer:new-chat:") ?? false) ? theme.color.violet : theme.color.t4}>
          + new chat
        </Text>
      </Box>
    </Box>
  );
}

function ActiveChatSpin() {
  const frame = useSpinFrame();
  return <Text color={theme.color.running}>{frame} </Text>;
}

/**
 * Always-visible compact chat rows under non-expanded lane cards: one row per
 * chat (status dot + provider glyph + title + age) and an optional dim
 * "+N more" row. No header, no "+ new chat" — those stay on the expanded
 * card. Row count MUST match the lane's DrawerLanePlan (visibleChatCount +
 * moreCount-row) so the drawer mouse hit-test stays aligned.
 */
function CompactChatPreview({
  sessions,
  moreCount,
  activeSessionId,
  width,
  hoveredId,
}: {
  sessions: AgentChatSessionSummary[];
  moreCount: number;
  activeSessionId: string | null;
  width: number;
  hoveredId?: string | null;
}) {
  if (sessions.length === 0 && moreCount <= 0) return null;
  const max = Math.max(8, width - 4);
  return (
    <Box flexDirection="column">
      {sessions.map((session) => {
        const running = session.status === "active";
        const hovered = hoveredId?.startsWith(`drawer:chat:${session.sessionId}:`) ?? false;
        const provider = (session.provider as AdeCodeProvider) ?? null;
        const exec = theme.provider(provider);
        const when = formatSessionAge(session);
        const dot = statusGlyph(chatStatusDot(session));
        const label = truncate(formatSessionLabel(session), max - 8);
        const titleColor: string = hovered
          ? theme.color.violet
          : session.awaitingInput && !running
            ? theme.color.attention
            : theme.color.t2;
        return (
          <Box key={session.sessionId}>
            <Text wrap="truncate-end">
              {running ? <Text>{"  "}</Text> : <Text color={dot.color} bold={session.awaitingInput}>{dot.glyph} </Text>}
              <Text color={exec.color}>{exec.glyph} </Text>
              <Text color={titleColor}>{label}</Text>
              <Text> </Text>
              {running ? <ActiveChatSpin /> : null}
              <Text color={theme.color.t4}>{when}</Text>
              {session.sessionId === activeSessionId ? (
                <Text color={theme.color.violet}> ●</Text>
              ) : null}
            </Text>
          </Box>
        );
      })}
      {moreCount > 0 ? (
        <Box>
          <Text color={theme.color.t5} dimColor wrap="truncate-end">{`  +${moreCount} more`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Mini-row drawer variant (single-line rows). Matches D3MiniRow in the wireframe. */
function MiniDrawer({
  width,
  borderColor,
  addMode,
  emphasisColor,
  lanes,
  laneStart,
  laneTotal,
  sessions,
  activeLaneId,
  activeSessionId,
  browsingLaneId,
  selectedLaneIndex,
  selectedChatIndex,
  rowMeta,
  rawSessions,
  focused,
  mode,
  loading,
  unavailableLaneIds,
}: {
  width: number;
  borderColor: string;
  addMode: boolean;
  emphasisColor: string;
  lanes: LaneSummary[];
  laneStart: number;
  laneTotal: number;
  sessions: AgentChatSessionSummary[];
  activeLaneId: string | null;
  activeSessionId: string | null;
  browsingLaneId: string | null;
  selectedLaneIndex: number;
  selectedChatIndex: number;
  rowMeta: Array<{ depth: number; isLast: boolean; prefix: string }>;
  rawSessions: AgentChatSessionSummary[];
  focused: boolean;
  mode: DrawerMode;
  loading: boolean;
  unavailableLaneIds: ReadonlySet<string>;
}) {
  void focused;
  void browsingLaneId;
  const hoveredId = useHoveredHitId();
  const inner = width - 2;
  return (
    <Box width={width} flexDirection="column" borderStyle="single" borderColor={borderColor}>
      <Box paddingX={1}>
        <Text bold color={addMode ? emphasisColor : theme.color.violet}>
          {addMode ? "PICK CHAT" : `LANES · ${loading && lanes.length === 0 ? "…" : lanes.length}`}
        </Text>
      </Box>
      {loading && lanes.length === 0 ? (
        <Box paddingX={1}>
          <Text dimColor>Loading lanes…</Text>
        </Box>
      ) : null}
      {lanes.map((lane, index) => {
        const status = deriveLaneStatus(lane, rawSessions, activeLaneId, unavailableLaneIds);
        const meta = rowMeta[index] ?? { depth: 0, prefix: "", isLast: false };
        // lanes is sliced by laneStart; selectedLaneIndex is window-relative.
        const selected = index === selectedLaneIndex;
        const hovered = hoveredId?.startsWith(`drawer:lane:${lane.id}:`) ?? false;
        const detail = formatLaneAge(lane);
        const isVmLane = lane.runtimePlacement === "macos-vm";
        const vmSuffixWidth = isVmLane ? 3 : 0;
        // Leading chrome: selection rail (1) + status dot (1) + space (1) = 3.
        const dot = statusGlyph(laneStatusDot(status));
        const nameMax = Math.max(4, inner - 5 - detail.length - meta.prefix.length - vmSuffixWidth);
        return (
          <Box key={lane.id} paddingX={1}>
            <Rail on={selected} />
            <Text color={dot.color} bold={status === "running" || status === "attention"}>
              {dot.glyph}{" "}
            </Text>
            {meta.prefix ? <Text color={theme.color.t4}>{meta.prefix}</Text> : <Text> </Text>}
            <Text
              color={selected || hovered || status === "primary" ? theme.color.violet : theme.color.t1}
              bold={selected || status === "primary"}
            >
              {pad(truncate(lane.name, nameMax), nameMax)}
            </Text>
            {isVmLane ? (
              <Text color={theme.color.info} bold>
                {" "}VM
              </Text>
            ) : null}
            <Text color={theme.color.t4}> {detail}</Text>
          </Box>
        );
      })}
      {mode === "chats" ? (
        <>
          <Box paddingX={1} marginTop={1}>
            <Text bold color={theme.color.violet}>
              CHATS · {sessions.length}
            </Text>
          </Box>
          {sessions.map((session, index) => {
            const selected = index === selectedChatIndex;
            const running = session.status === "active";
            const hovered = hoveredId?.startsWith(`drawer:chat:${session.sessionId}:`) ?? false;
            const provider = (session.provider as AdeCodeProvider) ?? null;
            const exec = theme.provider(provider);
            const when = formatSessionAge(session);
            const dot = statusGlyph(chatStatusDot(session));
            const nameMax = Math.max(4, inner - 5 - when.length);
            return (
              <Box key={session.sessionId} paddingX={1}>
                {running ? <ActiveChatSpin /> : <Text color={dot.color} bold={session.awaitingInput}>{dot.glyph} </Text>}
                <Text color={exec.color}>{exec.glyph}</Text>
                <Text> </Text>
                <Text
                  color={
                    selected || hovered || session.sessionId === activeSessionId || running
                      ? theme.color.violet
                      : theme.color.t2
                  }
                  bold={selected || running}
                >
                  {pad(truncate(formatSessionLabel(session), nameMax), nameMax)}
                </Text>
                <Text color={theme.color.t4}> {when}</Text>
              </Box>
            );
          })}
          <Box paddingX={1}>
            {lanes[selectedLaneIndex] && unavailableLaneIds.has(lanes[selectedLaneIndex]!.id) ? (
              <Text color={theme.color.error}>worktree missing</Text>
            ) : (
              <Text color={selectedChatIndex === sessions.length || (hoveredId?.startsWith("drawer:new-chat:") ?? false) ? theme.color.violet : theme.color.t4}>
                + new chat
              </Text>
            )}
          </Box>
        </>
      ) : null}
      <Box paddingX={1} flexShrink={0}>
        <Text color={theme.color.t4} wrap="truncate">
          {!focused
            ? "\n"
            : addMode
              ? "↑↓ pick chat · ↵ add · esc cancel"
              : mode === "chats"
                ? "↑↓ chats · Esc lanes"
                : "↑↓ lanes · ↵ open"}
        </Text>
      </Box>
      <Box paddingX={1} flexShrink={0}>
        <Text
          color={focused && mode === "lanes" && selectedLaneIndex >= lanes.length ? theme.color.violet : theme.color.t4}
          bold={focused && mode === "lanes" && selectedLaneIndex >= lanes.length}
        >
          + lane
        </Text>
      </Box>
    </Box>
  );
}

/** Best-effort: detect the exec/provider for a lane from its sessions. */
function sessionProviderFor(
  lane: LaneSummary,
  sessions: AgentChatSessionSummary[],
): AdeCodeProvider | null {
  // Prefer the most recently-active session in the lane. Fall back to the
  // most-recently-started.
  const laneSessions = sessions.filter((s) => s.laneId === lane.id);
  if (!laneSessions.length) return null;
  const ordered = [...laneSessions].sort((a, b) => {
    const aTs = Date.parse(a.lastActivityAt ?? a.startedAt ?? "");
    const bTs = Date.parse(b.lastActivityAt ?? b.startedAt ?? "");
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs)) return bTs - aTs;
    return 0;
  });
  const top = ordered[0];
  return (top?.provider as AdeCodeProvider) ?? null;
}
