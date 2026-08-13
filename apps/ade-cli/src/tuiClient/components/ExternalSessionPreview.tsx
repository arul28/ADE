import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";
import { formatRelativePastTime } from "../relativeTime";
import {
  externalSessionProviderLabel,
  externalSessionRowTitle,
  shortenCwd,
} from "../externalSessionBrowser";
import type { ExternalSessionSummary } from "../../../../desktop/src/shared/types/externalSessions";

/**
 * Center-pane preview for `/import`: the transcript of the row highlighted in
 * the external-session browser, so the user reads the conversation BEFORE Enter
 * commits the import — the same "highlight previews, Enter commits" contract the
 * drawer uses for ADE chats.
 *
 * The source is `ExternalSessionSummary.messages`, the recent-exchange sample
 * the host already ships with each row. That is a slice, not the full provider
 * transcript: there is no read-only "load this external transcript" RPC, and
 * importing is what materialises the full thread.
 */
export function ExternalSessionPreview({
  session,
  width,
  maxRows,
}: {
  session: ExternalSessionSummary | null;
  width: number;
  maxRows: number;
}) {
  if (!session) {
    return (
      <Box paddingX={1} flexDirection="column">
        <Text color={theme.color.t4} dimColor>
          No external session selected. ↑↓ moves through the list on the right.
        </Text>
      </Box>
    );
  }
  const innerWidth = Math.max(20, width - 2);
  const messages = session.messages ?? [];
  // Keep the newest exchanges: that is where "did this thread do what I think"
  // is decided, and the opening prompt is already the row heading.
  const bodyBudget = Math.max(2, maxRows - 5);
  const rendered: Array<{ key: string; role: string; text: string }> = [];
  for (let index = messages.length - 1; index >= 0 && rendered.length < bodyBudget; index -= 1) {
    const message = messages[index];
    if (!message?.text?.trim()) continue;
    rendered.unshift({
      key: `${index}`,
      role: message.role === "assistant" ? "◂" : "▸",
      text: message.text.replace(/\s+/gu, " ").trim(),
    });
  }
  const updatedAt = session.updatedAt ?? session.createdAt ?? null;

  return (
    <Box paddingX={1} flexDirection="column" height={maxRows}>
      <Text color={theme.color.t1} bold wrap="truncate-end">
        {externalSessionRowTitle(session)}
      </Text>
      <Text color={theme.color.t4} dimColor wrap="truncate-end">
        {[
          externalSessionProviderLabel(session.provider),
          session.cwd ? shortenCwd(session.cwd, { maxSegments: 4 }) : null,
          updatedAt ? formatRelativePastTime(new Date(updatedAt).toISOString()) : null,
          session.messageCount != null ? `${session.messageCount} messages` : null,
          session.alreadyImported ? "already imported" : null,
        ].filter(Boolean).join(" · ")}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {rendered.length ? (
          rendered.map((entry) => (
            <Text key={entry.key} wrap="truncate-end">
              <Text color={entry.role === "▸" ? theme.color.accent : theme.color.t3}>{`${entry.role} `}</Text>
              <Text color={theme.color.t2}>{entry.text.slice(0, Math.max(8, innerWidth - 2))}</Text>
            </Text>
          ))
        ) : (
          <Text color={theme.color.t4} dimColor>
            This provider did not ship a transcript sample for this session.
          </Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor wrap="truncate-end">
          Preview only — importing brings the full thread across. ↵ imports the selected action.
        </Text>
      </Box>
    </Box>
  );
}
