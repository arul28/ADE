import React from "react";
import { Box, Text } from "ink";
import type { RightPaneContent } from "../types";
import { theme } from "../theme";
import { TokenBar, tokenBarColor } from "./FooterControls";
import { useShimmerTick } from "../spinTick";

type UsageContent = Extract<RightPaneContent, { kind: "usage" }>;
type QuotaWindow = NonNullable<UsageContent["quotaWindows"]>[number];

function endTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function compactTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatCost(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/**
 * Reset countdown. `resetAt` is an epoch in *seconds* (matching the daemon's
 * rate-limit `resetsAt` from `latestTokenStats`). `nowMs` is read fresh each
 * spin tick so the timer ticks down while the pane is open — but only while the
 * tick is advancing (real activity), so an idle pane never re-renders.
 */
function formatResetCountdown(resetAt: number | null | undefined, nowMs: number): string | null {
  if (resetAt == null || !Number.isFinite(resetAt)) return null;
  const remainingMs = resetAt * 1000 - nowMs;
  if (remainingMs <= 0) return "now";
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

function QuotaWindowRow({
  window,
  width,
  nowMs,
  marginTop,
}: {
  window: QuotaWindow;
  width: number;
  nowMs: number;
  marginTop: number;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(window.percent)));
  const color = tokenBarColor(percent);
  const countdown = formatResetCountdown(window.resetAt, nowMs);
  // Reserve room for the "↻ <countdown>" chip (+ a gap) only when a countdown is
  // actually shown; otherwise just leave a small gutter. Previously this always
  // subtracted a fixed 8, needlessly truncating labels when no countdown exists.
  const reserved = countdown ? countdown.length + 4 : 2;
  const labelWidth = Math.max(4, Math.floor(width) - reserved);
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={theme.color.t2}>{endTruncate(window.label, labelWidth)}</Text>
        {countdown ? (
          <Text color={theme.color.t4} dimColor>{`↻ ${countdown}`}</Text>
        ) : null}
      </Box>
      <Box flexDirection="row">
        {/* TokenBar carries the ≥95% danger pulse (amber→red, gated on the spin
            tick) for free, so the last filled cell blinks when a window is full. */}
        <TokenBar percent={percent} />
        <Text color={color}>{` ${percent}%`}</Text>
      </Box>
    </Box>
  );
}

export function UsagePane({ content, width }: { content: UsageContent; width: number }) {
  const inner = Math.max(12, width - 4);
  // Read the clock once per render. The hook only changes value while the spin
  // tick is advancing (streaming / connecting), so an idle /usage pane consumes
  // the tick but produces ZERO re-renders — the countdown is frozen at rest and
  // resumes live the moment there's activity.
  const tick = useShimmerTick();
  void tick;
  const nowMs = Date.now();

  if (content.loading) {
    return (
      <Box flexDirection="column">
        <Text color={theme.color.t3}>Loading usage…</Text>
      </Box>
    );
  }

  if (content.error) {
    return (
      <Box flexDirection="column">
        <Text color={theme.color.error}>Usage unavailable</Text>
        <Text color={theme.color.t3} wrap="wrap">{endTruncate(content.error, inner * 3)}</Text>
      </Box>
    );
  }

  const windows = content.quotaWindows ?? [];
  const session = content.session ?? null;

  return (
    <Box flexDirection="column">
      {windows.length ? (
        windows.map((window, index) => (
          <QuotaWindowRow
            key={window.id}
            window={window}
            width={inner}
            nowMs={nowMs}
            marginTop={index === 0 ? 0 : 1}
          />
        ))
      ) : (
        <Text color={theme.color.t4} dimColor>Quota windows unavailable.</Text>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.color.t2} bold>This session</Text>
        {session ? (
          <>
            <Box flexDirection="row">
              <Text color={theme.color.t4}>↑in </Text>
              <Text color={theme.color.t1}>{compactTokens(session.input)}</Text>
              <Text color={theme.color.t4}>{"   ↓out "}</Text>
              <Text color={theme.color.t1}>{compactTokens(session.output)}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={theme.color.t4}>cost </Text>
              <Text color={theme.color.t2}>{formatCost(session.cost)}</Text>
            </Box>
          </>
        ) : (
          <Text color={theme.color.t4} dimColor>No session usage yet.</Text>
        )}
      </Box>
    </Box>
  );
}
