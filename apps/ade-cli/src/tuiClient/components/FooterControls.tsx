import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";
import type { AdeCodeProvider } from "../types";

const TOKEN_BAR_CELLS = 10;

type InlineRowCell = 'provider' | 'model' | 'reasoning' | 'permission' | 'subagents' | null;

function Hint({ keyLabel, action }: { keyLabel: string; action: string }) {
  return (
    <>
      <Text color={theme.color.accent}>{keyLabel}</Text>
      <Text dimColor>{` ${action}`}</Text>
    </>
  );
}

function tokenBarColor(percent: number): string {
  if (percent >= 95) return theme.color.danger;
  if (percent >= 80) return theme.color.warning;
  if (percent >= 50) return theme.color.accent;
  return theme.color.running;
}

function TokenBar({ percent }: { percent: number }) {
  const safe = Math.max(0, Math.min(100, percent));
  const filled = Math.max(0, Math.min(TOKEN_BAR_CELLS, Math.round((safe / 100) * TOKEN_BAR_CELLS)));
  const empty = TOKEN_BAR_CELLS - filled;
  const color = tokenBarColor(safe);
  return (
    <Text>
      <Text color={color}>{"▓".repeat(filled)}</Text>
      <Text color={theme.color.border} dimColor>{"░".repeat(empty)}</Text>
    </Text>
  );
}

/**
 * A single picker cell. When `focused` (and the parent row is focused), the
 * value is wrapped in `[brackets]` and tinted with the violet accent (or the
 * plan-mode accent when `planMode` is true). When `locked`, the cell renders
 * dim regardless of focus.
 */
function Cell({
  value,
  focused,
  rowFocused,
  baseColor,
  accentColor,
  locked,
}: {
  value: string;
  focused: boolean;
  rowFocused: boolean;
  baseColor: string;
  accentColor: string;
  locked?: boolean;
}) {
  if (locked) {
    return (
      <Text color={theme.color.mutedFg} dimColor>
        {value}
      </Text>
    );
  }
  if (rowFocused && focused) {
    return (
      <Text color={accentColor} bold>
        {`[${value}]`}
      </Text>
    );
  }
  if (rowFocused) {
    return <Text color={theme.color.t2}>{value}</Text>;
  }
  return <Text color={baseColor}>{value}</Text>;
}

export function FooterControls({
  provider,
  providerLocked,
  modelDisplay,
  reasoningEffort,
  permissionLabel,
  contextPercent,
  tokenSummary,
  approvalActive,
  liveAgentCount,
  subagentsButtonVisible,
  fastMode,
  inlineRowFocused,
  inlineRowCell,
  planMode,
  terminalControlAvailable,
  terminalControlActive,
}: {
  provider?: AdeCodeProvider | null;
  providerLocked?: boolean;
  modelDisplay?: string | null;
  reasoningEffort?: string | null;
  permissionLabel?: string | null;
  contextPercent?: number | null;
  tokenSummary?: string | null;
  approvalActive?: boolean;
  liveAgentCount?: number;
  subagentsButtonVisible?: boolean;
  fastMode?: boolean;
  inlineRowFocused?: boolean;
  inlineRowCell?: InlineRowCell;
  planMode?: boolean;
  terminalControlAvailable?: boolean;
  terminalControlActive?: boolean;
}) {
  const brand = provider ? theme.provider(provider) : null;
  const rowFocused = inlineRowFocused === true;
  const accentColor = planMode ? theme.color.planMode : theme.color.violet;
  const agents = liveAgentCount ?? 0;
  const showSubagents = subagentsButtonVisible === true;
  const providerIsLocked = providerLocked === true;

  return (
    <Box flexDirection="row" paddingX={1} justifyContent="space-between" flexShrink={0}>
      <Text wrap="truncate-end">
        {rowFocused ? (
          <Text color={theme.color.accent}>{"▸ "}</Text>
        ) : null}
        {brand ? (
          <Cell
            value={`${brand.glyph} ${brand.label}`}
            focused={inlineRowCell === 'provider'}
            rowFocused={rowFocused}
            baseColor={planMode ? theme.color.planMode : brand.color}
            accentColor={accentColor}
            locked={providerIsLocked}
          />
        ) : null}
        {modelDisplay ? (
          <>
            <Text>{"  "}</Text>
            <Cell
              value={modelDisplay}
              focused={inlineRowCell === 'model'}
              rowFocused={rowFocused}
              baseColor={theme.color.t2}
              accentColor={accentColor}
            />
          </>
        ) : null}
        {fastMode ? (
          <>
            <Text>{"  "}</Text>
            <Text color={theme.color.warning}>fast</Text>
          </>
        ) : null}
        {reasoningEffort ? (
          <>
            <Text>{"  "}</Text>
            <Cell
              value={reasoningEffort}
              focused={inlineRowCell === 'reasoning'}
              rowFocused={rowFocused}
              baseColor={theme.color.t3}
              accentColor={accentColor}
            />
          </>
        ) : null}
        {permissionLabel ? (
          <>
            <Text>{"  "}</Text>
            <Cell
              value={permissionLabel}
              focused={inlineRowCell === 'permission'}
              rowFocused={rowFocused}
              baseColor={theme.color.t3}
              accentColor={accentColor}
            />
          </>
        ) : null}
        {showSubagents ? (
          <>
            <Text>{"  "}</Text>
            {(() => {
              const subagentValue = agents > 0
                ? `⊚ chat info · ${agents}`
                : "⊚ chat info";
              const isFocused = inlineRowCell === 'subagents';
              if (rowFocused && isFocused) {
                return (
                  <Text color={accentColor} bold>{`[${subagentValue}]`}</Text>
                );
              }
              return (
                <Text color={isFocused ? theme.color.accent : theme.color.t3}>
                  {subagentValue}
                </Text>
              );
            })()}
          </>
        ) : null}
        {contextPercent != null || tokenSummary ? (
          <>
            <Text color={theme.color.t4}>{"  "}</Text>
            {contextPercent != null ? (
              <>
                <TokenBar percent={contextPercent} />
                <Text dimColor>{` ${contextPercent}%`}</Text>
              </>
            ) : null}
            {tokenSummary ? (
              <>
                <Text color={theme.color.t4}>{contextPercent != null ? " · " : ""}</Text>
                <Text color={theme.color.t2}>{tokenSummary}</Text>
              </>
            ) : null}
          </>
        ) : null}
      </Text>
      <Text wrap="truncate-start">
        {terminalControlActive ? (
          <>
            <Text color={theme.color.warning} bold>CLAUDE CONTROL</Text>
            <Text dimColor>{" · "}</Text>
            <Hint keyLabel="^t" action="ADE" />
            <Text dimColor>{"  "}</Text>
            <Hint keyLabel="^]" action="escape" />
          </>
        ) : approvalActive ? (
          <>
            <Text color={theme.color.accent} bold>a</Text>
            <Text dimColor>{" approve  "}</Text>
            <Text color={theme.color.danger} bold>d</Text>
            <Text dimColor>{" deny  ·  "}</Text>
            <Text color={theme.color.accent}>← →</Text>
            <Text dimColor>{" choose"}</Text>
          </>
        ) : rowFocused ? (
          <>
            <Hint keyLabel="↑" action="prompt" />
            <Text dimColor>{"  "}</Text>
            <Hint keyLabel="←→" action="cells" />
            <Text dimColor>{"  "}</Text>
            <Hint keyLabel="↓" action="cycle" />
          </>
        ) : (
          <>
            <Hint keyLabel="^o" action="lanes" />
            <Text dimColor>{"  "}</Text>
            <Hint keyLabel="^p" action="pane" />
            <Text dimColor>{"  "}</Text>
            <Hint keyLabel="^a" action="chat info" />
            <Text dimColor>{"  "}</Text>
            <Hint keyLabel="/" action="cmds" />
            <Text dimColor>{"  "}</Text>
            <Hint keyLabel="?" action="help" />
            {terminalControlAvailable ? (
              <>
                <Text dimColor>{"  "}</Text>
                <Hint keyLabel="^t" action="Claude" />
              </>
            ) : null}
          </>
        )}
      </Text>
    </Box>
  );
}
