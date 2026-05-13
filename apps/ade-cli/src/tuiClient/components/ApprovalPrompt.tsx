import React from "react";
import { Box, Text } from "ink";
import type { PendingApproval } from "../types";
import { theme } from "../theme";

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
  if (!approval) return null;
  const question = approval.request?.questions[0] ?? null;
  const highStakes = approval.highStakes;
  const borderColor = highStakes ? theme.color.error : theme.color.attention;
  const headerColor = highStakes ? theme.color.error : theme.color.attention;

  let title: string;
  if (approval.mode === "question") title = "INPUT REQUESTED";
  else if (highStakes) title = "HIGH-STAKES APPROVAL REQUIRED";
  else title = "APPROVAL REQUIRED";

  const showChips = approval.mode !== "question" && !highStakes;

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
      <Text color={theme.color.t1}>{question?.question ?? approval.description}</Text>
      {question?.options?.length ? (
        <Box flexDirection="column">
          {question.options.slice(0, 6).map((option, index) => (
            <Text key={option.value} color={theme.color.t3} dimColor>
              {index + 1}. {option.label}{option.description ? ` - ${option.description}` : ""}
            </Text>
          ))}
        </Box>
      ) : null}

      {showChips ? (
        <Box flexDirection="row" marginTop={1}>
          <ApproveChip k="a" label="approve" color={theme.color.running} highlighted />
          <Text>  </Text>
          <ApproveChip k="d" label="deny" color={theme.color.error} />
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
