import React from "react";
import { Box, Text } from "ink";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { AdeCodeModelState, RuntimeMode } from "../types";
import { formatLaneLabel } from "../format";

const PURPLE = "#A78BFA";
const AMBER = "#F59E0B";

export function Header({
  projectName,
  lane,
  model,
  mode,
  tuiCount,
}: {
  projectName: string;
  lane: LaneSummary | null;
  model: AdeCodeModelState;
  mode: RuntimeMode | "connecting";
  tuiCount: number;
}) {
  let modeColor: string = "gray";
  if (mode === "attached") modeColor = "green";
  else if (mode === "embedded") modeColor = "yellow";
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color={PURPLE}>▌ ADE</Text>
      <Text dimColor>  ◆ </Text>
      <Text>{projectName}</Text>
      <Text dimColor>   ▌ </Text>
      <Text color={AMBER}>{formatLaneLabel(lane)}</Text>
      <Text dimColor>   ▲ </Text>
      <Text color={PURPLE}>{model.displayName}</Text>
      <Text dimColor>   ● </Text>
      <Text color={modeColor}>{mode}</Text>
      <Text dimColor>{` · ⏵ ${tuiCount} tui${tuiCount === 1 ? "" : "s"}`}</Text>
    </Box>
  );
}
