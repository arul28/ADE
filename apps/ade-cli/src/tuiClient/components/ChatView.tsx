import React from "react";
import { Box, Text } from "ink";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { LocalNotice } from "../types";
import { renderChatLines, type RenderedChatLine } from "../format";
import { theme } from "../theme";
import { AdeWordmark } from "./AdeWordmark";
import { laneIconGlyph } from "./Header";

function estimatedRows(line: RenderedChatLine): number {
  const bodyRows = Math.max(1, line.body.split(/\r?\n/).length);
  let rows = bodyRows + (line.header ? 1 : 0);
  if (line.tone === "user") rows += 2; // round border adds 2 rows
  return rows;
}

function fitToRows(lines: RenderedChatLine[], maxRows?: number): RenderedChatLine[] {
  if (!maxRows || maxRows <= 0) return lines;
  const visible: RenderedChatLine[] = [];
  let rows = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const nextRows = estimatedRows(line);
    if (visible.length && rows + nextRows > maxRows) break;
    visible.unshift(line);
    rows += nextRows;
  }
  return visible;
}

const HERO_INNER_WIDTH = 48;
const HERO_DIVIDER = "─".repeat(HERO_INNER_WIDTH);

function HeroDivider() {
  return <Text color={theme.color.border} dimColor>{HERO_DIVIDER}</Text>;
}

function HeroSuggestion({ command, label }: { command: string; label: string }) {
  return (
    <Text>
      <Text color={theme.color.accent}>›  </Text>
      <Text color={theme.color.fg}>{command}</Text>
      {label ? (
        <>
          <Text>   </Text>
          <Text dimColor>{label}</Text>
        </>
      ) : null}
    </Text>
  );
}

export function BootHero({
  projectName,
  laneName,
  lane,
}: {
  projectName: string;
  laneName: string;
  lane?: LaneSummary | null;
}) {
  const laneColor = theme.lane(lane ?? null);
  const laneGlyph = laneIconGlyph(lane?.icon ?? null);
  const showProject = projectName.trim() && projectName.trim().toLowerCase() !== "ade";
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Box
        borderStyle="round"
        borderColor={theme.color.accent}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
        width={HERO_INNER_WIDTH + 4}
      >
        <Box flexDirection="column" paddingX={1}>
          <AdeWordmark />
          <Box height={1} />
          <Text>
            <Text color={theme.color.fg} bold>ade code</Text>
            <Text dimColor>  ·  v0.1</Text>
          </Text>
          <Box flexDirection="row">
            <Text color={laneColor}>{laneGlyph} {laneName}</Text>
            {lane?.branchRef ? (
              <Text dimColor>    ⎇ {lane.branchRef}</Text>
            ) : null}
            {!lane?.branchRef && showProject ? (
              <Text dimColor>    {projectName}</Text>
            ) : null}
          </Box>
          <Box height={1} />
          <HeroDivider />
          <Box height={1} />
          <Text color={theme.color.fg}>type to chat</Text>
          <Box height={1} />
          <Text>
            <Text color={theme.color.accent} bold>/</Text>
            <Text dimColor>  commands     </Text>
            <Text color={theme.color.accent} bold>@</Text>
            <Text dimColor>  files     </Text>
            <Text color={theme.color.accent} bold>?</Text>
            <Text dimColor>  help</Text>
          </Text>
          <Box height={1} />
          <HeroDivider />
          <Box height={1} />
          <HeroSuggestion command="inspect the current diff" label="" />
          <HeroSuggestion command="@file" label="then ask for a focused review" />
          <HeroSuggestion command="/status" label="show lane health" />
          <HeroSuggestion command="/new" label="start a fresh chat" />
        </Box>
      </Box>
    </Box>
  );
}

type ChatLineProps = {
  line: RenderedChatLine;
  prevTone: RenderedChatLine["tone"] | null;
};

function ChatLineComponent({ line, prevTone }: ChatLineProps) {
  const isChatTurn = line.tone === "user" || line.tone === "assistant";
  const speakerChanged = prevTone !== line.tone;
  const showSpacer = isChatTurn && speakerChanged && prevTone !== null;

  if (line.tone === "user") {
    return (
      <Box flexDirection="column">
        {showSpacer ? <Box height={1} /> : null}
        {line.header ? (
          <Box flexDirection="row" justifyContent="flex-end" paddingRight={1}>
            <Text dimColor>{line.header}</Text>
          </Box>
        ) : null}
        <Box flexDirection="row" justifyContent="flex-end" paddingLeft={4}>
          <Box
            borderStyle="round"
            borderColor={theme.color.accent}
            paddingX={1}
            flexDirection="column"
          >
            <Text color={theme.color.fg}>{line.body}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (line.tone === "tool" || line.tone === "error") {
    const isErrorTone = line.tone === "error";
    const lines = line.body.split(/\r?\n/);
    return (
      <Box flexDirection="column" paddingLeft={2}>
        {lines.map((text, index) => (
          <Text key={`${line.id}:${index}`} color={isErrorTone ? theme.color.danger : theme.color.tool} dimColor={!isErrorTone}>
            {text}
          </Text>
        ))}
      </Box>
    );
  }

  if (line.tone === "reasoning" || line.tone === "notice" || line.tone === "approval") {
    return (
      <Box flexDirection="column">
        {line.header ? <Text color={theme.tone(line.tone)} dimColor>{line.header}</Text> : null}
        <Text color={theme.tone(line.tone)} dimColor={line.tone !== "approval"}>{line.body}</Text>
      </Box>
    );
  }

  // assistant
  return (
    <Box flexDirection="column">
      {showSpacer ? <Box height={1} /> : null}
      {line.header ? (
        <Text dimColor>{line.header}</Text>
      ) : null}
      <Text color={theme.color.fg}>{line.body}</Text>
    </Box>
  );
}

const ChatLine = React.memo(ChatLineComponent, (prev, next) => (
  prev.line === next.line && prev.prevTone === next.prevTone
));

export function ChatView({
  events,
  notices,
  activeSession,
  projectName,
  laneName,
  lane,
  expandedLineIds,
  maxRows,
}: {
  events: AgentChatEventEnvelope[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  projectName: string;
  laneName: string;
  lane?: LaneSummary | null;
  expandedLineIds?: Set<string>;
  maxRows?: number;
}) {
  const lines = fitToRows(renderChatLines({ events, notices, activeSession, expandedLineIds, maxLines: 80 }), maxRows);
  if (!lines.length) {
    return <BootHero projectName={projectName} laneName={laneName} lane={lane ?? null} />;
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      {lines.map((line, index) => (
        <ChatLine key={line.id} line={line} prevTone={index > 0 ? lines[index - 1]!.tone : null} />
      ))}
    </Box>
  );
}
