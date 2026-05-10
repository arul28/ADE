import React from "react";
import { Box, Text } from "ink";
import type { MentionSuggestion } from "../types";

const COLORS: Record<MentionSuggestion["kind"], string> = {
  lane: "#F59E0B",
  chat: "#A78BFA",
  pr: "cyan",
  file: "green",
  commit: "yellow",
};

export function MentionPalette({
  suggestions,
  selectedIndex,
}: {
  suggestions: MentionSuggestion[];
  selectedIndex: number;
}) {
  if (!suggestions.length) return null;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {suggestions.slice(0, 8).map((suggestion, index) => (
        <Text key={`${suggestion.kind}:${suggestion.insertText}`}>
          <Text color={index === selectedIndex ? "#A78BFA" : "gray"}>{index === selectedIndex ? "›" : " "}</Text>
          <Text color={COLORS[suggestion.kind]}> {suggestion.kind.padEnd(6)}</Text>
          <Text> {suggestion.label.slice(0, 28).padEnd(28)}</Text>
          <Text dimColor> {suggestion.detail ?? ""}</Text>
        </Text>
      ))}
      <Text dimColor>tab inserts selected reference</Text>
    </Box>
  );
}
