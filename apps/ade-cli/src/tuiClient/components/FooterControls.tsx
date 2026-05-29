import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";
import type { AdeCodeProvider } from "../types";
import { gridMiniMapText } from "./GridMiniMap";
import { useHoveredHitId } from "../hitTestRegistry";
import { useShimmerTick } from "../spinTick";

const TOKEN_BAR_CELLS = 10;

type InlineRowCell = 'provider' | 'model' | 'fast' | 'reasoning' | 'permission' | 'subagents' | null;

function Hint({ keyLabel, action }: { keyLabel: string; action: string }) {
  return (
    <>
      <Text color={theme.color.accent}>{keyLabel}</Text>
      <Text dimColor>{` ${action}`}</Text>
    </>
  );
}

function tokenBarColor(percent: number): string {
  // Context-usage fill: on-brand violet while healthy, escalating to amber then
  // red as context runs low. (No green — a green block here read as a glitch.)
  if (percent >= 95) return theme.color.danger;
  if (percent >= 80) return theme.color.warning;
  return theme.color.accent;
}

export function TokenBar({ percent }: { percent: number }) {
  const safe = Math.max(0, Math.min(100, percent));
  const target = Math.max(0, Math.min(TOKEN_BAR_CELLS, Math.round((safe / 100) * TOKEN_BAR_CELLS)));

  // The shimmer tick only advances during real activity (streaming/connecting).
  // We lean on it for *both* the growth easing and the danger pulse so the bar
  // costs nothing when idle: with the tick frozen, this component never re-renders
  // and the math below collapses to a static render at the true value.
  const tick = useShimmerTick();
  const animRef = React.useRef({ filled: target, tick });

  let filled: number;
  if (tick === animRef.current.tick) {
    // Idle (or first render): the tick is not advancing, so we can't animate.
    // Snap to the true value and keep it there — no re-render loop, no drift.
    filled = target;
    animRef.current.filled = target;
  } else {
    // Active: ease one cell per tick toward the target. The bar converges in a
    // few frames and then holds steady (current === target → no further motion).
    const current = animRef.current.filled;
    if (current < target) filled = current + 1;
    else if (current > target) filled = current - 1;
    else filled = target;
    animRef.current.filled = filled;
    animRef.current.tick = tick;
  }

  const empty = TOKEN_BAR_CELLS - filled;
  const color = tokenBarColor(safe);

  // Context exhaustion: pulse the last filled cell bright/dim so it's *felt*.
  // Gated on the same activity tick — dim phase on alternating frames.
  const pulseDanger = safe >= 95 && filled > 0;
  const pulseDim = pulseDanger && tick % 2 === 1;
  const leading = pulseDanger ? filled - 1 : filled;

  return (
    <Text>
      <Text color={color}>{"▓".repeat(Math.max(0, leading))}</Text>
      {pulseDanger ? (
        <Text color={color} dimColor={pulseDim} bold={!pulseDim}>{"▓"}</Text>
      ) : null}
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
  hovered,
}: {
  value: string;
  focused: boolean;
  rowFocused: boolean;
  baseColor: string;
  accentColor: string;
  locked?: boolean;
  hovered?: boolean;
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
  if (rowFocused || hovered) {
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
  permissionDetail,
  contextPercent,
  tokenSummary,
  approvalActive,
  liveAgentCount,
  subagentsButtonVisible,
  fastMode,
  fastSupported,
  inlineRowFocused,
  inlineRowCell,
  planMode,
  terminalControlAvailable,
  terminalControlActive,
  multiViewActive,
  multiViewMap,
}: {
  provider?: AdeCodeProvider | null;
  providerLocked?: boolean;
  modelDisplay?: string | null;
  reasoningEffort?: string | null;
  permissionLabel?: string | null;
  permissionDetail?: string | null;
  contextPercent?: number | null;
  tokenSummary?: string | null;
  approvalActive?: boolean;
  liveAgentCount?: number;
  subagentsButtonVisible?: boolean;
  fastMode?: boolean;
  fastSupported?: boolean;
  inlineRowFocused?: boolean;
  inlineRowCell?: InlineRowCell;
  planMode?: boolean;
  terminalControlAvailable?: boolean;
  terminalControlActive?: boolean;
  multiViewActive?: boolean;
  multiViewMap?: { count: number; focusedIndex: number; notice?: string | null } | null;
}) {
  const brand = provider ? theme.provider(provider) : null;
  const rowFocused = inlineRowFocused === true;
  const accentColor = planMode ? theme.color.planMode : theme.color.violet;
  const agents = liveAgentCount ?? 0;
  const showSubagents = subagentsButtonVisible === true;
  const providerIsLocked = providerLocked === true;
  const hoveredId = useHoveredHitId();
  const inlineHovered = (name: string) => hoveredId === `footer:inline:${name}`;
  const footerHovered = (id: string) => hoveredId === id;

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
            hovered={inlineHovered("provider")}
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
              hovered={inlineHovered("model")}
            />
          </>
        ) : null}
        {fastSupported ? (
          <>
            <Text>{"  "}</Text>
            <Cell
              value="fast"
              focused={inlineRowCell === 'fast'}
              rowFocused={rowFocused}
              baseColor={fastMode ? theme.color.warning : theme.color.t4}
              accentColor={accentColor}
              hovered={inlineHovered("fast")}
            />
          </>
        ) : fastMode ? (
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
              hovered={inlineHovered("reasoning")}
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
              hovered={inlineHovered("permission")}
            />
            {permissionDetail ? (
              <>
                <Text color={theme.color.t4} dimColor>{" · "}</Text>
                <Text color={theme.color.t4} dimColor>{permissionDetail}</Text>
              </>
            ) : null}
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
                <Text color={isFocused || inlineHovered("subagents") ? theme.color.accent : theme.color.t3}>
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
        {multiViewMap ? (
          <>
            <Text color={theme.color.t4}>{"  "}</Text>
            {(() => {
              // Accent the focused tile glyph (▣) violet to match the grid's
              // selected-pane color; the rest of the minimap stays dim.
              const map = gridMiniMapText(multiViewMap.count, multiViewMap.focusedIndex);
              const [before, after = ""] = map.split("▣");
              return (
                <Text color={theme.color.t3}>
                  {before}
                  <Text color={theme.color.violet}>▣</Text>
                  {after}
                </Text>
              );
            })()}
            {multiViewMap.notice ? (
              <Text color={theme.color.warning}>{`  ${multiViewMap.notice}`}</Text>
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
            <Text color={footerHovered("footer:approval-accept") ? theme.color.running : theme.color.accent} bold>a</Text>
            <Text dimColor>{" approve  "}</Text>
            <Text color={footerHovered("footer:approval-decline") ? theme.color.error : theme.color.t2} bold>d</Text>
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
            {!showSubagents ? (
              <>
                <Hint keyLabel="^a" action="chat info" />
                <Text dimColor>{"  "}</Text>
              </>
            ) : null}
            <Hint keyLabel="^g" action={multiViewActive ? "add chat" : "split"} />
            {multiViewActive ? (
              <>
                <Text dimColor>{"  "}</Text>
                <Hint keyLabel="tab" action="tile" />
                <Text dimColor>{"  "}</Text>
                <Hint keyLabel="^w" action="close tile" />
              </>
            ) : null}
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
