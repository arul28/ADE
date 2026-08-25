import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";
import type { AdeCodeProvider } from "../types";

/**
 * Compact summary of the model a NEW chat will start with. The new-chat page
 * no longer auto-opens a model pane, so this line is how the user sees what
 * they are about to launch: provider glyph + model + effort + permissions +
 * interface, in the same vocabulary FooterControls uses for a live chat.
 */
export function nextChatModelSummary(args: {
  modelDisplay?: string | null;
  reasoningEffort?: string | null;
  permissionLabel?: string | null;
  interfaceMode?: "chat" | "cli" | null;
  fastMode?: boolean;
}): string {
  return [
    args.modelDisplay?.trim() || null,
    args.fastMode ? "fast" : null,
    args.reasoningEffort?.trim() || null,
    args.permissionLabel?.trim() || null,
    args.interfaceMode === "cli" ? "CLI" : "Chat",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

export function ModelStatus({
  statusLineText,
  vimMode,
  fastMode,
  draftChatActive,
  provider,
  modelDisplay,
  reasoningEffort,
  permissionLabel,
  interfaceMode,
}: {
  statusLineText?: string | null;
  vimMode?: "insert" | "normal" | null;
  fastMode?: boolean;
  draftChatActive?: boolean;
  provider?: AdeCodeProvider | null;
  modelDisplay?: string | null;
  reasoningEffort?: string | null;
  permissionLabel?: string | null;
  interfaceMode?: "chat" | "cli" | null;
}) {
  const statusRows = statusLineText?.split(/\r?\n/).filter(Boolean).slice(0, 3) ?? [];
  const extras: React.ReactNode[] = [];
  if (vimMode) {
    extras.push(
      <Text key="vim" color={vimMode === "normal" ? theme.color.warning : theme.color.accent}>{vimMode}</Text>,
    );
  }
  if (fastMode) {
    extras.push(<Text key="fast" color={theme.color.warning}>fast</Text>);
  }
  const brand = draftChatActive && provider ? theme.provider(provider) : null;
  const nextChatLine = draftChatActive
    ? nextChatModelSummary({ modelDisplay, reasoningEffort, permissionLabel, interfaceMode, fastMode })
    : null;
  if (draftChatActive) {
    extras.push(
      <Text key="draft">
        <Text color={theme.color.accent}>next chat</Text>
        <Text dimColor>{"  "}</Text>
        {brand ? <Text color={brand.color}>{`${brand.glyph} ${brand.label} `}</Text> : null}
        <Text color={theme.color.t3}>{nextChatLine}</Text>
        <Text dimColor>{"  · /model to change"}</Text>
      </Text>,
    );
  }
  if (!statusRows.length && !extras.length) return null;
  return (
    <Box paddingX={1} flexShrink={0} flexDirection="column">
      {extras.length ? (
        <Text wrap="truncate-end">
          {extras.map((node, index) => (
            <React.Fragment key={index}>
              {index > 0 ? <Text dimColor>{"  ·  "}</Text> : null}
              {node}
            </React.Fragment>
          ))}
        </Text>
      ) : null}
      {statusRows.map((line, index) => (
        <Text key={`${index}:${line}`} wrap="truncate-end" dimColor>{line}</Text>
      ))}
    </Box>
  );
}
