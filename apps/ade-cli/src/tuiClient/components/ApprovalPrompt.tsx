import React from "react";
import { Box, Text } from "ink";
import type { PendingApproval } from "../types";

export function ApprovalPrompt({
  approval,
  modal = false,
}: {
  approval: PendingApproval | null;
  modal?: boolean;
}) {
  if (!approval) return null;
  const question = approval.request?.questions[0] ?? null;

  let title: string;
  if (approval.mode === "question") title = "Input requested";
  else if (approval.highStakes) title = "High-stakes approval required";
  else title = "Approval required";

  let footer: string;
  if (approval.mode === "question") footer = "Type an answer, option number/value, deny, or cancel.";
  else if (approval.highStakes) footer = "Type approve or deny, then press enter.";
  else footer = "Press a to approve, d to deny.";

  const card = (
    <Box
      borderStyle="single"
      borderColor={approval.highStakes ? "red" : "yellow"}
      paddingX={1}
      paddingY={modal ? 1 : 0}
      flexDirection="column"
      width={modal ? 60 : undefined}
    >
      <Text color={approval.highStakes ? "red" : "yellow"}>{title}</Text>
      <Text>{question?.question ?? approval.description}</Text>
      {question?.options?.length ? (
        <Box flexDirection="column">
          {question.options.slice(0, 6).map((option, index) => (
            <Text key={option.value} dimColor>
              {index + 1}. {option.label}{option.description ? ` - ${option.description}` : ""}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text dimColor>{footer}</Text>
    </Box>
  );
  if (!modal) return card;
  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      {card}
    </Box>
  );
}
