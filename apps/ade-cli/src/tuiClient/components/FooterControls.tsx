import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";
import type { AdeCodeProvider } from "../types";

const TOKEN_BAR_CELLS = 10;
type FooterPane = "drawer" | "chat" | "details";
type FooterDrawerMode = "lanes" | "chats";

function Toggle({
  label,
  hint,
  open,
  focused,
}: {
  label: string;
  hint: string;
  open: boolean;
  focused: boolean;
}) {
  const arrow = open ? "▾" : "▸";
  if (focused) {
    return (
      <Text color={theme.color.accent} inverse>
        {` ${arrow} ${label} ${hint} `}
      </Text>
    );
  }
  return (
    <Text color={open ? theme.color.accent : theme.color.mutedFg} dimColor={!open}>
      {`[${arrow} ${label} ${hint}]`}
    </Text>
  );
}

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

export function FooterControls({
  drawerOpen,
  rightOpen,
  activePane = "chat",
  drawerMode = "lanes",
  drawerFocused,
  detailsFocused,
  footerControlActive,
  provider,
  modelDisplay,
  reasoningEffort,
  permissionLabel,
  contextPercent,
  tokenSummary,
  approvalActive,
  liveAgentCount,
  rightPaneShowsAgents,
  agentsAvailable,
  agentsOpen,
  agentsFocused,
  fastMode,
  pendingSteerCount = 0,
  chatScrollOffset = 0,
  chatScrollMaxOffset = 0,
}: {
  drawerOpen: boolean;
  rightOpen: boolean;
  activePane?: FooterPane;
  drawerMode?: FooterDrawerMode;
  drawerFocused: boolean;
  detailsFocused: boolean;
  footerControlActive: boolean;
  provider?: AdeCodeProvider | null;
  modelDisplay?: string | null;
  reasoningEffort?: string | null;
  permissionLabel?: string | null;
  contextPercent?: number | null;
  tokenSummary?: string | null;
  approvalActive?: boolean;
  liveAgentCount?: number;
  rightPaneShowsAgents?: boolean;
  agentsAvailable?: boolean;
  agentsOpen?: boolean;
  agentsFocused?: boolean;
  fastMode?: boolean;
  pendingSteerCount?: number;
  chatScrollOffset?: number;
  chatScrollMaxOffset?: number;
}) {
  const brand = provider ? theme.provider(provider) : null;
  const hasModeBar = Boolean(brand || modelDisplay || fastMode || reasoningEffort || permissionLabel || contextPercent != null || tokenSummary || pendingSteerCount > 0);
  const showAgentsToggle = agentsAvailable === true;
  const showAgentsChip = (liveAgentCount ?? 0) > 0 && !rightPaneShowsAgents && !showAgentsToggle;
  const actionHint = (() => {
    if (activePane === "drawer" && drawerMode === "chats") {
      return (
        <>
          <Hint keyLabel="↑↓" action="chats" />
          <Text dimColor>  </Text>
          <Hint keyLabel="Esc" action="lanes" />
        </>
      );
    }
    if (activePane === "drawer") {
      return (
        <>
          <Hint keyLabel="↑↓" action="lanes" />
          <Text dimColor>  </Text>
          <Hint keyLabel="↵" action="open" />
        </>
      );
    }
    if (activePane === "details") {
      return (
        <>
          <Hint keyLabel="↑↓" action="move" />
          <Text dimColor>  </Text>
          <Hint keyLabel="↵" action="run" />
        </>
      );
    }
    const safeScrollMax = Math.max(0, chatScrollMaxOffset);
    const safeScrollOffset = Math.max(0, Math.min(chatScrollOffset, safeScrollMax));
    return (
      <>
        <Hint keyLabel="↑↓" action="scroll" />
        {safeScrollMax > 0 ? <Text dimColor>{` ${safeScrollOffset}/${safeScrollMax}`}</Text> : null}
        <Text dimColor>  </Text>
        <Hint keyLabel="Tab" action={drawerOpen ? "lanes" : "open lanes"} />
        {pendingSteerCount > 0 ? (
          <>
            <Text dimColor>  </Text>
            <Hint keyLabel="/steer" action="staged" />
          </>
        ) : null}
      </>
    );
  })();
  return (
    <Box flexDirection="column" flexShrink={0}>
      {hasModeBar ? (
        <Box
          flexDirection="row"
          paddingX={1}
          justifyContent="space-between"
          borderStyle="single"
          borderColor={theme.color.borderSoft}
          borderTop
          borderLeft={false}
          borderRight={false}
          borderBottom={false}
        >
          <Text wrap="truncate-end">
            {brand ? (
              <Text color={brand.color} bold>{brand.glyph} {brand.label}</Text>
            ) : null}
            {modelDisplay ? (
              <>
                <Text color={theme.color.t4}>{"  ·  "}</Text>
                <Text color={theme.color.t2}>{modelDisplay}</Text>
              </>
            ) : null}
            {fastMode ? (
              <>
                <Text color={theme.color.t4}>{"  ·  "}</Text>
                <Text color={theme.color.warning}>fast</Text>
              </>
            ) : null}
            {reasoningEffort ? (
              <>
                <Text color={theme.color.t4}>{"  ·  "}</Text>
                <Text color={theme.color.t3}>{reasoningEffort}</Text>
              </>
            ) : null}
            {permissionLabel ? (
              <>
                <Text color={theme.color.t4}>{"  ·  "}</Text>
                <Text color={theme.color.t3}>{permissionLabel}</Text>
              </>
            ) : null}
            {pendingSteerCount > 0 ? (
              <>
                <Text color={theme.color.t4}>{"  ·  "}</Text>
                <Text color={theme.color.violet}>staged {pendingSteerCount}</Text>
              </>
            ) : null}
          </Text>
          {contextPercent != null || tokenSummary ? (
            <Text wrap="truncate-start">
              {contextPercent != null ? (
                <>
                  <TokenBar percent={contextPercent} />
                  <Text dimColor>{` ${contextPercent}%`}</Text>
                </>
              ) : null}
              {tokenSummary ? (
                <>
                  <Text color={theme.color.t4}>{"  "}</Text>
                  <Text color={theme.color.t2}>{tokenSummary}</Text>
                </>
              ) : null}
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Box flexDirection="row" paddingX={1} justifyContent="space-between">
        <Text wrap="truncate-end">
          {showAgentsToggle ? (
            <>
              <Toggle label="agents" hint="^a" open={agentsOpen === true} focused={agentsFocused === true} />
              <Text>{"  "}</Text>
            </>
          ) : null}
          <Toggle label="lanes" hint="^o" open={drawerOpen} focused={drawerFocused} />
          <Text>{"  "}</Text>
          <Toggle label="info" hint="^p" open={rightOpen} focused={detailsFocused} />
          {showAgentsChip ? (
            <>
              <Text>{"  "}</Text>
              <Text color={theme.color.accent}>
                {`[● ${liveAgentCount} agent${liveAgentCount === 1 ? "" : "s"} · ^a]`}
              </Text>
            </>
          ) : null}
        </Text>
        <Text wrap="truncate-start">
          {approvalActive ? (
            <>
              <Text color={theme.color.accent} bold>a</Text>
              <Text dimColor>{" approve  "}</Text>
              <Text color={theme.color.danger} bold>d</Text>
              <Text dimColor>{" deny  ·  "}</Text>
              <Text color={theme.color.accent}>← →</Text>
              <Text dimColor>{" choose"}</Text>
            </>
          ) : footerControlActive ? (
            <Text dimColor>↵ toggle  ← → choose  ↑ exit</Text>
          ) : (
            <>
              {actionHint}
              <Text dimColor>  </Text>
              <Hint keyLabel="/" action="cmds" />
              <Text dimColor>  </Text>
              <Hint keyLabel="?" action="help" />
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}
