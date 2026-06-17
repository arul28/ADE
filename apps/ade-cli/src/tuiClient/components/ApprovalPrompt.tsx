import React from "react";
import { Box, Text, useStdout } from "ink";
import type { PendingApproval } from "../types";
import { theme } from "../theme";
import type { AdeCodeProvider } from "../types";
import { useHoveredHitId } from "../hitTestRegistry";
import { SectionHeader, Pill, StatusDot, KeyHints, Rule } from "./designKit";
import {
  optionsForPendingQuestion,
  pendingQuestionAnsweredCount,
  type PendingQuestionSelectionState,
} from "../pendingInput";
import { pendingInputHeaderLabel } from "../../../../desktop/src/shared/pendingInputLabels";

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

// Split a preview into individual lines so the terminal renders them verbatim,
// preserving column alignment (diffs, box-drawing, indented plans). Each line is
// truncated to the card width rather than soft-wrapped mid-box — a wrap would
// reflow box-drawing columns onto the next row and break the layout. A cap keeps
// a giant plan/diff from blowing past the card; the truncation marker tells the
// user there's more.
const PREVIEW_MAX_LINES = 12;
const PROVIDER_ACCENT_SOURCES = new Set(["claude", "codex", "cursor", "droid", "opencode", "ollama", "lmstudio"]);

function previewLines(value: string, max: number): string[] {
  const rows = value.replace(/\r\n?/g, "\n").split("\n");
  const clipped = rows.slice(0, PREVIEW_MAX_LINES).map((row) => truncateEnd(row, max));
  if (rows.length > PREVIEW_MAX_LINES) clipped.push("…");
  return clipped;
}

function pendingInputAccent(source: string | null | undefined): string {
  const normalized = source?.trim().toLowerCase();
  if (!normalized || !PROVIDER_ACCENT_SOURCES.has(normalized)) return theme.color.violet;
  return theme.provider(normalized as AdeCodeProvider).color;
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
  questionState = null,
  width,
}: {
  approval: PendingApproval | null;
  modal?: boolean;
  questionState?: PendingQuestionSelectionState | null;
  width?: number;
}) {
  const hoveredId = useHoveredHitId();
  const { stdout } = useStdout();
  if (!approval) return null;

  const question = approval.request?.questions[0] ?? null;
  const options = question?.options?.length ? question.options : approval.request?.options ?? [];
  const questions = approval.request?.questions ?? [];
  const highStakes = approval.highStakes;
  const isQuestion = approval.mode === "question";
  const kind = approval.request?.kind;
  const source = approval.request?.source;
  const providerAccent = pendingInputAccent(source);

  // Accent + glyph for the titled header. Green is never used here — amber for a
  // routine permission ask, red for a high-stakes/destructive one, violet for
  // selection/input requests (informational, not a warning).
  //
  // Question + plan_approval headers read as the source-derived
  // `pendingInputHeaderLabel` ("Claude asks" / "Claude · Plan ready"), matching
  // the desktop redesign — no more kind-based "INPUT REQUESTED" double-labelling.
  let title: string;
  let glyph: string;
  let accent: string;
  if (kind === "model_selection") {
    title = "MODEL SELECTION";
    glyph = "◆";
    accent = providerAccent;
  } else if (kind === "plan_approval") {
    title = pendingInputHeaderLabel(source, kind);
    glyph = "◇";
    accent = providerAccent;
  } else if (isQuestion) {
    // `kind` may be undefined (legacy/freeform questions); the helper's default
    // branch ("{Provider} asks") is exactly right for any question kind, so
    // coalesce to "" rather than special-casing.
    title = pendingInputHeaderLabel(source, kind ?? "");
    glyph = "?";
    accent = providerAccent;
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
  // Clamp the fixed card width to the terminal so it never overflows a narrow
  // window. Border (2) + paddingX (2) = 4 cols of chrome around innerWidth.
  const fixedWidth = modal ? MODAL_WIDTH : isQuestion ? Math.max(INLINE_WIDTH, width ?? INLINE_WIDTH) : INLINE_WIDTH;
  const terminalCols = stdout?.columns ?? 0;
  const innerWidth =
    terminalCols > 0 ? Math.max(20, Math.min(fixedWidth, terminalCols - 4)) : fixedWidth;
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

  // For questions, the request-level description is shown as a single context
  // kicker above the questions — but ONLY when it adds detail beyond the question
  // text itself, otherwise it's the header + question + same-question-again
  // duplication the desktop redesign removed.
  const requestDescription = approval.request?.description?.trim() ?? "";
  const extraContext =
    isQuestion
    && requestDescription
    && !questions.some((entry) => entry.question.trim() === requestDescription)
      ? requestDescription
      : null;

  const showChips = !isQuestion && !highStakes;

  // Footer hints, keyed to the real bindings in app input handling.
  const hints: Array<[string, string]> = isQuestion
    ? [["↑↓", "choose"], ["←→", "question"], ["enter", "next/send"], ["type", "custom"], ["deny", "decline"]]
    : highStakes
      ? [["approve", "allow"], ["deny", "decline"], ["enter", "confirm"]]
      : [["a", "approve"], ["d", "deny"]];

  const accentingAccept =
    hoveredId === "approval:accept" ||
    !(typeof hoveredId === "string" && hoveredId.startsWith("approval:"));
  const answeredCount = isQuestion
    ? pendingQuestionAnsweredCount(approval.request, questionState?.answers ?? {})
    : 0;

  const card = (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
      paddingY={modal ? 1 : 0}
      flexDirection="column"
      width={modal || isQuestion ? innerWidth : undefined}
    >
      <SectionHeader
        title={title}
        glyph={glyph}
        color={accent}
        width={textWidth}
        marginTop={0}
        hint={highStakes ? "review carefully" : undefined}
      />

      {isQuestion && questions.length > 1 ? (
        <Text color={theme.color.t3}>
          {`${answeredCount} of ${questions.length} answered`}
        </Text>
      ) : null}

      {extraContext ? (
        <Box marginTop={1}>
          <Text color={theme.color.t3} dimColor wrap="truncate-end">
            {truncateEnd(extraContext, textWidth)}
          </Text>
        </Box>
      ) : null}

      {primary && !isQuestion ? (
        <Box marginTop={modal ? 1 : 0}>
          <Text color={theme.color.t1} wrap="truncate-end">
            {truncateEnd(primary, textWidth)}
          </Text>
        </Box>
      ) : null}
      {secondary && !isQuestion ? (
        <Text color={theme.color.t3} dimColor wrap="truncate-end">
          {truncateEnd(secondary, textWidth)}
        </Text>
      ) : null}

      {isQuestion && questions.length ? (
        <Box flexDirection="column" marginTop={1}>
          {questions.map((entry, questionIndex) => {
            const activeQuestion = (questionState?.activeQuestionIndex ?? 0) === questionIndex;
            const questionOptions = optionsForPendingQuestion(approval.request, entry, questionIndex);
            const selectedIndex = questionState?.optionIndexByQuestionId[entry.id] ?? 0;
            const answered = Object.prototype.hasOwnProperty.call(questionState?.answers ?? {}, entry.id);
            const header = entry.header?.trim() || `Question ${questionIndex + 1}`;
            return (
              <Box key={entry.id} flexDirection="column" marginTop={questionIndex === 0 ? 0 : 1}>
                <Text color={activeQuestion ? theme.color.violet : theme.color.t3} bold={activeQuestion}>
                  {`${activeQuestion ? "›" : " "} ${questionIndex + 1}/${questions.length} ${header}${answered ? " ✓" : ""}`}
                </Text>
                <Text color={theme.color.t1} bold={activeQuestion} wrap="truncate-end">
                  {truncateEnd(entry.question, textWidth)}
                </Text>
                {entry.impact ? (
                  <Text color={theme.color.t3} dimColor wrap="truncate-end">
                    {truncateEnd(entry.impact, textWidth)}
                  </Text>
                ) : null}
                {questionOptions.length ? (
                  <Box flexDirection="column" marginTop={1}>
                    {questionOptions.map((option, index) => {
                      const optionId = `approval:question-option:${questionIndex}:${option.value}:${index}`;
                      const hovered = hoveredId === optionId;
                      const selected = index === selectedIndex;
                      const active = activeQuestion && (hovered || selected);
                      const detail = option.description ? ` - ${option.description}` : "";
                      const line = `${option.label}${detail}`;
                      return (
                        <Box key={`${option.value}:${index}`} flexDirection="column">
                          <Box flexDirection="row">
                            <Text color={active ? theme.color.violet : selected ? theme.color.attention2 : theme.color.t4} bold={active}>
                              {`${selected ? "●" : "○"} `}
                            </Text>
                            <Text color={active ? theme.color.violet : theme.color.t2} bold={active} dimColor={!activeQuestion} wrap="truncate-end">
                              {truncateEnd(line, Math.max(8, textWidth - 2))}
                            </Text>
                          </Box>
                          {option.preview && active ? (
                            <Box flexDirection="column">
                              {previewLines(option.preview, Math.max(8, textWidth - 2)).map((previewLine, previewIndex) => (
                                <Text key={previewIndex} color={theme.color.t3} dimColor wrap="truncate-end">
                                  {previewLine.length ? previewLine : " "}
                                </Text>
                              ))}
                            </Box>
                          ) : null}
                        </Box>
                      );
                    })}
                  </Box>
                ) : (
                  <Text color={theme.color.t3} dimColor>
                    Type an answer in the prompt.
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      ) : options.length ? (
        <Box flexDirection="column" marginTop={1}>
          {options.slice(0, 6).map((option, index) => {
            const optionId = `approval:question-option:0:${option.value}:${index}`;
            const active = hoveredId === optionId;
            const detail = option.description ? ` - ${option.description}` : "";
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
