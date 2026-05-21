import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";

export function AddChatModeBanner() {
  return (
    <Box paddingX={1} flexShrink={0}>
      <Text color={theme.color.attention2} bold>Split chat: pick a chat in the left pane</Text>
      <Text color={theme.color.t4}>{"  ·  "}</Text>
      <Text color={theme.color.attention2}>↵</Text>
      <Text dimColor>{" Add  ·  "}</Text>
      <Text color={theme.color.attention2}>Esc</Text>
      <Text dimColor>{" Cancel"}</Text>
    </Box>
  );
}
