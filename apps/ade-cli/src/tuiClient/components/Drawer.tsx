import React from "react";
import { Box, Text, useStdout } from "ink";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { DiffLineStats } from "../../../../desktop/src/shared/types/git";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import { formatSessionLabel } from "../format";
import { computeStackRowMeta, sortLanesForStackGraph } from "../laneTree";
import { formatRelativePastTime } from "../relativeTime";
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

function DrawerComponent({
  lanes,
  sessions,
  closedSessions = [],
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
  closedCliExpandedLaneIds = new Set<string>(),
}: {
  lanes: LaneSummary[];
  sessions: AgentChatSessionSummary[];
  closedSessions?: AgentChatSessionSummary[];
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
  closedCliExpandedLaneIds?: ReadonlySet<string>;
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
      closedChatCount: closedSessions.filter((s) => s.laneId === lane.id).length,
      closedExpanded: closedCliExpandedLaneIds.has(lane.id),
      worktreeAvailable: !unavailableLaneIds.has(lane.id),
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
  const laneClosedSessions = expandedPlan
    ? closedSessions
        .filter((s) => s.laneId === expandedPlan.laneId)
        .slice(0, expandedPlan.visibleClosedChatCount)
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
        closedSessions={laneClosedSessions}
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
          const closedInLane = closedSessions.filter((session) => session.laneId === lane.id);
          const laneChatSessions = sessionsInLane.slice(0, plan.visibleChatCount);
          const laneClosedChatSessions = closedInLane.slice(0, plan.visibleClosedChatCount);
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
                pr={prByLaneId[lane.id] ?? null}
                diffStats={diffByLaneId[lane.id] ?? null}
                worktreeAvailable={worktreeAvailable}
              />
              {showChatBlock ? (
                <ChatBlock
                  sessions={laneChatSessions}
                  closedSessions={laneClosedChatSessions}
                  closedCount={closedInLane.length}
                  closedExpanded={plan.closedExpanded}
                  closedToggleVisible={plan.closedToggleVisible}
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

export const Drawer = React.memo(DrawerComponent);

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
 * Single-line lane card row (rendered inside a per-lane rounded card):
 *   [tree-prefix] ● bold-name [PR pill] … +adds −dels
 *
 * The card's border color conveys selection; the status dot conveys run/await/
 * fail; the right edge carries the live diff (+adds/−dels), which replaces the
 * old "run" status chip and updates in place as the agent edits files. There is
 * no second meta line and no timestamp — the chats listed below already show
 * their own age, and the lane name is always bold.
 */
function LaneCard({
  lane,
  status,
  prefix,
  width,
  selected,
  active,
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
  pr: DrawerPrSummary | null;
  diffStats: DiffLineStats | null;
  worktreeAvailable: boolean;
  hovered?: boolean;
}) {
  // Selection/active/hover/primary win with violet; otherwise the lane keeps its
  // user-assigned color (or default text). The name is always bold so the lane
  // identity stays the row's anchor.
  const highlighted = selected || active || hovered || status === "primary";
  const nameColor = highlighted
    ? theme.color.violet
    : lane.color ?? theme.color.t1;
  const contentWidth = Math.max(10, width);

  // Status dot leads the row so a running/awaiting/failed lane pops at a glance:
  // live ● green, awaiting ◔ amber, failed red, idle a dim hollow ○, primary an
  // info dot.
  const dot = statusGlyph(laneStatusDot(status));
  const LEAD_WIDTH = 2; // status dot + space

  // Right cluster, in priority order: a missing/rebasing worktree wins over the
  // live diff. The diff is the common case and refreshes in place.
  const diff = worktreeAvailable && diffStats
    ? { add: diffStats.additions, del: diffStats.deletions }
    : null;
  type RightCluster =
    | { kind: "text"; text: string; color: string }
    | { kind: "diff"; add: number; del: number };
  const rightCluster: RightCluster | null = !worktreeAvailable
    ? { kind: "text", text: "no worktree", color: theme.color.error }
    : lane.status?.rebaseInProgress
      ? { kind: "text", text: "rebasing", color: theme.color.attention }
      : diff
        ? { kind: "diff", add: diff.add, del: diff.del }
        : null;
  const rightWidth = rightCluster == null
    ? 0
    : rightCluster.kind === "text"
      ? rightCluster.text.length
      : `+${rightCluster.add} −${rightCluster.del}`.length;

  const indicatorWidth = prefix.length;
  const prPillText = pr?.state === "open" ? formatPrPillText(pr) : null;
  const prPillWidth = prPillText?.length ?? 0;
  const rightReservation = rightWidth ? rightWidth + 1 : 0;
  const canShowPrPill = Boolean(prPillText)
    && contentWidth >= 22
    && contentWidth - indicatorWidth - LEAD_WIDTH - rightReservation - prPillWidth - 1 >= 4;
  const reservedRight = rightReservation + (canShowPrPill ? prPillWidth + 1 : 0);
  const nameMax = Math.max(3, contentWidth - indicatorWidth - LEAD_WIDTH - reservedRight);
  const name = truncate(lane.name, nameMax);

  return (
    <Box>
      <Text>
        {prefix ? <Text color={theme.color.t4}>{prefix}</Text> : null}
        <Text color={dot.color} bold={status === "running" || status === "attention"}>{dot.glyph} </Text>
        <Text color={nameColor} bold>
          {pad(name, nameMax)}
        </Text>
        {canShowPrPill && pr ? (
          <>
            <Text> </Text>
            <PrPill pr={pr} />
          </>
        ) : null}
        {rightCluster ? (
          <>
            <Text> </Text>
            {rightCluster.kind === "diff" ? (
              <Text>
                <Text color={theme.color.running}>+{rightCluster.add}</Text>
                <Text> </Text>
                <Text color={theme.color.error}>−{rightCluster.del}</Text>
              </Text>
            ) : (
              <Text color={rightCluster.color}>{rightCluster.text}</Text>
            )}
          </>
        ) : null}
      </Text>
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

/**
 * One chat row, identical whether it renders under a selected (expanded) lane or
 * a non-selected one — only the highlight/brightness differs. Layout:
 *   ● ◎ title …  spinner  ●(active)
 * The status dot leads (the running spinner replaces it for active chats), then
 * the provider brand glyph (same mark the model picker uses), the title, and a
 * trailing violet dot for the active chat. There is no timestamp — the panel
 * carries no ages. Always exactly one row tall so the mouse hit-test stays
 * aligned.
 */
function ChatRow({
  session,
  activeSessionId,
  max,
  selected,
  hovered,
  dimTitle,
}: {
  session: AgentChatSessionSummary;
  activeSessionId: string | null;
  max: number;
  selected: boolean;
  hovered: boolean;
  dimTitle: boolean;
}) {
  const running = session.status === "active";
  const provider = (session.provider as AdeCodeProvider) ?? null;
  const exec = theme.provider(provider);
  const dot = statusGlyph(chatStatusDot(session));
  // The age used to reserve trailing room; without it the title can run wider,
  // keeping just a little space for the spinner + active dot.
  const label = truncate(formatSessionLabel(session), max - 4);
  // Selection/hover wins with violet; awaiting-input tints amber as a calm
  // "needs you" signal; otherwise the title sits a touch dimmer under a
  // non-selected lane (dimTitle) than under the focused one.
  const titleColor: string = selected || hovered
    ? theme.color.violet
    : session.awaitingInput && !running
      ? theme.color.attention
      : dimTitle ? theme.color.t2 : theme.color.t1;
  return (
    <Box>
      <Text wrap="truncate-end">
        {running ? <Text>{"  "}</Text> : <Text color={dot.color} bold={session.awaitingInput}>{dot.glyph} </Text>}
        <Text color={exec.color}>{exec.glyph} </Text>
        <Text color={titleColor}>{label}</Text>
        {running ? <Text> <ActiveChatSpin /></Text> : null}
        {session.sessionId === activeSessionId ? (
          <Text color={theme.color.violet}> ●</Text>
        ) : null}
      </Text>
    </Box>
  );
}

/**
 * Chat block under the selected (expanded) lane: the same tight chat rows every
 * lane shows, plus a trailing interactive "+ new chat" row. There is no "CHATS"
 * header and no top margin, so an expanded lane looks just like a collapsed one
 * apart from its violet border + the extra new-chat affordance. An unavailable
 * worktree collapses to a single "worktree missing" row.
 */
function ChatBlock({
  sessions,
  closedSessions,
  closedCount,
  closedExpanded,
  closedToggleVisible,
  activeSessionId,
  selectedChatIndex,
  width,
  worktreeAvailable,
  interactive = true,
  hoveredId,
}: {
  sessions: AgentChatSessionSummary[];
  closedSessions: AgentChatSessionSummary[];
  closedCount: number;
  closedExpanded: boolean;
  closedToggleVisible: boolean;
  activeSessionId: string | null;
  selectedChatIndex: number;
  width: number;
  worktreeAvailable: boolean;
  interactive?: boolean;
  hoveredId?: string | null;
}) {
  if (!worktreeAvailable) {
    return (
      <Box>
        <Text color={theme.color.error}>worktree missing</Text>
      </Box>
    );
  }
  const max = Math.max(8, width - 4);
  const closedToggleIndex = sessions.length;
  const closedStartIndex = closedToggleIndex + (closedToggleVisible ? 1 : 0);
  const newChatIndex = closedStartIndex + (closedExpanded ? closedSessions.length : 0);
  return (
    <Box flexDirection="column">
      {sessions.map((session, index) => {
        const selected = interactive && index === selectedChatIndex;
        const hovered = hoveredId?.startsWith(`drawer:chat:${session.sessionId}:`) ?? false;
        return (
          <ChatRow
            key={session.sessionId}
            session={session}
            activeSessionId={activeSessionId}
            max={max}
            selected={selected}
            hovered={hovered}
            dimTitle={false}
          />
        );
      })}
      {closedToggleVisible ? (
        <ClosedCliToggleRow
          count={closedCount}
          expanded={closedExpanded}
          max={max}
          selected={interactive && selectedChatIndex === closedToggleIndex}
          hovered={hoveredId?.startsWith("drawer:closed-toggle:") ?? false}
        />
      ) : null}
      {closedExpanded ? closedSessions.map((session, index) => (
        <ClosedCliRow
          key={session.sessionId}
          session={session}
          max={max}
          selected={interactive && selectedChatIndex === closedStartIndex + index}
          hovered={hoveredId?.startsWith(`drawer:closed-chat:${session.sessionId}:`) ?? false}
        />
      )) : null}
      <Box>
        <Text color={(interactive && selectedChatIndex === newChatIndex) || (hoveredId?.startsWith("drawer:new-chat:") ?? false) ? theme.color.violet : theme.color.t4}>
          + new chat
        </Text>
      </Box>
    </Box>
  );
}

function ClosedCliToggleRow({
  count,
  expanded,
  max,
  selected,
  hovered,
}: {
  count: number;
  expanded: boolean;
  max: number;
  selected: boolean;
  hovered: boolean;
}) {
  const label = truncate(`${expanded ? "▾" : "▸"} closed (${count})`, max);
  return (
    <Box>
      <Text
        color={selected || hovered ? theme.color.violet : theme.color.t4}
        dimColor={!selected && !hovered}
        wrap="truncate-end"
      >
        {label}
      </Text>
    </Box>
  );
}

function ClosedCliRow({
  session,
  max,
  selected,
  hovered,
}: {
  session: AgentChatSessionSummary;
  max: number;
  selected: boolean;
  hovered: boolean;
}) {
  const provider = (session.provider as AdeCodeProvider) ?? null;
  const exec = theme.provider(provider);
  const dot = statusGlyph("idle");
  const ended = formatRelativePastTime(session.endedAt ?? session.lastActivityAt ?? session.startedAt);
  const suffix = ` ${ended}`;
  const label = truncate(formatSessionLabel(session), Math.max(3, max - suffix.length - 4));
  return (
    <Box>
      <Text wrap="truncate-end">
        <Text color={dot.color} dimColor>{dot.glyph} </Text>
        <Text color={exec.color}>{exec.glyph} </Text>
        <Text color={selected || hovered ? theme.color.violet : theme.color.t3} dimColor={!selected && !hovered}>
          {label}
        </Text>
        <Text color={theme.color.t5} dimColor>{suffix}</Text>
      </Text>
    </Box>
  );
}

function ActiveChatSpin() {
  const frame = useSpinFrame();
  return <Text color={theme.color.running}>{frame} </Text>;
}

/**
 * Always-visible chat rows under non-expanded lane cards: the same tight rows
 * the expanded block uses, plus an optional dim "+N more" row when the row
 * budget can't fit them all. No "+ new chat" — that stays on the selected card.
 * Row count MUST match the lane's DrawerLanePlan (visibleChatCount + moreCount
 * row) so the drawer mouse hit-test stays aligned.
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
        const hovered = hoveredId?.startsWith(`drawer:chat:${session.sessionId}:`) ?? false;
        return (
          <ChatRow
            key={session.sessionId}
            session={session}
            activeSessionId={activeSessionId}
            max={max}
            selected={false}
            hovered={hovered}
            dimTitle
          />
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
  closedSessions,
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
  closedSessions: AgentChatSessionSummary[];
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
  void closedSessions;
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
        // Leading chrome: selection rail (1) + status dot (1) + space (1) = 3.
        const dot = statusGlyph(laneStatusDot(status));
        const nameMax = Math.max(4, inner - 3 - meta.prefix.length);
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
            const dot = statusGlyph(chatStatusDot(session));
            const nameMax = Math.max(4, inner - 4);
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
