import React from "react";
import { Box, Text } from "ink";
import type { PendingApproval } from "../types";
import { theme } from "../theme";
import { useHoveredHitId } from "../hitTestRegistry";
import { SectionHeader, Pill, StatusDot, KeyHints, Rule } from "./designKit";

// Default inner widths. The parent never passes a width, so the card sizes
// itself: a fixed, centered column when modal (high-stakes), and a comfortable
// readable width inline. Both stay well within a narrow terminal.
const MODAL_WIDTH = 60;
const INLINE_WIDTH = 64;

function truncateEnd(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * An access-key prefix shown immediately before an action's pill, e.g. the `a`
 * in `a [ approve ]`. Accentuated when the action is highlighted.
 */
function Hotkey({ value, highlighted }: { value: string; highlighted?: boolean }) {
  return <Text color={highlighted ? theme.color.accent : theme.color.t3} bold>{`${value} `}</Text>;
}

/**
 * A neutral/destructive bracketed chip — the deny affordance. The kit `Pill` is
 * violet-only (primary), so deny gets its own red/neutral chip per the color
 * rules (the primary accept action uses the kit `Pill`).
 */
function DenyChip({ label, highlighted }: { label: string; highlighted?: boolean }) {
  const color = highlighted ? theme.color.error : theme.color.t4;
  return <Text color={color} bold={highlighted} dimColor={!highlighted}>{`[ ${label} ]`}</Text>;
}

export function ApprovalPrompt({
  approval,
  modal = false,
}: {
  approval: PendingApproval | null;
  modal?: boolean;
}) {
  const hoveredId = useHoveredHitId();
  if (!approval) return null;

  const question = approval.request?.questions[0] ?? null;
  const options = question?.options?.length ? question.options : approval.request?.options ?? [];
  const highStakes = approval.highStakes;
  const isQuestion = approval.mode === "question";
  const kind = approval.request?.kind;

  // Accent + glyph for the titled header. Green is never used here — amber for a
  // routine permission ask, red for a high-stakes/destructive one, violet for
  // selection/input requests (informational, not a warning).
  let title: string;
  let glyph: string;
  let accent: string;
  if (kind === "model_selection") {
    title = "MODEL SELECTION";
    glyph = "◆";
    accent = theme.color.violet;
  } else if (kind === "plan_approval") {
    title = "PLAN APPROVAL";
    glyph = "◇";
    accent = theme.color.violet;
  } else if (isQuestion) {
    title = "INPUT REQUESTED";
    glyph = "?";
    accent = theme.color.violet;
  } else if (highStakes) {
    title = "HIGH-STAKES PERMISSION";
    glyph = "▲";
    accent = theme.color.error;
  } else {
    title = "PERMISSION";
    glyph = "▲";
    accent = theme.color.attention;
  }

  const borderColor = highStakes ? theme.color.error : theme.color.borderActive;
  const innerWidth = modal ? MODAL_WIDTH : INLINE_WIDTH;
  // The content region sits inside a single border (2 cols) + paddingX of 1
  // (2 cols), so usable text columns are innerWidth - 4. Rules/truncation use
  // this so nothing wraps past the card edge.
  const textWidth = Math.max(8, innerWidth - 4);

  // The request body: a primary line (the command / question being asked) and an
  // optional secondary detail, rendered dim beneath it.
  const primary =
    question?.question ?? approval.request?.title ?? approval.description ?? "";
  const secondaryRaw =
    question?.question && approval.request?.description && approval.request.description !== primary
      ? approval.request.description
      : !question?.question && approval.request?.title && approval.description !== primary
        ? approval.description
        : null;
  const secondary = secondaryRaw && secondaryRaw !== primary ? secondaryRaw : null;

  const showChips = !isQuestion && !highStakes;

  // Footer hints, keyed to the real bindings in app input handling.
  const hints: Array<[string, string]> = isQuestion
    ? [["1-6", "select"], ["type", "answer"], ["deny", "decline"]]
    : highStakes
      ? [["approve", "allow"], ["deny", "decline"], ["enter", "confirm"]]
      : [["a", "approve"], ["d", "deny"]];

  const accentingAccept =
    hoveredId === "approval:accept" ||
    !(typeof hoveredId === "string" && hoveredId.startsWith("approval:"));

  const card = (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
      paddingY={modal ? 1 : 0}
      flexDirection="column"
      width={modal ? innerWidth : undefined}
    >
      <SectionHeader
        title={title}
        glyph={glyph}
        color={accent}
        width={textWidth}
        marginTop={0}
        hint={highStakes ? "review carefully" : undefined}
      />

      {primary ? (
        <Box marginTop={modal ? 1 : 0}>
          <Text color={theme.color.t1} wrap="truncate-end">
            {truncateEnd(primary, textWidth)}
          </Text>
        </Box>
      ) : null}
      {secondary ? (
        <Text color={theme.color.t3} dimColor wrap="truncate-end">
          {truncateEnd(secondary, textWidth)}
        </Text>
      ) : null}

      {options.length ? (
        <Box flexDirection="column" marginTop={1}>
          {options.slice(0, 6).map((option, index) => {
            const optionId = `approval:question-option:${option.value}:${index}`;
            const active = hoveredId === optionId;
            const detail = option.description ? ` — ${option.description}` : "";
            const line = `${option.label}${detail}`;
            return (
              <Box key={option.value} flexDirection="row">
                <Text color={active ? theme.color.violet : theme.color.t4} bold={active}>
                  {`${index + 1} `}
                </Text>
                <Text color={active ? theme.color.violet : theme.color.t2} bold={active} dimColor={!active} wrap="truncate-end">
                  {truncateEnd(line, Math.max(8, textWidth - 2))}
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : null}

      {showChips ? (
        <Box flexDirection="row" marginTop={1}>
          <Box width={Math.floor(textWidth / 2)} flexDirection="row">
            <Hotkey value="a" highlighted={accentingAccept} />
            <Pill label="approve" active={accentingAccept} />
          </Box>
          <Box flexDirection="row">
            <Hotkey value="d" highlighted={hoveredId === "approval:decline"} />
            <DenyChip label="deny" highlighted={hoveredId === "approval:decline"} />
          </Box>
        </Box>
      ) : null}

      {highStakes ? (
        <Box flexDirection="row" marginTop={1}>
          <StatusDot kind="warn" />
          <Text color={theme.color.t3}> destructive — explicit confirmation required</Text>
        </Box>
      ) : null}

      {modal ? (
        <Box marginTop={1}>
          <Rule width={textWidth} />
        </Box>
      ) : null}
      <KeyHints items={hints} marginTop={modal ? 0 : 1} />
    </Box>
  );

  if (!modal) return card;
  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      {card}
    </Box>
  );
}
