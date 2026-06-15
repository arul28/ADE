import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { ChatTerminalPreviewResult, ChatTerminalSession } from "../../../../desktop/src/shared/types";
import type { LocalNotice, AdeCodeProvider } from "../types";
import type { ChatTextSelection } from "./ChatView";
import { ChatView } from "./ChatView";
import { TerminalPane } from "./TerminalPane";
import { readTerminalScroll, type TerminalScrollBySessionId } from "./TerminalScrollState";
import {
  asTileCount,
  canRenderMultiChatGrid,
  computeTileRects,
  type MultiViewTile,
} from "../multiChatLayout";
import { useHitTestTarget } from "../hitTestRegistry";
import { theme } from "../theme";

type TileData = {
  tile: MultiViewTile;
  session: AgentChatSessionSummary | null;
  lane: LaneSummary | null;
};

// Mirrors app.tsx isClaudePlaceholderTitle: a Claude session still on a generic
// title is awaiting the background auto-naming job (shown as "naming…").
const CLAUDE_PLACEHOLDER_TILE_TITLES = new Set(["claude", "claude cli", "claude session", "claude code"]);
function isPlaceholderTerminalTitle(title: string | null | undefined): boolean {
  const normalized = String(title ?? "").trim().toLowerCase();
  return normalized.length === 0 || CLAUDE_PLACEHOLDER_TILE_TITLES.has(normalized);
}

// Mirrors ChatView's tile frame so terminal tiles read the same as chat tiles:
// border accents the focused tile (violet/double), lane identity lives inside via
// a colored rail + title, and a × remove affordance sits top-right.
function TerminalChatTile({
  terminal,
  laneName,
  laneAccent,
  rect,
  focused,
  hovered,
  removeHovered,
  preview,
  liveChunks,
  attached,
  scrollOffset,
  pendingNewCount,
  onRemove,
}: {
  terminal: ChatTerminalSession;
  laneName: string;
  laneAccent: string | null;
  rect: { w: number; h: number };
  focused: boolean;
  hovered: boolean;
  removeHovered: boolean;
  preview: ChatTerminalPreviewResult | null;
  liveChunks: string[];
  attached: boolean;
  scrollOffset: number;
  pendingNewCount: number;
  onRemove: () => void;
}) {
  const running = terminal.status === "running";
  const statusGlyph = running ? "●" : "○";
  const statusColor = running ? theme.color.running : theme.color.t5;
  const tileBorderColor = focused
    ? theme.color.violet
    : hovered
      ? theme.color.borderActive
      : theme.color.border;
  const headerColor = focused ? theme.color.violet : running ? theme.color.t2 : theme.color.t4;
  const naming = running && isPlaceholderTerminalTitle(terminal.title);
  const railSlot = laneAccent ? 2 : 0;
  const innerWidth = Math.max(4, rect.w - 2);
  const header = `${laneName} / ${terminal.title}`.slice(0, Math.max(4, innerWidth - railSlot - 4));
  return (
    <Box
      flexDirection="column"
      borderStyle={focused ? "double" : "round"}
      borderColor={tileBorderColor}
      height={rect.h}
      width={rect.w}
    >
      <Box paddingX={1} flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <Box flexDirection="row" flexShrink={1}>
          {laneAccent ? <Text color={laneAccent}>{"▎ "}</Text> : null}
          <Text color={headerColor} wrap="truncate-end">{header}</Text>
          {naming ? <Text color={theme.color.accent}>{" · naming…"}</Text> : null}
        </Box>
        <Box flexDirection="row" flexShrink={0}>
          <Text color={statusColor}>{statusGlyph}</Text>
          <Text color={removeHovered ? theme.color.error : theme.color.t4} inverse={removeHovered}>
            {" ×"}
          </Text>
        </Box>
      </Box>
      <TerminalPane
        bodyOnly
        title={terminal.title}
        terminalId={terminal.terminalId}
        preview={preview}
        liveChunks={liveChunks}
        attached={attached}
        width={innerWidth}
        height={Math.max(1, rect.h - 3)}
        scrollOffset={scrollOffset}
        pendingNewCount={pendingNewCount}
      />
    </Box>
  );
}

// Stable empty array for tiles with no notices, so ChatView's aggregation memo
// stays intact instead of re-running on a fresh [] every render.
const NO_NOTICES: LocalNotice[] = [];

function groupRows<T extends { rect: { x: number; y: number } }>(entries: T[]): T[][] {
  const rows = new Map<number, T[]>();
  for (const entry of entries) {
    const bucket = rows.get(entry.rect.y) ?? [];
    bucket.push(entry);
    rows.set(entry.rect.y, bucket);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row.sort((a, b) => a.rect.x - b.rect.x));
}

function providerForTile(session: AgentChatSessionSummary | null, fallback?: AdeCodeProvider | null): AdeCodeProvider | null | undefined {
  const provider = session?.provider;
  if (
    provider === "codex"
    || provider === "claude"
    || provider === "opencode"
    || provider === "cursor"
    || provider === "droid"
  ) {
    return provider as AdeCodeProvider;
  }
  return fallback;
}

function MultiChatTile({
  index,
  data,
  rect,
  baseX,
  baseY,
  projectName,
  provider,
  modelDisplay,
  focused,
  events,
  notices,
  streaming,
  interrupted,
  expandedLineIds,
  scrollOffsetRows,
  selection,
  terminalSession,
  terminalPreview,
  terminalLiveChunks,
  terminalScroll,
  terminalAttached,
  onFocusTile,
  onRemoveTile,
}: {
  index: number;
  data: TileData;
  rect: { x: number; y: number; w: number; h: number };
  baseX: number;
  baseY: number;
  projectName: string;
  provider?: AdeCodeProvider | null;
  modelDisplay?: string | null;
  focused: boolean;
  events: AgentChatEventEnvelope[];
  notices: LocalNotice[];
  streaming: boolean;
  interrupted: boolean;
  expandedLineIds?: Set<string>;
  scrollOffsetRows: number;
  selection: ChatTextSelection | null;
  terminalSession?: ChatTerminalSession | null;
  terminalPreview?: ChatTerminalPreviewResult | null;
  terminalLiveChunks?: string[];
  terminalScroll?: { scrollOffset: number; pendingNewCount: number };
  terminalAttached?: boolean;
  onFocusTile: (index: number) => void;
  onRemoveTile: (index: number) => void;
}) {
  const tileId = `multi-chat:tile:${data.tile.sessionId}`;
  const removeId = `multi-chat:remove:${data.tile.sessionId}`;
  const hovered = useHitTestTarget({
    id: tileId,
    rect: {
      x: baseX + rect.x,
      y: baseY + rect.y,
      w: rect.w,
      h: rect.h,
    },
    onClick: () => onFocusTile(index),
    zIndex: 5,
  });
  const removeHovered = useHitTestTarget({
    id: removeId,
    rect: {
      x: baseX + rect.x + Math.max(0, rect.w - 3),
      y: baseY + rect.y + 1,
      w: 2,
      h: 1,
    },
    onClick: () => onRemoveTile(index),
    zIndex: 10,
  });
  if (terminalSession) {
    return (
      <TerminalChatTile
        terminal={terminalSession}
        laneName={data.lane?.name ?? data.tile.laneId}
        laneAccent={data.lane?.color ?? null}
        rect={rect}
        focused={focused}
        hovered={hovered}
        removeHovered={removeHovered}
        preview={terminalPreview ?? null}
        liveChunks={terminalLiveChunks ?? []}
        attached={Boolean(terminalAttached)}
        scrollOffset={terminalScroll?.scrollOffset ?? 0}
        pendingNewCount={terminalScroll?.pendingNewCount ?? 0}
        onRemove={() => onRemoveTile(index)}
      />
    );
  }
  return (
    <ChatView
      events={events}
      notices={notices}
      activeSession={data.session}
      projectName={projectName}
      laneName={data.lane?.name ?? data.tile.laneId}
      lane={data.lane}
      provider={providerForTile(data.session, provider)}
      modelDisplay={data.session?.model ?? modelDisplay}
      streaming={streaming}
      interrupted={interrupted}
      expandedLineIds={expandedLineIds}
      maxRows={rect.h}
      scrollOffsetRows={scrollOffsetRows}
      selection={selection}
      width={rect.w}
      focused={focused}
      hovered={hovered}
      removeHovered={removeHovered}
      onRemove={() => onRemoveTile(index)}
    />
  );
}

export function MultiChatGrid({
  tiles,
  focusedIndex,
  width,
  height,
  baseX,
  baseY,
  projectName,
  provider,
  modelDisplay,
  lanesById,
  sessionBySessionId,
  eventsBySessionId,
  notices,
  streamingBySessionId,
  interruptedBySessionId,
  scrollBySessionId,
  selectionBySessionId,
  expandedLineIds,
  terminalSessionById,
  terminalPreviewById,
  terminalLiveChunksById,
  terminalScrollBySessionId,
  attachedTerminalId,
  onFocusTile,
  onRemoveTile,
}: {
  tiles: MultiViewTile[];
  focusedIndex: number;
  width: number;
  height: number;
  baseX: number;
  baseY: number;
  projectName: string;
  provider?: AdeCodeProvider | null;
  modelDisplay?: string | null;
  lanesById: Record<string, LaneSummary>;
  sessionBySessionId: Record<string, AgentChatSessionSummary>;
  eventsBySessionId: Record<string, AgentChatEventEnvelope[]>;
  notices: LocalNotice[];
  streamingBySessionId: Record<string, boolean>;
  interruptedBySessionId: Record<string, boolean>;
  scrollBySessionId: Record<string, number>;
  selectionBySessionId: Record<string, ChatTextSelection | null>;
  expandedLineIds?: Set<string>;
  terminalSessionById?: Record<string, ChatTerminalSession>;
  terminalPreviewById?: Record<string, ChatTerminalPreviewResult>;
  terminalLiveChunksById?: Record<string, string[]>;
  terminalScrollBySessionId?: TerminalScrollBySessionId;
  attachedTerminalId?: string | null;
  onFocusTile: (index: number) => void;
  onRemoveTile: (index: number) => void;
}) {
  const safeTiles = useMemo(() => tiles.slice(0, 6), [tiles]);
  const tileCount = asTileCount(safeTiles.length);
  const rects = useMemo(() => computeTileRects(tileCount, width, height), [height, tileCount, width]);
  const rows = useMemo(() => groupRows(safeTiles.map((tile, index) => ({
    tile,
    index,
    rect: rects[index] ?? rects[0]!,
  }))), [rects, safeTiles]);
  // Each notice is tagged with the chat that fired it, so a tile only shows its own
  // session's notices. Session-less notices attach to the focused tile so global
  // feedback stays visible. Resolved once per (notices, tiles, focus) change so token
  // streaming keeps stable array identities and ChatView's aggregation memo intact.
  const noticesByTileSession = useMemo(() => {
    const bySession = new Map<string, LocalNotice[]>();
    const global: LocalNotice[] = [];
    for (const notice of notices) {
      if (notice.sessionId) {
        const bucket = bySession.get(notice.sessionId);
        if (bucket) bucket.push(notice);
        else bySession.set(notice.sessionId, [notice]);
      } else {
        global.push(notice);
      }
    }
    const focusedSessionId = safeTiles[Math.max(0, Math.min(focusedIndex, safeTiles.length - 1))]?.sessionId;
    const resolved = new Map<string, LocalNotice[]>();
    for (const tile of safeTiles) {
      const own = bySession.get(tile.sessionId) ?? NO_NOTICES;
      resolved.set(
        tile.sessionId,
        tile.sessionId === focusedSessionId && global.length ? [...own, ...global] : own,
      );
    }
    return resolved;
  }, [notices, safeTiles, focusedIndex]);

  if (!safeTiles.length) {
    return (
      <Box width={width} height={height} paddingX={1}>
        <Text color={theme.color.t4} dimColor>No chats open.</Text>
      </Box>
    );
  }

  if (!canRenderMultiChatGrid(safeTiles.length, width, height)) {
    const tile = safeTiles[Math.max(0, Math.min(focusedIndex, safeTiles.length - 1))];
    const session = sessionBySessionId[tile.sessionId] ?? null;
    const lane = lanesById[tile.laneId] ?? null;
    return (
      <MultiChatTile
        index={Math.max(0, Math.min(focusedIndex, safeTiles.length - 1))}
        data={{ tile, session, lane }}
        rect={{ x: 0, y: 0, w: width, h: height }}
        baseX={baseX}
        baseY={baseY}
        projectName={projectName}
        provider={provider}
        modelDisplay={modelDisplay}
        focused
        events={eventsBySessionId[tile.sessionId] ?? []}
        notices={noticesByTileSession.get(tile.sessionId) ?? NO_NOTICES}
        streaming={!!streamingBySessionId[tile.sessionId]}
        interrupted={!!interruptedBySessionId[tile.sessionId]}
        expandedLineIds={expandedLineIds}
        scrollOffsetRows={scrollBySessionId[tile.sessionId] ?? 0}
        selection={selectionBySessionId[tile.sessionId] ?? null}
        terminalSession={terminalSessionById?.[tile.sessionId] ?? null}
        terminalPreview={terminalPreviewById?.[tile.sessionId] ?? null}
        terminalLiveChunks={terminalLiveChunksById?.[tile.sessionId] ?? []}
        terminalScroll={readTerminalScroll(terminalScrollBySessionId ?? {}, tile.sessionId)}
        terminalAttached={attachedTerminalId === tile.sessionId}
        onFocusTile={onFocusTile}
        onRemoveTile={onRemoveTile}
      />
    );
  }

  return (
    <Box width={width} height={height} flexDirection="column">
      {rows.map((row, rowIndex) => (
        <Box
          key={`row:${rowIndex}:${row[0]?.rect.y ?? 0}`}
          flexDirection="row"
          height={row[0]?.rect.h ?? height}
        >
          {row.map(({ tile, index, rect }) => {
            const session = sessionBySessionId[tile.sessionId] ?? null;
            const lane = lanesById[tile.laneId] ?? null;
            return (
              <Box key={tile.sessionId} width={rect.w} height={rect.h}>
                <MultiChatTile
                  index={index}
                  data={{ tile, session, lane }}
                  rect={rect}
                  baseX={baseX}
                  baseY={baseY}
                  projectName={projectName}
                  provider={provider}
                  modelDisplay={modelDisplay}
                  focused={index === focusedIndex}
                  events={eventsBySessionId[tile.sessionId] ?? []}
                  notices={noticesByTileSession.get(tile.sessionId) ?? NO_NOTICES}
                  streaming={!!streamingBySessionId[tile.sessionId]}
                  interrupted={!!interruptedBySessionId[tile.sessionId]}
                  expandedLineIds={expandedLineIds}
                  scrollOffsetRows={scrollBySessionId[tile.sessionId] ?? 0}
                  selection={selectionBySessionId[tile.sessionId] ?? null}
                  terminalSession={terminalSessionById?.[tile.sessionId] ?? null}
                  terminalPreview={terminalPreviewById?.[tile.sessionId] ?? null}
                  terminalLiveChunks={terminalLiveChunksById?.[tile.sessionId] ?? []}
                  terminalScroll={readTerminalScroll(terminalScrollBySessionId ?? {}, tile.sessionId)}
                  terminalAttached={attachedTerminalId === tile.sessionId}
                  onFocusTile={onFocusTile}
                  onRemoveTile={onRemoveTile}
                />
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
