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

type DrawerDensity = "full" | "mini";
type DrawerMode = "lanes" | "chats";

const DRAWER_WIDTH_FULL = 32;
const DRAWER_WIDTH_MINI = 22;

export type DrawerPrSummary = {
  number: number;
  state: "open" | "closed" | "merged";
  checksPassed: number;
  checksTotal: number;
};

export function visibleDrawerLaneCount(panelHeight: number, laneCount: number): number {
  // Full drawer uses compact lane cards; leave room for a chat group + hints.
  const lanesMaxRows = Math.max(2, Math.floor((panelHeight - 5) / 4));
  return Math.min(laneCount, 12, lanesMaxRows);
}

export function visibleDrawerChatCount(chatCount: number): number {
  return Math.min(chatCount, 12);
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
  density = "full",
  mode = "lanes",
  prByLaneId = {},
  diffByLaneId = {},
  loading = false,
  unavailableLaneIds = new Set<string>(),
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
  density?: DrawerDensity;
  mode?: DrawerMode;
  prByLaneId?: Record<string, DrawerPrSummary>;
  diffByLaneId?: Record<string, DiffLineStats>;
  loading?: boolean;
  unavailableLaneIds?: ReadonlySet<string>;
}) {
  const { stdout } = useStdout();
  const resolvedPanelHeight = panelHeight ?? stdout?.rows ?? 40;
  const ordered = React.useMemo(() => sortLanesForStackGraph(lanes), [lanes]);
  const rowMeta = React.useMemo(() => computeStackRowMeta(ordered), [ordered]);
  const laneRows = ordered.slice(0, visibleDrawerLaneCount(resolvedPanelHeight, ordered.length));
  const visibleRowMeta = rowMeta.slice(0, laneRows.length);

  const browsing = browsingLaneId ?? activeLaneId;
  const browsingLane = laneRows.find((l) => l.id === browsing) ?? null;
  const laneSessions = browsingLane
    ? sessions.filter((s) => s.laneId === browsingLane.id).slice(0, visibleDrawerChatCount(sessions.length))
    : [];

  const width = density === "mini" ? DRAWER_WIDTH_MINI : DRAWER_WIDTH_FULL;
  const borderColor = focused ? theme.color.violet : theme.color.border;

  if (density === "mini") {
    return (
      <MiniDrawer
        width={width}
        borderColor={borderColor}
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
        <Text bold color={theme.color.violet}>
          LANES · {loading && lanes.length === 0 ? "…" : lanes.length}
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={0} flexGrow={1} flexShrink={1}>
        {loading && laneRows.length === 0 ? (
          <Box paddingX={1}>
            <Text dimColor>Loading lanes…</Text>
          </Box>
        ) : null}
        {laneRows.map((lane, index) => {
          const isSelected = index === selectedLaneIndex;
          const meta = visibleRowMeta[index] ?? { depth: 0, isLast: false, prefix: "" };
          const worktreeAvailable = !unavailableLaneIds.has(lane.id);
          const status = deriveLaneStatus(lane, sessions, activeLaneId, unavailableLaneIds);
          const isBrowsing = lane.id === browsing;
          const sessionsInLane = sessions.filter((session) => session.laneId === lane.id);
          const laneChatSessions = sessionsInLane.slice(0, visibleDrawerChatCount(sessionsInLane.length));
          const showChatBlock = mode === "chats"
            ? isBrowsing && browsingLane?.id === lane.id
            : isSelected;
          return (
            <React.Fragment key={lane.id}>
              <LaneCard
                lane={lane}
                status={status}
                prefix={meta.prefix}
                width={width - 2 /* borders */}
                selected={isSelected}
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
                  width={width - 2}
                  worktreeAvailable={worktreeAvailable}
                  interactive={mode === "chats"}
                />
              ) : null}
            </React.Fragment>
          );
        })}
      </Box>

      <Box paddingX={1} flexShrink={0}>
        <Text color={theme.color.t4} wrap="truncate">
          {!focused ? (
            "\n"
          ) : mode === "chats" ? (
            <>
              <Text color={theme.color.violet}>↑↓</Text>{" "}
              {browsingLane && unavailableLaneIds.has(browsingLane.id) ? "lane unavailable" : "open chat"}
              {"\n"}
              <Text color={theme.color.violet}>↑</Text> lane card · <Text color={theme.color.violet}>↓</Text> next lane
            </>
          ) : (
            <>
              <Text color={theme.color.violet}>↑↓</Text> lanes · chats preview
              {"\n"}
              <Text color={theme.color.violet}>↓</Text> enter chats · <Text color={theme.color.violet}>↵</Text> details
            </>
          )}
        </Text>
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

/**
 * Full two-line lane row:
 *   line 1: rail/prefix · name · [chip]
 *   line 2: exec · branch · detail · age
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
}) {
  const railColor = theme.laneStatusColor(status);
  const nameColor = selected || active || status === "primary" ? theme.color.violet : theme.color.t1;
  const detail = laneDetailSuffix(lane, diffStats, worktreeAvailable);
  const exec = theme.provider(provider);
  const age = formatLaneAge(lane);
  const contentWidth = Math.max(10, width - 4);

  const chipText = ((): string => {
    switch (status) {
      case "primary": return "PRIMARY";
      case "running": return "run";
      case "attention": return "wait";
      case "failed": return worktreeAvailable ? "fail" : "miss";
      default: return "idle";
    }
  })();
  const chipColor = ((): string => {
    switch (status) {
      case "primary": return theme.color.violet;
      case "running": return theme.color.running;
      case "attention": return theme.color.attention;
      case "failed": return theme.color.error;
      default: return theme.color.t4;
    }
  })();

  // Indicator column (rail or stack prefix). Width: prefix may be 0..N chars.
  const indicator = prefix ? prefix : `${theme.rail} `;
  const indicatorWidth = indicator.length;
  const chipWidth = chipText.length;
  const prPillText = pr?.state === "open" ? formatPrPillText(pr) : null;
  const prPillWidth = prPillText?.length ?? 0;
  const canShowPrPill = Boolean(prPillText) && contentWidth >= 24 && contentWidth - indicatorWidth - chipWidth - prPillWidth - 3 >= 4;
  const nameMax = Math.max(3, contentWidth - indicatorWidth - chipWidth - (canShowPrPill ? prPillWidth + 1 : 0) - 1);
  const name = truncate(lane.name, nameMax);

  const line2Indent = " ".repeat(Math.min(indicatorWidth, 4));
  const branch = lane.branchRef ?? "";
  const detailText = detail.diff
    ? `+${detail.diff.add} −${detail.diff.del}`
    : detail.hint ?? "";
  const canShowAge = Boolean(age) && contentWidth >= 22;
  const metaWidth = contentWidth - line2Indent.length - 2 - (canShowAge ? age.length + 3 : 0);
  const detailMax = detailText ? Math.min(detailText.length, Math.max(0, metaWidth - 7)) : 0;
  const branchMax = Math.max(3, metaWidth - (detailMax ? detailMax + 3 : 0));
  const truncBranch = truncate(branch, branchMax);
  const truncDetail = detailText ? truncate(detailText, detailMax) : "";

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={selected ? theme.color.violet : theme.color.border} paddingX={1}>
      <Box>
        <Text>
          {prefix ? (
            <Text color={theme.color.t4}>{prefix}</Text>
          ) : (
            <Text color={railColor} bold>
              {theme.rail}
              {" "}
            </Text>
          )}
          <Text color={nameColor} bold={selected || status === "primary"}>
            {pad(name, nameMax)}
          </Text>
          <Text> </Text>
          <Text color={chipColor}>{chipText}</Text>
          {canShowPrPill && pr ? (
            <>
              <Text> </Text>
              <PrPill pr={pr} />
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
          {truncDetail ? (
            <>
              <Text color={theme.color.t5}> · </Text>
              {detail.diff && truncDetail === detailText ? (
                <Text>
                  <Text color={theme.color.running}>+{detail.diff.add}</Text>
                  <Text> </Text>
                  <Text color={theme.color.error}>−{detail.diff.del}</Text>
                </Text>
              ) : (
                <Text color={theme.color.t3}>{truncDetail}</Text>
              )}
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
 * Chat block rendered beneath the browsing lane row, with a violet left border
 * matching DFChat from the wireframe.
 */
function ChatBlock({
  sessions,
  activeSessionId,
  selectedChatIndex,
  width,
  worktreeAvailable,
  interactive = true,
}: {
  sessions: AgentChatSessionSummary[];
  activeSessionId: string | null;
  selectedChatIndex: number;
  width: number;
  worktreeAvailable: boolean;
  interactive?: boolean;
}) {
  if (!worktreeAvailable) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={theme.color.violet}>│ </Text>
          <Text color={theme.color.t4}>CHATS · unavailable</Text>
        </Box>
        <Box>
          <Text color={theme.color.violet}>│ </Text>
          <Text color={theme.color.error}>worktree missing</Text>
        </Box>
      </Box>
    );
  }
  if (sessions.length === 0 && selectedChatIndex !== 0) {
    return (
      <Box paddingLeft={2}>
        <Text color={theme.color.violet}>│ </Text>
        <Text dimColor>No chats in lane.</Text>
      </Box>
    );
  }
  const max = Math.max(8, width - 4);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.color.violet}>│ </Text>
        <Text color={theme.color.t4}>CHATS · {sessions.length}</Text>
      </Box>
      {sessions.map((session, index) => {
        const running = session.status === "active";
        const selected = interactive && index === selectedChatIndex;
        const provider = (session.provider as AdeCodeProvider) ?? null;
        const exec = theme.provider(provider);
        const when = formatSessionAge(session);
        const label = truncate(formatSessionLabel(session), max - 6);
        let titleColor: string = theme.color.t2;
        if (running) {
          titleColor = theme.color.violet;
        } else if (selected) {
          titleColor = theme.color.t1;
        }
        return (
          <Box key={session.sessionId}>
            <Text color={theme.color.violet}>│ </Text>
            <Text color={exec.color}>{exec.glyph} </Text>
            <Text color={titleColor} bold={running || selected}>
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
        <Text color={theme.color.violet}>│ </Text>
        <Text color={interactive && selectedChatIndex === sessions.length ? theme.color.violet : theme.color.t4}>
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
  const inner = width - 2;
  return (
    <Box width={width} flexDirection="column" borderStyle="single" borderColor={borderColor}>
      <Box paddingX={1}>
        <Text bold color={theme.color.violet}>
          LANES · {loading && lanes.length === 0 ? "…" : lanes.length}
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
        const detail = formatLaneAge(lane);
        const nameMax = Math.max(4, inner - 3 - detail.length - meta.prefix.length);
        return (
          <Box key={lane.id} paddingX={1}>
            <Text color={theme.laneStatusColor(status)} bold>
              {theme.rail}
            </Text>
            {meta.prefix ? <Text color={theme.color.t4}>{meta.prefix}</Text> : <Text> </Text>}
            <Text
              color={selected || status === "primary" ? theme.color.violet : theme.color.t1}
              bold={selected || status === "primary"}
            >
              {pad(truncate(lane.name, nameMax), nameMax)}
            </Text>
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
                    selected || session.sessionId === activeSessionId || running
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
              <Text color={selectedChatIndex === sessions.length ? theme.color.violet : theme.color.t4}>
                + new chat
              </Text>
            )}
          </Box>
        </>
      ) : null}
      <Box paddingX={1} flexShrink={0}>
        <Text color={theme.color.t4} wrap="truncate">
          {!focused ? "\n" : mode === "chats" ? "↑↓ chats · Esc lanes" : "↑↓ lanes · ↵ open"}
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
