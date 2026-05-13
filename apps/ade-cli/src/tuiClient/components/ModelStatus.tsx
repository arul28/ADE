import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";

export function ModelStatus({
  statusLineText,
  vimMode,
  fastMode,
  draftChatActive,
}: {
  statusLineText?: string | null;
  vimMode?: "insert" | "normal" | null;
  fastMode?: boolean;
  draftChatActive?: boolean;
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
  if (draftChatActive) {
    extras.push(<Text key="draft" color={theme.color.accent}>next chat</Text>);
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
