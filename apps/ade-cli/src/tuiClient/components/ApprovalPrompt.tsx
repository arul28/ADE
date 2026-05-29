import React from "react";
import { Box, Text } from "ink";
import type { PendingApproval } from "../types";
import { theme } from "../theme";
import { useHoveredHitId } from "../hitTestRegistry";

function ApproveChip({
  k,
  label,
  color,
  highlighted,
}: {
  k: string;
  label: string;
  color: string;
  highlighted?: boolean;
}) {
  return (
    <Text color={highlighted ? color : theme.color.t2} bold={highlighted}>
      [<Text color={color} bold>{k}</Text>] {label}
    </Text>
  );
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
  const borderColor = highStakes ? theme.color.error : theme.color.attention;
  const headerColor = highStakes ? theme.color.error : theme.color.attention;

  let title: string;
  if (approval.request?.kind === "model_selection") title = "MODEL SELECTION";
  else if (approval.request?.kind === "plan_approval") title = "PLAN APPROVAL";
  else if (approval.mode === "question") title = "INPUT REQUESTED";
  else if (highStakes) title = "HIGH-STAKES APPROVAL REQUIRED";
  else title = "APPROVAL REQUIRED";

  const showChips = approval.mode !== "question" && !highStakes;
  const prompt = question?.question ?? approval.request?.title ?? approval.request?.description ?? approval.description;

  const card = (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
      paddingY={modal ? 1 : 0}
      flexDirection="column"
      width={modal ? 60 : undefined}
    >
      <Box flexDirection="row">
        <Text color={headerColor} bold>⚠ {title}</Text>
      </Box>
      <Text color={theme.color.t1}>{prompt}</Text>
      {options.length ? (
        <Box flexDirection="column">
          {options.slice(0, 6).map((option, index) => (
            <Text
              key={option.value}
              color={hoveredId === `approval:question-option:${option.value}:${index}` ? theme.color.violet : theme.color.t3}
              dimColor={hoveredId !== `approval:question-option:${option.value}:${index}`}
            >
              {index + 1}. {option.label}{option.description ? ` - ${option.description}` : ""}
            </Text>
          ))}
        </Box>
      ) : null}

      {showChips ? (
        <Box flexDirection="row" marginTop={1}>
          <ApproveChip k="a" label="approve" color={theme.color.running} highlighted={hoveredId === "approval:accept" || !(typeof hoveredId === "string" && hoveredId.startsWith("approval:"))} />
          <Text>  </Text>
          <ApproveChip k="d" label="deny" color={theme.color.error} highlighted={hoveredId === "approval:decline"} />
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor>
          {approval.mode === "question"
            ? "Type an answer, option number/value, deny, or cancel."
            : highStakes
              ? 'Type "approve" or "deny", then press enter.'
              : "Press a to approve, d to deny."}
        </Text>
      </Box>
    </Box>
  );
  if (!modal) return card;
  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      {card}
    </Box>
  );
}
