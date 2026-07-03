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

function HeaderComponent({
  projectName,
  lane,
  chatTitle,
  remoteLabel,
}: {
  projectName: string;
  lane: LaneSummary | null;
  chatTitle?: string | null;
  remoteLabel?: string | null;
}) {
  const laneColor = theme.lane(lane);
  const normalizedProject = projectName.trim().toLowerCase();
  const branchRef = lane?.branchRef?.trim() ?? "";
  const worktreeName = lane?.worktreePath?.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? "";
  const projectRepeatsBranch = Boolean(
    normalizedProject
    && lane
    && (
      branchRef.toLowerCase().endsWith(normalizedProject)
      || worktreeName === normalizedProject
    ),
  );
  const showProject = Boolean(normalizedProject && normalizedProject !== "ade" && !projectRepeatsBranch);
  const chatLabel = chatTitle?.trim() || null;
  const remote = remoteLabel?.trim() || null;
  return (
    <Box
      paddingX={1}
      flexShrink={0}
      borderStyle="single"
      borderColor={theme.color.border}
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Text wrap="truncate-end">
        <Text color={theme.color.accent} inverse bold>{" ADE "}</Text>
        {showProject ? (
          <>
            <Text color={theme.color.t4}>{"  │  "}</Text>
            <Text color={theme.color.fg}>{projectName}</Text>
          </>
        ) : null}
        {lane ? (
          <>
            <Text color={theme.color.t4}>{"  │  "}</Text>
            <Text color={theme.color.t4}>lane </Text>
            <Text color={laneColor} bold>{laneIconGlyph(lane.icon)}</Text>
            <Text> </Text>
            <Text color={laneColor}>{formatLaneLabel(lane)}</Text>
          </>
        ) : null}
        {lane?.branchRef ? (
          <>
            <Text>{"    "}</Text>
            <Text color={theme.color.t4}>branch </Text>
            <Text color={theme.color.t3}>{lane.branchRef}</Text>
          </>
        ) : null}
        {chatLabel ? (
          <>
            <Text>{"    "}</Text>
            <Text color={theme.color.t4}>chat </Text>
            <Text color={theme.color.fg}>{chatLabel}</Text>
          </>
        ) : null}
      </Text>
      {remote ? (
        <Text color={theme.color.t4} wrap="truncate-end">
          connected to <Text color={theme.color.accent}>{remote}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

export const Header = React.memo(HeaderComponent);
