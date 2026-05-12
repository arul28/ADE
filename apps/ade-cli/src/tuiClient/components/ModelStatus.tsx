import React from "react";
import { Box, Text } from "ink";
import type { AdeCodeProvider } from "../types";
import { theme } from "../theme";

const BAR_CELLS = 10;

function meterColor(percent: number): string {
  if (percent >= 95) return theme.color.danger;
  if (percent >= 80) return theme.color.warning;
  return theme.color.accent;
}

function ContextMeter({ percent, summary }: { percent: number; summary: string | null }) {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS)));
  const empty = BAR_CELLS - filled;
  const color = meterColor(percent);
  return (
    <Text>
      <Text color={color}>{"▓".repeat(filled)}</Text>
      <Text color={theme.color.border} dimColor>{"░".repeat(empty)}</Text>
      <Text dimColor>{` ${percent}%`}</Text>
      {summary ? <Text dimColor>{`  ${summary}`}</Text> : null}
    </Text>
  );
}

export function ModelStatus({
  provider,
  displayName,
  reasoningEffort,
  permissionLabel,
  fastMode,
  draftChatActive,
  contextPercent,
  tokenSummary,
  statusLineText,
  vimMode,
}: {
  provider: AdeCodeProvider;
  displayName: string;
  reasoningEffort: string | null;
  permissionLabel: string;
  fastMode?: boolean;
  draftChatActive?: boolean;
  contextPercent?: number | null;
  tokenSummary?: string | null;
  statusLineText?: string | null;
  vimMode?: "insert" | "normal" | null;
}) {
  const brand = theme.provider(provider);
  const statusRows = statusLineText?.split(/\r?\n/).filter(Boolean).slice(0, 3) ?? [];
  return (
    <Box paddingX={1} flexShrink={0} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color={brand.color}>{brand.glyph} {brand.label}</Text>
          <Text dimColor>  ·  </Text>
          <Text color={theme.color.fg}>{displayName}</Text>
          <Text dimColor>  ·  </Text>
          <Text dimColor>{reasoningEffort ?? "no reasoning"}</Text>
          <Text dimColor>  ·  </Text>
          <Text dimColor>{permissionLabel}</Text>
          {vimMode ? (
            <>
              <Text dimColor>  ·  </Text>
              <Text color={vimMode === "normal" ? theme.color.warning : theme.color.accent}>{vimMode}</Text>
            </>
          ) : null}
          {fastMode ? (
            <>
              <Text dimColor>  ·  </Text>
              <Text color={theme.color.warning}>fast</Text>
            </>
          ) : null}
          {draftChatActive ? (
            <>
              <Text dimColor>  ·  </Text>
              <Text color={theme.color.accent}>next chat</Text>
            </>
          ) : null}
        </Text>
        {!statusRows.length && contextPercent != null ? (
          <ContextMeter percent={contextPercent} summary={tokenSummary ?? null} />
        ) : null}
      </Box>
      {statusRows.map((line, index) => (
        <Text key={`${index}:${line}`} wrap="truncate-end" dimColor>{line}</Text>
      ))}
    </Box>
  );
}
