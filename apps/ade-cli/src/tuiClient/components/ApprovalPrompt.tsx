import React from "react";
import { Box, Text, useStdout } from "ink";
import type { PendingApproval } from "../types";
import { theme } from "../theme";
import type { AdeCodeProvider } from "../types";
import { useHoveredHitId } from "../hitTestRegistry";
import { SectionHeader, Pill, StatusDot, KeyHints, Rule } from "./designKit";
import {
  optionsForPendingQuestion,
  pendingQuestionAnswerGuidance,
  pendingQuestionAnsweredCount,
  selectedValuesForQuestion,
  type PendingQuestionSelectionState,
} from "../pendingInput";
import { pendingInputHeaderLabel } from "../../../../desktop/src/shared/pendingInputLabels";
import {
  isQuestionAnswered,
  isStoredQuestionAnswered,
  notePlaceholder,
  ownQuestionValue,
  sendLabel,
} from "../../../../desktop/src/shared/pendingInputAnswers";

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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringListValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        if (typeof entry !== "string") return [];
        const trimmed = entry.trim();
        return trimmed.length ? [trimmed] : [];
      })
    : [];
}

function compactList(values: string[], limit = 3): string {
  const visible = values.slice(0, limit);
  const suffix = values.length > limit ? `, +${values.length - limit} more` : "";
  return `${visible.join(", ")}${suffix}`;
}

function modelSelectionBriefing(metadata: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!metadata) return [];
  const rows: Array<[string, string]> = [];
  const description = stringValue(metadata.workDescription);
  const files = stringListValue(metadata.filesHint);
  const dependsOn = stringListValue(metadata.dependsOn);
  if (description) rows.push(["Description", description]);
  if (files.length) rows.push(["Files", compactList(files)]);
  if (dependsOn.length) rows.push(["Runs after", compactList(dependsOn)]);
  return rows;
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
  draft = "",
}: {
  approval: PendingApproval | null;
  modal?: boolean;
  questionState?: PendingQuestionSelectionState | null;
  width?: number;
  /**
   * The live prompt-line text. The TUI types its note in the main prompt rather
   * than inside the card, so the card has to be told about it to derive the
   * same Send label the desktop button carries — the label is the payload
   * receipt on every surface or it is a receipt on none.
   */
  draft?: string;
}) {
  const hoveredId = useHoveredHitId();
  const { stdout } = useStdout();
  if (!approval) return null;

  const question = approval.request?.questions[0] ?? null;
  const options = optionsForPendingQuestion(approval.request, question ?? undefined, 0);
  const questions = approval.request?.questions ?? [];
  const activeQuestionIndex = questionState?.activeQuestionIndex ?? 0;
  const activeQuestion = questions[activeQuestionIndex] ?? null;
  const activeAllowsFreeform = activeQuestion?.allowsFreeform !== false;
  const activeOptions = optionsForPendingQuestion(approval.request, activeQuestion ?? undefined, activeQuestionIndex);
  const activeHasDefault = Boolean(activeQuestion?.defaultAssumption?.trim());
  const activeUnanswerable = Boolean(
    activeQuestion
    && activeOptions.length === 0
    && !activeAllowsFreeform
    && !activeHasDefault,
  );
  const highStakes = approval.highStakes;
  const isQuestion = approval.mode === "question";
  const kind = approval.request?.kind;
  const source = approval.request?.source;
  const providerAccent = pendingInputAccent(source);
  const planApprovalContent = kind === "plan_approval"
    ? stringValue(approval.request?.providerMetadata?.planContent)
    : null;

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
  const secondary = !planApprovalContent && secondaryRaw && secondaryRaw !== primary
    ? secondaryRaw
    : null;

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
  const questionHints: Array<[string, string]> = [];
  if (activeOptions.length > 0) questionHints.push(["↑↓", "choose"]);
  if (questions.length > 1) questionHints.push(["←→", "question"]);
  if (activeOptions.length > 0) questionHints.push(["1-9", "pick"]);
  if (!activeUnanswerable) questionHints.push(["enter", "next/send"]);
  if (activeAllowsFreeform) questionHints.push(["type", "custom"]);
  questionHints.push(["deny", "decline"]);
  const hints: Array<[string, string]> = isQuestion
    ? questionHints
    : highStakes
      ? [["approve", "allow"], ["deny", "decline"], ["enter", "confirm"]]
      : [["a", "approve"], ["d", "deny"]];

  const accentingAccept =
    hoveredId === "approval:accept" ||
    !(typeof hoveredId === "string" && hoveredId.startsWith("approval:"));
  const answeredCount = isQuestion
    ? pendingQuestionAnsweredCount(approval.request, questionState?.answers ?? {})
    : 0;
  /**
   * The answer state of the question the user is on, expressed exactly as the
   * desktop card expresses it: what the note field is for right now, and what
   * pressing Enter will actually send. Both come from
   * `shared/pendingInputAnswers`, so the TUI cannot drift from the payload.
   */
  const activePicks = selectedValuesForQuestion(approval.request, questionState, activeQuestionIndex);
  const noteHint = isQuestion && activeQuestion && activeAllowsFreeform
    ? notePlaceholder({
        hasOptions: activeOptions.length > 0,
        picks: activePicks,
        multi: activeQuestion.multiSelect === true,
      })
    : null;
  const activeAlreadyBanked = activeQuestion
    ? isStoredQuestionAnswered(
        activeQuestion,
        ownQuestionValue(questionState?.answers, activeQuestion.id),
      )
    : false;
  const activeContributes = isQuestionAnswered(
    activePicks,
    activeAllowsFreeform ? draft : "",
  );
  const sendHint = isQuestion && activeQuestion && !activeUnanswerable
    ? sendLabel({
        picks: activePicks,
        note: activeAllowsFreeform ? draft : "",
        isLast: activeQuestionIndex === questions.length - 1,
        totalAnswered: answeredCount + (!activeAlreadyBanked && activeContributes ? 1 : 0),
        totalQuestions: questions.length,
      })
    : null;
  const briefingRows = kind === "model_selection"
    ? modelSelectionBriefing(approval.request?.providerMetadata)
    : [];
  const planApprovalPreview = planApprovalContent
    ? previewLines(planApprovalContent, textWidth)
    : [];

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

      {briefingRows.length ? (
        <Box flexDirection="column" marginTop={1}>
          {briefingRows.map(([label, value]) => (
            <Text key={label} color={theme.color.t3} wrap="truncate-end">
              {truncateEnd(`${label}: ${value}`, textWidth)}
            </Text>
          ))}
        </Box>
      ) : null}

      {planApprovalPreview.length ? (
        <Box flexDirection="column" marginTop={1}>
          {planApprovalPreview.map((line, index) => (
            <Text key={index} color={theme.color.t2} wrap="truncate-end">
              {line.length ? line : " "}
            </Text>
          ))}
        </Box>
      ) : null}

      {isQuestion && questions.length ? (
        <Box flexDirection="column" marginTop={1}>
          {questions.map((entry, questionIndex) => {
            const isActive = (questionState?.activeQuestionIndex ?? 0) === questionIndex;
            const questionOptions = optionsForPendingQuestion(approval.request, entry, questionIndex);
            const selectedIndex = ownQuestionValue(questionState?.optionIndexByQuestionId, entry.id) ?? 0;
            const selectedValues = selectedValuesForQuestion(approval.request, questionState, questionIndex);
            const answered = isStoredQuestionAnswered(
              entry,
              ownQuestionValue(questionState?.answers, entry.id),
            );
            const header = entry.header?.trim() || `Question ${questionIndex + 1}`;
            return (
              <Box key={entry.id} flexDirection="column" marginTop={questionIndex === 0 ? 0 : 1}>
                <Text color={isActive ? theme.color.violet : theme.color.t3} bold={isActive}>
                  {`${isActive ? "›" : " "} ${questionIndex + 1}/${questions.length} ${header}${answered ? " ✓" : ""}`}
                </Text>
                <Text color={theme.color.t1} bold={isActive} wrap="truncate-end">
                  {truncateEnd(entry.question, textWidth)}
                </Text>
                {entry.impact ? (
                  <Text color={theme.color.t3} dimColor wrap="truncate-end">
                    {truncateEnd(entry.impact, textWidth)}
                  </Text>
                ) : null}
                {entry.defaultAssumption ? (
                  <Text color={theme.color.t3} dimColor wrap="truncate-end">
                    {truncateEnd(`Default: ${entry.defaultAssumption}`, textWidth)}
                  </Text>
                ) : null}
                {questionOptions.length ? (
                  <Box flexDirection="column" marginTop={1}>
                    {questionOptions.map((option, index) => {
                      const optionId = `approval:question-option:${questionIndex}:${option.value}:${index}`;
                      const hovered = hoveredId === optionId;
                      const highlighted = index === selectedIndex;
                      const selected = selectedValues.includes(option.value);
                      const active = isActive && (hovered || highlighted);
                      const detail = option.description ? ` - ${option.description}` : "";
                      const line = `${option.label}${detail}`;
                      return (
                        <Box key={`${option.value}:${index}`} flexDirection="column">
                          <Box flexDirection="row">
                            <Text color={active ? theme.color.violet : selected ? theme.color.attention2 : theme.color.t4} bold={active}>
                              {entry.multiSelect ? `${selected ? "☑" : "☐"} ` : `${selected ? "●" : "○"} `}
                            </Text>
                            <Text color={active ? theme.color.violet : theme.color.t2} bold={active} dimColor={!isActive} wrap="truncate-end">
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
                    {entry.allowsFreeform === false
                      ? pendingQuestionAnswerGuidance(approval.request, entry, questionIndex)
                      : "Type an answer in the prompt."}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      ) : options.length ? (
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, index) => {
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

      {/* The note row's job, and what Enter will actually send — the same two
          strings the desktop card shows, derived from the same module, so a
          selection plus a typed note reads the same on both surfaces. */}
      {noteHint || sendHint ? (
        <Box flexDirection="column" marginTop={1}>
          {noteHint ? (
            <Text color={theme.color.t4} dimColor wrap="truncate-end">
              {truncateEnd(`✎ ${noteHint}`, textWidth)}
            </Text>
          ) : null}
          {sendHint ? (
            <Text color={providerAccent} bold wrap="truncate-end">
              {truncateEnd(`↵ ${sendHint}`, textWidth)}
            </Text>
          ) : null}
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
