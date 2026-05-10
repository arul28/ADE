import React from "react";
import { Box, Text } from "ink";
import type { LaneIcon, LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import { formatLaneLabel } from "../format";
import { theme } from "../theme";

const LANE_ICON_GLYPH: Record<NonNullable<LaneIcon>, string> = {
  star: "★",
  flag: "⚑",
  bolt: "↯",
  shield: "▣",
  tag: "❯",
};

export function laneIconGlyph(icon: LaneIcon | null | undefined): string {
  if (!icon) return "▎";
  return LANE_ICON_GLYPH[icon] ?? "▎";
}

export function Header({ projectName, lane }: { projectName: string; lane: LaneSummary | null }) {
  const laneColor = theme.lane(lane);
  const showProject = projectName.trim() && projectName.trim().toLowerCase() !== "ade";
  return (
    <Box
      paddingX={1}
      flexShrink={0}
      borderStyle="single"
      borderColor={theme.color.border}
      borderTop={false}
      borderLeft={false}
      borderRight={false}
    >
      <Text wrap="truncate">
        <Text color={theme.color.accent} inverse bold>{" ADE "}</Text>
        {showProject ? (
          <>
            <Text>{"   "}</Text>
            <Text color={theme.color.fg}>{projectName}</Text>
          </>
        ) : null}
        {lane ? (
          <>
            <Text>{"   "}</Text>
            <Text color={laneColor}>{laneIconGlyph(lane.icon)} {formatLaneLabel(lane)}</Text>
          </>
        ) : null}
        {lane?.branchRef ? (
          <>
            <Text>{"    "}</Text>
            <Text dimColor>⎇ {lane.branchRef}</Text>
          </>
        ) : null}
      </Text>
    </Box>
  );
}
