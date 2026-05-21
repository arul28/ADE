import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { LocalNotice, AdeCodeProvider } from "../types";
import type { ChatTextSelection } from "./ChatView";
import { ChatView } from "./ChatView";
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
        notices={notices}
        streaming={!!streamingBySessionId[tile.sessionId]}
        interrupted={!!interruptedBySessionId[tile.sessionId]}
        expandedLineIds={expandedLineIds}
        scrollOffsetRows={scrollBySessionId[tile.sessionId] ?? 0}
        selection={selectionBySessionId[tile.sessionId] ?? null}
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
                  notices={notices}
                  streaming={!!streamingBySessionId[tile.sessionId]}
                  interrupted={!!interruptedBySessionId[tile.sessionId]}
                  expandedLineIds={expandedLineIds}
                  scrollOffsetRows={scrollBySessionId[tile.sessionId] ?? 0}
                  selection={selectionBySessionId[tile.sessionId] ?? null}
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
