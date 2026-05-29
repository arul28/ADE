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

export function visibleDrawerLaneCount(panelHeight: number, laneCount: number): number {
  // Each lane card is 4 rows (2 content + 2 border) plus a 1-row margin between
  // adjacent cards. Header + footer hints + new-lane row eat about 6 rows of
  // outer chrome. Use 5 rows per card so the count stays inside the visible
  // panel even when the selected card also expands its chat block.
  const lanesMaxRows = Math.max(2, Math.floor((panelHeight - 6) / 5));
  return Math.min(laneCount, 12, lanesMaxRows);
}

export function visibleDrawerChatCount(chatCount: number, availableRows?: number): number {
  const cap = 12;
  if (availableRows == null) return Math.min(chatCount, cap);
  // Each chat row costs 2 rows (content + margin); first row has no margin.
  // The chat block also has a header ("CHATS · N") and a footer ("+ new chat"),
  // costing 3 rows of chrome (header + marginTop + footer).
  const chromeRows = 3;
  const maxByHeight = Math.max(1, Math.floor((availableRows - chromeRows + 1) / 2));
  return Math.min(chatCount, cap, maxByHeight);
}

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
  const visibleCount = visibleDrawerLaneCount(resolvedPanelHeight, ordered.length);
  const laneStart = Math.max(0, Math.min(scrollOffsetRows, Math.max(0, ordered.length - visibleCount)));
  const laneRows = ordered.slice(laneStart, laneStart + visibleCount);
  const visibleRowMeta = rowMeta.slice(laneStart, laneStart + laneRows.length);

  const browsing = browsingLaneId ?? activeLaneId;
  const browsingLane = laneRows.find((l) => l.id === browsing) ?? null;
  // Budget rows for the chat block: panel height minus outer chrome (header 1 +
  // footer hints 2 + new-lane 1 + borders 2 = 6) minus rows consumed by lane
  // cards (each non-selected card ~5 rows, selected card ~6 with diff line).
  const chatRowBudget = resolvedPanelHeight - 6 - laneRows.length * 5;
  const laneSessions = browsingLane
    ? sessions.filter((s) => s.laneId === browsingLane.id).slice(0, visibleDrawerChatCount(sessions.length, chatRowBudget))
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

  return (
    <Box width={width} flexDirection="column" borderStyle="single" borderColor={borderColor}>
      <Box paddingX={1} flexShrink={0}>
        <Text bold color={emphasisColor}>
          {addMode ? "PICK CHAT" : `LANES · ${loading && lanes.length === 0 ? "…" : lanes.length}`}
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={1} flexGrow={1} flexShrink={1} overflow="hidden">
        {loading && laneRows.length === 0 ? (
          <Box paddingX={1}>
            <Text dimColor>Loading lanes…</Text>
          </Box>
        ) : null}
        {laneRows.map((lane, index) => {
          const isSelected = index === selectedLaneIndex;
          const isHovered = hoveredId?.startsWith(`drawer:lane:${lane.id}:`) ?? false;
          const meta = visibleRowMeta[index] ?? { depth: 0, isLast: false, prefix: "" };
          const worktreeAvailable = !unavailableLaneIds.has(lane.id);
          const status = deriveLaneStatus(lane, sessions, activeLaneId, unavailableLaneIds);
          const isBrowsing = lane.id === browsing;
          const sessionsInLane = sessions.filter((session) => session.laneId === lane.id);
          const laneChatSessions = sessionsInLane.slice(0, visibleDrawerChatCount(sessionsInLane.length, chatRowBudget));
          const showChatBlock = mode === "chats"
            ? isBrowsing && browsingLane?.id === lane.id
            : isSelected;
          const cardBorder = cardBorderColor(isSelected);
          // width - 2 (outer drawer border) - 2 (lane container paddingX) - 2 (card border) - 2 (card paddingX)
          const cardInnerWidth = width - 8;
          return (
            <Box
              key={lane.id}
              borderStyle="round"
              borderColor={cardBorder}
              paddingX={1}
              flexDirection="column"
              marginTop={index > 0 ? 1 : 0}
            >
              <LaneCard
                lane={lane}
                status={status}
                prefix={meta.prefix}
                width={cardInnerWidth}
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
                  width={cardInnerWidth}
                  worktreeAvailable={worktreeAvailable}
                  interactive={mode === "chats"}
                  hoveredId={hoveredId}
                />
              ) : null}
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column" paddingX={1} flexShrink={0}>
        {!focused ? (
          <>
            <Text> </Text>
            <Text> </Text>
          </>
        ) : addMode ? (
          <>
            <Text color={theme.color.t4} wrap="truncate-end">
              <Text color={emphasisColor}>↑↓</Text>
              {" select chat in left pane"}
            </Text>
            <Text color={theme.color.t4} wrap="truncate-end">
              <Text color={emphasisColor}>↵/click</Text>
              {" add · "}
              <Text color={emphasisColor}>esc</Text>
              {" cancel"}
            </Text>
          </>
        ) : mode === "chats" ? (
          <>
            <Text color={theme.color.t4} wrap="truncate-end">
              <Text color={theme.color.violet}>↑↓</Text>
              {" "}
              {browsingLane && unavailableLaneIds.has(browsingLane.id) ? "lane unavailable" : "select chat"}
            </Text>
            <Text color={theme.color.t4} wrap="truncate-end">
              <Text color={theme.color.violet}>↵</Text>
              {" open · "}
              <Text color={theme.color.violet}>esc</Text>
              {" lanes · "}
              <Text color={theme.color.violet}>tab</Text>
              {" section"}
            </Text>
          </>
        ) : (
          <>
            <Text color={theme.color.t4} wrap="truncate-end">
              <Text color={theme.color.violet}>↑↓</Text>
              {" lanes"}
            </Text>
            <Text color={theme.color.t4} wrap="truncate-end">
              <Text color={theme.color.violet}>↵</Text>
              {" enter chats · "}
              <Text color={theme.color.violet}>tab</Text>
              {" section"}
            </Text>
          </>
        )}
      </Box>
      <Box paddingX={1} flexShrink={0}>
        <Text
          color={focused && mode === "lanes" && selectedLaneIndex >= laneRows.length ? theme.color.violet : theme.color.t4}
          bold={focused && mode === "lanes" && selectedLaneIndex >= laneRows.length}
        >
          + new lane
        </Text>
      </Box>
    </Box>
  );
}

function cardBorderColor(selected: boolean): string {
  return selected ? theme.color.violet : theme.color.border;
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
  const nameColor = selected || active || hovered || status === "primary" ? theme.color.violet : theme.color.t1;
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
      case "failed": return worktreeAvailable ? "fail" : "miss";
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
  // Lane identity: render the user-assigned lane color as a left accent rail so
  // it's visible in the drawer (the Header already honors it). Default lanes
  // (no explicit color) stay rail-free to keep the list calm.
  const laneAccent = lane.color ?? null;
  const laneRailWidth = laneAccent ? 2 : 0;
  const nameMax = Math.max(3, contentWidth - indicatorWidth - reservedRight - laneRailWidth);
  const name = truncate(lane.name, nameMax);

  const line2Indent = " ".repeat(Math.min(indicatorWidth, 4));
  const branch = lane.branchRef ?? "";
  // Diff is rendered on its own third line under selected cards; never inline
  // on line 2. Hints (missing worktree, dirty, rebase, checkpoint Xd) still
  // appear between branch and age on line 2.
  const inlineHint = detail.hint ?? "";
  const canShowAge = Boolean(age) && contentWidth >= 22;
  const metaWidth = contentWidth - line2Indent.length - 2 - (canShowAge ? age.length + 3 : 0);
  const hintMax = inlineHint ? Math.min(inlineHint.length, Math.max(0, metaWidth - 7)) : 0;
  const branchMax = Math.max(3, metaWidth - (hintMax ? hintMax + 3 : 0));
  const truncBranch = truncate(branch, branchMax);
  const truncHint = inlineHint ? truncate(inlineHint, hintMax) : "";
  // Diff renders only when the card is selected — otherwise the line list stays
  // calm. Selected cards get an extra row under the branch with +adds/−dels.
  const showDiffLine = selected && detail.diff !== null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          {prefix ? <Text color={theme.color.t4}>{prefix}</Text> : null}
          {laneAccent ? <Text color={laneAccent}>{"▎ "}</Text> : null}
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
          <Text color={theme.color.t3}>{truncBranch}</Text>
          {truncHint ? (
            <>
              <Text color={theme.color.t5}> · </Text>
              <Text color={theme.color.t3}>{truncHint}</Text>
            </>
          ) : null}
          {canShowAge && age ? (
            <>
              <Text color={theme.color.t5}> · </Text>
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
          <Text color={theme.color.t4}>CHATS · unavailable</Text>
        </Box>
        <Box>
          <Text color={theme.color.error}>worktree missing</Text>
        </Box>
      </Box>
    );
  }
  if (sessions.length === 0 && selectedChatIndex !== 0) {
    return (
      <Box marginTop={1}>
        <Text dimColor>No chats in lane.</Text>
      </Box>
    );
  }
  const max = Math.max(8, width - 4);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.color.t4}>CHATS · {sessions.length}</Text>
      </Box>
      {sessions.map((session, index) => {
        const running = session.status === "active";
        const selected = interactive && index === selectedChatIndex;
        const hovered = hoveredId?.startsWith(`drawer:chat:${session.sessionId}:`) ?? false;
        const provider = (session.provider as AdeCodeProvider) ?? null;
        const exec = theme.provider(provider);
        const when = formatSessionAge(session);
        const label = truncate(formatSessionLabel(session), max - 6);
        // White by default. Violet on selection (the only highlight state in a
        // TUI). The running spinner + activeSession dot already convey activity
        // — no need to also recolor the title, and bold is avoided because some
        // xterm builds render bold characters slightly wider, which makes the
        // selected row look outdented next to its neighbours.
        const titleColor: string = selected || hovered ? theme.color.violet : theme.color.t1;
        return (
          <Box key={session.sessionId} marginTop={index > 0 ? 1 : 0}>
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

/** Mini-row drawer variant (single-line rows). Matches D3MiniRow in the wireframe. */
function MiniDrawer({
  width,
  borderColor,
  addMode,
  emphasisColor,
  lanes,
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
        const selected = index === selectedLaneIndex;
        const hovered = hoveredId?.startsWith(`drawer:lane:${lane.id}:`) ?? false;
        const detail = formatLaneAge(lane);
        const isVmLane = lane.runtimePlacement === "macos-vm";
        const vmSuffixWidth = isVmLane ? 3 : 0;
        const nameMax = Math.max(4, inner - 3 - detail.length - meta.prefix.length - vmSuffixWidth);
        return (
          <Box key={lane.id} paddingX={1}>
            <Text color={theme.laneStatusColor(status)} bold>
              {theme.rail}
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
            const nameMax = Math.max(4, inner - 3 - when.length);
            return (
              <Box key={session.sessionId} paddingX={1}>
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
            {lanes[selectedLaneIndex] && unavailableLaneIds.has(lanes[selectedLaneIndex].id) ? (
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
