import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";

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

export function FooterControls({
  drawerOpen,
  rightOpen,
  drawerFocused,
  detailsFocused,
  footerControlActive,
}: {
  drawerOpen: boolean;
  rightOpen: boolean;
  drawerFocused: boolean;
  detailsFocused: boolean;
  footerControlActive: boolean;
}) {
  return (
    <Box flexDirection="row" paddingX={1} flexShrink={0} justifyContent="space-between">
      <Text wrap="truncate-end">
        <Toggle label="lanes" hint="^o" open={drawerOpen} focused={drawerFocused} />
        <Text> </Text>
        <Toggle label="setup" hint="^p" open={rightOpen} focused={detailsFocused} />
      </Text>
      <Text wrap="truncate-start">
        {footerControlActive ? (
          <Text dimColor>↵ toggle  ← → choose  ↑ exit</Text>
        ) : (
          <>
            <Hint keyLabel="↓" action="panes" />
            <Text dimColor>  </Text>
            <Hint keyLabel="⇥" action="cycle" />
            <Text dimColor>  </Text>
            <Hint keyLabel="/" action="cmds" />
            <Text dimColor>  </Text>
            <Hint keyLabel="?" action="help" />
          </>
        )}
      </Text>
    </Box>
  );
}
