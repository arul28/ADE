import React from "react";
import { Box, Text, useStdout } from "ink";
import { theme } from "../theme";
import { useHoveredHitId } from "../hitTestRegistry";
import { padDisplayEnd, padDisplayStart, terminalDisplayWidth, truncateDisplayEnd } from "../displayWidth";
import {
  computeWorkListLayout,
  type WorkListLayout,
} from "../workListLayout";
import type {
  WorkListModel,
  WorkListLaneHeaderRow,
  WorkListSessionRow,
  WorkListShelfRow,
} from "../workListModel";
import {
  EMPTY_PLUGIN_ROW_BADGE_STRIP,
  fitPluginBadgeStrip,
  pluginBadgeStripWidth,
  type PluginRowBadgeStrip,
} from "../pluginSockets";

/**
 * ADE Code's left pane: the desktop Work list, one session per card.
 *
 * Card anatomy (desktop `SessionCard` parity):
 *   line 1  where (age, or lane name on a singleton) …… glyph + status + timer
 *   line 2  title
 *   line 3  preview italic
 *
 * Every row shares a 2-cell left column: lane headers put the lane icon
 * there so it sits to the left of the cards, which indent under the name.
 * Provider logos stay out — a terminal cannot paint those assets.
 */

const PANE_WIDTH_MIN = 32;
const PANE_WIDTH_MAX = 48;
/** Fixed right column: glyph, then label, then elapsed — desktop SessionStatusLabel order. */
const STATUS_CLUSTER_CELLS = 18;
const GUTTER_CELLS = 2;
/** Keep a visible divider after the lane name so the header reads as a rule. */
const HEADER_RULE_MIN = 6;

function rowGutter(highlighted: boolean): string {
  return highlighted ? `${theme.rail} ` : "  ";
}

function laneMark(icon: string | null | undefined): string {
  return `${theme.laneIconGlyph(icon)} `;
}

function PluginBadges({ strip }: { strip: PluginRowBadgeStrip }) {
  if (strip.cells.length === 0) return null;
  return (
    <Text>
      {strip.cells.map((cell, index) => (
        <Text key={cell.key}>
          {index > 0 ? <Text> </Text> : null}
          <Text color={theme.vocabToneColor(cell.tone)}>{`[${cell.text}]`}</Text>
        </Text>
      ))}
      {strip.overflowCount > 0 ? (
        <Text color={theme.color.t4} dimColor>{` +${strip.overflowCount}`}</Text>
      ) : null}
    </Text>
  );
}

export function WorkSessionsPaneComponent({
  model,
  layout: providedLayout,
  selectedKey,
  panelHeight,
  width: requestedWidth,
  focused = false,
  pickerMode = false,
  loading = false,
  scrollOffsetRows = 0,
  pluginLaneBadges = {},
  pluginChatBadges = {},
}: {
  model: WorkListModel;
  /** Layout to render from. Omitted only in tests that do not exercise scrolling. */
  layout?: WorkListLayout;
  selectedKey: string | null;
  panelHeight?: number;
  width?: number;
  focused?: boolean;
  /** Add-to-grid picker: the pane is a chooser, so the hints change. */
  pickerMode?: boolean;
  loading?: boolean;
  scrollOffsetRows?: number;
  pluginLaneBadges?: Readonly<Record<string, PluginRowBadgeStrip>>;
  pluginChatBadges?: Readonly<Record<string, PluginRowBadgeStrip>>;
}) {
  const { stdout } = useStdout();
  const resolvedPanelHeight = panelHeight ?? stdout?.rows ?? 40;
  const width = Math.max(
    PANE_WIDTH_MIN,
    Math.min(PANE_WIDTH_MAX, Math.floor(requestedWidth ?? PANE_WIDTH_MIN)),
  );
  const selectedIndex = React.useMemo(
    () => model.rows.findIndex((row) => row.key === selectedKey),
    [model.rows, selectedKey],
  );
  const layout = providedLayout ?? computeWorkListLayout({
    panelHeight: resolvedPanelHeight,
    rows: model.rows,
    scrollOffsetRows,
    selectedIndex,
    headerRows: pickerMode ? 2 : 1,
  });
  const hoveredId = useHoveredHitId();
  const emphasis = pickerMode ? theme.color.attention2 : theme.color.violet;
  const borderColor = focused || pickerMode ? emphasis : theme.color.border;
  const inner = width - 4;

  return (
    <Box
      width={width}
      height={resolvedPanelHeight}
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
    >
      {pickerMode ? (
        <Box paddingX={1} flexShrink={0}>
          <Text bold color={emphasis}>PICK CHAT</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" paddingX={1} flexGrow={1} flexShrink={1} overflow="hidden">
        {loading && model.rows.length === 0 ? (
          <Text dimColor>Loading work…</Text>
        ) : null}
        {!loading && model.rows.length === 0 ? (
          <Text color={theme.color.t4}>No chats yet — press ↵ on a lane to start one.</Text>
        ) : null}
        {layout.hiddenBefore > 0 ? (
          <Text color={theme.color.t5} dimColor>{`  ↑ ${layout.hiddenBefore} above`}</Text>
        ) : null}
        {layout.placements.map((placement) => {
          const row = model.rows[placement.index]!;
          const selected = row.key === selectedKey;
          const hovered = hoveredId === `work:${row.key}`
            || hoveredId === `work:${row.key}:lane-identity`;
          const marginTop = placement.marginTop;
          switch (row.kind) {
            case "lane-header":
              return (
                <LaneHeader
                  key={row.key}
                  row={row}
                  width={inner}
                  selected={selected}
                  hovered={hovered}
                  marginTop={marginTop}
                  pluginBadges={pluginLaneBadges[row.laneId ?? ""] ?? EMPTY_PLUGIN_ROW_BADGE_STRIP}
                />
              );
            case "session":
              return (
                <SessionCard
                  key={row.key}
                  row={row}
                  width={inner}
                  selected={selected}
                  hovered={hovered}
                  height={placement.height}
                  marginTop={marginTop}
                  pluginBadges={pluginChatBadges[row.sessionId] ?? EMPTY_PLUGIN_ROW_BADGE_STRIP}
                />
              );
            case "new-chat":
              return null;
            case "shelf":
              return (
                <ShelfRow
                  key={row.key}
                  row={row}
                  width={inner}
                  selected={selected}
                  hovered={hovered}
                  marginTop={marginTop}
                />
              );
            default: {
              const _exhaustive: never = row;
              return _exhaustive;
            }
          }
        })}
        {layout.hiddenAfter > 0 ? (
          <Text color={theme.color.t5} dimColor>{`  ↓ ${layout.hiddenAfter} below`}</Text>
        ) : null}
      </Box>

      <Box paddingX={1} flexShrink={0}>
        <HintLine
          items={
            !focused
              ? []
              : pickerMode
                ? [["↑↓", "move"], ["↵", "add"], ["esc", "cancel"]]
                : [["↑↓", "move"], ["↵", "open"], ["esc", "chat"]]
          }
          keyColor={emphasis}
        />
      </Box>
    </Box>
  );
}

export const WorkSessionsPane = React.memo(WorkSessionsPaneComponent);

function HintLine({ items, keyColor }: { items: Array<[string, string]>; keyColor: string }) {
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
 * Lane group header. The lane's own colour is the accent; the row is a target
 * so Enter (or a click) opens lane details — the pane dropped the drawer's
 * lanes mode, but lane operations stay one keystroke away.
 *
 * An offline foreign machine dims the whole group and keeps its last-known
 * status with a "last seen" note, rather than removing rows that were real a
 * minute ago.
 */
function LaneHeader({
  row,
  width,
  selected,
  hovered,
  marginTop,
  pluginBadges,
}: {
  row: WorkListLaneHeaderRow;
  width: number;
  selected: boolean;
  hovered: boolean;
  marginTop: number;
  pluginBadges: PluginRowBadgeStrip;
}) {
  const offline = row.machine !== null && !row.machine.online;
  const accent = selected || hovered
    ? theme.color.violet
    : offline
      ? theme.color.t5
      : row.color ?? theme.color.t2;
  const suffix = row.lastSeenLabel
    ? ` · ${row.lastSeenLabel}`
    : row.worktreeAvailable ? "" : " · no worktree";
  const suffixColor = row.worktreeAvailable ? theme.color.t5 : theme.color.error;
  const mark = selected || hovered ? rowGutter(true) : laneMark(row.icon);
  const nameMax = Math.max(4, width - GUTTER_CELLS - suffix.length - HEADER_RULE_MIN - 1);
  const name = truncateDisplayEnd(row.label, nameMax);
  const badges = fitPluginBadgeStrip(
    pluginBadges,
    width - GUTTER_CELLS - terminalDisplayWidth(name) - suffix.length - HEADER_RULE_MIN - 2,
  );
  const badgeReservation = badges.cells.length > 0 ? pluginBadgeStripWidth(badges) + 1 : 0;
  const ruleLen = Math.max(
    HEADER_RULE_MIN,
    width - GUTTER_CELLS - terminalDisplayWidth(name) - suffix.length - badgeReservation - 1,
  );
  return (
    <Box marginTop={marginTop} width={width} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={accent}>{mark}</Text>
        <Text color={accent} bold>{name}</Text>
        <Text color={theme.color.borderSoft}>{` ${"─".repeat(ruleLen)}`}</Text>
        {badges.cells.length > 0 ? <Text> <PluginBadges strip={badges} /></Text> : null}
        {suffix ? <Text color={suffixColor} dimColor={row.worktreeAvailable}>{suffix}</Text> : null}
      </Text>
    </Box>
  );
}

function sessionStatusCluster(row: WorkListSessionRow): string {
  const glyphMark = row.glyph ? theme.sessionGlyphMark(row.glyph) : "";
  const label = row.status
    ? row.status.label
    : row.timestampLabel ?? "";
  const elapsed = row.status ? row.elapsedLabel ?? "" : "";
  const parts = [glyphMark, label, elapsed].filter((part) => part.length > 0);
  if (row.isActiveSession) parts.push("\u25DD");
  return parts.join(" ");
}

/**
 * Desktop SessionCard: where+status, title, preview. Line 1 is a row of
 * fixed columns so the glyph cannot wrap onto the title and status stays
 * pinned to one right-hand slot. Desktop paints glyph → label → elapsed.
 */
function SessionCard({
  row,
  width,
  selected,
  hovered,
  height,
  marginTop,
  pluginBadges,
}: {
  row: WorkListSessionRow;
  width: number;
  selected: boolean;
  hovered: boolean;
  height: number;
  marginTop: number;
  pluginBadges: PluginRowBadgeStrip;
}) {
  const highlighted = selected || hovered;
  const offline = row.machine !== null && !row.machine.online;
  const toneColor = theme.sessionToneColor(row.tone);
  const railColor = highlighted ? theme.color.violet : theme.color.borderSoft;
  const innerWidth = Math.max(4, width - GUTTER_CELLS);
  const whereLeft = row.showLaneIdentity
    ? (row.laneName ?? "lane")
    : row.ageLabel;
  const whereColor = row.showLaneIdentity
    ? (row.laneColor ?? theme.color.t2)
    : theme.color.t5;
  const titleColor = highlighted
    ? theme.color.violet
    : offline
      ? theme.color.t4
      : row.status?.prominent
        ? toneColor
        : row.filing === "settled" || row.filing === "snoozed"
          ? theme.color.t4
          : theme.color.t1;
  const statusColor = row.status ? toneColor : theme.color.t5;
  const line1Gutter = highlighted
    ? rowGutter(true)
    : row.showLaneIdentity
      ? laneMark(row.laneIcon)
      : rowGutter(false);
  const restGutter = rowGutter(highlighted);
  const statusCol = padDisplayStart(
    truncateDisplayEnd(sessionStatusCluster(row), STATUS_CLUSTER_CELLS),
    STATUS_CLUSTER_CELLS,
  );
  const leftMax = Math.max(4, width - GUTTER_CELLS - STATUS_CLUSTER_CELLS);
  const left = padDisplayEnd(truncateDisplayEnd(whereLeft, leftMax), leftMax);
  return (
    <Box flexDirection="column" width={width} marginTop={marginTop} flexShrink={0}>
      <Text>
        <Text color={row.showLaneIdentity && !highlighted ? whereColor : railColor}>{line1Gutter}</Text>
        <Text color={whereColor} bold={row.showLaneIdentity}>{left}</Text>
        <Text color={statusColor} dimColor={!row.status}>{statusCol}</Text>
      </Text>
      {height >= 2 ? (
        <Text>
          <Text color={railColor}>{restGutter}</Text>
          <Text color={titleColor} bold={highlighted || Boolean(row.status?.prominent)}>
            {truncateDisplayEnd(row.title, innerWidth)}
          </Text>
        </Text>
      ) : null}
      {height >= 3 ? (
        <Text>
          <Text color={railColor}>{restGutter}</Text>
          <MetaLine row={row} width={innerWidth} pluginBadges={pluginBadges} />
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Line 3: preview on the left; draft/machine marks on the right. No fake
 * provider logo — a terminal cannot render those assets.
 */
function MetaLine({
  row,
  width,
  pluginBadges,
}: {
  row: WorkListSessionRow;
  width: number;
  pluginBadges: PluginRowBadgeStrip;
}) {
  const extras = `${row.marker ? ` ${row.marker}` : ""}${row.hasDraft ? " ✎" : ""}${
    row.machine ? ` ⧉ ${row.machine.name}` : ""
  }`;
  const badges = fitPluginBadgeStrip(
    pluginBadges,
    width - terminalDisplayWidth(extras) - 1,
  );
  const badgeReservation = badges.cells.length > 0 ? pluginBadgeStripWidth(badges) + 1 : 0;
  const preview = row.preview?.text ?? "";
  const leftMax = Math.max(1, width - terminalDisplayWidth(extras) - badgeReservation);
  return (
    <Text>
      <Text color={theme.color.t4} dimColor italic>
        {padDisplayEnd(truncateDisplayEnd(preview, leftMax), leftMax)}
      </Text>
      {row.marker ? (
        <Text color={theme.color.t5} dimColor>{` ${row.marker}`}</Text>
      ) : null}
      {row.hasDraft ? <Text color={theme.color.attention}>{" ✎"}</Text> : null}
      {row.machine ? (
        <Text color={row.machine.online ? theme.color.t4 : theme.color.t5} dimColor>
          {` ⧉ ${truncateDisplayEnd(row.machine.name, Math.max(4, Math.floor(width / 3)))}`}
        </Text>
      ) : null}
      {badges.cells.length > 0 ? <Text> <PluginBadges strip={badges} /></Text> : null}
    </Text>
  );
}

/**
 * The collapsed quiet tail. Snoozed and settled rows share one shelf pattern —
 * both are "true, but not actionable", and the desktop files them the same way.
 */
function ShelfRow({
  row,
  width,
  selected,
  hovered,
  marginTop,
}: {
  row: WorkListShelfRow;
  width: number;
  selected: boolean;
  hovered: boolean;
  marginTop: number;
}) {
  const highlighted = selected || hovered;
  const gutter = rowGutter(highlighted);
  const label = truncateDisplayEnd(
    `${row.expanded ? "▾" : "▸"} ${row.shelf} (${row.count})`,
    Math.max(6, width - GUTTER_CELLS),
  );
  return (
    <Box marginTop={marginTop} width={width}>
      <Text
        color={highlighted ? theme.color.violet : theme.color.t4}
        dimColor={!highlighted}
        wrap="truncate-end"
      >
        {`${gutter}${label}`}
      </Text>
    </Box>
  );
}
