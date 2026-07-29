import React from "react";
import { Box, Text } from "ink";

import type { AttentionItem } from "../../../../desktop/src/shared/types/attention";
import {
  attentionItemContext,
  attentionPaneEntries,
} from "../attentionPane";
import { theme } from "../theme";
import type { RightPaneContent } from "../types";

function endTruncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

function attentionTone(item: AttentionItem): string {
  if (item.phase === "needs_you" || item.phase === "review_requested" || item.phase === "merge_ready") {
    return theme.color.attention;
  }
  if (
    item.phase === "failed"
    || item.phase === "blocked"
    || item.phase === "stale"
    || item.phase === "checks_failing"
    || item.phase === "changes_requested"
  ) {
    return theme.color.error;
  }
  if (item.phase === "starting" || item.phase === "running") {
    return theme.color.running;
  }
  return theme.color.t2;
}

function attentionGlyph(item: AttentionItem): string {
  if (item.phase === "needs_you" || item.phase === "review_requested" || item.phase === "merge_ready") return "!";
  if (item.phase === "failed" || item.phase === "checks_failing" || item.phase === "changes_requested") return "×";
  if (item.phase === "blocked" || item.phase === "stale") return "◆";
  if (item.phase === "starting" || item.phase === "running") return "●";
  if (item.phase === "completed" || item.phase === "merged") return "✓";
  return "·";
}

export function AttentionPaneView({
  content,
  selectedIndex,
  width,
}: {
  content: Extract<RightPaneContent, { kind: "attention" }>;
  selectedIndex: number;
  width: number;
}) {
  const { model } = content;
  const availability = model.snapshot.availability;
  const stateTone = availability?.state === "ready"
    ? theme.color.t3
    : availability?.state === "signed_out"
      ? theme.color.attention
      : theme.color.error;
  const window = attentionPaneEntries(model, selectedIndex, 11);
  const inner = Math.max(18, width - 4);
  return (
    <Box flexDirection="column">
      <Text color={stateTone} wrap="wrap">{model.message}</Text>
      <Text color={theme.color.t4} dimColor>
        {model.waitingCount > 0
          ? `${model.waitingCount} waiting${model.liveCount ? ` · ${model.liveCount} live` : ""}`
          : model.liveCount > 0
            ? `${model.liveCount} live · nothing waiting`
            : "Nothing needs you"}
      </Text>
      {window.hiddenBefore > 0 ? (
        <Text color={theme.color.t4} dimColor>{`↑ ${window.hiddenBefore} earlier`}</Text>
      ) : null}
      {window.entries.length ? window.entries.map((entry) => {
        if (entry.kind === "heading") {
          return (
            <Box key={entry.key} marginTop={1}>
              <Text color={theme.color.t4} bold>{entry.label}</Text>
            </Box>
          );
        }
        const selected = entry.itemIndex === selectedIndex;
        const context = attentionItemContext(entry.item);
        return (
          <Box key={entry.key} flexDirection="column">
            <Text
              color={selected ? theme.color.violet : attentionTone(entry.item)}
              bold={selected}
              wrap="truncate-end"
            >
              {`${selected ? theme.rail : " "} ${attentionGlyph(entry.item)} ${endTruncate(entry.item.title, Math.max(8, inner - 4))}`}
            </Text>
            <Text color={theme.color.t4} dimColor wrap="truncate-end">
              {`    ${endTruncate(context, Math.max(8, inner - 4))}`}
            </Text>
            {!entry.item.machine.online ? (
              <Text color={theme.color.attention} dimColor>
                {"    offline, last known"}
              </Text>
            ) : null}
          </Box>
        );
      }) : (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.color.t2}>All clear.</Text>
          <Text color={theme.color.t4} dimColor wrap="wrap">
            Running work and results that need review will appear here across your account.
          </Text>
        </Box>
      )}
      {window.hiddenAfter > 0 ? (
        <Text color={theme.color.t4} dimColor>{`↓ ${window.hiddenAfter} more`}</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {model.items.length ? (
          <Text color={theme.color.t4} dimColor>{"↑↓ move · Enter opens exact destination"}</Text>
        ) : null}
        <Text color={theme.color.t4} dimColor>{"R refresh"}</Text>
      </Box>
    </Box>
  );
}
